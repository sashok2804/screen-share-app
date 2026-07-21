import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseMeshResult } from './useMesh';
import type { UseRoomResult } from './useRoom';
import {
  getPreset,
  toDisplayMediaVideoConstraints,
  type QualityPreset,
  type QualityPresetId,
} from '../lib/quality';
import { applyBitrate, applyCodecPreferences } from '../lib/rtc';

export interface ActiveStream {
  preset: QualityPreset;
  /** Effective resolution reported by the track after capture. */
  width: number;
  height: number;
  frameRate: number;
  /** Whether the captured source provides audio. */
  hasAudio: boolean;
}

export interface UseScreenShareResult {
  isStreaming: boolean;
  stream: ActiveStream | null;
  /** Live local preview track for the host UI. */
  localPreviewRef: React.RefObject<HTMLVideoElement | null>;
  /** Incoming remote video track (for viewers). */
  remoteVideoRef: React.RefObject<HTMLVideoElement | null>;
  error: string | null;
  startStream: (presetId: QualityPresetId) => Promise<void>;
  stopStream: () => void;
  changeQuality: (presetId: QualityPresetId) => Promise<void>;
  /** Attach a remote video track to the preview element. */
  attachRemoteVideo: (track: MediaStreamTrack) => void;
  detachRemoteVideo: (track: MediaStreamTrack) => void;
  /** AEC toggle for the system-audio capture. */
  aecEnabled: boolean;
  setAecEnabled: (next: boolean) => void;
}

/**
 * Screen capture + publish (host) / receive (viewer).
 *
 * Host calls `startStream('ultra')` → getDisplayMedia → codec/bitrate config
 * → mesh.publishVideo → server `stream-start` notification.
 * Viewer calls subscribe via useRoom; the mesh's recvonly transceiver picks
 * up the host track, which is routed here through `attachRemoteVideo`.
 */
