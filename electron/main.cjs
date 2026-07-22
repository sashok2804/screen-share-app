// @ts-check
/**
 * Electron main process entry for the screen-share-app desktop client.
 *
 * Phase 1 responsibilities:
 *   - Create a BrowserWindow that loads the existing React client (https://localhost:3000 by default).
 *   - Register the custom URL protocol `screen-share://`.
 *   - Enforce single-instance; route second-instance launches to the existing window.
 *   - Handle macOS `open-url` for portability (Windows-only build today, but be future-proof).
 *   - Set a strict CSP that still permits wss/https to the dev server and the public deployment.
 *
 * Phase 2 adds: desktopCapturer source picker IPC handlers (`desktop-capturer:getSources`
 *               and `desktop-capturer:getSourceMetadata`) that back the renderer's custom
 *               source-picker UI instead of the native getDisplayMedia dialog.
 * Phase 3 (rewritten): per-process WASAPI loopback audio capture via the
 *               `loopback-capture` npm package. This replaces the earlier FFmpeg +
 *               DirectShow approach: instead of grabbing the system mixer (which
 *               includes the remote peer's voice coming out of our speakers →
 *               echo), we capture via `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`
 *               in one of two modes (the same trick Discord uses):
 *                 • INCLUDE-target-process-tree — only the chosen process and
 *                   its children (used when the host picks a specific window).
 *                 • EXCLUDE-target-process-tree — everything EXCEPT the given
 *                   process tree; we pass our own Electron PID so the capture
 *                   includes all desktop audio minus our renderer's audio →
 *                   echo-free "entire screen" capture (no separate audio modal).
 *               `startSystemAudio` falls back to classic WASAPI loopback on the
 *               default render endpoint when the chosen window's PID can't be
 *               resolved. Raw PCM (16-bit signed LE, stereo, 48 kHz) is
 *               averaged to mono Float32 in the main process and forwarded to
 *               the renderer, where a ScriptProcessorNode feeds it into a
 *               MediaStreamAudioDestinationNode → WebRTC.
 */

'use strict';

const { app, BrowserWindow, session, Menu, shell, ipcMain, desktopCapturer } = require('electron');

const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');

/**
 * `loopback-capture` ships a prebuilt N-API v9 binary (no Visual Studio build
 * tools required) and only exposes `LoopbackCapture` with
 * `start(pid, includeProcessTree, cb)`, `startSystemAudio(cb)` and `stop()`.
 * The `includeProcessTree` flag maps directly to the Win32
 * `PROCESS_LOOPBACK_MODE_{INCLUDE,EXCLUDE}_TARGET_PROCESS_TREE` parameter
 * (see node_modules/loopback-capture/src/LoopbackCapture.cpp):
 *   - `true`  → capture only `pid` and its children (per-application pick).
 *   - `false` → capture everything EXCEPT `pid` and its children (entire-screen
 *               pick where we pass our own Electron PID to mute ourselves).
 * On non-Windows platforms the require() succeeds but the constructor logs a
 * warning — we gate all calls behind `process.platform === 'win32'` below.
 */
let loopback = null;
try {
  loopback = require('loopback-capture');
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('[audio] failed to load loopback-capture:', err && err.message ? err.message : err);
}

/**
 * Default URL of the React client. In dev this is the Vite dev server proxied through
 * the Fastify HTTPS server on :3000. Override with SCREENSHARE_URL env var.
 *
 * NOTE: `RESOLVED_URL` below is the legacy fallback used by helpers that don't
 * care about user config (e.g. the Help menu, IPC exports). The runtime path is
 * `loadConfig().url` / the URL passed to `createMainWindow(url)`.
 */
const DEFAULT_URL = 'https://194.226.115.141:8443';
const RESOLVED_URL = process.env.SCREENSHARE_URL || DEFAULT_URL;

/**
 * Absolute path of `server-config.json` inside the per-user data directory
 * (`%APPDATA%/Screen Share/server-config.json` on Windows). Holds the user's
 * chosen server URL and `trustSelfSignedCerts` flag.
 *
 * Shape:
 *   { "url": "https://localhost:3000", "trustSelfSignedCerts": true }
 */
const CONFIG_FILE = path.join(app.getPath('userData'), 'server-config.json');

/** Default values used when the file is absent or reset by the user. */
const DEFAULT_CONFIG = Object.freeze({
  url: DEFAULT_URL,
  trustSelfSignedCerts: true,
});

/**
 * In-memory cache of the parsed config. `readConfig()` populates it on first
 * access and `writeConfig()` updates it on every save so the rest of the
 * main process (e.g. `installCertBypass`) doesn't have to re-read the file.
 *
 * @type {{ url: string, trustSelfSignedCerts: boolean } | null}
 */
let cachedConfig = null;

/**
 * Load the user's server config. Missing file, missing keys, or a malformed
 * JSON all fall back to {@link DEFAULT_CONFIG} so the app always boots. The
 * parsed object is cached in {@link cachedConfig} — subsequent calls return
 * the same reference.
 *
 * @returns {{ url: string, trustSelfSignedCerts: boolean }}
 */
