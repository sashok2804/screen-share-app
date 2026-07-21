/**
 * WebRTC helpers: codec preference ordering and bitrate application.
 *
 * Goal: on Chrome/Edge 117+ we want the encoder to pick AV1 first (HW-accelerated,
 * best quality per bit), fall back to VP9, then to H.264. This is what makes
 * 1440p@60fps achievable without saturating the CPU.
 */

import type { QualityPreset } from './quality';

// RTP codec mimeType fragments. WebRTC uses "video/AV1", "video/VP9", "video/H264"
// (NOT the ISOBMFF/MP4 fourcc "av01"/"vp09" forms).
const CODEC_PRIORITY = ['av1', 'vp9', 'h264'] as const;

export interface RtpCapabilitiesLike {
  codecs?: Array<{ mimeType: string }>;
}

export interface TransceiverLike {
  setCodecPreferences(codecs: Array<{ mimeType: string }>): void;
}

/**
 * Reorders the codec list by priority (AV1 > VP9 > H.264).
 * Codecs that don't match any priority keep their relative order and
 * land after the prioritised ones.
 */
export function sortCodecsByPriority(
  codecs: Array<{ mimeType: string }>,
): Array<{ mimeType: string }> {
  const score = (mimeType: string): number => {
    const lower = mimeType.toLowerCase();
    for (let i = 0; i < CODEC_PRIORITY.length; i++) {
      if (lower.includes(CODEC_PRIORITY[i])) return i;
    }
    return CODEC_PRIORITY.length;
  };

  // Stable sort: preserves original order within the same score.
  return [...codecs]
    .map((codec, originalIndex) => ({ codec, originalIndex, score: score(codec.mimeType) }))
    .sort((a, b) => a.score - b.score || a.originalIndex - b.originalIndex)
    .map((entry) => entry.codec);
}

/**
 * Applies the codec preference order to a transceiver, using the *browser's*
 * own capability list as the source (so we never pass an unsupported codec).
 * Returns the filtered/reordered codec list, or `null` if unavailable.
 */
export function applyCodecPreferences(
  transceiver: TransceiverLike,
  kind: 'audio' | 'video',
  getCapabilities: (kind: 'audio' | 'video') => RtpCapabilitiesLike | null,
): Array<{ mimeType: string }> | null {
  const caps = getCapabilities(kind);
  if (!caps?.codecs?.length) return null;
  const ordered = sortCodecsByPriority(caps.codecs);
  transceiver.setCodecPreferences(ordered);
  return ordered;
}

/**
 * Applies the preset bitrate to an RTP sender via setParameters.
 *
 * WebRTC encodings are a live array — we must mutate the existing object
 * rather than replacing the array reference.
 */
export async function applyBitrate(sender: RTCRtpSender, preset: QualityPreset): Promise<void> {
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{} as RTCRtpEncodingParameters];
  }
  for (const enc of params.encodings) {
    enc.maxBitrate = preset.maxBitrate;
    // Hint the encoder to keep the full captured resolution.
    enc.scaleResolutionDownBy = undefined;
    // Request a high-priority encoding layer when available (SVC).
    if (!('priority' in enc)) {
      (enc as RTCRtpEncodingParameters & { priority?: RTCPriorityType }).priority = 'high';
    }
  }
  await sender.setParameters(params);
}

/**
 * Default ICE servers. STUN is enough for most home LANs; for symmetric NAT
 * you should add a TURN server via the `VITE_TURN_URL` env var.
 *
 * NOTE: Google STUN (stun.l.google.com) is reachable from most networks,
 * but some ISPs (especially in RU/CIS) block it. We include Cloudflare and
 * Stunprotocol as fallbacks — Chrome will try all of them in parallel.
 */
export function defaultIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.stunprotocol.org:3478' },
  ];

  const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined;
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: import.meta.env.VITE_TURN_USERNAME as string | undefined,
      credential: import.meta.env.VITE_TURN_CREDENTIAL as string | undefined,
    });
  }
  return servers;
}
