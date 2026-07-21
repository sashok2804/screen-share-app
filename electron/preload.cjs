// @ts-check
/**
 * Electron preload script — runs in an isolated context with access to a limited
 * subset of Electron APIs and exposes them to the renderer via contextBridge.
 *
 * Phase 1 exposes just enough for the React client to:
 *   - detect that it's running inside Electron,
 *   - read the app version (for About UI / telemetry),
 *   - subscribe to `open-room` events forwarded from the main process when the
 *     app is launched/activated via the `screen-share://` protocol.
 *
 * TODO: Phase 2 — expose desktopCapturer source picker (getSources).
 * TODO: Phase 3 — expose FFmpeg WASAPI bridge (listAudioDevices, startProcessAudio,
 *                 stopProcessAudio, onAudioChunk).
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /** Marker so the React client can branch on `window.electronAPI?.isElectron`. */
  isElectron: true,

  /** @returns {string} Semver-ish app version from package.json via Electron. */
  getAppVersion: () => ipcRenderer.sendSync('electron:app-version-sync') || '',

  /**
   * Subscribe to room-open requests triggered by `screen-share://room/<id>` launches.
   * @param {(roomId: string) => void} callback
   * @returns {() => void} unsubscribe
   */
  onOpenRoom: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, roomId) => {
      if (typeof roomId === 'string' && roomId.length > 0) {
        try {
          callback(roomId);
        } catch (err) {
          // Never let a renderer-side callback throw into the IPC layer.
          // eslint-disable-next-line no-console
          console.error('[preload] onOpenRoom callback threw:', err);
        }
      }
    };
    ipcRenderer.on('open-room', handler);
    return () => ipcRenderer.removeListener('open-room', handler);
  }
});
