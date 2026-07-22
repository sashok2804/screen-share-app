import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseVoiceResult {
  micEnabled: boolean;
  /** Whether the user has given mic permission. */
  hasPermission: boolean;
  /** Error from the last mic attempt. */
  error: string | null;
  toggleMic: () => Promise<void>;
  /** Live audio element that plays incoming remote audio tracks. */
  remoteAudioRef: React.RefObject<HTMLAudioElement | null>;
  /**
   * The live MediaStream of incoming remote voices. Used as the AEC
   * reference signal for system-audio capture cancellation.
   */
  getRemoteStream: () => MediaStream | null;
  /** Attach a remote audio track to the output element. */
  attachRemoteAudio: (track: MediaStreamTrack) => void;
  /** Detach a previously attached remote audio track. */
  detachRemoteAudio: (track: MediaStreamTrack) => void;
  /** The current local microphone track (for VU meter). Null if mic is off. */
  localTrack: MediaStreamTrack | null;
  /**
   * Subscribe to remote audio tracks keyed by participant id. The list is
   * updated whenever a track is added or removed. Use this to render per-user
   * VU meters.
   */
  remoteTracks: ReadonlyMap<string, MediaStreamTrack>;
  /** Register a remote track (called from Room when mesh.onTrack fires). */
  registerRemote: (peerId: string, track: MediaStreamTrack) => void;
  /** Unregister a remote track (called on peer-left / track-ended). */
  unregisterRemote: (peerId: string) => void;
}

/**
 * Microphone capture.
 *
 * This hook only CAPTURES the microphone and exposes the resulting track via
 * `localTrack`. It no longer publishes anything to the mesh directly — the
 * Room component feeds the track into the central `useAudioMixer`, which
 * combines it with screen-share audio into a single WebRTC track. That single
 * track is what the mesh publishes. Publishing the mic separately caused two
 * audio senders to land in the same RTCPeerConnection, breaking SDP
 * renegotiation whenever the host had mic + screen audio both on.
 */
export function useVoice(): UseVoiceResult {
  const [micEnabled, setMicEnabled] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localTrack, setLocalTrack] = useState<MediaStreamTrack | null>(null);
  const [remoteTracks, setRemoteTracks] = useState<ReadonlyMap<string, MediaStreamTrack>>(
    new Map(),
  );

  const trackRef = useRef<MediaStreamTrack | null>(null);
  const remoteStreamRef = useRef<MediaStream>(new MediaStream());
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  /** peerId → track, kept in a ref for synchronous access. */
  const remoteByPeerRef = useRef<Map<string, MediaStreamTrack>>(new Map());

  // Wire the remote stream to the audio element whenever it changes.
  useEffect(() => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStreamRef.current;
    }
  }, []);

  const syncRemoteState = useCallback(() => {
    setRemoteTracks(new Map(remoteByPeerRef.current));
  }, []);

  const startMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('No audio track in getUserMedia result');
      trackRef.current = track;
      setLocalTrack(track);
      setMicEnabled(true);
      setHasPermission(true);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Microphone access failed';
      setError(message);
      setMicEnabled(false);
    }
  }, []);

  const stopMic = useCallback(() => {
    trackRef.current = null;
    setLocalTrack(null);
    setMicEnabled(false);
  }, []);

  const toggleMic = useCallback(async () => {
    if (micEnabled) stopMic();
    else await startMic();
  }, [micEnabled, startMic, stopMic]);

  const attachRemoteAudio = useCallback(
    (track: MediaStreamTrack) => {
      if (!remoteStreamRef.current.getTracks().includes(track)) {
        remoteStreamRef.current.addTrack(track);
      }
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStreamRef.current;
      }
    },
    [],
  );

  const detachRemoteAudio = useCallback(
    (track: MediaStreamTrack) => {
      remoteStreamRef.current.removeTrack(track);
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStreamRef.current;
      }
    },
    [],
  );

  /** Register a remote track keyed by participant id (for VU meters). */
  const registerRemote = useCallback(
    (peerId: string, track: MediaStreamTrack) => {
      remoteByPeerRef.current.set(peerId, track);
      syncRemoteState();
    },
    [syncRemoteState],
  );

  /** Forget a participant's track (peer left or track ended). */
  const unregisterRemote = useCallback(
    (peerId: string) => {
      if (remoteByPeerRef.current.delete(peerId)) {
        syncRemoteState();
      }
    },
    [syncRemoteState],
  );

  useEffect(() => {
    return () => {
      trackRef.current?.stop();
    };
  }, []);

  return {
    micEnabled,
    hasPermission,
    error,
    toggleMic,
    remoteAudioRef,
    getRemoteStream: () => remoteStreamRef.current,
    attachRemoteAudio,
    detachRemoteAudio,
    localTrack,
    remoteTracks,
    registerRemote,
    unregisterRemote,
  };
}