export function useScreenShare(
  mesh: UseMeshResult,
  room: UseRoomResult,
  /**
   * Reference stream used by the AEC graph to cancel the remote peer voices
   * out of the captured system audio. Pass the same stream that the local
   * <audio> playback element uses (i.e. what is leaking via the speakers).
   */
  getRemoteAudioStream: () => MediaStream | null,
): UseScreenShareResult {
  const [isStreaming, setIsStreaming] = useState(false);
  const [stream, setStream] = useState<ActiveStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reserved for the Electron desktop client, where a real process-loopback
  // capture will replace the system-audio path. Unused in the web build.
  void getRemoteAudioStream;

  const streamRef = useRef<MediaStream | null>(null);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const audioTrackRef = useRef<MediaStreamTrack | null>(null);
  const presetRef = useRef<QualityPreset | null>(null);

  const localPreviewRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteStreamRef = useRef<MediaStream>(new MediaStream());
  /** Holds the latest stopStream so the 'ended' handler can call it safely. */
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (localPreviewRef.current) {
      localPreviewRef.current.srcObject = streamRef.current;
    }
  }, [isStreaming]);

  // Keep the ref pointing at the latest stopStream (so the track's 'ended'
  // handler always calls the current closure, not a stale one).
  // (Populated below, after stopStream is defined.)

  /** Applies codec preferences + bitrate to every video sender carrying `track`. */
  const configureVideoSenders = useCallback(
    (track: MediaStreamTrack, preset: QualityPreset) => {
      // Codec preferences first (requires the transceiver, not the sender).
      mesh.forEachVideoTransceiver((transceiver) => {
        applyCodecPreferences(
          transceiver as unknown as Parameters<typeof applyCodecPreferences>[0],
          'video',
          (kind) =>
            typeof RTCRtpSender !== 'undefined'
              ? (RTCRtpSender.getCapabilities(kind) as { codecs?: Array<{ mimeType: string }> } | null)
              : null,
        );
      });
      // Bitrate via setParameters on each sender.
      mesh.forEachSender(track, async (sender) => {
        try {
          await applyBitrate(sender, preset);
        } catch (err) {
          console.error('[screen-share] applyBitrate failed', err);
        }
      });
    },
    [mesh],
  );

  const stopStream = useCallback(() => {
    if (videoTrackRef.current) {
      videoTrackRef.current.stop();
      mesh.unpublishVideo();
      videoTrackRef.current = null;
    }
    if (audioTrackRef.current) {
      audioTrackRef.current.stop();
      audioTrackRef.current = null;
    }
    streamRef.current = null;
    presetRef.current = null;
    if (localPreviewRef.current) localPreviewRef.current.srcObject = null;
    setIsStreaming(false);
    setStream(null);
    room.notifyStreamStop();
  }, [mesh, room]);

  const startStream = useCallback(
    async (presetId: QualityPresetId) => {
      try {
        if (!room.isHost) {
          throw new Error('Only the host can start a screen stream');
        }
        const preset = getPreset(presetId);

        const media = await navigator.mediaDevices.getDisplayMedia({
          video: toDisplayMediaVideoConstraints(preset),
          audio: {
            // Disable browser-side audio processing for system/tab sound —
            // it's content audio, not voice.
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
          },
        });

        const videoTrack = media.getVideoTracks()[0];
        if (!videoTrack) throw new Error('No video track captured');

        // Publish first (creates the transceiver/sender), then configure it.
        mesh.publishVideo(videoTrack);
        videoTrackRef.current = videoTrack;
        presetRef.current = preset;
        configureVideoSenders(videoTrack, preset);

        // Audio (optional — Window sources won't have it).
        // NOTE: AEC is disabled by default. Browser-side AEC cannot reliably
        // remove the remote peer's voice from a system-audio loopback, and
        // enabling it caused demo audio to be dropped entirely. The proper
        // fix is process-loopback capture (WASAPI), available in the Electron
        // desktop client — see electron/ directory.
        const audioTrack = media.getAudioTracks()[0];
        if (audioTrack) {
          audioTrackRef.current = audioTrack;
          mesh.publishAudio(audioTrack);
        }

        streamRef.current = media;
        if (localPreviewRef.current) localPreviewRef.current.srcObject = media;

        // Listen for the user pressing "Stop sharing" in the Chrome bar.
        videoTrack.addEventListener('ended', () => stopRef.current());

        const settings = videoTrack.getSettings();
        setStream({
          preset,
          width: settings.width ?? preset.width,
          height: settings.height ?? preset.height,
          frameRate: settings.frameRate ?? preset.frameRate,
          hasAudio: !!audioTrack,
        });
        setIsStreaming(true);
        setError(null);
        room.notifyStreamStart(presetId);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          setError('Доступ к экрану отменён');
        } else {
          setError(err instanceof Error ? err.message : 'getDisplayMedia failed');
        }
      }
    },
    [mesh, room, configureVideoSenders],
  );

  // Keep the ref pointing at the latest stopStream (so the track's 'ended'
  // handler always calls the current closure, not a stale one).
  useEffect(() => {
    stopRef.current = stopStream;
  }, [stopStream]);

  const changeQuality = useCallback(
    async (presetId: QualityPresetId) => {
      if (!videoTrackRef.current || !presetRef.current) return;
      const preset = getPreset(presetId);
      presetRef.current = preset;
      configureVideoSenders(videoTrackRef.current, preset);
      room.notifyQualityChange(presetId);
      setStream((s) => (s ? { ...s, preset } : s));
    },
    [mesh, room, configureVideoSenders],
  );

  const attachRemoteVideo = useCallback((track: MediaStreamTrack) => {
    if (!remoteStreamRef.current.getTracks().includes(track)) {
      remoteStreamRef.current.addTrack(track);
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
      remoteVideoRef.current.play().catch(() => {});
    }
  }, []);

  const detachRemoteVideo = useCallback((track: MediaStreamTrack) => {
    remoteStreamRef.current.removeTrack(track);
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
    }
  }, []);

  useEffect(() => {
    return () => {
      videoTrackRef.current?.stop();
      audioTrackRef.current?.stop();
    };
  }, []);

  return {
    isStreaming,
    stream,
    localPreviewRef,
    remoteVideoRef,
    error,
    startStream,
    stopStream,
    changeQuality,
    attachRemoteVideo,
    detachRemoteVideo,
    aecEnabled: false,
    setAecEnabled: () => {},
  };
}
