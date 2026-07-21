/**
 * Stream quality presets.
 *
 * Each preset maps to a desired frame size, frame rate and target bitrate.
 * The actual captured resolution is `min(requested, source)` — we surface
 * the real value to the UI from `track.getSettings()` after capture.
 *
 * Bitrates are tuned for screen content (high motion = gameplay, not faces).
 */

export type QualityPresetId = 'low' | 'medium' | 'high' | 'ultra' | 'max';

export interface QualityPreset {
  id: QualityPresetId;
  /** Human-readable label shown in the UI. */
  label: string;
  /** Width in pixels requested from getDisplayMedia. */
  width: number;
  /** Height in pixels requested from getDisplayMedia. */
  height: number;
  /** Target frame rate. */
  frameRate: number;
  /** Target max bitrate in bits per second (applied to the RTP sender). */
  maxBitrate: number;
  /** Short description of the use case. */
  hint: string;
}

export const QUALITY_PRESETS: Record<QualityPresetId, QualityPreset> = {
  low: {
    id: 'low',
    label: '720p · 30 fps',
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 2_500_000,
    hint: 'Слабый канал / мобильный зритель',
  },
  medium: {
    id: 'medium',
    label: '1080p · 30 fps',
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 5_000_000,
    hint: 'Презентации, слайды, код',
  },
  high: {
    id: 'high',
    label: '1080p · 60 fps',
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrate: 8_000_000,
    hint: 'Геймплей 1080p, плавный UI',
  },
  ultra: {
    id: 'ultra',
    label: '1440p · 60 fps',
    width: 2560,
    height: 1440,
    frameRate: 60,
    maxBitrate: 16_000_000,
    hint: 'Целевой режим (2K, как Discord на максималках)',
  },
  max: {
    id: 'max',
    label: '2160p · 30 fps',
    width: 3840,
    height: 2160,
    frameRate: 30,
    maxBitrate: 28_000_000,
    hint: '4K — только если монитор 4K',
  },
};

export const QUALITY_PRESET_ORDER: QualityPresetId[] = ['low', 'medium', 'high', 'ultra', 'max'];

/** Returns the preset for an id, or throws if unknown. */
export function getPreset(id: string): QualityPreset {
  const preset = QUALITY_PRESETS[id as QualityPresetId];
  if (!preset) {
    throw new Error(`Unknown quality preset: ${id}`);
  }
  return preset;
}

/** Type guard for validating preset ids coming from the network. */
export function isQualityPresetId(id: unknown): id is QualityPresetId {
  return typeof id === 'string' && id in QUALITY_PRESETS;
}

/** Builds the `video` MediaTrackConstraints object for getDisplayMedia. */
export function toDisplayMediaVideoConstraints(preset: QualityPreset): MediaTrackConstraints {
  return {
    frameRate: { ideal: preset.frameRate, max: preset.frameRate },
    width: { ideal: preset.width },
    height: { ideal: preset.height },
  };
}

/** Returns the effective bitrate in Mbps for display. */
export function bitrateMbps(preset: QualityPreset): number {
  return preset.maxBitrate / 1_000_000;
}
