/**
 * Ambient types for the `window.electronAPI` surface exposed by the Electron
 * preload script (see `electron/preload.cjs`).
 *
 * Phases 1, 2 and 3 are all implemented (source picker + FFmpeg audio bridge).
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
  sampleRate: number;
  channels: number;
}
/** Result of `startProcessAudio` on failure. */
export interface ProcessAudioStartErr {
  ok: false;
  error: string;
}
export type ProcessAudioStartResult = ProcessAudioStartOk | ProcessAudioStartErr;

/** Options accepted by `startProcessAudio`. */
export interface StartProcessAudioOptions {
  /** DShow/WASAPI device name; empty = FFmpeg default input. */
  deviceName?: string;
  /** Output sample rate. Default 48000. */
  sampleRate?: number;
  /** Output channel count. Default 2. */
  channels?: number;
  /** Input format. Default 'dshow'. */
  format?: 'dshow' | 'wasapi';
}

/** Result of `listAudioDevices`. */
export interface ListAudioDevicesResult {
  audio: string[];
  video: string[];
  /** `false` if FFmpeg was not found on the system. */
  ffmpegFound: boolean;
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
      /** Lists DirectShow audio/video devices. */
      listAudioDevices?: () => Promise<ListAudioDevicesResult>;

      /** Start FFmpeg audio capture from the named (or default) device. */
      startProcessAudio?: (
        opts?: StartProcessAudioOptions
      ) => Promise<ProcessAudioStartResult>;

      /** Stop the active capture. */
      stopProcessAudio?: () => Promise<{ ok: boolean }>;

      /** Subscribe to audio chunks (Float32Array). Returns an unsubscribe. */
      onAudioChunk?: (callback: (chunk: Float32Array) => void) => () => void;

      /** Subscribe to mid-capture hard errors. Returns an unsubscribe. */
      onAudioError?: (callback: (err: { message: string }) => void) => () => void;
    };
  }
}