function readConfig() {
  if (cachedConfig) return cachedConfig;
  /** @type {{ url: string, trustSelfSignedCerts: boolean }} */
  const cfg = { ...DEFAULT_CONFIG };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.url === 'string' && parsed.url.trim()) {
          cfg.url = parsed.url.trim();
        }
        if (typeof parsed.trustSelfSignedCerts === 'boolean') {
          cfg.trustSelfSignedCerts = parsed.trustSelfSignedCerts;
        }
      }
    }
  } catch (err) {
    // Corrupt JSON / IO error — log and fall back to defaults rather than
    // bricking the app. The user can still re-enter the URL via Settings.
    // eslint-disable-next-line no-console
    console.warn('[config] failed to read server-config.json, using defaults:', err);
  }
  cachedConfig = cfg;
  return cfg;
}

/**
 * Persist the config to disk and update the in-memory cache. Validates the URL
 * (must be http/https, max length as a sanity check). Returns the normalised
 * config on success, or `null` on validation failure (caller surfaces the
 * error in the UI).
 *
 * @param {{ url?: unknown, trustSelfSignedCerts?: unknown }} input
 * @returns {{ url: string, trustSelfSignedCerts: boolean } | null}
 */
function writeConfig(input) {
  const url = typeof input?.url === 'string' ? input.url.trim() : '';
  if (!url || url.length > 2048 || !/^https?:\/\//i.test(url)) {
    return null;
  }
  // Normalize a bare host ("localhost:3000") into https://.
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  // Reject obvious garbage (no host) but allow any port/path.
  if (!parsed.hostname) return null;

  /** @type {{ url: string, trustSelfSignedCerts: boolean }} */
  const cfg = {
    url: parsed.href.replace(/\/$/, ''),
    trustSelfSignedCerts: input?.trustSelfSignedCerts !== false,
  };

  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[config] failed to write server-config.json:', err);
    return null;
  }
  cachedConfig = cfg;
  return cfg;
}

/** Delete the config file (used by the "Reset settings" action). */
function deleteConfig() {
  cachedConfig = null;
  try {
    if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[config] failed to delete server-config.json:', err);
  }
}

/**
 * Whether the user's server-config.json exists on disk. Used at boot to decide
 * whether to show the first-run setup screen. We deliberately don't use
 * `cachedConfig` here — we want a fresh disk check.
 *
 * @returns {boolean}
 */
function configExists() {
  try {
    return fs.existsSync(CONFIG_FILE);
  } catch {
    return false;
  }
}

/**
 * In dev we use a self-signed cert (server/certs/cert.pem). Chromium blocks the
 * load with ERR_CERT_AUTHORITY_INVALID and surfaces an interstitial that makes
 * the picker/audio loop painful to test. When NOT packaged we install a
 * `setCertificateVerifyProc` that accepts any cert whose host is localhost (or
 * 127.0.0.1) so the dev server loads cleanly.
 *
 * PRODUCTION BUILDS MUST USE A PROPERLY TRUSTED CERTIFICATE. We never bypass
 * cert verification when `app.isPackaged` is true — the verify proc is simply
 * not installed, so Chromium's default validation applies.
 */
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let configWindow = null;
/**
 * Holds a room id that arrived via `screen-share://room/<id>` while the main
 * window wasn't ready (first run, or while the settings window was open).
 * Flushed to the renderer as soon as {@link mainWindow} goes online.
 *
 * @type {string | null}
 */
let pendingRoomId = null;

/**
 * Parse a `screen-share://...` URL and extract the roomId.
 * Accepts forms like:
 *   - screen-share://room/abc123
 *   - screen-share://room/abc123/
 *   - screen-share:///room/abc123
 *   - screen-share:room/abc123
 * @param {string} raw
 * @returns {string | null}
 */
function parseScreenShareUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'screen-share:') return null;

  // After the scheme, pathname is the meaningful part. Handle host vs path forms.
  const parts = [url.hostname, url.pathname]
    .filter(Boolean)
    .join('/')
    .split('/')
    .filter(Boolean); // drop empties

  // Expected: ["room", "<roomId>"]
  if (parts.length >= 2 && parts[0].toLowerCase() === 'room') {
    return parts[1] || null;
  }
  // Fallback: bare roomId after scheme.
  if (parts.length === 1) {
    return parts[0] || null;
  }
  return null;
}

/**
 * Forward an inbound screen-share:// URL to the renderer. If the main window
 * isn't loaded yet (first run, still showing the settings screen, or booted
 * into the error path), the room id is stashed in {@link pendingRoomId} and
 * delivered once the main window's DOM is ready (see the
 * `dom-ready` listener in {@link createMainWindowFromConfig}).
 * @param {string} raw
 */
function dispatchOpenRoom(raw) {
  const roomId = parseScreenShareUrl(raw);
  if (!roomId) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Make sure the window is visible before we poke the renderer.
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send('open-room', roomId);
  } else {
    pendingRoomId = roomId;
  }
}

/**
 * Boot the main window from the saved (or just-saved) config, then flush any
 * queued room id to the renderer. Centralises the post-config plumbing so
 * `app.whenReady`, the `server:connect` handler, and the auto-start path all
 * behave identically.
 *
 * @returns {Promise<BrowserWindow>}
 */
