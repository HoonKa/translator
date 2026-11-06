// Gemini Live link for ONE target language.
//
// Long classes: a Live API connection only lasts about 10 minutes. Instead of
// waiting for it to drop, we open the next connection a little early (at a
// pause in speech when possible), move the microphone audio over to it, and
// let the old connection finish its last words before closing it. If a
// connection drops unexpectedly, audio is buffered (up to 20 s) and replayed
// into the new connection, so nothing said during the gap is lost.
//
// All timing is driven by the 100 ms audio chunks (not setTimeout), because
// browsers slow down timers in background tabs.

export const DEFAULT_WS =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export const TRANSLATE_MODEL = 'gemini-3.5-live-translate-preview';
export const GENERAL_MODEL = 'gemini-3.8-live';

const SOFT_ROTATE_MS = 7.5 * 60 * 1000;  // after this, switch at the next pause
const HARD_ROTATE_MS = 9 * 60 * 1000;    // switch now, even mid-sentence
const SETUP_TIMEOUT_MS = 12000;
const DRAIN_MS = 4000;                   // let the old connection finish its sentence
const MAX_BUFFER_CHUNKS = 200;           // 20 s of audio
const SILENT_RMS = 0.012;

// The docs show translationConfig / transcription settings in slightly
// different places, so we try these in order and remember what works.
function setupVariants(model, lang, wantSource) {
  const m = `models/${model}`;
  const tr = { targetLanguageCode: lang, echoTargetLanguage: true };
  const src = wantSource ? { inputAudioTranscription: {} } : {};
  if (model.includes('translate')) {
    return [
      { setup: { model: m, generationConfig: { responseModalities: ['AUDIO'], ...src, outputAudioTranscription: {}, translationConfig: tr } } },
      { setup: { model: m, generationConfig: { responseModalities: ['AUDIO'], translationConfig: tr }, ...src, outputAudioTranscription: {} } },
      { setup: { model: m, generationConfig: { responseModalities: ['AUDIO'] }, translationConfig: tr, ...src, outputAudioTranscription: {} } },
    ];
  }
  // General Live model used as an interpreter (waits for short pauses).
  const names = { en: 'English', ja: 'Japanese', zh: 'Chinese', 'zh-Hans': 'Simplified Chinese', es: 'Spanish', vi: 'Vietnamese', fr: 'French', de: 'German', ko: 'Korean' };
  const target = names[lang] || lang;
  return [{
    setup: {
      model: m,
      generationConfig: { responseModalities: ['AUDIO'] },
      systemInstruction: { parts: [{ text:
        `You are a simultaneous interpreter in a classroom. Translate everything the teacher says into ${target}. ` +
        `Output only the translation, never answer questions, never add comments. If speech is already in ${target}, repeat it.` }] },
      ...src,
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: { silenceDurationMs: 500 },
        activityHandling: 'NO_INTERRUPTION',
      },
    },
  }];
}

let connSeq = 0;

