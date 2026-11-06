import { startMic, listMics } from './audio.js';
import { TranslatorLink, TRANSLATE_MODEL } from './gemini.js';
import { Segmenter } from './captions.js';
import { createRelay } from './relay.js';
import { FreeEngine, prepareTranslators, freeModeSupport } from './free.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const RELAY_KIND = params.get('relay') === 'mock' ? 'mock' : 'firebase';
const WS_OVERRIDE = params.get('ws') || undefined; // testing only
const FAST = params.get('fast') ? { softRotateMs: 15000, hardRotateMs: 25000 } : {};

export const LANGS = [
  ['en', 'English'], ['ja', '日本語'], ['zh-Hans', '中文(简体)'], ['vi', 'Tiếng Việt'],
  ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['ru', 'Русский'],
  ['mn', 'Монгол'], ['th', 'ไทย'], ['id', 'Bahasa Indonesia'], ['uz', 'Oʻzbek'],
];
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let relay = null;
let room = null;
let running = false;
let mic = null;
let links = [];
let segs = {};
let srcSeg = null;
let startedAt = 0;
let wakeLock = null;
const transcript = [];
const live = {};       // lang -> { text, dirty, last }
let shownLang = 'en';
let mode = 'auto';      // 'auto' | 'gemini' | 'free'
let engine = null;      // which engine is producing captions now: 'gemini' | 'free'
let free = null;
let translators = {};
let notLiveSince = 0;
let geminiRetryAt = 0;
let probing = false;
let cfg = null;         // { apiKey, model, langs }
const GEMINI_RETRY_MS = 15 * 60 * 1000;

// ---------- UI helpers ----------
function msg(text, kind = 'info', id) {
  if (id) { const old = document.getElementById(id); if (old) old.remove(); }
  if (!text) return;
  const d = document.createElement('div');
  d.className = `msg ${kind}`;
  if (id) d.id = id;
  d.textContent = text;
  $('msgs').appendChild(d);
}
function log(line) {
  const el = $('log');
  const t = new Date().toLocaleTimeString();
  el.textContent += `${t} ${line}\n`;
  if (el.textContent.length > 20000) el.textContent = el.textContent.slice(-15000);
  el.scrollTop = el.scrollHeight;
  console.log(line);
}
function setDot(dot, label, cls, text) { $(dot).className = `dot ${cls}`; $(label).textContent = text; }

function addLine(box, text) {
  const el = $(box);
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  let partial = el.querySelector('.partial');
  const p = document.createElement('p');
  p.textContent = text;
  el.insertBefore(p, partial);
  while (el.querySelectorAll('p:not(.partial)').length > 200) el.firstChild.remove();
  if (atBottom) el.scrollTop = el.scrollHeight;
}
function setPartial(box, text) {
  const el = $(box);
  let partial = el.querySelector('.partial');
  if (!partial) { partial = document.createElement('p'); partial.className = 'partial'; el.appendChild(partial); }
  partial.textContent = text;
  el.scrollTop = el.scrollHeight;
}

// ---------- Room / QR ----------
function newCode() {
  let s = '';
  const r = crypto.getRandomValues(new Uint8Array(5));
  for (const b of r) s += CODE_CHARS[b % CODE_CHARS.length];
  return s;
}
function studentUrl(code) {
  const u = new URL('s.html', location.href);
  u.search = '';
  u.searchParams.set('r', code);
  if (RELAY_KIND === 'mock') u.searchParams.set('relay', 'mock');
  return u.toString();
}
function qrSvg(text) {
  if (!window.qrcode) return '<div style="color:#111">QR 라이브러리를 불러오지 못했어요</div>';
  const q = window.qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
}
function showRoom() {
  const url = studentUrl(room);
  $('roomCode').textContent = room;
  $('roomUrl').textContent = url;
  $('qr').innerHTML = qrSvg(url);
  $('bigqrImg').innerHTML = qrSvg(url);
  $('bigCode').textContent = room;
  $('bigUrl').textContent = url;
}
async function claimRoom(forceNew = false) {
  const langs = selectedLangs();
  let code = forceNew ? null : store.get('room');
  for (let i = 0; i < 5; i++) {
    if (!code) code = newCode();
    if (await relay.claimRoom(code, langs)) { room = code; store.set('room', code); showRoom(); return true; }
    code = null;
  }
  msg('방을 만들지 못했어요. 인터넷 연결과 Firebase 설정을 확인해 주세요.', 'bad', 'roomErr');
  return false;
}

