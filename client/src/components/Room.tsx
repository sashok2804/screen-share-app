import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSignaling } from '../hooks/useSignaling';
import { useRoom } from '../hooks/useRoom';
import { useMesh, type MeshCallbacks } from '../hooks/useMesh';
import { useVoice } from '../hooks/useVoice';
import { useScreenShare } from '../hooks/useScreenShare';
import { useAudioMixer } from '../hooks/useAudioMixer';
import type { QualityPresetId } from '../lib/quality';
import { VideoStage } from './VideoStage';
import { ParticipantList } from './ParticipantList';
import { StreamControls } from './StreamControls';
import { SubscribeButton } from './SubscribeButton';
import { SourcePicker } from './SourcePicker';

export interface RoomProps {
  roomId: string;
  name: string;
  onLeave: () => void;
}

export function Room({ roomId, name, onLeave }: RoomProps) {
  const signaling = useSignaling();
  const room = useRoom(signaling);

  // Wire the mesh to the current room state via a ref to avoid stale closures.
  const callbacksRef = useRef<MeshCallbacks>({
    isHost: () => room.isHost,
    isSubscribed: () => room.subscribed,
    isRemoteHost: (peerId) => peerId === room.hostId,
  });
  useEffect(() => {
    callbacksRef.current.isHost = () => room.isHost;
    callbacksRef.current.isSubscribed = () => room.subscribed;
    callbacksRef.current.isRemoteHost = (peerId) => peerId === room.hostId;
  }, [room.isHost, room.subscribed, room.hostId]);

  const mesh = useMesh(signaling, () => room.selfId, callbacksRef);
  // The mixer is the single source of WebRTC audio: mic + screen audio are
  // combined into ONE MediaStreamTrack before being handed to the mesh. This
  // prevents the "two audio senders in one PeerConnection" bug that broke SDP
  // renegotiation whenever the host streamed screen + mic at the same time.
  const mixer = useAudioMixer();
  // `useVoice` no longer takes `mesh` — it only captures the mic track. The
  // mixer + the publish effect below do the WebRTC plumbing.
  const voice = useVoice();
  const screen = useScreenShare(mesh, room, voice.getRemoteStream);

  // Route the live mic track into the mixer. The disconnect fn from
  // connectMicrophone is returned as the effect cleanup, so toggling the mic
  // off detaches it from the bus automatically.
  useEffect(() => {
    if (!voice.localTrack) return;
    return mixer.connectMicrophone(voice.localTrack);
  }, [voice.localTrack, mixer]);

  // Route the screen-share audio track (Electron WASAPI bridge OR browser
  // getDisplayMedia audio) into the mixer. Same disconnect-on-cleanup pattern.
  useEffect(() => {
    if (!screen.audioTrackForMixer) return;
    return mixer.connectScreenAudio(screen.audioTrackForMixer);
  }, [screen.audioTrackForMixer, mixer]);

  // Publish the single mixed track to the mesh. The mixedTrack reference is
  // stable for the mixer's lifetime (sources connect/disconnect around it), so
  // this effect fires ONCE per session unless the whole mixer is torn down —
  // toggling mic or screen audio does not re-trigger renegotiation.
  useEffect(() => {
    if (!mixer.mixedTrack) return;
    mesh.publishAudio(mixer.mixedTrack);
    return () => {
      mesh.unpublishAudio();
    };
  }, [mixer.mixedTrack, mesh]);

  // Route remote tracks to the appropriate sinks.
  useEffect(() => {
    const unsubscribe = signaling.onMessage(() => {
      // The actual routing happens via mesh.onTrack; we keep this subscription
      // only to ensure re-render when peer-list changes (handled by useRoom).
    });
    return unsubscribe;
  }, [signaling]);

  // Attach mesh.onTrack to voice/screen sinks + VU meter tracking.
  useEffect(() => {
    const prev = callbacksRef.current;
    const next: MeshCallbacks = {
      ...prev,
      onTrack: (peerId, track, kind) => {
        if (kind === 'audio') {
          voice.attachRemoteAudio(track);
          voice.registerRemote(peerId, track);
        } else if (kind === 'video') {
          screen.attachRemoteVideo(track);
        }
      },
      onTrackRemoved: (peerId, track) => {
        if (track.kind === 'audio') {
          voice.detachRemoteAudio(track);
          voice.unregisterRemote(peerId);
        } else if (track.kind === 'video') {
          screen.detachRemoteVideo(track);
        }
      },
      isHost: prev.isHost,
      isSubscribed: prev.isSubscribed,
      isRemoteHost: prev.isRemoteHost,
    };
    callbacksRef.current = next;
    // voice and screen are stable callbacks; safe to skip deps.
  }, [voice, screen]);

  // Join once the socket is up.
  useEffect(() => {
    room.join(roomId, name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, name]);

  // Leave cleans up.
  const handleLeave = useCallback(() => {
    screen.stopStream();
    voice.toggleMic && voice.micEnabled && voice.toggleMic();
    mesh.closeAll();
    signaling.disconnect();
    onLeave();
  }, [screen, voice, mesh, signaling, onLeave]);

  // Determine which video element is active.
  const videoMode: 'idle' | 'hosting' | 'viewing' = screen.isStreaming
    ? 'hosting'
    : room.hostStreaming && room.subscribed
      ? 'viewing'
      : 'idle';

  // The video element ref depends on mode.
  const stageRef = useMemo<React.RefObject<HTMLVideoElement | null>>(
    () =>
      videoMode === 'hosting'
        ? screen.localPreviewRef
        : screen.remoteVideoRef,
    [videoMode, screen.localPreviewRef, screen.remoteVideoRef],
  );

  const [pickedPreset, setPickedPreset] = useState<QualityPresetId | null>('ultra');

  const effectivePreset: QualityPresetId | null = screen.stream
    ? screen.stream.preset.id
    : pickedPreset;

  if (!room.selfId) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-400">
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-3">
            <span className="h-2 w-2 rounded-full bg-indigo-400 animate-pulse" />
            Подключение к комнате…
          </div>
          <div className="text-xs text-slate-600 font-mono">
            ws: {signaling.status}
            {signaling.lastError ? ` · ${signaling.lastError}` : ''}
          </div>
          <button
            type="button"
            onClick={() => signaling.connect()}
            className="text-xs text-indigo-400 underline"
          >
            Переподключить
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold">Screen Share</h1>
          <span className="rounded-md border border-slate-700 px-2 py-0.5 text-xs text-slate-400">
            Комната: <span className="text-slate-200">{room.roomId ?? roomId}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ConnectionDot status={signaling.status} />
          <button
            type="button"
            onClick={voice.toggleMic}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              voice.micEnabled
                ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {voice.micEnabled ? '🎤 Микрофон' : '🔇 Включить'}
          </button>
          <button
            type="button"
            onClick={handleLeave}
            className="rounded-lg bg-rose-600/90 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500"
          >
            Выйти
          </button>
        </div>
      </header>

      <main className="flex flex-1 flex-col md:flex-row gap-4 p-4 min-h-0">
        <div className="flex-1 flex flex-col gap-4 min-h-0">
          <VideoStage
            ref={stageRef}
            mode={videoMode}
            resolutionLabel={
              screen.stream ? `${screen.stream.width}×${screen.stream.height}` : undefined
            }
            fpsLabel={screen.stream ? `${Math.round(screen.stream.frameRate)}fps` : undefined}
            hasAudio={screen.stream?.hasAudio}
          />

          {!videoMode && room.hostStreaming && !room.isHost && (
            <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-indigo-200">Хост запустил стрим</p>
                <p className="text-xs text-slate-400">
                  Нажмите «Смотреть стрим», чтобы подключиться. Без подписки трафик не идёт.
                </p>
              </div>
              <SubscribeButton
                hostStreaming={room.hostStreaming}
                isHost={room.isHost}
                subscribed={room.subscribed}
                onSubscribe={room.subscribeToStream}
                onUnsubscribe={room.unsubscribeFromStream}
              />
            </div>
          )}

          <StreamControls
            isHost={room.isHost}
            hostStreaming={screen.isStreaming}
            activePreset={effectivePreset}
            onPickPreset={(id) => {
              setPickedPreset(id);
              if (screen.isStreaming) void screen.changeQuality(id);
            }}
            onStart={(id) => void screen.startStream(id)}
            onStop={screen.stopStream}
            effective={
              screen.stream
                ? {
                    width: screen.stream.width,
                    height: screen.stream.height,
                    frameRate: screen.stream.frameRate,
                    hasAudio: screen.stream.hasAudio,
                  }
                : null
            }
            errorMessage={screen.error}
            audioViaFfmpeg={screen.audioViaFfmpeg}
            isElectron={screen.isElectron}
            selectedAudioLabel={screen.selectedAudioLabel}
            showGainControls={!!mixer.mixedTrack && room.isHost}
            voiceGain={mixer.voiceGain}
            screenGain={mixer.screenGain}
            onVoiceGainChange={mixer.setVoiceGain}
            onScreenGainChange={mixer.setScreenGain}
          />
        </div>

        <div className="flex flex-col gap-4 md:w-72 shrink-0">
          <ParticipantList
            participants={room.participants}
            selfId={room.selfId}
            hostId={room.hostId}
            ownerId={room.ownerId}
            isOwner={room.isOwner}
            subscribers={room.subscribers}
            onTransferHost={room.transferHost}
            localTrack={voice.localTrack}
            remoteTracks={voice.remoteTracks}
          />

          {room.isHost && room.hostStreaming && (
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-400">
              <p className="font-medium text-slate-300 mb-1">Подписчиков: {room.subscribers.length}</p>
              <p>
                Каждый зритель тянет отдельный поток от вас напрямую (mesh). Битрейт ≈{' '}
                {screen.stream ? (screen.stream.preset.maxBitrate / 1_000_000).toFixed(1) : '—'} Mbps ×{' '}
                {room.subscribers.length || 0}
              </p>
            </div>
          )}
        </div>
      </main>

      {/* Hidden audio sink for remote voice. */}
      <audio ref={voice.remoteAudioRef} autoPlay className="hidden" />

      {/* Electron-only custom source picker (replaces native getDisplayMedia dialog).
          Audio is auto-selected from the chosen video source — no separate modal. */}
      {screen.sourcePickerOpen && (
        <SourcePicker
          onPick={(s) => screen.confirmSource(s)}
          onCancel={() => screen.cancelSource()}
        />
      )}

      {signaling.lastError && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300">
          {signaling.lastError}
        </div>
      )}
    </div>
  );
}

function ConnectionDot({ status }: { status: 'idle' | 'connecting' | 'open' | 'closed' | 'error' }) {
  const color =
    status === 'open'
      ? 'bg-emerald-400'
      : status === 'connecting'
        ? 'bg-amber-400 animate-pulse'
        : status === 'error'
          ? 'bg-rose-500'
          : 'bg-slate-600';
  return (
    <span className="flex items-center gap-1.5 text-xs text-slate-400">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {status === 'open' ? 'online' : status}
    </span>
  );
}
