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
 * Phase 3 will add: FFmpeg subprocess for WASAPI loopback capture.
 */

'use strict';

const { app, BrowserWindow, session, Menu, shell, ipcMain, desktopCapturer } = require('electron');

const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');

const { listDirectShowAudioDevices } = require('./src/dshow-devices.cjs');
const { FFmpegAudioCapture } = require('./src/ffmpeg-bridge.cjs');

/**
 * Default URL of the React client. In dev this is the Vite dev server proxied through
 * the Fastify HTTPS server on :3000. Override with SCREENSHARE_URL env var.
 */
const DEFAULT_URL = 'https://localhost:3000';
const RESOLVED_URL = process.env.SCREENSHARE_URL || DEFAULT_URL;

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
 * Forward an inbound screen-share:// URL to the renderer (if any).
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
  }
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
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }]
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
 */
function installCsp() {
  const base = RESOLVED_URL;
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
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [headerValue]
      }
    });
  });
}

async function createMainWindow() {
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

  win.once('ready-to-show', () => win.show());

  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
    // Typical for self-signed cert in dev; show a friendly note in console.
    // The user can proceed manually via the cert warning screen.
    // eslint-disable-next-line no-console
    console.warn(`[main] did-fail-load: ${errorCode} ${errorDescription} (${RESOLVED_URL})`);
  });

  // Open external links (target=_blank) in the OS browser, not a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  try {
    await win.loadURL(RESOLVED_URL);
  } catch (err) {
    // Common in dev: ERR_CERT_AUTHORITY_INVALID for the self-signed cert.
    // Chromium will surface the interstitial; the user clicks "Advanced → Proceed".
    // eslint-disable-next-line no-console
    console.warn(`[main] loadURL rejected (likely self-signed cert): ${err && err.message}`);
  }

  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
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
// Phase 3 — FFmpeg WASAPI / DirectShow loopback audio bridge.
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the ffmpeg executable, checking (in order):
 *   1. `SCREENSHARE_FFMPEG` env var (full path).
 *   2. Bundled binary: `<resourcesPath>/ffmpeg.exe` if packaged, or
 *      `<electronDir>/bin/ffmpeg.exe` in dev.
 *   3. System PATH via `where ffmpeg` (Windows) / `which ffmpeg` (other).
 *
 * Returns the resolved absolute path, or `null` if no ffmpeg is available.
 * The result is cached so we don't spawn `where` on every IPC call.
 *
 * @returns {string | null}
 */
