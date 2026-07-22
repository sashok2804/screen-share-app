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
 * Phase 3 (rewritten) adds the per-process WASAPI loopback bridge
 * (`loopback-capture` npm package — Discord-style, no echo):
 *   - listAudioProcesses(): returns `{ pid, name, title }[]` of processes with a
 *     visible window, for the audio-source picker.
 *   - startProcessAudio({ pid } | { system }): starts WASAPI capture (per-process
 *     loopback, or whole-default-endpoint loopback). Returns
 *     `{ ok, sampleRate, channels }` or `{ ok:false, error }`.
 *   - stopProcessAudio(): tears down the capture session.
 *   - onAudioChunk(cb): subscribes to `audio:chunk` events (Float32Array, mono,
 *     48 kHz). Returns an unsubscribe function.
 *   - onAudioError(cb): optional diagnostic subscription for hard failures
 *     that arrive mid-capture (after start() has already resolved).
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
  },

  // ---- Phase 3 (rewritten): loopback-capture WASAPI bridge ----------------

  /**
   * List running processes that own a visible window, so the renderer can show
   * an application picker for audio capture. Returns `{ pid, name, title }[]`.
   * Empty on non-Windows or on PowerShell failure.
   *
   * @returns {Promise<Array<{ pid: number, name: string, title: string }>>}
   */
  listAudioProcesses: async () => {
    const result = await ipcRenderer.invoke('audio:listProcesses');
    return Array.isArray(result) ? result : [];
  },

  /**
   * Start WASAPI loopback capture. Pass exactly one of:
   *   - `{ system: true }` — capture the whole default render endpoint
   *     (everything playing through the default speakers/headphones).
   *   - `{ pid: <number> }` — capture only the chosen process (and its child
   *     tree) via WASAPI process loopback. This is the echo-free path: the
   *     remote peer's voice emitted by our Electron window is NOT included
   *     because it belongs to a different process.
   *
   * @param {{ pid?: number, system?: boolean }} [opts]
   * @returns {Promise<{ ok: true, sampleRate: number, channels: number } | { ok: false, error: string }>}
   */
  startProcessAudio: async (opts) => {
    return await ipcRenderer.invoke('audio:start', opts || {});
  },

  /**
   * Stop the active capture. Always resolves to `{ ok: true }`.
   * @returns {Promise<{ ok: boolean }>}
   */
  stopProcessAudio: async () => {
    return await ipcRenderer.invoke('audio:stop');
  },

  /**
   * Subscribe to mono Float32 audio chunks (48 kHz) emitted by the loopback
   * capture. Returns an unsubscribe function.
   *
   * @param {(chunk: Float32Array) => void} callback
   * @returns {() => void}
   */
  onAudioChunk: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, chunk) => {
      try {
        callback(chunk);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[preload] onAudioChunk callback threw:', err);
      }
    };
    ipcRenderer.on('audio:chunk', handler);
    return () => ipcRenderer.removeListener('audio:chunk', handler);
  },

  /**
   * Subscribe to mid-capture hard errors. Returns an unsubscribe function.
   *
   * @param {(err: { message: string }) => void} callback
   * @returns {() => void}
   */
  onAudioError: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => {
      try {
        callback(payload || { message: 'unknown audio error' });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[preload] onAudioError callback threw:', err);
      }
    };
    ipcRenderer.on('audio:error', handler);
    return () => ipcRenderer.removeListener('audio:error', handler);
  },

  // ---- Server config (first-run UI + Settings menu) ---------------------

  /**
   * Read the saved server config from `server-config.json`. Returned shape is
   * always stable; `url` is the default `https://localhost:3000` when no file
   * exists yet.
   *
   * @returns {Promise<{ url: string, trustSelfSignedCerts: boolean, appVersion: string, firstRun: boolean }>}
   */
  getServerConfig: async () => {
    const result = await ipcRenderer.invoke('server:get-config');
    return {
      url: typeof result?.url === 'string' ? result.url : 'https://localhost:3000',
      trustSelfSignedCerts: result?.trustSelfSignedCerts !== false,
      appVersion: typeof result?.appVersion === 'string' ? result.appVersion : '',
      firstRun: result?.firstRun === true,
    };
  },

  /**
   * Persist the config WITHOUT opening the main window. Useful when the user
   * wants to save without immediately connecting, or for tests.
   *
   * @param {{ url: string, trustSelfSignedCerts?: boolean }} config
   * @returns {Promise<{ ok: true, config: { url: string, trustSelfSignedCerts: boolean } } | { ok: false, error: string }>}
   */
  saveServerConfig: async (config) => {
    return await ipcRenderer.invoke('server:save', config);
  },

  /**
   * Persist the config AND swap from the settings window to the main window.
   * This is the "Connect" button handler in `server-config.html`. The settings
   * window is closed by the main process after the main window has loaded.
   *
   * @param {{ url: string, trustSelfSignedCerts?: boolean }} config
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  connectToServer: async (config) => {
    return await ipcRenderer.invoke('server:connect', config);
  },

  /**
   * Wipe `server-config.json`. The next launch will show the first-run UI.
   * Doesn't change the currently-open window.
   *
   * @returns {Promise<{ ok: boolean }>}
   */
  resetServerConfig: async () => {
    return await ipcRenderer.invoke('server:reset');
  },

  /**
   * Open the settings window (closes the main window first). Optional `mode`
   * of 'error' renders the form with an error banner.
   *
   * @param {'settings' | 'error' | string} [mode]
   * @returns {Promise<{ ok: boolean }>}
   */
  openServerSettings: async (mode) => {
    return await ipcRenderer.invoke('server:open-settings', mode);
  }
});
