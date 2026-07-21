import { useEffect, useState } from 'react';

/**
 * Sample an audio track's RMS level via Web Audio API AnalyserNode.
 *
 * Returns a float in [0, 1] representing current loudness, updated ~15 fps.
 * Closes/disposes the AnalyserNode when the track changes or unmounts.
 *
 * Notes:
 * - A single AudioContext is lazily created and reused across all meters —
 *   browsers limit how many contexts you can have open at once.
 * - We use a low time-domain FFT size (256) which is plenty for a VU meter.
 * - For the local (mic) track you typically want `muted` playback on the
 *   source element, but AnalyserNode works regardless of the element's muted
 *   flag — it taps the raw MediaStream.
 */
export function useAudioLevel(track: MediaStreamTrack | null): number {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!track) {
      setLevel(0);
      return;
    }

    const ctx = getSharedAudioContext();
    const stream = new MediaStream([track]);
    let source: MediaStreamAudioSourceNode;
    try {
      source = ctx.createMediaStreamSource(stream);
    } catch (err) {
      console.warn('[useAudioLevel] cannot bind track', err);
      return;
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);

    const buffer = new Uint8Array(analyser.fftSize);
    let rafId: number;
    let lastUpdate = 0;

    const tick = (ts: number) => {
      rafId = requestAnimationFrame(tick);
      // Throttle to ~15 fps to avoid React state thrash.
      if (ts - lastUpdate < 66) return;
      lastUpdate = ts;

      analyser.getByteTimeDomainData(buffer);
      // Compute RMS of the centered samples (byte values are 0..255, center 128).
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) {
        const v = (buffer[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buffer.length);
      // Boost + clamp into [0, 1] for nicer visual range.
      const boosted = Math.min(1, rms * 1.8);
      setLevel((prev) => {
        // Decay more slowly than attack for a smoother meter.
        return boosted > prev ? boosted : prev * 0.85 + boosted * 0.15;
      });
    };
    rafId = requestAnimationFrame(tick);

    const onTrackEnded = () => setLevel(0);
    track.addEventListener('ended', onTrackEnded);

    return () => {
      cancelAnimationFrame(rafId);
      track.removeEventListener('ended', onTrackEnded);
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        /* already gone */
      }
      setLevel(0);
    };
  }, [track]);

  return level;
}

// ─── Shared AudioContext ───────────────────────────────────────────────────

let sharedCtx: AudioContext | null = null;

function getSharedAudioContext(): AudioContext {
  if (!sharedCtx) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API not supported');
    sharedCtx = new Ctor();
  }
  // Some browsers start the context in 'suspended' state until a user gesture.
  if (sharedCtx.state === 'suspended') {
    void sharedCtx.resume();
  }
  return sharedCtx;
}
