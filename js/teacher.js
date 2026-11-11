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
  ['en', 'English'], ['my', 'မြန်မာ (미얀마어)'], ['vi', 'Tiếng Việt (베트남어)'],
  ['mn', 'Монгол (몽골어)'], ['uz', 'Oʻzbek (우즈베크어)'],
];
const DEFAULT_LANGS = 'en,my,vi,mn,uz';
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
let cfg = null;         // { apiKey, tokenUrl, password, model, langs }
const hasCred = () => !!(cfg && (cfg.apiKey || (cfg.tokenUrl && cfg.password)));
const GEMINI_RETRY_MS = 15 * 60 * 1000;
const srcLang = () => store.get('srcLang', 'ko');

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
  const saved = (store.get('langs2', DEFAULT_LANGS) || DEFAULT_LANGS).split(',');
  $('langs').innerHTML = '';
  for (const [code, name] of LANGS) {
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" value="${code}"> ${name}`;
    l.querySelector('input').checked = saved.includes(code);
    l.querySelector('input').addEventListener('change', () => store.set('langs2', selectedLangs().join(',')));
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
async function fetchToken() {
  let r;
  try {
    r = await fetch(cfg.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: cfg.password }) });
  } catch (e) { throw new Error(`키 서버에 연결할 수 없어요 (${e.message})`); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { const e = new Error('수업 비밀번호가 틀렸어요'); e.fatal = true; throw e; }
  if (r.status === 403 || r.status === 500 || (r.status === 502 && /api key|permission/i.test(j.error || ''))) {
    const e = new Error(`키 서버 설정 오류: ${j.error || r.status}`); e.fatal = true; throw e;
  }
  if (!r.ok || !j.token) throw new Error(j.error || `키 서버 오류 ${r.status}`);
  return j.token;
}

function startGemini() {
  const { apiKey, model, langs } = cfg;
  const getToken = cfg.tokenUrl && cfg.password ? fetchToken : undefined;
  segs = {};
  for (const l of langs) segs[l] = makeSegmenter(l);
  srcSeg = makeSegmenter('ko');
  links = langs.map((lang, i) => new TranslatorLink({
    apiKey, getToken, model, lang, wantSource: i === 0, wsUrl: WS_OVERRIDE, ...FAST,
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
    langs: cfg.langs, translators, srcLang: srcLang(),
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
  const tokenUrl = $('tokenUrl').value.trim();
  const password = $('classPw').value;
  const cred = apiKey || (tokenUrl && password);
  if (mode === 'gemini' && !cred) { msg('관리자 설정에서 키 서버 주소와 비밀번호(또는 API 키)를 먼저 넣어 주세요.', 'warn', 'keyMsg'); $('adminBox').open = true; return; }
  if (mode !== 'gemini') {
    const sup = freeModeSupport();
    if (mode === 'free' && (!sup.speech || !sup.translator)) {
      msg('이 브라우저는 무료 모드를 지원하지 않아요. 최신 크롬(138 이상)이나 엣지를 써 주세요.', 'bad', 'keyMsg'); return;
    }
    translators = prepareTranslators(langs, srcLang(), (l, p) => { if (p < 1) msg(`번역 모델 내려받는 중 (${l}) ${Math.round(p * 100)}%`, 'info', 'dl'); else msg(null, '', 'dl'); });
  }
  msg(null, '', 'keyMsg'); msg(null, '', 'aiErr'); msg(null, '', 'modeMsg');
  store.set('apiKey', apiKey);
  store.set('tokenUrl', tokenUrl);
  store.set('classPw', password);
  store.set('mic', $('mic').value);
  store.set('langs2', langs.join(','));
  const model = $('model').value || TRANSLATE_MODEL;
  store.set('model', model);
  shownLang = langs[0];
  cfg = { apiKey, tokenUrl, password, model, langs };

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
  if (mode === 'free' || (mode === 'auto' && !cred)) {
    engine = 'free';
    geminiRetryAt = Infinity;
    startFree();
    if (mode === 'auto') msg('이 브라우저에는 수업 비밀번호가 저장돼 있지 않아서 무료 크롬 번역으로 시작했어요. ⚙️ 관리자 설정에 비밀번호를 넣으면 Gemini로 번역해요.', 'warn', 'modeMsg');
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
    const errs = links.filter(l => l.state === 'error');
    if (links[0] && links[0].state === 'error' || (links.length && errs.length === links.length)) return switchToFree('오류: ' + (errs[0].detail || ''));
    // Another language failed alone (e.g. a usage limit): keep the others running and retry it in 2 minutes.
    for (const l of errs) {
      if (!l.retryAt) { l.retryAt = now + 120000; log(`[${l.lang}] 오류, 2분 뒤 다시 시도: ${l.detail}`); }
      else if (now >= l.retryAt) { l.retryAt = 0; l.start(); }
    }
    if (links[0] && links[0].state !== 'live') {
      if (!notLiveSince) notLiveSince = now;
      else if (now - notLiveSince > 20000) return switchToFree('20초 넘게 연결 안 됨');
    } else notLiveSince = 0;
  } else if (engine === 'free' && hasCred() && now >= geminiRetryAt) {
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
// A setup link (#setup=...) lets the administrator configure a teacher's PC once.
function applySetupLink() {
  const m = location.hash.match(/setup=([^&]+)/);
  if (!m) return false;
  try {
    const c = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))));
    if (c.key !== undefined) store.set('apiKey', c.key);
    if (c.tokenUrl !== undefined) store.set('tokenUrl', c.tokenUrl);
    if (c.pw !== undefined) store.set('classPw', c.pw);
    if (c.langs) store.set('langs2', c.langs);
    if (c.mode) store.set('mode', c.mode);
    if (c.model) store.set('model', c.model);
    store.set('configured', '1');
  } catch (e) { console.warn('bad setup link', e); }
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}
function makeSetupLink() {
  const tokenUrl = $('tokenUrl').value.trim(), pw = $('classPw').value;
  const server = tokenUrl && pw;
  const c = { key: server ? '' : $('apiKey').value.trim(), tokenUrl, pw, langs: selectedLangs().join(','), mode: $('mode').value, model: $('model').value };
  const enc = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(c)))));
  const u = new URL(location.href); u.hash = `setup=${enc}`;
  return u.toString();
}

