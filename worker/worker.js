// law-app API — Cloudflare Worker
// Routes (mounted at law.medicom.vip/api/*):
//   GET  /api/ping     -> PIN check / health
//   GET  /api/search   -> proxy: Giluy Naot verdict search (no key, no quota)
//   GET  /api/laws     -> proxy: Giluy Naot laws list
//   GET  /api/law-text -> law full text from Wikisource (open law book)
//   POST /api/ask      -> Claude-powered research over the same sources
//   GET  /api/skills   -> list the account's API Skills (custom + Anthropic built-ins)
//   POST /api/skill-run-> run a task with selected Skills attached (container.skills)
//   GET  /api/file     -> download a file a Skill created (Files API proxy)
// Secrets required: APP_PIN, ANTHROPIC_API_KEY

const GN = 'https://www.giluy-naot.org.il';
const WIKI_API = 'https://he.wikisource.org/w/api.php';
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_V1 = 'https://api.anthropic.com/v1';
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
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

async function searchLaws(search) {
  // Primary: Wikisource (the open law book) full-text search.
  try {
    const u = WIKI_API + '?action=query&list=search&srsearch=' + encodeURIComponent(search) +
      '&srnamespace=0&srlimit=20&format=json&formatversion=2';
    const res = await fetch(u, { headers: UA });
    if (res.ok) {
      const data = await res.json();
      const hits = (data.query && data.query.search) || [];
      if (hits.length) {
        const items = hits.map(h => ({
          id: h.title,
          name: h.title,
          law_type: '',
          section_count: '',
          updated_at: h.timestamp || '',
          wikisource_url: 'https://he.wikisource.org/wiki/' + encodeURIComponent(h.title.replace(/ /g, '_')),
          knesset_url: '',
        }));
        const total = (data.query.searchinfo && data.query.searchinfo.totalhits) || items.length;
        return { items, total };
      }
    }
  } catch (e) { /* fall through to Giluy Naot */ }
  // Fallback: Giluy Naot laws list.
  const url = GN + '/api/laws?q=' + encodeURIComponent(search) + '&page=1';
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error('gn laws ' + res.status);
  return res.json();
}

async function verdictText(id, offset = 0) {
  const res = await fetch(GN + '/verdict/' + encodeURIComponent(id), { headers: UA });
  if (!res.ok) throw new Error('gn verdict ' + res.status);
  const html = await res.text();
  const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  // The ruling body lives in whitespace-pre-wrap blocks; everything else on the page is chrome.
  const blocks = [];
  const re = /<(\w+)[^>]*class="[^"]*whitespace-pre-wrap[^"]*"[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(noScripts)) !== null) {
    const t = stripHtml(m[2]);
    if (t) blocks.push(t);
  }
  const full = blocks.length ? blocks.join('\n') : stripHtml(noScripts);
  const CHUNK = 18000;
  const start = Math.max(0, offset | 0);
  const text = full.slice(start, start + CHUNK);
  const next = start + CHUNK < full.length ? start + CHUNK : null;
  return { text, total_chars: full.length, next_offset: next };
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
    id: r.id || '',
    case_type: r.case_type || '', case_number: r.case_number || '',
    parties: stripHtml(r.parties || ''), court: r.court || '',
    judge: r.judge || '', decision_date: r.decision_date || '',
    decision_type: r.decision_type || '',
    snippet: stripHtml(r.snippet || '').slice(0, 400),
    pdf_url: r.pdf_url || '',
    page_url: r.id ? GN + '/verdict/' + r.id : casePageUrl(r),
  };
}

const TOOLS = [
  {
    name: 'search_verdicts',
    description: 'חיפוש פסקי דין והחלטות במאגר גילוי נאות. מחזיר תקצירים בלבד, וכן שדה id לכל פסק דין, לקריאת הנוסח המלא באמצעות get_verdict_text.',
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
    description: 'חיפוש חוקים, תקנות וצווים בספר החוקים הפתוח (ויקיטקסט), עם גיבוי במדור החקיקה של גילוי נאות. מחזיר שם חוק וקישורים.',
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
  {
    name: 'get_verdict_text',
    description: 'קריאת הנוסח המלא של פסק דין מתוך דף פסק הדין בגילוי נאות, לפי שדה id שהוחזר מ-search_verdicts. הנוסח מוחזר בקטעים של 18,000 תווים: התוצאה כוללת total_chars ו־next_offset. אם next_offset אינו null, הנוסח לא נגמר, ויש לקרוא את ההמשך בקריאה נוספת עם offset=next_offset, שוב ושוב עד סוף הנוסח או עד השלמת הדיון הדרוש. חובה לקרוא כך את פסקי הדין המרכזיים לפני ניסוח התשובה, ולא להסתפק בתקצירים.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'מזהה פסק הדין (id) מתוצאות search_verdicts' },
        offset: { type: 'number', description: 'היסט תווים להמשך קריאה, כפי שהוחזר בשדה next_offset בקריאה הקודמת. ברירת מחדל 0.' },
      },
      required: ['id'],
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
    return { results };
  }
  if (name === 'search_laws') {
    const data = await searchLaws(input.search);
    const items = (data.items || []).slice(0, 8).map(l => ({
      name: l.name || '', law_type: l.law_type || '',
      section_count: l.section_count || '', updated_at: l.updated_at || '',
      wikisource_title: l.wikisource_url ? decodeURIComponent(l.wikisource_url.split('/wiki/')[1] || '') : '',
      wikisource_url: l.wikisource_url || '', knesset_url: l.knesset_url || '',
    }));
    return { items };
  }
  if (name === 'get_law_text') {
    const html = await wikiText(input.title);
    const text = stripHtml(html).slice(0, 14000);
    sources.push({ title: input.title, url: 'https://he.wikisource.org/wiki/' + encodeURIComponent(input.title.replace(/ /g, '_')) });
    return { title: input.title, text };
  }
  if (name === 'get_verdict_text') {
    const r = await verdictText(input.id, input.offset || 0);
    const url = GN + '/verdict/' + input.id;
    sources.push({ title: 'פסק הדין המלא בגילוי נאות', url });
    return { url, ...r };
  }
  throw new Error('unknown tool ' + name);
}

