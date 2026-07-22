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
import type { AudioProcess, ElectronSource, StartProcessAudioOptions } from '../electron';

export interface ActiveStream {
  preset: QualityPreset;
  /** Effective resolution reported by the track after capture. */
  width: number;
  height: number;
  frameRate: number;
  /** Whether the captured source provides audio. */
  hasAudio: boolean;
}

/**
 * Heuristic: resolve the chosen video window source to a PID by matching its
 * `name` against the running-process list from `audio:listProcesses`.
 *
 * Why we need this: Electron's `desktopCapturer.getSources()` does NOT expose
 * the PID behind a window source (only `id`, `name`, `display_id`). The
 * `audio:listProcesses` IPC returns `{ pid, name, title }` from PowerShell
 * `Get-Process`, so we join on names. The matching is intentionally fuzzy:
 *
 *   - source.name for a window is usually the window title (e.g.
 *     "YouTube — Google Chrome", "Minecraft 1.20", "Discord").
 *   - We try several strategies in order and return the first hit:
 *       1. exact equality between source.name and process.title
 *       2. process.title contains source.name (or vice versa)
 *       3. source.name contains process.name (e.g. "Google Chrome" → "chrome")
 *       4. process.name contains a leading token of source.name
 *
 * Returns `null` when nothing matches — caller falls back to `{ system: true }`.
 * Pure function (no React state) so it's easy to unit-test in isolation.
 *
 * @param processes Result of `window.electronAPI.listAudioProcesses()`.
 * @param sourceName The `ElectronSource.name` of the chosen window source.
 */
export function findProcessBySourceName(
  processes: AudioProcess[],
  sourceName: string,
): AudioProcess | null {
  if (!processes || processes.length === 0) return null;
  const name = (sourceName ?? '').trim();
  if (!name) return null;
  const nameLower = name.toLowerCase();

  // (1) Exact title match — most precise.
  let hit = processes.find((p) => p.title && p.title === name);
  if (hit) return hit;

  // (2) Title contains source.name or vice versa.
  hit = processes.find(
    (p) =>
      (p.title && (p.title.includes(name) || name.includes(p.title))) ||
      false,
  );
  if (hit) return hit;

  // (3) source.name contains process.name (e.g. "...Google Chrome" → "chrome").
  hit = processes.find((p) => p.name && p.name.length > 1 && nameLower.includes(p.name.toLowerCase()));
  if (hit) return hit;

  // (4) Leading token of source.name matches process.name. Handles window
  //     titles like "Minecraft 1.20" where "Minecraft" itself isn't a process
  //     name but might appear as one (rare; safety net).
  const firstToken = nameLower.split(/[\s—\-_·]+/).find((t) => t.length > 1);
  if (firstToken) {
    hit = processes.find(
      (p) => p.name && p.name.toLowerCase() === firstToken,
    );
    if (hit) return hit;
  }

  return null;
}

/**
 * Decide the WASAPI loopback selection (`StartProcessAudioOptions`) for the
 * chosen video source. Pure async helper — does NOT touch React state or
 * `processAudio.start`; the caller wires the result into the hook.
 *
 *   - screen source (source.id starts with "screen:") → EXCLUDE our own PID.
 *     Captures the whole desktop minus our renderer's audio → no echo.
 *   - window source → resolve PID via `listAudioProcesses` + heuristic; if
 *     found, INCLUDE that PID's tree; otherwise fall back to system audio.
 *
 * @param source The video source the host picked in `<SourcePicker>`.
 * @returns The `StartProcessAudioOptions` to pass to `processAudio.start`.
 */
async function resolveAudioSelection(source: ElectronSource): Promise<StartProcessAudioOptions> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;

  // Entire screen → exclude ourselves.
  if (source.id.startsWith('screen:')) {
    if (api?.getElectronPid) {
      try {
        const pid = await api.getElectronPid();
        if (typeof pid === 'number' && pid > 0) {
          return { excludePid: pid };
        }
      } catch (err) {
        console.warn('[screen-share] getElectronPid failed, falling back to system audio', err);
      }
    }
    // Couldn't get our own PID (rare; preload bridge missing?) — degrade to
    // classic whole-endpoint loopback. The host may hear echo, but at least
    // they get audio.
    return { system: true };
  }

  // Window → try to resolve the PID.
  if (api?.listAudioProcesses) {
    try {
      const processes = await api.listAudioProcesses();
      const match = findProcessBySourceName(processes, source.name);
      if (match && typeof match.pid === 'number') {
        return { pid: match.pid };
      }
    } catch (err) {
      console.warn('[screen-share] listAudioProcesses failed, falling back to system audio', err);
    }
  }

  // Fallback: whole default render endpoint (classic WASAPI loopback).
  return { system: true };
}

