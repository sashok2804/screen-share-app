// @ts-check
/**
 * Download a static Windows FFmpeg build and extract `bin/ffmpeg.exe` next to
 * the Electron app so it can be bundled by `electron-builder` as an
 * `extraResource`. The result lands at `<electron>/bin/ffmpeg.exe`.
 *
 * Source: https://www.gyan.dev/ffmpeg/builds/ (`ffmpeg-release-essentials.zip`,
 * ~110 MB). The zip contains `ffmpeg-<ver>-essentials_build/bin/ffmpeg.exe` —
 * we extract just that one file and discard the rest.
 *
 * Re-running the script is safe: if `bin/ffmpeg.exe` already exists and is
 * non-empty we skip the download. Pass `--force` to re-download regardless.
 *
 * Usage:
 *   node electron/scripts/download-ffmpeg.cjs          # skip if present
 *   node electron/scripts/download-ffmpeg.cjs --force  # always re-download
 *   npm -w electron run download-ffmpeg                # npm script wrapper
 *
 * Requirements: Node 18+ (uses global `fetch`), `unzip` on PATH (Git Bash on
 * Windows ships it). Falls back to a pure-Node unzip if `unzip` is missing.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');

const URL =
  process.env.SCREENSARE_FFMPEG_URL ||
  process.env.SCREENSHARE_FFMPEG_URL ||
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

const ELECTRON_DIR = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ELECTRON_DIR, 'bin');
const DEST_EXE = path.join(BIN_DIR, 'ffmpeg.exe');

const force = process.argv.includes('--force');

/**
 * Pipe a `fetch` Response body to a file with progress logging. Returns when
 * the file is fully written and the stream closed.
 *
 * @param {Response} res
 * @param {string} filePath
 * @returns {Promise<void>}
 */
function streamResponseToFile(res, filePath) {
  return new Promise((resolve, reject) => {
    // Response.body is a web stream; convert to Node stream once.
    const nodeStream = require('stream');
    // @ts-ignore — Readable.fromWeb exists in Node 18+
    const readable = nodeStream.Readable.fromWeb(res.body);
    const file = fs.createWriteStream(filePath);
    const total = Number(res.headers.get('content-length') || 0);
    let received = 0;
    let lastLog = 0;
    readable.on('data', (chunk) => {
      received += chunk.length;
      const now = Date.now();
      if (total && now - lastLog > 1000) {
        const pct = ((received / total) * 100).toFixed(1);
        const mb = (received / 1024 / 1024).toFixed(1);
        const totalMb = (total / 1024 / 1024).toFixed(1);
        // eslint-disable-next-line no-console
        console.log(`[ffmpeg] downloading... ${mb}/${totalMb} MB (${pct}%)`);
        lastLog = now;
      }
    });
    readable.on('error', (err) => {
      file.close(() => reject(err));
    });
    file.on('error', reject);
    file.on('finish', () => resolve());
    readable.pipe(file);
  });
}

/**
 * Extract `bin/ffmpeg.exe` from the downloaded zip into `BIN_DIR`.
 * Tries the system `unzip` first (fast), then falls back to a small tar-based
 * extraction (Windows 10+ ships `tar` which can read zips), then to PowerShell
 * `Expand-Archive` as a last resort.
 *
 * @param {string} zipPath
 * @returns {void}
 */
function extractFfmpeg(zipPath) {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  // Strategy 1: system `unzip` (Git Bash on Windows ships this).
  if (trySystemUnzip(zipPath)) return;

  // Strategy 2: Windows 10+ `tar` (bsd tar in Windows understands .zip).
  if (tryTarUnzip(zipPath)) return;

  // Strategy 3: PowerShell Expand-Archive.
  if (tryPowerShellUnzip(zipPath)) return;

  throw new Error(
    'No unzip tool available. Install `unzip`, or extract the zip manually ' +
      `and copy bin/ffmpeg.exe from inside it to ${DEST_EXE}.`,
  );
}

/**
 * @param {string} zipPath
 * @returns {boolean}
 */
