/**
 * Signaling logic — pure, transport-agnostic.
 *
 * The SignalingHub holds all room state and decides *what* to send and to whom.
 * The actual delivery is delegated to a `Transport` implementation (the
 * WebSocket server in `index.ts`; a mock in tests).
 */

import { randomUUID } from 'node:crypto';
import { createRoomStore, type Participant, type Room, type RoomStore } from './rooms.js';
import type { ServerMessage as ServerMessageType } from './protocol.js';

/** Re-exported for callers that need to type outgoing messages. */
export type ServerMessage = ServerMessageType;
import type {
  ClientMessage,
  SdpPayload,
  IcePayload,
} from './protocol.js';

/** Minimal transport surface the hub needs. */
export interface Transport {
  /** Send a message to one participant (by socket ref). */
  send(socket: unknown, msg: ServerMessage): void;
  /** Disconnect a participant. */
  close(socket: unknown): void;
}

/** Mapping from a connected socket to its participant+room. */
interface Session {
  participantId: string;
  roomId: string;
  name: string;
}

export interface HubDeps {
  store?: RoomStore;
  /** Generates participant ids. Override in tests for determinism. */
  generateId?: () => string;
}

export class SignalingHub {
  private store: RoomStore;
  private generateId: () => string;
  /** socket → session */
  private sessions = new Map<unknown, Session>();
  /** participantId → socket */
  private sockets = new Map<string, unknown>();

  constructor(private transport: Transport, deps: HubDeps = {}) {
    this.store = deps.store ?? createRoomStore();
    this.generateId = deps.generateId ?? randomUUID;
  }

  /** Returns the room store (for inspection / tests). */
  getStore(): RoomStore {
    return this.store;
  }

  /**
   * Top-level entry: an incoming ClientMessage on a given socket.
   * Routes to the appropriate handler. Errors are caught and reported back.
   */
  handleRaw(socket: unknown, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.transport.send(socket, { type: 'error', payload: { message: 'Invalid JSON' } });
      return;
    }

    try {
      this.dispatch(socket, msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      this.transport.send(socket, { type: 'error', payload: { message } });
    }
  }

  /** Called by the transport when a socket closes. */
  handleClose(socket: unknown): void {
    const session = this.sessions.get(socket);
    if (!session) return;
    this.sessions.delete(socket);
    this.sockets.delete(session.participantId);

    const remaining = this.store.leave(session.roomId, session.participantId);
    if (remaining) {
      this.broadcastRoomState(remaining);
      this.send(remaining, { type: 'peer-left', payload: { id: session.participantId } });
    }
  }

  // ─── Dispatch ────────────────────────────────────────────────────────────

