import { useState } from 'react';

export interface LobbyProps {
  onJoin: (roomId: string, name: string) => void;
  /** Initial values used to deep-link into a room (?room=foo). */
  initialRoomId?: string;
}

export function Lobby({ onJoin, initialRoomId }: LobbyProps) {
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState(initialRoomId ?? '');

  const canJoin = name.trim().length > 0 && roomId.trim().length > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canJoin) return;
    onJoin(roomId.trim(), name.trim());
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur p-8 shadow-2xl">
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-white">Screen Share</h1>
          <p className="mt-2 text-sm text-slate-400">
            Демонстрация экрана <span className="text-indigo-400 font-medium">1440p · 60 fps</span> P2P
            через WebRTC
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="name" className="block text-xs font-medium text-slate-300 mb-1.5">
              Ваше имя
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 32))}
              placeholder="Например, Анна"
              maxLength={32}
              autoFocus
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label htmlFor="roomId" className="block text-xs font-medium text-slate-300 mb-1.5">
              ID комнаты
            </label>
            <input
              id="roomId"
              type="text"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value.slice(0, 64))}
              placeholder="Например, my-team"
              maxLength={64}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <p className="mt-1.5 text-xs text-slate-500">
              Первый, кто заходит в комнату, становится её владельцем и хостом.
            </p>
          </div>

          <button
            type="submit"
            disabled={!canJoin}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
          >
            Войти в комнату
          </button>
        </form>

        <div className="mt-8 border-t border-slate-800 pt-4">
          <p className="text-xs text-slate-500">
            Лучше всего работает в <span className="text-slate-300">Chrome / Edge 117+</span> — там
            доступен AV1/VP9 энкодер, который и даёт честные 1440p@60.
          </p>
        </div>
      </div>
    </div>
  );
}
