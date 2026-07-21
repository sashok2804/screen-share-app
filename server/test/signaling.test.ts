import { describe, it, expect, beforeEach } from 'vitest';
import { SignalingHub, type Transport, type ServerMessage } from '../src/signaling.js';
import type { ClientMessage } from '../src/protocol.js';

/** Mock transport: records every send() for assertions. */
class MockTransport implements Transport {
  sent: { socket: unknown; msg: ServerMessage }[] = [];
  send(socket: unknown, msg: ServerMessage): void {
    this.sent.push({ socket, msg });
  }
  close(_socket: unknown): void {}
}

/** Fake socket object with an id for readability. */
let socketCounter = 0;
function makeSocket(): { id: number; readyState: number } {
  return { id: ++socketCounter, readyState: 1 };
}

function sendJoin(hub: SignalingHub, socket: unknown, roomId: string, name: string): void {
  const msg: ClientMessage = { type: 'join', payload: { roomId, name } };
  hub.handleRaw(socket, JSON.stringify(msg));
}

function send(
  hub: SignalingHub,
  socket: unknown,
  msg: ClientMessage,
): void {
  hub.handleRaw(socket, JSON.stringify(msg));
}

describe('SignalingHub', () => {
  let transport: MockTransport;
  let hub: SignalingHub;
  let idCounter = 0;

  beforeEach(() => {
    transport = new MockTransport();
    idCounter = 0;
    hub = new SignalingHub(transport, { generateId: () => `p${++idCounter}` });
  });

  describe('join', () => {
    it('first joiner becomes owner+host and gets "joined" with isHost=true', () => {
      const s = makeSocket();
      sendJoin(hub, s, 'room-1', 'Alice');
      const joined = transport.sent.find((x) => x.msg.type === 'joined')!.msg;
      expect(joined).toEqual({
        type: 'joined',
        payload: { selfId: 'p1', roomId: 'room-1', role: 'owner', isHost: true },
      });
    });

    it('second joiner is viewer and triggers peer-joined to existing', () => {
      const s1 = makeSocket();
      const s2 = makeSocket();
      sendJoin(hub, s1, 'room-1', 'Alice');
      transport.sent.length = 0;
      sendJoin(hub, s2, 'room-1', 'Bob');

      const peerJoined = transport.sent.filter((x) => x.msg.type === 'peer-joined');
      expect(peerJoined.length).toBe(1);
      expect(peerJoined[0].socket).toBe(s1); // existing peer gets the notification
      expect(peerJoined[0].msg).toEqual({
        type: 'peer-joined',
        payload: { id: 'p2', name: 'Bob' },
      });
    });

    it('rejects empty roomId/name', () => {
      const s = makeSocket();
      sendJoin(hub, s, '', 'Alice');
      const err = transport.sent.find((x) => x.msg.type === 'error');
      expect(err).toBeDefined();
    });
  });

  describe('relay (offer/answer/ice)', () => {
    it('relays an offer from A to B', () => {
      const sA = makeSocket();
      const sB = makeSocket();
      sendJoin(hub, sA, 'room-1', 'Alice');
      sendJoin(hub, sB, 'room-1', 'Bob');
      transport.sent.length = 0;

      send(hub, sA, {
        type: 'offer',
        to: 'p2',
        payload: { type: 'offer', sdp: 'SDP-A' } as RTCSessionDescriptionInit,
      });

      const relayed = transport.sent.find((x) => x.socket === sB && x.msg.type === 'offer');
      expect(relayed).toBeDefined();
      expect(relayed!.msg).toEqual({
        type: 'offer',
        from: 'p1',
        payload: { type: 'offer', sdp: 'SDP-A' },
      });
    });

    it('refuses to relay to a peer in a different room', () => {
      const sA = makeSocket();
      const sB = makeSocket();
      sendJoin(hub, sA, 'room-1', 'Alice');
      sendJoin(hub, sB, 'room-2', 'Bob');
      transport.sent.length = 0;

      send(hub, sA, { type: 'offer', to: 'p2', payload: { type: 'offer', sdp: 'x' } });
      const err = transport.sent.find((x) => x.msg.type === 'error');
      expect(err).toBeDefined();
    });

    it('refuses relay before join', () => {
      const s = makeSocket();
      send(hub, s, { type: 'offer', to: 'p2', payload: { type: 'offer', sdp: 'x' } });
      const err = transport.sent.find((x) => x.msg.type === 'error');
      expect(err!.msg).toMatchObject({ type: 'error', payload: { message: 'Not joined' } });
    });
  });

  describe('transferHost', () => {
    it('owner can transfer host and broadcast host-changed', () => {
      const sA = makeSocket();
      const sB = makeSocket();
      sendJoin(hub, sA, 'room-1', 'Alice');
      sendJoin(hub, sB, 'room-1', 'Bob');
      transport.sent.length = 0;

      send(hub, sA, { type: 'transfer-host', payload: { newHostId: 'p2' } });

      const changed = transport.sent.filter((x) => x.msg.type === 'host-changed');
      expect(changed.length).toBe(2); // both peers
      expect(changed[0].msg).toEqual({
        type: 'host-changed',
        payload: { hostId: 'p2', ownerId: 'p1' },
      });
    });

    it('non-owner cannot transfer host', () => {
      const sA = makeSocket();
      const sB = makeSocket();
      sendJoin(hub, sA, 'room-1', 'Alice');
      sendJoin(hub, sB, 'room-1', 'Bob');
      transport.sent.length = 0;

      send(hub, sB, { type: 'transfer-host', payload: { newHostId: 'p1' } });
      const err = transport.sent.find((x) => x.msg.type === 'error');
      expect(err).toBeDefined();
    });
  });

  describe('stream lifecycle', () => {
    it('host can start a stream → stream-start broadcast', () => {
      const sA = makeSocket();
      sendJoin(hub, sA, 'room-1', 'Alice');
      transport.sent.length = 0;
      send(hub, sA, { type: 'stream-start', payload: { qualityPreset: 'ultra' } });

      const evt = transport.sent.find((x) => x.msg.type === 'stream-start');
      expect(evt!.msg).toEqual({
        type: 'stream-start',
        payload: { hostId: 'p1', qualityPreset: 'ultra' },
      });
    });

    it('viewer cannot start a stream', () => {
      const sA = makeSocket();
      const sB = makeSocket();
      sendJoin(hub, sA, 'room-1', 'Alice');
      sendJoin(hub, sB, 'room-1', 'Bob');
      transport.sent.length = 0;
      send(hub, sB, { type: 'stream-start', payload: { qualityPreset: 'ultra' } });

      const err = transport.sent.find((x) => x.msg.type === 'error');
      expect(err).toBeDefined();
    });

    it('host can stop a stream → stream-stop + subscribers cleared', () => {
      const sA = makeSocket();
      const sB = makeSocket();
      sendJoin(hub, sA, 'room-1', 'Alice');
      sendJoin(hub, sB, 'room-1', 'Bob');
      send(hub, sA, { type: 'stream-start', payload: { qualityPreset: 'ultra' } });
      send(hub, sB, { type: 'subscribe' });
      transport.sent.length = 0;

      send(hub, sA, { type: 'stream-stop' });

      const stop = transport.sent.find((x) => x.msg.type === 'stream-stop');
      expect(stop).toBeDefined();

      const peerList = transport.sent.find((x) => x.msg.type === 'peer-list')!.msg;
      if (peerList.type === 'peer-list') {
        expect(peerList.payload.subscribers).toEqual([]);
      }
    });

    it('quality-change is broadcast only from host', () => {
      const sA = makeSocket();
      const sB = makeSocket();
      sendJoin(hub, sA, 'room-1', 'Alice');
      sendJoin(hub, sB, 'room-1', 'Bob');
      transport.sent.length = 0;
      send(hub, sA, { type: 'quality-change', payload: { qualityPreset: 'high' } });
      const qc = transport.sent.filter((x) => x.msg.type === 'quality-change');
      expect(qc.length).toBe(2);

      transport.sent.length = 0;
      send(hub, sB, { type: 'quality-change', payload: { qualityPreset: 'low' } });
      expect(transport.sent.some((x) => x.msg.type === 'error')).toBe(true);
    });
  });

  describe('subscribe / unsubscribe', () => {
    it('subscribe sends a "subscribed" event to everyone', () => {
      const sA = makeSocket();
      const sB = makeSocket();
      sendJoin(hub, sA, 'room-1', 'Alice');
      sendJoin(hub, sB, 'room-1', 'Bob');
      transport.sent.length = 0;
      send(hub, sB, { type: 'subscribe' });
      const sub = transport.sent.filter((x) => x.msg.type === 'subscribed');
      expect(sub.length).toBe(2);
      expect(sub[0].msg).toEqual({ type: 'subscribed', payload: { viewerId: 'p2' } });
    });

    it('unsubscribe sends an "unsubscribed" event', () => {
      const sA = makeSocket();
      const sB = makeSocket();
      sendJoin(hub, sA, 'room-1', 'Alice');
      sendJoin(hub, sB, 'room-1', 'Bob');
      send(hub, sB, { type: 'subscribe' });
      transport.sent.length = 0;
      send(hub, sB, { type: 'unsubscribe' });
      const unsub = transport.sent.filter((x) => x.msg.type === 'unsubscribed');
      expect(unsub.length).toBe(2);
    });
  });

  describe('disconnect', () => {
    it('handleClose leaves the room and notifies remaining peers', () => {
      const sA = makeSocket();
      const sB = makeSocket();
      sendJoin(hub, sA, 'room-1', 'Alice');
      sendJoin(hub, sB, 'room-1', 'Bob');
      transport.sent.length = 0;

      hub.handleClose(sB);

      const left = transport.sent.find((x) => x.msg.type === 'peer-left');
      expect(left).toBeDefined();
      expect(left!.msg).toEqual({ type: 'peer-left', payload: { id: 'p2' } });
    });

    it('handleClose on last participant dissolves room silently', () => {
      const sA = makeSocket();
      sendJoin(hub, sA, 'room-1', 'Alice');
      transport.sent.length = 0;
      hub.handleClose(sA);
      expect(transport.sent.length).toBe(0);
      expect(hub.getStore().has('room-1')).toBe(false);
    });
  });

  describe('peer-list broadcast', () => {
    it('includes roles, hostId, ownerId, subscribers', () => {
      const sA = makeSocket();
      const sB = makeSocket();
      sendJoin(hub, sA, 'room-1', 'Alice');
      sendJoin(hub, sB, 'room-1', 'Bob');
      send(hub, sA, { type: 'stream-start', payload: { qualityPreset: 'ultra' } });
      send(hub, sB, { type: 'subscribe' });
      transport.sent.length = 0;
      // Trigger any broadcast by changing quality:
      send(hub, sA, { type: 'quality-change', payload: { qualityPreset: 'high' } });

      const list = transport.sent.find((x) => x.msg.type === 'peer-list')!.msg;
      if (list.type === 'peer-list') {
        expect(list.payload.hostId).toBe('p1');
        expect(list.payload.ownerId).toBe('p1');
        expect(list.payload.subscribers).toEqual(['p2']);
        const names = list.payload.participants.map((p) => p.name).sort();
        expect(names).toEqual(['Alice', 'Bob']);
      }
    });
  });

  describe('malformed input', () => {
    it('rejects invalid JSON', () => {
      const s = makeSocket();
      hub.handleRaw(s, 'not json');
      const err = transport.sent.find((x) => x.msg.type === 'error');
      expect(err!.msg).toMatchObject({ type: 'error', payload: { message: 'Invalid JSON' } });
    });
  });
});
