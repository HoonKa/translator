// Completely free mode: Chrome/Edge built-in speech recognition (Korean)
// + Chrome/Edge built-in on-device translator. No API key needed.
// Chrome's translator has no Burmese/Mongolian/Uzbek: those show nothing in this mode.
// Limits: desktop Chrome 138+ / Edge, uses the default microphone, lower quality than Gemini.

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const TR_CODE = { 'zh-Hans': 'zh', 'zh-Hant': 'zh-Hant' };

export function freeModeSupport() {
  return { speech: !!SR, translator: 'Translator' in self };
}

/** Must be called right after a click (the browser needs a user action to download models). */
export function prepareTranslators(langs, src = 'ko', onProgress) {
  const out = {};
  if (!('Translator' in self)) return out;
  for (const lang of langs) {
    const targetLanguage = TR_CODE[lang] || lang;
    if (targetLanguage === src) { out[lang] = Promise.resolve({ translate: async (t) => t }); continue; }
    out[lang] = Translator.create({
      sourceLanguage: src, targetLanguage,
      monitor(m) { m.addEventListener('downloadprogress', (e) => onProgress && onProgress(lang, e.loaded)); },
    }).catch((e) => { console.warn('translator', lang, e); return null; });
  }
  return out;
}

export class FreeEngine {
  /** opts: { langs, remote (SentenceTranslator, optional), onRemote(ok, why), glossary: [{src,dst}], translators (from prepareTranslators), onPartial(lang,t), onFinal(lang,t), onStatus(state, detail), onLog } */
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
  /** Called with every mic chunk: restarts speech recognition if it went deaf while the teacher speaks. */
  noteAudio(rms) {
    if (!this.running || !this.rec) return;
    // Loud chunks in the last 5 s (50 chunks of 100 ms).
    const w = this.win || (this.win = []);
    w.push(rms >= 0.02 ? 1 : 0);
    if (w.length > 50) w.shift();
    const loud = w.reduce((a, b) => a + b, 0);
    const now = Date.now();
    // Speaking for at least 2.5 of the last 5 s, but no result for 5 s: recognition went deaf.
    // A fresh recognition session needs a few seconds before its first result, and restarting it
    // again too soon keeps it deaf. So: wait 5 s without results, give each new session at least
    // 10 s, and wait longer after each restart that did not help.
    const grace = Math.min(30000, 10000 * 2 ** Math.max(0, (this.kicksInRow || 0) - 1));
    if (loud >= 25 && now - (this.lastResultAt || 0) > 5000 && now - (this.startedAt || 0) > (this.kicksInRow ? grace : 5000)) {
      this.kicksInRow = (this.kicksInRow || 0) + 1;
      this.lastKickAt = now; this.startedAt = now; this.kicks = (this.kicks || 0) + 1;
      this._log(`free: 말하는 중인데 5초간 인식 결과 없음 -> 음성 인식 다시 시작 (${this.kicks}번째)`);
      this.deafSince = this.deafSince || (this.lastResultAt || now);
      try { this.rec.abort(); } catch {}
    }
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
    rec.lang = this.srcLang === 'en' ? 'en-US' : 'ko-KR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onstart = () => { this.stopping = false; this.startedAt = Date.now(); this.failures = 0; this.lastResultAt = Math.max(this.lastResultAt || 0, Date.now() - 3000); this._status('live'); };
    rec.onresult = (ev) => {
      this.lastResultAt = Date.now();
      this.kicksInRow = 0;
      if (this.deafSince) { this._log(`free: 인식 다시 됨 (${((this.lastResultAt - this.deafSince) / 1000).toFixed(1)}초 동안 멈췄음)`); this.deafSince = 0; }
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const t = r[0].transcript.trim();
        if (!t) continue;
        if (r.isFinal) this._final(t); else interim += (interim ? ' ' : '') + t;
      }
      this.pending = interim;
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
      // Chrome drops words it had not finished when a session ends (or is restarted): keep them.
      if (this.pending && this.running) { this._log(`free: 끝나지 않은 말 보존: "${this.pending.slice(0, 30)}"`); this._final(this.pending); }
      this.pending = '';
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
    // Glossary: put the wanted spelling into the sentence before translating (works best for names).
    for (const g of this.glossary || []) if (g.src) text = text.split(g.src).join(g.dst);
    try { return await t.translate(text); } catch { return null; }
  }
  _final(ko) {
    this.seq++;
    this.onFinal('ko', ko);
    this.onPartial('ko', '');
    if (this.remote) { this.queue = (this.queue || []).concat(ko); this._pump(); return; }
    for (const l of this.langs) {
      this._translate(l, ko).then((en) => { if (en) { this.onFinal(l, en); this.onPartial(l, ''); } });
    }
  }
  // Gemini text translation: one request per finished sentence (sentences that pile up while a
  // request is running are sent together). If Gemini is unavailable, Chrome's translator fills in.
  async _pump() {
    if (this.busy || !this.queue || !this.queue.length || !this.running) return;
    const now = Date.now();
    const text = this.queue.join(' ');
    this.queue = [];
    const langs = [...this.langs];
    const useRemote = now >= (this.remoteDownUntil || 0);
    this.busy = true;
    let out = null;
    if (useRemote) {
      try {
        const t0 = Date.now();
        out = await this.remote.translate(text, langs, this.context || '');
        this.remoteFails = 0;
        if (this.remoteWasDown) { this._log('free: Gemini 글 번역 다시 됨'); this.remoteWasDown = false; this.onRemote && this.onRemote(true); }
        if (Date.now() - t0 > 4000) this._log(`free: Gemini 글 번역이 느려요 (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
      } catch (e) {
        const wait = Math.min(300000, 30000 * 2 ** (this.remoteFails || 0));
        this.remoteFails = (this.remoteFails || 0) + 1;
        this.remoteDownUntil = Date.now() + (e.quota ? wait : Math.min(wait, 10000));
        this.remoteWasDown = true;
        this._log(`free: Gemini 글 번역 실패 (${e.message}). ${Math.round((this.remoteDownUntil - Date.now()) / 1000)}초 동안 크롬 번역 사용`);
        this.onRemote && this.onRemote(false, e.message);
      }
    }
    for (const l of langs) {
      let t = out && out[l];
      if (!t) t = await this._translate(l, text);   // Chrome fallback (English/Vietnamese only)
      if (t) { this.onFinal(l, t); this.onPartial(l, ''); }
    }
    this.context = (this.context ? this.context + ' ' : '') + text;
    if (this.context.length > 500) this.context = this.context.slice(-500);
    this.busy = false;
    if (this.queue.length) this._pump();
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
