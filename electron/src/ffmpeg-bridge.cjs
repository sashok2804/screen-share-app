// @ts-check
/**
 * FFmpeg subprocess bridge for system-audio capture on Windows.
 *
 * Phase 3 — spawns FFmpeg to capture from a DirectShow (or WASAPI) input
 * device and emits raw `f32le` PCM chunks that the renderer feeds into a
 * Web Audio graph → MediaStreamAudioDestinationNode → MediaStreamTrack.
 *
 * Two-tier strategy:
 *   - Tier 1 (must work): `-f dshow -i audio="<device>"` → raw PCM.
 *   - Tier 2 (best effort): if the caller passes `format: 'wasapi'` we try
 *     `ffmpeg -f wasapi -i audio="<device>"` first (libwasapi must be linked
 *     into the bundled FFmpeg). On failure we fall back to `dshow`.
 *
 * The output is always 32-bit float little-endian (`pcm_f32le`) at the
 * requested sample rate / channel count. That's what the Web Audio API
 * expects when copying into an AudioBuffer.
 *
 * The class is an EventEmitter with:
 *   - 'chunk'  (Float32Array) — one per ~128-frame quantum of accumulation.
 *   - 'error'  (Error)
 *   - 'exit'   (code, signal)
 *   - 'warn'   (string) — non-fatal stderr line.
 */

'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');

/**
 * @typedef {Object} FFmpegAudioCaptureOptions
 * @property {string} ffmpegPath      Absolute path to ffmpeg.exe.
 * @property {string} [deviceName]    DShow/WASAPI device name. If omitted we
 *                                    use FFmpeg's default input device.
 * @property {number} [sampleRate]    Output sample rate (default 48000).
 * @property {number} [channels]      Output channel count (default 2).
 * @property {'dshow'|'wasapi'} [format]
 *                                    Input format. Default 'dshow'.
 * @property {boolean} [tryWasapiFallback]
 *                                    If true and format is 'wasapi', retry
 *                                    with 'dshow' on failure. Default true.
 */

class FFmpegAudioCapture extends EventEmitter {
  /**
   * @param {FFmpegAudioCaptureOptions} opts
   */
  constructor(opts) {
    super();
    if (!opts || !opts.ffmpegPath) {
      throw new Error('FFmpegAudioCapture: ffmpegPath is required');
    }
    this.ffmpegPath = opts.ffmpegPath;
    this.deviceName = opts.deviceName || '';
    this.sampleRate = Math.floor(opts.sampleRate || 48000);
    this.channels = Math.floor(opts.channels || 2);
    this.format = opts.format === 'wasapi' ? 'wasapi' : 'dshow';
    this.tryWasapiFallback = opts.tryWasapiFallback !== false;

    /** @type {import('child_process').ChildProcess | null} */
    this.proc = null;
    this.running = false;
    this.stopping = false;

    /** Leftover bytes (< 4) from the last stdout chunk that didn't align to a
     *  Float32 — prepended to the next chunk so we never split a sample. */
    this._tail = Buffer.alloc(0);

    /** @type {NodeJS.Timeout | null} */
    this._killTimer = null;

    // EventEmitter has a default max listeners warning at 11; we want to be
    // generous in case the main process attaches several diagnostic sinks.
    this.setMaxListeners(20);
  }

  /**
   * Build the ffmpeg argv for the current input format.
   * Output is always raw f32le on stdout.
   *
   * Throws if no device name was provided — we deliberately do NOT fall back
   * to FFmpeg's `dummy` input: that device does not exist on a stock Windows
   * install, so FFmpeg exits with code 1 and the renderer surfaces a cryptic
   * "user aborted a request" error. The caller (renderer) is responsible for
   * picking a real device via `listAudioDevices()` first.
   *
   * @private
   */
  _buildArgs(format) {
    if (!this.deviceName || this.deviceName.length === 0) {
      throw new Error(
        'No audio device specified. Call listAudioDevices() and pick one.',
      );
    }

    return [
      '-hide_banner',
      '-loglevel', 'warning',
      '-f', format,
      '-i', `audio=${this.deviceName}`,
      '-ac', String(this.channels),
      '-ar', String(this.sampleRate),
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      // Pipe raw PCM to stdout.
      'pipe:1',
    ];
  }

