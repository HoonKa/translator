// Caption relay between the teacher PC and the students' phones.
// Default: Firebase Realtime Database. "mock" keeps everything inside one
// browser (used for local testing only).
//
// Data layout:
//   rooms/{CODE}/meta  = { owner, langs: ['en'], active, startedAt, updatedAt }
//   rooms/{CODE}/live/{lang}           = text of the line being spoken right now
//   rooms/{CODE}/lines/{lang}/{pushId} = { x: text, t: time }
const FB = 'https://www.gstatic.com/firebasejs/10.12.2';

export async function createRelay(kind, firebaseConfig) {
  if (kind === 'mock') return mockRelay();
  return firebaseRelay(firebaseConfig);
}

async function firebaseRelay(cfg) {
  const [{ initializeApp }, dbm, authm] = await Promise.all([
    import(`${FB}/firebase-app.js`),
    import(`${FB}/firebase-database.js`),
    import(`${FB}/firebase-auth.js`),
  ]);
  const { getDatabase, ref, set, update, push, get, remove, onValue, onChildAdded, query, limitToLast, serverTimestamp, onDisconnect } = dbm;
  const app = initializeApp(cfg);
  const db = getDatabase(app);
  let uid = null;

  async function signIn() {
    const { getAuth, signInAnonymously, onAuthStateChanged } = authm;
    const auth = getAuth(app);
    await new Promise((res) => { const u = onAuthStateChanged(auth, () => { u(); res(); }); });
    if (!auth.currentUser) await signInAnonymously(auth);
    uid = auth.currentUser.uid;
    return uid;
  }

  const api = {
    kind: 'firebase',
    signIn,
    /** Returns true if the room is ours (new or created by us before). */
    async claimRoom(code, langs) {
      const r = ref(db, `rooms/${code}/meta`);
      const snap = await get(r).catch(() => null);
      if (snap && snap.exists() && snap.val().owner !== uid) return false;
      try {
        await update(r, { owner: uid, langs, active: false, updatedAt: serverTimestamp() });
        return true;
      } catch { return false; }
    },
    async setActive(code, active, langs) {
      const r = ref(db, `rooms/${code}/meta`);
      const v = { active, updatedAt: serverTimestamp() };
      if (langs) v.langs = langs;
      if (active) v.startedAt = serverTimestamp();
      await update(r, v);
      // If the PC loses its connection, phones will see the class as paused.
      if (active) onDisconnect(ref(db, `rooms/${code}/meta/active`)).set(false);
    },
    pushLine(code, lang, text) {
      return push(ref(db, `rooms/${code}/lines/${lang}`), { x: text, t: serverTimestamp() });
    },
    setLive(code, lang, text) {
      return set(ref(db, `rooms/${code}/live/${lang}`), text);
    },
    async clearRoom(code) {
      await Promise.all([remove(ref(db, `rooms/${code}/lines`)), remove(ref(db, `rooms/${code}/live`))]);
    },
    watchMeta(code, cb) { return onValue(ref(db, `rooms/${code}/meta`), s => cb(s.val())); },
    watchLive(code, lang, cb) { return onValue(ref(db, `rooms/${code}/live/${lang}`), s => cb(s.val() || '')); },
    watchLines(code, lang, cb, n = 60) {
      return onChildAdded(query(ref(db, `rooms/${code}/lines/${lang}`), limitToLast(n)), s => cb(s.key, s.val()));
    },
    watchConnection(cb) { return onValue(ref(db, '.info/connected'), s => cb(!!s.val())); },
  };
  return api;
}

// ---- Local mock (same browser, BroadcastChannel) ----
function mockRelay() {
  const KEY = 'mockdb';
  const ch = new BroadcastChannel('mockdb');
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = (db) => localStorage.setItem(KEY, JSON.stringify(db));
  const listeners = new Set();
  const notify = (path) => { for (const l of listeners) l(path); };
  ch.onmessage = (e) => notify(e.data);
  const write = (path, fn) => {
    const db = load(); fn(db); save(db); notify(path); ch.postMessage(path);
  };
  const getPath = (db, path) => path.split('/').reduce((o, k) => (o ? o[k] : undefined), db);
  const setPath = (db, path, val) => {
    const ks = path.split('/'); let o = db;
    for (const k of ks.slice(0, -1)) o = o[k] = o[k] || {};
    if (val === null) delete o[ks.at(-1)]; else o[ks.at(-1)] = val;
  };
  let seq = 0;
  const watch = (prefix, fn) => {
    const l = (p) => { if (p.startsWith(prefix) || prefix.startsWith(p)) fn(); };
    listeners.add(l); fn();
    return () => listeners.delete(l);
  };
  return {
    kind: 'mock',
    async signIn() { return 'mock-uid'; },
    async claimRoom(code, langs) { write(`rooms/${code}/meta`, db => setPath(db, `rooms/${code}/meta`, { ...(getPath(db, `rooms/${code}/meta`) || {}), owner: 'mock-uid', langs, active: false })); return true; },
    async setActive(code, active, langs) { write(`rooms/${code}/meta`, db => { const m = getPath(db, `rooms/${code}/meta`) || {}; m.active = active; if (langs) m.langs = langs; setPath(db, `rooms/${code}/meta`, m); }); },
    pushLine(code, lang, text) { const id = String(Date.now()).padStart(15, '0') + '-' + (seq++); write(`rooms/${code}/lines/${lang}`, db => setPath(db, `rooms/${code}/lines/${lang}/${id}`, { x: text, t: Date.now() })); },
    setLive(code, lang, text) { write(`rooms/${code}/live/${lang}`, db => setPath(db, `rooms/${code}/live/${lang}`, text)); },
    async clearRoom(code) { write(`rooms/${code}`, db => { setPath(db, `rooms/${code}/lines`, null); setPath(db, `rooms/${code}/live`, null); }); },
    watchMeta(code, cb) { return watch(`rooms/${code}/meta`, () => cb(getPath(load(), `rooms/${code}/meta`) || null)); },
    watchLive(code, lang, cb) { return watch(`rooms/${code}/live/${lang}`, () => cb(getPath(load(), `rooms/${code}/live/${lang}`) || '')); },
    watchLines(code, lang, cb, n = 60) {
      const seen = new Set();
      return watch(`rooms/${code}/lines/${lang}`, () => {
        const o = getPath(load(), `rooms/${code}/lines/${lang}`) || {};
        const keys = Object.keys(o).sort().slice(-n);
        for (const k of keys) if (!seen.has(k)) { seen.add(k); cb(k, o[k]); }
      });
    },
    watchConnection(cb) { cb(true); return () => {}; },
  };
}
