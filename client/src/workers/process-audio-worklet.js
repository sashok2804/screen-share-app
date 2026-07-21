/**
 * AudioWorkletProcessor that drains a queue of Float32Array chunks (received
 * from the main thread via `port.postMessage`) into the AudioWorklet output.
 *
 * The main thread (see `useProcessAudio.ts`) wires up FFmpeg's stdout PCM →
 * IPC `audio:chunk` events → `worklet.port.postMessage(chunk)` here. We keep
 * a small ring buffer so brief bursts don't drop samples.
 *
 * Channel layout: FFmpeg output is interleaved per `channels` (default 1 in
 * the renderer's call site, so we just pass the data straight through). For
 * multichannel input the main thread should down-mix first; this processor
 * always emits mono (single output channel) to match the existing
 * voice-publish path.
 *
 * If the queue underruns (no data ready for a 128-sample quantum), we emit
 * silence — the WebRTC sender will just send a near-zero frame.
 */

const RING_FRAMES = 16384; // ~340ms at 48 kHz mono — plenty for jitter.

class ProcessAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {Float32Array} */
    this.ring = new Float32Array(RING_FRAMES);
    this.writePos = 0;
    this.readPos = 0;
    /** Number of valid samples currently in the ring. */
    this.fill = 0;
    /** Sticky flag — once we've ever had data, never emit pre-roll silence. */
    this.started = false;

    this.port.onmessage = (event) => {
      const chunk = event.data;
      if (!chunk || typeof chunk.length !== 'number') return;

      // If the ring is more than ~80% full, drop the oldest samples to make
      // room. This bounds latency at the cost of glitches under sustained
      // overload — better than unbounded growth.
      const available = RING_FRAMES - this.fill;
      if (chunk.length > available) {
        const overflow = chunk.length - available;
        // Advance readPos by overflow (drop oldest).
        this.readPos = (this.readPos + overflow) % RING_FRAMES;
        this.fill -= overflow;
        if (this.fill < 0) this.fill = 0;
      }

      // Copy chunk into the ring (handle wrap).
      const copyLen = Math.min(chunk.length, RING_FRAMES);
      for (let i = 0; i < copyLen; i++) {
        this.ring[this.writePos] = chunk[i];
        this.writePos = (this.writePos + 1) % RING_FRAMES;
      }
      this.fill += copyLen;
      this.started = true;
    };
  }

  /**
   * @param {Array<Array<Float32Array>>} _inputs
   * @param {Array<Array<Float32Array>>} outputs
   */
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const out = output[0];
    if (!out) return true;

    const want = out.length; // 128 in practice.

    if (this.fill >= want) {
      const take = want;
      for (let i = 0; i < take; i++) {
        out[i] = this.ring[this.readPos];
        this.ring[this.readPos] = 0; // optional: clear for sanity.
        this.readPos = (this.readPos + 1) % RING_FRAMES;
      }
      this.fill -= take;
    } else if (this.started && this.fill > 0) {
      // Partial: drain whatever we have, zero the rest.
      const take = this.fill;
      for (let i = 0; i < take; i++) {
        out[i] = this.ring[this.readPos];
        this.ring[this.readPos] = 0;
        this.readPos = (this.readPos + 1) % RING_FRAMES;
      }
      for (let i = take; i < want; i++) out[i] = 0;
      this.fill = 0;
    } else {
      // No data yet (or underrun on a quiet source): emit silence.
      out.fill(0);
    }
    return true;
  }
}

registerProcessor('process-audio-processor', ProcessAudioProcessor);
