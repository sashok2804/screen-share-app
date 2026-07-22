import { describe, it, expect } from 'vitest';
import { pickDefaultAudioDevice } from '../src/hooks/useProcessAudio';

describe('pickDefaultAudioDevice', () => {
  it('prefers Voicemeeter Out A1 over A4 even when A4 sorts earlier in the list', () => {
    // Real-world dshow order reported by a user: A4 came at index 2, A1 at
    // index 3. The old single-regex `A\d` rule matched A4 first.
    const devices = [
      'Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)',
      'Микрофон (3- JBL Quantum350 Wireless)',
      'Voicemeeter Out A4 (VB-Audio Voicemeeter VAIO)',
      'Voicemeeter Out A1 (VB-Audio Voicemeeter VAIO)',
      'Voicemeeter Out A2 (VB-Audio Voicemeeter VAIO)',
    ];
    expect(pickDefaultAudioDevice(devices)).toBe(
      'Voicemeeter Out A1 (VB-Audio Voicemeeter VAIO)',
    );
  });

  it('prefers A1 over A2 and A3', () => {
    const devices = [
      'Voicemeeter Out A3 (VB-Audio Voicemeeter VAIO)',
      'Voicemeeter Out A2 (VB-Audio Voicemeeter VAIO)',
      'Voicemeeter Out A1 (VB-Audio Voicemeeter VAIO)',
    ];
    expect(pickDefaultAudioDevice(devices)).toBe(
      'Voicemeeter Out A1 (VB-Audio Voicemeeter VAIO)',
    );
  });

  it('falls through A2 when A1 is absent', () => {
    const devices = [
      'Voicemeeter Out A4 (VB-Audio Voicemeeter VAIO)',
      'Voicemeeter Out A2 (VB-Audio Voicemeeter VAIO)',
    ];
    expect(pickDefaultAudioDevice(devices)).toBe(
      'Voicemeeter Out A2 (VB-Audio Voicemeeter VAIO)',
    );
  });

  it('uses the generic A\\d fallback when only A4+ are present', () => {
    const devices = [
      'Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)',
      'Voicemeeter Out A4 (VB-Audio Voicemeeter VAIO)',
    ];
    expect(pickDefaultAudioDevice(devices)).toBe(
      'Voicemeeter Out A4 (VB-Audio Voicemeeter VAIO)',
    );
  });

  it('prefers Stereo Mix over Voicemeeter hardware outputs', () => {
    const devices = [
      'Voicemeeter Out A1 (VB-Audio Voicemeeter VAIO)',
      'Stereo Mix (Realtek Audio)',
    ];
    expect(pickDefaultAudioDevice(devices)).toBe('Stereo Mix (Realtek Audio)');
  });

  it('skips microphones and Voicemeeter virtual cables (B1)', () => {
    const devices = [
      'Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)',
      'Микрофон (3- JBL Quantum350 Wireless)',
      'CABLE Output (VB-Audio Virtual Cable)',
    ];
    // Nothing matches the priority list, and everything is a mic / virtual
    // cable, so the fallback also fails — return the first device.
    expect(pickDefaultAudioDevice(devices)).toBe(devices[0]);
  });
});