const SYSTEM = [
  'אתה עוזר מחקר משפטי לסטודנט למשפטים בישראל. ענה בעברית בלבד.',
  'לכל שאלה עובדתית על פסיקה או חקיקה חובה להשתמש בכלים: search_verdicts לפסיקה, search_laws לחקיקה, get_law_text לקריאת נוסח חוק.',
  'תוצאות search_verdicts הן תקצירים בלבד. לפני ניסוח התשובה קרא באמצעות get_verdict_text את נוסחם המלא של פסק הדין הרלוונטי ביותר, או של שני פסקי הדין הרלוונטיים ביותר, ובסס את התשובה על הנוסח המלא.',
  'הנוסח מוחזר בקטעים: כל עוד next_offset אינו null, המשך לקרוא את אותו פסק דין עם offset=next_offset עד שהגעת לסוף הנוסח, או לפחות עד שהשלמת את חלק הדיון וההכרעה. אל תכתוב שהנוסח נקטע או שאין בידך הנוסח המלא בלי שניסית להמשיך לקרוא בקטעים.',
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
  const model = String(env.MODEL || DEFAULT_MODEL);
  const effortRaw = String(env.EFFORT || 'high').toLowerCase();
  const effort = EFFORTS.includes(effortRaw) ? effortRaw : null;
  const messages = [{ role: 'user', content: question }];
  for (let round = 0; round < 12; round++) {
    const payload = {
      model, max_tokens: 8000, system: SYSTEM,
      tools: TOOLS, messages,
    };
    if (effort) payload.output_config = { effort };
    const res = await fetch(ANTHROPIC, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
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

/* ---------- API Skills (the legal plugin skills Eran uploaded to the Console) ---------- */

function anthropicHeaders(env, extra) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    ...(extra || {}),
  };
}

async function listSkills(env) {
  const skills = [];
  let page = null;
  for (let i = 0; i < 3; i++) {
    const u = ANTHROPIC_V1 + '/skills?limit=100' + (page ? '&page=' + encodeURIComponent(page) : '');
    const res = await fetch(u, { headers: anthropicHeaders(env) });
    if (!res.ok) {
      const t = await res.text();
      const err = new Error('anthropic_' + res.status);
      err.detail = t.slice(0, 300);
      throw err;
    }
    const data = await res.json();
    for (const s of data.data || []) {
      const source = typeof s.source === 'string' ? s.source : ((s.source && s.source.type) || '');
      skills.push({
        id: s.id,
        name: s.display_name || s.display_title || s.name || s.id,
        source,
      });
    }
    page = data.next_page || null;
    if (!page) break;
  }
  return skills;
}

async function handleSkillsList(env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'no_key' }, 501);
  try {
    return json({ skills: await listSkills(env) });
  } catch (e) {
    return json({ error: e.message, detail: e.detail || '' }, 502);
  }
}

const SKILL_DESCS = {
 "asmachtaot-bemismach": "שגרת המקורות והאימות למסמך שאינו משפטי מלכתחילה אך נשען על דין ישראלי: חוזר, נוהל, מכתב רשמי, נייר עמדה, הצעת מחקר, מאמר או מצגת שמופיעים בהם חוק, תקנה, סעיף, תוספת או פסק דין.",
 "brief": "תדריך מחקר משפטי במקורות ישראליים.",
 "chavat-daat-mumche-refui": "בניית שלד לחוות דעת מומחה רפואי בתביעת רשלנות רפואית לפי הדין הישראלי, על בסיס ספרות מאומתת והנחיות קליניות המצוטטות מילה במילה.",
 "chipus-psika": "איתור פסקי דין והחלטות של בתי המשפט בישראל, מכל הערכאות, במאגר \"גילוי נאות\" — תחילה דרך מחבר ה-MCP או ה-API הרשמי עם המפתח האישי, ובגיבוי בדפדפן הפנימי בטופס החיפוש המובנה: חיפוש לפי מספר תיק, סוג הליך, שם צד, שופט, ערכאה, תאריכים",
 "compliance-check": "בדיקת ציות לרגולציה הישראלית עבור פעולה, מוצר או יוזמה.",
 "dinei-avoda": "ניתוח סוגיות בדיני עבודה לפי הדין הישראלי.",
 "dinei-mishpacha": "ניתוח סוגיות בדיני משפחה לפי הדין הישראלי.",
 "dinei-nezikin": "ניתוח סוגיות בדיני נזיקין לפי הדין הישראלי.",
 "dinei-reayot": "ניתוח שאלות בדיני ראיות לפי הדין הישראלי.",
 "hadlut-pirayon": "ניתוח סוגיות בחדלות פירעון ושיקום כלכלי לפי הדין הישראלי.",
 "itur-mumche": "איתור ובדיקת רקע של מומחה רפואי לחוות דעת בהליך משפטי בישראל: מועמדים לפי תחום ואזור, תחילה מהמינויים בפועל בפסיקה ובנוסף מהאלפון mumhe.com; ניסיון המומחה בפסיקה בגילוי נאות; סיווג התפקיד בכל החלטה (מומחה מטעם בית המשפט, מומחה מטע",
 "ktiva-akademit": "ליווי כתיבה משפטית אקדמית בעברית, ובכללה עבודה סמינריונית, רפרט ומאמר.",
 "legal-response": "ניסוח מכתבים ותגובות משפטיות לפי הדין הישראלי, עם בדיקות הסלמה מובנות.",
 "legal-risk-assessment": "הערכת סיכון משפטי במדרג מובנה לפי חומרה והסתברות, בהקשר הדין הישראלי.",
 "meeting-briefing": "הכנה מובנית לדיון, לפגישה משפטית, לסמינר או למוט קורט, ומעקב אחר משימות שנגזרות מהם.",
 "mekarkein": "ניתוח סוגיות במקרקעין לפי הדין הישראלי.",
 "mishpat-minhali": "ניתוח סוגיות במשפט מנהלי וחוקתי לפי הדין הישראלי, לרבות ביקורת שיפוטית על רשויות.",
 "mishpat-plili": "ניתוח סוגיות במשפט פלילי מהותי ובסדר דין פלילי לפי הדין הישראלי.",
 "nituach-psak-din": "ניתוח מובנה של פסק דין ישראלי, לרבות חילוץ ההלכה והבחנתה מאמרת אגב.",
 "profil-shofet": "דף פרופיל על שופט או שופטת בהליך, מתוך פסיקתם הקודמת בגילוי נאות ובדגש על תחומים דומים להליך הנוכחי: היקף ותמהיל התיקים, סטטיסטיקה של הכרעות על מדגם שנקרא במלואו, הוצאות, ניהול ההליך ומשכו, יחס לחוות דעת מומחים, שיטת ההנמקה והכתיב",
 "review-contract": "ניתוח חוזה לפי דיני החוזים הישראליים, כולל זיהוי סעיפים בעייתיים והצעות ניסוח.",
 "seder-din-ezrachi": "ניתוח שאלות בסדר דין אזרחי לפי תקנות סדר הדין האזרחי, התשע\"ט-2018.",
 "signature-request": "בדיקת דרישות חתימה, כתב ואימות במסמך משפטי לפי הדין הישראלי, לפני הוצאתו לחתימה.",
 "tachshiv-nezek": "חישובים מספריים בתיק נזקי גוף לפי הדין הישראלי, במנוע פנימי וללא תלות באתר חיצוני. שקלול אחוזי נכות בשיטת יתרת הכושר, כאב וסבל לפי תקנות הפלת״ד 1976, הסכום המקסימלי ותקרת שילוש השכר, הפרשי הצמדה וריבית לפי חוק פסיקת ריבית והצמדה א",
 "triage-nda": "מיון מהיר של הסכם סודיות והסכמי אי-תחרות לפי הדין הישראלי, וסיווגם ירוק, צהוב או אדום.",
 "vendor-check": "מיפוי ישות ובדיקת נאותות במקורות ישראליים פתוחים, לרבות התקשרויות והליכים.",
 "zikuk-sheelot": "זיקוק שאלות מחקר משפטיות מתוך מסמכי תיק, לפני שמתחילים לחפש: קריאה מלאה ונמדדת של המסמכים, עד שש שאלות הבהרה, מפת סוגיות, ולכל שאלה שני נוסחים, אחד בהקשר התיק ואחד מופשט לחיפוש, עם תוכנית חיפוש בגילוי נאות ובמאגרי החקיקה הפתוחים. "
};

