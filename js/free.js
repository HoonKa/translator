// Completely free mode: Chrome/Edge built-in speech recognition (Korean)
// + Chrome/Edge built-in on-device translator. No API key needed.
// Limits: desktop Chrome 138+ / Edge, uses the default microphone, lower quality than Gemini.

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const TR_CODE = { 'zh-Hans': 'zh', 'zh-Hant': 'zh-Hant' };

export function freeModeSupport() {
  return { speech: !!SR, translator: 'Translator' in self };
}

/** Must be called right after a click (the browser needs a user action to download models). */
export function prepareTranslators(langs, onProgress) {
  const out = {};
  if (!('Translator' in self)) return out;
  for (const lang of langs) {
    const targetLanguage = TR_CODE[lang] || lang;
    out[lang] = Translator.create({
      sourceLanguage: 'ko', targetLanguage,
      monitor(m) { m.addEventListener('downloadprogress', (e) => onProgress && onProgress(lang, e.loaded)); },
    }).catch((e) => { console.warn('translator', lang, e); return null; });
  }
  return out;
}

export class FreeEngine {
  /** opts: { langs, translators (from prepareTranslators), onPartial(lang,t), onFinal(lang,t), onStatus(state, detail), onLog } */
  constructor(opts) {
    Object.assign(this, opts);
    this.running = false;
    this.state = 'stopped';
    this.lastInterimAt = 0;
    this.interimBusy = false;
    this.failures = 0;
    this.seq = 0;
  }
  async start() {
    if (!SR) { this._status('error', '이 브라우저는 음성 인식을 지원하지 않아요 (크롬/엣지 필요).'); return; }
    this.running = true;
    this.tr = {};
    for (const [l, p] of Object.entries(this.translators || {})) this.tr[l] = await p;
    const missing = this.langs.filter(l => !this.tr[l]);
    if (missing.length) this._log(`free: no built-in translator for ${missing.join(',')}`);
    this._listen();
  }
  stop() {
    this.running = false;
    try { this.rec && this.rec.abort(); } catch {}
    this._status('stopped');
  }
  _listen() {
    if (!this.running) return;
    const rec = new SR();
    this.rec = rec;
    rec.lang = 'ko-KR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onstart = () => { this.failures = 0; this._status('live'); };
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const t = r[0].transcript.trim();
        if (!t) continue;
        if (r.isFinal) this._final(t); else interim += (interim ? ' ' : '') + t;
      }
      this._interim(interim);
    };
    rec.onerror = (ev) => {
      if (ev.error === 'no-speech' || ev.error === 'aborted') return;
      this._log(`free: speech error ${ev.error}`);
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        this.running = false;
        this._status('error', '마이크/음성 인식 권한이 없어요.');
      } else this.failures++;
    };
    // Chrome ends recognition after silence or about a minute: start again right away.
    rec.onend = () => {
      if (!this.running) return;
      const delay = this.failures ? Math.min(5000, 300 * 2 ** this.failures) : 0;
      if (this.failures) this._status('reconnecting');
      setTimeout(() => this._listen(), delay);
    };
    try { rec.start(); } catch (e) { this._log(`free: start failed ${e.message}`); }
  }
  async _translate(lang, text) {
    const t = this.tr[lang];
    if (!t) return null;
    try { return await t.translate(text); } catch { return null; }
  }
  _final(ko) {
    this.seq++;
    this.onFinal('ko', ko);
    this.onPartial('ko', '');
    for (const l of this.langs) {
      this._translate(l, ko).then((en) => { if (en) { this.onFinal(l, en); this.onPartial(l, ''); } });
    }
  }
  _interim(ko) {
    this.onPartial('ko', ko);
    // Translate the unfinished sentence at most ~2x per second, so captions move while the teacher speaks.
    const now = Date.now();
    if (!ko || this.interimBusy || now - this.lastInterimAt < 500) return;
    this.lastInterimAt = now;
    this.interimBusy = true;
    const seq = this.seq;
    Promise.all(this.langs.map(async (l) => {
      const en = await this._translate(l, ko);
      if (en && this.running && seq === this.seq) this.onPartial(l, en);
    })).finally(() => { this.interimBusy = false; });
  }
  _status(state, detail = '') { this.state = state; this.detail = detail; this.onStatus && this.onStatus(state, detail); }
  _log(l) { this.onLog && this.onLog(l); }
}