function trySystemUnzip(zipPath) {
  try {
    // Find the ffmpeg.exe entry name without extracting first.
    const list = spawnSync('unzip', ['-l', zipPath], { windowsHide: true });
    if (list.status !== 0) return false;
    const listing = list.stdout?.toString('utf8') || '';
    const entry = listing
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /bin\/ffmpeg\.exe$/i.test(l));
    if (!entry) return false;
    // Last whitespace-separated token is the path.
    const entryPath = entry.split(/\s+/).pop();
    if (!entryPath) return false;

    // Extract just that one file into BIN_DIR, then rename to ffmpeg.exe.
    const tmpExtract = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-extract-'));
    const extract = spawnSync(
      'unzip',
      ['-o', '-q', zipPath, entryPath, '-d', tmpExtract],
      { windowsHide: true },
    );
    if (extract.status !== 0) {
      fs.rmSync(tmpExtract, { recursive: true, force: true });
      return false;
    }
    // Walk the extracted dir to find ffmpeg.exe (the entry path is relative
    // to the zip root, so it's at tmpExtract/<entryPath>).
    const extracted = path.join(tmpExtract, entryPath);
    if (!fs.existsSync(extracted)) {
      // Fall back to globbing.
      const found = findFile(tmpExtract, 'ffmpeg.exe');
      if (!found) {
        fs.rmSync(tmpExtract, { recursive: true, force: true });
        return false;
      }
      fs.copyFileSync(found, DEST_EXE);
    } else {
      fs.copyFileSync(extracted, DEST_EXE);
    }
    fs.rmSync(tmpExtract, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} zipPath
 * @returns {boolean}
 */
function tryTarUnzip(zipPath) {
  // `tar -tf` lists entries. We then extract with the matching name.
  try {
    const list = spawnSync('tar', ['-tf', zipPath], { windowsHide: true });
    if (list.status !== 0) return false;
    const listing = list.stdout?.toString('utf8') || '';
    const entry = listing
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /bin\/ffmpeg\.exe$/i.test(l));
    if (!entry) return false;

    // `tar -xzf` doesn't work on zips; use `-a` (auto-compress) or rely on
    // Windows bsdtar which auto-detects. Extract to a temp dir then move.
    const tmpExtract = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-extract-'));
    const extract = spawnSync(
      'tar',
      ['-xf', zipPath, '-C', tmpExtract, entry],
      { windowsHide: true },
    );
    if (extract.status !== 0) {
      fs.rmSync(tmpExtract, { recursive: true, force: true });
      return false;
    }
    const extracted = path.join(tmpExtract, entry);
    if (!fs.existsSync(extracted)) {
      const found = findFile(tmpExtract, 'ffmpeg.exe');
      if (!found) {
        fs.rmSync(tmpExtract, { recursive: true, force: true });
        return false;
      }
      fs.copyFileSync(found, DEST_EXE);
    } else {
      fs.copyFileSync(extracted, DEST_EXE);
    }
    fs.rmSync(tmpExtract, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} zipPath
 * @returns {boolean}
 */
function tryPowerShellUnzip(zipPath) {
  if (process.platform !== 'win32') return false;
  try {
    const tmpExtract = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-extract-'));
    const ps = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${tmpExtract}" -Force`,
      ],
      { windowsHide: true },
    );
    if (ps.status !== 0) {
      fs.rmSync(tmpExtract, { recursive: true, force: true });
      return false;
    }
    const found = findFile(tmpExtract, 'ffmpeg.exe');
    if (!found) {
      fs.rmSync(tmpExtract, { recursive: true, force: true });
      return false;
    }
    fs.copyFileSync(found, DEST_EXE);
    fs.rmSync(tmpExtract, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively find a file by name.
 *
 * @param {string} root
 * @param {string} name
 * @returns {string | null}
 */
function findFile(root, name) {
  const lower = name.toLowerCase();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(fullPath, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === lower) {
      return fullPath;
    }
  }
  return null;
}

async function main() {
  if (fs.existsSync(DEST_EXE) && fs.statSync(DEST_EXE).size > 1000 && !force) {
    // eslint-disable-next-line no-console
    console.log(`[ffmpeg] already present at ${DEST_EXE} (use --force to re-download)`);
    return;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const zipPath = path.join(BIN_DIR, 'ffmpeg-download.zip');

  // eslint-disable-next-line no-console
  console.log(`[ffmpeg] downloading ${URL} ...`);
  const res = await fetch(URL, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  }
  await streamResponseToFile(res, zipPath);
  // eslint-disable-next-line no-console
  console.log(`[ffmpeg] downloaded ${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);

  // eslint-disable-next-line no-console
  console.log('[ffmpeg] extracting bin/ffmpeg.exe ...');
  extractFfmpeg(zipPath);

  // Clean up the zip — it's ~110 MB and not needed after extraction.
  fs.rmSync(zipPath, { force: true });

  if (!fs.existsSync(DEST_EXE) || fs.statSync(DEST_EXE).size < 1000) {
    throw new Error(`Extraction completed but ${DEST_EXE} is missing or empty`);
  }
  const sizeMb = (fs.statSync(DEST_EXE).size / 1024 / 1024).toFixed(1);
  // eslint-disable-next-line no-console
  console.log(`[ffmpeg] OK — ${DEST_EXE} (${sizeMb} MB)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[ffmpeg] download failed:', err && err.message ? err.message : err);
  process.exit(1);
});
