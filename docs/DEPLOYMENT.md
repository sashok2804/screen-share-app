# Деплой и сборка

Полная инструкция: как развернуть сервер на VPS и собрать Windows-инсталлер для Electron-клиента.

---

## Содержание

- [Архитектура развёртывания](#архитектура-развёртывания)
- [Часть 1. VPS-сервер](#часть-1-vps-сервер)
  - [Требования к серверу](#требования-к-серверу)
  - [Подключение и первичный осмотр](#подключение-и-первичный-осмотр)
  - [Очистка от старого проекта](#очистка-от-старого-проекта)
  - [Установка Node.js](#установка-nodejs)
  - [Генерация self-signed сертификата](#генерация-self-signed-сертификата)
  - [Развёртывание кода](#развёртывание-кода)
  - [Systemd-сервис](#systemd-сервис)
  - [Nginx reverse-proxy](#nginx-reverse-proxy)
  - [Проверка снаружи](#проверка-снаружи)
  - [Обновление сервера при релизе](#обновление-сервера-при-релизе)
- [Часть 2. Let's Encrypt + домен (опционально)](#часть-2-lets-encrypt--домен-опционально)
- [Часть 3. Сборка Windows-инсталлера](#часть-3-сборка-windows-инсталлера)
  - [Требования к сборочной машине](#требования-к-сборочной-машине)
  - [Шаги сборки](#шаги-сборки)
  - [Кастомизация](#кастомизация)
- [Часть 4. Эксплуатация](#часть-4-эксплуатация)
  - [Логи](#логи)
  - [Управление сервисом](#управление-сервисом)
  - [Бэкап](#бэкап)
  - [Мониторинг](#мониторинг)
- [Приложение: cheatsheet](#приложение-cheatsheet)

---

## Архитектура развёртывания

```
                   HTTPS :8443
   ┌────────────┐ ───────────────  ┌──────────────────────────┐
   │  Browser   │     WSS /ws      │  VPS 194.226.115.141     │
   │  Electron  │                  │                          │
   │  клиент    │                  │  ┌────────────────────┐  │
   └────────────┘                  │  │  nginx :8443       │  │
                                   │  │  TLS termination   │  │
                                   │  └─────────┬──────────┘  │
                                   │            │             │
                                   │  ┌─────────▼──────────┐  │
                                   │  │  Fastify :3000     │  │
                                   │  │  (localhost only)  │  │
                                   │  │  WS + static       │  │
                                   │  └─────────┬──────────┘  │
                                   │            │             │
                                   │  ┌─────────▼──────────┐  │
                                   │  │  systemd service   │  │
                                   │  │  screenshare.service│ │
                                   │  └────────────────────┘  │
                                   └──────────────────────────┘
```

**Слои:**
1. **nginx :8443** — публичный HTTPS endpoint, терминирует TLS, проксирует на localhost:3000
2. **Fastify :3000** — слушает только localhost, сам тоже HTTPS (double-TLS, но это safe)
3. **systemd** — автозапуск, рестарт при падении

**Почему так:** Fastify не выставлен наружу напрямую — все внешние подключения идут через nginx, который добавляет таймауты, rate-limiting (через `limit_req` если нужно), и единое логирование.

---

## Часть 1. VPS-сервер

### Требования к серверу

- **ОС**: Debian 12/13, Ubuntu 22.04+ (тестировалось на Debian 13 Trixie)
- **RAM**: от 512 MB (наше приложение занимает ~40 MB)
- **Диск**: от 2 GB свободных (код + node_modules + сборка)
- **Доступ**: root или sudo
- **Порты**: 22 (SSH), 8443 (HTTPS для клиентов)
- **Node.js**: 22.x

### Подключение и первичный осмотр

```bash
ssh root@<SERVER_IP>

# Базовый осмотр
cat /etc/os-release          # версия ОС
uname -a                     # ядро
df -h /                      # диск
free -h                      # память
nproc                        # ядра
ss -tlnp                     # слушающие порты
systemctl list-units --type=service --state=running  # что запущено
```

### Очистка от старого проекта

Если на сервере был другой проект — остановить и удалить его сервисы.

**Пример (neuro-planner → screen-share):**

```bash
# Остановить старый сервис
systemctl stop neuro-planner
systemctl disable neuro-planner
rm /etc/systemd/system/neuro-planner.service
systemctl daemon-reload

# Удалить код
rm -rf /var/www/neuro-planner /var/www/html

# Почистить nginx default-сайт
rm -f /etc/nginx/sites-enabled/default

# Очистить apt-кэш
apt-get clean
apt-get autoremove -y

# Проверить свободное место
df -h /
```

### Установка Node.js

```bash
# Проверить наличие
node --version   # нужно v22.x
npm --version

# Если нет — установить через NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Дополнительно
apt-get install -y git nginx certbot
```

### Генерация self-signed сертификата

Let's Encrypt не выдаёт сертификаты на IP-адрес — нужен домен. Если домена нет, используем self-signed.

```bash
mkdir -p /opt/screenshare/certs
cd /opt/screenshare/certs

# Генерация сертификата на 825 дней с SAN для конкретного IP
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem \
  -out cert.pem \
  -days 825 \
  -subj "/CN=<SERVER_IP>" \
  -addext "subjectAltName=IP:<SERVER_IP>"

# Проверить
openssl x509 -in cert.pem -noout -subject -ext subjectAltName
# Должно показать: subject=CN=194.226.115.141
#                    IP Address:194.226.115.141

# Права
chmod 600 key.pem
chmod 644 cert.pem
```

**Альтернатива с доменом и Let's Encrypt** — см. [Часть 2](#часть-2-lets-encrypt--домен-опционально).

### Развёртывание кода

```bash
mkdir -p /opt/screenshare
cd /opt/screenshare

git clone https://github.com/sashok2804/screen-share-app.git
cd screen-share-app

# Установить все зависимости (включая dev для сборки)
npm ci

# Собрать клиент (React → dist/)
npm run build --workspace client

# Собрать сервер (TS → dist/)
npm run build --workspace server

# Удалить dev-зависимости (опционально, экономит место)
# npm prune --omit=dev

# Проверить
ls client/dist/    # index.html, assets/
ls server/dist/    # index.js, rooms.js, signaling.js, protocol.js
```

### Systemd-сервис

Создать `/etc/systemd/system/screenshare.service`:

```ini
[Unit]
Description=Screen Share — WebRTC signaling server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/screenshare/screen-share-app
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=SSL_CERT_FILE=/opt/screenshare/certs/cert.pem
Environment=SSL_KEY_FILE=/opt/screenshare/certs/key.pem
Environment=LOG_LEVEL=info
ExecStart=/usr/bin/node /opt/screenshare/screen-share-app/server/dist/index.js
Restart=on-failure
RestartSec=5

# Жёсткие лимиты
LimitNOFILE=65536
MemoryMax=256M

[Install]
WantedBy=multi-user.target
```

Активировать:

```bash
systemctl daemon-reload
systemctl enable screenshare       # автозапуск
systemctl restart screenshare
systemctl status screenshare       # проверить

# Локальный smoke-тест
curl -sk https://127.0.0.1:3000/health
# Ожидается: {"status":"ok","rooms":0}
```

### Nginx reverse-proxy

Создать `/etc/nginx/sites-available/screenshare`:

```nginx
# Screen Share — HTTPS:8443 reverse proxy → Fastify :3000 (localhost)

server {
    listen 8443 ssl;
    http2 on;
    listen [::]:8443 ssl;
    server_name <SERVER_IP>;

    ssl_certificate     /opt/screenshare/certs/cert.pem;
    ssl_certificate_key /opt/screenshare/certs/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    client_max_body_size 2m;

    # WebSocket-специфичные таймауты (long-lived соединения)
    location / {
        proxy_pass https://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket upgrade
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
        proxy_connect_timeout 60s;
    }
}
```

Активировать:

```bash
ln -sf /etc/nginx/sites-available/screenshare /etc/nginx/sites-enabled/screenshare

# Проверить конфиг
nginx -t

# Применить
systemctl reload nginx
```

### Проверка снаружи

С любой внешней машины:

```bash
# HTTPS health
curl -sk https://<SERVER_IP>:8443/health
# Ожидается: {"status":"ok","rooms":0}

# WebSocket handshake
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('wss://<SERVER_IP>:8443/ws', { rejectUnauthorized: false });
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'join', payload: { roomId: 'test', name: 'Smoke' } }));
});
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  console.log('MSG:', m.type);
  if (m.type === 'joined') { ws.close(); process.exit(0); }
});
ws.on('error', (e) => { console.error('ERR', e.message); process.exit(1); });
"
# Ожидается: MSG: joined
```

### Обновление сервера при релизе

```bash
ssh root@<SERVER_IP>
cd /opt/screenshare/screen-share-app

# 1. Стянуть свежий код
git pull --rebase

# 2. Если изменились зависимости — пересстановить
# npm ci

# 3. Пересобрать клиент и сервер
npm run build --workspace client
npm run build --workspace server

# 4. Перезапустить сервис
systemctl restart screenshare

# 5. Smoke-тест
curl -sk https://127.0.0.1:3000/health
```

**Скрипт одной строкой:**

```bash
ssh root@<SERVER_IP> "cd /opt/screenshare/screen-share-app && git pull --rebase && npm run build --workspace client && systemctl restart screenshare && sleep 2 && curl -sk https://127.0.0.1:3000/health"
```

---

## Часть 2. Let's Encrypt + домен (опционально)

Если есть домен (A-запись → IP сервера), получаем бесплатный доверенный сертификат.

### 1. Настроить DNS

В панели регистратора домена создать A-запись:
```
screen.example.ru.  A  194.226.115.141
```

Дождаться распространения DNS (5–30 минут):
```bash
dig +short screen.example.ru
# Должно вернуть IP сервера
```

### 2. Получить сертификат

```bash
certbot certonly --nginx -d screen.example.ru

# Сертификаты будут в:
# /etc/letsencrypt/live/screen.example.ru/fullchain.pem
# /etc/letsencrypt/live/screen.example.ru/privkey.pem
```

### 3. Обновить nginx-конфиг

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name screen.example.ru;

    ssl_certificate     /etc/letsencrypt/live/screen.example.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/screen.example.ru/privkey.pem;
    # ... остальное как в основном конфиге
}
```

### 4. Автообновление

Certbot ставит systemd-таймер автоматически:
```bash
systemctl list-timers | grep certbot
```

Проверить обновление вручную:
```bash
certbot renew --dry-run
```

### 5. Серверу передать сертификаты Let's Encrypt

Либо через env в systemd:
```ini
Environment=SSL_CERT_FILE=/etc/letsencrypt/live/screen.example.ru/fullchain.pem
Environment=SSL_KEY_FILE=/etc/letsencrypt/live/screen.example.ru/privkey.pem
```

Либо выключить TLS в Fastify (просто HTTP), оставив только nginx:
```ini
# Убрать SSL_CERT_FILE и SSL_KEY_FILE
Environment=PORT=3000
Environment=HOST=127.0.0.1
```

И в nginx:
```nginx
proxy_pass http://127.0.0.1:3000;   # HTTP, не HTTPS
```

---

## Часть 3. Сборка Windows-инсталлера

### Требования к сборочной машине

- **ОС**: Windows 10/11 x64
- **Node.js**: 22.x
- **npm**: 10+
- **Git Bash** (для shell-команд)
- **PowerShell** 5+ (встроен в Windows)

### Шаги сборки

```bash
cd C:/Users/<user>/screen-share-app

# 1. Установить все зависимости (включая electron, electron-builder, loopback-capture)
npm install

# 2. Собрать клиент (React production build)
npm run build --workspace client

# 3. Собрать сервер (TypeScript → JavaScript)
npm run build --workspace server

# 4. Собрать Windows-инсталлер
npm run build --workspace electron
```

### Результат

```
electron/dist/
├── Screen Share Setup 0.1.0.exe   ← NSIS-инсталлер (~70 MB)
├── win-unpacked/                   ← распакованное приложение
│   ├── Screen Share.exe
│   ├── resources/
│   │   ├── app.asar                ← упакованный код
│   │   ├── elevate.exe
│   │   └── get-pid.ps1             ← скрипт для PID resolution
│   └── ...
└── builder-debug.yml
```

### Что внутри инсталлера

- **Electron runtime** + Chromium (~70 MB основного веса)
- **React-клиент** (~240 KB JS, ~32 KB CSS)
- **loopback-capture** native addon (~340 KB) — WASAPI Application Loopback
- **get-pid.ps1** — Win32 PowerShell скрипт для резолва PID по HWND
- **Custom URL protocol** `screen-share://` — регистрируется при установке

### Кастомизация

#### Изменить адрес сервера по умолчанию

В `electron/main.cjs`:
```js
const DEFAULT_URL = 'https://194.226.115.141:8443';  // ← изменить тут
```

#### Изменить иконку

Положить `icon.ico` (multi-resolution: 16/32/48/64/128/256) в `electron/build/icon.ico` и пересобрать.

#### Изменить appId / productName

В `electron/package.json`:
```json
{
  "build": {
    "appId": "com.yourcompany.screenshare",
    "productName": "Your Product Name",
    ...
  }
}
```

#### Версия

В `electron/package.json`:
```json
{
  "version": "0.2.0"
}
```

### Проблемы и решения

#### `app-builder-lib` ESM/CJS ошибка на Node 22.11

В репозитории есть `electron/scripts/patch-app-builder.cjs` (postinstall hook), который фиксит `@noble/hashes/blake2.js` require в `app-builder-lib`. Запускается автоматически после `npm install`.

Если падает — запустить вручную:
```bash
node electron/scripts/patch-app-builder.cjs
```

#### Native addon `loopback-capture` не грузится в packaged-режиме

Проверить в `electron/package.json`:
```json
{
  "build": {
    "asarUnpack": ["**/node_modules/loopback-capture/**"]
  }
}
```

Это кладёт `.node` файл вне asar-архива.

#### PowerShell script `get-pid.ps1` не найден

Проверить `extraResources` в `electron/package.json`:
```json
{
  "build": {
    "extraResources": [
      { "from": "scripts/get-pid.ps1", "to": "get-pid.ps1" }
    ]
  }
}
```

### Распространение

Готовый `Screen Share Setup 0.1.0.exe` распространять как есть. Пользователю нужно:

1. Запустить `Screen Share Setup 0.1.0.exe`
2. Установить (можно выбрать папку установки)
3. При первом запуске ввести адрес сервера: `https://<SERVER_IP>:8443`
4. Чекбокс «Доверять self-signed сертификатам» оставить включённым (если сервер использует self-signed)

**Без внешних зависимостей** — не требует установки Node.js, FFmpeg, или чего-либо ещё.

---

## Часть 4. Эксплуатация

### Логи

**Systemd:**
```bash
# Реальное время
journalctl -u screenshare -f

# Последние 100 строк
journalctl -u screenshare -n 100

# За сегодня
journalctl -u screenshare --since today

# Ошибки только
journalctl -u screenshare -p err
```

**Nginx:**
```bash
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log
```

### Управление сервисом

```bash
systemctl start screenshare      # запустить
systemctl stop screenshare       # остановить
systemctl restart screenshare    # перезапустить
systemctl status screenshare     # статус + последние логи
systemctl enable screenshare     # автозапуск при загрузке
systemctl disable screenshare    # отключить автозапуск
```

### Nginx

```bash
nginx -t                          # проверить конфиг
systemctl reload nginx            # применить без даунтайма
systemctl restart nginx           # полный рестарт
```

### Бэкап

Что бэкапить:
- `/opt/screenshare/certs/` — TLS сертификаты (или перевыпустить через certbot)
- `/opt/screenshare/screen-share-app/.env` (если есть)
- БД нет (состояние in-memory)

Скрипт бэкапа:
```bash
tar -czf /root/screenshare-backup-$(date +%F).tar.gz \
  /opt/screenshare/certs/ \
  /etc/nginx/sites-available/screenshare \
  /etc/systemd/system/screenshare.service
```

### Мониторинг

Минимальный healthcheck (cron каждые 5 минут):
```bash
*/5 * * * * curl -sk https://127.0.0.1:3000/health >/dev/null || systemctl restart screenshare
```

Или через systemd-watchdog + внешний мониторинг (UptimeRobot и т.п.).

### Firewall

Минимально необходимые правила (если включён ufw):
```bash
ufw allow 22/tcp       # SSH
ufw allow 8443/tcp     # HTTPS для клиентов
ufw enable
```

WebRTC-порты между клиентами идут **напрямую** (P2P), на сервере открывать не нужно — сервер видит только сигналинг.

---

## Приложение: cheatsheet

### Быстрый старт с нуля (VPS)

```bash
# 1. Подключиться
ssh root@<SERVER_IP>

# 2. Установить пакеты
apt-get update && apt-get install -y git nginx nodejs npm

# 3. Клонировать и собрать
mkdir -p /opt/screenshare && cd /opt/screenshare
git clone https://github.com/sashok2804/screen-share-app.git
cd screen-share-app && npm ci
npm run build --workspace client && npm run build --workspace server

# 4. Сгенерировать сертификат
mkdir -p /opt/screenshare/certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout /opt/screenshare/certs/key.pem \
  -out /opt/screenshare/certs/cert.pem -days 825 \
  -subj "/CN=<SERVER_IP>" -addext "subjectAltName=IP:<SERVER_IP>"

# 5. Создать systemd-сервис (см. выше)
nano /etc/systemd/system/screenshare.service
systemctl daemon-reload && systemctl enable --now screenshare

# 6. Создать nginx-конфиг (см. выше)
nano /etc/nginx/sites-available/screenshare
ln -sf /etc/nginx/sites-available/screenshare /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# 7. Проверить
curl -sk https://<SERVER_IP>:8443/health
```

### Быстрый старт с нуля (Electron-инсталлер)

```bash
# На Windows-машине:
cd C:/Users/<user>/screen-share-app
npm install
npm run build --workspace client
npm run build --workspace server
npm run build --workspace electron

# Результат:
ls "electron/dist/Screen Share Setup 0.1.0.exe"
```

### Обновление в одну строку

```bash
# VPS
ssh root@<SERVER_IP> "cd /opt/screenshare/screen-share-app && git pull --rebase && npm run build --workspace client && systemctl restart screenshare"

# Electron-инсталлер (локально)
cd C:/Users/<user>/screen-share-app && git pull && npm run build --workspace client && npm run build --workspace electron
```

### Откат

```bash
# VPS — откат к предыдущему коммиту
cd /opt/screenshare/screen-share-app
git log --oneline -10
git checkout <PREVIOUS_COMMIT>
npm run build --workspace client
systemctl restart screenshare
```

---

## Известные ограничения

1. **Self-signed сертификат** — браузеры ругаются. Electron-клиент обходит через `setCertificateVerifyProc`. Для браузерных пользователей нужен Let's Encrypt + домен.

2. **Mesh P2P** — масштабируется до ~5 зрителей (хост раздаёт каждому отдельный поток). Для 10+ зрителей нужен SFU (mediasoup/LiveKit).

3. **Только Windows для WASAPI loopback** — захват звука конкретного приложения работает только на Windows 10 2004+ (требование `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`).

4. **Кастомный URL-протокол `screen-share://`** — регистрируется при установке. Deep-link работает только если приложение установлено (не в portable-режиме).

5. **STUN Cloudflare** — Google STUN блокируется некоторыми RU/CIS провайдерами. Cloudflare STUN `stun.cloudflare.com:3478` — primary, Google — fallback.
