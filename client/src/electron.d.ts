/**
 * Ambient types for the `window.electronAPI` surface exposed by the Electron
 * preload script (see `electron/preload.cjs`).
 *
 * Phase 1 (protocol + version), Phase 2 (source picker) and Phase 3 (per-
 * process WASAPI loopback audio via the `loopback-capture` npm package) are
 * implemented.
 */

export {};

/** A capturable desktop source as returned by `electronAPI.getSources()`. */
export interface ElectronSource {
  id: string;
  /** Display name (window title or "Entire Screen"/"Screen 1" etc.). */
  name: string;
  /** Electron `display_id` — useful for multi-monitor targeting. */
  display_id?: string;
  /** `data:image/png;base64,...` thumbnail (320×180 by default). */
  thumbnailDataURL: string;
  /** `data:image/png;base64,...` app icon for window sources, or null. */
  appIconDataURL?: string | null;
}

/** Result of `startProcessAudio` on success. */
export interface ProcessAudioStartOk {
  ok: true;
  /** Output sample rate delivered to the renderer (always 48000). */
  sampleRate: number;
  /** Output channel count delivered to the renderer (always 1, mono). */
  channels: number;
}
/** Result of `startProcessAudio` on failure. */
export interface ProcessAudioStartErr {
  ok: false;
  error: string;
}
export type ProcessAudioStartResult = ProcessAudioStartOk | ProcessAudioStartErr;

/**
 * Options accepted by `startProcessAudio`. Exactly one of `pid` / `system`
 * must be provided:
 *   - `{ pid }`     — per-process WASAPI loopback (Discord-style, echo-free).
 *   - `{ system }`  — whole default render endpoint (entire desktop audio).
 */
export interface StartProcessAudioOptions {
  /**
   * Target process id. Captures the process and (on the main-process side) its
   * child tree via `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`.
   */
  pid?: number;
  /**
   * When `true`, capture the entire default playback device (everything
   * playing through speakers/headphones) using classic WASAPI loopback.
   */
  system?: boolean;
}

/** A running process with a visible window — used by the audio source picker. */
export interface AudioProcess {
  /** OS process id. */
  pid: number;
  /** Process executable name without extension (e.g. "firefox", "Spotify"). */
  name: string;
  /** Main window title (e.g. "Discord", "Menu — Spotify"). */
  title: string;
}

/** Selection made in the `ProcessAudioPicker`: either a process or system. */
export type AudioSourceSelection = { pid: number; name: string } | { system: true };

declare global {
  interface Window {
    electronAPI?: {
      /** Marker — `true` when the React client is running inside Electron. */
      isElectron: true;

      /** Returns the desktop client's version (e.g. "0.1.0"). */
      getAppVersion: () => string;

      /**
       * Subscribe to room-open requests triggered by `screen-share://room/<id>`
       * launches. Returns an unsubscribe function.
       */
      onOpenRoom: (callback: (roomId: string) => void) => () => void;

      // ---- Phase 2: desktopCapturer source picker -------------------------
      /** Lists capturable windows + screens with thumbnails. */
      getSources?: () => Promise<ElectronSource[]>;

      /** Returns `{ name }` for a previously-listed source, or null. */
      getSourceMetadata?: (sourceId: string) => Promise<{ name: string } | null>;

      // ---- Phase 3 (rewritten): loopback-capture WASAPI bridge ------------
      /**
       * List running processes with a visible window (for the audio picker).
       * Returns `[]` on non-Windows or on PowerShell failure.
       */
      listAudioProcesses?: () => Promise<AudioProcess[]>;

      /**
       * Start WASAPI loopback capture. Pass `{ pid }` for per-process capture
       * (echo-free) or `{ system: true }` for the whole default render endpoint.
       */
      startProcessAudio?: (
        opts?: StartProcessAudioOptions,
      ) => Promise<ProcessAudioStartResult>;

      /** Stop the active capture. */
      stopProcessAudio?: () => Promise<{ ok: boolean }>;

      /** Subscribe to mono Float32 chunks (48 kHz). Returns an unsubscribe. */
      onAudioChunk?: (callback: (chunk: Float32Array) => void) => () => void;

      /** Subscribe to mid-capture hard errors. Returns an unsubscribe. */
      onAudioError?: (callback: (err: { message: string }) => void) => () => void;
    };
  }
}