// KakaoTalk / Naver / Instagram built-in browsers block speech recognition and keep separate settings.
function checkBrowser() {
  const ua = navigator.userAgent;
  const inApp = /KAKAOTALK|NAVER\(|Instagram|FBAN|FBAV|Line\/|DaumApps|everytimeApp/i.test(ua);
  const mobile = /Android|iPhone|iPad/i.test(ua);
  if (inApp) {
    const d = document.createElement('div');
    d.className = 'msg bad';
    d.innerHTML = '카카오톡 같은 앱 안의 브라우저에서는 마이크와 음성 인식이 제대로 동작하지 않아요. <b>크롬에서 열어 주세요.</b> ';
    const b = document.createElement('button');
    b.textContent = '크롬으로 열기';
    b.style.marginTop = '8px';
    b.onclick = () => {
      if (/KAKAOTALK/i.test(ua)) location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href);
      else if (/Android/i.test(ua)) location.href = `intent://${location.host}${location.pathname}${location.search}#Intent;scheme=https;package=com.android.chrome;end`;
      else navigator.clipboard.writeText(location.href).then(() => alert('주소를 복사했어요. 크롬이나 사파리에 붙여넣어 주세요.'));
    };
    d.appendChild(b);
    $('msgs').appendChild(d);
  } else if (mobile) {
    msg('선생님 화면은 PC 크롬에서 쓰도록 만들었어요. 휴대폰에서도 되지만 화면이 꺼지면 번역이 멈춰요.', 'info', 'mobileMsg');
  }
}

async function init() {
  checkBrowser();
  const fromLink = applySetupLink();
  $('apiKey').value = store.get('apiKey', '');
  $('tokenUrl').value = store.get('tokenUrl', '') || window.TOKEN_URL || '';
  $('classPw').value = store.get('classPw', '');
  $('model').value = store.get('model', TRANSLATE_MODEL);
  $('mode').value = store.get('mode', 'auto');
  renderLangs();
  renderMics();
  navigator.mediaDevices?.addEventListener?.('devicechange', renderMics);

  $('startBtn').onclick = () => (running ? stop() : start());
  // Big QR: the browser's Back button closes it instead of leaving the page.
  const showBig = (on) => { $('bigqr').style.display = on ? 'flex' : 'none'; };
  $('bigQrBtn').onclick = () => { history.pushState({ bigqr: true }, ''); showBig(true); };
  $('bigqr').onclick = () => { if (history.state && history.state.bigqr) history.back(); else showBig(false); };
  window.addEventListener('popstate', () => showBig(!!(history.state && history.state.bigqr)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('bigqr').style.display === 'flex') $('bigqr').click(); });
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
  const showSrc = () => { $('srcBtn').textContent = srcLang() === 'ko' ? '말하는 언어: 한국어' : 'Speaking: English'; };
  showSrc();
  $('srcBtn').onclick = () => {
    store.set('srcLang', srcLang() === 'ko' ? 'en' : 'ko');
    showSrc();
    if (running && free) {
      // Restart the free engine with the new speaking language (the click lets the browser load translators).
      translators = prepareTranslators(cfg.langs, srcLang());
      free.stop(); free = null; startFree();
    }
  };
  $('setupLinkBtn').onclick = () => {
    store.set('apiKey', $('apiKey').value.trim()); store.set('tokenUrl', $('tokenUrl').value.trim()); store.set('classPw', $('classPw').value); store.set('configured', '1');
    navigator.clipboard.writeText(makeSetupLink()).then(() => msg('설정 링크를 복사했어요. 선생님 PC 크롬에서 한 번 열어주세요.', 'info', 'copied'));
  };
  if (store.get('configured') !== '1' && !store.get('apiKey') && !store.get('classPw')) $('adminBox').open = true;
  if (fromLink) msg('이 PC에 번역 설정을 저장했어요. 이제 이 페이지를 즐겨찾기 하고 "수업 시작"만 누르면 돼요.', 'info', 'setupOk');
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
