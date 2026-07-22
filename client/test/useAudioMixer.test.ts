import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAudioMixer } from '../src/hooks/useAudioMixer';

/**
 * Tests for the central `useAudioMixer` hook.
 *
 * The mixer exists to guarantee the mesh always publishes exactly ONE audio
 * track, no matter how many local audio sources (mic + screen) are connected.
 * These tests pin the lifecycle invariants that the fix relies on:
 *
 *   1. The `mixedTrack` reference is STABLE across connect/disconnect calls —
 *      toggling the mic or screen audio must NOT re-create the track the
 *      RTCPeerConnection is holding (that would force a renegotiation).
 *   2. Each connect returns a disconnect fn that detaches only that source.
 *   3. `dispose()` tears down the AudioContext and clears `mixedTrack`.
 *   4. Gain setters mutate the GainNode (smoke test).
 */

interface MockGain {
  gain: { value: number; setTargetAtTime: ReturnType<typeof vi.fn> };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface MockDestination {
  channelCount: number;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  stream: {
    getAudioTracks: () => MediaStreamTrack[];
    getTracks: () => MediaStreamTrack[];
  };
}

interface MockSource {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface MockCtx {
  state: string;
  currentTime: number;
  resume: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  createGain: () => MockGain;
  createMediaStreamDestination: () => MockDestination;
  createMediaStreamSource: () => MockSource;
}

function makeTrack(id: string): MediaStreamTrack {
  return {
    id,
    kind: 'audio',
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function installMockAudioContext(): { ctx: MockCtx; gains: MockGain[]; dest: MockDestination; track: MediaStreamTrack } {
  const track = makeTrack('mixed-track');
  const dest: MockDestination = {
    channelCount: 2,
    connect: vi.fn(),
    disconnect: vi.fn(),
    stream: {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    },
  };
  const gains: MockGain[] = [];
  const ctx: MockCtx = {
    state: 'running',
    currentTime: 0,
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createGain: () => {
      const g: MockGain = {
        gain: { value: 1, setTargetAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(g);
      return g;
    },
    createMediaStreamDestination: () => dest,
    createMediaStreamSource: () => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).AudioContext = vi.fn(() => ctx);
  (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext = undefined;
  return { ctx, gains, dest, track };
}

describe('useAudioMixer', () => {
  let originalAudioContext: typeof AudioContext;
  let originalMediaStream: typeof MediaStream;

  beforeEach(() => {
    originalAudioContext = window.AudioContext;
    // jsdom doesn't ship a MediaStream constructor — the hook uses one to
    // wrap each input track before createMediaStreamSource. Stub it to a
    // minimal shim that just remembers its tracks.
    originalMediaStream = window.MediaStream;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).MediaStream = class {
      constructor(public tracks: MediaStreamTrack[] = []) {}
      getTracks() {
        return this.tracks;
      }
      getAudioTracks() {
        return this.tracks.filter((t) => t.kind === 'audio');
      }
    };
  });

  afterEach(() => {
    window.AudioContext = originalAudioContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).MediaStream = originalMediaStream;
    vi.restoreAllMocks();
  });

  it('exposes no mixedTrack before any source is connected', () => {
    installMockAudioContext();
    const { result } = renderHook(() => useAudioMixer());
    expect(result.current.mixedTrack).toBeNull();
    expect(typeof result.current.connectMicrophone).toBe('function');
    expect(typeof result.current.connectScreenAudio).toBe('function');
  });

  it('creates a stable mixedTrack on first connect; identity stays the same across later connect/disconnect', () => {
    const { track: mixedTrack } = installMockAudioContext();
    const { result } = renderHook(() => useAudioMixer());

    let disconnectMic: (() => void) | undefined;
    act(() => {
      disconnectMic = result.current.connectMicrophone(makeTrack('mic-1'));
    });
    expect(result.current.mixedTrack).toBe(mixedTrack);

    // Connect a second source — mixedTrack identity must NOT change.
    let disconnectScreen: (() => void) | undefined;
    act(() => {
      disconnectScreen = result.current.connectScreenAudio(makeTrack('screen-1'));
    });
    expect(result.current.mixedTrack).toBe(mixedTrack);

    // Disconnect the mic — still the SAME mixedTrack reference.
    act(() => disconnectMic?.());
    expect(result.current.mixedTrack).toBe(mixedTrack);

    // Disconnect the screen — still the SAME mixedTrack reference. The
    // destination stays alive so a later reconnect doesn't renegotiate.
    act(() => disconnectScreen?.());
    expect(result.current.mixedTrack).toBe(mixedTrack);
  });

  it('keeps mixedTrack alive when reconnecting a previously-disconnected source', () => {
    const { track: mixedTrack } = installMockAudioContext();
    const { result } = renderHook(() => useAudioMixer());

    let disconnectMic: (() => void) | undefined;
    act(() => {
      disconnectMic = result.current.connectMicrophone(makeTrack('mic-1'));
    });
    act(() => disconnectMic?.());
    // Reconnect a DIFFERENT track — mixedTrack must stay the same object.
    let disconnectMic2: (() => void) | undefined;
    act(() => {
      disconnectMic2 = result.current.connectMicrophone(makeTrack('mic-2'));
    });
    expect(result.current.mixedTrack).toBe(mixedTrack);
    act(() => disconnectMic2?.());
  });

  it('dispose() tears down the graph and clears mixedTrack', () => {
    const { ctx, dest } = installMockAudioContext();
    const { result } = renderHook(() => useAudioMixer());

    act(() => {
      result.current.connectMicrophone(makeTrack('mic-1'));
    });
    expect(result.current.mixedTrack).not.toBeNull();

    act(() => {
      result.current.dispose();
    });
    expect(result.current.mixedTrack).toBeNull();
    expect(ctx.close).toHaveBeenCalled();
    expect(dest.disconnect).toHaveBeenCalled();
  });

  it('gain setters update state and push the value onto the GainNode', () => {
    const { gains } = installMockAudioContext();
    const { result } = renderHook(() => useAudioMixer());

    // Create the graph so the GainNodes exist.
    act(() => {
      result.current.connectMicrophone(makeTrack('mic-1'));
    });
    // Two gain nodes (voice + screen) get created upfront.
    expect(gains.length).toBe(2);
    const [voiceGain, screenGain] = gains;

    act(() => {
      result.current.setVoiceGain(0.5);
    });
    expect(result.current.voiceGain).toBe(0.5);
    expect(voiceGain.gain.setTargetAtTime).toHaveBeenCalledWith(0.5, expect.any(Number), 0.01);

    act(() => {
      result.current.setScreenGain(1.5);
    });
    expect(result.current.screenGain).toBe(1.5);
    expect(screenGain.gain.setTargetAtTime).toHaveBeenCalledWith(1.5, expect.any(Number), 0.01);
  });

  it('degrades gracefully when AudioContext is unavailable (no mixedTrack, no throw)', () => {
    // No AudioContext constructor at all.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).AudioContext = undefined;
    (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext = undefined;

    const { result } = renderHook(() => useAudioMixer());

    let disconnect: (() => void) | undefined;
    act(() => {
      // Should not throw.
      disconnect = result.current.connectMicrophone(makeTrack('mic-1'));
    });
    expect(result.current.mixedTrack).toBeNull();
    expect(typeof disconnect).toBe('function');
    act(() => disconnect?.());
  });
});
