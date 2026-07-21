import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ClientMessage, ServerMessage } from '@screenshare/server/protocol';
import type { UseSignalingResult } from './useSignaling';

export interface Participant {
  id: string;
  name: string;
  role: 'owner' | 'host' | 'viewer';
}

export interface RoomState {
  selfId: string | null;
  roomId: string | null;
  role: 'owner' | 'host' | 'viewer';
  isHost: boolean;
  isOwner: boolean;
  participants: Participant[];
  hostId: string | null;
  ownerId: string | null;
  subscribers: string[];
  /** Whether the host is currently streaming. */
  hostStreaming: boolean;
  /** Active stream quality preset (set by host). */
  streamQuality: string | null;
  /** Whether *we* are subscribed to the host's video. */
  subscribed: boolean;
}

export interface UseRoomResult extends RoomState {
  join: (roomId: string, name: string) => void;
  leave: () => void;
  transferHost: (newHostId: string) => void;
  subscribeToStream: () => void;
  unsubscribeFromStream: () => void;
  notifyStreamStart: (qualityPreset: string) => void;
  notifyStreamStop: () => void;
  notifyQualityChange: (qualityPreset: string) => void;
}

const INITIAL_STATE: RoomState = {
  selfId: null,
  roomId: null,
  role: 'viewer',
  isHost: false,
  isOwner: false,
  participants: [],
  hostId: null,
  ownerId: null,
  subscribers: [],
  hostStreaming: false,
  streamQuality: null,
  subscribed: false,
};

/**
 * Room state machine: maps incoming server messages to a cohesive view of the
 * room and exposes outgoing actions that wrap the raw signaling `send`.
 */
export function useRoom(signaling: UseSignalingResult): UseRoomResult {
  const { status, send, onMessage } = signaling;
  const [state, setState] = useState<RoomState>(INITIAL_STATE);

  // Subscribe once.
  useEffect(() => {
    const unsubscribe = onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case 'joined':
          setState((s) => ({
            ...s,
            selfId: msg.payload.selfId,
            roomId: msg.payload.roomId,
            role: msg.payload.role,
            isHost: msg.payload.isHost,
            isOwner: msg.payload.role === 'owner',
          }));
          break;
        case 'peer-list':
          setState((s) => {
            const me = msg.payload.participants.find(
              (p: { id: string; name: string; role: 'owner' | 'host' | 'viewer' }) =>
                p.id === s.selfId,
            );
            return {
              ...s,
              participants: msg.payload.participants,
              hostId: msg.payload.hostId,
              ownerId: msg.payload.ownerId,
              subscribers: msg.payload.subscribers,
              isHost: msg.payload.hostId === s.selfId,
              isOwner: msg.payload.ownerId === s.selfId,
              role: me?.role ?? s.role,
              subscribed: s.selfId ? msg.payload.subscribers.includes(s.selfId) : false,
            };
          });
          break;
        case 'peer-left':
          setState((s) => ({
            ...s,
            participants: s.participants.filter((p) => p.id !== msg.payload.id),
            subscribers: s.subscribers.filter((id) => id !== msg.payload.id),
          }));
          break;
        case 'host-changed':
          setState((s) => ({
            ...s,
            hostId: msg.payload.hostId,
            ownerId: msg.payload.ownerId,
            isHost: msg.payload.hostId === s.selfId,
            isOwner: msg.payload.ownerId === s.selfId,
          }));
          break;
        case 'stream-start':
          setState((s) => ({
            ...s,
            hostStreaming: true,
            streamQuality: msg.payload.qualityPreset,
          }));
          break;
        case 'stream-stop':
          setState((s) => ({
            ...s,
            hostStreaming: false,
            streamQuality: null,
            subscribed: false,
          }));
          break;
        case 'quality-change':
          setState((s) => ({ ...s, streamQuality: msg.payload.qualityPreset }));
          break;
        default:
          // peer-joined, subscribed, unsubscribed, offer/answer/ice, error
          // are consumed by other hooks or handled via peer-list refresh.
          break;
      }
    });
    return unsubscribe;
  }, [onMessage]);

  // Auto-join once the socket is open and we have credentials queued.
  const [pendingJoin, setPendingJoin] = useState<{ roomId: string; name: string } | null>(null);
  useEffect(() => {
    if (status === 'open' && pendingJoin) {
      const msg: ClientMessage = {
        type: 'join',
        payload: { roomId: pendingJoin.roomId, name: pendingJoin.name },
      };
      send(msg);
      setPendingJoin(null);
    }
  }, [status, pendingJoin, send]);

  const join = useCallback((roomId: string, name: string) => {
    setPendingJoin({ roomId, name });
  }, []);

  const leave = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  const transferHost = useCallback(
    (newHostId: string) => {
      const msg: ClientMessage = { type: 'transfer-host', payload: { newHostId } };
      send(msg);
    },
    [send],
  );

  const subscribeToStream = useCallback(() => {
    const msg: ClientMessage = { type: 'subscribe' };
    send(msg);
  }, [send]);

  const unsubscribeFromStream = useCallback(() => {
    const msg: ClientMessage = { type: 'unsubscribe' };
    send(msg);
  }, [send]);

  const notifyStreamStart = useCallback(
    (qualityPreset: string) => {
      const msg: ClientMessage = { type: 'stream-start', payload: { qualityPreset } };
      send(msg);
    },
    [send],
  );

  const notifyStreamStop = useCallback(() => {
    const msg: ClientMessage = { type: 'stream-stop' };
    send(msg);
  }, [send]);

  const notifyQualityChange = useCallback(
    (qualityPreset: string) => {
      const msg: ClientMessage = { type: 'quality-change', payload: { qualityPreset } };
      send(msg);
    },
    [send],
  );

  return useMemo(
    () => ({
      ...state,
      join,
      leave,
      transferHost,
      subscribeToStream,
      unsubscribeFromStream,
      notifyStreamStart,
      notifyStreamStop,
      notifyQualityChange,
    }),
    [
      state,
      join,
      leave,
      transferHost,
      subscribeToStream,
      unsubscribeFromStream,
      notifyStreamStart,
      notifyStreamStop,
      notifyQualityChange,
    ],
  );
}