// ---------- Settings ----------
function selectedLangs() {
  const s = [...document.querySelectorAll('#langs input:checked')].map(i => i.value);
  return s.length ? s : ['en'];
}
function renderLangs() {
  const saved = (store.get('langs', 'en') || 'en').split(',');
  $('langs').innerHTML = '';
  for (const [code, name] of LANGS) {
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" value="${code}"> ${name}`;
    l.querySelector('input').checked = saved.includes(code);
    l.querySelector('input').addEventListener('change', () => store.set('langs', selectedLangs().join(',')));
    $('langs').appendChild(l);
  }
}
async function renderMics() {
  const sel = $('mic');
  const saved = store.get('mic', '');
  const mics = await listMics();
  sel.innerHTML = '<option value="">기본 마이크</option>';
  for (const m of mics) {
    if (!m.deviceId || m.deviceId === 'default') continue;
    const o = document.createElement('option');
    o.value = m.deviceId;
    o.textContent = m.label || `마이크 ${sel.length}`;
    sel.appendChild(o);
  }
  sel.value = [...sel.options].some(o => o.value === saved) ? saved : '';
}

// ---------- Captions out ----------
function writeLive(lang, text, now = Date.now()) {
  const s = live[lang] || (live[lang] = { text: '', dirty: false, last: 0 });
  s.text = text;
  s.dirty = true;
  if (now - s.last >= 100) flushLive(lang, now);
}
function flushLive(lang, now = Date.now()) {
  const s = live[lang];
  if (!s || !s.dirty) return;
  s.dirty = false;
  s.last = now;
  Promise.resolve(relay.setLive(room, lang, s.text)).catch(() => {});
}

function emitPartial(lang, t) {
  writeLive(lang, t);
  if (lang === shownLang) setPartial('out', t);
  if (lang === 'ko') setPartial('src', t);
}
function emitFinal(lang, t) {
  transcript.push({ at: new Date(), lang, text: t });
  Promise.resolve(relay.pushLine(room, lang, t)).catch((e) => log(`relay write failed: ${e.message}`));
  if (lang === shownLang) addLine('out', t);
  if (lang === 'ko') addLine('src', t);
}
function makeSegmenter(lang) {
  return new Segmenter({ onPartial: (t) => emitPartial(lang, t), onFinal: (t) => emitFinal(lang, t) });
}

// ---------- Start / stop ----------
function startGemini() {
  const { apiKey, model, langs } = cfg;
  segs = {};
  for (const l of langs) segs[l] = makeSegmenter(l);
  srcSeg = makeSegmenter('ko');
  links = langs.map((lang, i) => new TranslatorLink({
    apiKey, model, lang, wantSource: i === 0, wsUrl: WS_OVERRIDE, ...FAST,
    onText: (d) => { if (engine === 'gemini') segs[lang].push(d); },
    onSource: (d) => { if (engine === 'gemini') srcSeg.push(d); },
    onStatus: () => updateAiStatus(),
    onLog: log,
  }));
  links.forEach(l => l.start());
}
function stopGemini() {
  links.forEach(l => l.stop());
  links = [];
  Object.values(segs).forEach(s => s.flush());
  if (srcSeg) srcSeg.flush();
  segs = {}; srcSeg = null;
}
function startFree() {
  free = new FreeEngine({
    langs: cfg.langs, translators,
    onPartial: (l, t) => { if (engine === 'free') emitPartial(l, t); },
    onFinal: (l, t) => { if (engine === 'free') emitFinal(l, t); },
    onStatus: () => updateAiStatus(),
    onLog: log,
  });
  free.start();
}
function switchToFree(why) {
  log(`무료 모드로 전환: ${why}`);
  stopGemini();
  engine = 'free';
  probing = false;
  notLiveSince = 0;
  geminiRetryAt = Date.now() + GEMINI_RETRY_MS;
  if (!free) startFree();
  msg(`Gemini 번역이 멈춰서 무료 크롬 번역으로 바꿨어요 (${why}). 15분 뒤 Gemini를 다시 시도해요.`, 'warn', 'modeMsg');
  updateAiStatus();
}

