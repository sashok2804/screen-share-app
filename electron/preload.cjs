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
 * Phase 2 adds:
 *   - getSources(): wraps desktopCapturer to list windows/screens with thumbnails.
 *   - getSourceMetadata(sourceId): returns `{ name }` for a previously-listed
 *     source. The main process caches the last list so this call is cheap and
 *     does not re-query the OS.
 *
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
  },

  /**
   * List capturable desktop sources (windows + screens) with thumbnails.
   * Replaces the browser's native getDisplayMedia picker when running inside
   * Electron. The main process returns plain-serialisable objects (data URLs
   * for the thumbnails/icons) so this travels cleanly across the contextBridge.
   *
   * @returns {Promise<Array<{id: string, name: string, display_id?: string, thumbnailDataURL: string, appIconDataURL?: string | null}>>}
   */
  getSources: async () => {
    return await ipcRenderer.invoke('desktop-capturer:getSources');
  },

  /**
   * Look up metadata for a previously-listed source. The main process caches
   * the last `getSources` result, so this is a cheap in-memory lookup and
   * avoids re-querying the OS for the source name.
   *
   * @param {string} sourceId
   * @returns {Promise<{ name: string } | null>} `null` if the id is unknown.
   */
  getSourceMetadata: async (sourceId) => {
    if (typeof sourceId !== 'string' || sourceId.length === 0) return null;
    return await ipcRenderer.invoke('desktop-capturer:getSourceMetadata', sourceId);
  }
});
