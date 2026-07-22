import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseAudioMixerResult {
  /** The single mixed audio track to publish via WebRTC. Null if no sources. */
  mixedTrack: MediaStreamTrack | null;
  /** Connect a microphone track to the mix. Returns a disconnect function. */
  connectMicrophone: (track: MediaStreamTrack) => () => void;
  /** Connect a screen-share audio track to the mix. Returns a disconnect function. */
  connectScreenAudio: (track: MediaStreamTrack) => () => void;
  /** Voice gain (0..2), default 1.0. */
  voiceGain: number;
  /** Screen audio gain (0..2), default 1.0. */
  screenGain: number;
  setVoiceGain: (g: number) => void;
  setScreenGain: (g: number) => void;
  /** Tear down the whole mixer graph. */
  dispose: () => void;
}

/**
 * Single-source WebRTC audio mixer.
 *
 * WHY THIS EXISTS
 * ---------------
 * In the mesh architecture we publish exactly ONE audio sender per
 * RTCPerrerConnection. Before this hook the host would call
 * `mesh.publishAudio()` twice (once for the mic from `useVoice`, once for the
 * screen-share audio from `useScreenShare`), producing two audio senders in
 * the same PeerConnection. WebRTC then can't agree on a single audio
 * transceiver, SDP renegotiation breaks, and BOTH tracks drop out — the user
 * has to toggle the mic to recover and the demo sound vanishes entirely.
 *
 * THE FIX
 * -------
 * We mix every local audio source (mic + screen audio) through ONE Web Audio
 * graph and expose a single `MediaStreamTrack` taken from the destination
 * node. The mesh publishes that single track and never sees a second audio
 * sender, no matter how many sources the host adds or removes.
 *
 * GRAPH
 * -----
 *   Mic   ── MediaStreamSource ── GainNode(voice)  ─┐
 *                                                      ├── MediaStreamDestination ── single mixedTrack ── WebRTC
 *   Screen ── MediaStreamSource ── GainNode(screen) ─┘
 *
 * LIFECYCLE INVARIANTS
 * --------------------
 * - The `mixedTrack` reference is STABLE for the lifetime of the mixer once
 *   it has been created. Sources connect/disconnect around it; the track
 *   object the RTCPerrerConnection holds never changes. We deliberately keep
 *   the destination alive even when every source has disconnected so that a
 *   later re-connect doesn't force a renegotiation with a new track.
 * - The AudioContext is created lazily on the first `connect*` call and torn
 *   down by `dispose()` (or unmount).
 *
 * WHY NOT MICSEVERYTHING-AS-ONE-TRACK AT THE SOURCE
 * -------------------------------------------------
 * Doing the mix inside `useProcessAudio` (or inside `useScreenShare`) would
 * couple the screen-audio hook to the mic lifecycle and make it impossible to
 * route browser getDisplayMedia audio through the same fix. A standalone
 * mixer is the single source of truth for "what goes to WebRTC".
 */