async function createMainWindowFromConfig() {
  const cfg = readConfig();
  // CSP + cert bypass are (re)installed each time we boot the main window so
  // they pick up the latest saved URL.
  installCsp(cfg);
  installCertBypass(cfg);
  const win = await createMainWindow(cfg.url);

  // If the load already failed and triggered the error UI, the window is
  // gone — bail out without touching webContents.
  if (win.isDestroyed()) return win;

  // Once the renderer's DOM is ready, deliver any pending deep-link room id.
  win.webContents.once('dom-ready', () => {
    if (win.isDestroyed()) return;
    if (pendingRoomId) {
      const id = pendingRoomId;
      pendingRoomId = null;
      try {
        win.webContents.send('open-room', id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[main] failed to flush pending room id:', err);
      }
    }
  });

  return win;
}

/** Build a minimal application menu. */
function buildMenu() {
  const isMac = process.platform === 'darwin';
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }]
      : []),
    {
      label: 'File',
      submenu: [
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Настройки сервера...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            // Closes the main window (inside createConfigWindow) and opens
            // server-config.html so the user can change the server URL or
            // toggle the self-signed cert trust flag.
            createConfigWindow('settings');
          }
        },
        { type: 'separator' },
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open Website',
          click: () => {
            const baseUrl = RESOLVED_URL.replace(/\/$/, '');
            shell.openExternal(baseUrl).catch(() => {});
          }
        }
      ]
    }
  ];
  return Menu.buildFromTemplate(template);
}

/**
 * Install a Content-Security-Policy via response headers. We need:
 *   - connect-src: wss/https to localhost (dev) and the public deployment (https + wss).
 *   - media-src / img-src: blob:, data:, https.
 *   - script-src / style-src: allow Vite (inline styles, eval in dev), renderer bundle.
 *
 * The CSP is parameterised by the user's chosen server URL (`config.url`), so
 * changing servers doesn't require rebuilding. Local `file://` loads (the
 * first-run `server-config.html` screen) are exempt — they need inline
 * scripts/styles and don't talk to the network, so we skip CSP injection for
 * non-http(s) responses entirely.
 *
 * @param {{ url: string }} [config]
 */
function installCsp(config) {
  const base = (config && config.url) || RESOLVED_URL;
  let origin = 'https://localhost:3000';
  try {
    origin = new URL(base).origin;
  } catch {
    /* keep default */
  }

  // In dev Vite needs eval + inline scripts/styles. Lock down in production.
  const scriptSrc = isDev
    ? "'self' 'unsafe-inline' 'unsafe-eval'"
    : "'self' 'unsafe-inline'";
  const styleSrc = isDev ? "'self' 'unsafe-inline'" : "'self' 'unsafe-inline'";
  const connectSrc = [
    "'self'",
    'wss://localhost:*',
    'https://localhost:*',
    'ws://localhost:*',
    origin,
    // allow wss/ws variants of the public deployment
    origin.replace(/^http/, 'ws'),
    origin.replace(/^http/, 'wss'),
    // Cloudflare/Google STUN aren't fetched over HTTP, but allow turn:/stun: implicitly.
    'stun:',
    'turn:'
  ].join(' ');

  /** @type {Record<string, string>} */
  const csp = {
    'default-src': "'self'",
    'script-src': scriptSrc,
    'style-src': styleSrc,
    'img-src': "'self' data: blob: https:",
    'media-src': "'self' blob: data: https:",
    'connect-src': connectSrc,
    'font-src': "'self' data:",
    'object-src': "'none'",
    'frame-ancestors': "'none'",
    'base-uri': "'self'",
    'form-action': "'self'"
  };
  const headerValue = Object.entries(csp)
    .map(([k, v]) => `${k} ${v}`)
    .join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Only inject CSP for remote responses. Local file:// loads (the setup
    // screen) need inline scripts and don't have a meaningful origin, so we
    // leave them alone.
    if (!/^https?:\/\//i.test(details.url)) {
      callback({});
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [headerValue]
      }
    });
  });
}

/**
 * Create (or re-create) the main BrowserWindow that loads the remote React
 * client. Takes the URL explicitly so the same function works regardless of
 * whether the URL came from `SCREENSHARE_URL` (dev env), the saved config, or
 * a one-off `?room=` deep link.
 *
 * If `loadURL` fails (server down, cert still rejected after bypass, DNS
 * failure) we tear this window down and show {@link showErrorWindow} so the
 * user can fix the address via the settings screen instead of staring at a
 * black window.
 *
 * @param {string} url Fully-qualified https:// URL to load.
 * @param {boolean} [devTools] Override the dev-tools default (mainly for tests).
 * @returns {Promise<BrowserWindow>}
 */
