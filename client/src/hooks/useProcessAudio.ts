import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Renderer-side bridge between the FFmpeg subprocess (main process) and the
 * WebRTC mesh. Receives raw Float32 PCM chunks via IPC and turns them into a
 * `MediaStreamTrack` backed by an AudioWorklet + MediaStreamAudioDestination.
 *
 * Flow:
 *   main: ffmpeg.exe -f dshow -i audio="..." -f f32le pipe:1
 *      ↓ (chunk: Float32Array) IPC `audio:chunk`
 *   renderer (this hook):
 *      ↓ worklet.port.postMessage(chunk)
 *   AudioWorkletProcessor → AudioNode → MediaStreamAudioDestinationNode
 *      → destination.stream.getAudioTracks()[0]
 *
 * Only active when `window.electronAPI?.isElectron === true`. Browser builds
 * resolve to no-ops (`start()` returns null, `stop()` is a no-op).
 *
 * Audio format notes:
 *   - We request **mono** (channels: 1) from FFmpeg so the worklet ring buffer
 *     matches the WebRTC voice-publish path. If the user later wants stereo,
 *     change `channels` here and add de-interleave logic in the worklet.
 *   - Sample rate is fixed at 48000 to match the AudioContext; the WebRTC
 *     sender will resample as needed for the codec.
 */

export interface UseProcessAudioResult {
  /** `true` after start() has succeeded and the track is alive. */
  isActive: boolean;
  /** Last error message surfaced from the FFmpeg bridge (or null). */
  error: string | null;
  /**
   * Start capturing. Returns the resulting audio track, or null on failure
   * (including the browser-build no-op case and missing FFmpeg).
   */
  start: (deviceName?: string) => Promise<MediaStreamTrack | null>;
  /** Stop the capture and release all resources. Safe to call when idle. */
  stop: () => Promise<void>;
}

const TARGET_SAMPLE_RATE = 48000;
const TARGET_CHANNELS = 1;

export function useProcessAudio(): UseProcessAudioResult {
  const isElectron =
    typeof window !== 'undefined' && window.electronAPI?.isElectron === true;

  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** AudioContext lazily created on first start(). */
  const audioContextRef = useRef<AudioContext | null>(null);
  /** The worklet node — kept so we can disconnect() on stop. */
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  /** The MediaStreamDestination — its `.stream` provides the track. */
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  /** Unsubscribe for `onAudioChunk` (installed on start). */
  const unsubscribeChunkRef = useRef<(() => void) | null>(null);
  /** Unsubscribe for `onAudioError` (installed on start). */
  const unsubscribeErrorRef = useRef<(() => void) | null>(null);

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
    if (workletNodeRef.current) {
      try {
        workletNodeRef.current.disconnect();
      } catch {
        /* ignore */
      }
      workletNodeRef.current = null;
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
    setIsActive(false);
  }, []);

  const start = useCallback(
    async (deviceName?: string): Promise<MediaStreamTrack | null> => {
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

      // Clean up any prior session before starting a new one.
      await teardown();
      setError(null);

      try {
        // 1) Set up the AudioContext + worklet BEFORE starting FFmpeg so the
        //    first chunk has a destination ready.
        const Ctor: typeof AudioContext =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
        audioContextRef.current = ctx;
        if (ctx.state === 'suspended') {
          await ctx.resume().catch(() => {});
        }

        await ctx.audioWorklet.addModule(
          new URL('../workers/process-audio-worklet.js', import.meta.url).toString(),
        );

        const node = new AudioWorkletNode(ctx, 'process-audio-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
        });
        workletNodeRef.current = node;

        const dest = ctx.createMediaStreamDestination();
        dest.channelCount = 1;
        node.connect(dest);
        destinationRef.current = dest;

        // 2) Subscribe to chunk / error events.
        unsubscribeChunkRef.current = api.onAudioChunk((chunk) => {
          const n = node;
          if (!n || !chunk || chunk.length === 0) return;
          try {
            // Transfer the Float32Array buffer to the worklet thread (zero-copy).
            // We must copy first because the IPC payload is not in a transferable
            // position (it's owned by the structured-clone result), but postMessage
            // will still move it across threads cleanly here.
            const view = chunk instanceof Float32Array
              ? chunk
              : new Float32Array(chunk);
            const copy = new Float32Array(view.length);
            copy.set(view);
            n.port.postMessage(copy, [copy.buffer]);
          } catch (err) {
            console.error('[useProcessAudio] chunk postMessage failed', err);
          }
        });

        if (api.onAudioError) {
          unsubscribeErrorRef.current = api.onAudioError((payload) => {
            console.error('[useProcessAudio] ffmpeg error:', payload.message);
            setError(payload.message);
          });
        }

        // 3) Ask the main process to spawn FFmpeg.
        const result = await api.startProcessAudio({
          deviceName,
          sampleRate: TARGET_SAMPLE_RATE,
          channels: TARGET_CHANNELS,
        });
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