const KELALEI_IMUT = "# כללי אימות אסמכתאות\n\nחובה על כל מיומנות בערכה.\n\n> **נתיבים בקובץ זה** יחסיים לתיקיית התוסף, כלומר לערך של `${CLAUDE_PLUGIN_ROOT}` כפי שהוא מופיע\n> מורחב בכל `SKILL.md`. \"`skills/chipus-psika/SKILL.md`\" פירושו `<תיקיית התוסף>/skills/chipus-psika/SKILL.md`.\n\n## הכלל\n\nאין להציג חוק, סעיף, תקנה, פסק דין או ציטוט בלי אימות מול מקור ראשוני באותה עבודה.\nמודל שפה נוטה לייצר אסמכתאות שנראות תקינות ואינן קיימות, או לשייך הלכה לתיק הלא נכון.\nזו תקלה חמורה בעבודה אקדמית ובעבודה מקצועית כאחת.\n\n## תחולה\n\nהכלל חל על כל פלט ועל כל מסמך שמופיעים בו חוק, סעיף, תקנה, תוספת או פסק דין ישראלי, **גם כשהמשימה\nאינה משפטית מלכתחילה**: עריכת חוזר, נוהל, מכתב רשמי, נייר עמדה, הצעת מחקר, מאמר או מצגת, וגם\nכשהמשתמש ביקש עריכה או עיצוב בלבד. במשימה כזו מפעילים את `skills/asmachtaot-bemismach`, שמחילה את\nהסולם שלהלן לפני כל שינוי במסמך.\n\nנמדד ב-11.11.2026: בעריכת חוזר של משרד ממשלתי שנשען על תקנות, שום מיומנות לא הופעלה, והנוסח נבדק\nתחילה מול קישור נבו ומול סיכום WebFetch של ויקיטקסט. הסיכום שיבש את מבנה התוספת לתקנות, והפניות\nנכונות במסמך המשתמש הוחלפו בשגויות עד שהנוסח נקרא במאגר החקיקה של גילוי נאות.\n\n## סדר הפעולות\n\n1. **לפני הכתיבה**: לאתר את נוסח החוק או פסק הדין במקור.\n2. **בזמן הכתיבה**: לצטט רק ממה שנקרא בפועל. ולרשום כל מקור שנקרא ביומן הציטוטים (פרק \"מצבי אימות, תקציב ופיצול\").\n3. **אחרי הכתיבה**: לעבור על כל האסמכתאות ולסמן את מצב האימות.\n\n## מי מבצע את האימות\n\nהאימות אינו מסתמך על ציות עצמי של המודל. בתוסף קיים סוכן ייעודי, `meamet-asmachtaot`,\nשתפקידו היחיד הוא לאמת אסמכתאות מול מקורות ולהחזיר מצב אימות לכל אחת.\n\n**כל מיומנות בערכה מחויבת להפעיל אותו לפני החזרת פלט הכולל אסמכתאות.**\nבנוסף, `hooks/` מכיל רשת ביטחון שחוסמת סיום תור עם אסמכתאות שאין לצידן טבלת מצב אימות.\n\nהסוכן קורא ומחפש בלבד. הוא אינו מתקן את הניתוח המשפטי ואינו מוסיף לו.\n\n### כשכלי Agent אינו זמין בסשן\n\nיש סביבות שבהן כלי `Agent` אינו קיים: סשן מקונן (המיומנות רצה כבר בתוך סוכן), סשן headless,\nאו הרצה מתוזמנת. **אין לדלג על האימות ואין להתחזות לאימות שבוצע.** המסלול המחייב:\n\n1. לבדוק בפועל אם הכלי קיים, ולא להניח. אם הוא קיים, להפעיל את הסוכן כרגיל.\n2. אם אינו קיים, לבצע את אותו אימות ידנית, **לפי אותו סולם המקורות שלהלן ובאותו סדר**.\n3. **להוסיף בראש טבלת האסמכתאות את המשפט המדויק: \"אימות עצמי, ללא בדיקה חיצונית\".**\n   זהו סימון גלוי שהאימות לא עבר דרך גורם נפרד, והוא תנאי לסיום התור.\n4. תקרת האימות העצמי היא ⚠ בכל אסמכתא שלא נקרא לגביה קובץ מקור. ✓ נשמר למקרה שבו הקובץ\n   עצמו נקרא.\n\nהיעדר הכלי אינו עילה לוותר על הטבלה, ואינו עילה לעצור את העבודה.\n\n## מצבי אימות, תקציב ופיצול\n\nנמדד ב-5.10.2026: הפעלה אחת של הסוכן על 22 אסמכתאות ו-11 פריטי ספרות, בלי תקציב, נמשכה 3 שעות ו-6 דקות (815 קריאות כלים), והדוח לא נמסר אוטומטית בסופה. רוב קובצי המקור כבר נקראו בשלב המחקר, כך שחלק ניכר מהבדיקה כפל עבודה. הכללים שלהלן נועדו למנוע זאת.\n\n1. **יומן ציטוטים בזמן המחקר.** כל מקור שנקרא נרשם מיד בקובץ יומן בסביבת העבודה, שורה לכל אסמכתא: האסמכתא המלאה; נתיב קובץ המקור; מספר הפסקה; ציטוט מילולי קצר שעליו נשענת הטענה; הטענה; הדובר והמעמד (רוב, מיעוט, הצטרפות לתוצאה בלבד, אמרת אגב). את היומן מעבירים לסוכן, וכך האימות הוא בדיקה של היומן ולא חיפוש מחדש.\n2. **מצב ליבה הוא ברירת המחדל** בתדריך, במחקר, בטיוטה ובתשובה בשיחה. עד 12 האסמכתאות שהמסקנות נשענות עליהן מסומנות \"ליבה\" ונבדקות. שאר האסמכתאות נכנסות לטבלה כ-⚠ \"לא נבדק — מצב ליבה\". **מצב מלא** — לפני הגשה לבית משפט, ללקוח או עבודה אקדמית סופית, או כשהמשתמש ביקש.\n3. **תקציב לכל הפעלה של הסוכן:** במצב ליבה עד 20 דקות, 60 קריאות כלים ו-10 קריאות לגילוי נאות; במצב מלא עד 60 דקות ו-200 קריאות. את התקציב מציינים במפורש בהנחיה לסוכן. כשהתקציב נגמר הסוכן מוסר דוח חלקי.\n4. **פיצול.** מעל 8 אסמכתאות ליבה — כמה הפעלות במקביל, עד 6 אסמכתאות לכל אחת, כל אחת עם חלק משלה ביומן. את מכסת גילוי נאות מחלקים ביניהן מראש.\n5. **עדכון סטטוס למשתמש.** הפעלת סוכן חוסמת את המפעיל עד שהסוכן מסיים, ובזמן הזה אי אפשר לענות למשתמש. לכן, לפני כל הפעלה ארוכה (אימות או מחקר), שולחים למשתמש שורה אחת: מה נבדק ובכמה זמן משוער.\n6. **הטבלה נשארת חובה.** אסמכתא שלא נבדקה אינה נמחקת מהטבלה; היא מסומנת ⚠ עם הסיבה.\n\n## סולם המקורות המתועדף\n\n**חובה לעבור בסולם לפי הסדר.** אין לפתוח בחיפוש אינטרנט כללי לאסמכתא ישראלית; הוא שלב 4, לא שלב 1.\n\n### פסיקה\n\n| # | המקור | מה מקבלים | מתי עוצרים |\n|---|---|---|---|\n| 1 | **קבצים מקומיים** בסביבת העבודה ובתיקיות המשתמש | קובץ מלא | תמיד עדיף על שליפה |\n| 2 | **גילוי נאות** — מחבר ה-MCP או ה-API עם המפתח האישי; גיבוי: החיפוש המובנה בדפדפן הפנימי, https://www.giluy-naot.org.il/search | מטא-דאטה, טקסט מלא, ו**קובץ המקור של הרשות השופטת** | ברירת המחדל לכל פסיקה ישראלית. המסלולים וסדרם: `skills/chipus-psika/SKILL.md` |\n| 3 | **מראות של נבו ופ\"ד** שפורסמו בגלוי (gov.il, אתרי רשויות, קבצים שהועלו על ידי צדדים שלישיים) | PDF או Word | כשגילוי נאות אינו מכסה, בעיקר פסיקה ישנה |\n| 3א | **פרסומים מקוונים של אתרים משפטיים ומשרדי עורכי דין**, שמאותרים בחיפוש פתוח בגוגל בדפדפן הפנימי (למשל עמודי `caselaw` באתר afiklaw, שהם העתקי נבו מחולקים לעמודים) | טקסט מלא, לא קובץ מקור | רק אחרי מיצוי גילוי נאות, כולל מסלול 4. **מקור משני**: מספרי פסקאות וציטוטים מסומנים ⚠ עד שהם מאומתים מול הקובץ הרשמי, או מול ציטוט בפסק דין מאוחר שקובץ המקור שלו נקרא. לכבד את `robots.txt` ואת `Crawl-Delay`, ולשלוף בסקריפט רק כשהקובץ מתיר. נמדד ב-5.10.2026: פסק הדין בפרשת קליין (13.1.2026) נמצא כך, אף שאינו בגילוי נאות ולא בפנקס התובענות. בהעתק המקוון המספור התאפס בפרק אחד (פס' 424–428 הופיעו כ-10–14) |\n| 4 | חיפוש אינטרנט כללי | מקור משני | ⚠ בלבד. לעולם לא ציטוט מילולי |\n\n**אין לסמן אי-איתור של פסק דין לפני שמוצה שלב 2.** סולם החיפוש בתוך גילוי נאות, שמונה שלבים\nמהצר לרחב, מפורט ב-`skills/chipus-psika/SKILL.md`, ושם גם תנאי המיצוי המדויקים: בתיק רגיל —\nמספר הליך **וגם** שם צד; **בתיק חסוי** (\"פלוני\"/\"פלונית\") — מספר הליך **וגם** טקסט חופשי, שכן\nחיפוש לפי שם אינו יכול להצליח שם. שם הצד (`party_name` ב-MCP וב-API, `name` בטופס) סורק את כל\nהצדדים ואינו מוגבל לצד הפותח.\n\n**בסביבה בלי דפדפן**, מיצוי שלב 2 כולל גם קריאה אחת במסלול 4 של `chipus-psika` (`--legacy`), בשני שמות או בביטוי מדויק של מספר ההליך. נמדד ב-5.10.2026: תיק שלא אותר במחבר וב-API נמצא כך, יחד עם הערעור עליו.\n\n### חקיקה\n\nנוסח חוק מעודכן קשה יותר לשליפה מפסיקה. הסדר שנבדק ועובד, מגרסה 1.15.0:\n\n| # | המקור | הערה |\n|---|---|---|\n| 1 | **קובץ שהמשתמש סיפק** | תמיד ראשון. קובץ נבו שהמשתמש עצמו הוריד וצירף הוא קובץ מקומי לכל דבר |\n| 2 | **גילוי נאות, מאגר החקיקה** (`https://www.giluy-naot.org.il/laws`) | **ברירת המחדל לנוסח חקיקה.** נוסח משולב שמבוסס על \"ספר החוקים הפתוח\" (ויקיטקסט). כתובת דף: `/laws/<שם החיקוק, במקפים במקום רווחים ובלי השנה>`; כתובת עם רווחים מחזירה 404. קוראים ב-`get_page_text` בדפדפן הפנימי או ב-curl של ה-HTML; `robots.txt` של האתר מתיר גישה. בתחתית הדף: \"פרסום ברשומות ותיקונים\" (הפרסום המקורי וכל תיקון), קישורים לוויקיטקסט ולמאגר החקיקה של הכנסת, ותאריך \"גרסת הארכיון\". **זה אינו נוסח רשמי**, ותיקונים שאחרי תאריך הארכיון עלולים לחסור. נמדד ב-5.10.2026: 6,103 פריטים. נמדד ב-11.11.2026: תקנות ביטוח בריאות ממלכתי (הגשת דוח) וחוק ביטוח בריאות ממלכתי נקראו במלואם, בגרסת ארכיון מ-21.9.2026 |\n| 3 | **ויקיטקסט / \"ספר החוקים הפתוח\"** | הנוסח שביסוד שלב 2, ולעיתים עדכני ממנו. קוראים בדפדפן הפנימי. **WebFetch מחזיר סיכום של מודל קטן, ולכן הוא לאיתור בלבד**: נמדד ב-11.11.2026, הסיכום דיווח שתוספת אינה ממוספרת כפרטים 1 עד 5, בניגוד לנוסח. כתובת `action=raw` לא נשלפה. אם הדף אינו נטען, לא להתעכב: לעבור לשלב הבא |\n| 4 | **חיפוש בגוגל, בדפדפן הפנימי** | לאיתור נוסח שפורסם באתר פתוח: קבצי \"נוסח מלא ומעודכן\" באתרי gov.il ורשויות (רשות ניירות ערך, הרשות להגנת הפרטיות, משרדי ממשלה), מאגר החקיקה הלאומי. PDF שהורד נקרא ישירות. **תוצאה שמובילה ל-`nevo.co.il` אינה נפתחת** |\n| 5 | **רשומות**: ספר החוקים וקובץ התקנות | הנוסח הרשמי והמחייב; הנוסח של תיקון מסוים, לבדיקת יום תחילה |\n| 6 | **אתר הכנסת** | הצעות חוק, דברי הסבר, והנוסח כפי שהתקבל |\n\n**נבו אינו מקור בסולם** (מגרסה 1.15.0). ככלל אין לפנות ל-`nevo.co.il`, לא לחקיקה ולא לפסיקה, בשום כלי\nובכלל זה הדפדפן הפנימי. `robots.txt` שלו אוסר כל גישה אוטומטית חוץ מ-Googlebot ו-Bingbot, ואוסר במפורש\nאת ClaudeBot ואת anthropic-ai, ואותו נוסח נגיש בשלבים 2 עד 4. **קישור לנבו שהמשתמש צירף מזהה את דבר\nהחקיקה, ואינו הוראה לפתוח אותו**: מאתרים את אותו חיקוק לפי שמו. העתקי נבו שפורסמו באתרים אחרים\n(gov.il, אתרי רשויות, משרדי עורכי דין) נשארים בשימוש, במעמד שנקבע להם בסולם.\n\n**חסימות ידועות, שאין לנסות לעקוף**: `nevo.co.il`, כאמור. כשמסלול חסום, עוברים למסלול הבא ומציינים זאת,\nולא מנסים דרך אחרת לאותו מתחם. **403 בסביבת הענן אינו הזמנה לנסות ממחשב המשתמש:** זו אותה חסימה.\nנמדד ב-5.10.2026: דפי נבו נשלפו בסקריפט ממחשב המשתמש אחרי 403 בענן. זו הייתה עקיפת חסימה.\n\n**מסלול משלים לפסיקה שאינה נגישה.** כשקובץ המקור של פסק דין ישן אינו קיים באף מאגר פתוח —\nמצב שכיח בפסיקת העליון שלפני 1990, שגילוי נאות אינו מכסה ואתר הרשות השופטת מתחיל אחריה —\n**ציטוט מילולי של הקביעה בפסק דין מאוחר שקובץ המקור שלו נקרא מבסס ✓ לאותה קביעה בלבד.**\nההצדקה זהה לזו שבחקיקה: בית המשפט מצטט מהמקור שלפניו. מצוין בטבלה: \"הקביעה אומתה מול ציטוט\nמילולי ב<פסק הדין המאוחר>, <תאריך>; קובץ המקור של פסק הדין המצוטט לא אותר\". **הסייג**: זה\nמבסס את הקביעה שצוטטה, ולא כל מה שמיוחס לפסק הדין הישן, ואינו מאפשר ציטוט של פסקה שלא הובאה.\nבלי המסלול הזה, ועקנין וכל אבני היסוד של דיני הנזיקין נעולות על ⚠ לצמיתות מסיבה ארכיטקטונית\nולא מחמת ספק אמיתי, והסימון מאבד את כוח האבחנה שלו.\n\n**מסלול משלים לנוסח סעיף שאינו נגיש**: ציטוט מילולי של הסעיף **בפסק דין עדכני שקובץ המקור שלו\nנקרא**. זהו מקור ראשוני לעניין הנוסח, וגם מתארך אותו — הנוסח שצוטט הוא זה שחל במועד פסק הדין.\nמצוין בטבלה: \"הנוסח אומת מול ציטוט מילולי ב<פסק הדין>, <תאריך>\". שימושי במיוחד כש-gov.il מוחזר חסום.\n\n**קובץ שהורד נקרא ישירות**, ולא דרך סיכום של מודל קטן. PDF: `pdftotext`. Word ישן (.doc או RTF\nבתחפושת): `soffice --headless --convert-to docx`. סיכום WebFetch של טקסט משפטי בעברית שיבש בבדיקה\nגם ציטוטים וגם קיום של שמות צדדים, ולכן הוא **אינו** בסיס לציטוט מילולי ואינו בסיס לקביעת היעדר.\n\n> ⚠ **`pdftotext` משבש ספרות בעברית.** נמדד: `ע\"א 88441//` במקום `ע\"א 4486/11` — האותיות תקינות,\n> הספרות מתהפכות. **אין להעתיק מספרי הליך, מספרי פסקאות, סכומים או תאריכים מפלט `pdftotext`**\n> בלי השוואה לקובץ ה-Word או לתמונת ה-PDF.\n\n## סימון מצב אימות\n\n| סימון | משמעות |\n|---|---|\n| ✓ | אומת מול מקור ראשוני, כולל נוסח מעודכן |\n| ⚠ | אותר במקור משני בלבד, או **לא אותר אף שהחיפוש מוצה**. טעון אימות ידני |\n| ✗ | **הופרך בפועל**: המקור אותר ותוכנו שונה, או שהפרטים שגויים באופן מוכח. אין להשתמש |\n\nכל פלט של מיומנות בערכה מסתיים בטבלת אסמכתאות עם עמודת מצב אימות. הטבלה נושאת כותרת\n\"טבלת אסמכתאות\" או עמודה \"מצב אימות\", ולכל שורה סימון. סימן בודד בגוף הטקסט אינו טבלה,\nואינו מספיק.\n\n## הספק פועל לשני הכיוונים\n\nהכלל שלמעלה נועד למנוע אסמכתא מומצאת שנכנסת לעבודה. יש לו תאום הפוך, שקל לפספס:\n\n**אסמכתא תקפה שנפסלת בטעות.** התוסף מורה להסיר כל אסמכתא המסומנת ✗, ולכן ✗ שגוי הוא\nהוראת מחיקה של מקור אמיתי וטוב.\n\n**\"לא מצאתי\" אינו \"לא קיים\".** במאגרים הישראליים במיוחד: נבו ואתר הרשות השופטת חסומים לרוב\nבפני שליפה אוטומטית, פסיקה ישנה אינה מדוגמת במלואה, וניסוח הציטוט משפיע על האיתור יותר\nמקיומו של פסק הדין. לכן אי-איתור הוא ⚠, לא ✗, וניסוחו הוא **\"לא אותרה בכלים שנוסו\"**.\n\nגם כיסויו של גילוי נאות אינו מלא, ובלשון האתר עצמו \"העדר תוצאות בחיפוש אינו ראיה לכך שאין\nפסיקה בנושא\"; אי-איתור שם נשאר ⚠.\n\n**מה נחשב מקור ראשוני במאגר מראה.** קובץ ה-PDF או ה-Word של הרשות השופטת, כפי שהתקבל דרך גילוי\nנאות, הוא מקור ראשוני לכל דבר, ומצוין בטבלה \"קובץ המקור של הרשות השופטת, דרך גילוי נאות\" עם\nקישור. הטקסט המחולץ באתר (`full_text`) והקטע בתוצאת החיפוש אינם מקור ראשוני: קריאה בהם בלבד\nהיא ⚠, וציטוט מילולי נלקח רק מהקובץ.\n\nאין לקבוע שאסמכתא הומצאה. אין ראיה לכך. יש לדווח מה נוסה, היכן, ומה לא נמצא.\n\n## מקורות חיצוניים שידוע שהם שגויים\n\nשגיאות וסתירות שאותרו במקורות חיצוניים שאי אפשר לתקן מתועדות ב-`references/tikunei-mekorot-hitzoniim.md`.\n\n**חובה**: כשעובדים מול מקור חיצוני, יש לבדוק אם הוא מופיע שם ולהחיל את התיקון. **הקובץ ההוא\nגובר על המקור החיצוני**, גם כשהמקור אומר אחרת בגוף הטקסט שלו.\n\n**שרת MCP משפטי אחד מוגדר בתוסף: `giluy-naot`**, מאגר הפסיקה של גילוי נאות (מ-1.9.0). הוא כלי\nהאיתור הראשי לפסיקה, וכפוף לאותו כלל: כל אסמכתא ממנו עוברת את `meamet-asmachtaot` כמו כל אסמכתא\nאחרת. **השרת עצמו אינו מקור ראשוני**: הטקסט שהוא מחזיר שקול לטקסט המחולץ באתר, וקריאה בו בלבד היא ⚠.\nהמקור הראשוני הוא קובץ הרשות השופטת שהוא מפנה אליו. שרת משפטי נוסף שיחובר בעתיד — אותו דין.\n\n## מה במיוחד טעון בדיקה\n\n- **מספרי סעיפים ותקנות**: משתנים בתיקוני חקיקה. מספר שהיה נכון לפני חמש שנים עשוי להיות שגוי היום.\n- **סכומי סף**: סמכות עניינית, תביעות קטנות, אגרות, עיצומים כספיים. מתעדכנים מדי שנה.\n- **נוסח מעודכן מול נוסח היסטורי**: יש לוודא שהנוסח שנקרא הוא זה שחל במועד הרלוונטי.\n- **סטטוס הלכה**: האם ההלכה עדיין תקפה, שונתה בדיון נוסף, או נסתייגה בפסיקה מאוחרת.\n- **חקיקה שטרם נכנסה לתוקף**: הבחנה בין פרסום ברשומות לבין יום התחילה.\n- **דעת יחיד ואמרת אגב**: ראה להלן. זו התקלה השכיחה ביותר שאינה תקלת \"קיום\".\n\n## אמרת אגב ודעת יחיד אינן הלכה\n\nאסמכתא יכולה להיות קיימת, מדויקת במספרה ובשם הצדדים — ועדיין לתמוך בטענה אחרת לגמרי ממה\nשיוחס לה. אימות \"קיום\" אינו מספיק. לפני שנכתב שנקבעה הלכה, יש לבדוק בגוף פסק הדין:\n\n1. **מי כתב את הדברים**, וכמה שופטים הצטרפו **לנימוק** ולא רק לתוצאה. \"אני מסכים לתוצאה\" אינו\n   הצטרפות להלכה.\n2. **האם בית המשפט עצמו הגדיר את הדיון כ\"למעלה מן הצורך\"**, \"לעת מצוא\", או \"איני נדרש להכריע\".\n   זהו סימון מפורש של אמרת אגב, והוא גובר על הרושם שהניתוח מותיר.\n3. **מה היקף התחולה שהשופט עצמו נתן** לקביעה, ואילו מקרים הוציא ממנה במפורש.\n4. **האם הקביעה אומצה בפסיקה מאוחרת.** הכלי המעשי: חיפוש מספר ההליך כטקסט חופשי בהתאמה\n   מדויקת בגילוי נאות (`free_text=4486/11&match_mode=exact&sort=newest`), שמחזיר את ההחלטות\n   המאזכרות אותו. **רק בטופס המובנה בדפדפן או בנקודות הקצה הפנימיות**: ב-MCP וב-API אין התאמה\n   מדויקת, ו-`query` עם מספר הליך מחזיר רעש (שלב 8 ב-`skills/chipus-psika/SKILL.md`).\n\n**ניסוח בפלט**: קביעה שאינה הלכה מחייבת נכתבת כ\"הוצע\", \"בחוות דעתו של השופט X\", \"עמדה שטרם\nהוכרעה\" — לא כ\"נקבע\" ולא כ\"נזנח\". בטבלת האסמכתאות מצוין מעמדה בעמודת ההערה.\n\n**דירוג**: מעמד שגוי **בלבד**, כשהתוכן עצמו מדויק → ⚠, עם הניסוח החלופי בהערה. מעמד שגוי\n**וגם** תוכן שאינו תואם את הקובץ שנקרא → ✗. ההבדל אינו סמנטי: ⚠ נשארת בעבודה עם סימון גלוי,\nואילו ✗ מוסרת ממנה.\n\n**כלי זול ויעיל לבדיקת מעמד**: ספירת מופעים בטקסט המחולץ. סמני אמרת האגב הם מחרוזות קבועות —\n`grep -c \"למעלה מן הצורך\"`, `\"לעת מצוא\"`, `\"איני נדרש להכריע\"`, `\"אני מסכים לתוצאה\"` — וכך גם\nהפועל שבטענה הנבדקת. אם הפועל המרכזי בטענה מופיע 0 פעמים בפסק הדין, זו אינדיקציה חזקה לפני\nשנקראת ולו פסקה אחת.\n\n## פורמט הציטוט\n\nהסטנדרט המחייב בישראל הוא **כללי האזכור האחיד** (מהדורה שנייה), שלפיהם נבדקות עבודות\nבפקולטות למשפטים ובכתבי העת המשפטיים. אין להמציא פורמט חלופי.\n\n> **חובה**: לפני הגשת עבודה אקדמית, יש לוודא את הפורמט מול הנוסח הרשמי של כללי האזכור האחיד,\n> ומול הנחיות המוסד הספציפי, שלעיתים מוסיף דרישות משלו. הדוגמאות שלהלן הן תזכורת בלבד ואינן תחליף לכללים.\n\n### דוגמאות לצורות הנפוצות\n\n| סוג המקור | הצורה |\n|---|---|\n| חקיקה ראשית | שם החוק, התש\"ף-2020, ס\"ח 123 |\n| הפניה לסעיף בחוק | ס' 12(ב) לחוק פלוני |\n| חקיקת משנה | תקנות פלוניות, התשפ\"א-2021, ק\"ת 456 |\n| הצעת חוק | הצעת חוק פלוני, התשפ\"ב-2022, ה\"ח הממשלה 789 |\n| פסיקת העליון | ע\"א 1234/20 פלוני נ' אלמוני, פס' 15 לפסק דינה של השופטת כהן (נבו 1.1.2022) |\n| פסיקה שפורסמה בפ\"ד | ע\"א 1234/80 פלוני נ' אלמוני, פ\"ד לה(2) 123 (1981) |\n| ספר | שם המחבר **שם הספר** 123 (מהדורה שנייה, 2019) |\n| מאמר | שם המחבר \"שם המאמר\" **שם כתב העת** יב 45 (2020) |\n\n### שם התיק נפתח בשם המערער\n\nאסמכתא מצוטטת בקיצור לעיתים בשם הצד הזכור, שהוא לרוב המשיב. שם התיק במאגרים נפתח בשם\nהמערער, ולכן **ציטוט מקוצר בשם הצד השני לא יימצא בחיפוש**.\n\n| הצורה המקוצרת | הצורה שמאתרת |\n|---|---|\n| ע\"א 398/99 דיין | ע\"א 398/99 קופת חולים של ההסתדרות הכללית נ' דיין, פ\"ד נה(1) 765 (1999) |\n\nבכל אסמכתא שנרשמת לשימוש חוזר, ובכל קובץ הנחיות פנימי, יש לרשום את **הצורה המלאה**:\nשם הצד הפותח, שם הצד השני, ומראה המקום. צורה מקוצרת היא מלכודת אימות, לא קיצור דרך.\n\n### נקודות שנופלים בהן\n\n- **דין קדימה בין מקורות**: הסדר בהערת שוליים אינו שרירותי. יש לבדוק את כלל הסדר בכללי האזכור.\n- **ציון עמוד מדויק**: הפניה לפסק דין שלם בלי מספר פסקה אינה מספקת בטענה נקודתית.\n- **\"נבו\" מול פ\"ד**: פסק דין שפורסם בפ\"ד מצוטט לפי פ\"ד, ולא לפי מאגר מקוון.\n- **ההבחנה בין ס\"ח לבין הנוסח המשולב**: יש לצטט את הנוסח שחל במועד הרלוונטי.\n\n## הפקת מסמך\n\nכל פלט שנמסר כקובץ Word או PDF, או כעמוד HTML, מופק לפי `references/hafaka-vehatzaga.md` בתיקיית\nהשורש של התוסף (בנתיב מלא: `${CLAUDE_PLUGIN_ROOT}/references/hafaka-vehatzaga.md`): David 12 לכל הטקסט כולל\nלועזית, ריווח שורה וחצי, יישור לשני הצדדים, שוליים 2.54 ס״מ, טבלאות בכיווניות מימין לשמאל, וכללי\nהכיווניות לשמות פסקי דין זרים, לציטוטים באנגלית ולרשימת המקורות. מסמך משפטי או רפואי-משפטי נמסר\nכ-Word ו-PDF, ולא כ-Claude Docs או כ-Markdown. הערות שוליים ממוספרות ב-David 10 הן חובה במסמך אקדמי בלבד.\n";