  /**
   * Spawn the FFmpeg subprocess and start emitting 'chunk' events.
   * Resolves once the process has spawned and started streaming; rejects on
   * immediate spawn failure or first hard error.
   *
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      if (this.running) {
        reject(new Error('FFmpegAudioCapture: already running'));
        return;
      }
      if (process.platform !== 'win32') {
        // dshow/wasapi are Windows-only — never try to spawn on other OSes.
        reject(
          new Error(
            `FFmpegAudioCapture: ${this.format} capture is only available on Windows`,
          ),
        );
        return;
      }

      const trySpawn = (format) => {
        const args = this._buildArgs(format);
        let child;
        try {
          child = spawn(this.ffmpegPath, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return null;
        }
        return child;
      };

      const format0 = this.format;
      const child = trySpawn(format0);
      if (!child) return;
      this.proc = child;
      this._attachChild(child, format0, resolve, reject);
    });
  }

  /**
   * Wire up stdout/stderr/exit handlers. Centralised so wasapi→dshow fallback
   * can re-run it after a quick restart.
   *
   * @param {import('child_process').ChildProcess} child
   * @param {'dshow'|'wasapi'} format
   * @param {(v?: void) => void} resolve
   * @param {(err: Error) => void} reject
   * @private
   */
  _attachChild(child, format, resolve, reject) {
    let resolved = false;
    let firstDataSeen = false;

    /** @param {Buffer} buf */
    const onStdout = (buf) => {
      if (!firstDataSeen) {
        firstDataSeen = true;
        this.running = true;
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }
      // Stitch the previous tail onto this chunk to keep sample alignment.
      const stitched = this._tail.length > 0
        ? Buffer.concat([this._tail, buf])
        : buf;
      const floatBytes = 4; // f32le
      const aligned = stitched.length - (stitched.length % floatBytes);
      if (aligned < floatBytes) {
        // Not enough for even one sample yet — stash everything.
        this._tail = stitched;
        return;
      }
      this._tail = stitched.subarray(aligned);
      const sampleBuf = stitched.subarray(0, aligned);
      const floats = new Float32Array(sampleBuf.buffer, sampleBuf.byteOffset, sampleBuf.byteLength / floatBytes);
      // Copy into a fresh ArrayBuffer so the slice we send to the renderer
      // owns its memory (the source Buffer may be reused by Node streams).
      const copy = new Float32Array(floats.length);
      copy.set(floats);
      this.emit('chunk', copy);
    };

    let stderrBuf = '';
    const onStderr = (buf) => {
      stderrBuf += buf.toString('utf8');
      let idx;
      // Process stderr line-by-line; emit each complete line as a 'warn'.
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, idx).replace(/\r$/, '').trim();
        stderrBuf = stderrBuf.slice(idx + 1);
        if (line) this.emit('warn', line);
      }
    };

    const cleanup = () => {
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
      if (this._killTimer) {
        clearTimeout(this._killTimer);
        this._killTimer = null;
      }
    };

    const onError = (err) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        // If wasapi failed before first data, try falling back to dshow.
        if (
          format === 'wasapi' &&
          this.tryWasapiFallback &&
          !this.stopping
        ) {
          this.emit('warn', `wasapi input failed (${err.message}); retrying with dshow`);
          const fallback = trySpawnFallback.call(this, 'dshow');
          if (fallback) {
            this.proc = fallback;
            this._attachChild(fallback, 'dshow', resolve, reject);
            return;
          }
        }
        reject(err);
      } else {
        this.emit('error', err);
      }
    };

    const onExit = (code, signal) => {
      this.running = false;
      const wasResolved = resolved;
      cleanup();
      if (!resolved) {
        resolved = true;
        // The process died before producing any data — likely a bad device
        // name or unsupported input. Try the dshow fallback once.
        if (
          format === 'wasapi' &&
          this.tryWasapiFallback &&
          !this.stopping
        ) {
          this.emit('warn', `wasapi input exited (code=${code} signal=${signal}); retrying with dshow`);
          const fallback = trySpawnFallback.call(this, 'dshow');
          if (fallback) {
            this.proc = fallback;
            this._attachChild(fallback, 'dshow', resolve, reject);
            return;
          }
        }
        reject(
          new Error(
            `FFmpeg exited before producing data (code=${code} signal=${signal})`,
          ),
        );
      } else if (!this.stopping) {
        // Unexpected exit mid-stream.
        this.emit(
          'error',
          new Error(
            `FFmpeg exited unexpectedly (code=${code} signal=${signal})`,
          ),
        );
      }
      this.emit('exit', code, signal);
      // Suppress "unused variable" lints for control-flow clarity.
      void wasResolved;
    };

    /** @this {FFmpegAudioCapture} */
    function trySpawnFallback(newFormat) {
      const args = this._buildArgs(newFormat);
      try {
        return spawn(this.ffmpegPath, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        return null;
      }
    }

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('error', onError);
    child.on('exit', onExit);
  }

  /**
   * Stop the subprocess: SIGTERM first, escalate to SIGKILL after 2 seconds.
   * Idempotent — safe to call from any state.
   *
   * @param {number} [graceMs=2000] Grace period before SIGKILL.
   * @returns {void}
   */
  stop(graceMs = 2000) {
    this.stopping = true;
    const proc = this.proc;
    if (!proc || this._killTimer) {
      // Already stopped or a kill timer is in flight.
      if (!proc) this.running = false;
      return;
    }
    try {
      proc.stdin?.end();
    } catch {
      /* ignore */
    }
    try {
      // 'SIGTERM' on Windows isn't really graceful, but spawn.kill will
      // TerminateProcess the child, which is what we want.
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    this._killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      this._killTimer = null;
    }, graceMs);
    this.running = false;
  }

  /**
   * Convenience wrapper for `EventEmitter.on` so callers don't have to think
   * about the base class. Identical to `super.on`.
   * @param {string} event
   * @param {(...args: unknown[]) => void} cb
   */
  on(event, cb) {
    return super.on(event, cb);
  }

  off(event, cb) {
    return super.off(event, cb);
  }
}

module.exports = {
  FFmpegAudioCapture,
};
