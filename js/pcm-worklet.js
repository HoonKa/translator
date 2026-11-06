// AudioWorklet: converts mic audio to 16 kHz, 16-bit PCM and posts one
// 100 ms chunk (1600 samples) at a time, together with its loudness (RMS).
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.target = 16000;
    this.ratio = sampleRate / this.target; // 1 when the context already runs at 16 kHz
    this.chunk = new Int16Array(1600);
    this.n = 0;
    this.sumSq = 0;
    this.acc = 0;     // box-filter accumulator for downsampling
    this.accN = 0;
    this.phase = 0;
  }
  push(s) {
    if (s > 1) s = 1; else if (s < -1) s = -1;
    this.sumSq += s * s;
    this.chunk[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.n === this.chunk.length) {
      const rms = Math.sqrt(this.sumSq / this.n);
      const out = this.chunk;
      this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
      this.chunk = new Int16Array(1600);
      this.n = 0;
      this.sumSq = 0;
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.ratio === 1) {
      for (let i = 0; i < ch.length; i++) this.push(ch[i]);
      return true;
    }
    // Downsample by averaging the input samples that fall into each output sample.
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.accN++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        this.push(this.acc / this.accN);
        this.acc = 0;
        this.accN = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
