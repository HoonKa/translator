// "Recording" mode: this page records the microphone itself (no gaps), cuts the sound at
// pauses (or every 10 s), and sends each piece to Gemini, which writes down what was said
// and translates it into every students' language in one request.

const SPEECH_RMS = 0.02;
const QUIET_RMS = 0.015;
const PREROLL = 3;          // keep 0.3 s before speech starts
const END_SILENCE = 7;      // 0.7 s of quiet ends a piece
const MIN_VOICED = 8;       // ignore pieces with less than 0.8 s of speech (coughs, noise)
const MAX_CHUNKS = 100;     // 10 s at most per piece
const NAMES = { en: 'English', my: 'Burmese (Myanmar script)', vi: 'Vietnamese', mn: 'Mongolian (Cyrillic)', uz: 'Uzbek (Latin script)' };

export class AudioTranslator {
  /** opts: { tokenUrl, password, apiKey, glossary, getLangs(), getTopic(), onResult(source, translations), onCut(), onStatus(ok, why), onLog } */
  constructor(opts) {
    Object.assign(this, opts);
    this.pre = []; this.seg = null; this.seq = 0; this.nextOut = 1; this.done = new Map();
    this.context = ''; this.downUntil = 0; this.fails = 0; this.requests = 0;
  }
  get up() { return Date.now() >= this.downUntil; }

  /** Every 100 ms chunk of 16 kHz PCM16 (base64). */
  push(b64, rms) {
    if (!this.seg) {
      this.pre.push(b64); if (this.pre.length > PREROLL) this.pre.shift();
      if (rms >= SPEECH_RMS) { this.seg = { chunks: [...this.pre], voiced: 1, quiet: 0 }; this.pre = []; }
      return;
    }
    const s = this.seg;
    s.chunks.push(b64);
    if (rms >= SPEECH_RMS) { s.voiced++; s.quiet = 0; } else if (rms < QUIET_RMS) s.quiet++;
    if (s.quiet >= END_SILENCE * 3 && s.voiced < MIN_VOICED) { this.seg = null; return; }          // just noise
    if ((s.quiet >= END_SILENCE && s.voiced >= MIN_VOICED) || s.chunks.length >= MAX_CHUNKS) this.cut();
  }
  /** Finish the current piece now (also called when the class stops). */
  cut() {
    const s = this.seg; this.seg = null;
    if (!s || s.voiced < MIN_VOICED) return;
    this.onCut && this.onCut();
    if (!this.up) return;                    // Gemini is resting: the Chrome fallback covers this piece
    this._send(++this.seq, wav(s.chunks));
  }

  async _send(id, audio) {
    const langs = this.getLangs();
    const topic = (this.getTopic && this.getTopic()) || '';
    let res = null;
    this.requests++;
    const t0 = Date.now();
    try {
      res = this.tokenUrl && this.password ? await this._viaServer(audio, langs, topic) : await this._direct(audio, langs, topic);
      if (res.token) throw new Error('키 서버 코드가 예전 버전이에요 (녹음 번역을 몰라요)');
      if (res.error) { const e = new Error(res.error); e.quota = !!res.quota || /quota|exhausted|rate/i.test(res.error); throw e; }
      this.fails = 0;
      if (this.wasDown) { this.wasDown = false; this.onStatus && this.onStatus(true); }
      if (Date.now() - t0 > 5000) this._log(`audio: Gemini가 느려요 (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
    } catch (e) {
      const wait = Math.min(300000, 30000 * 2 ** this.fails);
      this.fails++;
      this.downUntil = Date.now() + (e.quota ? wait : Math.min(wait, 15000));
      this.wasDown = true;
      this._log(`audio: Gemini 녹음 번역 실패 (${e.message}). ${Math.round((this.downUntil - Date.now()) / 1000)}초 동안 크롬 받아쓰기로 대신해요`);
      this.onStatus && this.onStatus(false, e.message);
      res = null;
    }
    // Hand results out in the order the pieces were spoken.
    this.done.set(id, res);
    while (this.done.has(this.nextOut)) {
      const r = this.done.get(this.nextOut); this.done.delete(this.nextOut); this.nextOut++;
      if (r && (r.source || '').trim()) {
        this.context = (this.context + ' ' + r.source).slice(-500);
        this.onResult(r.source.trim(), r.translations || {});
      }
    }
  }

  async _viaServer(audio, langs, topic) {
    const r = await fetch(this.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'audio', password: this.password, audio, langs, topic, context: this.context, glossary: this.glossary || [] }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) return { error: '수업 비밀번호가 틀렸어요' };
    if (!r.ok && !j.error) return { error: `키 서버 오류 ${r.status}` };
    return j;
  }

  async _direct(audio, langs, topic) {
    const gloss = (this.glossary || []).map(g => `${g.src} => ${g.dst}`).join('\n');
    const prompt =
      'The audio is a short piece of a teacher speaking in a classroom (Korean, sometimes English or mixed). ' +
      'Write down exactly what was said in the original language as "source" (keep English technical terms in English letters). ' +
      'If there is no clear speech, return an empty source and empty translations. Then translate the source faithfully and naturally into each language below.\n' +
      `Languages: ${langs.map(l => `${l} = ${NAMES[l] || l}`).join(', ')}\n` +
      (gloss ? `Glossary:\n${gloss}\n` : '') + (topic ? `Class topic: ${topic}\n` : '') +
      (this.context ? `What the teacher said just before (context only): ${this.context}\n` : '');
    const keys = ['source', ...langs];
    const schema = { type: 'OBJECT', properties: Object.fromEntries(keys.map(l => [l, { type: 'STRING' }])), required: keys };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${encodeURIComponent(this.apiKey)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: audio } }, { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2 } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: (j.error && j.error.message) || `HTTP ${r.status}`, quota: r.status === 429 };
    try { const { source, ...translations } = JSON.parse(j.candidates[0].content.parts.map(p => p.text || '').join('')); return { source, translations }; }
    catch { return { error: 'bad model output' }; }
  }
  _log(l) { this.onLog && this.onLog(l); }
}

// 16 kHz mono PCM16 chunks (base64) -> WAV file (base64)
function wav(chunks) {
  const parts = chunks.map(b => Uint8Array.from(atob(b), c => c.charCodeAt(0)));
  const len = parts.reduce((a, p) => a + p.length, 0);
  const buf = new Uint8Array(44 + len);
  const v = new DataView(buf.buffer);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) buf[o + i] = t.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, 36 + len, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len, true);
  let o = 44; for (const p of parts) { buf.set(p, o); o += p.length; }
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}
