import { useAudioLevel } from '../hooks/useAudioLevel';

export interface AudioMeterProps {
  /** Track to analyse. Pass null when muted / no mic. */
  track: MediaStreamTrack | null;
  /** Compact (single bar, 3px) vs full (gradient, 6px). */
  variant?: 'compact' | 'full';
}

/**
 * Horizontal VU meter for a single audio track.
 *
 * Sampling happens in `useAudioLevel` (~15 fps). Here we just convert the
 * 0..1 level to a width percentage and pick a colour band:
 *   0–0.3  silent/quiet → slate
 *   0.3–0.6 talking     → emerald
 *   0.6–0.85 loud       → amber
 *   0.85+   clipping    → rose
 */
export function AudioMeter({ track, variant = 'compact' }: AudioMeterProps) {
  const level = useAudioLevel(track);
  const hasTrack = track !== null;
  const percent = Math.round(level * 100);

  const color = !hasTrack || level < 0.05
    ? 'bg-slate-600/40'
    : level < 0.3
      ? 'bg-emerald-500/80'
      : level < 0.6
        ? 'bg-emerald-400'
        : level < 0.85
          ? 'bg-amber-400'
          : 'bg-rose-500';

  const height = variant === 'compact' ? 'h-1' : 'h-1.5';

  if (!hasTrack) {
    return (
      <div className={`${height} w-full rounded-full bg-slate-800/60`} aria-hidden />
    );
  }

  return (
    <div
      className={`${height} w-full rounded-full bg-slate-800/60 overflow-hidden`}
      role="meter"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Уровень громкости"
      title={`Громкость: ${percent}%`}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-75 ${color}`}
        style={{ width: `${Math.max(2, percent)}%` }}
      />
    </div>
  );
}
