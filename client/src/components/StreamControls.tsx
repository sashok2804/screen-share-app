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
   * Phase 3 — `true` when system audio is captured via the Electron FFmpeg /
   * WASAPI bridge (no browser fallback path, no echo loop).
   */
  audioViaFfmpeg?: boolean;
  /** Phase 3 — running inside the Electron desktop client. */
  isElectron?: boolean;
  /** Phase 3 — DirectShow audio device names for the dropdown. */
  audioDevices?: string[];
  /** Phase 3 — the user's selection, or null for "auto". */
  selectedAudioDevice?: string | null;
  /** Phase 3 — change the selection. `null` restores "auto". */
  onPickAudioDevice?: (name: string | null) => void;
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
  aecEnabled,
  audioViaFfmpeg,
  isElectron,
  audioDevices,
  selectedAudioDevice,
  onPickAudioDevice,
}: StreamControlsProps) {
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

      {isElectron && audioDevices && audioDevices.length > 0 && onPickAudioDevice && (
        <div className="space-y-1">
          <label
            htmlFor="audio-device-select"
            className="block text-[11px] font-medium text-slate-400"
          >
            Источник звука (системный аудио через FFmpeg)
          </label>
          <select
            id="audio-device-select"
            value={selectedAudioDevice ?? ''}
            onChange={(e) => onPickAudioDevice(e.target.value || null)}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
          >
            <option value="">Авто (Voicemeeter / CABLE)</option>
            {audioDevices.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          {hostStreaming && (
            <p className="text-[10px] text-slate-500">
              Изменения вступят в силу при следующем запуске стрима.
            </p>
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
                value={effective.hasAudio ? '✓ есть' : '✕ нет (Window-источник)'}
              />
              <Stat label="Активный пресет" value={activePreset ?? '—'} />
            </div>
          )}

          {effective?.hasAudio && audioViaFfmpeg && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300/90">
              <div className="font-medium">Звук через FFmpeg (WASAPI)</div>
              <div className="mt-0.5 text-[10px] text-emerald-300/70">
                Системный звук захватывается напрямую через FFmpeg без эха, без
                loopback-петли, как в браузере.
              </div>
            </div>
          )}

          {!audioViaFfmpeg && effective?.hasAudio && aecEnabled !== undefined && (
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
