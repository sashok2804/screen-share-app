import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseAecResult {
  /** Whether the AEC pipeline is currently engaged. */
  enabled: boolean;
  /** Toggle AEC on/off. Off = pass-through. */
  setEnabled: (next: boolean) => void;
  /**
   * Run a captured system-audio track through the AEC graph, using
   * `referenceStream` (the remote peer voices) as the cancellation reference.
   * Returns the cleaned MediaStream that should be published instead of the
   * raw capture. Returns null if AEC is disabled or unavailable.
   *
   * Reference MUST be the same stream that the local <audio> element is
   * playing — i.e. what is leaking into the system loopback via the speakers.
   */
  process: (
    capture: MediaStreamTrack,
    referenceStream: MediaStream | null,
  ) => MediaStreamTrack | null;
  /** Tear down the AEC graph (called automatically on unmount). */
  dispose: () => void;
  /** Last error encountered while building the graph. */
  error: string | null;
}

let sharedCtx: AudioContext | null = null;
async function getSharedAudioContext(): Promise<AudioContext> {
  if (!sharedCtx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API not supported');
    sharedCtx = new Ctor();
  }
  if (sharedCtx.state === 'suspended') {
    await sharedCtx.resume();
  }
  return sharedCtx;
}

let workletLoaded = false;
async function ensureWorklet(ctx: AudioContext): Promise<void> {
  if (workletLoaded) return;
  await ctx.audioWorklet.addModule(new URL('../workers/aec-worklet.js', import.meta.url));
  workletLoaded = true;
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
  } | null>(null);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
  }, []);

  const process = useCallback(
    (capture: MediaStreamTrack, referenceStream: MediaStream | null): MediaStreamTrack | null => {
      // If disabled, just pass the raw capture through.
      if (!enabled) return capture;
      if (!referenceStream) {
        // Nothing to cancel against; pass through.
        return capture;
      }

      // Tear down any previous graph before building a new one.
      disposeNodes();

      try {
        // We need a synchronous AudioContext handle here; if it isn't ready
        // yet, fall back to the raw capture for this session.
        if (!sharedCtx) {
          // Kick off async creation for next time.
          void getSharedAudioContext().then(() => ensureWorklet(sharedCtx!));
          return capture;
        }
        const ctx = sharedCtx;

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

        nodesRef.current = { ctx, captureSource, referenceSource, worklet, destination };

        const cleanedTrack = destination.stream.getAudioTracks()[0];
        return cleanedTrack ?? capture;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'AEC graph build failed';
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

  // Ensure the AudioContext + worklet are preloaded in the background so that
  // the synchronous `process()` call has them ready when needed.
  useEffect(() => {
    void getSharedAudioContext()
      .then((ctx) => ensureWorklet(ctx))
      .catch((err) => {
        const message = err instanceof Error ? err.message : 'Audio worklet init failed';
        setError(message);
      });
  }, []);

  useEffect(() => {
    return () => disposeNodes();
  }, [disposeNodes]);

  return { enabled, setEnabled, process, dispose, error };
}
