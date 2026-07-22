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
import type { AudioSourceSelection, ElectronSource } from '../electron';

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

  // ---- Phase 3 (rewritten): loopback audio ------------------------------
  /** True when we are running inside Electron (so the UI can show hints). */
  isElectron: boolean;
  /**
   * True when audio is being captured via the loopback-capture WASAPI bridge
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

  // ---- Phase 3: Electron audio source picker ----------------------------
  /**
   * `true` while the audio-source picker (`<ProcessAudioPicker>`) is open.
   * The host component should render it conditionally and wire
   * `confirmAudioSource` / `cancelAudioSource`.
   */
  audioPickerOpen: boolean;
  /** Open the ProcessAudioPicker modal. */
  openAudioPicker: () => void;
  /** Resolve the picker with the user's choice and start capture. */
  confirmAudioSource: (selection: AudioSourceSelection) => void;
  /** Resolve the picker with a cancellation (no audio change). */
  cancelAudioSource: () => void;
  /** Stop capturing application audio (revert to video-only). */
  stopProcessAudio: () => void;
  /**
   * Human-readable label of the active audio source (e.g. "Spotify" or
   * "Системный звук"), or `null` when no audio source is selected.
   */
  selectedAudioLabel: string | null;
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

  // Phase 3 (rewritten) — Electron-only loopback audio bridge. The browser
  // build resolves `start()` to null and `stop()` to a no-op thanks to the
  // `isElectron` gate inside the hook.
  const processAudio = useProcessAudio();
  /** True iff we are publishing audio captured via the WASAPI bridge (Electron). */
  const [audioViaFfmpeg, setAudioViaFfmpeg] = useState(false);

  // `true` when running inside the Electron desktop client. Computed once at
  // the top so every Electron-gated branch can read it without reordering.
  const isElectron =
    typeof window !== 'undefined' && window.electronAPI?.isElectron === true;

  // Refs are declared up-front so every callback below (including the audio
  // picker helpers, which touch audioTrackRef) can reference them safely.
  const streamRef = useRef<MediaStream | null>(null);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const audioTrackRef = useRef<MediaStreamTrack | null>(null);
  const presetRef = useRef<QualityPreset | null>(null);
  const localPreviewRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteStreamRef = useRef<MediaStream>(new MediaStream());
  /** Holds the latest stopStream so the 'ended' handler can call it safely. */
  const stopRef = useRef<() => void>(() => {});

  // Phase 3 (rewritten) — audio source selection. Unlike the old device-
  // dropdown model, the host now picks an audio source via the
  // `<ProcessAudioPicker>` modal AFTER starting video, on demand. `null` means
  // "no audio source selected" (video-only stream).
  const [audioPickerOpen, setAudioPickerOpen] = useState(false);
  /** Human-readable label for the currently-active source (UI feedback). */
  const [selectedAudioLabel, setSelectedAudioLabel] = useState<string | null>(null);

  /**
   * Resolve the picker with the user's choice AND start the loopback capture
   * immediately. The async pipeline (stop any prior capture → start new →
   * publish audio track → flag hasAudio) is fire-and-forget: errors surface
   * through `error`/`processAudio.error` rather than rejecting a promise the
   * UI isn't awaiting.
   */
  const confirmAudioSource = useCallback((selection: AudioSourceSelection) => {
    setAudioPickerOpen(false);
    void (async () => {
      try {
        // Tear down any prior loopback capture so the new selection replaces it.
        await processAudio.stop();
        if (audioViaFfmpeg) {
          mesh.unpublishAudio();
          if (audioTrackRef.current) {
            audioTrackRef.current.stop();
            audioTrackRef.current = null;
          }
          setAudioViaFfmpeg(false);
        }

        const track = await processAudio.start(selection);
        if (!track) {
          const msg = processAudio.error ?? 'Не удалось запустить захват звука';
          setError(`Звук: ${msg}`);
          setSelectedAudioLabel(null);
          return;
        }
        audioTrackRef.current = track;
        mesh.publishAudio(track);
        setAudioViaFfmpeg(true);
        setStream((s) => (s ? { ...s, hasAudio: true } : s));
        setSelectedAudioLabel(
          'pid' in selection ? selection.name : 'Системный звук',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[screen-share] processAudio.start failed:', msg);
        setError(`Звук: ${msg}`);
        setSelectedAudioLabel(null);
      }
    })();
  }, [processAudio, audioViaFfmpeg, mesh]);

  const cancelAudioSource = useCallback(() => {
    setAudioPickerOpen(false);
  }, []);

  const openAudioPicker = useCallback(() => {
    setAudioPickerOpen(true);
  }, []);

  /** Stop the loopback capture (revert to video-only). */
  const stopProcessAudio = useCallback(() => {
    void (async () => {
      try {
        await processAudio.stop();
      } catch (err) {
        console.error('[screen-share] stopProcessAudio failed', err);
      }
      if (audioViaFfmpeg) {
        mesh.unpublishAudio();
        audioTrackRef.current = null;
        setAudioViaFfmpeg(false);
        setStream((s) => (s ? { ...s, hasAudio: false } : s));
      }
      setSelectedAudioLabel(null);
    })();
  }, [processAudio, audioViaFfmpeg, mesh]);

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
    // Safety net: if the user clicks stop while the source picker is open,
    // cancel the pending promise so an awaiting startStream() doesn't hang on
    // a resolver that will never fire. Also dismiss the audio picker.
    if (pendingSourceRef.current) {
      cancelSource();
    }
    if (audioPickerOpen) {
      setAudioPickerOpen(false);
    }
    if (videoTrackRef.current) {
      videoTrackRef.current.stop();
      mesh.unpublishVideo();
      videoTrackRef.current = null;
    }
    if (audioTrackRef.current) {
      audioTrackRef.current.stop();
      // When audio came from the loopback bridge we also have to ask the
      // main process to tear down the WASAPI session + AudioContext.
      if (audioViaFfmpeg) {
        mesh.unpublishAudio();
      }
      audioTrackRef.current = null;
    }
    if (audioViaFfmpeg) {
      void processAudio.stop();
      setAudioViaFfmpeg(false);
    }
    setSelectedAudioLabel(null);
    streamRef.current = null;
    presetRef.current = null;
    if (localPreviewRef.current) localPreviewRef.current.srcObject = null;
    setIsStreaming(false);
    setStream(null);
    room.notifyStreamStop();
  }, [mesh, room, cancelSource, processAudio, audioViaFfmpeg, audioPickerOpen]);

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
          // Audio is intentionally `false` here: on Electron it would hit the
          // same system-loopback echo loop we're avoiding. Application audio
          // is captured separately (echo-free) via the loopback-capture WASAPI
          // bridge, which the host selects on demand from StreamControls →
          // ProcessAudioPicker (see confirmAudioSource).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const media = (await navigator.mediaDevices.getUserMedia({
            audio: false,
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
    [isElectron, mesh, room, configureVideoSenders, requestSourceFromPicker, publishCapturedMedia],
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
    // Phase 3 (rewritten)
    isElectron,
    audioViaFfmpeg,
    audioPickerOpen,
    openAudioPicker,
    confirmAudioSource,
    cancelAudioSource,
    stopProcessAudio,
    selectedAudioLabel,
    // Phase 2
    sourcePickerOpen,
    confirmSource,
    cancelSource,
  };
}
