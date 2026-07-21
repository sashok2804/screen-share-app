import { useCallback, useEffect, useRef } from 'react';
import type { ClientMessage, ServerMessage, SdpPayload } from '@screenshare/server/protocol';
import type { UseSignalingResult } from './useSignaling';
import { defaultIceServers } from '../lib/rtc';

/**
 * Mesh connection manager.
 *
 * Maintains one RTCPeerConnection per remote peer. Each PC carries:
 *  - bidirectional audio (always);
 *  - a video transceiver whose direction is determined by host/subscribe state.
 *
 * Negotiation pattern: the *existing* peer (lower join time) is the initiator
 * ("polite"), the newcomer is the *impolite* answerer. This avoids glare.
 * The server tells us about newcomers via `peer-joined`, so the existing peer
 * creates the offer.
 */

export interface MeshCallbacks {
  /** Called when a new audio/video track arrives from a remote peer. */
  onTrack?: (peerId: string, track: MediaStreamTrack, kind: 'audio' | 'video') => void;
  /** Called when a remote track is removed (peer re-negotiated or closed). */
  onTrackRemoved?: (peerId: string, track: MediaStreamTrack) => void;
  /** Local tracks the mesh should publish to every peer. */
  getLocalTracks?: () => { audio?: MediaStreamTrack; video?: MediaStreamTrack };
  /** Whether we are the host (i.e. our video should be sendonly). */
  isHost: () => boolean;
  /** Whether the local peer is currently subscribed to the host video. */
  isSubscribed: () => boolean;
  /** Whether a given remote peer is the current host. */
  isRemoteHost: (peerId: string) => boolean;
}

interface PeerEntry {
  pc: RTCPeerConnection;
  /** "polite" = we yield during glare; "impolite" = we win. */
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
}

function isPolite(localId: string | null, remoteId: string): boolean {
  // Existing peer (smaller join index) creates the offer → that's us when our
  // id is "less than" the remote's. We use lexicographic comparison as a
  // deterministic proxy for arrival order (ids are server-assigned UUIDs).
  return localId != null && localId < remoteId;
}

export interface UseMeshResult {
  /** Adds a local audio track (mic) and publishes it to all peers. */
  publishAudio: (track: MediaStreamTrack) => void;
  /** Removes the local audio track from all peers. */
  unpublishAudio: () => void;
  /** Adds a local video track (screen) and publishes it to all peers. */
  publishVideo: (track: MediaStreamTrack) => void;
  /** Removes the local video track from all peers. */
  unpublishVideo: () => void;
  /** Close and discard all peer connections (call on leave). */
  closeAll: () => void;
  /**
   * Apply a side-effecting function to every RTCRtpSender carrying the given
   * track across all peer connections. Used to set codec preferences / bitrate
   * after publishing.
   */
  forEachSender: (track: MediaStreamTrack, fn: (sender: RTCRtpSender) => void) => void;
  /**
   * Apply a side-effecting function to every RTCRtpTransceiver carrying the
   * given track kind across all peer connections.
   */
  forEachVideoTransceiver: (fn: (transceiver: RTCRTransceiverLike) => void) => void;
}

/** Minimal structural type so tests can mock without a full RTCPeerConnection. */
export interface RTCRTransceiverLike {
  readonly sender: { track: MediaStreamTrack | null };
  readonly receiver: { track: MediaStreamTrack | null };
  direction: 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';
  setCodecPreferences(codecs: Array<{ mimeType: string }>): void;
}