const SKILL_SYSTEM = [
  'אתה עוזר עבודה משפטית ואקדמית לסטודנט למשפטים בישראל. ענה בעברית בלבד.',
  'המשתמש בחר מיומנויות (Skills) שצורפו לבקשה זו. פעל לפי הוראות המיומנויות שנבחרו: קרא את קבצי ההוראות שלהן שבמיכל ויישם את שלבי העבודה שלהן על המשימה ועל חומר הרקע.',
  'לתשומת לבך: סביבת הריצה (המיכל) חסרת גישה לאינטרנט, ולכן סקריפטים שרצים בתוכה אינם יכולים לקרוא לממשקים חיצוניים. לצורכי מחקר השתמש בכלים שניתנו לך בבקשה זו: search_verdicts ו־get_verdict_text לפסיקה בגילוי נאות, search_laws ו־get_law_text לחקיקה מספר החוקים הפתוח, וכן web_search ו־web_fetch.',
  'אסור להמציא פסקי דין, מספרי תיקים או סעיפי חוק. מה שלא נמצא, אמור במפורש.',
  'מסמך מעוצב: בכל משימה שהתוצר שלה הוא ניתוח, תדריך, מזכר, סקירה, חוות דעת או תוצר עבודה מהותי אחר, הפק בנוסף לתשובה בצ׳אט גם קובץ Word מעוצב (.docx) במיכל, ובו התוצר המלא, לא תקציר. בנה אותו ב־python-docx בתקן הבא: גופן David גודל 12 (כולל תכונת complex script בכותרות ובהדגשות), כיוון RTL מלא בכל פסקה (bidi), ריווח שורות 1.5, כותרת ראשית מודגשת וממורכזת, כותרות משנה מודגשות, גוף הטקסט מיושר לשני הצדדים, ושמות של פסקי דין וחוקים מודגשים בכל הופעה בגוף הטקסט.',
  'אין להשתמש במקף ארוך (—) במסמך או בתשובה בצ׳אט; השתמש בפסיק, בנקודתיים, בסוגריים או במשפט נפרד.',
  'אם המיומנות עצמה מייצרת קובץ מסוג אחר (למשל xlsx), צור גם אותו כנדרש בהוראותיה.',
  'בסוף העבודה סכם בעברית מה נעשה, לפי מבנה הפלט שהמיומנות דורשת.',
  'פרק האימות של מיומנות אימות האסמכתאות (kelalei-imut) מצורף בזה במלואו. כאשר המשימה או המיומנות דורשות אימות אסמכתאות, פעל לפי הפרק הזה:\n' + KELALEI_IMUT,
].join('\n');

