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

const SKILL_SYSTEM = [
  'אתה עוזר עבודה משפטית ואקדמית לסטודנט למשפטים בישראל. ענה בעברית בלבד.',
  'המשתמש בחר מיומנויות (Skills) שצורפו לבקשה זו. פעל לפי הוראות המיומנויות שנבחרו: קרא את קבצי ההוראות שלהן שבמיכל ויישם את שלבי העבודה שלהן על המשימה ועל חומר הרקע.',
  'לתשומת לבך: סביבת הריצה (המיכל) חסרת גישה לאינטרנט, ולכן סקריפטים שרצים בתוכה אינם יכולים לקרוא לממשקים חיצוניים. לצורכי מחקר השתמש בכלים שניתנו לך בבקשה זו: search_verdicts ו־get_verdict_text לפסיקה בגילוי נאות, search_laws ו־get_law_text לחקיקה מספר החוקים הפתוח, וכן web_search ו־web_fetch.',
  'אסור להמציא פסקי דין, מספרי תיקים או סעיפי חוק. מה שלא נמצא, אמור במפורש.',
  'מסמך מעוצב: בכל משימה שהתוצר שלה הוא ניתוח, תדריך, מזכר, סקירה, חוות דעת או תוצר עבודה מהותי אחר, הפק בנוסף לתשובה בצ׳אט גם קובץ Word מעוצב (.docx) במיכל, ובו התוצר המלא, לא תקציר. בנה אותו ב־python-docx בתקן הבא: גופן David גודל 12 (כולל תכונת complex script בכותרות ובהדגשות), כיוון RTL מלא בכל פסקה (bidi), ריווח שורות 1.5, כותרת ראשית מודגשת וממורכזת, כותרות משנה מודגשות, גוף הטקסט מיושר לשני הצדדים, ושמות של פסקי דין וחוקים מודגשים בכל הופעה בגוף הטקסט.',
  'אין להשתמש במקף ארוך (—) בתוך המסמך; השתמש בפסיק, בנקודתיים, בסוגריים או במשפט נפרד.',
  'אם המיומנות עצמה מייצרת קובץ מסוג אחר (למשל xlsx), צור גם אותו כנדרש בהוראותיה.',
  'בסוף העבודה סכם בעברית מה נעשה, לפי מבנה הפלט שהמיומנות דורשת.',
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
