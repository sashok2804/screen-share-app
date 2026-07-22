import { useEffect, useMemo, useState } from 'react';
import type { AudioSourceSelection, AudioProcess } from '../electron';

export interface ProcessAudioPickerProps {
  /** Called with the user's choice (a process or "system audio"). */
  onPick: (selection: AudioSourceSelection) => void;
  /** Called when the modal is dismissed without a choice (Esc / Отмена / backdrop). */
  onCancel: () => void;
}

/**
 * Application-audio source picker (Electron only). Shown after the video
 * source is chosen when the host wants to capture the audio of a specific
 * application — the Discord-style, echo-free path. The remote peer's voice
 * (played by this Electron window's renderer) belongs to a different process
 * than the picked target, so it never enters the capture.
 *
 * Also offers "Системный звук" (whole default render endpoint) for the case
 * where the desired source isn't in the process list (e.g. a UWP app, or
 * audio routed through a virtual cable).
 *
 * The list comes from `window.electronAPI.listAudioProcesses()` (PowerShell
 * `Get-Process` with a non-empty MainWindowTitle). We hide our own app
 * process — capturing ourselves would be a pure feedback loop.
 */
export function ProcessAudioPicker({ onPick, onCancel }: ProcessAudioPickerProps) {
  const [processes, setProcesses] = useState<AudioProcess[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!api?.listAudioProcesses) {
      setLoading(false);
      setError('Список процессов недоступен (не в Electron?)');
      return;
    }
    api.listAudioProcesses()
      .then((list) => {
        if (cancelled) return;
        // Hide our own desktop client from the list: capturing the Electron
        // app's own audio would just re-publish the remote peer's voice → the
        // exact echo loop this picker exists to avoid. Match by name ("Screen
        // Share" is our productName / process name) and by "electron"/"Screen
        // Share" titles to be safe across packaged vs dev runs.
        const filtered = (list ?? []).filter(
          (p) =>
            !/^(Screen Share|electron)$/i.test(p.name) &&
            !/Screen Share\s*·/i.test(p.title),
        );
        setProcesses(filtered);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Не удалось получить список процессов');
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return processes;
    return processes.filter(
      (p) => p.name.toLowerCase().includes(q) || p.title.toLowerCase().includes(q),
    );
  }, [processes, query]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Выбор источника звука"
    >
      <div className="flex w-full max-w-2xl flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Источник звука</h2>
            <p className="mt-0.5 text-[11px] text-slate-400">
              Звук выбранного приложения без эха (WASAPI loopback)
            </p>
          </div>
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
        <div className="flex-1 overflow-hidden px-6 py-4 flex flex-col gap-3">
          {/* System-audio shortcut — always available, first for prominence. */}
          <button
            type="button"
            onClick={() => onPick({ system: true })}
            className="flex items-center gap-3 rounded-xl border border-indigo-500/40 bg-indigo-500/10 px-4 py-3 text-left transition hover:border-indigo-400 hover:bg-indigo-500/20"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-300">
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path
                  d="M3 8v4h3l4 3V5L6 8H3zm9-2a4 4 0 010 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-slate-100">Системный звук</span>
              <span className="block text-[11px] text-slate-400">
                Весь звук с устройства вывода по умолчанию
              </span>
            </span>
          </button>

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск приложения…"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
            />
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading && (
              <div className="flex flex-col items-center justify-center gap-3 py-12 text-slate-400">
                <Spinner />
                <p className="text-sm">Получаем список процессов…</p>
              </div>
            )}

            {!loading && error && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                {error}
              </div>
            )}

            {!loading && !error && filtered.length === 0 && (
              <div className="py-12 text-center text-sm text-slate-400">
                {processes.length === 0
                  ? 'Нет процессов с окнами. Воспользуйтесь «Системным звуком».'
                  : 'Ничего не найдено.'}
              </div>
            )}

            {!loading && !error && filtered.length > 0 && (
              <ul className="flex flex-col gap-1">
                {filtered.map((p) => (
                  <li key={`${p.pid}`}>
                    <button
                      type="button"
                      onClick={() => onPick({ pid: p.pid, name: p.name })}
                      className="flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-left transition hover:border-slate-700 hover:bg-slate-800/60"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-800 text-[10px] font-mono text-slate-400">
                        {p.pid}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-slate-100">{p.name}</span>
                        <span className="block truncate text-[11px] text-slate-500" title={p.title}>
                          {p.title}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-slate-800 px-6 py-3">
          <span className="text-[10px] text-slate-500">
            Дружит без эха: голос друга из этого окна исключается автоматически.
          </span>
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
