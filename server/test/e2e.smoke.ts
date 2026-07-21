/**
 * End-to-end smoke test for the real server.
 *
 * Boots the actual Fastify+ws server on a random port, opens two WebSocket
 * clients, performs the join handshake, and asserts they learn about each
 * other. This validates the full transport layer (not just the hub logic).
 *
 * Run with: `npm -w server run test:e2e`
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../src/index.js';
import type WebSocket from 'ws';

const PORT = 4817 + Math.floor(Math.random() * 1000);

const messages: Record<string, unknown[]> = { a: [], b: [] };

async function openClient(url: string, label: 'a' | 'b'): Promise<WebSocket> {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('message', (data) => {
    try {
      messages[label].push(JSON.parse(data.toString()));
    } catch {
      /* ignore */
    }
  });
  return ws;
}

function nextMessage(label: 'a' | 'b', predicate: (m: any) => boolean, timeoutMs = 1000): Promise<any> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const found = messages[label].find((m) => predicate(m as any));
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timeout waiting for message on client ${label}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('e2e server smoke', () => {
  let server: { close: () => Promise<void> };

  beforeAll(async () => {
    server = await createServer({ port: PORT, host: '127.0.0.1' });
  }, 10_000);

  afterAll(async () => {
    await server.close();
  });

  it('serves /health', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('joins two clients into one room and notifies them of each other', async () => {
    const url = `ws://127.0.0.1:${PORT}/ws`;
    const wsA = await openClient(url, 'a');
    const wsB = await openClient(url, 'b');

    // A joins first → becomes owner+host.
    wsA.send(JSON.stringify({ type: 'join', payload: { roomId: 'e2e-room', name: 'Alice' } }));
    const joinedA = await nextMessage('a', (m) => m.type === 'joined');
    expect(joinedA.payload.isHost).toBe(true);
    expect(joinedA.payload.role).toBe('owner');

    // B joins → A is notified of the newcomer.
    wsB.send(JSON.stringify({ type: 'join', payload: { roomId: 'e2e-room', name: 'Bob' } }));
    const joinedB = await nextMessage('b', (m) => m.type === 'joined');
    expect(joinedB.payload.role).toBe('viewer');

    const peerJoinedOnA = await nextMessage('a', (m) => m.type === 'peer-joined');
    expect(peerJoinedOnA.payload.name).toBe('Bob');

    // A sees both participants in the refreshed peer-list.
    const peerList = await nextMessage('a', (m) => m.type === 'peer-list' && m.payload.participants.length === 2);
    expect(peerList.payload.hostId).toBe(joinedA.payload.selfId);
    expect(peerList.payload.ownerId).toBe(joinedA.payload.selfId);

    wsA.close();
    wsB.close();
  }, 10_000);
});