export function useAudioMixer(): UseAudioMixerResult {
  /** Lazily-created AudioContext + nodes. */
  const ctxRef = useRef<AudioContext | null>(null);
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const voiceGainRef = useRef<GainNode | null>(null);
  const screenGainRef = useRef<GainNode | null>(null);

  /**
   * Currently-connected source nodes, so disconnect() can clean them up.
   * Keyed by the input track id + a counter (a track could theoretically be
   * connected twice, though in practice it won't be).
   */
  const micSourcesRef = useRef<Map<string, MediaStreamAudioSourceNode>>(new Map());
  const screenSourcesRef = useRef<Map<string, MediaStreamAudioSourceNode>>(new Map());

  /** Counter to disambiguate connections in the rare reconnect-same-track case. */
  const counterRef = useRef(0);

  const [mixedTrack, setMixedTrack] = useState<MediaStreamTrack | null>(null);
  const [voiceGain, setVoiceGainState] = useState(1.0);
  const [screenGain, setScreenGainState] = useState(1.0);

  /**
   * Lazily build the graph on first connect. Idempotent — no-op if already
   * built. Returns false if the Web Audio API isn't available (older
   * browsers / test envs without an AudioContext mock) so callers can degrade
   * gracefully (the publish path will then never see a mixedTrack).
   */
  const ensureGraph = useCallback((): boolean => {
    if (ctxRef.current && destinationRef.current) return true;
    try {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return false;
      const ctx = new Ctor();
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {
          /* will retry on next connect */
        });
      }
      const destination = ctx.createMediaStreamDestination();
      // Single mono bus is enough — WebRTC voice path is mono anyway and
      // mixing stereo sources through a mono destination avoids any channel
      // mismatch surprises.
      destination.channelCount = 1;

      const voiceGainNode = ctx.createGain();
      voiceGainNode.gain.value = voiceGain;
      const screenGainNode = ctx.createGain();
      screenGainNode.gain.value = screenGain;

      voiceGainNode.connect(destination);
      screenGainNode.connect(destination);

      ctxRef.current = ctx;
      destinationRef.current = destination;
      voiceGainRef.current = voiceGainNode;
      screenGainRef.current = screenGainNode;

      const track = destination.stream.getAudioTracks()[0] ?? null;
      if (track) setMixedTrack(track);
      return true;
    } catch (err) {
      console.error('[useAudioMixer] failed to build graph', err);
      return false;
    }
  }, [voiceGain, screenGain]);

  /**
   * Internal helper — connect a track to a gain bus, remembering the source
   * node under a unique key so the returned disconnect fn can find it.
   */
  const connectToBus = useCallback(
    (
      track: MediaStreamTrack,
      gainRef: React.RefObject<GainNode | null>,
      bucket: React.RefObject<Map<string, MediaStreamAudioSourceNode>>,
    ): (() => void) => {
      if (!ensureGraph()) return () => {};
      const ctx = ctxRef.current;
      const gain = gainRef.current;
      if (!ctx || !gain) return () => {};

      // Wrap the bare track in a MediaStream — createMediaStreamSource needs
      // a stream, not a track. We deliberately DON'T reuse the source stream
      // the caller may have, so disconnecting one input doesn't disturb any
      // other consumer of that stream (e.g. the local VU meter / preview).
      const sourceStream = new MediaStream([track]);
      let source: MediaStreamAudioSourceNode;
      try {
        source = ctx.createMediaStreamSource(sourceStream);
      } catch (err) {
        console.warn('[useAudioMixer] createMediaStreamSource failed', err);
        return () => {};
      }
      source.connect(gain);

      const key = `${track.id}#${counterRef.current++}`;
      bucket.current.set(key, source);

      return () => {
        try {
          source.disconnect();
        } catch {
          /* already gone */
        }
        bucket.current.delete(key);
      };
    },
    [ensureGraph],
  );

  const connectMicrophone = useCallback(
    (track: MediaStreamTrack): (() => void) =>
      connectToBus(track, voiceGainRef, micSourcesRef),
    [connectToBus],
  );

  const connectScreenAudio = useCallback(
    (track: MediaStreamTrack): (() => void) =>
      connectToBus(track, screenGainRef, screenSourcesRef),
    [connectToBus],
  );

  const setVoiceGain = useCallback((g: number) => {
    setVoiceGainState(g);
    if (voiceGainRef.current) {
      // Use setTargetAtTime to avoid zipper noise on the live signal.
      try {
        voiceGainRef.current.gain.setTargetAtTime(g, ctxRef.current?.currentTime ?? 0, 0.01);
      } catch {
        voiceGainRef.current.gain.value = g;
      }
    }
  }, []);

  const setScreenGain = useCallback((g: number) => {
    setScreenGainState(g);
    if (screenGainRef.current) {
      try {
        screenGainRef.current.gain.setTargetAtTime(g, ctxRef.current?.currentTime ?? 0, 0.01);
      } catch {
        screenGainRef.current.gain.value = g;
      }
    }
  }, []);

  const dispose = useCallback(() => {
    for (const source of micSourcesRef.current.values()) {
      try {
        source.disconnect();
      } catch {
        /* ignore */
      }
    }
    for (const source of screenSourcesRef.current.values()) {
      try {
        source.disconnect();
      } catch {
        /* ignore */
      }
    }
    micSourcesRef.current.clear();
    screenSourcesRef.current.clear();

    if (voiceGainRef.current) {
      try {
        voiceGainRef.current.disconnect();
      } catch {
        /* ignore */
      }
      voiceGainRef.current = null;
    }
    if (screenGainRef.current) {
      try {
        screenGainRef.current.disconnect();
      } catch {
        /* ignore */
      }
      screenGainRef.current = null;
    }
    if (destinationRef.current) {
      try {
        destinationRef.current.disconnect();
      } catch {
        /* ignore */
      }
      destinationRef.current.stream.getTracks().forEach((t) => t.stop());
      destinationRef.current = null;
    }
    if (ctxRef.current) {
      try {
        void ctxRef.current.close();
      } catch {
        /* ignore */
      }
      ctxRef.current = null;
    }
    setMixedTrack(null);
  }, []);

  // Tear down on unmount.
  useEffect(() => {
    return () => dispose();
  }, [dispose]);

  return {
    mixedTrack,
    connectMicrophone,
    connectScreenAudio,
    voiceGain,
    screenGain,
    setVoiceGain,
    setScreenGain,
    dispose,
  };
}
