import { createRelay } from './relay.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const code = (params.get('r') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const RELAY_KIND = params.get('relay') === 'mock' ? 'mock' : 'firebase';
const NAMES = { my: 'မြန်မာ', en: 'English', ja: '日本語', 'zh-Hans': '中文', vi: 'Tiếng Việt', es: 'Español', fr: 'Français', de: 'Deutsch', ru: 'Русский', mn: 'Монгол', th: 'ไทย', id: 'Indonesia', uz: 'Oʻzbek', ko: 'Original (원문)' };
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let relay, lang = null, unLines = null, unLive = null, meta = null, connected = false;
let follow = true;

function status(text) {
  let s = $('status');
  if (!text) { if (s) s.remove(); return; }
  if (!s) { s = document.createElement('div'); s.id = 'status'; $('feed').prepend(s); }
  s.textContent = text;
}
function partialEl() {
  let p = $('feed').querySelector('.partial');
  if (!p) { p = document.createElement('p'); p.className = 'partial'; $('feed').appendChild(p); }
  return p;
}
function scroll() { if (follow) $('feed').scrollTop = $('feed').scrollHeight; }
function addLine(text) {
  const feed = $('feed');
  const p = document.createElement('p');
  p.textContent = text;
  feed.insertBefore(p, partialEl());
  const all = feed.querySelectorAll('p:not(.partial)');
  all.forEach((el, i) => el.classList.toggle('old', i < all.length - 3));
  if (all.length > 300) all[0].remove();
  scroll();
}
function updateDot() {
  const live = connected && meta && meta.active;
  $('dot').className = `dot ${live ? 'ok' : connected ? 'warn' : ''}`;
}

function selectLang(l) {
  if (l === lang) return;
  lang = l;
  store.set('lang', l);
  if (unLines) unLines();
  if (unLive) unLive();
  $('feed').querySelectorAll('p').forEach(p => p.remove());
  unLines = relay.watchLines(code, l, (_k, v) => { status(''); addLine(v.x); });
  unLive = relay.watchLive(code, l, (t) => { partialEl().textContent = t; if (t) status(''); scroll(); });
}

function renderLangs(langs) {
  const sel = $('lang');
  const cur = [...sel.options].map(o => o.value).join();
  if (cur === langs.join()) return;
  sel.innerHTML = '';
  for (const l of langs) {
    const o = document.createElement('option');
    o.value = l; o.textContent = NAMES[l] || l;
    sel.appendChild(o);
  }
  const want = langs.includes(lang) ? lang : langs.includes(store.get('lang')) ? store.get('lang') : langs[0];
  sel.value = want;
  selectLang(want);
}

async function keepAwake() {
  try {
    if (navigator.wakeLock && document.visibilityState === 'visible') await navigator.wakeLock.request('screen');
  } catch {}
}

// Save today's captions in the chosen language as a text file.
async function save() {
  if (!relay || !lang) return;
  let lines = [];
  try { lines = await relay.getLines(code, lang); } catch (e) { alert(`Could not load captions: ${e.message}`); return; }
  lines = lines.filter(v => v && v.x);
  if (!lines.length) { alert('No captions yet.'); return; }
  const day = (t) => new Date(t).toLocaleDateString('sv-SE');
  const last = day(lines.at(-1).t || Date.now());
  const hm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const body = lines.filter(v => !v.t || day(v.t) === last).map(v => (v.t ? `[${hm(v.t)}] ` : '') + v.x);
  const text = [`Class captions ${last} (${NAMES[lang] || lang})`, '', ...body].join('\r\n');
  const blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `captions_${last}_${lang}.txt`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function init() {
  $('save').onclick = save;
  $('code').textContent = code;
  let fs = Number(store.get('fs', 24));
  const applyFs = () => { document.documentElement.style.setProperty('--fs', `${fs}px`); store.set('fs', fs); };
  applyFs();
  $('bigger').onclick = () => { fs = Math.min(56, fs + 3); applyFs(); scroll(); };
  $('smaller').onclick = () => { fs = Math.max(14, fs - 3); applyFs(); scroll(); };
  if (store.get('theme') === 'light') document.body.classList.add('light');
  $('theme').onclick = () => { document.body.classList.toggle('light'); store.set('theme', document.body.classList.contains('light') ? 'light' : 'dark'); };
  $('lang').onchange = (e) => selectLang(e.target.value);
  const feed = $('feed');
  feed.addEventListener('scroll', () => {
    follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
    $('jump').style.display = follow ? 'none' : 'block';
  });
  $('jump').onclick = () => { follow = true; scroll(); $('jump').style.display = 'none'; };
  document.addEventListener('visibilitychange', keepAwake);
  document.addEventListener('click', keepAwake, { once: true });
  keepAwake();

  if (!code) { status('Scan the QR code shown in class to join.'); return; }
  if (RELAY_KIND === 'firebase' && !window.FIREBASE_CONFIG) { status('Not configured yet.'); return; }
  try {
    relay = await createRelay(RELAY_KIND, window.FIREBASE_CONFIG);
  } catch (e) { status(`Could not connect: ${e.message}`); return; }
  relay.watchConnection((ok) => { connected = ok; updateDot(); });
  relay.watchMeta(code, (m) => {
    meta = m;
    updateDot();
    if (!m) { status(`Room ${code} not found. Please scan the QR code again.`); return; }
    renderLangs(m.langs && m.langs.length ? m.langs : ['en']);
    if (!m.active && !$('feed').querySelector('p:not(.partial)')) status('Waiting for the class to start…');
    else if (m.active && $('status') && !$('feed').querySelector('p:not(.partial)')) status('Class is live. Captions will appear when the teacher speaks.');
  });
}
init();
