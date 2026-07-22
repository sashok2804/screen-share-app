import { QUALITY_PRESETS, QUALITY_PRESET_ORDER, bitrateMbps, type QualityPresetId } from '../lib/quality';

export interface StreamControlsProps {
  isHost: boolean;
  hostStreaming: boolean;
  activePreset: QualityPresetId | null;
  onPickPreset: (presetId: QualityPresetId) => void;
  onStart: (presetId: QualityPresetId) => void;
  onStop: () => void;
  /** Effective capture info, when streaming. */
  effective?: { width: number; height: number; frameRate: number; hasAudio: boolean } | null;
  errorMessage?: string | null;
  /** AEC toggle state. */
  aecEnabled?: boolean;
  /** Toggle AEC. */
  onToggleAec?: (next: boolean) => void;
  /**
   * Phase 3 (rewritten) — `true` when audio is captured via the loopback-capture
   * WASAPI bridge (per-process, exclude-self, or system-wide; Electron-only,
   * echo-free). Audio is auto-selected from the video source — no separate UI.
   */
  audioViaFfmpeg?: boolean;
  /** Phase 3 — running inside the Electron desktop client. */
  isElectron?: boolean;
  /**
   * Phase 3 — human-readable label of the auto-selected audio source, or null
   * when audio capture hasn't started / failed. Shown only as a status chip
   * (read-only — the user does not pick it manually any more).
   */
  selectedAudioLabel?: string | null;
}

export function StreamControls({
  isHost,
  hostStreaming,
  activePreset,
  onPickPreset,
  onStart,
  onStop,
  effective,
  errorMessage,
  audioViaFfmpeg,
  isElectron,
  selectedAudioLabel,
}: StreamControlsProps) {
  // `aecEnabled` / `onToggleAec` are no longer surfaced in the UI (the AEC
  // worklet was removed and the Electron path is echo-free by construction),
  // but the prop shape is preserved for back-compat with callers/tests.
  void aecEnabled;

  if (!isHost) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">
        Вы не хост. Хост может передать вам роль во вкладке «Участники».
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Демонстрация экрана
        </h2>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            hostStreaming
              ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
              : 'bg-slate-700/30 text-slate-400 border border-slate-700'
          }`}
        >
          {hostStreaming ? '● LIVE' : '○ остановлено'}
        </span>
      </div>

      {/* Phase 3 (rewritten): audio is auto-selected from the video source.
          No manual picker — just a status indicator while streaming. */}
      {isElectron && hostStreaming && (
        <div className="rounded-lg border border-slate-700/60 bg-slate-950/60 px-3 py-2 text-xs">
          {audioViaFfmpeg ? (
            <div className="flex items-center gap-2">
              <span className="text-emerald-300">🔊 Звук: ✓ включён автоматически</span>
              {selectedAudioLabel && (
                <span className="truncate text-[10px] text-slate-400" title={selectedAudioLabel}>
                  · {selectedAudioLabel}
                </span>
              )}
            </div>
          ) : (
            <span className="text-slate-400">
              Звук выбирается автоматически по источнику видео…
            </span>
          )}
        </div>
      )}

      {!hostStreaming ? (
        <>
          <p className="text-xs text-slate-400">
            Выберите качество. Реальное разрешение может быть ниже, если ваш монитор меньше запрошенного
            (например, для 1440p нужен монитор 2K и выше).
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {QUALITY_PRESET_ORDER.map((id) => {
              const preset = QUALITY_PRESETS[id];
              const isActive = activePreset === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onPickPreset(id)}
                  className={`text-left rounded-lg border px-3 py-2 transition ${
                    isActive
                      ? 'border-indigo-500 bg-indigo-500/10'
                      : 'border-slate-700 bg-slate-950 hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-100">{preset.label}</span>
                    <span className="text-[10px] text-slate-500">{bitrateMbps(preset)} Mbps</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-500">{preset.hint}</p>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            disabled={!activePreset}
            onClick={() => activePreset && onStart(activePreset)}
            className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
          >
            Начать стрим{activePreset ? ` · ${QUALITY_PRESETS[activePreset].label}` : ''}
          </button>
        </>
      ) : (
        <>
          {effective && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Stat label="Разрешение" value={`${effective.width}×${effective.height}`} />
              <Stat label="Частота кадров" value={`${Math.round(effective.frameRate)} fps`} />
              <Stat
                label="Звук источника"
                value={effective.hasAudio ? '✓ включён' : '✕ нет'}
              />
              <Stat label="Активный пресет" value={activePreset ?? '—'} />
            </div>
          )}

          {effective?.hasAudio && audioViaFfmpeg && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300/90">
              <div className="font-medium">
                Звук через WASAPI loopback{selectedAudioLabel ? ` — ${selectedAudioLabel}` : ''}
              </div>
              <div className="mt-0.5 text-[10px] text-emerald-300/70">
                Захват без эха: для окна приложения — только его звук, для всего
                экрана — весь звук, кроме этого приложения (как в Discord).
              </div>
            </div>
          )}

          {!audioViaFfmpeg && effective?.hasAudio && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/90">
              <div className="font-medium">Звук захвачен с системным loopback</div>
              <div className="mt-0.5 text-[10px] text-amber-300/70">
                Друг может слышать эхо своего голоса. Для чистого звука без эха —
                используй desktop-клиент (Electron) с WASAPI loopback.
              </div>
            </div>
          )}
          {activePreset && (
            <div className="flex flex-wrap gap-1.5">
              {QUALITY_PRESET_ORDER.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onPickPreset(id)}
                  className={`rounded border px-2 py-1 text-[11px] transition ${
                    activePreset === id
                      ? 'border-indigo-500 bg-indigo-500/15 text-indigo-200'
                      : 'border-slate-700 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  {QUALITY_PRESETS[id].label}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={onStop}
            className="w-full rounded-lg bg-rose-600 px-4 py-2.5 font-medium text-white transition hover:bg-rose-500"
          >
            Остановить стрим
          </button>
        </>
      )}

      {errorMessage && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {errorMessage}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-950 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-sm text-slate-100">{value}</div>
    </div>
  );
}