const SKILL_TOOLS = [
  { type: 'code_execution_20250825', name: 'code_execution' },
  { type: 'web_search_20250305', name: 'web_search', max_uses: 10 },
  { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 10 },
  ...TOOLS,
];

function collectFileIds(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) collectFileIds(x, out); return; }
  if (typeof node.file_id === 'string' && node.file_id) {
    out.push({ id: node.file_id, name: node.filename || node.name || '' });
  }
  for (const k of Object.keys(node)) collectFileIds(node[k], out);
}

async function handleSkillRun(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'no_key' }, 501);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }
  const skillsIn = Array.isArray(body.skills) ? body.skills : [];
  const skills = skillsIn
    .filter(s => s && typeof s.skill_id === 'string' && s.skill_id)
    .slice(0, 20)
    .map(s => ({ type: s.type === 'anthropic' ? 'anthropic' : 'custom', skill_id: s.skill_id, version: 'latest' }));
  if (!skills.length) return json({ error: 'no_skills' }, 400);
  const task = String(body.task || '').trim().slice(0, 4000);
  if (!task) return json({ error: 'empty_task' }, 400);
  const material = String(body.material || '').trim().slice(0, 30000);
  const prompt = material ? task + '\n\nחומר רקע:\n' + material : task;

  const sources = [];
  const fileMap = new Map();
  const model = String(env.MODEL || DEFAULT_MODEL);
  const effortRaw = String(env.EFFORT || 'high').toLowerCase();
  const effort = EFFORTS.includes(effortRaw) ? effortRaw : null;
  const messages = [{ role: 'user', content: prompt }];
  let containerId = null;
  let answer = '';
  let lastStop = '';
  let lastTypes = '';
  for (let round = 0; round < 25; round++) {
    const container = containerId ? { id: containerId, skills } : { skills };
    const payload = {
      model, max_tokens: 32000, system: SKILL_SYSTEM,
      tools: SKILL_TOOLS, messages, container,
    };
    if (effort) payload.output_config = { effort };
    const res = await fetch(ANTHROPIC, {
      method: 'POST',
      headers: anthropicHeaders(env),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text();
      return json({ error: 'anthropic_' + res.status, detail: t.slice(0, 300) }, 502);
    }
    const data = await res.json();
    lastStop = data.stop_reason || '';
    lastTypes = (data.content || []).map(b => b.type).join(',');
    const roundText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (roundText) answer = answer ? answer + '\n' + roundText : roundText;
    if (data.container && data.container.id) containerId = data.container.id;
    const found = [];
    collectFileIds(data.content, found);
    for (const f of found) if (!fileMap.has(f.id)) fileMap.set(f.id, f);
    messages.push({ role: 'assistant', content: data.content });
    const toolUses = (data.content || []).filter(b => b.type === 'tool_use' && TOOLS.some(t => t.name === b.name));
    if (toolUses.length) {
      const results = [];
      for (const tu of toolUses) {
        try {
          const out = await runTool(tu.name, tu.input || {}, sources);
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 24000) });
        } catch (e) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'שגיאה בביצוע הכלי: ' + e.message, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    if (data.stop_reason === 'pause_turn') continue;
    break;
  }
  const seen = new Set(); const uniq = [];
  for (const s of sources) { if (!seen.has(s.url)) { seen.add(s.url); uniq.push(s); } }
  if (!answer && !fileMap.size) {
    return json({ error: 'empty_run', detail: 'stop=' + lastStop + ' types=' + lastTypes }, 502);
  }
  return json({ answer, sources: uniq.slice(0, 10), files: [...fileMap.values()].slice(0, 10) });
}

