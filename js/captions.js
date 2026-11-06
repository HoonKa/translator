// Turns a stream of small text pieces into caption lines.
// A line is finished at the end of a sentence, after a pause, or when it gets long.
const END = /[.!?。！？](['")\]]?)\s+/;

export class Segmenter {
  constructor({ onPartial, onFinal, pauseMs = 1800, maxLen = 140 }) {
    this.onPartial = onPartial;
    this.onFinal = onFinal;
    this.pauseMs = pauseMs;
    this.maxLen = maxLen;
    this.cur = '';
    this.lastAt = 0;
  }
  push(delta, now = Date.now()) {
    if (!delta) return;
    this.cur += delta;
    this.lastAt = now;
    this._cut();
    this.onPartial(this.cur.trim());
  }
  _cut() {
    for (;;) {
      const m = END.exec(this.cur);
      // Keep very short pieces like "Dr." together with the next words.
      if (m && this.cur.slice(0, m.index + 1).trim().length >= 8) {
        const end = m.index + 1 + m[1].length;
        this._final(this.cur.slice(0, end));
        this.cur = this.cur.slice(end);
        continue;
      }
      if (this.cur.length > this.maxLen) {
        let at = this.cur.lastIndexOf(' ', this.maxLen);
        if (at < this.maxLen / 2) at = this.maxLen;
        this._final(this.cur.slice(0, at));
        this.cur = this.cur.slice(at);
        continue;
      }
      break;
    }
  }
  /** Call regularly; finishes the line after a pause. */
  tick(now = Date.now()) {
    if (this.cur.trim() && now - this.lastAt > this.pauseMs) this.flush();
  }
  flush() {
    if (this.cur.trim()) this._final(this.cur);
    this.cur = '';
    this.onPartial('');
  }
  _final(t) {
    t = t.trim();
    if (t) this.onFinal(t);
  }
}
