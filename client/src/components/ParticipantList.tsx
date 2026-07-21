import type { Participant } from '../hooks/useRoom';
import { AudioMeter } from './AudioMeter';

export interface ParticipantListProps {
  participants: Participant[];
  selfId: string | null;
  hostId: string | null;
  ownerId: string | null;
  isOwner: boolean;
  subscribers: string[];
  onTransferHost: (participantId: string) => void;
  /** Local mic track for the "you" VU meter. Null when mic is off. */
  localTrack: MediaStreamTrack | null;
  /** Remote audio tracks keyed by participant id. */
  remoteTracks: ReadonlyMap<string, MediaStreamTrack>;
}

function roleBadge(role: Participant['role']): string {
  switch (role) {
    case 'owner':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    case 'host':
      return 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30';
    default:
      return 'bg-slate-700/30 text-slate-400 border-slate-700';
  }
}

function roleLabel(role: Participant['role']): string {
  switch (role) {
    case 'owner':
      return 'Владелец';
    case 'host':
      return 'Хост';
    default:
      return 'Зритель';
  }
}

export function ParticipantList({
  participants,
  selfId,
  isOwner,
  onTransferHost,
  subscribers,
  localTrack,
  remoteTracks,
}: ParticipantListProps) {
  return (
    <aside className="w-full md:w-72 shrink-0 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
        В комнате · {participants.length}
      </h2>
      <ul className="space-y-2">
        {participants.map((p) => {
          const isMe = p.id === selfId;
          const isCurrentHost = p.role === 'host' || p.role === 'owner';
          const canPromote = isOwner && !isCurrentHost && p.id !== selfId;
          const isSubscribed = subscribers.includes(p.id);
          const track = isMe ? localTrack : remoteTracks.get(p.id) ?? null;
          const muted = track === null;
          return (
            <li key={p.id} className="rounded-lg px-2.5 py-2 hover:bg-slate-800/40">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`h-2 w-2 rounded-full ${muted ? 'bg-slate-600' : isMe ? 'bg-emerald-400' : 'bg-emerald-500'}`}
                    aria-hidden
                  />
                  <span className="truncate text-sm text-slate-200">
                    {p.name}
                    {isMe && <span className="text-slate-500"> (вы)</span>}
                    {muted && <span className="text-slate-600"> 🔇</span>}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {isSubscribed && (
                    <span
                      className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
                      title="Смотрит стрим хоста"
                    >
                      👁
                    </span>
                  )}
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${roleBadge(p.role)}`}
                  >
                    {roleLabel(p.role)}
                  </span>
                  {canPromote && (
                    <button
                      type="button"
                      onClick={() => onTransferHost(p.id)}
                      title="Сделать хостом"
                      className="rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300 hover:bg-indigo-500/20"
                    >
                      → хост
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-1.5">
                <AudioMeter track={track} variant="compact" />
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
