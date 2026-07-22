import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useProcessAudio } from '../src/hooks/useProcessAudio';
import type { StartProcessAudioOptions } from '../src/electron';

/**
 * Tests for the rewritten `useProcessAudio` hook (per-process WASAPI loopback
 * via the `loopback-capture` bridge).
 *
 * Coverage focus:
 *   - The new selection contract: `start()` requires either `{ pid }` or
 *     `{ system: true }`. Anything else returns null + sets an error without
 *     touching the AudioContext or the IPC bridge.
 *   - A valid `{ system: true }` selection drives the full pipeline:
 *     `startProcessAudio` IPC + `onAudioChunk` subscription + the resulting
 *     `MediaStreamTrack` from the `MediaStreamAudioDestinationNode`.
 *
 * Browser-build behaviour (`window.electronAPI` absent → no-op) is also covered.
 */

/** Minimal mock of `window.electronAPI` — only the methods the hook touches. */
type MockApi = {
  isElectron: true;
  startProcessAudio: ReturnType<typeof vi.fn>;
  stopProcessAudio: ReturnType<typeof vi.fn>;
  onAudioChunk: ReturnType<typeof vi.fn>;
  onAudioError: ReturnType<typeof vi.fn>;
};

function installMockApi(overrides: Partial<MockApi> = {}): MockApi {
  const api: MockApi = {
    isElectron: true,
    startProcessAudio: vi.fn().mockResolvedValue({ ok: true, sampleRate: 48000, channels: 1 }),
    stopProcessAudio: vi.fn().mockResolvedValue({ ok: true }),
    onAudioChunk: vi.fn().mockImplementation(() => vi.fn()), // returns unsubscribe
    onAudioError: vi.fn().mockImplementation(() => vi.fn()),
    ...overrides,
  };
  (window as unknown as { electronAPI?: MockApi }).electronAPI = api;
  return api;
}

/** Remove the mock so the next test starts from a clean slate. */
function clearMockApi() {
  (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
}

describe('useProcessAudio — selection contract', () => {
  let originalAudioContext: typeof AudioContext;

  beforeEach(() => {
    originalAudioContext = window.AudioContext;
    // A stub AudioContext is enough — we only need createScriptProcessor,
    // createMediaStreamDestination and a closeable ctx. The destination's
    // stream must expose a single audio track for the happy path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).AudioContext = class {
      state = 'running';
      resume = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockResolvedValue(undefined);
      createScriptProcessor = () => ({
        onaudioprocess: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
      });
      createMediaStreamDestination = () => ({
        channelCount: 2,
        connect: vi.fn(),
        disconnect: vi.fn(),
        stream: { getAudioTracks: () => [{ kind: 'audio', stop: vi.fn() }], getTracks: () => [{ kind: 'audio', stop: vi.fn() }] },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  });

  afterEach(() => {
    window.AudioContext = originalAudioContext;
    clearMockApi();
    vi.restoreAllMocks();
  });

  it('returns null and sets an error when called with no selection (no pid, no system)', async () => {
    installMockApi();
    const { result } = renderHook(() => useProcessAudio());

    let track: MediaStreamTrack | null = 'sentinel' as unknown as MediaStreamTrack;
    await act(async () => {
      track = await result.current.start({} as StartProcessAudioOptions);
    });

    expect(track).toBeNull();
    expect(result.current.error).toMatch(/not selected/i);
    expect(result.current.isActive).toBe(false);
  });

  it('returns null in the browser build (no electronAPI) without throwing', async () => {
    clearMockApi(); // browser build
    const { result } = renderHook(() => useProcessAudio());

    let track: MediaStreamTrack | null = 'sentinel' as unknown as MediaStreamTrack;
    await act(async () => {
      track = await result.current.start({ system: true });
    });

    expect(track).toBeNull();
    expect(result.current.isActive).toBe(false);
  });

  it('requires either pid or system — passing pid of wrong type is rejected', async () => {
    installMockApi();
    const { result } = renderHook(() => useProcessAudio());

    let track: MediaStreamTrack | null = 'sentinel' as unknown as MediaStreamTrack;
    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      track = await result.current.start({ pid: 'not-a-number' } as any);
    });

    expect(track).toBeNull();
    expect(result.current.error).toMatch(/not selected/i);
  });

  it('happy path: { system: true } → calls startProcessAudio, subscribes to chunks, returns a track', async () => {
    const api = installMockApi();
    const { result } = renderHook(() => useProcessAudio());

    let track: MediaStreamTrack | null = null;
    await act(async () => {
      track = await result.current.start({ system: true });
    });

    expect(track).not.toBeNull();
    expect(track?.kind).toBe('audio');
    expect(result.current.isActive).toBe(true);
    expect(result.current.error).toBeNull();
    expect(api.startProcessAudio).toHaveBeenCalledWith({ system: true });
    expect(api.onAudioChunk).toHaveBeenCalled();
  });

  it('happy path: { pid } → forwards the chosen pid to the IPC bridge', async () => {
    const api = installMockApi();
    const { result } = renderHook(() => useProcessAudio());

    let track: MediaStreamTrack | null = null;
    await act(async () => {
      track = await result.current.start({ pid: 1234 });
    });

    expect(track).not.toBeNull();
    expect(api.startProcessAudio).toHaveBeenCalledWith({ pid: 1234 });
    expect(result.current.isActive).toBe(true);
  });

  it('happy path: { excludePid } → forwards excludePid to the IPC bridge (entire-screen path)', async () => {
    const api = installMockApi();
    const { result } = renderHook(() => useProcessAudio());

    let track: MediaStreamTrack | null = null;
    await act(async () => {
      track = await result.current.start({ excludePid: 4321 });
    });

    expect(track).not.toBeNull();
    expect(track?.kind).toBe('audio');
    expect(api.startProcessAudio).toHaveBeenCalledWith({ excludePid: 4321 });
    expect(result.current.isActive).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('surfaces a main-process failure (ok:false) as an error and tears down', async () => {
    installMockApi({
      startProcessAudio: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }),
    });
    const { result } = renderHook(() => useProcessAudio());

    let track: MediaStreamTrack | null = 'sentinel' as unknown as MediaStreamTrack;
    await act(async () => {
      track = await result.current.start({ system: true });
    });

    expect(track).toBeNull();
    expect(result.current.error).toBe('boom');
    expect(result.current.isActive).toBe(false);
  });

  it('stop() calls stopProcessAudio and deactivates', async () => {
    const api = installMockApi();
    const { result } = renderHook(() => useProcessAudio());

    await act(async () => {
      await result.current.start({ system: true });
    });
    expect(result.current.isActive).toBe(true);

    await act(async () => {
      await result.current.stop();
    });

    expect(api.stopProcessAudio).toHaveBeenCalled();
    await waitFor(() => expect(result.current.isActive).toBe(false));
  });
});
