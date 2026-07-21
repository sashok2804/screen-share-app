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
 * Phase 2/3 will add: desktopCapturer source picker, FFmpeg subprocess for WASAPI loopback capture.
 */

'use strict';

const { app, BrowserWindow, session, Menu, shell, ipcMain } = require('electron');

const path = require('path');

/**
 * Default URL of the React client. In dev this is the Vite dev server proxied through
 * the Fastify HTTPS server on :3000. Override with SCREENSHARE_URL env var.
 */
const DEFAULT_URL = 'https://localhost:3000';
const RESOLVED_URL = process.env.SCREENSARE_URL || DEFAULT_URL;

const isDev = process.env.NODE_ENV !== 'production';

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

app.whenReady().then(async () => {
  installCsp();
  registerProtocol();
  Menu.setApplicationMenu(buildMenu());
  await createMainWindow();
});

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
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
  RESOLVED_URL
};
