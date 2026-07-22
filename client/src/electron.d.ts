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
 * Options accepted by `startProcessAudio`. Exactly one of `pid` / `excludePid`
 * / `system` must be provided:
 *   - `{ pid }`        — per-process WASAPI loopback (Discord-style, echo-free).
 *                        Captures the chosen process and (by default) its child
 *                        tree via `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`
 *                        with the INCLUDE-target-process-tree mode.
 *   - `{ excludePid }` — capture EVERYTHING EXCEPT the given process tree.
 *                        Used for "entire screen" picks: we pass our own Electron
 *                        PID so the capture includes all system audio minus the
 *                        remote peer's voice coming out of our own window → no
 *                        echo, without restricting to a single process.
 *   - `{ system }`     — whole default render endpoint (classic WASAPI
 *                        loopback, no process filtering). Fallback when the
 *                        host's chosen window's PID can't be resolved.
 */
export interface StartProcessAudioOptions {
  /**
   * Target process id. Captures the process and (on the main-process side) its
   * child tree (controlled by `includeTree`) via
   * `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` in INCLUDE mode.
   */
  pid?: number;
  /**
   * Process id to EXCLUDE. Captures every process EXCEPT the given one and its
   * children via process loopback in EXCLUDE-target-process-tree mode. Pass our
   * own Electron PID to grab the whole desktop without re-capturing the remote
   * peer's voice played by our renderer → echo-free "entire screen" audio.
   */
  excludePid?: number;
  /**
   * When `true` (default), include the target process's child tree. Only
   * meaningful together with `pid`. Kept in the type so callers can opt out of
   * the tree if a future use case ever needs to (current code always passes the
   * default).
   */
  includeTree?: boolean;
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
       * List running processes with a visible window. Used by the auto-audio
       * heuristic to resolve a chosen video source to a PID (source.name →
       * process). Returns `[]` on non-Windows or on PowerShell failure.
       */
      listAudioProcesses?: () => Promise<AudioProcess[]>;

      /**
       * Authoritatively resolve the owning PID of a desktopCapturer window
       * source by parsing the Win32 HWND out of `source.id`
       * (`"window:<HWND>:..."`) and calling
       * `user32!GetWindowThreadProcessId` via PowerShell P/Invoke. This is the
       * deterministic path tried FIRST — the `listAudioProcesses` name
       * heuristic is kept only as a fallback.
       *
       * @param sourceId desktopCapturer source.id (`"window:<HWND>:..."`).
       * @returns PID on success, `null` when the HWND can't be resolved
       *   (non-Windows, malformed id, invalid HWND, PowerShell failure).
       */
      getPidFromSourceId?: (sourceId: string) => Promise<number | null>;

      /**
       * Returns the main process's own PID (`process.processId`). Used for the
       * "entire screen" audio path so we can pass it as `excludePid` and grab
       * the whole desktop minus our own renderer's audio → no echo.
       */
      getElectronPid?: () => Promise<number>;

      /**
       * Start WASAPI loopback capture. Exactly one of:
       *   - `{ pid }`        — capture only this process (and its child tree by
       *                         default). Echo-free because the remote peer's
       *                         voice belongs to a different process.
       *   - `{ excludePid }` — capture everything EXCEPT this process tree.
       *                         Use our own PID for "entire screen" picks.
       *   - `{ system: true }` — whole default render endpoint (no filtering).
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
