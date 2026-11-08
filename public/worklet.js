// Audio-thread helpers for Session Desk.
// sd-lufs: sums K-weighted energy in 100 ms blocks for the loudness meter.

class SdLufs extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = Math.round(sampleRate / 10);
    this.acc = 0;
    this.n = 0;
  }
  process(inputs) {
    const inp = inputs[0];
    if (inp && inp.length) {
      const L = inp[0], R = inp[1] || inp[0];
      for (let i = 0; i < L.length; i++) this.acc += L[i] * L[i] + R[i] * R[i];
      this.n += L.length;
      if (this.n >= this.block) {
        this.port.postMessage(this.acc / this.n);
        this.acc = 0;
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('sd-lufs', SdLufs);
