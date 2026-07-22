import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Renderer-side bridge between the FFmpeg subprocess (main process) and the
 * WebRTC mesh. Receives raw Float32 PCM chunks via IPC and turns them into a
 * `MediaStreamTrack` backed by a `ScriptProcessorNode` +
 * `MediaStreamAudioDestinationNode`.
 *
 * Flow:
 *   main: ffmpeg.exe -f dshow -i audio="..." -f f32le pipe:1
 *      ↓ (chunk: Float32Array) IPC `audio:chunk`
 *   renderer (this hook):
 *      ↓ handleChunk() pushes into a ring buffer
 *   ScriptProcessorNode.onaudioprocess drains the ring into its output buffer
 *      → MediaStreamAudioDestinationNode
 *      → destination.stream.getAudioTracks()[0]
 *
 * Why `ScriptProcessorNode` instead of the worklet-based processor that used
 *   to live here?
 *   In the packaged Electron build (and on the production server) the
 *   Content-Security-Policy is `script-src 'self' 'unsafe-inline'` — it does
 *   NOT include `data:`. Vite inlines the module source as a
 *   `data:text/javascript;base64,...` URL in production builds, so loading
 *   that module is rejected by the CSP and throws an
 *   `AbortError` ("The user aborted a request"). `ScriptProcessorNode` runs
 *   inline on the main thread, needs no external module load and therefore no
 *   CSP exceptions — it works in browsers and packaged Electron alike. The CPU
 *   cost is negligible for a single mono voice-publish path.
 *
 * Only active when `window.electronAPI?.isElectron === true`. Browser builds
 * resolve to no-ops (`start()` returns null, `stop()` is a no-op).
 *
 * Audio format notes:
 *   - We request **mono** (channels: 1) from FFmpeg so the ring buffer matches
 *     the WebRTC voice-publish path. If the user later wants stereo, change
 *     `channels` here and de-interleave in `handleChunk`.
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
   *
   * If `deviceName` is omitted, the hook calls `listAudioDevices()` and picks a
   * sensible default (preferring virtual loopback devices like Voicemeeter /
   * VB-Audio Virtual Cable over microphones). See `pickDefaultAudioDevice`.
   */
  start: (deviceName?: string) => Promise<MediaStreamTrack | null>;
  /** Stop the capture and release all resources. Safe to call when idle. */
  stop: () => Promise<void>;
}

const TARGET_SAMPLE_RATE = 48000;
const TARGET_CHANNELS = 1;

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

/**
 * Heuristic default-device picker for DirectShow **loopback** capture.
 *
 * The goal is to capture what the sound card is *playing* (system audio,
 * games, video) — NOT what the user is saying into a microphone. This is the
 * inverse of mic capture, so the priority list has to favour physical
 * speakers/headphones and Windows' built-in loopback over virtual microphones
 * and cables.
 *
 * Order (first match wins):
 *   1. Windows' built-in loopback endpoints — `Stereo Mix` (English),
 *      `Стерео микшер` (Russian), `Что слышно` (Russian UI), `Wave Out`,
 *      `Loopback`, anything with `Mix` as a whole word. These are frequently
 *      disabled by default but are exactly what we want when present.
 *   2. Voicemeeter HARDWARE outputs in order — `Voicemeeter Out A1` first
 *      (the typical speakers/headphones output), then `A2`, `A3`, then a
 *      catch-all `A\d` for the rest. A1 is listed explicitly because the
 *      dshow enumeration order is not stable: on many installs `A4` sorts
 *      before `A1`, and without an explicit rule the picker chose `A4`
 *      (often not wired to anything) and peers heard silence.
 *   3. `Voicemeeter VAIO` (`Voicemeeter Input`) — captures whatever is routed
 *      into the mixer.
 *
 * Explicitly **NOT** preferred (these are virtual microphones / virtual cables
 * that carry the user's *voice*, not the system sound):
 *   - `Voicemeeter Out B1` / `B2` / `B3` (virtual mic sent to Discord etc.)
 *   - `Voicemeeter AUX`
 *   - `CABLE Output` (VB-Audio Virtual Cable receiver end)
 *
 * Fall-through: the first device that does not look like a microphone / virtual
 * mic / virtual cable, else the first device whatever it is.
 *
 * Exported so the picker can be unit-tested independently of the hook.
 *
 * @param devices  DirectShow audio device names from `listAudioDevices()`.
 * @returns the chosen device name (guaranteed non-empty if `devices` is).
 */
export function pickDefaultAudioDevice(devices: string[]): string {
  // Priority order: try most-specific patterns first.
  // The Voicemeeter block lists each hardware A-output by number before the
  // generic `A\d` fallback, so A1 (typical speakers/headphones) is picked over
  // A2/A3/A4 even when A4 sorts earlier in the dshow enumeration. With a single
  // `/Voicemeeter Out A\d/i` rule the regex matched the FIRST device in array
  // order — which on real installs is frequently A4 (not wired to anything),
  // so peers heard silence.
  const priority = [
    /Stereo Mix/i,
    /Стерео микшер/i,
    /Что слышно/i,
    /Wave Out/i,
    /Loopback/i,
    /Mix\b/i,
    // Voicemeeter HARDWARE OUT — A1 is the typical speakers/headphones output.
    /Voicemeeter Out A1/i,
    /Voicemeeter Out A2/i,
    /Voicemeeter Out A3/i,
    /Voicemeeter Out A\d/i, // fallback for other A-devices (A4, A5, ...)
    /Voicemeeter VAIO/i,
  ];
  for (const pattern of priority) {
    const match = devices.find((d) => pattern.test(d));
    if (match) return match;
  }
  // Fall back to the first device that's NOT obviously a microphone or
  // virtual cable — those capture voice, not system sound.
  const nonMic = devices.find(
    (d) =>
      !/микрофон|microphone|mic|Voicemeeter Out B\d|CABLE Output|AUX/i.test(d),
  );
  return nonMic ?? devices[0];
}

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

      // If the caller did not name a device, try to pick a sensible default
      // (virtual loopback sink > microphone). We never want to send an empty
      // name down to FFmpeg — that resolves to the non-existent `dummy` device
      // and the capture exits with code 1 ("user aborted a request" in the UI).
      if (!deviceName) {
        try {
          const devices = await api.listAudioDevices?.();
          const audioDevices = devices?.audio ?? [];
          // Log the full list so the user / support can see what dshow
          // actually exposes on this machine — Voicemeeter routing in
          // particular varies a lot between installs.
          // eslint-disable-next-line no-console
          console.log('[useProcessAudio] available audio devices:', audioDevices);
          if (audioDevices.length === 0) {
            setError(
              'No audio capture devices found. Install VB-Cable or enable Stereo Mix.',
            );
            return null;
          }
          deviceName = pickDefaultAudioDevice(audioDevices);
          // eslint-disable-next-line no-console
          console.log('[useProcessAudio] picked device:', deviceName);
        } catch (err) {
          console.error('[useProcessAudio] listAudioDevices failed:', err);
          // Fall through — the empty name will be rejected by the main process
          // with a clearer "No audio device specified" message than the old
          // `dummy` exit-1 path.
        }
      }

      try {
        // 1) Set up the AudioContext + ScriptProcessor BEFORE starting FFmpeg
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

        // 2) Subscribe to chunk / error events. Each FFmpeg chunk is pushed
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
