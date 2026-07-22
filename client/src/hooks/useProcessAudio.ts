import { useCallback, useEffect, useRef, useState } from 'react';
import type { StartProcessAudioOptions } from '../electron';

/**
 * Renderer-side bridge between the WASAPI loopback capture (main process) and
 * the WebRTC mesh. Receives raw mono Float32 PCM chunks via IPC and turns them
 * into a `MediaStreamTrack` backed by a `ScriptProcessorNode` +
 * `MediaStreamAudioDestinationNode`.
 *
 * Flow:
 *   main: loopback-capture native addon (per-process or system-wide WASAPI)
 *      ↓ (chunk: Float32Array, mono, 48 kHz) IPC `audio:chunk`
 *   renderer (this hook):
 *      ↓ handleChunk() pushes into a ring buffer
 *   ScriptProcessorNode.onaudioprocess drains the ring into its output buffer
 *      → MediaStreamAudioDestinationNode
 *      → destination.stream.getAudioTracks()[0]
 *
 * Why `ScriptProcessorNode` instead of an AudioWorklet?
 *   In the packaged Electron build (and on the production server) the
 *   Content-Security-Policy is `script-src 'self' 'unsafe-inline'` — it does
 *   NOT include `data:`. Vite inlines the module source as a
 *   `data:text/javascript;base64,...` URL in production builds, so loading
 *   that module is rejected by the CSP and throws an `AbortError`. The
 *   deprecated `ScriptProcessorNode` runs inline on the main thread, needs no
 *   external module load and therefore no CSP exceptions. The CPU cost is
 *   negligible for a single mono audio-publish path.
 *
 * Only active when `window.electronAPI?.isElectron === true`. Browser builds
 * resolve to no-ops (`start()` returns null, `stop()` is a no-op).
 *
 * Audio format: the main process already delivers **mono Float32 at 48 kHz**
 * (it converts the WASAPI stereo s16 stream down to mono f32), so the ring
 * buffer matches the Web Audio graph and the WebRTC voice-publish path
 * one-to-one — no client-side resampling.
 */

export interface UseProcessAudioResult {
  /** `true` after start() has succeeded and the track is alive. */
  isActive: boolean;
  /** Last error message surfaced from the loopback bridge (or null). */
  error: string | null;
  /**
   * Start capturing. Returns the resulting audio track, or null on failure
   * (including the browser-build no-op case, missing selection, and main-
   * process errors).
   *
   * `opts` must be one of:
   *   - `{ pid: <number> }`        — per-process capture (echo-free). Used when
   *                                  the host picks a specific application window.
   *   - `{ excludePid: <number> }` — capture everything EXCEPT this PID's tree.
   *                                  Used for "entire screen" picks where we
   *                                  pass our own Electron PID so the capture
   *                                  includes all desktop audio minus our own
   *                                  renderer's audio → echo-free system audio.
   *   - `{ system: true }`         — whole default render endpoint (fallback
   *                                  when the chosen window's PID can't be
   *                                  resolved).
   *
   * Passing nothing (or none of the above) is an error: audio is now chosen
   * automatically by `useScreenShare` based on the video source, but the
   * underlying hook still requires an explicit selection to start.
   */
  start: (opts: StartProcessAudioOptions) => Promise<MediaStreamTrack | null>;
  /** Stop the capture and release all resources. Safe to call when idle. */
  stop: () => Promise<void>;
}

const TARGET_SAMPLE_RATE = 48000;

/**
 * ScriptProcessor buffer size in sample-frames. Must be a power of two in
 * [256, 512, 1024, 2048, 4096, 8192, 16384]. 4096 ≈ 85 ms at 48 kHz — a good
 * trade-off between latency and main-thread overhead.
 */
const BUFFER_SIZE = 4096;

/**
 * Ring buffer length in sample-frames. ~340 ms at 48 kHz mono — enough headroom
 * to absorb IPC jitter without dropping samples.
 */
const RING_SIZE = 16384;

