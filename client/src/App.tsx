import { useEffect, useState } from 'react';
import { Lobby } from './components/Lobby';
import { Room } from './components/Room';

interface Session {
  roomId: string;
  name: string;
}

function readInitialRoomFromUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.search);
  return params.get('room') ?? undefined;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [initialRoom] = useState<string | undefined>(readInitialRoomFromUrl);

  // Reflect the current room in the URL for shareable links.
  useEffect(() => {
    if (!session) return;
    const url = new URL(window.location.href);
    url.searchParams.set('room', session.roomId);
    window.history.replaceState({}, '', url.toString());
  }, [session]);

  if (!session) {
    return (
      <Lobby
        initialRoomId={initialRoom}
        onJoin={(roomId, name) => setSession({ roomId, name })}
      />
    );
  }

  return (
    <Room
      roomId={session.roomId}
      name={session.name}
      onLeave={() => setSession(null)}
    />
  );
}
