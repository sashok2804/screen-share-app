# Project Context — screen-share-app

**Path**: `C:/Users/natka/ZCodeProject/screen-share-app/`
**Repo**: https://github.com/sashok2804/screen-share-app (main branch)
**Stack**: WebRTC P2P mesh, React 19 + Vite + Tailwind v4 (client), Node.js 22 + Fastify + ws (server).

## What's already done

### Server (`server/`)
- Fastify + ws signaling on port 3000 (HTTPS with self-signed cert from `server/certs/`).
- Room state machine with roles: owner (first joiner) → can transfer host to anyone.
- Mesh P2P signaling: offer/answer/ICE relay, subscribe/unsubscribe to host video.
- 47 unit + e2e tests, all green. Coverage ~93%.

### Client (`client/`)
- React 19 + TypeScript + Vite + Tailwind v4.
- Hooks: `useSignaling`, `useRoom`, `useMesh` (perfect-negotiation), `useVoice`, `useScreenShare`, `useAudioLevel`.
- Components: `Lobby`, `Room`, `VideoStage`, `ParticipantList`, `StreamControls`, `SubscribeButton`, `AudioMeter`.
- Quality presets: 720p30 / 1080p30 / 1080p60 / **1440p60 (ultra)** / 4K30.
- Codec preference: AV1 → VP9 → H.264.
- STUN: Cloudflare primary, Google fallback (some RU ISPs block Google STUN).

### Known limitation (the one we're fixing now)
Screen-share with system audio (`getDisplayMedia` audio on Entire Screen) creates a feedback loop: the remote peer hears themselves through the host's speakers → loopback → back to them. Browser-side AEC doesn't work for loopback capture. We tried NLMS AudioWorklet — it failed (cut the demo audio too). The proper fix is **process-loopback capture via WASAPI on Windows**, exposed through an Electron desktop client.

## Phase: Electron desktop client (Windows)

### Directory layout we're building
```
screen-share-app/
├── server/         (existing, unchanged)
├── client/         (existing, gets new components)
├── electron/       (NEW — Electron main + preload + ffmpeg bridge)
│   ├── package.json
│   ├── main.cjs
│   ├── preload.cjs
│   ├── builder.yml
│   └── src/
│       ├── ffmpeg-bridge.ts
│       └── dshow-devices.ts
└── CONTEXT.md      (this file)
```

### IPC contract (preload exposes `window.electronAPI`)
- `getSources(): Promise<Array<{id, name, thumbnailDataURL}>>` — wraps `desktopCapturer.getSources`.
- `listAudioDevices(): Promise<string[]>` — DirectShow audio device names via FFmpeg.
- `startProcessAudio(deviceName: string): Promise<{ok: boolean, sampleRate: number, channels: number}>`.
- `stopProcessAudio(): Promise<void>`.
- Event `ffmpeg:audio-chunk` (Float32Array payload) — emitted by main process, renderer subscribes via `window.electronAPI.onAudioChunk(cb)`.

### Custom URL protocol
- `screen-share://room/<roomId>` should open the app and navigate to `https://SERVER_URL/?room=<roomId>`.
- Register via `app.setAsDefaultProtocolClient('screen-share')` at startup.
- Handle `second-instance` (Windows) and `open-url` (macOS) events.

## Build environment
- Windows 10, Git Bash shell.
- Node 22.11.0, npm 10.9.0.
- Python 3.11 available.
- **No Visual Studio Build Tools** (so no native node addon compilation — must use FFmpeg subprocess for WASAPI).
- FFmpeg NOT installed system-wide (we'll bundle it in the installer).

## Git workflow
- One commit per logical change.
- `git add <specific-files>` then `git commit -m "<type>(<scope>): <description>"`.
- Don't commit `node_modules/`, `dist/`, `*.pem`.
- Push to origin/main only when instructed.