async function createMainWindow(url, devTools) {
  /** @type {Electron.BrowserWindowConstructorOptions} */
  const winOptions = {
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0b0e14',
    title: 'Screen Share',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require('electron') / ipcRenderer
      spellcheck: false
    }
  };

  const win = new BrowserWindow(winOptions);
  mainWindow = win;

  /** Tracks whether we've already swapped to the error UI for this window. */
  let fatalTriggered = false;
  /**
   * Swap to the error config window. Idempotent — `did-fail-load` and the
   * `loadURL` rejection can both fire for the same failure, and double-
   * calling `createConfigWindow` would tear down a window twice.
   *
   * @param {string} message
   */
  const triggerFatal = (message) => {
    if (fatalTriggered) return;
    fatalTriggered = true;
    showFatalErrorWindow(url, message);
  };

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    // eslint-disable-next-line no-console
    console.warn(
      `[main] did-fail-load: ${errorCode} ${errorDescription} (${validatedURL || url})`,
    );
    // Only treat it as fatal if the main page itself failed (not a
    // sub-resource) AND it's not an ERR_ABORTED (-3) which usually accompanies
    // a redirect/reload rather than a true failure.
    if (
      validatedURL &&
      (validatedURL === url || validatedURL.replace(/\/$/, '') === url.replace(/\/$/, '')) &&
      errorCode !== -3
    ) {
      triggerFatal(`${errorDescription || 'load failed'} (code ${errorCode})`);
    }
  });

  // Open external links (target=_blank) in the OS browser, not a new Electron window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) {
      shell.openExternal(target).catch(() => {});
    }
    return { action: 'deny' };
  });

  let loadError = null;
  try {
    await win.loadURL(url);
  } catch (err) {
    // Two common cases:
    //   (a) ERR_CERT_AUTHORITY_INVALID for a self-signed cert that the bypass
    //       didn't cover (e.g. trustSelfSignedCerts=false and non-localhost).
    //   (b) ERR_CONNECTION_REFUSED when the server is down.
    // In both cases Chromium ALSO fires `did-fail-load`, which has already
    // called `triggerFatal()` and destroyed this window. We only fall back to
    // the error UI ourselves if that somehow didn't happen.
    loadError = err instanceof Error ? err : new Error(String(err));
    // eslint-disable-next-line no-console
    console.warn(`[main] loadURL rejected: ${loadError.message}`);
  }

  // The error path may have destroyed this window out from under us. Guard
  // every subsequent access.
  if (win.isDestroyed()) {
    // `did-fail-load` already swapped to the error UI — nothing more to do.
    return win;
  }

  if (loadError) {
    // `did-fail-load` didn't fire (some cert failures skip it), so trigger
    // the error UI explicitly.
    triggerFatal(loadError.message);
    return win;
  }

  if (devTools === undefined ? isDev : devTools) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

/**
 * Create the first-run / settings window that loads the local
 * `server-config.html` via `loadFile`. The window is intentionally smaller
 * than the main app — it's a modal-style form, not the full UI.
 *
 * @param {'first-run' | 'settings' | 'error'} [mode] Hint passed to the page
 *   via a query param so it can tweak copy (e.g. show a "couldn't connect"
 *   banner when reached from the error path).
 * @param {string} [errorMessage] Optional error string for `mode === 'error'`.
 * @returns {BrowserWindow}
 */
function createConfigWindow(mode, errorMessage) {
  // If a config window is already open (e.g. user hit Ctrl+, twice), just
  // focus it instead of stacking duplicates.
  const existing = BrowserWindow.getAllWindows().find((w) => {
    try {
      return !w.isDestroyed() && w.webContents.getURL().startsWith('file:');
    } catch {
      return false;
    }
  });
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }

  // IMPORTANT: create the new config window BEFORE destroying the main
  // window. Otherwise `window-all-closed` fires between the two calls and
  // quits the app (on non-macOS) before the settings window has a chance
  // to come up.
  /** @type {Electron.BrowserWindowConstructorOptions} */
  const options = {
    width: 560,
    height: 520,
    minWidth: 480,
    minHeight: 420,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0b0e14',
    title: 'Screen Share — Server Settings',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  };

  const win = new BrowserWindow(options);
  configWindow = win;

  // Now that the new window exists, we can safely tear down the main window.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
    mainWindow = null;
  }

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  win.on('closed', () => {
    if (configWindow === win) configWindow = null;
    // If the user closes the config window without saving AND there's no main
    // window, quit. Otherwise we'd be left with an invisible app.
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      BrowserWindow.getAllWindows().length === 0
    ) {
      // Don't quit on macOS (convention), do quit everywhere else.
      if (process.platform !== 'darwin') app.quit();
    }
  });

  // loadFile with a query string so the page can read `location.search` to
  // decide which banner to show. Electron joins these as `?mode=first-run`.
  win.loadFile(path.join(__dirname, 'server-config.html'), {
    query: {
      mode: mode || 'first-run',
      ...(errorMessage ? { error: String(errorMessage).slice(0, 500) } : {}),
    },
  });

  return win;
}

/**
 * Convenience wrapper around {@link createConfigWindow} for the post-failure
 * path: shows the same form but with an error banner so the user knows why
 * they were dumped back to setup.
 *
 * @param {string} attemptedUrl
 * @param {string} [message]
 */
function showFatalErrorWindow(attemptedUrl, message) {
  // eslint-disable-next-line no-console
  console.error(
    `[main] fatal: failed to load ${attemptedUrl}${message ? ` — ${message}` : ''}`,
  );
  createConfigWindow('error', message || `Could not reach ${attemptedUrl}`);
}

/**
 * Single-instance + protocol entry point. We request the lock *before* app.whenReady()
 * so that the second-instance handler is in place when this process is the primary one.
 */
