// law-app API — Cloudflare Worker
// Routes (mounted at law.medicom.vip/api/*):
//   GET  /api/ping     -> PIN check / health
//   GET  /api/search   -> proxy: Giluy Naot verdict search (no key, no quota)
//   GET  /api/laws     -> proxy: Giluy Naot laws list
//   GET  /api/law-text -> law full text from Wikisource (open law book)
//   POST /api/ask      -> Claude-powered research over the same sources
// Secrets required: APP_PIN, ANTHROPIC_API_KEY

const GN = 'https://www.giluy-naot.org.il';
const WIKI_API = 'https://he.wikisource.org/w/api.php';
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5';
const UA = { 'User-Agent': 'law-app/1.0 (private legal research; contact: owner)' };

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

async function gnSearch(params) {
  const url = GN + '/api/search?' + new URLSearchParams(params).toString();
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error('gn search ' + res.status);
  return res.json();
}

async function gnLaws(search) {
  const url = GN + '/api/laws?search=' + encodeURIComponent(search) + '&page=1';
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error('gn laws ' + res.status);
  return res.json();
}

async function wikiText(title) {
  const u = WIKI_API + '?action=parse&page=' + encodeURIComponent(title) +
    '&prop=text&format=json&formatversion=2&disableeditsection=1';
  const res = await fetch(u, { headers: UA });
  if (!res.ok) throw new Error('wiki ' + res.status);
  const data = await res.json();
  return (data && data.parse && data.parse.text) || '';
}

function casePageUrl(r) {
  const p = new URLSearchParams();
  if (r.case_number) p.set('case_number', r.case_number);
  if (r.case_type) p.set('case_type', r.case_type);
  return GN + '/search?' + p.toString();
}

function trimVerdict(r) {
  return {
    case_type: r.case_type || '', case_number: r.case_number || '',
    parties: stripHtml(r.parties || ''), court: r.court || '',
    judge: r.judge || '', decision_date: r.decision_date || '',
    decision_type: r.decision_type || '',
    snippet: stripHtml(r.snippet || '').slice(0, 400),
    pdf_url: r.pdf_url || '', page_url: casePageUrl(r),
  };
}

const TOOLS = [
  {
    name: 'search_verdicts',
    description: 'חיפוש פסקי דין והחלטות במאגר גילוי נאות. החזר תוצאות עם תקציר וקישור לקובץ המקור.',
    input_schema: {
      type: 'object',
      properties: {
        free_text: { type: 'string', description: 'טקסט חופשי לחיפוש בתוך פסקי הדין' },
        match_mode: { type: 'string', enum: ['exact', 'any'], description: 'exact = ביטוי מדויק, any = כל אחת מהמילים' },
        name: { type: 'string', description: 'שם צד (תובע/נתבע)' },
        judge: { type: 'string', description: 'שם שופט' },
        case_number: { type: 'string', description: 'מספר תיק, למשל 398/99' },
        case_type: { type: 'string', description: 'סוג הליך, למשל ע"א, בג"ץ, ת"א' },
        court_type: { type: 'string', description: 'ערכאה: עליון, מחוזי, שלום, עבודה, משפחה, תעבורה, רבני' },
        date_from: { type: 'string', description: 'מתאריך YYYY-MM-DD' },
        date_to: { type: 'string', description: 'עד תאריך YYYY-MM-DD' },
        sort: { type: 'string', enum: ['relevance', 'newest', 'oldest'] },
      },
    },
  },
  {
    name: 'search_laws',
    description: 'חיפוש חוקים, תקנות וצווים במדור החקיקה של גילוי נאות (מבוסס על ספר החוקים הפתוח). מחזיר שם חוק, מספר סעיפים וקישורים.',
    input_schema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'שם החוק או מילות חיפוש' } },
      required: ['search'],
    },
  },
  {
    name: 'get_law_text',
    description: 'קריאת הטקסט המלא של חוק מתוך ספר החוקים הפתוח (ויקיטקסט), לפי כותרת הדף בוויקיטקסט כפי שהוחזרה מ-search_laws בשדה wikisource_title.',
    input_schema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'כותרת דף החוק בוויקיטקסט' } },
      required: ['title'],
    },
  },
];

