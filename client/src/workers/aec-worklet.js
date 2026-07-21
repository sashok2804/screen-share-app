/**
 * Acoustic Echo Cancellation AudioWorklet processor.
 *
 * Uses Normalised Least Mean Squares (NLMS) adaptive filter to estimate the
 * echo path between the far-end (remote peer voice) reference signal and the
 * near-end capture (system loopback). The filter output is then subtracted
 * from the capture, leaving only the genuine near-end audio.
 *
 * Inputs:
 *   channel 0 — near-end (capture) signal: system audio containing both
 *               the genuine sounds (game, music) AND the far-end voice that
 *               leaked into the capture via the speakers.
 *   channel 1 — far-end (reference) signal: what we sent to the speakers,
 *               i.e. the remote peer's voice. This is the signal the filter
 *               learns to cancel.
 *
 * Output:
 *   channel 0 — cleaned near-end: capture minus estimated echo.
 *
 * Tunables:
 *   FILTER_LENGTH — adaptive filter taps. 1024 taps @ 48 kHz ≈ 21 ms of echo
 *                   tail coverage, which is plenty for typical speaker→mic
 *                   paths in a small room.
 *   STEP_SIZE    — NLMS adaptation rate. Higher = faster convergence but
 *                   more noise injection. 0.5 is a safe starting point.
 *   REGULARISATION — avoids divide-by-zero when reference energy is ~0.
 *
 * Reference: Haykin, "Adaptive Filter Theory", NLMS chapter.
 */

class AecProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [];
  }

  constructor() {
    super();
    this.filterLength = 1024;
    this.stepSize = 0.5;
    this.regularisation = 1e-6;

    // Adaptive filter weights (Float32Array for SIMD-friendly access).
    this.weights = new Float32Array(this.filterLength);

    // Ring buffer of past reference samples used as the regressor vector.
    this.referenceHistory = new Float32Array(this.filterLength);
    this.historyIndex = 0;

    // Optional: receive runtime tuning messages from the main thread.
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data?.type === 'config') {
        if (typeof data.stepSize === 'number' && data.stepSize > 0 && data.stepSize <= 2) {
          this.stepSize = data.stepSize;
        }
        if (typeof data.filterLength === 'number' && data.filterLength > 0 && data.filterLength <= 4096) {
          this.filterLength = Math.floor(data.filterLength);
          this.weights = new Float32Array(this.filterLength);
          this.referenceHistory = new Float32Array(this.filterLength);
          this.historyIndex = 0;
        }
      }
      if (data?.type === 'reset') {
        this.weights.fill(0);
        this.referenceHistory.fill(0);
        this.historyIndex = 0;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    // No input connected yet — emit silence and bail.
    if (!input || input.length === 0) {
      const out = output[0];
      if (out) out.fill(0);
      return true;
    }

    const capture = input[0]; // near-end
    const reference = input[1]; // far-end

    // No reference channel means nothing to cancel — pass through.
    if (!reference) {
      if (output[0] && capture) {
        output[0].set(capture);
      }
      return true;
    }

    const out = output[0];
    if (!out) return true;

    const N = this.filterLength;
    const mu = this.stepSize;
    const refHist = this.referenceHistory;
    const w = this.weights;

    for (let i = 0; i < capture.length; i++) {
      // Push the current reference sample into the ring buffer.
      refHist[this.historyIndex] = reference[i];

      // Compute the filter output: dot(weights, regressor).
      // We walk the ring buffer in reverse-arrival order so the regressor
      // vector matches the taps the filter is "expecting".
      let echo = 0;
      let idx = this.historyIndex;
      for (let k = 0; k < N; k++) {
        echo += w[k] * refHist[idx];
        idx = idx === 0 ? N - 1 : idx - 1;
      }

      // Error signal = what the capture actually is minus our echo estimate.
      const error = capture[i] - echo;
      out[i] = error;

      // Compute reference energy for normalisation.
      let energy = this.regularisation;
      idx = this.historyIndex;
      for (let k = 0; k < N; k++) {
        const s = refHist[idx];
        energy += s * s;
        idx = idx === 0 ? N - 1 : idx - 1;
      }

      // NLMS weight update: w += (mu / energy) * error * regressor.
      const step = (mu * error) / energy;
      idx = this.historyIndex;
      for (let k = 0; k < N; k++) {
        w[k] += step * refHist[idx];
        idx = idx === 0 ? N - 1 : idx - 1;
      }

      // Advance the ring buffer pointer.
      this.historyIndex = (this.historyIndex + 1) % N;
    }

    return true;
  }
}

registerProcessor('aec-processor', AecProcessor);