export function useProcessAudio(): UseProcessAudioResult {
  const isElectron =
    typeof window !== 'undefined' && window.electronAPI?.isElectron === true;

  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** AudioContext lazily created on first start(). */
  const audioContextRef = useRef<AudioContext | null>(null);
  /** The ScriptProcessorNode — kept so we can disconnect() on stop. */
  const scriptNodeRef = useRef<ScriptProcessorNode | null>(null);
  /** The MediaStreamDestination — its `.stream` provides the track. */
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  /** Unsubscribe for `onAudioChunk` (installed on start). */
  const unsubscribeChunkRef = useRef<(() => void) | null>(null);
  /** Unsubscribe for `onAudioError` (installed on start). */
  const unsubscribeErrorRef = useRef<(() => void) | null>(null);

  /**
   * Ring buffer state. Held in refs so the `onaudioprocess` closure (created
   * once per `start()`) can mutate them without rebinding. We deliberately use
   * a single underlying `Float32Array` plus write/read cursors and a live
   * sample counter — simpler and faster than shifting an array per chunk.
   */
  const ringBufferRef = useRef<Float32Array>(new Float32Array(RING_SIZE));
  const writePosRef = useRef(0);
  const readPosRef = useRef(0);
  const bufferedRef = useRef(0);

  /** Tear down everything we created. Idempotent. */
  const teardown = useCallback(async () => {
    if (unsubscribeChunkRef.current) {
      try {
        unsubscribeChunkRef.current();
      } catch {
        /* ignore */
      }
      unsubscribeChunkRef.current = null;
    }
    if (unsubscribeErrorRef.current) {
      try {
        unsubscribeErrorRef.current();
      } catch {
        /* ignore */
      }
      unsubscribeErrorRef.current = null;
    }
    if (scriptNodeRef.current) {
      try {
        // Detach the handler so no further audio callbacks fire after we
        // start tearing things down (some engines still call once more).
        scriptNodeRef.current.onaudioprocess = null;
      } catch {
        /* ignore */
      }
      try {
        scriptNodeRef.current.disconnect();
      } catch {
        /* ignore */
      }
      scriptNodeRef.current = null;
    }
    if (destinationRef.current) {
      try {
        destinationRef.current.disconnect();
      } catch {
        /* ignore */
      }
      // Stop the destination's tracks so any peer holding a reference knows.
      destinationRef.current.stream.getTracks().forEach((t) => t.stop());
      destinationRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        // close() returns a Promise in browsers.
        await audioContextRef.current.close();
      } catch {
        /* ignore */
      }
      audioContextRef.current = null;
    }
    // Reset the ring buffer state for the next session.
    ringBufferRef.current = new Float32Array(RING_SIZE);
    writePosRef.current = 0;
    readPosRef.current = 0;
    bufferedRef.current = 0;
    setIsActive(false);
  }, []);

  const start = useCallback(
    async (opts: StartProcessAudioOptions): Promise<MediaStreamTrack | null> => {
      if (!isElectron || !window.electronAPI) {
        // Browser build — caller should not have invoked us; bail gracefully.
        setError(null);
        return null;
      }
      const api = window.electronAPI;
      if (!api.startProcessAudio || !api.onAudioChunk) {
        setError('preload bridge missing startProcessAudio / onAudioChunk');
        return null;
      }

      // Validate the selection before doing any AudioContext work: the caller
      // must pass exactly one of {pid, excludePid, system}. We never want to
      // silently capture something the user didn't pick.
      const hasPid = typeof opts?.pid === 'number';
      const hasExcludePid = typeof opts?.excludePid === 'number';
      const wantSystem = opts?.system === true;
      if (!hasPid && !hasExcludePid && !wantSystem) {
        setError('Audio source not selected. Pick an application or system audio.');
        return null;
      }

      // Clean up any prior session before starting a new one.
      await teardown();
      setError(null);

      try {
        // 1) Set up the AudioContext + ScriptProcessor BEFORE starting capture
        //    so the first chunk has a destination ready.
        const Ctor: typeof AudioContext =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
        audioContextRef.current = ctx;
        if (ctx.state === 'suspended') {
          await ctx.resume().catch(() => {});
        }

        // ScriptProcessorNode: 0 inputs (we feed samples ourselves from the
        // ring buffer), 1 output (mono). `createScriptProcessor` is deprecated
        // but still implemented by every browser and by Electron's Chromium;
        // it is the only CSP-safe way to synthesise audio on the main thread.
        const node = ctx.createScriptProcessor(BUFFER_SIZE, 0, 1);
        scriptNodeRef.current = node;

        // Drain the ring buffer into the output on every audio block. We read
        // from refs because the same closure stays attached for the lifetime
        // of the session and the underlying values may be swapped on restart.
        node.onaudioprocess = (event: AudioProcessingEvent) => {
          const output = event.outputBuffer.getChannelData(0);
          const ring = ringBufferRef.current;
          let readPos = readPosRef.current;
          let buffered = bufferedRef.current;
          for (let i = 0; i < output.length; i++) {
            if (buffered > 0) {
              output[i] = ring[readPos];
              readPos = (readPos + 1) % RING_SIZE;
              buffered--;
            } else {
              // Underrun: emit silence rather than stalling the graph.
              output[i] = 0;
            }
          }
          readPosRef.current = readPos;
          bufferedRef.current = buffered;
        };

        const dest = ctx.createMediaStreamDestination();
        dest.channelCount = 1;
        node.connect(dest);
        destinationRef.current = dest;

        // 2) Subscribe to chunk / error events. Each captured chunk is pushed
        //    into the ring buffer; the ScriptProcessor's onaudioprocess will
        //    pull from it on the next audio quantum.
        const handleChunk = (chunk: Float32Array) => {
          if (!chunk || chunk.length === 0) return;
          const view =
            chunk instanceof Float32Array ? chunk : new Float32Array(chunk);
          const ring = ringBufferRef.current;
          let writePos = writePosRef.current;
          let readPos = readPosRef.current;
          let buffered = bufferedRef.current;
          for (let i = 0; i < view.length; i++) {
            if (buffered >= RING_SIZE) {
              // Overflow: drop the oldest sample to make room. This bounds
              // latency at the cost of a single-sample glitch — far better
              // than unbounded growth that would drift the whole stream.
              readPos = (readPos + 1) % RING_SIZE;
              buffered--;
            }
            ring[writePos] = view[i];
            writePos = (writePos + 1) % RING_SIZE;
            buffered++;
          }
          writePosRef.current = writePos;
          readPosRef.current = readPos;
          bufferedRef.current = buffered;
        };

        unsubscribeChunkRef.current = api.onAudioChunk((chunk) =>
          handleChunk(chunk),
        );

        if (api.onAudioError) {
          unsubscribeErrorRef.current = api.onAudioError((payload) => {
            console.error('[useProcessAudio] capture error:', payload.message);
            setError(payload.message);
          });
        }

        // 3) Ask the main process to start WASAPI loopback capture.
        const result = await api.startProcessAudio(opts);
        if (!result || result.ok !== true) {
          const msg = result && result.ok === false ? result.error : 'unknown start error';
          setError(msg);
          await teardown();
          return null;
        }

        setIsActive(true);
        const track = dest.stream.getAudioTracks()[0] ?? null;
        if (!track) {
          setError('MediaStreamDestination produced no audio track');
          await teardown();
          return null;
        }
        return track;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[useProcessAudio] start failed:', msg);
        setError(msg);
        await teardown();
        return null;
      }
    },
    [isElectron, teardown],
  );

  const stop = useCallback(async () => {
    if (isElectron && window.electronAPI?.stopProcessAudio) {
      try {
        await window.electronAPI.stopProcessAudio();
      } catch (err) {
        console.error('[useProcessAudio] stopProcessAudio failed', err);
      }
    }
    await teardown();
  }, [isElectron, teardown]);

  // Unmount safety net.
  useEffect(() => {
    return () => {
      // We can't await here; trigger the async teardown but don't wait.
      if (isElectron && window.electronAPI?.stopProcessAudio) {
        void window.electronAPI.stopProcessAudio().catch(() => {});
      }
      void teardown();
    };
  }, [isElectron, teardown]);

  return { isActive, error, start, stop };
}
