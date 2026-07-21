/**
 * Fastify HTTP/HTTPS server + WebSocket signaling endpoint.
 *
 * - GET /health → liveness probe
 * - GET /ws      → signaling WebSocket (upgraded from HTTP)
 * - production: serves the built client bundle from ../client/dist
 * - HTTPS: auto-enabled when server/certs/{cert,key}.pem exist OR when
 *   SSL_CERT_FILE / SSL_KEY_FILE env vars point at them.
 *   Browsers gate getDisplayMedia/getUserMedia behind "secure context", so
 *   HTTPS is REQUIRED for non-localhost access.
 */

import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, type WebSocket } from 'ws';
import { SignalingHub, type Transport, type ServerMessage } from './signaling.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Absolute path to a static client bundle (served at /). */
  staticDir?: string;
  /** When true, do not bind — used by tests. */
  mute?: boolean;
}

/** Resolve TLS cert/key files. Returns null if neither is configured. */
function resolveTls(): { cert: Buffer; key: Buffer } | null {
  const fromEnv = () => {
    const certFile = process.env.SSL_CERT_FILE;
    const keyFile = process.env.SSL_KEY_FILE;
    if (certFile && keyFile && fs.existsSync(certFile) && fs.existsSync(keyFile)) {
      return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
    }
    return null;
  };
  const fromDefault = () => {
    // Look in both server/certs/ (source layout) and server/dist/certs/
    // (bundled layout) so the same code works in dev (tsx) and prod.
    const candidates = [
      path.resolve(__dirname, '../certs/cert.pem'),
      path.resolve(__dirname, 'certs/cert.pem'),
    ];
    const certPath = candidates.find((p) => fs.existsSync(p));
    const keyPath = certPath?.replace('cert.pem', 'key.pem');
    if (certPath && keyPath && fs.existsSync(keyPath)) {
      return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
    }
    return null;
  };
  return fromEnv() ?? fromDefault();
}

export async function createServer(opts: ServerOptions = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';

  const tls = resolveTls();

  // We construct with the HTTPS-shape options when TLS is configured, then
  // normalise to the HTTP instance type — both expose the same surface we use.
  const app = (
    tls
      ? Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, https: { cert: tls.cert, key: tls.key } })
      : Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })
  ) as ReturnType<typeof Fastify>;

  // WebSocket-aware transport: each socket gets its own send queue.
  const wss = new WebSocketServer({ noServer: true });
  const transport: Transport = {
    send(socket: unknown, msg: ServerMessage): void {
      const ws = socket as { readyState: number; send: (data: string) => void } | undefined;
      if (!ws || ws.readyState !== 1 /* OPEN */) return;
      ws.send(JSON.stringify(msg));
    },
    close(socket: unknown): void {
      const ws = socket as { close: () => void } | undefined;
      ws?.close();
    },
  };

  const hub = new SignalingHub(transport);

  // Health probe (no auth, used by orchestrators).
  app.get('/health', async () => ({ status: 'ok', rooms: hub.getStore().list().length }));

  // Static client serving in production builds.
  const staticDir = opts.staticDir ?? path.resolve(__dirname, '../../client/dist');
  try {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
      decorateReply: false,
    });
    app.log.info({ staticDir }, 'serving static client');
  } catch (err) {
    app.log.warn({ err }, 'static plugin not registered (dev mode?)');
  }

  // HTTP → WebSocket upgrade.
  const server = app.server as import('node:http').Server;
  server.on('upgrade', (req: IncomingMessage, socket, head: Buffer) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      hub.handleRaw(ws, data.toString());
    });
    ws.on('close', () => {
      hub.handleClose(ws);
    });
    ws.on('error', () => {
      hub.handleClose(ws);
    });
  });

  if (!opts.mute) {
    await app.listen({ port, host });
    const scheme = tls ? 'https' : 'http';
    app.log.info(
      { url: `${scheme}://${host}:${port}`, tls: !!tls },
      'screen-share-app server listening',
    );
    if (!tls && host !== 'localhost' && host !== '127.0.0.1') {
      app.log.warn(
        'HTTPS disabled — getDisplayMedia/getUserMedia will be blocked on non-localhost clients. ' +
          'Drop cert.pem + key.pem into server/certs/ to enable TLS.',
      );
    }
  }

  return { app, hub, wss, close: async () => { wss.close(); await app.close(); } };
}

// Run when invoked directly (not imported by tests).
// On Windows `process.argv[1]` may be a relative/normalized path that does
// not equal `import.meta.url` verbatim, so we resolve via realpath.
let isMain = false;
try {
  const { realpathSync } = await import('node:fs');
  const argvPath = realpathSync(process.argv[1]);
  const modulePath = fileURLToPath(import.meta.url);
  isMain = realpathSync(modulePath) === argvPath;
} catch {
  isMain = false;
}

if (isMain) {
  createServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