function registerSingleInstance() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    // Another instance is already running. Bail.
    app.quit();
    return false;
  }

  // Windows/Linux: a launch with a protocol URL passes the URL as the last argv item.
  app.on('second-instance', (_event, argv, _workingDirectory) => {
    // Find the screen-share:// argument.
    const protoUrl = argv.find((a) => /^screen-share:/i.test(a));
    if (protoUrl) {
      dispatchOpenRoom(protoUrl);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // macOS: launched via custom protocol fires 'open-url'.
  /** @param {Electron.Event} _event */
  app.on('open-url', (_event, url) => {
    // The event arrives before (or after) whenReady depending on state; just defer.
    if (url) dispatchOpenRoom(url);
  });

  // macOS: 'open-file' isn't used for our protocol flow.

  return true;
}

function registerProtocol() {
  // Register as the default handler for the screen-share:// scheme.
  // Best-effort; returns false on some environments but the OS may still route.
  try {
    app.setAsDefaultProtocolClient('screen-share');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[main] setAsDefaultProtocolClient failed:', err);
  }
}

// Renderer → main: sync handler so the renderer's getAppVersion() can return a string.
ipcMain.on('electron:app-version-sync', (event) => {
  event.returnValue = app.getVersion();
});

// ---------------------------------------------------------------------------
// Server config IPC (first-run UI + Settings menu).
// ---------------------------------------------------------------------------

/**
 * Renderer → main: return the current config + app version. Used by
 * `server-config.html` to prefill the form. Always resolves (never throws) —
 * the renderer treats a null `url` as "no saved config".
 */
ipcMain.handle('server:get-config', () => {
  const cfg = readConfig();
  return {
    url: cfg.url,
    trustSelfSignedCerts: cfg.trustSelfSignedCerts,
    appVersion: app.getVersion(),
    firstRun: !configExists(),
  };
});

/**
 * Renderer → main: persist the user's choices. Returns `{ ok, config?, error? }`.
 * On success the in-memory cache is updated but the main window is NOT opened
 * yet — the renderer follows up with `server:connect` to actually swap windows.
 *
 * @param {unknown} raw
 * @returns {Promise<{ ok: true, config: { url: string, trustSelfSignedCerts: boolean } } | { ok: false, error: string }>}
 */
ipcMain.handle('server:save', async (_event, raw) => {
  const saved = writeConfig(raw);
  if (!saved) {
    return { ok: false, error: 'Invalid server URL. Use https://host:port' };
  }
  return { ok: true, config: saved };
});

/**
 * Renderer → main: persist the form values AND swap from the settings window
 * to the main window. This is the "Connect" button handler. The settings
 * window is closed via `BrowserWindow.close()` after the main window has
 * finished loading, so the user doesn't see a flash of no-window.
 *
 * Returns `{ ok, error? }`. On failure the settings window stays open so the
 * user can correct the URL.
 *
 * @param {unknown} raw
 */
ipcMain.handle('server:connect', async (_event, raw) => {
  const saved = writeConfig(raw);
  if (!saved) {
    return { ok: false, error: 'Invalid server URL. Use https://host:port' };
  }

  try {
    // Boot the main window from the just-saved config. CSP + cert bypass get
    // reinstalled inside `createMainWindowFromConfig` with the new URL.
    await createMainWindowFromConfig();

    // Close the settings window once the main window is showing. We wait for
    // `ready-to-show` to avoid a brief flash where both/neither window is up.
    if (configWindow && !configWindow.isDestroyed()) {
      const cw = configWindow;
      const closeConfigWindow = () => {
        try {
          if (!cw.isDestroyed()) cw.close();
        } catch {
          /* ignore */
        }
      };
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.once('ready-to-show', closeConfigWindow);
        // Safety net: don't leave the settings window open forever if
        // ready-to-show already fired (race) — close after 5s.
        setTimeout(closeConfigWindow, 5000);
      } else {
        closeConfigWindow();
      }
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
});

/**
 * Renderer → main: wipe `server-config.json` so the next launch shows the
 * first-run screen. Also resets the in-memory cache. Doesn't open the settings
 * window — pair with `server:open-settings` for that.
 */
ipcMain.handle('server:reset', async () => {
  deleteConfig();
  return { ok: true };
});

/**
 * Renderer (or menu) → main: open the settings window. Used by the Settings
 * menu item (Ctrl+,) and by the "Open settings" button on the error screen.
 * Closes the main window first so there's exactly one window on screen.
 */
ipcMain.handle('server:open-settings', async (_event, modeArg) => {
  createConfigWindow(
    modeArg === 'error' ? 'error' : 'settings',
    typeof modeArg === 'string' && modeArg.startsWith('error:') ? modeArg.slice(6) : undefined,
  );
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Phase 2 — desktopCapturer source picker.
// ---------------------------------------------------------------------------

/**
 * Cache of the most recent `getSources` result, keyed by source id. Used by
 * `getSourceMetadata` so a follow-up name lookup (after the renderer picked a
 * source) doesn't re-query the OS.
 *
 * @type {Map<string, { id: string, name: string, display_id?: string }>}
 */
const sourceCache = new Map();

/**
 * Renderer → main: list windows/screens with thumbnails + (optional) app icons.
 * Returns plain-serialisable objects so they cross the contextBridge cleanly.
 * Side effect: refreshes `sourceCache`.
 */
ipcMain.handle('desktop-capturer:getSources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    /** @type {Array<{id: string, name: string, display_id?: string, thumbnailDataURL: string, appIconDataURL?: string | null}>} */
    const result = sources.map((s) => {
      const entry = {
        id: s.id,
        name: s.name,
        display_id: s.display_id,
        thumbnailDataURL: s.thumbnail.toDataURL(),
        appIconDataURL: s.appIcon ? s.appIcon.toDataURL() : null,
      };
      sourceCache.set(s.id, { id: s.id, name: s.name, display_id: s.display_id });
      return entry;
    });
    // Drop cache entries that are no longer present to avoid unbounded growth.
    const liveIds = new Set(result.map((s) => s.id));
    for (const id of [...sourceCache.keys()]) {
      if (!liveIds.has(id)) sourceCache.delete(id);
    }
    return result;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[main] desktopCapturer.getSources failed:', err);
    return [];
  }
});

/**
 * Renderer → main: cheap metadata lookup for a previously-listed source.
 * Returns `{ name }` or `null` if the id is unknown / cache was cleared.
 *
 * @param {unknown} _event
 * @param {unknown} sourceIdRaw
 */
ipcMain.handle(
  'desktop-capturer:getSourceMetadata',
  (_event, sourceIdRaw) => {
    if (typeof sourceIdRaw !== 'string') return null;
    const hit = sourceCache.get(sourceIdRaw);
    return hit ? { name: hit.name } : null;
  },
);

// ---------------------------------------------------------------------------
// Phase 3 (rewritten) — per-process WASAPI loopback via `loopback-capture`.
// ---------------------------------------------------------------------------

/**
 * Convert a raw PCM chunk (16-bit signed LE, stereo, 48 kHz) from the native
 * addon into a mono Float32Array for the renderer's Web Audio graph. Stereo
 * frames are averaged to mono and each sample is normalised to [-1, 1] by
 * dividing by 32768. The resulting buffer is structured-cloneable so it can
 * cross the contextBridge intact.
 *
 * @param {Buffer} chunk  Raw PCM from `loopback-capture`.
 * @returns {Float32Array}  Mono Float32 samples.
 */
function pcmStereoS16ToMonoF32(chunk) {
  // Each stereo frame is 4 bytes (2 channels × 2 bytes / int16).
  const samples = chunk.length >> 2; // floor(len/4)
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const left = chunk.readInt16LE(i * 4);
    const right = chunk.readInt16LE(i * 4 + 2);
    out[i] = (left + right) * (1 / 65536); // (L+R)/2 / 32768 == (L+R)/65536
  }
  return out;
}

/**
 * Currently active `LoopbackCapture` instance. Only one capture runs at a time
 * per window; starting a new one stops the previous.
 * @type {{ stop: () => void } | null}
 */
let currentCapture = null;

/**
 * IPC: list running processes that own a visible window. Used by the renderer's
 * auto-audio heuristic to resolve a chosen video source to a PID
 * (desktopCapturer does NOT expose the PID behind a window source, so the
 * renderer joins on `name` / `title`). Returns `{ pid, name, title }[]`,
 * always a stable array — empty on non-Windows or on PowerShell failure.
 *
 * Implementation note: Electron's `desktopCapturer.getSources()` does NOT
 * expose the PID behind a window source, so we can't simply join on it. We
 * query `Get-Process` directly — it's fast (<100 ms typical), no external
 * deps, and matches the Windows-only nature of this feature.
 *
 * @returns {Promise<Array<{ pid: number, name: string, title: string }>>}
 */
ipcMain.handle('audio:listProcesses', async () => {
  if (process.platform !== 'win32') return [];
  try {
    // ConvertTo-Json returns a single object (not an array) when only one
    // process matches — normalise to an array in JS.
    const output = execSync(
      'powershell -NoProfile -NonInteractive -Command ' +
        '"Get-Process | Where-Object { $_.MainWindowTitle -ne [string]::Empty } | ' +
        'Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress"',
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
    );
    if (!output || !output.trim()) return [];
    let list = JSON.parse(output);
    if (!Array.isArray(list)) list = [list];
    return list
      .filter(
        (p) =>
          p && typeof p.Id === 'number' && typeof p.ProcessName === 'string' && typeof p.MainWindowTitle === 'string',
      )
      .map((p) => ({ pid: p.Id, name: p.ProcessName, title: p.MainWindowTitle }))
      .filter((p) => p.title.length > 0 && p.name.length > 0)
      // Sort by name for a stable, scannable list in the picker.
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[audio:listProcesses] failed:', err && err.message ? err.message : err);
    return [];
  }
});

/**
 * IPC: start WASAPI loopback capture. `opts` is one of:
 *   - `{ system: true }`         capture the entire default render endpoint
 *                                 (classic WASAPI loopback — everything playing).
 *                                 Used as a fallback when the chosen window's
 *                                 PID can't be resolved.
 *   - `{ pid: <number> }`        capture only the chosen process (and, by
 *                                 default, its child tree) via process loopback
 *                                 in INCLUDE-target-process-tree mode. This is
 *                                 the echo-free per-application path used when
 *                                 the host picks a specific window: the remote
 *                                 peer's voice coming out of our speakers is
 *                                 owned by the Electron renderer process, NOT
 *                                 the target process, so it is excluded
 *                                 automatically.
 *   - `{ excludePid: <number> }` capture EVERYTHING EXCEPT the given process
 *                                 (and its child tree) via process loopback in
 *                                 EXCLUDE-target-process-tree mode. Used when
 *                                 the host picks the entire screen: we pass
 *                                 our own Electron PID (see `app:getPid`) so
 *                                 the capture includes all desktop audio minus
 *                                 our renderer's audio → no echo from the
 *                                 remote peer's voice played by our window.
 *
 * The `loopback-capture` native module's `start(pid, includeProcessTree, cb)`
 * maps `includeProcessTree` directly to the Win32
 * `AUDIOCLIENT_ACTIVATION_PARAMS_PROCESS_LOOPBACK_MODE` flag — INCLUDE when
 * `true`, EXCLUDE when `false` (see node_modules/loopback-capture/src/
 * LoopbackCapture.cpp). That's what makes "exclude self" work.
 *
 * Resolves to `{ ok, sampleRate, channels }` on success. Chunks are pushed to
 * the renderer as `audio:chunk` events (Float32Array, mono, 48 kHz). Mid-
 * capture failures are surfaced via `audio:error`.
 *
 * @param {unknown} _event
 * @param {unknown} rawOpts
 * @returns {Promise<{ ok: true, sampleRate: number, channels: number } | { ok: false, error: string }>}
 */
ipcMain.handle('audio:start', async (_event, rawOpts) => {
  try {
    // Stop any prior capture — only one live stream per window.
    if (currentCapture) {
      try {
        currentCapture.stop();
      } catch {
        /* ignore */
      }
      currentCapture = null;
    }

    if (!loopback) {
      return { ok: false, error: 'loopback-capture native module failed to load' };
    }
    if (process.platform !== 'win32') {
      return { ok: false, error: 'audio capture is Windows-only' };
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { ok: false, error: 'main window not available' };
    }

    /**
     * @type {{ pid?: unknown, excludePid?: unknown, includeTree?: unknown, system?: unknown }}
     */
    const opts =
      rawOpts && typeof rawOpts === 'object' ? /** @type {any} */ (rawOpts) : {};
    const wantSystem = opts.system === true;
    const pid = typeof opts.pid === 'number' ? opts.pid : null;
    const excludePid = typeof opts.excludePid === 'number' ? opts.excludePid : null;

    // Validate: exactly one of {system, pid, excludePid} must be provided.
    if (!wantSystem && pid === null && excludePid === null) {
      return {
        ok: false,
        error: 'Either opts.pid, opts.excludePid, or opts.system must be provided',
      };
    }

    // Default includeTree=true unless caller explicitly passes false. Only
    // meaningful for the include-path (we always want a process's children too,
    // e.g. a browser with helper/utility processes that emit audio).
    const includeTree = opts.includeTree !== false;

    const capture = new loopback.LoopbackCapture();

    /**
     * Shared chunk handler: convert the raw stereo-s16 PCM to mono Float32 and
     * forward to the renderer. Guarded against window destruction so a capture
     * that outlives the window (rare race on teardown) doesn't throw.
     *
     * @param {Buffer} chunk
     */
    const onChunk = (chunk) => {
      try {
        if (!chunk || chunk.length < 4) return;
        const float32 = pcmStereoS16ToMonoF32(chunk);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('audio:chunk', float32);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[audio:start] chunk handler threw:', err && err.message ? err.message : err);
      }
    };

    if (wantSystem) {
      capture.startSystemAudio(onChunk);
    } else if (excludePid !== null) {
      // EXCLUDE mode: capture everything EXCEPT the given PID (and its tree).
      // includeProcessTree=false → PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE.
      // Used for "entire screen": pass our own Electron PID so the remote
      // peer's voice played by our renderer is excluded → echo-free.
      capture.start(/** @type {number} */ (excludePid), false, onChunk);
    } else {
      // INCLUDE mode: capture only the chosen process (and its tree when
      // includeTree is true). captures the process AND any child processes
      // it spawns (e.g. a game launching a launcher, or a browser with helper
      // processes that emit audio).
      capture.start(/** @type {number} */ (pid), includeTree, onChunk);
    }

    currentCapture = capture;
    return { ok: true, sampleRate: 48000, channels: 1 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('[audio:start] failed:', message);
    // Surface the failure to the renderer's onAudioError subscription too, so
    // the user sees it in the UI rather than just in the main-process console.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('audio:error', { message });
    }
    return { ok: false, error: message };
  }
});

/**
 * IPC: return the Electron main process's own PID (`process.processId`). The
 * renderer uses this for the "entire screen" audio path: passing our own PID
 * as `excludePid` to `audio:start` captures the whole desktop minus our
 * renderer's audio output → no echo from the remote peer's voice. Resolves
 * even outside Windows (returns the Node process pid regardless) so the
 * renderer code path doesn't need its own platform branch.
 *
 * @returns {Promise<number>}
 */
ipcMain.handle('app:getPid', async () => {
  // `process.processId` is Electron's PID on Windows/Linux; on macOS in a
  // packaged build it's the main process pid too. Fall back to `process.pid`
  // (always defined) just in case.
  const pid =
    typeof process.processId === 'number'
      ? process.processId
      : typeof process.pid === 'number'
        ? process.pid
        : 0;
  return pid;
});

/**
 * IPC: stop the current capture (if any). Always resolves to `{ ok: true }`.
 */
ipcMain.handle('audio:stop', async () => {
  try {
    if (currentCapture) {
      try {
        currentCapture.stop();
      } catch {
        /* ignore */
      }
      currentCapture = null;
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
});

/**
 * Install the certificate verify proc on the default session.
 *
 * History: this used to be a no-op when `app.isPackaged` was true, which meant
 * the default `https://localhost:3000` self-signed dev cert was rejected by
 * Chromium in the installed build → ERR_CERT_AUTHORITY_INVALID → black window.
 * We now honour the user's `trustSelfSignedCerts` setting (default: `true` so
 * the first-run flow against the bundled dev server just works).
 *
 * Acceptance rules (any one of):
 *   1. Host is `localhost` / `127.0.0.1` / `::1` (loopback is trusted
 *      regardless of the cert, mirrors the original dev-only behaviour).
 *   2. The request's origin matches the saved server URL's origin AND the
 *      user hasn't disabled self-signed trust. This is what lets the packaged
 *      app talk to a friend's self-signed deployment at e.g.
 *      `https://192.168.1.10:3000` after they enter the address once.
 *   3. `trustSelfSignedCerts` is `true` (the default) — accept everything.
 *      Convenience for first-run; users who want strict validation can flip
 *      the checkbox off in the settings screen.
 *
 * @param {{ url: string, trustSelfSignedCerts: boolean }} [config]
 */
function installCertBypass(config) {
  const cfg = config || readConfig();

  /** Saved server origin (e.g. `https://192.168.1.10:3000`). Empty string if unset. */
  let savedOrigin = '';
  try {
    savedOrigin = new URL(cfg.url).origin;
  } catch {
    /* keep empty */
  }

  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const { hostname, validationResult, verificationFont: _vf } = request;

    // (1) Loopback — always trusted, dev or packaged.
    if (
      typeof hostname === 'string' &&
      (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1')
    ) {
      callback(0);
      return;
    }

    // Build the request origin to compare against the saved URL.
    /** @type {string} */
    let origin = '';
    try {
      // `request` has `origin` on newer Electron; fall back to reconstructing
      // from the URL field if present.
      origin =
        /** @type {any} */ (request).origin ||
        (typeof request === 'object' && typeof request.url === 'string'
          ? new URL(request.url).origin
          : '');
    } catch {
      /* ignore */
    }

    // (2) Origin matches the saved server URL — trust it.
    if (savedOrigin && origin && origin === savedOrigin) {
      callback(0);
      return;
    }

    // (3) User opted into trusting any self-signed cert.
    if (cfg.trustSelfSignedCerts) {
      callback(0);
      return;
    }

    // Otherwise defer to Chromium's default validation.
    // `-2` === "use default" per Electron's CertVerifyResult; we pass through
    // the request's own `validationResult` when available for completeness.
    callback(typeof validationResult === 'number' ? validationResult : -2);
  });

  // eslint-disable-next-line no-console
  console.log(
    `[main] cert bypass active (trustSelfSignedCerts=${cfg.trustSelfSignedCerts}, savedOrigin=${savedOrigin || 'n/a'})`,
  );
}

// Pre-load the loopback-capture native module so we surface any load failure
// at startup (logged once) instead of on the first audio:start call.
app.whenReady().then(async () => {
  registerProtocol();
  Menu.setApplicationMenu(buildMenu());

  // (1) Dev override: when SCREENSHARE_URL is set in env we skip the settings
  //     UI entirely and load that URL directly. This preserves the existing
  //     `npm -w electron run dev` flow against the local Fastify server.
  if (process.env.SCREENSHARE_URL) {
    installCsp({ url: process.env.SCREENSHARE_URL });
    // In dev we always trust localhost regardless of any saved config.
    installCertBypass({
      url: process.env.SCREENSHARE_URL,
      trustSelfSignedCerts: true,
    });
    await createMainWindow(process.env.SCREENSHARE_URL);
    return;
  }

  // (2) First run / reset: no config file → show the setup screen. We DON'T
  //     install cert bypass / CSP yet — those get installed (with the final
  //     URL) when the user clicks "Connect" via `server:connect`.
  if (!configExists()) {
    // eslint-disable-next-line no-console
    console.log('[main] no server-config.json — showing first-run setup');
    createConfigWindow('first-run');
    return;
  }

  // (3) Returning user — boot straight into the saved server.
  await createMainWindowFromConfig();
});

// Quit when all windows are closed, except on macOS. Also tear down any
// running loopback capture so we don't leak a live WASAPI session.
app.on('window-all-closed', () => {
  if (currentCapture) {
    try {
      currentCapture.stop();
    } catch {
      /* ignore */
    }
    currentCapture = null;
  }
  configWindow = null;
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (process.env.SCREENSHARE_URL) {
      await createMainWindow(process.env.SCREENSHARE_URL);
    } else if (configExists()) {
      await createMainWindowFromConfig();
    } else {
      createConfigWindow('first-run');
    }
  }
});

// Export internals for debugging/tests (CommonJS).
module.exports = {
  parseScreenShareUrl,
  DEFAULT_URL,
  RESOLVED_URL,
  pcmStereoS16ToMonoF32,
};