async function start() {
  // Download built-in translators now, while we still have the click (browsers require it).
  const langs = selectedLangs();
  mode = $('mode').value;
  store.set('mode', mode);
  const apiKey = $('apiKey').value.trim();
  if (mode === 'gemini' && !apiKey) { msg('Gemini API 키를 먼저 입력해 주세요.', 'warn', 'keyMsg'); $('apiKey').focus(); return; }
  if (mode !== 'gemini') {
    const sup = freeModeSupport();
    if (mode === 'free' && (!sup.speech || !sup.translator)) {
      msg('이 브라우저는 무료 모드를 지원하지 않아요. 최신 크롬(138 이상)이나 엣지를 써 주세요.', 'bad', 'keyMsg'); return;
    }
    translators = prepareTranslators(langs, (l, p) => { if (p < 1) msg(`번역 모델 내려받는 중 (${l}) ${Math.round(p * 100)}%`, 'info', 'dl'); else msg(null, '', 'dl'); });
  }
  msg(null, '', 'keyMsg'); msg(null, '', 'aiErr'); msg(null, '', 'modeMsg');
  store.set('apiKey', apiKey);
  store.set('mic', $('mic').value);
  store.set('langs', langs.join(','));
  const model = $('model').value || TRANSLATE_MODEL;
  store.set('model', model);
  shownLang = langs[0];
  cfg = { apiKey, model, langs };

  $('startBtn').disabled = true;
  try {
    mic = await startMic({ deviceId: $('mic').value, onChunk, onEnded: onMicEnded });
  } catch (e) {
    $('startBtn').disabled = false;
    msg(`마이크를 켤 수 없어요: ${e.message}. 브라우저 주소창의 마이크 권한을 확인해 주세요.`, 'bad', 'micErr');
    return;
  }
  msg(null, '', 'micErr');
  $('micName').textContent = `🎤 ${mic.label} (${mic.sampleRate} Hz)`;
  renderMics();

  notLiveSince = 0; probing = false;
  if (mode === 'free' || (mode === 'auto' && !apiKey)) {
    engine = 'free';
    geminiRetryAt = Infinity;
    startFree();
    if (mode === 'auto') msg('API 키가 없어서 무료 크롬 번역으로 시작했어요.', 'info', 'modeMsg');
  } else {
    engine = 'gemini';
    startGemini();
  }

  running = true;
  startedAt = Date.now();
  await relay.setActive(room, true, [...langs, 'ko']).catch(e => log(`relay: ${e.message}`));
  $('startBtn').textContent = '수업 종료';
  $('startBtn').classList.add('stop');
  $('startBtn').disabled = false;
  $('timer').hidden = false;
  lockScreen();
}

