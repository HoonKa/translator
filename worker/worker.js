// Cloudflare Worker: keeps the Gemini API key secret and hands the teacher page
// a short-lived, single-use Gemini Live token.
//
// Settings (Cloudflare dashboard > Worker > Settings > Variables and Secrets):
//   GEMINI_API_KEY   (Secret)  the AI Studio API key
//   CLASS_PASSWORD   (Secret)  password the teacher pages use
//   ALLOWED_ORIGINS  (Text)    e.g. https://hoonka.github.io
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

async function same(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}
