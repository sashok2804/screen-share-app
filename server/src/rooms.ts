/**
 * In-memory state for signaling rooms.
 *
 * Pure data + logic, no I/O. The signaling layer attaches a WebSocket
 * reference via the opaque `socket` field; this module never touches it
 * directly so it stays unit-testable.
 */

export type Role = 'owner' | 'host' | 'viewer';

export interface Participant {
  id: string;
  name: string;
  role: Role;
  /** Opaque transport handle (WebSocket on the server side). */
  socket: unknown;
  /** Whether the participant currently has an active screen stream. */
  streaming: boolean;
  /** Quality preset currently used by the stream (only meaningful for the host). */
  qualityPreset?: string;
}

export interface Room {
  id: string;
  ownerId: string;
  hostId: string;
  participants: Map<string, Participant>;
  /** ids of viewers who explicitly subscribed to the host's video track. */
  subscribers: Set<string>;
}

export interface RoomSnapshot {
  id: string;
  ownerId: string;
  hostId: string;
  participants: Array<Omit<Participant, 'socket'>>;
  subscribers: string[];
}

export class RoomStore {
  private rooms = new Map<string, Room>();

  /** Returns true if a room with the given id exists. */
  has(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  /** Creates an empty room. Throws if it already exists. */
  create(roomId: string): Room {
    if (this.rooms.has(roomId)) {
      throw new Error(`Room ${roomId} already exists`);
    }
    const room: Room = {
      id: roomId,
      ownerId: '',
      hostId: '',
      participants: new Map(),
      subscribers: new Set(),
    };
    this.rooms.set(roomId, room);
    return room;
  }

  /**
   * Adds a participant to a room. Creates the room on first join and marks
   * that participant as both owner and host (rule: первый зашедший = owner+host).
   */
  join(roomId: string, participant: Participant): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = this.create(roomId);
    }

    if (room.participants.has(participant.id)) {
      throw new Error(`Participant ${participant.id} already in room ${roomId}`);
    }

    const isFirst = room.participants.size === 0;
    room.participants.set(participant.id, participant);

    if (isFirst) {
      room.ownerId = participant.id;
      room.hostId = participant.id;
      participant.role = 'owner';
    }

    return room;
  }

  /** Removes a participant. Returns the resulting room state (or null if room dissolved). */
  leave(roomId: string, participantId: string): Room | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const existed = room.participants.delete(participantId);
    room.subscribers.delete(participantId);

    if (room.participants.size === 0) {
      this.rooms.delete(roomId);
      return null;
    }

    if (existed) {
      // Promote oldest remaining participant to owner if the owner left.
      if (room.ownerId === participantId) {
        const nextOwner = this.firstParticipantId(room);
        if (nextOwner) {
          room.ownerId = nextOwner;
          const newOwner = room.participants.get(nextOwner)!;
          newOwner.role = newOwner.role === 'host' ? 'owner' : 'owner';
        }
      }

      // Promote oldest remaining participant to host if the host left.
      if (room.hostId === participantId) {
        const nextHost = this.firstParticipantId(room);
        if (nextHost) {
          room.hostId = nextHost;
          // If they were the owner they keep the owner role (owner == host+founder).
          const next = room.participants.get(nextHost)!;
          if (room.ownerId !== nextHost) {
            next.role = 'host';
          } else {
            next.role = 'owner';
          }
        }
      }
    }

    return room;
  }

  /**
   * Transfers host role. Only the current owner may call this.
   * Returns the updated room or throws on permission / unknown target.
   */
  transferHost(roomId: string, fromOwnerId: string, newHostId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);
    if (room.ownerId !== fromOwnerId) {
      throw new Error('Only the owner can transfer host');
    }
    if (!room.participants.has(newHostId)) {
      throw new Error(`Target participant ${newHostId} not in room`);
    }
    if (room.hostId === newHostId) {
      return room; // no-op
    }

    // Old host demotes to viewer (unless they are also the owner).
    const oldHost = room.participants.get(room.hostId);
    if (oldHost && room.hostId !== room.ownerId) {
      oldHost.role = 'viewer';
    }

    room.hostId = newHostId;
    const newHost = room.participants.get(newHostId)!;
    newHost.role = room.ownerId === newHostId ? 'owner' : 'host';

    return room;
  }

  /** Adds a subscriber for the host video track. */
  subscribe(roomId: string, viewerId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);
    if (!room.participants.has(viewerId)) {
      throw new Error(`Participant ${viewerId} not in room`);
    }
    room.subscribers.add(viewerId);
    return room;
  }

  /** Removes a viewer subscription. Returns undefined if the room does not exist. */
  unsubscribe(roomId: string, viewerId: string): Room | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    room.subscribers.delete(viewerId);
    return room;
  }

  /** Marks host as streaming (or stops stream). Only affects host's `streaming` flag. */
  setStreaming(roomId: string, participantId: string, streaming: boolean, qualityPreset?: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);
    const p = room.participants.get(participantId);
    if (!p) throw new Error(`Participant ${participantId} not in room`);
    if (streaming && room.hostId !== participantId) {
      throw new Error('Only the host can start a screen stream');
    }
    p.streaming = streaming;
    if (streaming) {
      p.qualityPreset = qualityPreset;
    } else {
      p.qualityPreset = undefined;
      // When stream stops, all subscribers are cleared (no track to consume).
      room.subscribers.clear();
    }
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  list(): Room[] {
    return [...this.rooms.values()];
  }

  /** Returns a JSON-safe snapshot (strips WebSocket references). */
  snapshot(roomId: string): RoomSnapshot | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return {
      id: room.id,
      ownerId: room.ownerId,
      hostId: room.hostId,
      participants: [...room.participants.values()].map(({ socket: _socket, ...rest }) => rest),
      subscribers: [...room.subscribers],
    };
  }

  private firstParticipantId(room: Room): string | null {
    for (const id of room.participants.keys()) return id;
    return null;
  }
}

/** Factory used by the signaling layer. */
export function createRoomStore(): RoomStore {
  return new RoomStore();
}