async function handleSkillStep(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'no_key' }, 501);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }
  const skillsIn = Array.isArray(body.skills) ? body.skills : [];
  const skills = skillsIn
    .filter(s => s && typeof s.skill_id === 'string' && s.skill_id)
    .slice(0, 20)
    .map(s => ({ type: s.type === 'anthropic' ? 'anthropic' : 'custom', skill_id: s.skill_id, version: 'latest' }));
  if (!skills.length) return json({ error: 'no_skills' }, 400);
  let messages = Array.isArray(body.messages) && body.messages.length ? body.messages : null;
  if (!messages) {
    const task = String(body.task || '').trim().slice(0, 4000);
    if (!task) return json({ error: 'empty_task' }, 400);
    const material = String(body.material || '').trim().slice(0, 30000);
    const prompt = material ? task + '\n\nחומר רקע:\n' + material : task;
    messages = [{ role: 'user', content: prompt }];
  }
  const model = String(env.MODEL || DEFAULT_MODEL);
  const effortRaw = String(env.EFFORT || 'high').toLowerCase();
  const effort = EFFORTS.includes(effortRaw) ? effortRaw : null;
  const container = body.container_id ? { id: String(body.container_id), skills } : { skills };
  const payload = { model, max_tokens: 32000, system: SKILL_SYSTEM, tools: SKILL_TOOLS, messages, container };
  if (effort) payload.output_config = { effort };
  let res;
  try {
    res = await fetch(ANTHROPIC, { method: 'POST', headers: anthropicHeaders(env), body: JSON.stringify(payload) });
  } catch (e) {
    return json({ error: 'upstream', detail: String((e && e.message) || e).slice(0, 300) }, 502);
  }
  if (!res.ok) {
    const t = await res.text();
    return json({ error: 'anthropic_' + res.status, detail: t.slice(0, 300) }, 502);
  }
  const data = await res.json();
  const containerId = (data.container && data.container.id) || body.container_id || null;
  const found = [];
  collectFileIds(data.content, found);
  const files = [...new Map(found.map(f => [f.id, f])).values()];
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const sources = [];
  messages.push({ role: 'assistant', content: data.content });
  const toolUses = (data.content || []).filter(b => b.type === 'tool_use' && TOOLS.some(t => t.name === b.name));
  if (toolUses.length) {
    const results = [];
    for (const tu of toolUses) {
      try {
        const out = await runTool(tu.name, tu.input || {}, sources);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 24000) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'שגיאה בביצוע הכלי: ' + e.message, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
    return json({ text, sources, files, container_id: containerId, messages, done: false, stop_reason: data.stop_reason || '' });
  }
  const done = data.stop_reason !== 'pause_turn';
  return json({ text, sources, files, container_id: containerId, messages, done, stop_reason: data.stop_reason || '' });
}

