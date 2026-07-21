import { describe, it, expect, beforeEach } from 'vitest';
import { RoomStore, createRoomStore, type Participant } from '../src/rooms.js';

function makeParticipant(id: string, name = id, role: Participant['role'] = 'viewer'): Participant {
  return { id, name, role, socket: {}, streaming: false };
}

describe('RoomStore', () => {
  let store: RoomStore;

  beforeEach(() => {
    store = createRoomStore();
  });

  describe('create / has', () => {
    it('creates an empty room', () => {
      store.create('room-1');
      expect(store.has('room-1')).toBe(true);
    });

    it('throws if room already exists', () => {
      store.create('room-1');
      expect(() => store.create('room-1')).toThrow(/already exists/);
    });
  });

  describe('join', () => {
    it('first participant becomes owner AND host', () => {
      const room = store.join('room-1', makeParticipant('a', 'Alice'));
      expect(room.ownerId).toBe('a');
      expect(room.hostId).toBe('a');
      expect(room.participants.get('a')!.role).toBe('owner');
    });

    it('second participant is a viewer', () => {
      store.join('room-1', makeParticipant('a', 'Alice'));
      store.join('room-1', makeParticipant('b', 'Bob'));
      const b = store.get('room-1')!.participants.get('b')!;
      expect(b.role).toBe('viewer');
    });

    it('throws on duplicate join (same id)', () => {
      store.join('room-1', makeParticipant('a'));
      expect(() => store.join('room-1', makeParticipant('a'))).toThrow(/already in room/);
    });

    it('creates the room on first join if it does not exist', () => {
      expect(store.has('room-1')).toBe(false);
      store.join('room-1', makeParticipant('a'));
      expect(store.has('room-1')).toBe(true);
    });
  });

  describe('leave', () => {
    it('removes the participant', () => {
      store.join('room-1', makeParticipant('a'));
      store.join('room-1', makeParticipant('b'));
      store.leave('room-1', 'b');
      expect(store.get('room-1')!.participants.has('b')).toBe(false);
    });

    it('dissolves the room when the last participant leaves', () => {
      store.join('room-1', makeParticipant('a'));
      store.leave('room-1', 'a');
      expect(store.has('room-1')).toBe(false);
      expect(store.get('room-1')).toBeUndefined();
    });

    it('promotes next participant to owner when owner leaves', () => {
      store.join('room-1', makeParticipant('a', 'Alice', 'owner'));
      store.join('room-1', makeParticipant('b', 'Bob'));
      store.leave('room-1', 'a');
      const room = store.get('room-1')!;
      expect(room.ownerId).toBe('b');
      expect(room.participants.get('b')!.role).toBe('owner');
    });

    it('promotes next participant to host when host leaves (and is not owner)', () => {
      store.join('room-1', makeParticipant('a', 'Alice')); // owner + host
      store.join('room-1', makeParticipant('b', 'Bob'));
      store.transferHost('room-1', 'a', 'b'); // b becomes host, a still owner
      store.leave('room-1', 'b'); // b leaves → next host should be a again
      const room = store.get('room-1')!;
      expect(room.hostId).toBe('a');
      expect(room.participants.get('a')!.role).toBe('owner');
    });

    it('cleans up subscriber set on leave', () => {
      store.join('room-1', makeParticipant('a'));
      store.join('room-1', makeParticipant('b'));
      store.setStreaming('room-1', 'a', true, 'ultra');
      store.subscribe('room-1', 'b');
      store.leave('room-1', 'b');
      expect(store.get('room-1')!.subscribers.has('b')).toBe(false);
    });

    it('returns null for non-existent room', () => {
      expect(store.leave('nope', 'x')).toBeNull();
    });
  });

  describe('transferHost', () => {
    it('transfers host from owner to another participant', () => {
      store.join('room-1', makeParticipant('a', 'Alice'));
      store.join('room-1', makeParticipant('b', 'Bob'));
      store.join('room-1', makeParticipant('c', 'Carol'));

      store.transferHost('room-1', 'a', 'b');
      const room = store.get('room-1')!;
      expect(room.hostId).toBe('b');
      expect(room.participants.get('b')!.role).toBe('host');
      // Old host (a) is still owner.
      expect(room.participants.get('a')!.role).toBe('owner');
    });

    it('throws if caller is not the owner', () => {
      store.join('room-1', makeParticipant('a'));
      store.join('room-1', makeParticipant('b'));
      expect(() => store.transferHost('room-1', 'b', 'a')).toThrow(/Only the owner/);
    });

    it('throws if target participant is not in room', () => {
      store.join('room-1', makeParticipant('a'));
      expect(() => store.transferHost('room-1', 'a', 'ghost')).toThrow(/not in room/);
    });

    it('is a no-op if target is already host', () => {
      store.join('room-1', makeParticipant('a'));
      const room = store.transferHost('room-1', 'a', 'a');
      expect(room.hostId).toBe('a');
    });

    it('demotes the old host to viewer when transferring', () => {
      store.join('room-1', makeParticipant('a')); // owner + host
      store.join('room-1', makeParticipant('b'));
      store.join('room-1', makeParticipant('c'));
      store.transferHost('room-1', 'a', 'b'); // b = host
      store.transferHost('room-1', 'a', 'c'); // c = host, b should demote
      const room = store.get('room-1')!;
      expect(room.participants.get('b')!.role).toBe('viewer');
      expect(room.participants.get('c')!.role).toBe('host');
    });
  });

  describe('subscribe / unsubscribe', () => {
    it('adds a subscriber', () => {
      store.join('room-1', makeParticipant('a'));
      store.join('room-1', makeParticipant('b'));
      store.subscribe('room-1', 'b');
      expect(store.get('room-1')!.subscribers.has('b')).toBe(true);
    });

    it('throws if subscriber not in room', () => {
      store.join('room-1', makeParticipant('a'));
      expect(() => store.subscribe('room-1', 'ghost')).toThrow(/not in room/);
    });

    it('unsubscribe is safe on non-subscriber', () => {
      store.join('room-1', makeParticipant('a'));
      store.join('room-1', makeParticipant('b'));
      expect(() => store.unsubscribe('room-1', 'b')).not.toThrow();
    });
  });

  describe('setStreaming', () => {
    it('marks host as streaming with a quality preset', () => {
      store.join('room-1', makeParticipant('a'));
      store.setStreaming('room-1', 'a', true, 'ultra');
      const p = store.get('room-1')!.participants.get('a')!;
      expect(p.streaming).toBe(true);
      expect(p.qualityPreset).toBe('ultra');
    });

    it('clears subscribers when stream stops', () => {
      store.join('room-1', makeParticipant('a'));
      store.join('room-1', makeParticipant('b'));
      store.setStreaming('room-1', 'a', true, 'ultra');
      store.subscribe('room-1', 'b');
      store.setStreaming('room-1', 'a', false);
      expect(store.get('room-1')!.subscribers.size).toBe(0);
      expect(store.get('room-1')!.participants.get('a')!.qualityPreset).toBeUndefined();
    });

    it('forbids non-host from starting stream', () => {
      store.join('room-1', makeParticipant('a'));
      store.join('room-1', makeParticipant('b'));
      expect(() => store.setStreaming('room-1', 'b', true, 'ultra')).toThrow(/Only the host/);
    });

    it('allows non-host to flip streaming=false (defensive cleanup)', () => {
      store.join('room-1', makeParticipant('a'));
      store.join('room-1', makeParticipant('b'));
      expect(() => store.setStreaming('room-1', 'b', false)).not.toThrow();
    });
  });

  describe('snapshot', () => {
    it('strips socket references', () => {
      store.join('room-1', { ...makeParticipant('a'), socket: { secret: 'leak' } });
      const snap = store.snapshot('room-1')!;
      expect(snap.participants[0]).not.toHaveProperty('socket');
    });

    it('returns null for missing room', () => {
      expect(store.snapshot('nope')).toBeNull();
    });
  });

  describe('list', () => {
    it('returns all rooms', () => {
      store.join('room-1', makeParticipant('a'));
      store.join('room-2', makeParticipant('b'));
      expect(store.list().map((r) => r.id).sort()).toEqual(['room-1', 'room-2']);
    });
  });
});
