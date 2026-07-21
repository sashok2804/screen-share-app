// @ts-check
/**
 * DirectShow / WASAPI audio device enumeration via FFmpeg.
 *
 * Used by the Phase 3 audio bridge so the user can pick which input device to
 * capture from. We spawn `ffmpeg -list_devices true -f dshow -i dummy` and
 * parse the device list (FFmpeg prints it to **stderr**, never stdout).
 *
 * Notes:
 *   - FFmpeg *always* exits non-zero for `-i dummy` (it can't open `dummy`
 *     as a real input). That is expected — we read stderr regardless.
 *   - The device list is localised, but the section headers are stable:
 *       `[dshow @ ...] DirectShow video devices` / `... audio devices`
 *     On non-English FFmpeg the strings are still the same (compiled-in).
 *   - "Stereo Mix" / "Wave Out" / etc. are device-specific names; users may
 *     need to enable them in Windows Sound settings.
 *   - On non-Windows platforms this returns empty arrays and logs a notice.
 */

'use strict';

const { spawn } = require('child_process');

/**
 * Parse the stderr produced by `ffmpeg -list_devices true -f dshow -i dummy`.
 *
 * Example stderr excerpt:
 * ```
 * [dshow @ 0000019A1B2C3D40]  "Microphone (Realtek Audio)" (audio)
 * [dshow @ 0000019A1B2C3D40]     Alternative name "@device_cm_{...}"
 * [dshow @ 0000019A1B2C3D40]  "Stereo Mix (Realtek Audio)" (audio)
 * [dshow @ 0000019A1B2C3D40]     Alternative name "@device_cm_{...}"
 * [dshow @ 0000019A1B2C3D40]  "USB Video Device" (video)
 * ```
 *
 * @param {string} stderr
 * @returns {{ audio: string[], video: string[] }}
 */
function parseDeviceList(stderr) {
  /** @type {{ audio: string[], video: string[] }} */
  const out = { audio: [], video: [] };

  // Current section: audio or video. Flip on a "DirectShow <kind> devices" line.
  let section = /** @type {'audio' | 'video' | null} */ (null);

  const lines = stderr.split(/\r?\n/);
  for (const line of lines) {
    // Section switchers.
    if (/DirectShow\s+audio\s+devices/i.test(line)) {
      section = 'audio';
      continue;
    }
    if (/DirectShow\s+video\s+devices/i.test(line)) {
      section = 'video';
      continue;
    }

    // The actual device lines look like:
    //   [dshow @ 0x...]  "Device Name" (audio)
    // The trailing "(audio)"/"(video)" is what FFmpeg itself classifies it as.
    // "Alternative name" lines must be skipped.
    if (/Alternative name/i.test(line)) continue;

    // Quoted device name(s) anywhere on the line.
    const nameMatch = line.match(/"([^"]+)"/);
    if (!nameMatch) continue;

    // Trust the trailing classifier more than the current section: FFmpeg
    // occasionally re-orders sections on localised builds.
    let kind = section;
    if (/\(audio\)/i.test(line)) kind = 'audio';
    else if (/\(video\)/i.test(line)) kind = 'video';

    if (!kind) continue; // unknown section
    const name = nameMatch[1].trim();
    if (name && !out[kind].includes(name)) {
      out[kind].push(name);
    }
  }

  return out;
}

/**
 * List DirectShow audio + video input devices known to FFmpeg.
 *
 * @param {{ ffmpegPath: string, timeoutMs?: number }} opts
 * @returns {Promise<{ audio: string[], video: string[], raw: string }>}
 *   Resolves with the parsed device lists plus the raw stderr (for debugging).
 *   Always resolves — never rejects — so the IPC handler can return a stable
 *   shape to the renderer.
 */
function listDirectShowAudioDevices(opts) {
  return new Promise((resolve) => {
    if (!opts || !opts.ffmpegPath) {
      resolve({ audio: [], video: [], raw: '' });
      return;
    }

    if (process.platform !== 'win32') {
      // dshow is Windows-only. On other platforms we just log and bail.
      // eslint-disable-next-line no-console
      console.warn(
        '[dshow-devices] DirectShow listing is Windows-only; returning empty list.',
      );
      resolve({ audio: [], video: [], raw: '' });
      return;
    }

    const args = ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
    let child;
    try {
      child = spawn(opts.ffmpegPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[dshow-devices] failed to spawn ffmpeg:', err);
      resolve({ audio: [], video: [], raw: String(err && err.message || err) });
      return;
    }

    let stderr = '';
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 8000;

    const finish = (raw) => {
      if (timer) clearTimeout(timer);
      const parsed = parseDeviceList(raw);
      resolve({ ...parsed, raw });
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        // eslint-disable-next-line no-console
        console.warn('[dshow-devices] ffmpeg -list_devices timed out');
        finish(stderr);
      }, timeoutMs);
    }

    // FFmpeg writes the device list to stderr.
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    // stdout is unused but drain it so the child doesn't block on a full pipe.
    child.stdout.on('data', () => {});
    child.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[dshow-devices] ffmpeg spawn error:', err);
    });
    child.on('exit', () => {
      // FFmpeg always exits non-zero here — that's fine.
      finish(stderr);
    });
  });
}

module.exports = {
  listDirectShowAudioDevices,
  parseDeviceList,
};