  private dispatch(socket: unknown, msg: ClientMessage): void {
    switch (msg.type) {
      case 'join':
        this.handleJoin(socket, msg);
        break;
      case 'offer':
      case 'answer':
      case 'ice':
        this.handleRelay(socket, msg);
        break;
      case 'transfer-host':
        this.handleTransferHost(socket, msg);
        break;
      case 'subscribe':
        this.handleSubscribe(socket);
        break;
      case 'unsubscribe':
        this.handleUnsubscribe(socket);
        break;
      case 'stream-start':
        this.handleStreamStart(socket, msg);
        break;
      case 'stream-stop':
        this.handleStreamStop(socket);
        break;
      case 'quality-change':
        this.handleQualityChange(socket, msg);
        break;
      default: {
        // exhaustiveness check
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  }

  // ─── Join ───────────────────────────────────────────────────────────────

  private handleJoin(socket: unknown, msg: { payload: { roomId: string; name: string } }): void {
    const { roomId, name } = msg.payload;
    if (!roomId?.trim() || !name?.trim()) {
      throw new Error('roomId and name are required');
    }

    const participantId = this.generateId();
    const participant: Participant = {
      id: participantId,
      name: name.trim().slice(0, 32),
      role: 'viewer',
      socket,
      streaming: false,
    };

    const room = this.store.join(roomId, participant);
    this.sessions.set(socket, { participantId, roomId, name: participant.name });
    this.sockets.set(participantId, socket);

    const isHost = room.hostId === participantId;
    const role = isHost ? (room.ownerId === participantId ? 'owner' : 'host') : 'viewer';

    this.transport.send(socket, {
      type: 'joined',
      payload: { selfId: participantId, roomId, role, isHost },
    });

    // Tell the *existing* participants about the newcomer (they initiate offers).
    const others = [...room.participants.values()].filter((p) => p.id !== participantId);
    for (const other of others) {
      this.transport.send(other.socket, {
        type: 'peer-joined',
        payload: { id: participantId, name: participant.name },
      });
    }

    // Send everyone the refreshed peer list (including the newcomer themselves).
    this.broadcastRoomState(room);
  }

  // ─── Relay (offer/answer/ICE) ────────────────────────────────────────────

  private handleRelay(
    socket: unknown,
    msg: { type: 'offer' | 'answer' | 'ice'; to: string; payload: unknown },
  ): void {
    const session = this.requireSession(socket);
    const targetSocket = this.sockets.get(msg.to);
    if (!targetSocket) {
      throw new Error(`Peer ${msg.to} not connected`);
    }
    // Ensure both peers are in the same room.
    const targetSession = this.sessions.get(targetSocket);
    if (!targetSession || targetSession.roomId !== session.roomId) {
      throw new Error(`Peer ${msg.to} is not in your room`);
    }

    const relayed: ServerMessage =
      msg.type === 'offer'
        ? { type: 'offer', from: session.participantId, payload: msg.payload as SdpPayload }
        : msg.type === 'answer'
          ? { type: 'answer', from: session.participantId, payload: msg.payload as SdpPayload }
          : { type: 'ice', from: session.participantId, payload: msg.payload as IcePayload };

    this.transport.send(targetSocket, relayed);
  }

  // ─── Host transfer ──────────────────────────────────────────────────────

  private handleTransferHost(
    socket: unknown,
    msg: { payload: { newHostId: string } },
  ): void {
    const session = this.requireSession(socket);
    const room = this.store.transferHost(session.roomId, session.participantId, msg.payload.newHostId);
    this.broadcastRoomState(room);
    this.send(room, { type: 'host-changed', payload: { hostId: room.hostId, ownerId: room.ownerId } });
  }

  // ─── Subscribe / unsubscribe ────────────────────────────────────────────

  private handleSubscribe(socket: unknown): void {
    const session = this.requireSession(socket);
    const room = this.store.subscribe(session.roomId, session.participantId);
    // Notify host that this viewer wants the video track.
    this.send(room, {
      type: 'subscribed',
      payload: { viewerId: session.participantId },
    });
    this.broadcastRoomState(room);
  }

  private handleUnsubscribe(socket: unknown): void {
    const session = this.requireSession(socket);
    const room = this.store.unsubscribe(session.roomId, session.participantId);
    if (!room) return;
    this.send(room, {
      type: 'unsubscribed',
      payload: { viewerId: session.participantId },
    });
    this.broadcastRoomState(room);
  }

  // ─── Stream lifecycle ──────────────────────────────────────────────────

  private handleStreamStart(
    socket: unknown,
    msg: { payload: { qualityPreset: string } },
  ): void {
    const session = this.requireSession(socket);
    const room = this.store.setStreaming(session.roomId, session.participantId, true, msg.payload.qualityPreset);
    this.broadcastRoomState(room);
    this.send(room, {
      type: 'stream-start',
      payload: { hostId: room.hostId, qualityPreset: msg.payload.qualityPreset },
    });
  }

  private handleStreamStop(socket: unknown): void {
    const session = this.requireSession(socket);
    const room = this.store.setStreaming(session.roomId, session.participantId, false);
    this.broadcastRoomState(room);
    this.send(room, {
      type: 'stream-stop',
      payload: { hostId: session.participantId },
    });
  }

  private handleQualityChange(
    socket: unknown,
    msg: { payload: { qualityPreset: string } },
  ): void {
    const session = this.requireSession(socket);
    // Only the host may change quality.
    const room = this.store.get(session.roomId);
    if (!room) throw new Error('Room not found');
    if (room.hostId !== session.participantId) {
      throw new Error('Only the host can change stream quality');
    }
    const host = room.participants.get(session.participantId)!;
    host.qualityPreset = msg.payload.qualityPreset;
    this.broadcastRoomState(room);
    this.send(room, {
      type: 'quality-change',
      payload: { hostId: session.participantId, qualityPreset: msg.payload.qualityPreset },
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private requireSession(socket: unknown): Session {
    const session = this.sessions.get(socket);
    if (!session) throw new Error('Not joined');
    return session;
  }

  /** Send to all participants in the room. */
  private send(room: Room, msg: ServerMessage): void {
    for (const p of room.participants.values()) {
      this.transport.send(p.socket, msg);
    }
  }

  /** Broadcast a refreshed peer-list snapshot to everyone in the room. */
  private broadcastRoomState(room: Room): void {
    const snap = this.store.snapshot(room.id);
    if (!snap) return;
    const message: ServerMessage = {
      type: 'peer-list',
      payload: {
        participants: snap.participants.map((p) => ({
          id: p.id,
          name: p.name,
          role: p.role,
        })),
        hostId: snap.hostId,
        ownerId: snap.ownerId,
        subscribers: snap.subscribers,
      },
    };
    this.send(room, message);
  }
}