async function runTool(name, input, sources) {
  if (name === 'search_verdicts') {
    const p = { page: '1', per_page: '8', sort: input.sort || 'relevance' };
    if (input.free_text) { p.free_text = input.free_text; p.match_mode = input.match_mode || 'exact'; p.free_text_op = 'and'; }
    if (input.name) p.name = input.name;
    if (input.judge) p.judge = input.judge;
    if (input.case_number) p.case_number = input.case_number;
    if (input.case_type) p.case_type = input.case_type;
    if (input.court_type) p.court_type = input.court_type;
    if (input.date_from) p.date_from = input.date_from;
    if (input.date_to) p.date_to = input.date_to;
    const data = await gnSearch(p);
    const results = (data.results || []).map(trimVerdict);
    for (const r of results) {
      if (r.pdf_url) sources.push({ title: [r.case_type, r.case_number, r.parties].filter(Boolean).join(' '), url: r.pdf_url });
    }
    return { results };
  }
  if (name === 'search_laws') {
    const data = await gnLaws(input.search);
    const items = (data.items || []).slice(0, 8).map(l => ({
      name: l.name || '', law_type: l.law_type || '',
      section_count: l.section_count || '', updated_at: l.updated_at || '',
      wikisource_title: l.wikisource_url ? decodeURIComponent(l.wikisource_url.split('/wiki/')[1] || '') : '',
      wikisource_url: l.wikisource_url || '', knesset_url: l.knesset_url || '',
    }));
    for (const l of items) {
      if (l.wikisource_url) sources.push({ title: l.name, url: l.wikisource_url });
    }
    return { items };
  }
  if (name === 'get_law_text') {
    const html = await wikiText(input.title);
    const text = stripHtml(html).slice(0, 14000);
    sources.push({ title: input.title, url: 'https://he.wikisource.org/wiki/' + encodeURIComponent(input.title.replace(/ /g, '_')) });
    return { title: input.title, text };
  }
  throw new Error('unknown tool ' + name);
}

const SYSTEM = [
  'אתה עוזר מחקר משפטי לסטודנט למשפטים בישראל. ענה בעברית בלבד.',
  'לכל שאלה עובדתית על פסיקה או חקיקה חובה להשתמש בכלים: search_verdicts לפסיקה, search_laws לחקיקה, get_law_text לקריאת נוסח חוק.',
  'אסור להמציא פסקי דין, מספרי תיקים, שמות שופטים או סעיפי חוק. מה שלא נמצא בכלים, אמור במפורש שלא נמצא.',
  'בכל טענה משפטית ציין אסמכתה: שם פסק הדין ומספר התיק, או שם החוק ומספר הסעיף.',
  'מבנה התשובה: פתיחה קצרה עם התשובה, אחריה פירוט קצר, ולבסוף שורת "לתשומת לב" אם יש מגבלה (למשל שהתקציר אינו תחליף לקובץ המקור).',
  'היה תמציתי ומדויק. אל תיתן ייעוץ משפטי אישי; זהו כלי מחקר.',
].join('\n');

async function handleAsk(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'no_key' }, 501);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }
  const question = String(body.question || '').trim().slice(0, 2000);
  if (!question) return json({ error: 'empty_question' }, 400);

  const sources = [];
  const messages = [{ role: 'user', content: question }];
  for (let round = 0; round < 5; round++) {
    const res = await fetch(ANTHROPIC, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL, max_tokens: 2200, system: SYSTEM,
        tools: TOOLS, messages,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      return json({ error: 'anthropic_' + res.status, detail: t.slice(0, 300) }, 502);
    }
    const data = await res.json();
    messages.push({ role: 'assistant', content: data.content });
    const toolUses = (data.content || []).filter(b => b.type === 'tool_use');
    if (!toolUses.length || data.stop_reason !== 'tool_use') {
      const answer = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      const seen = new Set(); const uniq = [];
      for (const s of sources) { if (!seen.has(s.url)) { seen.add(s.url); uniq.push(s); } }
      return json({ answer, sources: uniq.slice(0, 10) });
    }
    const results = [];
    for (const tu of toolUses) {
      try {
        const out = await runTool(tu.name, tu.input || {}, sources);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 24000) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'שגיאה בביצוע החיפוש: ' + e.message, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return json({ error: 'too_many_rounds' }, 502);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (!env.APP_PIN) return json({ error: 'pin_not_configured' }, 503);
    if (request.headers.get('X-App-Pin') !== env.APP_PIN) return json({ error: 'unauthorized' }, 401);

    try {
      if (path === '/api/ping') return json({ ok: true });
      if (path === '/api/search') {
        const data = await gnSearch(Object.fromEntries(url.searchParams));
        return json(data);
      }
      if (path === '/api/laws') {
        const search = url.searchParams.get('search') || '';
        const data = await gnLaws(search);
        return json(data);
      }
      if (path === '/api/law-text') {
        const title = url.searchParams.get('title') || '';
        if (!title) return json({ error: 'missing_title' }, 400);
        const html = await wikiText(title);
        return json({ title, html });
      }
      if (path === '/api/ask' && request.method === 'POST') return handleAsk(request, env);
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      return json({ error: 'upstream', detail: String(e.message || e).slice(0, 200) }, 502);
    }
  },
};
