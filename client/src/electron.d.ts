/**
 * Ambient types for the `window.electronAPI` surface exposed by the Electron
 * preload script (see `electron/preload.cjs`).
 *
 * Only `isElectron`, `getAppVersion()` and `onOpenRoom()` are implemented in
 * Phase 1. The remaining members are declared so the renderer code can be
 * written against the final shape; they are optional and resolve to
 * `undefined` until Phases 2/3 land.
 */
export {};

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
      getSources?: () => Promise<
        Array<{ id: string; name: string; thumbnailDataURL: string }>
      >;

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