export function useMesh(
  signaling: UseSignalingResult,
  getLocalId: () => string | null,
  callbacks: React.MutableRefObject<MeshCallbacks>,
): UseMeshResult {
  const { send, onMessage } = signaling;
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const localAudioRef = useRef<MediaStreamTrack | null>(null);
  const localVideoRef = useRef<MediaStreamTrack | null>(null);

  const ensurePeer = useCallback(
    (peerId: string): PeerEntry => {
      const existing = peersRef.current.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: defaultIceServers() });
      const entry: PeerEntry = {
        pc,
        polite: isPolite(getLocalId(), peerId),
        makingOffer: false,
        ignoreOffer: false,
      };
      peersRef.current.set(peerId, entry);

      pc.ontrack = (event) => {
        const track = event.track;
        callbacks.current.onTrack?.(peerId, track, track.kind === 'video' ? 'video' : 'audio');
        track.onended = () => {
          callbacks.current.onTrackRemoved?.(peerId, track);
        };
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          const msg: ClientMessage = {
            type: 'ice',
            to: peerId,
            payload: event.candidate.toJSON(),
          };
          send(msg);
        }
      };

      pc.onnegotiationneeded = async () => {
        try {
          entry.makingOffer = true;
          await pc.setLocalDescription();
          const msg: ClientMessage = {
            type: 'offer',
            to: peerId,
            payload: pc.localDescription!,
          };
          send(msg);
        } catch (err) {
          console.error('[mesh] negotiationneeded failed', err);
        } finally {
          entry.makingOffer = false;
        }
      };

      // Add existing local tracks to the new PC.
      if (localAudioRef.current) {
        pc.addTrack(localAudioRef.current);
      }
      // Video only goes out from the host.
      if (localVideoRef.current && callbacks.current.isHost()) {
        pc.addTransceiver(localVideoRef.current, { direction: 'sendonly' });
      } else {
        // Ensure we have a recvonly video transceiver if we're subscribed.
        if (callbacks.current.isSubscribed() && callbacks.current.isRemoteHost(peerId)) {
          pc.addTransceiver('video', { direction: 'recvonly' });
        }
      }

      return entry;
    },
    [send, getLocalId, callbacks],
  );

  // Remove a peer entry and fire onTrackRemoved for each track.
  const removePeer = useCallback(
    (peerId: string) => {
      const entry = peersRef.current.get(peerId);
      if (!entry) return;
      const senders = entry.pc.getSenders();
      for (const s of senders) {
        if (s.track) callbacks.current.onTrackRemoved?.(peerId, s.track);
      }
      const receivers = entry.pc.getReceivers();
      for (const r of receivers) {
        if (r.track) callbacks.current.onTrackRemoved?.(peerId, r.track);
      }
      entry.pc.close();
      peersRef.current.delete(peerId);
    },
    [callbacks],
  );

  // Handle incoming signaling.
  useEffect(() => {
    const unsubscribe = onMessage(async (msg: ServerMessage) => {
      if (msg.type === 'peer-joined') {
        ensurePeer(msg.payload.id);
        return;
      }
      if (msg.type === 'peer-left') {
        removePeer(msg.payload.id);
        return;
      }
      if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice') {
        const entry = ensurePeer(msg.from);
        const pc = entry.pc;
        try {
          if (msg.type === 'offer') {
            const offerCollision = entry.makingOffer || pc.signalingState !== 'stable';
            entry.ignoreOffer = !entry.polite && offerCollision;
            if (entry.ignoreOffer) return;
            await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
            await pc.setLocalDescription();
            const reply: ClientMessage = {
              type: 'answer',
              to: msg.from,
              payload: pc.localDescription as unknown as SdpPayload,
            };
            send(reply);
          } else if (msg.type === 'answer') {
            await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
          } else if (msg.type === 'ice') {
            try {
              await pc.addIceCandidate(msg.payload as RTCIceCandidateInit);
            } catch (err) {
              if (!entry.ignoreOffer) throw err;
            }
          }
        } catch (err) {
          console.error('[mesh] signaling error', msg.type, err);
        }
      }
    });
    return unsubscribe;
  }, [onMessage, ensurePeer, removePeer, send]);

  const publishAudio = useCallback((track: MediaStreamTrack) => {
    localAudioRef.current = track;
    for (const entry of peersRef.current.values()) {
      // Avoid adding twice.
      const already = entry.pc.getSenders().some((s) => s.track === track);
      if (!already) entry.pc.addTrack(track);
    }
  }, []);

  const unpublishAudio = useCallback(() => {
    const track = localAudioRef.current;
    localAudioRef.current = null;
    if (!track) return;
    for (const entry of peersRef.current.values()) {
      for (const sender of entry.pc.getSenders()) {
        if (sender.track === track) {
          entry.pc.removeTrack(sender);
        }
      }
    }
    track.stop();
  }, []);

  const publishVideo = useCallback(
    (track: MediaStreamTrack) => {
      localVideoRef.current = track;
      // Host-only: add a sendonly transceiver to every peer.
      for (const [peerId, entry] of peersRef.current) {
        const already = entry.pc.getSenders().some((s) => s.track === track);
        if (already) continue;
        // Replace any existing recvonly video transceiver (we may have set one
        // up previously as a viewer who then became host).
        const existing = entry.pc.getTransceivers().find(
          (t) => t.receiver.track?.kind === 'video' || t.sender.track?.kind === 'video',
        );
        if (existing) {
          existing.direction = 'sendonly';
          existing.sender.replaceTrack(track);
        } else {
          entry.pc.addTransceiver(track, { direction: 'sendonly' });
        }
        void peerId;
      }
    },
    [],
  );

  const unpublishVideo = useCallback(() => {
    const track = localVideoRef.current;
    localVideoRef.current = null;
    if (!track) return;
    for (const entry of peersRef.current.values()) {
      const sender = entry.pc.getSenders().find((s) => s.track === track);
      if (sender) {
        // Drop the track but keep the transceiver (sendonly → inactive),
        // so a future publishVideo can replace it.
        sender.replaceTrack(null);
      }
    }
    track.stop();
  }, []);

  const closeAll = useCallback(() => {
    for (const entry of peersRef.current.values()) {
      entry.pc.close();
    }
    peersRef.current.clear();
    localAudioRef.current = null;
    localVideoRef.current = null;
  }, []);

  const forEachSender = useCallback(
    (track: MediaStreamTrack, fn: (sender: RTCRtpSender) => void) => {
      for (const entry of peersRef.current.values()) {
        for (const sender of entry.pc.getSenders()) {
          if (sender.track === track) {
            try {
              fn(sender);
            } catch (err) {
              console.error('[mesh] sender callback failed', err);
            }
          }
        }
      }
    },
    [],
  );

  const forEachVideoTransceiver = useCallback(
    (fn: (transceiver: RTCRTransceiverLike) => void) => {
      for (const entry of peersRef.current.values()) {
        for (const t of entry.pc.getTransceivers()) {
          const midTrack = t.sender.track ?? t.receiver.track;
          if (midTrack?.kind === 'video') {
            try {
              fn(t as unknown as RTCRTransceiverLike);
            } catch (err) {
              console.error('[mesh] transceiver callback failed', err);
            }
          }
        }
      }
    },
    [],
  );

  return {
    publishAudio,
    unpublishAudio,
    publishVideo,
    unpublishVideo,
    closeAll,
    forEachSender,
    forEachVideoTransceiver,
  };
}
