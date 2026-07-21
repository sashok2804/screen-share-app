/**
 * Ambient types for the `window.electronAPI` surface exposed by the Electron
 * preload script (see `electron/preload.cjs`).
 *
 * `isElectron`, `getAppVersion()`, `onOpenRoom()`, `getSources()` and
 * `getSourceMetadata()` are implemented (Phases 1 + 2). The remaining members
 * are declared so the renderer code can be written against the final shape;
 * they are optional and resolve to `undefined` until Phase 3 lands.
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

      // ---- Phase 3: FFmpeg WASAPI bridge ----------------------------------
      listAudioDevices?: () => Promise<string[]>;
      startProcessAudio?: (
        deviceName: string
      ) => Promise<{ ok: boolean; sampleRate: number; channels: number }>;
      stopProcessAudio?: () => Promise<void>;
      onAudioChunk?: (callback: (chunk: Float32Array) => void) => void;
    };
  }
}
