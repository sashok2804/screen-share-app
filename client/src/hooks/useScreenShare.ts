import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseMeshResult } from './useMesh';
import type { UseRoomResult } from './useRoom';
import { useProcessAudio } from './useProcessAudio';
import {
  getPreset,
  toDisplayMediaVideoConstraints,
  type QualityPreset,
  type QualityPresetId,
} from '../lib/quality';
import { applyBitrate, applyCodecPreferences } from '../lib/rtc';
import type { ElectronSource } from '../electron';

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

  // ---- Phase 3: FFmpeg audio --------------------------------------------
  /** True when we are running inside Electron (so the UI can show hints). */
  isElectron: boolean;
  /**
   * True when system audio is being captured via the FFmpeg/WASAPI bridge
   * (Electron-only). When true the `hasAudio` flag on `stream` reflects that
   * audio, and the existing system-loopback AEC path should NOT activate.
   */
  audioViaFfmpeg: boolean;

  // ---- Phase 2: Electron source picker ---------------------------------
  /**
   * `true` while waiting for the user to pick a source in the custom
   * SourcePicker modal (Electron only). The host component should render
   * `<SourcePicker>` when this is true.
   */
  sourcePickerOpen: boolean;
  /**
   * Resolve the pending picker with the user's choice. Called by
   * `<SourcePicker onPick>`.
   */
  confirmSource: (source: ElectronSource) => void;
  /**
   * Resolve the pending picker with a cancellation. Called by
   * `<SourcePicker onCancel>`.
   */
  cancelSource: () => void;

  // ---- Phase 3: Electron audio device picker ----------------------------
  /**
   * DirectShow audio device names available on this machine (Electron only).
   * Empty in the browser build or before the initial `listAudioDevices()` call
   * resolves.
   */
  audioDevices: string[];
  /**
   * The device the user picked in the dropdown, or `null` for "auto" (let the
   * hook pick a sensible default — see `pickDefaultAudioDevice`).
   */
  selectedAudioDevice: string | null;
  /** Set or clear the user's audio device choice. `null` means "auto". */
  setAudioDevice: (name: string | null) => void;
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

  // Phase 3 — Electron-only FFmpeg audio bridge. The browser build will
  // resolve `start()` to null and `stop()` to a no-op thanks to the
  // `isElectron` gate inside the hook.
  const processAudio = useProcessAudio();
  /** True iff we are publishing system audio captured via FFmpeg (Electron). */
  const [audioViaFfmpeg, setAudioViaFfmpeg] = useState(false);

  // `true` when running inside the Electron desktop client. Computed once at
  // the top so every Electron-gated branch (including the device-loading
  // effect below) can read it without reordering declarations.
  const isElectron =
    typeof window !== 'undefined' && window.electronAPI?.isElectron === true;

  // Phase 3 — list of DirectShow audio devices + the user's selection. The
  // dropdown lets the host override our heuristic default picker. `null`
  // means "auto" (the hook / useProcessAudio picks a loopback device).
  const [audioDevices, setAudioDevices] = useState<string[]>([]);
  const [selectedAudioDevice, setSelectedAudioDevice] = useState<string | null>(null);
  useEffect(() => {
    if (!isElectron || !window.electronAPI?.listAudioDevices) return;
    let cancelled = false;
    window.electronAPI
      .listAudioDevices()
      .then((res) => {
        if (cancelled) return;
        setAudioDevices(res?.audio ?? []);
      })
      .catch((err) => {
        console.error('[screen-share] listAudioDevices failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [isElectron]);

  const streamRef = useRef<MediaStream | null>(null);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const audioTrackRef = useRef<MediaStreamTrack | null>(null);
  const presetRef = useRef<QualityPreset | null>(null);

  const localPreviewRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteStreamRef = useRef<MediaStream>(new MediaStream());
  /** Holds the latest stopStream so the 'ended' handler can call it safely. */
  const stopRef = useRef<() => void>(() => {});

  // ---- Phase 2: Electron source picker -----------------------------------
  //
  // Design: `startStream` cannot render UI (it's a hook), so we lift the
  // SourcePicker into Room.tsx. The picker's lifecycle is driven by a deferred
  // promise stored in a ref: `startStream` opens the modal (sets the state),
  // then awaits the promise. `<SourcePicker onPick>` calls `confirmSource`,
  // which resolves the promise with the chosen source; `onCancel` (and
  // `stopStream` as a safety net) call `cancelSource`, which rejects. This
  // keeps the async flow inside `startStream` without leaking modal state into
  // the call site.
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  /** Pending picker resolver: set when the modal opens, cleared on resolve. */
  const pendingSourceRef = useRef<{
    resolve: (s: ElectronSource) => void;
    reject: (err: Error) => void;
  } | null>(null);

  /** Open the picker and resolve with the user's chosen source, or reject on cancel. */
  const requestSourceFromPicker = useCallback((): Promise<ElectronSource> => {
    return new Promise<ElectronSource>((resolve, reject) => {
      pendingSourceRef.current = { resolve, reject };
      setSourcePickerOpen(true);
    });
  }, []);

  const confirmSource = useCallback((source: ElectronSource) => {
    const pending = pendingSourceRef.current;
    if (!pending) return;
    pendingSourceRef.current = null;
    setSourcePickerOpen(false);
    pending.resolve(source);
  }, []);

  const cancelSource = useCallback(() => {
    const pending = pendingSourceRef.current;
    if (!pending) return;
    pendingSourceRef.current = null;
    setSourcePickerOpen(false);
    pending.reject(new Error('Выбор источника отменён'));
  }, []);

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
        // CRITICAL: pass RTCRtpReceiver.getCapabilities, NOT sender. The codec
        // list handed to setCodecPreferences must be a subset of the RECEIVER
        // capabilities; using sender caps (especially H264) triggers Chrome's
        // InvalidModificationError regression (screego/server#215).
        applyCodecPreferences(
          transceiver as unknown as Parameters<typeof applyCodecPreferences>[0],
          'video',
          (kind) =>
            typeof RTCRtpReceiver !== 'undefined'
              ? (RTCRtpReceiver.getCapabilities(kind) as { codecs?: Array<{ mimeType: string }> } | null)
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
    // Safety net: if the user clicks stop while the picker is open, cancel
    // the pending promise so startStream() doesn't hang waiting on a resolver.
    if (pendingSourceRef.current) {
      cancelSource();
    }
    if (videoTrackRef.current) {
      videoTrackRef.current.stop();
      mesh.unpublishVideo();
      videoTrackRef.current = null;
    }
    if (audioTrackRef.current) {
      audioTrackRef.current.stop();
      // When audio came from the FFmpeg bridge we also have to ask the
      // main process to tear down the subprocess + AudioContext.
      if (audioViaFfmpeg) {
        mesh.unpublishAudio();
      }
      audioTrackRef.current = null;
    }
    if (audioViaFfmpeg) {
      void processAudio.stop();
      setAudioViaFfmpeg(false);
    }
    streamRef.current = null;
    presetRef.current = null;
    if (localPreviewRef.current) localPreviewRef.current.srcObject = null;
    setIsStreaming(false);
    setStream(null);
    room.notifyStreamStop();
  }, [mesh, room, cancelSource, processAudio, audioViaFfmpeg]);

  /**
   * Shared post-capture pipeline for both Electron and browser paths:
   * publish the video track, configure codec/bitrate, attach preview,
   * wire the 'ended' handler, and surface the ActiveStream + room notify.
   */
  const publishCapturedMedia = useCallback(
    (media: MediaStream, preset: QualityPreset, presetId: QualityPresetId) => {
      const videoTrack = media.getVideoTracks()[0];
      if (!videoTrack) throw new Error('No video track captured');

      // Publish first (creates the transceiver/sender), then configure it.
      mesh.publishVideo(videoTrack);
      videoTrackRef.current = videoTrack;
      presetRef.current = preset;
      configureVideoSenders(videoTrack, preset);

      // Audio (optional — Window sources won't have it; Electron path captures
      // audio separately via the Phase 3 FFmpeg/WASAPI bridge).
      const audioTrack = media.getAudioTracks()[0];
      if (audioTrack) {
        audioTrackRef.current = audioTrack;
        mesh.publishAudio(audioTrack);
      }

      streamRef.current = media;
      if (localPreviewRef.current) localPreviewRef.current.srcObject = media;

      // Listen for the user pressing "Stop sharing" (browser bar) or the
      // Electron share-helpers stopping the desktop track.
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
    },
    [mesh, room, configureVideoSenders],
  );

  const startStream = useCallback(
    async (presetId: QualityPresetId) => {
      try {
        if (!room.isHost) {
          throw new Error('Only the host can start a screen stream');
        }
        const preset = getPreset(presetId);

        // ----- Electron: custom source picker → chromeMediaSource: 'desktop' -----
        if (isElectron) {
          let source: ElectronSource;
          try {
            source = await requestSourceFromPicker();
          } catch {
            // User dismissed the picker — treat as a silent cancel, not an error.
            return;
          }
          // Electron's desktop-capture constraint shape is non-standard; the
          // `mandatory` wrapper is required by Chromium's desktop capturer.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const media = (await navigator.mediaDevices.getUserMedia({
            audio: false, // Phase 3 will add process audio via the FFmpeg bridge.
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: source.id,
                maxWidth: preset.width,
                maxHeight: preset.height,
                maxFrameRate: preset.frameRate,
                minFrameRate: preset.frameRate,
              },
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any)) as MediaStream;

          publishCapturedMedia(media, preset, presetId);

          // Phase 3 — Electron: kick off FFmpeg-based system-audio capture.
          // Failure is non-fatal: video still flows, peers just won't hear
          // audio. Surface the error via the existing `error` channel.
          void (async () => {
            try {
              // `selectedAudioDevice` is null → "auto" → useProcessAudio picks
              // a sensible loopback default (Voicemeeter / CABLE / Stereo Mix).
              const track = await processAudio.start(
                selectedAudioDevice ?? undefined,
              );
              if (track) {
                audioTrackRef.current = track;
                mesh.publishAudio(track);
                setAudioViaFfmpeg(true);
                setStream((s) => (s ? { ...s, hasAudio: true } : s));
              } else if (processAudio.error) {
                setError(`FFmpeg audio: ${processAudio.error}`);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error('[screen-share] processAudio.start failed:', msg);
              setError(`FFmpeg audio: ${msg}`);
            }
          })();

          return;
        }

        // ----- Browser: native getDisplayMedia (unchanged from Phase 1) ---------
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

        publishCapturedMedia(media, preset, presetId);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          setError('Доступ к экрану отменён');
        } else {
          setError(err instanceof Error ? err.message : 'getDisplayMedia failed');
        }
      }
    },
    [isElectron, mesh, room, configureVideoSenders, requestSourceFromPicker, publishCapturedMedia, processAudio, selectedAudioDevice],
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
    // Phase 3
    isElectron,
    audioViaFfmpeg,
    audioDevices,
    selectedAudioDevice,
    setAudioDevice: setSelectedAudioDevice,
    // Phase 2
    sourcePickerOpen,
    confirmSource,
    cancelSource,
  };
}
