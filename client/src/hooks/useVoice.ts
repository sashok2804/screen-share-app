import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseMeshResult } from './useMesh';

export interface UseVoiceResult {
  micEnabled: boolean;
  /** Whether the user has given mic permission. */
  hasPermission: boolean;
  /** Error from the last mic attempt. */
  error: string | null;
  toggleMic: () => Promise<void>;
  /** Live audio element that plays incoming remote audio tracks. */
  remoteAudioRef: React.RefObject<HTMLAudioElement | null>;
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
 * Microphone capture + publish through the mesh.
 *
 * Always sends audio (when enabled); there's no per-viewer subscription —
 * voice goes to everyone in the room.
 */
export function useVoice(mesh: UseMeshResult): UseVoiceResult {
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
      mesh.publishAudio(track);
      setMicEnabled(true);
      setHasPermission(true);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Microphone access failed';
      setError(message);
      setMicEnabled(false);
    }
  }, [mesh]);

  const stopMic = useCallback(() => {
    mesh.unpublishAudio();
    trackRef.current = null;
    setLocalTrack(null);
    setMicEnabled(false);
  }, [mesh]);

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
    attachRemoteAudio,
    detachRemoteAudio,
    localTrack,
    remoteTracks,
    registerRemote,
    unregisterRemote,
  };
}
