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
// VP8 is included for broader compatibility (older peers / non-Chromium).
const CODEC_PRIORITY = ['av1', 'vp9', 'vp8', 'h264'] as const;

/**
 * "Real" video codec mimeTypes that `RTCRtpTransceiver.setCodecPreferences`
 * accepts on Chrome/Edge. Capability lists also report payload-format helpers
 * — `video/rtx` (retransmission), `video/red` (redundancy), `video/ulpfec`
 * and `video/flexfec-*` (forward error correction) — which Chrome REJECTS with
 * an `InvalidModificationError`. We drop them before ordering.
 *
 * Compared case-insensitively. The literal `av1x` appears on some Chromium
 * builds; treat it as AV1's cousin rather than a real entry (it is NOT valid
 * for setCodecPreferences today).
 */
const VALID_VIDEO_CODECS = new Set([
  'video/av1',
  'video/vp9',
  'video/vp8',
  'video/h264',
]);

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
 *
 * **CRITICAL:** per MDN and the WebRTC working group, the codec list passed to
 * `setCodecPreferences()` MUST be a subset of the codecs returned by
 * `RTCRtpReceiver.getCapabilities(kind)` — NOT `RTCRtpSender.getCapabilities()`.
 * H264 in particular is reported by the sender and receiver as DIFFERENT codec
 * objects (different `sdpFmtpLine`), so passing a sender-derived H264 entry
 * makes Chrome 131+ throw `InvalidModificationError: invalid codec with name
 * "H264"` (see screego/server#215). The caller is therefore required to pass
 * `RTCRtpReceiver.getCapabilities` as `getCapabilities`.
 *
 * Robustness strategy:
 *   1. Filter out non-real codecs (rtx/red/ulpfec/flexfec) that Chrome reports
 *      in capabilities but rejects in `setCodecPreferences`.
 *   2. Try the full prioritised list.
 *   3. On rejection (known Chrome regression with H264 — some setups are
 *      decode-only / unidirectional), retry WITHOUT H264.
 *   4. On a second rejection, retry WITHOUT H264 and WITHOUT VP9 (some
 *      sandboxes expose only AV1 + VP8).
 *   5. If everything fails, log and return `null` rather than throwing.
 *
 * Returns the filtered/reordered codec list actually handed to
 * `setCodecPreferences`, or `null` if we deliberately skipped the call.
 */
export function applyCodecPreferences(
  transceiver: TransceiverLike,
  kind: 'audio' | 'video',
  // CRITICAL: caller must pass RTCRtpReceiver.getCapabilities, NOT sender.
  getCapabilities: (kind: 'audio' | 'video') => RtpCapabilitiesLike | null,
): Array<{ mimeType: string }> | null {
  const caps = getCapabilities(kind);
  if (!caps?.codecs?.length) return null;

  // Step 1: filter to real codecs only (no rtx/red/ulpfec/flexfec).
  // For audio we pass everything through — the helper formats are rare and
  // we never observed Chrome rejecting an audio preference list.
  const realCodecs = caps.codecs.filter((c) => {
    if (kind !== 'video') return true;
    return VALID_VIDEO_CODECS.has(c.mimeType.toLowerCase());
  });

  if (realCodecs.length === 0) {
    console.warn(
      '[rtc] no valid video codecs after filtering, skipping setCodecPreferences',
    );
    return null;
  }

  // Step 2: sort by priority AV1 > VP9 > VP8 > H264.
  const ordered = sortCodecsByPriority(realCodecs);

  // Step 3: try to apply. If H264 causes InvalidModificationError
  // (known Chrome bug, unidirectional codec support), retry without H264.
  const tryApply = (list: Array<{ mimeType: string }>): boolean => {
    try {
      transceiver.setCodecPreferences(list);
      return true;
    } catch (err) {
      console.warn(
        '[rtc] setCodecPreferences rejected list:',
        list.map((c) => c.mimeType).join(','),
        '— error:',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  };

  if (tryApply(ordered)) return ordered;

  // Fallback 1: drop H264 and retry.
  const withoutH264 = ordered.filter(
    (c) => !c.mimeType.toLowerCase().includes('h264'),
  );
  if (withoutH264.length > 0 && tryApply(withoutH264)) {
    console.log(
      '[rtc] codec preferences applied without H264:',
      withoutH264.map((c) => c.mimeType).join(','),
    );
    return withoutH264;
  }

  // Fallback 2: drop VP9 too (some setups only have AV1+VP8).
  const minimal = withoutH264.filter(
    (c) => !c.mimeType.toLowerCase().includes('vp9'),
  );
  if (minimal.length > 0 && tryApply(minimal)) {
    console.log(
      '[rtc] codec preferences applied (no H264, no VP9):',
      minimal.map((c) => c.mimeType).join(','),
    );
    return minimal;
  }

  console.warn('[rtc] all codec preference attempts failed, leaving defaults');
  return null;
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
