// Cloudflare Worker: keeps the Gemini API key secret and hands the teacher page
// a short-lived, single-use Gemini Live token.
//
// Settings (Cloudflare dashboard > Worker > Settings > Variables and Secrets):
//   GEMINI_API_KEY   (Secret)  the AI Studio API key
//   CLASS_PASSWORD   (Secret)  password the teacher pages use
//   ALLOWED_ORIGINS  (Text)    e.g. https://hoonka.github.io
//   TEXT_MODEL       (Text, optional) model for sentence translation, default gemini-flash-lite-latest
//
// Requests (POST JSON, always with "password"):
//   {}                                         -> { token }  single-use Gemini Live token
//   { action: "translate", text, langs, glossary, context } -> { translations: { en: "...", ... } }
export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || 'https://hoonka.github.io').split(',').map(s => s.trim());
    const okOrigin = allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Vary': 'Origin',
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json({ ok: true, info: 'translator token server' });
    if (!okOrigin) return json({ error: 'origin not allowed' }, 403);
    if (!env.GEMINI_API_KEY || !env.CLASS_PASSWORD) return json({ error: 'server not configured' }, 500);

    const body = await req.json().catch(() => ({}));
    if (!(await same(String(body.password || ''), env.CLASS_PASSWORD))) return json({ error: 'wrong password' }, 401);

    if (body.action === 'translate') return json(await translate(env, body), 200);

    const now = Date.now();
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        uses: 1,                                                   // one connection per token
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),  // connection may run 30 min
        newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(), // must connect within 2 min
      }),
    });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.name) return json({ error: (t.error && t.error.message) || 'token request failed', status: r.status }, 502);
    return json({ token: t.name });
  },
};

const NAMES = { en: 'English', my: 'Burmese (Myanmar script)', vi: 'Vietnamese', mn: 'Mongolian (Cyrillic)', uz: 'Uzbek (Latin script)', ja: 'Japanese', 'zh-Hans': 'Simplified Chinese' };

// One request translates one classroom sentence into every language the students read.
async function translate(env, body) {
  const text = String(body.text || '').slice(0, 2000);
  const langs = (Array.isArray(body.langs) ? body.langs : []).filter(l => /^[a-zA-Z-]{2,8}$/.test(l)).slice(0, 8);
  if (!text || !langs.length) return { translations: {} };
  const gloss = (Array.isArray(body.glossary) ? body.glossary : []).slice(0, 100).map(g => `${g.src} => ${g.dst}`).join('\n');
  const prompt =
    'You translate a teacher\'s speech in a classroom (Korean or English, recognized by speech-to-text, may contain small recognition errors) ' +
    'into other languages for students. Translate the NEW TEXT faithfully and naturally, fixing obvious recognition errors from context. ' +
    'Do not add explanations. Return JSON with one key per language code.\n' +
    `Languages: ${langs.map(l => `${l} = ${NAMES[l] || l}`).join(', ')}\n` +
    (gloss ? `Glossary (use these exact translations/spellings):\n${gloss}\n` : '') +
    (body.topic ? `Class topic: ${String(body.topic).slice(0, 200)} (use it to fix misheard technical terms)\n` : '') +
    (body.context ? `Previous text (context only, do not translate): ${String(body.context).slice(0, 600)}\n` : '') +
    `NEW TEXT: ${text}`;
  const schema = { type: 'OBJECT', properties: Object.fromEntries(langs.map(l => [l, { type: 'STRING' }])), required: langs };
  const models = (env.TEXT_MODEL || 'gemini-flash-lite-latest,gemini-flash-latest').split(',').map(s => s.trim());
  let last = '';
  for (const model of models) {
    for (const thinking of [true, false]) {
      const generationConfig = { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2 };
      if (thinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        try { return { translations: JSON.parse(j.candidates[0].content.parts.map(p => p.text || '').join('')), model }; }
        catch { return { error: 'bad model output', model }; }
      }
      last = (j.error && j.error.message) || `HTTP ${r.status}`;
      if (r.status === 429) return { error: last, quota: true, model };
      if (r.status === 400 && /thinking/i.test(last)) continue;   // model does not take thinkingConfig: try without
      break;                                                       // try the next model
    }
  }
  return { error: last };
}

async function same(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}
