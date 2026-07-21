import { forwardRef } from 'react';

export interface VideoStageProps {
  /** "hosting" if we are streaming our own screen; "viewing" if remote. */
  mode: 'idle' | 'hosting' | 'viewing';
  /** Resolution label to show on the badge. */
  resolutionLabel?: string;
  /** Fps to show on the badge. */
  fpsLabel?: string;
  /** Whether the captured source has audio. */
  hasAudio?: boolean;
}

/**
 * Renders the main video surface. The actual srcObject is attached externally
 * (in useScreenShare) via the forwarded ref — both hosting preview and remote
 * view share the same <video> element, controlled by `mode`.
 */
export const VideoStage = forwardRef<HTMLVideoElement | null, VideoStageProps>(function VideoStage(
  { mode, resolutionLabel, fpsLabel, hasAudio },
  ref,
) {
  return (
    <div className="relative flex-1 min-h-0 rounded-2xl overflow-hidden border border-slate-800 bg-black">
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={mode === 'hosting'}
        className="h-full w-full object-contain"
      />

      {mode === 'idle' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500">
          <div className="rounded-full bg-slate-800/60 p-4 mb-3">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <rect x="2" y="4" width="20" height="14" rx="2" />
              <path d="M8 22h8M12 18v4" />
            </svg>
          </div>
          <p className="text-sm">Стрим ещё не запущен</p>
          <p className="text-xs text-slate-600 mt-1">
            Хост должен начать демонстрацию экрана, а зрители — подписаться
          </p>
        </div>
      )}

      {mode !== 'idle' && (resolutionLabel || fpsLabel) && (
        <div className="absolute top-3 left-3 flex items-center gap-1.5">
          {resolutionLabel && (
            <Badge>
              {resolutionLabel}
              {fpsLabel ? ` · ${fpsLabel}` : ''}
            </Badge>
          )}
          <Badge variant={mode === 'hosting' ? 'rose' : 'emerald'}>
            {mode === 'hosting' ? '● LIVE (вы)' : '● LIVE'}
          </Badge>
          {hasAudio === false && (
            <Badge variant="amber" title="Звук отсутствует для источника Window">
              🔇 без звука
            </Badge>
          )}
        </div>
      )}
    </div>
  );
});

function Badge({
  children,
  variant = 'slate',
  title,
}: {
  children: React.ReactNode;
  variant?: 'slate' | 'rose' | 'emerald' | 'amber';
  title?: string;
}) {
  const styles = {
    slate: 'bg-slate-900/80 text-slate-200 border-slate-700',
    rose: 'bg-rose-900/60 text-rose-200 border-rose-700/50',
    emerald: 'bg-emerald-900/60 text-emerald-200 border-emerald-700/50',
    amber: 'bg-amber-900/60 text-amber-200 border-amber-700/50',
  }[variant];
  return (
    <span
      title={title}
      className={`rounded-md border px-2 py-0.5 text-[11px] font-medium backdrop-blur ${styles}`}
    >
      {children}
    </span>
  );
}