/**
 * Human-readable label for the auto-picked audio source. Used in the UI so the
 * host can see what audio is being captured without a separate modal.
 *
 * @param source The video source the host picked.
 * @param opts   The selection that `resolveAudioSelection` produced.
 */
function describeAudioSelection(
  source: ElectronSource,
  opts: StartProcessAudioOptions,
): string {
  if (opts.excludePid !== undefined) {
    return 'Весь экран, кроме этого приложения';
  }
  if (opts.pid !== undefined) {
    // Use the source name verbatim — it's the window title (e.g. "Discord",
    // "YouTube — Google Chrome"). Truncate so the chip stays compact.
    const name = (source.name ?? '').trim();
    return name.length > 32 ? `${name.slice(0, 31)}…` : name || 'Выбранное приложение';
  }
  return 'Системный звук';
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
   * (Electron-only, auto-selected based on the video source). When true the
   * `hasAudio` flag on `stream` reflects that audio, and the existing
   * system-loopback AEC path should NOT activate.
   */
  audioViaFfmpeg: boolean;

  // ---- Phase 2: Electron source picker ----------------------------------
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

  /**
   * Human-readable label of the automatically-selected audio source (e.g.
   * "Chrome", "Весь экран, кроме этого приложения" or "Системный звук"), or
   * `null` when no audio source is active (e.g. video-only because audio
   * capture failed).
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
  // auto-picker, which touches audioTrackRef) can reference them safely.
  const streamRef = useRef<MediaStream | null>(null);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const audioTrackRef = useRef<MediaStreamTrack | null>(null);
  const presetRef = useRef<QualityPreset | null>(null);
  const localPreviewRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteStreamRef = useRef<MediaStream>(new MediaStream());
  /** Holds the latest stopStream so the 'ended' handler can call it safely. */
  const stopRef = useRef<() => void>(() => {});

  /**
   * Human-readable label for the currently-active audio source (UI feedback).
   * Set by the auto-pick path after the video source is chosen.
   */
  const [selectedAudioLabel, setSelectedAudioLabel] = useState<string | null>(null);

  /**
   * Auto-pick the audio source based on the chosen video source and start
   * WASAPI loopback capture. Called from `startStream` right after the video
   * track has been published. The pipeline is fire-and-forget: errors surface
   * through `error`/`processAudio.error` rather than rejecting a promise the
   * caller isn't awaiting. The video stream is NOT reverted if audio fails —
   * the host gets a video-only stream with an error banner instead.
   *
   * Selection rules (see CONTEXT.md):
   *   - source.id starts with "screen:" → entire screen → EXCLUDE our own PID
   *     (whole-desktop audio minus our renderer's output → no echo).
   *   - source.id is a window → resolve the window's PID via listAudioProcesses
   *     + `findProcessBySourceName` heuristic, then INCLUDE that PID's tree.
   *   - if the window PID can't be resolved → fall back to `{ system: true }`.
   *
   * @param source The video source the host just picked in `<SourcePicker>`.
   */
  const autoStartAudioForSource = useCallback(
    (source: ElectronSource) => {
      // Browser build / Electron with no API → no-op. The browser path still
      // goes through `getDisplayMedia` with `audio: true` and is handled by the
      // caller separately.
      if (!isElectron || !window.electronAPI) return;
      void (async () => {
        try {
          await processAudio.stop();
          if (audioViaFfmpeg) {
            mesh.unpublishAudio();
            if (audioTrackRef.current) {
              audioTrackRef.current.stop();
              audioTrackRef.current = null;
            }
            setAudioViaFfmpeg(false);
          }

          const opts = await resolveAudioSelection(source);
          const label = describeAudioSelection(source, opts);
          const track = await processAudio.start(opts);
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
          setSelectedAudioLabel(label);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[screen-share] autoStartAudioForSource failed:', msg);
          setError(`Звук: ${msg}`);
          setSelectedAudioLabel(null);
        }
      })();
    },
    [isElectron, processAudio, audioViaFfmpeg, mesh],
  );

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
    // a resolver that will never fire.
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
          // Audio is intentionally `false` here: on Electron it would hit the
          // same system-loopback echo loop we're avoiding. Application audio
          // is captured separately (echo-free) via the loopback-capture WASAPI
          // bridge — auto-selected from the just-picked video source below.
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

          // Auto-pick audio based on the chosen video source — no separate
          // modal. Window → INCLUDE that process's tree (echo-free per-app).
          // Screen → EXCLUDE our own PID (whole-desktop minus ourselves).
          autoStartAudioForSource(source);
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
    [isElectron, mesh, room, configureVideoSenders, requestSourceFromPicker, publishCapturedMedia, autoStartAudioForSource],
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
    selectedAudioLabel,
    // Phase 2
    sourcePickerOpen,
    confirmSource,
    cancelSource,
  };
}