let cachedFFmpegPath = undefined; // undefined = not-yet-resolved
function getFFmpegPath() {
  if (cachedFFmpegPath !== undefined) return cachedFFmpegPath;

  /** @type {string | null} */
  let resolved = null;

  // (1) Env var override.
  const envPath = process.env.SCREENSHARE_FFMPEG;
  if (envPath && fs.existsSync(envPath)) {
    resolved = path.resolve(envPath);
  }

  // (2) Bundled binary.
  if (!resolved) {
    try {
      const bundled = app.isPackaged
        ? path.join(process.resourcesPath, 'ffmpeg.exe')
        : path.join(__dirname, 'bin', 'ffmpeg.exe');
      if (fs.existsSync(bundled)) resolved = bundled;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[ffmpeg] bundle path check failed:', err);
    }
  }

  // (3) System PATH as last resort.
  if (!resolved) {
    try {
      const finder = process.platform === 'win32' ? 'where' : 'which';
      const result = spawnSync(finder, ['ffmpeg'], { windowsHide: true });
      if (result.status === 0) {
        const lines = (result.stdout?.toString('utf8') || '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        if (lines.length > 0 && fs.existsSync(lines[0])) {
          resolved = lines[0];
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[ffmpeg] PATH lookup failed:', err);
    }
  }

  if (resolved) {
    // eslint-disable-next-line no-console
    console.log(`[ffmpeg] resolved path: ${resolved}`);
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      '[ffmpeg] no ffmpeg.exe found (set SCREENSHARE_FFMPEG, bundle bin/ffmpeg.exe, or install system-wide). Audio capture will be unavailable.',
    );
  }

  cachedFFmpegPath = resolved;
  return resolved;
}

/**
 * Currently active FFmpegAudioCapture instance (one at a time per window).
 * @type {FFmpegAudioCapture | null}
 */
let currentCapture = null;

/**
 * IPC: list available DShow audio devices. Always returns a stable shape;
 * `{ audio: string[], video: string[], raw: string, ffmpegFound: boolean }`.
 */
ipcMain.handle('audio:listDevices', async () => {
  const ffmpegPath = getFFmpegPath();
  if (!ffmpegPath) {
    return { audio: [], video: [], raw: '', ffmpegFound: false };
  }
  try {
    const result = await listDirectShowAudioDevices({ ffmpegPath });
    return { ...result, ffmpegFound: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[main] audio:listDevices failed:', err);
    return { audio: [], video: [], raw: '', ffmpegFound: true };
  }
});

/**
 * IPC: start capturing system audio from the named device.
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

    const ffmpegPath = getFFmpegPath();
    if (!ffmpegPath) {
      return { ok: false, error: 'ffmpeg not found' };
    }
    if (process.platform !== 'win32') {
      return { ok: false, error: 'audio capture is Windows-only' };
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      return { ok: false, error: 'main window not available' };
    }

    /** @type {{ deviceName?: string, sampleRate?: number, channels?: number, format?: 'dshow'|'wasapi' }} */
    const opts =
      rawOpts && typeof rawOpts === 'object'
        ? /** @type {any} */ (rawOpts)
        : {};

    const deviceName = typeof opts.deviceName === 'string' ? opts.deviceName : '';
    const sampleRate = Math.floor(opts.sampleRate || 48000);
    const channels = Math.floor(opts.channels || 2);
    const format = opts.format === 'wasapi' ? 'wasapi' : 'dshow';

    const capture = new FFmpegAudioCapture({
      ffmpegPath,
      deviceName,
      sampleRate,
      channels,
      format,
      tryWasapiFallback: true,
    });

    // Forward chunks to the renderer. Float32Array is structured-cloneable so
    // we can ship it directly. If the window is destroyed mid-capture we just
    // stop forwarding.
    capture.on('chunk', (/** @type {Float32Array} */ chunk) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('audio:chunk', chunk);
      }
    });
    capture.on('warn', (/** @type {string} */ line) => {
      // eslint-disable-next-line no-console
      console.warn(`[ffmpeg] ${line}`);
    });
    capture.on('error', (/** @type {Error} */ err) => {
      // eslint-disable-next-line no-console
      console.error('[ffmpeg] capture error:', err.message);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('audio:error', { message: err.message });
      }
    });
    capture.on('exit', (code, signal) => {
      // eslint-disable-next-line no-console
      console.log(`[ffmpeg] process exited (code=${code} signal=${signal})`);
    });

    await capture.start();
    currentCapture = capture;
    return { ok: true, sampleRate, channels };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('[main] audio:start failed:', message);
    return { ok: false, error: message };
  }
});

/**
 * IPC: stop the current capture (if any).
 */
ipcMain.handle('audio:stop', async () => {
  try {
    if (currentCapture) {
      currentCapture.stop();
      currentCapture = null;
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
});

/**
 * Dev-only certificate bypass. When the app is NOT packaged we accept any
 * certificate served from `localhost` or `127.0.0.1` so that the self-signed
 * HTTPS dev server (`https://localhost:3000`) loads without the Chromium
 * interstitial. Packaged builds never install this hook, so they fall back to
 * Chromium's default verification — production deployments must use a cert
 * trusted by the user's OS (e.g. via mkcert + installed root CA, or a real CA).
 */
function installDevCertBypass() {
  if (app.isPackaged) {
    // Never bypass cert verification in production.
    return;
  }
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const { hostname } = request;
    if (
      typeof hostname === 'string' &&
      (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1')
    ) {
      // 0 === verification success in Chromium's CertVerifyResult enum.
      callback(0);
      return;
    }
    // For any other host, defer to Chromium's default validation.
    callback(-1);
  });
  // eslint-disable-next-line no-console
  console.log(
    '[main] dev cert bypass active for localhost/127.0.0.1 — packaged builds must use a trusted cert',
  );
}

// Pre-resolve ffmpeg path so we log the discovery (or warning) once at startup.
app.whenReady().then(async () => {
  installCsp();
  installDevCertBypass();
  registerProtocol();
  Menu.setApplicationMenu(buildMenu());
  getFFmpegPath(); // logs resolved path / warning
  await createMainWindow();
});

// Quit when all windows are closed, except on macOS. Also tear down any
// running FFmpeg capture so we don't leak orphaned subprocesses.
app.on('window-all-closed', () => {
  if (currentCapture) {
    try {
      currentCapture.stop();
    } catch {
      /* ignore */
    }
    currentCapture = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createMainWindow();
  }
});

// Export internals for debugging/tests (CommonJS).
module.exports = {
  parseScreenShareUrl,
  DEFAULT_URL,
  RESOLVED_URL,
  getFFmpegPath,
};
