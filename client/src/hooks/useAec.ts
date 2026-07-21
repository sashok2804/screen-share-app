import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseAecResult {
  /** Whether the AEC pipeline is currently engaged. */
  enabled: boolean;
  /** Toggle AEC on/off. Off = pass-through. */
  setEnabled: (next: boolean) => void;
  /**
   * Run a captured system-audio track through the AEC graph, using
   * `referenceStream` (the remote peer voices) as the cancellation reference.
   * Returns the cleaned MediaStreamTrack that should be published instead of
   * the raw capture. Returns null if AEC is disabled or the graph could not
   * be built (caller should fall back to the raw capture in that case).
   *
   * ASYNC: this waits for the AudioContext + worklet module to be ready
   * (which may take ~50-200 ms on first call).
   */
  process: (
    capture: MediaStreamTrack,
    referenceStream: MediaStream | null,
  ) => Promise<MediaStreamTrack | null>;
  /** Tear down the AEC graph (called automatically on unmount). */
  dispose: () => void;
  /** Last error encountered while building the graph. */
  error: string | null;
}

// ─── Module-singleton AudioContext (shared across all hooks) ────────────────

let sharedCtx: AudioContext | null = null;
let sharedCtxPromise: Promise<AudioContext> | null = null;

async function getSharedAudioContext(): Promise<AudioContext> {
  if (sharedCtx) return sharedCtx;
  if (sharedCtxPromise) return sharedCtxPromise;

  sharedCtxPromise = (async () => {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API not supported');
    const ctx = new Ctor();
    if (ctx.state === 'suspended') {
      // May reject if no user gesture yet — caller should handle gracefully.
      try {
        await ctx.resume();
      } catch {
        /* will retry on next call */
      }
    }
    sharedCtx = ctx;
    return ctx;
  })();

  return sharedCtxPromise;
}

let workletLoaded = false;
let workletLoadPromise: Promise<void> | null = null;

async function ensureWorklet(ctx: AudioContext): Promise<void> {
  if (workletLoaded) return;
  if (workletLoadPromise) return workletLoadPromise;

  workletLoadPromise = (async () => {
    await ctx.audioWorklet.addModule(new URL('../workers/aec-worklet.js', import.meta.url));
    workletLoaded = true;
  })();

  return workletLoadPromise;
}

/**
 * Adaptive Echo Cancellation hook for system-audio capture.
 *
 * When enabled, replaces the raw `getDisplayMedia` audio track with a
 * processed one where the far-end reference (remote peer voices) is cancelled
 * out via a 1024-tap NLMS adaptive filter (see workers/aec-worklet.js).
 *
 * Without this, screen-share with system audio creates a feedback loop: the
 * remote peer hears themselves through your speakers → loopback → back to them.
 */
export function useAec(): UseAecResult {
  const [enabled, setEnabledState] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Active AEC nodes for the current capture track. */
  const nodesRef = useRef<{
    ctx: AudioContext;
    captureSource: MediaStreamAudioSourceNode;
    referenceSource: MediaStreamAudioSourceNode;
    worklet: AudioWorkletNode;
    destination: MediaStreamAudioDestinationNode;
    referenceTrackListener?: () => void;
  } | null>(null);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
  }, []);

  const process = useCallback(
    async (
      capture: MediaStreamTrack,
      referenceStream: MediaStream | null,
    ): Promise<MediaStreamTrack | null> => {
      // If disabled, just pass the raw capture through.
      if (!enabled) return capture;
      if (!referenceStream) {
        // Nothing to cancel against; pass through.
        return capture;
      }

      // Tear down any previous graph before building a new one.
      disposeNodes();

      try {
        const ctx = await getSharedAudioContext();
        // Resume in case the context was suspended (e.g. after tab switch).
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
        await ensureWorklet(ctx);

        const captureStream = new MediaStream([capture]);
        const referenceTracks = referenceStream.getAudioTracks();
        if (referenceTracks.length === 0) return capture;

        const captureSource = ctx.createMediaStreamSource(captureStream);
        const referenceSource = ctx.createMediaStreamSource(referenceStream);
        const worklet = new AudioWorkletNode(ctx, 'aec-processor', {
          numberOfInputs: 2,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        // input 0 = near-end (capture), input 1 = far-end (reference).
        captureSource.connect(worklet, 0, 0);
        referenceSource.connect(worklet, 0, 1);

        const destination = ctx.createMediaStreamDestination();
        worklet.connect(destination);

        // If the reference track ends (peer leaves), rebuild without it.
        const referenceTrack = referenceTracks[0];
        const onReferenceEnded = () => {
          // Lightweight: just disconnect the reference input.
          try {
            referenceSource.disconnect();
          } catch {
            /* already gone */
          }
        };
        referenceTrack.addEventListener('ended', onReferenceEnded);

        nodesRef.current = {
          ctx,
          captureSource,
          referenceSource,
          worklet,
          destination,
          referenceTrackListener: onReferenceEnded,
        };

        const cleanedTrack = destination.stream.getAudioTracks()[0];
        return cleanedTrack ?? capture;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'AEC graph build failed';
        console.warn('[aec] falling back to raw capture:', message);
        setError(message);
        return capture; // graceful fallback
      }
    },
    [enabled],
  );

  const disposeNodes = useCallback(() => {
    const nodes = nodesRef.current;
    if (!nodes) return;
    try {
      if (nodes.referenceTrackListener && nodes.referenceSource.mediaStream) {
        const t = nodes.referenceSource.mediaStream.getAudioTracks()[0];
        t?.removeEventListener('ended', nodes.referenceTrackListener);
      }
    } catch {
      /* ignore */
    }
    try {
      nodes.captureSource.disconnect();
      nodes.referenceSource.disconnect();
      nodes.worklet.disconnect();
      nodes.destination.disconnect();
    } catch {
      /* already gone */
    }
    nodesRef.current = null;
  }, []);

  const dispose = useCallback(() => {
    disposeNodes();
  }, [disposeNodes]);

  // Preload the AudioContext + worklet in the background so that the first
  // real `process()` call is fast.
  useEffect(() => {
    let cancelled = false;
    getSharedAudioContext()
      .then((ctx) => ensureWorklet(ctx))
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Audio worklet init failed';
        console.warn('[aec] preload failed:', message);
        setError(message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => disposeNodes();
  }, [disposeNodes]);

  return { enabled, setEnabled, process, dispose, error };
}
