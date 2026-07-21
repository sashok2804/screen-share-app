/**
 * Wire protocol shared between server and client.
 *
 * Every message has a `type`. Client→server messages may carry `payload`.
 * Server→client messages may carry `from` (sender participant id) and
 * broadcast metadata.
 *
 * NOTE: RTCSessionDescriptionInit / RTCIceCandidateInit are DOM types. To keep
 * this file isomorphic (server has no DOM), we declare minimal structural
 * types that are assignment-compatible with the WebRTC SDK on the client.
 */

/** Minimal structural alias for RTCSessionDescriptionInit. */
export interface SdpPayload {
  type?: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

/** Minimal structural alias for RTCIceCandidateInit. */
export interface IcePayload {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

// ─── Client → Server ────────────────────────────────────────────────────────

export interface JoinMessage {
  type: 'join';
  payload: { roomId: string; name: string };
}

export interface OfferMessage {
  type: 'offer';
  to: string;
  payload: SdpPayload;
}

export interface AnswerMessage {
  type: 'answer';
  to: string;
  payload: SdpPayload;
}

export interface IceCandidateMessage {
  type: 'ice';
  to: string;
  payload: IcePayload;
}

export interface TransferHostMessage {
  type: 'transfer-host';
  payload: { newHostId: string };
}

export interface SubscribeMessage {
  type: 'subscribe';
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
}

export interface StreamStartMessage {
  type: 'stream-start';
  payload: { qualityPreset: string };
}

export interface StreamStopMessage {
  type: 'stream-stop';
}

export interface QualityChangeMessage {
  type: 'quality-change';
  payload: { qualityPreset: string };
}

export type ClientMessage =
  | JoinMessage
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | TransferHostMessage
  | SubscribeMessage
  | UnsubscribeMessage
  | StreamStartMessage
  | StreamStopMessage
  | QualityChangeMessage;

// ─── Server → Client ────────────────────────────────────────────────────────

export interface JoinedMessage {
  type: 'joined';
  payload: {
    selfId: string;
    roomId: string;
    role: 'owner' | 'host' | 'viewer';
    isHost: boolean;
  };
}

export interface PeerListMessage {
  type: 'peer-list';
  payload: {
    participants: Array<{ id: string; name: string; role: 'owner' | 'host' | 'viewer' }>;
    hostId: string;
    ownerId: string;
    subscribers: string[];
  };
}

/** "Someone joined after you — initiate the handshake as the existing peer." */
export interface PeerJoinedMessage {
  type: 'peer-joined';
  payload: { id: string; name: string };
}

export interface PeerLeftMessage {
  type: 'peer-left';
  payload: { id: string };
}

/** Relay of an offer/answer/ICE from another peer. */
export interface RelayOfferMessage {
  type: 'offer';
  from: string;
  payload: SdpPayload;
}

export interface RelayAnswerMessage {
  type: 'answer';
  from: string;
  payload: SdpPayload;
}

export interface RelayIceMessage {
  type: 'ice';
  from: string;
  payload: IcePayload;
}

export interface HostChangedMessage {
  type: 'host-changed';
  payload: { hostId: string; ownerId: string };
}

export interface StreamStartEvent {
  type: 'stream-start';
  payload: { hostId: string; qualityPreset: string };
}

export interface StreamStopEvent {
  type: 'stream-stop';
  payload: { hostId: string };
}

export interface QualityChangeEvent {
  type: 'quality-change';
  payload: { hostId: string; qualityPreset: string };
}

export interface SubscribedEvent {
  type: 'subscribed';
  payload: { viewerId: string };
}

export interface UnsubscribedEvent {
  type: 'unsubscribed';
  payload: { viewerId: string };
}

export interface ErrorMessage {
  type: 'error';
  payload: { message: string };
}

export type ServerMessage =
  | JoinedMessage
  | PeerListMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | RelayOfferMessage
  | RelayAnswerMessage
  | RelayIceMessage
  | HostChangedMessage
  | StreamStartEvent
  | StreamStopEvent
  | QualityChangeEvent
  | SubscribedEvent
  | UnsubscribedEvent
  | ErrorMessage;

/** Type guard helper: narrow an unknown incoming message to a ClientMessage. */
export function isClientMessage(msg: unknown): msg is ClientMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const t = (msg as { type?: unknown }).type;
  return (
    typeof t === 'string' &&
    [
      'join',
      'offer',
      'answer',
      'ice',
      'transfer-host',
      'subscribe',
      'unsubscribe',
      'stream-start',
      'stream-stop',
      'quality-change',
    ].includes(t)
  );
}
