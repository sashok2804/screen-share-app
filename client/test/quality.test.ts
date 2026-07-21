import { describe, it, expect } from 'vitest';
import {
  QUALITY_PRESETS,
  QUALITY_PRESET_ORDER,
  getPreset,
  isQualityPresetId,
  toDisplayMediaVideoConstraints,
  bitrateMbps,
} from '../src/lib/quality';

describe('quality presets', () => {
  it('exposes exactly 5 presets in the expected order', () => {
    expect(QUALITY_PRESET_ORDER).toEqual(['low', 'medium', 'high', 'ultra', 'max']);
  });

  it('ultra targets 1440p@60fps', () => {
    const p = QUALITY_PRESETS.ultra;
    expect(p.width).toBe(2560);
    expect(p.height).toBe(1440);
    expect(p.frameRate).toBe(60);
    expect(p.maxBitrate).toBe(16_000_000);
  });

  it('low targets 720p@30fps', () => {
    const p = QUALITY_PRESETS.low;
    expect(p.width).toBe(1280);
    expect(p.height).toBe(720);
    expect(p.frameRate).toBe(30);
  });

  it('max targets 4K', () => {
    const p = QUALITY_PRESETS.max;
    expect(p.width).toBe(3840);
    expect(p.height).toBe(2160);
  });

  it('each preset has monotonically increasing bitrate', () => {
    const bitrates = QUALITY_PRESET_ORDER.map((id) => QUALITY_PRESETS[id].maxBitrate);
    for (let i = 1; i < bitrates.length; i++) {
      expect(bitrates[i]).toBeGreaterThan(bitrates[i - 1]);
    }
  });
});

describe('getPreset', () => {
  it('returns the matching preset', () => {
    expect(getPreset('high').id).toBe('high');
  });

  it('throws for unknown id', () => {
    expect(() => getPreset('nonsense')).toThrow(/Unknown quality preset/);
  });
});

describe('isQualityPresetId', () => {
  it('narrows valid ids', () => {
    expect(isQualityPresetId('ultra')).toBe(true);
    expect(isQualityPresetId('xyz')).toBe(false);
    expect(isQualityPresetId(123)).toBe(false);
    expect(isQualityPresetId(null)).toBe(false);
  });
});

describe('toDisplayMediaVideoConstraints', () => {
  it('produces ideal+max frameRate and ideal resolution', () => {
    const c = toDisplayMediaVideoConstraints(QUALITY_PRESETS.ultra);
    expect(c.frameRate).toEqual({ ideal: 60, max: 60 });
    expect(c.width).toEqual({ ideal: 2560 });
    expect(c.height).toEqual({ ideal: 1440 });
  });
});

describe('bitrateMbps', () => {
  it('converts bps to Mbps', () => {
    expect(bitrateMbps(QUALITY_PRESETS.ultra)).toBe(16);
    expect(bitrateMbps(QUALITY_PRESETS.low)).toBe(2.5);
  });
});
