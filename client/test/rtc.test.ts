import { describe, it, expect, vi } from 'vitest';
import {
  sortCodecsByPriority,
  applyCodecPreferences,
  applyBitrate,
  defaultIceServers,
} from '../src/lib/rtc';
import { QUALITY_PRESETS } from '../src/lib/quality';

describe('sortCodecsByPriority', () => {
  it('orders AV1 > VP9 > H.264', () => {
    const input = [
      { mimeType: 'video/H264' },
      { mimeType: 'video/VP9' },
      { mimeType: 'video/AV1' },
    ];
    const sorted = sortCodecsByPriority(input);
    expect(sorted.map((c) => c.mimeType)).toEqual([
      'video/AV1',
      'video/VP9',
      'video/H264',
    ]);
  });

  it('pushes unknown codecs to the end (stable)', () => {
    const input = [
      { mimeType: 'video/H264' },
      { mimeType: 'video/rtx' },
      { mimeType: 'video/AV1' },
      { mimeType: 'video/red' },
    ];
    const sorted = sortCodecsByPriority(input);
    expect(sorted.map((c) => c.mimeType)).toEqual([
      'video/AV1',
      'video/H264',
      'video/rtx',
      'video/red',
    ]);
  });

  it('preserves order when nothing matches', () => {
    const input = [{ mimeType: 'video/foo' }, { mimeType: 'video/bar' }];
    expect(sortCodecsByPriority(input).map((c) => c.mimeType)).toEqual([
      'video/foo',
      'video/bar',
    ]);
  });

  it('is case-insensitive', () => {
    const input = [{ mimeType: 'VIDEO/H264' }, { mimeType: 'video/av1' }];
    expect(sortCodecsByPriority(input).map((c) => c.mimeType)).toEqual([
      'video/av1',
      'VIDEO/H264',
    ]);
  });

  it('does not mutate the input', () => {
    const input = [{ mimeType: 'video/H264' }, { mimeType: 'video/AV1' }];
    const snapshot = input.map((c) => ({ ...c }));
    sortCodecsByPriority(input);
    expect(input).toEqual(snapshot);
  });
});

describe('applyCodecPreferences', () => {
  it('calls setCodecPreferences with the reordered list', () => {
    const setCodecPreferences = vi.fn();
    const transceiver = { setCodecPreferences };
    const getCapabilities = () => ({
      codecs: [{ mimeType: 'video/H264' }, { mimeType: 'video/AV1' }],
    });
    const result = applyCodecPreferences(transceiver, 'video', getCapabilities);
    expect(setCodecPreferences).toHaveBeenCalledWith([
      { mimeType: 'video/AV1' },
      { mimeType: 'video/H264' },
    ]);
    expect(result?.map((c) => c.mimeType)).toEqual(['video/AV1', 'video/H264']);
  });

  it('returns null and does nothing when capabilities are missing', () => {
    const setCodecPreferences = vi.fn();
    const transceiver = { setCodecPreferences };
    const result = applyCodecPreferences(transceiver, 'video', () => null);
    expect(result).toBeNull();
    expect(setCodecPreferences).not.toHaveBeenCalled();
  });
});

describe('applyBitrate', () => {
  it('sets maxBitrate on existing encodings', async () => {
    const encodings: RTCRtpEncodingParameters[] = [{}];
    const sender = {
      getParameters: () => ({ encodings }),
      setParameters: vi.fn(async () => {}),
    } as unknown as RTCRtpSender;
    await applyBitrate(sender, QUALITY_PRESETS.ultra);
    expect(encodings[0].maxBitrate).toBe(16_000_000);
  });

  it('creates an encoding if none exist', async () => {
    const captured: { encodings?: RTCRtpEncodingParameters[] } = {};
    const sender = {
      getParameters: () => captured,
      setParameters: vi.fn(async (p: RTCRtpSendParameters) => {
        captured.encodings = p.encodings;
      }),
    } as unknown as RTCRtpSender;
    await applyBitrate(sender, QUALITY_PRESETS.low);
    expect(captured.encodings?.[0]?.maxBitrate).toBe(2_500_000);
  });
});

describe('defaultIceServers', () => {
  it('always includes Cloudflare + Google STUN endpoints', () => {
    const servers = defaultIceServers();
    expect(servers.length).toBeGreaterThanOrEqual(3);
    expect(servers.some((s) => String(s.urls).includes('stun.cloudflare.com'))).toBe(true);
    expect(servers.some((s) => String(s.urls).includes('stun.l.google.com'))).toBe(true);
  });
});
