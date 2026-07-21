import { useEffect, useState } from 'react';
import type { ElectronSource } from '../electron';

export interface SourcePickerProps {
  onPick: (source: ElectronSource) => void;
  onCancel: () => void;
}

/**
 * Custom replacement for the native `getDisplayMedia` picker, shown only when
 * running inside Electron. On mount it calls `window.electronAPI.getSources()`
 * and renders a responsive grid of source cards (windows + screens) with live
 * thumbnails. The host picks one → `onPick(source)`. Click-outside / Отмена /
 * Esc → `onCancel()`.
 *
 * The picker is intentionally self-contained: the parent only needs to render
 * it conditionally and wire `onPick` / `onCancel` to `useScreenShare`.
 */
export function SourcePicker({ onPick, onCancel }: SourcePickerProps) {
  const [sources, setSources] = useState<ElectronSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!api?.getSources) {
      setLoading(false);
      setError('Source picker недоступен (не в Electron?)');
      return;
    }
    api.getSources()
      .then((list) => {
        if (cancelled) return;
        setSources(list);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Не удалось получить список источников');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Esc closes the modal — matches user expectation for cancel-type dialogs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Click on the backdrop (not on the panel) cancels — standard modal UX.
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onCancel();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Выбор источника для демонстрации"
    >
      <div className="flex w-full max-w-4xl flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-100">Выберите источник</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Закрыть"
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M5 5l10 10M15 5L5 15"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading && (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-slate-400">
              <Spinner />
              <p className="text-sm">Получаем список окон и экранов…</p>
            </div>
          )}

          {!loading && error && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
              {error}
            </div>
          )}

          {!loading && !error && sources.length === 0 && (
            <div className="py-16 text-center text-sm text-slate-400">
              Нет доступных источников.
            </div>
          )}

          {!loading && !error && sources.length > 0 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {sources.map((source) => {
                const isScreen = source.id.startsWith('screen:');
                return (
                  <button
                    key={source.id}
                    type="button"
                    onClick={() => onPick(source)}
                    className="group flex flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-950 text-left transition hover:border-indigo-500 hover:scale-[1.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  >
                    {/* Thumbnail */}
                    <div className="relative aspect-video w-full overflow-hidden bg-slate-900">
                      {source.thumbnailDataURL ? (
                        <img
                          src={source.thumbnailDataURL}
                          alt={source.name}
                          loading="lazy"
                          className="h-full w-full object-cover object-top transition group-hover:brightness-110"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-xs text-slate-600">
                          без превью
                        </div>
                      )}
                      <span
                        className={`absolute left-2 top-2 rounded-md px-1.5 py-0.5 text-[10px] font-medium backdrop-blur ${
                          isScreen
                            ? 'bg-indigo-500/30 text-indigo-100 border border-indigo-400/40'
                            : 'bg-slate-800/80 text-slate-200 border border-slate-600/60'
                        }`}
                      >
                        {isScreen ? 'Экран' : 'Окно'}
                      </span>
                    </div>

                    {/* Title row */}
                    <div className="flex items-center gap-2 px-3 py-2">
                      {source.appIconDataURL ? (
                        <img
                          src={source.appIconDataURL}
                          alt=""
                          className="h-4 w-4 shrink-0"
                        />
                      ) : (
                        <span className="h-4 w-4 shrink-0" />
                      )}
                      <span
                        className="truncate text-xs text-slate-200"
                        title={source.name}
                      >
                        {source.name}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-slate-800 px-6 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-700"
          >
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400"
      role="status"
      aria-label="загрузка"
    />
  );
}