class Conn {
  constructor(link) {
    this.link = link;
    this.id = ++connSeq;
    this.ready = false;
    this.closed = false;
    this.draining = false;
    this.goAway = false;
    this.openedAt = Date.now();
    this.readyAt = 0;
    this.dec = new TextDecoder();
  }
  open(setupMsg) {
    const L = this.link;
    const url = `${L.wsUrl}?key=${encodeURIComponent(L.apiKey)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify(setupMsg));
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : this.dec.decode(ev.data));
      } catch { return; }
      this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.closed) return;
      this.closed = true;
      L._onClosed(this, ev.code, ev.reason || '');
    };
    ws.onerror = () => {};
  }
  onMessage(msg) {
    const L = this.link;
    if (msg.setupComplete) {
      this.ready = true;
      this.readyAt = Date.now();
      L._onReady(this);
      return;
    }
    const sc = msg.serverContent;
    if (sc) {
      if (sc.inputTranscription && sc.inputTranscription.text) L._emit('source', sc.inputTranscription.text, this);
      if (sc.outputTranscription && sc.outputTranscription.text) L._emit('text', sc.outputTranscription.text, this);
      if (sc.turnComplete || sc.generationComplete) L._emit('turn', null, this);
    }
    if (msg.goAway) {
      this.goAway = true;
      L._log(`conn ${this.id}: goAway ${JSON.stringify(msg.goAway.timeLeft || '')}`);
    }
    if (msg.error) L._log(`conn ${this.id}: error ${JSON.stringify(msg.error)}`);
  }
  send(b64) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } }));
      return true;
    }
    return false;
  }
  drain() {
    this.draining = true;
    try {
      if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    } catch {}
    this.drainUntil = Date.now() + DRAIN_MS;
  }
  close() {
    this.closed = true;
    try { this.ws.close(1000, 'done'); } catch {}
  }
}

export class TranslatorLink {
  /**
   * opts: { apiKey, model, lang, wantSource, wsUrl, onText(delta), onSource(delta),
   *         onTurn(), onStatus(state, detail), onLog(line) }
   * state: 'connecting' | 'live' | 'reconnecting' | 'error' | 'stopped'
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.wsUrl = opts.wsUrl || DEFAULT_WS;
    this.model = opts.model || TRANSLATE_MODEL;
    this.variantKey = `gl_variant_${this.model}`;
    this.variants = setupVariants(this.model, this.lang, this.wantSource);
    this.variantIdx = Math.min(Number(safeGet(this.variantKey) || 0), this.variants.length - 1);
    this.active = null;
    this.pending = null;
    this.draining = [];
    this.buffer = [];
    this.silentStreak = 0;
    this.failures = 0;
    this.nextRetryAt = 0;
    this.running = false;
    this.stats = { connections: 0, rotations: 0, drops: 0 };
    this.softRotateMs = opts.softRotateMs || SOFT_ROTATE_MS;
    this.hardRotateMs = opts.hardRotateMs || HARD_ROTATE_MS;
  }

  start() {
    this.running = true;
    this._status('connecting');
    this._connect('start');
  }

  stop() {
    this.running = false;
    for (const c of [this.active, this.pending, ...this.draining]) if (c) c.close();
    this.active = this.pending = null;
    this.draining = [];
    this.buffer = [];
    this._status('stopped');
  }

  /** Called every 100 ms with one audio chunk. */
  sendAudio(b64, rms) {
    if (!this.running) return;
    this.silentStreak = rms < SILENT_RMS ? this.silentStreak + 1 : 0;
    const a = this.active;
    if (a && a.ready && !a.closed && a.send(b64)) {
      // sent
    } else {
      this.buffer.push(b64);
      if (this.buffer.length > MAX_BUFFER_CHUNKS) this.buffer.shift();
    }
    this.tick();
  }

  tick() {
    const now = Date.now();
    // Close connections that have had time to finish their last sentence.
    this.draining = this.draining.filter(c => {
      if (c.closed) return false;
      if (now >= c.drainUntil) { c.close(); return false; }
      return true;
    });
    // Setup taking too long.
    if (this.pending && !this.pending.ready && now - this.pending.openedAt > SETUP_TIMEOUT_MS) {
      const p = this.pending;
      this._log(`conn ${p.id}: setup timeout`);
      p.close();
      this.pending = null;
      this._scheduleRetry();
    }
    if (!this.running || this.pending || now < this.nextRetryAt) return;
    const a = this.active;
    if (a) {
      const age = now - a.readyAt;
      const pause = this.silentStreak >= 3; // 300 ms of quiet
      if (a.goAway || age > this.hardRotateMs || (age > this.softRotateMs && pause)) {
        this.stats.rotations++;
        this._connect(a.goAway ? 'goAway' : 'rotate');
      }
    } else {
      this._connect('retry');
    }
  }

  _connect(reason) {
    const c = new Conn(this);
    this.pending = c;
    this.stats.connections++;
    this._log(`conn ${c.id}: opening (${reason}, setup variant ${this.variantIdx})`);
    c.open(this.variants[this.variantIdx]);
  }

  _onReady(c) {
    if (c !== this.pending) { c.close(); return; }
    this.pending = null;
    this.failures = 0;
    safeSet(this.variantKey, String(this.variantIdx));
    const old = this.active;
    this.active = c;
    if (old && !old.closed) { old.drain(); this.draining.push(old); }
    // Replay audio captured while no connection was available.
    if (this.buffer.length) {
      this._log(`conn ${c.id}: replaying ${(this.buffer.length / 10).toFixed(1)} s of buffered audio`);
      for (const b of this.buffer) c.send(b);
      this.buffer = [];
    }
    this._log(`conn ${c.id}: live`);
    this._status('live');
  }

  _onClosed(c, code, reason) {
    this._log(`conn ${c.id}: closed ${code} ${reason}`);
    if (c === this.pending) {
      this.pending = null;
      if (this._isFatal(code, reason)) return;
      if (code === 1007 && this.variantIdx < this.variants.length - 1) {
        // Server rejected the setup message: try the next layout right away.
        this.variantIdx++;
        this.nextRetryAt = 0;
        if (this.running && !this.active) this._connect('next setup variant');
        return;
      }
      this._scheduleRetry();
      return;
    }
    if (c === this.active) {
      this.active = null;
      if (!this.running) return;
      if (this._isFatal(code, reason)) return;
      this.stats.drops++;
      this._status('reconnecting', reason);
      this.nextRetryAt = 0; // reconnect immediately; tick() or this call does it
      if (!this.pending) this._connect('dropped');
    }
  }

  _isFatal(code, reason) {
    const r = reason.toLowerCase();
    let msg = null;
    if (r.includes('api key') || r.includes('api_key') || code === 1008 && r.includes('permission')) msg = 'API 키가 올바르지 않거나 권한이 없습니다.';
    else if (r.includes('not found') && r.includes('model')) msg = `모델(${this.model})을 찾을 수 없습니다.`;
    else if (r.includes('billing') || r.includes('quota') || r.includes('exceeded') || r.includes('resource_exhausted') || r.includes('rate limit')) msg = '사용량 한도 초과 또는 결제 설정이 필요합니다.';
    if (!msg) return false;
    this.running = false;
    this._status('error', `${msg} (${reason})`);
    return true;
  }

  _scheduleRetry() {
    this.failures++;
    const delay = Math.min(10000, 500 * 2 ** (this.failures - 1));
    this.nextRetryAt = Date.now() + delay;
    if (this.running) this._status(this.active ? 'live' : 'reconnecting', `재시도 ${Math.round(delay / 100) / 10}초 후`);
  }

  _emit(kind, data, conn) {
    if (kind === 'text' && this.onText) this.onText(data, conn.id);
    else if (kind === 'source' && this.onSource) this.onSource(data, conn.id);
    else if (kind === 'turn' && this.onTurn) this.onTurn(conn.id);
  }
  _status(state, detail = '') { this.state = state; this.detail = detail; if (this.onStatus) this.onStatus(state, detail); }
  _log(line) { if (this.onLog) this.onLog(`[${this.lang}] ${line}`); }
}

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