async function stop() {
  running = false;
  stopGemini();
  if (free) { free.stop(); free = null; }
  engine = null;
  for (const l of Object.keys(live)) flushLive(l);
  if (mic) { mic.stop(); mic = null; }
  await relay.setActive(room, false).catch(() => {});
  $('startBtn').textContent = '수업 시작';
  $('startBtn').classList.remove('stop');
  $('meter').firstElementChild.style.width = '0';
  setDot('aiDot', 'aiState', '', '대기 중');
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function onChunk({ b64, rms }) {
  const now = Date.now();
  for (const l of links) l.sendAudio(b64, rms);
  for (const s of Object.values(segs)) s.tick(now);
  if (srcSeg) srcSeg.tick(now);
  if (running && mode === 'auto') autoSwitch(now);
  for (const l of Object.keys(live)) if (now - live[l].last >= 100) flushLive(l, now);
  $('meter').firstElementChild.style.width = `${Math.min(100, rms * 400)}%`;
  if (now % 1000 < 100) updateTimer(now);
}

function autoSwitch(now) {
  if (engine === 'gemini' && !probing) {
    if (links.some(l => l.state === 'error')) return switchToFree('오류: ' + (links.find(l => l.state === 'error').detail || ''));
    if (links.some(l => l.state !== 'live')) {
      if (!notLiveSince) notLiveSince = now;
      else if (now - notLiveSince > 20000) return switchToFree('20초 넘게 연결 안 됨');
    } else notLiveSince = 0;
  } else if (engine === 'free' && cfg.apiKey && now >= geminiRetryAt) {
    if (!probing) { probing = true; log('Gemini 다시 시도'); startGemini(); return; }
    if (links.length && links.every(l => l.state === 'live')) {
      log('Gemini 복구됨: Gemini 번역으로 돌아갑니다');
      probing = false; engine = 'gemini'; notLiveSince = 0;
      if (free) { free.stop(); free = null; }
      msg('Gemini 번역으로 다시 돌아왔어요.', 'info', 'modeMsg');
      updateAiStatus();
    } else if (links.some(l => l.state === 'error') || now - geminiRetryAt > 30000) {
      stopGemini(); probing = false; geminiRetryAt = now + GEMINI_RETRY_MS;
      log('Gemini 아직 사용 불가: 15분 뒤 다시 시도');
    }
  }
}

async function onMicEnded() {
  if (!running) return;
  log('마이크 연결이 끊겼어요. 다시 연결 중...');
  msg('마이크 연결이 끊겼어요. 다시 연결하는 중입니다...', 'warn', 'micErr');
  const tryAgain = async (n) => {
    if (!running) return;
    try {
      if (mic) mic.stop();
      mic = await startMic({ deviceId: '', onChunk, onEnded: onMicEnded });
      $('micName').textContent = `🎤 ${mic.label}`;
      msg(null, '', 'micErr');
      log('마이크 다시 연결됨');
    } catch {
      setTimeout(() => tryAgain(n + 1), Math.min(5000, 1000 * n));
    }
  };
  tryAgain(1);
}

function updateAiStatus() {
  if (!running && !links.length && !free) return;
  if (engine === 'free' && free) {
    const st = free.state;
    if (st === 'error') { setDot('aiDot', 'aiState', 'bad', '무료 번역 오류'); msg(`무료 번역 오류: ${free.detail}`, 'bad', 'aiErr'); }
    else setDot('aiDot', 'aiState', st === 'live' ? 'ok' : 'warn', st === 'live' ? '번역 중 (무료 크롬)' : '다시 연결 중 (무료)');
    return;
  }
  const states = links.map(l => l.state);
  const err = links.find(l => l.state === 'error');
  if (err) {
    setDot('aiDot', 'aiState', 'bad', '번역 오류');
    if (mode !== 'auto') msg(`번역 연결 오류: ${err.detail || ''}`, 'bad', 'aiErr');
    return;
  }
  if (states.length && states.every(s => s === 'live')) setDot('aiDot', 'aiState', 'ok', '번역 중 (Gemini)');
  else if (states.some(s => s === 'reconnecting')) setDot('aiDot', 'aiState', 'warn', '다시 연결 중');
  else if (states.length) setDot('aiDot', 'aiState', 'warn', '연결 중');
}

function updateTimer(now) {
  const s = Math.floor((now - startedAt) / 1000);
  const p = (n) => String(n).padStart(2, '0');
  $('timer').textContent = `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

async function lockScreen() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible' && (!wakeLock || wakeLock.released)) lockScreen(); });

function download() {
  const lines = transcript.map(t => `[${t.at.toLocaleTimeString()}] (${t.lang}) ${t.text}`);
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `수업자막_${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
}

// ---------- Init ----------
async function init() {
  $('apiKey').value = store.get('apiKey', '');
  $('model').value = store.get('model', TRANSLATE_MODEL);
  $('mode').value = store.get('mode', 'auto');
  renderLangs();
  renderMics();
  navigator.mediaDevices?.addEventListener?.('devicechange', renderMics);

  $('startBtn').onclick = () => (running ? stop() : start());
  $('bigQrBtn').onclick = () => { $('bigqr').style.display = 'flex'; };
  $('bigqr').onclick = () => { $('bigqr').style.display = 'none'; };
  $('copyBtn').onclick = () => navigator.clipboard.writeText(studentUrl(room)).then(() => msg('링크를 복사했어요.', 'info', 'copied'));
  $('newRoomBtn').onclick = async () => {
    if (running) { msg('수업 중에는 방을 바꿀 수 없어요.', 'warn', 'roomErr'); return; }
    if (confirm('새 QR 코드를 만들까요? 학생들은 새 QR을 다시 찍어야 해요.')) await claimRoom(true);
  };
  $('clearBtn').onclick = async () => {
    if (!confirm('학생 화면의 자막 기록을 모두 지울까요?')) return;
    await relay.clearRoom(room);
    $('out').innerHTML = ''; $('src').innerHTML = '';
  };
  $('dlBtn').onclick = download;
  window.addEventListener('beforeunload', (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } });

  if (RELAY_KIND === 'firebase' && !window.FIREBASE_CONFIG) {
    msg('Firebase 설정(config.js)이 아직 없어요. 설정 안내서를 확인해 주세요.', 'bad', 'cfg');
    setDot('relayDot', 'relayState', 'bad', '자막 서버 설정 필요');
    return;
  }
  try {
    relay = await createRelay(RELAY_KIND, window.FIREBASE_CONFIG);
    await relay.signIn();
    relay.watchConnection((ok) => setDot('relayDot', 'relayState', ok ? 'ok' : 'warn', ok ? '자막 서버 연결됨' : '자막 서버 재연결 중'));
    if (await claimRoom()) $('startBtn').disabled = false;
  } catch (e) {
    log(`relay init failed: ${e.message}`);
    msg(`자막 서버에 연결하지 못했어요: ${e.message}`, 'bad', 'cfg');
    setDot('relayDot', 'relayState', 'bad', '자막 서버 오류');
  }
}
init();
