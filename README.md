# Screen Share App — P2P WebRTC комнаты с 1440p@60fps

Веб-приложение для демонстрации экрана в режиме P2P (mesh) с целевым качеством
**1440p · 60 fps**. Сигналинг через Node.js/Fastify/ws, медиа — напрямую между
браузерами через WebRTC.

> **Хостам на Windows**: используйте десктоп-клиент (см.
> [Desktop client](#desktop-client-windows-recommended-for-hosts) ниже) — он
> захватывает системный звук через WASAPI без эха. Веб-сборка на Chrome при
> включённом «share audio» создаёт петлю: удалённый зритель слышит сам себя
> через ваши колонки → loopback → обратно. AEC браузера для loopback не работает.

## Возможности

- Комнаты без авторизации: вводишь `roomId` + имя → зашёл.
- Первый зашедший = **владелец + хост**. Владелец может передать хоста любому
  участнику.
- Каждый зритель **сам решает**, смотреть стрим или нет (подписка на видео-трансивер).
  Без подписки трафик видео не идёт.
- Голос (микрофон) — всегда双向, для всех участников.
- Пресеты качества: 720p30 / 1080p30 / 1080p60 / **1440p60** / 4K30.
- Энкодер: AV1 → VP9 → H.264 (auto-fallback по capabilities браузера).

## Стек

- **Frontend**: React 19 + TypeScript + Vite 6 + Tailwind CSS v4.
- **Backend (signaling)**: Node.js 22 + Fastify 4 + ws 8.
- **Тесты**: Vitest 2 (unit + e2e).
- **Архитектура**: mesh P2P (один `RTCPeerConnection` на пару юзеров).

## Запуск (dev)

```bash
# из корня проекта
npm install
npm run dev
```

Поднимается два сервера:
- Vite dev: `http://localhost:5173` (с прокси на `/ws` → `ws://localhost:3000`).
- Fastify: `http://localhost:3000` (сигналинг + статика `client/dist`).

Открой `http://localhost:5173?room=my-team` в двух вкладках Chrome, введи разные
имена, в одной включи демонстрацию экрана (ultra = 1440p60), во второй нажми
«Смотреть стрим».

## Production single-port с HTTPS

Браузеры требуют **secure context** (HTTPS или localhost) для `getDisplayMedia`/
`getUserMedia`. Через публичный IP по HTTP микрофон/экран работать не будут —
нужен HTTPS.

### 1. Сгенерировать self-signed сертификат

```bash
cd server
mkdir -p certs && cd certs

# OpenSSL (Git Bash на Windows, MSYS_NO_PATHCONV=1 обязателен)
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem -days 825 \
  -subj "/CN=Screen Share" \
  -addext "subjectAltName=DNS:localhost,IP:ВАШ_ПУБЛИЧНЫЙ_IP,IP:127.0.0.1"
```

Или через **mkcert** (рекомендуется для себя — он автоматически доверяется в
твоей системе):
```bash
mkcert -install
mkcert -cert-file server/certs/cert.pem -key-file server/certs/key.pem \
  localhost 127.0.0.1 ВАШ_ПУБЛИЧНЫЙ_IP
```

Сервер автоматически подхватит `cert.pem`+`key.pem` из `server/certs/` (можно
переопределить через env `SSL_CERT_FILE`/`SSL_KEY_FILE`).

### 2. Запуск

```bash
npm run build
PORT=3000 HOST=0.0.0.0 node server/dist/index.js
# → "Server listening at https://0.0.0.0:3000" tls:true
```

### 3. Друзья заходят

```
https://ВАШ_ПУБЛИЧНЫЙ_IP:3000/?room=имя-комнаты
```

При первом заходе Chrome покажет **«Подключение не защищено»** (self-signed):
1. Кнопка «Дополнительные»
2. «Перейти на сайт (небезопасно)»
3. После этого `getDisplayMedia`/`getUserMedia` заработают

Чтобы избавиться от предупреждения у друзей — отправь им файл
`server/certs/cert.pem` и попроси установить его в систему как доверённый
корневой сертификат (двойной клик → «Установить сертификат» → «Доверенные
корневые центры сертификации»). После перезапуска Chrome предупреждения не будет.

## Production-сборка

По умолчанию слушает `0.0.0.0:3000`. Переопределить:

```bash
PORT=8080 HOST=0.0.0.0 node server/dist/index.js
```

## Desktop client (Windows, recommended for hosts)

For best audio quality (no echo when sharing screen with audio), use the
Electron desktop client instead of the web browser.

The web build's audio limitation: Chrome's `getDisplayMedia({audio:true})` on
"Entire screen" creates a feedback loop — the remote peer hears themselves
through the host's speakers → loopback → back to them. Browser-side AEC doesn't
fix this for loopback capture. The desktop client captures system audio out of
process via FFmpeg (WASAPI loopback), so the host's mic path is isolated from
the system-audio path — no echo.

### Build the installer

```bash
npm install                                    # at repo root
npm -w electron run download-ffmpeg           # fetches ffmpeg.exe (~80 MB)
npm -w electron run build                     # produces electron/dist/*.exe
```

The resulting `Screen Share Setup X.X.X.exe` bundles:
- The Electron runtime
- The React client (loaded from https://YOUR_SERVER:3000)
- FFmpeg for WASAPI loopback audio capture
- Custom URL protocol `screen-share://`

Requirements:
- Windows 10+ x64.
- Node 22.12+ recommended. Node 22.11 works too — the
  `postinstall` script (`electron/scripts/patch-app-builder.cjs`) stubs an
  ESM-only require inside `app-builder-lib` so `electron-builder` runs.
- The HTTPS server must be reachable at the URL the app loads
  (`https://localhost:3000` by default; override via `SCREENSHARE_URL`).
  Production deployments must use a certificate trusted by the user's OS —
  the dev self-signed bypass only runs when `!app.isPackaged`.

### Custom URL protocol

After installation the app registers the `screen-share://` scheme on first
launch (via `app.setAsDefaultProtocolClient`). Links like
`screen-share://room/my-room` open the app directly in the specified room.

How to verify after install:

1. Launch the app once (this writes the Windows registry mapping).
2. Open `screen-share://room/test123` in any browser.
3. Windows prompts to open with "Screen Share" → accept.
4. The app focuses and navigates to `?room=test123` on the server URL.

Note: `electron-builder`'s `build.protocols` block is **macOS-only** (writes
`Info.plist` entries). On Windows the scheme is registered at runtime — the
NSIS installer itself does not write the registry key. This matches how
Discord/Slack/VS Code handle Windows deep-link registration.

```bash
PORT=8080 HOST=0.0.0.0 node server/dist/index.js
```

## Тесты

```bash
npm test                 # все unit-тесты (server + client)
npm -w server test       # только серверные unit
npm -w client test       # только клиентские unit
npm -w server run test:e2e   # e2e: поднимает реальный сервер, 2 WS-клиента
npm -w server run test:coverage  # покрытие серверного кода
```

**Текущее состояние**: 65 unit-тестов + 2 e2e, всё зелёное. Покрытие серверной
логики ~93% строк.

## Проверка качества стрима (smoke)

После запуска дев-сервера:

1. Открой `http://localhost:5173?room=test` в двух вкладках Chrome.
2. В первой — стань хостом (по умолчанию), выбери пресет **ultra (1440p60)**,
   нажми «Начать стрим», в нативном диалоге выбери «Entire screen».
3. Во второй — нажми «Смотреть стрим».
4. Открой `chrome://webrtc-internals` в обоих вкладках:
   - У хоста: `outbound-rtp` → `bytesSent` растёт, `framesEncoded` ≈ 60/сек,
     `codec` = `AV1` или `VP9`.
   - У зрителя: `inbound-rtp` → `bytesReceived` ≈ 16 Mbps при ultra.
5. Нажми «Отписаться» у зрителя → битрейт падает до 0.

## Пресеты качества

| Пресет | Разрешение | FPS | Битрейт | Назначение |
|---|---|---|---|---|
| `low` | 1280×720 | 30 | 2.5 Mbps | Слабый канал |
| `medium` | 1920×1080 | 30 | 5 Mbps | Презентации, код |
| `high` | 1920×1080 | 60 | 8 Mbps | Геймплей 1080p |
| **`ultra`** | **2560×1440** | **60** | **16 Mbps** | **Целевой 2K режим** |
| `max` | 3840×2160 | 30 | 28 Mbps | 4K (только если монитор 4K) |

Реальное разрешение = `min(запрос, источник)`. Если монитор 1080p, пресет
`ultra` вернёт максимум 1080p — это видно в UI как effective resolution.

## STUN/TURN

По умолчанию: Google STUN (`stun:stun.l.google.com:19302`). Этого хватает для
большинства домашних сетей.

Для прохождения через симметричный NAT (~10–15% юзеров) нужно поднять TURN.
В клиенте настраивается через env Vite:

```bash
# .env в client/
VITE_TURN_URL=turn:your.turn.server:3478
VITE_TURN_USERNAME=user
VITE_TURN_CREDENTIAL=pass
```

Cвой TURN проще всего поднять через [coturn](https://github.com/coturn/coturn)
на VPS.

## Архитектура

```
                 ┌────────────────┐
                 │  Fastify + ws  │  signaling only (no media)
                 └────────┬───────┘
                          │ WS (join / offer / answer / ICE / events)
              ┌───────────┴───────────┐
              ▼                       ▼
        ┌──────────┐             ┌──────────┐
        │  Host    │◄─── P2P ───►│ Viewer  │
        │  Chrome  │   (WebRTC)  │  Chrome  │
        └──────────┘             └──────────┘
```

- Сервер видит только сигналинг. Медиа идёт напрямую между пирами.
- Один `RTCPeerConnection` на пару юзеров: audio всегда双向, video —
  `sendonly` (хост) ↔ `recvonly` (подписчик).
- Subscribe/unsubscribe меняет направление трансивера / `replaceTrack(null)` —
  трафик видео физически останавливается.
- Glare control: existing peer — polite (yields), newcomer — impolite (wins).
- Stream lifecycle: `stream-start` / `stream-stop` / `quality-change` /
  `host-changed` события рассылаются всем в комнате.

## Ограничения (это не баги)

### 🔇 Звук при шаринге отдельного окна

Chrome не умеет захватывать звук конкретного приложения через
`getDisplayMedia()`. Доступно только:

| Источник в диалоге Chrome | Видео | Звук |
|---|---|---|
| **Entire screen** (весь экран) | ✓ | ✓ системный звук |
| **Tab** (вкладка браузера) | ✓ | ✓ звук вкладки |
| **Window** (отдельное окно) | ✓ | ✗ без звука |

Обход — только Electron-клиент с нативным process-loopback capture (как у
Discord). В вебе — никак.

### 📊 Mesh ограничение

При mesh P2P хост отдаёт **отдельный поток каждому зрителю**. 5 зрителей ×
16 Mbps = 80 Mbps аплинка у хоста. При 1 Gbps канале это терпимо до ~5–7
зрителей. Дальше нужен SFU (mediasoup/LiveKit/Janus) — это **Фаза 2**.

### 🖥 Реальное разрешение

`getDisplayMedia` не может выдать разрешение выше, чем источник (монитор).
Если у хоста монитор 1080p, пресет `ultra` (1440p) вернёт 1080p. Это видно в
UI как effective resolution.

## Структура проекта

```
screen-share-app/
├── package.json              # npm workspaces + postinstall (patches app-builder-lib)
├── README.md
├── CONTEXT.md                # project context (audio loopback problem, Electron plan)
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts      # unit-тесты (exclude e2e)
│   ├── vitest.e2e.config.ts  # e2e (boots real server)
│   ├── src/
│   │   ├── index.ts          # Fastify + ws binding
│   │   ├── rooms.ts          # RoomStore: rooms, roles, participants
│   │   ├── signaling.ts      # SignalingHub: message dispatch (pure)
│   │   └── protocol.ts       # wire types (shared with client)
│   └── test/
│       ├── rooms.test.ts     # 27 tests
│       ├── signaling.test.ts # 18 tests
│       └── e2e.smoke.ts      # 2 tests (real server)
├── client/
│   ├── package.json
│   ├── vite.config.ts
│   ├── vitest.config.ts
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── components/{Lobby,Room,VideoStage,ParticipantList,StreamControls,SourcePicker,AudioMeter}.tsx
│   │   ├── hooks/{useSignaling,useRoom,useMesh,useVoice,useScreenShare,useProcessAudio,useAudioLevel}.ts
│   │   ├── workers/process-audio-worklet.js   # PCM → AudioWorklet ring
│   │   ├── lib/{quality,rtc}.ts
│   │   └── styles/index.css
│   └── test/
│       ├── quality.test.ts   # 10 tests
│       ├── rtc.test.ts       # 10 tests
│       └── setup.ts
└── electron/                 # Windows desktop client (Phase 4)
    ├── package.json          # build config (NSIS), download-ffmpeg script
    ├── builder.yml           # human-readable mirror of package.json `build`
    ├── main.cjs              # Electron main + IPC + FFmpeg/WASAPI bridge
    ├── preload.cjs           # contextBridge → window.electronAPI
    ├── bin/                  # downloaded ffmpeg.exe (gitignored, ~97 MB)
    ├── build/icon.ico        # placeholder 16..256 icon
    ├── scripts/
    │   ├── download-ffmpeg.cjs     # fetch + extract ffmpeg from gyan.dev
    │   └── patch-app-builder.cjs   # postinstall: fixes app-builder-lib ESM bug
    └── src/
        ├── ffmpeg-bridge.cjs       # FFmpegAudioCapture class (f32le PCM stream)
        └── dshow-devices.cjs       # list DirectShow audio devices
```

## Что дальше (Фаза 2)

- **SFU-режим** через mediasoup: для 10+ зрителей. Переключатель mesh/SFU в UI.
- **Запись стрима** (VOD): MediaRecorder → chunked upload → каталог прошлых
  записей.
- ~~**Электрон-клиент хоста**: для звука отдельного окна приложения (process
  loopback).~~ ✅ Done — см. [Desktop client](#desktop-client-windows-recommended-for-hosts).
- **SVC** (VP9/AV1 слои): сервер раздаёт разным зрителям разные слои качества по
  их каналу.
- **Code signing**: NSIS installer сейчас подписан self-signed/test cert.
  Для распространения нужен Authenticode cert (EV или OV) — иначе SmartScreen
  будет ругаться.
