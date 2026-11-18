// Sentence translation with Gemini as TEXT (not audio): Chrome does the speech-to-text,
// and each finished sentence is sent once, translated into all students' languages at once.
// Goes through the key server (password) so the API key stays hidden, or directly with an API key.

const NAMES = { en: 'English', my: 'Burmese (Myanmar script)', vi: 'Vietnamese', mn: 'Mongolian (Cyrillic)', uz: 'Uzbek (Latin script)' };
const DIRECT_MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest'];

export class SentenceTranslator {
  /** opts: { tokenUrl, password, apiKey, glossary } */
  constructor(opts) { Object.assign(this, opts); this.requests = 0; }

  /** Returns { lang: text }. Throws Error (e.quota = true when it is a usage limit). */
  async translate(text, langs, context = '') {
    this.requests++;
    // The class topic helps Gemini fix technical terms the speech recognizer misheard.
    const topic = (this.getTopic && this.getTopic()) || '';
    if (topic) context = `[Class topic: ${topic}. Speech recognition often mishears technical terms (English terms may be written in Korean letters); interpret them to fit this topic.] ${context}`;
    const j = this.tokenUrl && this.password ? await this._viaServer(text, langs, context) : await this._direct(text, langs, context);
    if (j.error || !j.translations) { const e = new Error(j.error || 'no translation'); e.quota = !!j.quota || /quota|exhausted|rate/i.test(j.error || ''); throw e; }
    return j.translations;
  }

  async _viaServer(text, langs, context) {
    const r = await fetch(this.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'translate', password: this.password, text, langs, context, glossary: this.glossary || [] }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) return { error: '수업 비밀번호가 틀렸어요' };
    if (!r.ok && !j.error) return { error: `키 서버 오류 ${r.status}` };
    return j;
  }

  async _direct(text, langs, context) {
    const gloss = (this.glossary || []).map(g => `${g.src} => ${g.dst}`).join('\n');
    const prompt =
      "You translate a teacher's speech in a classroom (Korean or English, recognized by speech-to-text, may contain small recognition errors) " +
      'into other languages for students. Translate the NEW TEXT faithfully and naturally, fixing obvious recognition errors from context. ' +
      'Do not add explanations. Return JSON with one key per language code.\n' +
      `Languages: ${langs.map(l => `${l} = ${NAMES[l] || l}`).join(', ')}\n` +
      (gloss ? `Glossary (use these exact translations/spellings):\n${gloss}\n` : '') +
      (context ? `Previous text (context only, do not translate): ${context.slice(0, 600)}\n` : '') +
      `NEW TEXT: ${text}`;
    const schema = { type: 'OBJECT', properties: Object.fromEntries(langs.map(l => [l, { type: 'STRING' }])), required: langs };
    let last = '';
    for (const model of DIRECT_MODELS) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(this.apiKey)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2 } }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        try { return { translations: JSON.parse(j.candidates[0].content.parts.map(p => p.text || '').join('')) }; } catch { return { error: 'bad model output' }; }
      }
      last = (j.error && j.error.message) || `HTTP ${r.status}`;
      if (r.status === 429) return { error: last, quota: true };
    }
    return { error: last };
  }
}