const ROUTE_SYSTEM = [
  'אתה מנתב משימות משפטיות ואקדמיות למיומנויות (Skills) מתוך קטלוג נתון. קרא את המשימה ובחר את המיומנויות המתאימות לה באמת, בין אחת לארבע.',
  'החזר JSON בלבד, בלי שום טקסט נוסף, במבנה: {"skills": ["שם-מיומנות"], "reason": "הסבר קצר בעברית לבחירה"}.',
  'השמות חייבים להופיע בדיוק כפי שהם בקטלוג.',
].join('\n');

async function handleSkillRoute(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'no_key' }, 501);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }
  const task = String(body.task || '').trim().slice(0, 2000);
  if (!task) return json({ error: 'empty_task' }, 400);
  let all;
  try { all = await listSkills(env); } catch (e) { return json({ error: e.message, detail: e.detail || '' }, 502); }
  const mine = all.filter(s => s.source !== 'anthropic');
  if (!mine.length) return json({ error: 'no_skills_in_account' }, 404);
  const catalog = mine.map(s => '- ' + s.name + ': ' + (SKILL_DESCS[s.name] || '')).join('\n');
  const model = String(env.MODEL || DEFAULT_MODEL);
  const res = await fetch(ANTHROPIC, {
    method: 'POST',
    headers: anthropicHeaders(env),
    body: JSON.stringify({
      model, max_tokens: 1200,
      system: ROUTE_SYSTEM,
      messages: [{ role: 'user', content: 'הקטלוג:\n' + catalog + '\n\nהמשימה:\n' + task }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    return json({ error: 'anthropic_' + res.status, detail: t.slice(0, 300) }, 502);
  }
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  let chosen = [];
  let reason = '';
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m[0]);
    if (Array.isArray(parsed.skills)) chosen = parsed.skills.map(String);
    reason = String(parsed.reason || '');
  } catch (e) { /* fall back to a name scan below */ }
  if (!chosen.length) chosen = mine.filter(s => text.includes(s.name)).map(s => s.name);
  const picked = [];
  for (const name of chosen) {
    const hit = mine.find(s => s.name === name) || mine.find(s => s.name.toLowerCase() === String(name).toLowerCase());
    if (hit && !picked.some(p => p.skill_id === hit.id)) picked.push({ skill_id: hit.id, type: 'custom', name: hit.name });
  }
  const companion = mine.find(s => s.name === 'asmachtaot-bemismach');
  if (companion && picked.length && !picked.some(p => p.skill_id === companion.id)) {
    picked.push({ skill_id: companion.id, type: 'custom', name: companion.name });
    reason = (reason ? reason + ' · ' : '') + 'צורף גם סקיל אימות האסמכתאות כמלווה';
  }
  return json({ skills: picked.slice(0, 5), reason });
}

async function handleFile(url, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'no_key' }, 501);
  const id = url.searchParams.get('id') || '';
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return json({ error: 'bad_file_id' }, 400);
  const headers = anthropicHeaders(env, { 'anthropic-beta': 'files-api-2025-04-14' });
  let filename = 'skill-file';
  let mime = 'application/octet-stream';
  try {
    const meta = await fetch(ANTHROPIC_V1 + '/files/' + encodeURIComponent(id), { headers });
    if (meta.ok) {
      const m = await meta.json();
      if (m.filename) filename = m.filename;
      if (m.mime_type) mime = m.mime_type;
    }
  } catch (e) { /* fall through with defaults */ }
  const res = await fetch(ANTHROPIC_V1 + '/files/' + encodeURIComponent(id) + '/content', { headers });
  if (!res.ok) {
    const t = await res.text();
    return json({ error: 'anthropic_' + res.status, detail: t.slice(0, 300) }, 502);
  }
  return new Response(res.body, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
      'Cache-Control': 'no-store',
    },
  });
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
        const data = await searchLaws(search);
        return json(data);
      }
      if (path === '/api/law-text') {
        const title = url.searchParams.get('title') || '';
        if (!title) return json({ error: 'missing_title' }, 400);
        const html = await wikiText(title);
        return json({ title, html });
      }
      if (path === '/api/ask' && request.method === 'POST') return await handleAsk(request, env);
      if (path === '/api/skills' && request.method === 'GET') return await handleSkillsList(env);
      if (path === '/api/skill-run' && request.method === 'POST') return await handleSkillRun(request, env);
      if (path === '/api/skill-step' && request.method === 'POST') return await handleSkillStep(request, env);
      if (path === '/api/skill-route' && request.method === 'POST') return await handleSkillRoute(request, env);
      if (path === '/api/file' && request.method === 'GET') return await handleFile(url, env);
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      return json({ error: 'upstream', detail: String(e.message || e).slice(0, 200) }, 502);
    }
  },
};
