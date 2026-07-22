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

  it('filters out rtx/red/ulpfec/flexfec before calling setCodecPreferences', () => {
    // Real Chrome capability list: H264, its rtx payload, AV1, red, ulpfec.
    // setCodecPreferences would throw InvalidModificationError on the helpers.
    const setCodecPreferences = vi.fn();
    const transceiver = { setCodecPreferences };
    const getCapabilities = () => ({
      codecs: [
        { mimeType: 'video/H264' },
        { mimeType: 'video/rtx' },
        { mimeType: 'video/AV1' },
        { mimeType: 'video/red' },
        { mimeType: 'video/ulpfec' },
        { mimeType: 'video/flexfec-08' },
      ],
    });
    const result = applyCodecPreferences(transceiver, 'video', getCapabilities);
    expect(setCodecPreferences).toHaveBeenCalledTimes(1);
    expect(setCodecPreferences).toHaveBeenCalledWith([
      { mimeType: 'video/AV1' },
      { mimeType: 'video/H264' },
    ]);
    expect(result?.map((c) => c.mimeType)).toEqual(['video/AV1', 'video/H264']);
  });

  it('is case-insensitive when filtering (lowercase h264)', () => {
    const setCodecPreferences = vi.fn();
    const transceiver = { setCodecPreferences };
    const getCapabilities = () => ({
      codecs: [{ mimeType: 'video/h264' }, { mimeType: 'video/vp9' }],
    });
    const result = applyCodecPreferences(transceiver, 'video', getCapabilities);
    expect(result?.map((c) => c.mimeType)).toEqual(['video/vp9', 'video/h264']);
  });

  it('returns null and skips the call when only helper codecs exist', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setCodecPreferences = vi.fn();
    const transceiver = { setCodecPreferences };
    const getCapabilities = () => ({
      codecs: [
        { mimeType: 'video/rtx' },
        { mimeType: 'video/red' },
        { mimeType: 'video/ulpfec' },
      ],
    });
    const result = applyCodecPreferences(transceiver, 'video', getCapabilities);
    expect(result).toBeNull();
    expect(setCodecPreferences).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns null (and does not throw) when setCodecPreferences rejects the list', () => {
    // Simulate Chrome rejecting every (filtered) list — all fallbacks fail.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setCodecPreferences = vi.fn(() => {
      throw new DOMException(
        'Invalid codec preferences: invalid codec with name "H264".',
        'InvalidModificationError',
      );
    });
    const transceiver = { setCodecPreferences };
    const getCapabilities = () => ({
      codecs: [{ mimeType: 'video/H264' }],
    });
    const result = applyCodecPreferences(transceiver, 'video', getCapabilities);
    expect(setCodecPreferences).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    log.mockRestore();
  });

  it('retries without H264 when the full list is rejected (Chrome 131 regression)', () => {
    // Mirrors screego/server#215: Chrome throws on H264 even though it is in
    // the (receiver) capability list. The function must drop H264 and retry.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let callCount = 0;
    const seen: string[][] = [];
    const setCodecPreferences = vi.fn((list: Array<{ mimeType: string }>) => {
      callCount++;
      seen.push(list.map((c) => c.mimeType));
      // First call (AV1, VP9, H264) is rejected; subsequent calls succeed.
      if (callCount === 1) {
        throw new DOMException(
          'Invalid codec preferences: invalid codec with name "H264".',
          'InvalidModificationError',
        );
      }
    });
    const transceiver = { setCodecPreferences };
    const getCapabilities = () => ({
      codecs: [
        { mimeType: 'video/VP8' },
        { mimeType: 'video/VP9' },
        { mimeType: 'video/H264' },
      ],
    });
    const result = applyCodecPreferences(transceiver, 'video', getCapabilities);
    expect(setCodecPreferences).toHaveBeenCalledTimes(2);
    expect(seen[0]).toEqual(['video/VP9', 'video/VP8', 'video/H264']);
    expect(seen[1]).toEqual(['video/VP9', 'video/VP8']);
    expect(result?.map((c) => c.mimeType)).toEqual(['video/VP9', 'video/VP8']);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('drops VP9 too when both H264 and VP9 fallbacks are rejected', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let callCount = 0;
    const seen: string[][] = [];
    const setCodecPreferences = vi.fn((list: Array<{ mimeType: string }>) => {
      callCount++;
      seen.push(list.map((c) => c.mimeType));
      // Calls 1 (full) and 2 (no H264) are rejected; call 3 (AV1+VP8 only) OK.
      if (callCount <= 2) {
        throw new DOMException(
          'Invalid codec preferences: invalid codec with name "H264".',
          'InvalidModificationError',
        );
      }
    });
    const transceiver = { setCodecPreferences };
    const getCapabilities = () => ({
      codecs: [
        { mimeType: 'video/AV1' },
        { mimeType: 'video/VP8' },
        { mimeType: 'video/VP9' },
        { mimeType: 'video/H264' },
      ],
    });
    const result = applyCodecPreferences(transceiver, 'video', getCapabilities);
    expect(setCodecPreferences).toHaveBeenCalledTimes(3);
    expect(seen[2]).toEqual(['video/AV1', 'video/VP8']);
    expect(result?.map((c) => c.mimeType)).toEqual(['video/AV1', 'video/VP8']);
    log.mockRestore();
  });

  it('returns null when every fallback list is rejected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setCodecPreferences = vi.fn(() => {
      throw new DOMException('nope', 'InvalidModificationError');
    });
    const transceiver = { setCodecPreferences };
    const getCapabilities = () => ({
      codecs: [
        { mimeType: 'video/AV1' },
        { mimeType: 'video/VP9' },
        { mimeType: 'video/H264' },
      ],
    });
    const result = applyCodecPreferences(transceiver, 'video', getCapabilities);
    expect(setCodecPreferences).toHaveBeenCalledTimes(3);
    expect(result).toBeNull();
    warn.mockRestore();
    log.mockRestore();
  });

  it('does not retry on the first success (no extra setCodecPreferences calls)', () => {
    const setCodecPreferences = vi.fn();
    const transceiver = { setCodecPreferences };
    const getCapabilities = () => ({
      codecs: [{ mimeType: 'video/H264' }, { mimeType: 'video/AV1' }],
    });
    const result = applyCodecPreferences(transceiver, 'video', getCapabilities);
    expect(setCodecPreferences).toHaveBeenCalledTimes(1);
    expect(result?.map((c) => c.mimeType)).toEqual(['video/AV1', 'video/H264']);
  });

  it('passes audio codecs through unfiltered', () => {
    const setCodecPreferences = vi.fn();
    const transceiver = { setCodecPreferences };
    const getCapabilities = () => ({
      codecs: [{ mimeType: 'audio/opus' }, { mimeType: 'audio/telephone-event' }],
    });
    const result = applyCodecPreferences(transceiver, 'audio', getCapabilities);
    expect(setCodecPreferences).toHaveBeenCalledWith([
      { mimeType: 'audio/opus' },
      { mimeType: 'audio/telephone-event' },
    ]);
    expect(result?.map((c) => c.mimeType)).toEqual([
      'audio/opus',
      'audio/telephone-event',
    ]);
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
