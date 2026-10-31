/**
 * ipc/baseball-card.js — AFP FAS performance "Baseball Card".
 *
 * A one-page career/performance profile filled into the user's own DOCX
 * template. Every field has its own AI-fill:
 *   - DATA fields  (name, region, sites, fleet size, SCACs, primary vendor,
 *                   current-role context, and — via Phonetool — manager,
 *                   skip-level, hire date, previous roles): sourced from the app
 *                   / the user's authenticated Phonetool page. NEVER fabricated.
 *   - PROSE fields (summary, LP super powers, growth ideas, STAR accomplishments,
 *                   outside-role contributions, initiatives, fun facts): the user
 *                   types a rough note and the AI rewrites it PROFESSIONALLY in the
 *                   section's required format (third-person LP, STAR, etc.).
 *
 * DOCX export is byte-identical to the user's template: we load their own
 * assets/baseball_card_template.docx and replace ONLY the [placeholder] tokens
 * (position-aware — several tokens repeat across rows), preserving every style.
 */

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const store  = require('../store');
const logger = require('../utils/logger')('baseball-card');
const { handle, requireObject } = require('./_safe');

// ── Field schema ────────────────────────────────────────────────────────────
// `token` is the EXACT placeholder text; `occ` is the 1-based occurrence index
// of that token in document order (because many tokens repeat — [Manager Name]
// appears twice, [X] three times, [LP Name] six times, etc.). `mode`:
//   'data'  — AI fills from app/Phonetool data (never invented)
//   'prose' — AI rewrites the user's rough note into the required format
//   'user'  — plain user entry (AI still offers a polish via 'prose' default)
// `source` tags where a data field comes from. `format` guides the prose AI.

// Biggest Accomplishments: the template asks for "data and STAR format (2-3
// sentences each)". The AI must return the WHOLE line: a short title, an em
// dash, then Situation/Task → Action → Result-with-metric sentences.
const STAR_FORMAT =
  'STAR method with EXPLICIT labels. Output exactly these 5 lines separated by \\n (newline), nothing else:\n' +
  '<Short title, 3-8 words>\n' +
  'Situation: <1 sentence — the context/problem, with data>\n' +
  'Task: <1 sentence — what Z was responsible for / the goal>\n' +
  'Action: <1-2 sentences — what Z specifically did>\n' +
  'Result: <1 sentence — the outcome with a concrete metric (%, $, hours, units, days, count)>\n' +
  'Past tense, professional, implied subject or third person. All four labels (Situation, Task, Action, Result) are REQUIRED. ' +
  'No bullets, quotes, or markdown. Never invent metrics — if Z gave none for the Result, ask for one.';

const FIELDS = [
  // ── Identity ──
  { key: 'name',        label: 'Name',                         token: '[Full Name]',                    occ: 1, mode: 'data', source: 'profile' },
  { key: 'alias',       label: 'Alias (alias@)',               token: '[alias@]',                       occ: 1, mode: 'data', source: 'phonetool' },
  { key: 'managerId',   label: 'Manager',                      token: '[Manager Name]',                 occ: 1, mode: 'data', source: 'phonetool' },
  { key: 'hireDate',    label: 'Amazon Hire Date (MM/YYYY)',   token: '[MM/YYYY]',                      occ: 1, mode: 'data', source: 'phonetool' },
  { key: 'geoFlex',     label: 'Geographic Flexibility',       token: '[Yes/No — Preferred locations]', occ: 1, mode: 'user' },
  { key: 'mentors',     label: 'Mentors (name(s) + relationship)', token: '[List mentor name(s) and relationship]', occ: 1, mode: 'user' },
  // ── Portfolio Overview ──
  { key: 'regionZone',  label: 'Region / Zone',                token: '[AFP Region / Zone]',            occ: 1, mode: 'data', source: 'domicileGeo' },
  { key: 'sites',       label: 'Assigned Sites',               token: '[Site 1, Site 2, Site 3, ...]',  occ: 1, mode: 'data', source: 'fleet' },
  { key: 'fleetSize',   label: 'Fleet Size',                   token: '[X assets]',                     occ: 1, mode: 'data', source: 'fleet' },
  { key: 'operators',   label: 'Operators / SCACs',            token: '[SCAC1, SCAC2, ...]',            occ: 1, mode: 'data', source: 'fleet' },
  { key: 'primaryVendor', label: 'Primary Vendor',             token: '[Vendor Name]',                  occ: 1, mode: 'data', source: 'vendors' },
  // ── Reporting Chain (Manager #2 occurrence + Skip-Level) ──
  { key: 'managerId2',  label: 'Manager (reporting chain)',    token: '[Manager Name]',                 occ: 2, mode: 'data', source: 'phonetool', mirror: 'managerId' },
  { key: 'skipLevelId', label: 'Skip-Level',                   token: '[Skip-Level Name]',              occ: 1, mode: 'data', source: 'phonetool' },
  // ── Summary ──
  { key: 'summaryName', label: 'Summary — Name',               token: '[Name]',                         occ: 1, mode: 'data', source: 'profile', mirror: 'name' },
  { key: 'summaryYears',label: 'Summary — Years at Amazon',    token: '[X]',                            occ: 1, mode: 'data', source: 'phonetool' },
  { key: 'summaryMonths', label: 'Summary — Months',           token: '[X]',                            occ: 2, mode: 'data', source: 'phonetool' },
  { key: 'summaryContext', label: 'Summary — current role context', token: '[describe current role transition or key context about their position in the FAS org]', occ: 1, mode: 'prose', format: 'One or two professional sentences describing this FAS\'s current role/position context in the AFP FAS org (ROC Fleet Maintenance), third person.' },
  // ── Super Powers — Top 3 LPs ──
  { key: 'lp1Name', label: 'Super Power 1 — LP',               token: '[LP Name]', occ: 1, mode: 'user' },
  { key: 'lp1Desc', label: 'Super Power 1 — why',              token: '[Describe how you demonstrate this LP with a specific example and measurable outcome]', occ: 1, mode: 'lp', lpNameKey: 'lp1Name', lpGroup: 'super', format: 'Third person. Describe how Z demonstrates this Leadership Principle with ONE specific example and a measurable outcome. 1-2 sentences.' },
  { key: 'lp2Name', label: 'Super Power 2 — LP',               token: '[LP Name]', occ: 2, mode: 'user' },
  { key: 'lp2Desc', label: 'Super Power 2 — why',              token: '[Describe how you demonstrate this LP with a specific example and measurable outcome]', occ: 2, mode: 'lp', lpNameKey: 'lp2Name', lpGroup: 'super', format: 'Third person, specific example + measurable outcome, 1-2 sentences.' },
  { key: 'lp3Name', label: 'Super Power 3 — LP',               token: '[LP Name]', occ: 3, mode: 'user' },
  { key: 'lp3Desc', label: 'Super Power 3 — why',              token: '[Describe how you demonstrate this LP with a specific example and measurable outcome]', occ: 3, mode: 'lp', lpNameKey: 'lp3Name', lpGroup: 'super', format: 'Third person, specific example + measurable outcome, 1-2 sentences.' },
  // ── Growth Ideas — LP-backed ──
  { key: 'growth1Name', label: 'Growth 1 — LP',                token: '[LP Name]', occ: 4, mode: 'user' },
  { key: 'growth1Desc', label: 'Growth 1 — plan',             token: '[What you are doing to develop in this area]', occ: 1, mode: 'lp', lpNameKey: 'growth1Name', lpGroup: 'growth', format: 'Third person. What Z is doing to develop in this LP area. 1 sentence, constructive and professional.' },
  { key: 'growth2Name', label: 'Growth 2 — LP',                token: '[LP Name]', occ: 5, mode: 'user' },
  { key: 'growth2Desc', label: 'Growth 2 — plan',             token: '[What you are doing to develop in this area]', occ: 2, mode: 'lp', lpNameKey: 'growth2Name', lpGroup: 'growth', format: 'Third person development plan, 1 sentence.' },
  { key: 'growth3Name', label: 'Growth 3 — LP (optional)',     token: '[LP Name]', occ: 6, mode: 'user' },
  { key: 'growth3Desc', label: 'Growth 3 — plan (optional)',  token: '[What you are doing to develop in this area]', occ: 3, mode: 'lp', lpNameKey: 'growth3Name', lpGroup: 'growth', format: 'Third person development plan, 1 sentence.' },
  // ── Biggest Accomplishments (STAR) ──
  // The whole "[Accomplishment N] — ..." template line is rewritten on export
  // (see _replaceAccomplishments), so these values are the COMPLETE line.
  { key: 'accomp1',  label: 'Accomplishment 1 (STAR)',          token: '[Accomplishment 1]', occ: 1, mode: 'prose', star: 1, format: STAR_FORMAT },
  { key: 'accomp2',  label: 'Accomplishment 2 (STAR)',          token: '[Situation, Task, Action, Result with metrics]', occ: 1, mode: 'prose', star: 2, format: STAR_FORMAT },
  { key: 'accomp3',  label: 'Accomplishment 3 (STAR)',          token: '[Situation, Task, Action, Result with metrics]', occ: 2, mode: 'prose', star: 3, format: STAR_FORMAT },
  { key: 'accomp4',  label: 'Accomplishment 4 (STAR)',          token: '[Situation, Task, Action, Result with metrics]', occ: 3, mode: 'prose', star: 4, format: STAR_FORMAT },
  // Accomplishment 1 header token + its inline tokens
  { key: 'accomp1Title', label: 'Accomplishment 1 — title',     token: '[Accomplishment 1]', occ: 1, mode: 'user', _dupOf: 'accomp1' },
  // ── Accomplishments Outside Core Role ──
  { key: 'outside1', label: 'Outside-role contribution 1',      token: '[e.g., Interviewer, Bar Raiser, Affinity Group leadership, Mentoring]', occ: 1, mode: 'prose', format: 'One short professional line naming a contribution outside day-to-day FAS work (e.g., Interviewer, Bar Raiser, mentoring).' },
  { key: 'outside2', label: 'Outside-role contribution 2',      token: '[Additional contribution outside day-to-day FAS responsibilities]', occ: 1, mode: 'prose', format: 'One short professional line.' },
  { key: 'outside3', label: 'Outside-role contribution 3',      token: '[Additional contribution]', occ: 1, mode: 'prose', format: 'One short professional line.' },
  // ── Current Initiatives (3 rows: initiative / outcome / timeline) ──
  { key: 'init1',     label: 'Initiative 1',                    token: '[Initiative 1]', occ: 1, mode: 'prose', init: 1, format: 'Short initiative name/description, professional.' },
  { key: 'init1Out',  label: 'Initiative 1 — target outcome',   token: '[Expected result]', occ: 1, mode: 'user' },
  { key: 'init1Time', label: 'Initiative 1 — timeline',         token: '[Date]', occ: 1, mode: 'user' },
  { key: 'init2',     label: 'Initiative 2',                    token: '[Initiative 2]', occ: 1, mode: 'prose', init: 2, format: 'Short initiative name/description.' },
  { key: 'init2Out',  label: 'Initiative 2 — target outcome',   token: '[Expected result]', occ: 2, mode: 'user' },
  { key: 'init2Time', label: 'Initiative 2 — timeline',         token: '[Date]', occ: 2, mode: 'user' },
  { key: 'init3',     label: 'Initiative 3',                    token: '[Initiative 3]', occ: 1, mode: 'prose', init: 3, format: 'Short initiative name/description.' },
  { key: 'init3Out',  label: 'Initiative 3 — target outcome',   token: '[Expected result]', occ: 3, mode: 'user' },
  { key: 'init3Time', label: 'Initiative 3 — timeline',         token: '[Date]', occ: 3, mode: 'user' },
  // ── Tenure & Development ──
  { key: 'startDate',    label: 'Start Date (MM/YYYY)',         token: '[MM/YYYY]',           occ: 2, mode: 'data', source: 'phonetool', mirror: 'hireDate' },
  { key: 'timeInRole',   label: 'Time in Role',                 token: '[X years, X months]', occ: 1, mode: 'user' },
  { key: 'previousRoles',label: 'Previous Roles',               token: '[Previous role(s)]',  occ: 1, mode: 'data', source: 'phonetool', aiMode: 'phonetool-roles' },
  { key: 'developmentGoals', label: 'Development Goals',         token: '[Growth aspirations]', occ: 1, mode: 'prose', format: 'Professional, forward-looking growth aspirations for a FAS, 1-2 sentences, third person or first person as appropriate.' },
  // ── Personal / Fun Facts ──
  { key: 'funFacts',  label: 'Hobbies / interests / fun fact',  token: '[Hobbies, interests, fun fact about this person]', occ: 1, mode: 'prose', format: 'A warm, brief, professional-appropriate fun-fact line from the user\'s rough note.' },
];

const STAR_LABELS = ['Situation', 'Task', 'Action', 'Result'];

// Parse an AI/user STAR entry into { title, parts:[{label,text}] }. Labels may
// arrive inline or on separate lines, in any case, with markdown — all
// normalized. No labels found → parts is empty and `title` holds the raw line.
function _parseStar(s) {
  const raw = String(s || '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*[-•*]\s*/gm, '')
    .trim()
    .replace(/^["']|["']$/g, '');
  const one = (t) => String(t || '').replace(/\s*\r?\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const re = /\b(Situation|Task|Action|Result)s?\s*:\s*/gi;
  const hits = [];
  let m;
  while ((m = re.exec(raw)) !== null) hits.push({ label: m[1], start: m.index, end: re.lastIndex });
  if (!hits.length) return { title: one(raw), parts: [] };
  const title = one(raw.slice(0, hits[0].start)).replace(/\s*[—–:-]+\s*$/, '');
  const parts = hits.map((h, i) => ({
    label: STAR_LABELS.find(l => l.toLowerCase() === h.label.toLowerCase()),
    text: one(raw.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : raw.length)),
  })).filter(p => p.text);
  return { title, parts };
}

// Canonical stored/displayed form: title line, then one "Label: text" per line.
function _cleanStarLine(s) {
  const { title, parts } = _parseStar(s);
  if (!parts.length) return title;
  return [title, ...parts.map(p => p.label + ': ' + p.text)].filter(Boolean).join('\n');
}

// Rewrite each "[Accomplishment N] — <template guidance>" paragraph with the
// card's accompN value. The template line contains extra literal text/tokens
// ("Launched/Implemented [X]. Successfully [outcome]...", "[Situation, Task,
// ...]") so a single-token swap left junk behind — replace the paragraph's runs
// instead, keeping its list numbering (pPr) and run font (rPr). A leading
// "Title — " is rendered bold, the STAR sentences regular. Blank → untouched.
function _replaceAccomplishments(xml, card) {
  return xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (para) => {
    const text = para.replace(/<[^>]+>/g, '');
    const m = text.match(/\[Accomplishment (\d)\]/);
    if (!m) return para;
    const f = FIELDS.find(x => x.star === Number(m[1]));
    const val = f ? _cleanStarLine(card[f.key]) : '';
    if (!val) return para;

    const open = (para.match(/^<w:p[ >][^>]*>|^<w:p>/) || ['<w:p>'])[0];
    const pPr = (para.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
    const runsOnly = pPr ? para.replace(pPr, '') : para;
    const rPrRaw = (runsOnly.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || ['<w:rPr></w:rPr>'])[0];
    const rPrBold = rPrRaw.replace('<w:rPr>', '<w:rPr><w:b /><w:bCs />');
    const run = (rPr, t) => '<w:r>' + rPr + '<w:t xml:space="preserve">' + _xmlEscape(t) + '</w:t></w:r>';

    const BR = '<w:r>' + rPrRaw + '<w:br /></w:r>';
    const star = _parseStar(val);
    let body;
    if (star.parts.length) {
      // Bold title, then each "Situation: / Task: / Action: / Result:" on its
      // own line (line breaks inside the same numbered list item), label bold.
      const segs = [];
      if (star.title) segs.push(run(rPrBold, star.title));
      for (const p of star.parts) segs.push(run(rPrBold, p.label + ': ') + run(rPrRaw, p.text));
      body = segs.join(BR);
    } else {
      const tm = val.match(/^(.{3,90}?)\s+[—–-]{1,2}\s+(.+)$/);
      body = tm ? run(rPrBold, tm[1]) + run(rPrRaw, ' — ' + tm[2]) : run(rPrRaw, val);
    }
    return open + pPr + body + '</w:p>';
  });
}

const TEMPLATE_PATH = () => {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'baseball_card_template.docx'),
    path.join(process.resourcesPath || '', 'assets', 'baseball_card_template.docx'),
    path.join(process.cwd(), 'assets', 'baseball_card_template.docx'),
  ];
  for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch (_) {} }
  return candidates[0];
};

function _emptyCard() {
  const c = { updatedAt: null };
  for (const f of FIELDS) c[f.key] = '';
  return c;
}

function _loadCard() {
  const saved = store.load('baseballCard', null);
  const base = _emptyCard();
  if (saved && typeof saved === 'object') {
    for (const f of FIELDS) if (typeof saved[f.key] === 'string') base[f.key] = saved[f.key];
    base.updatedAt = saved.updatedAt || null;
    if (saved._phonetool && typeof saved._phonetool === 'object') base._phonetool = saved._phonetool;
  }
  return base;
}

// ── Data sources (NEVER fabricated) ───────────────────────────────────────────
// Returns a map of field.source -> value, computed from live app data.
function _appData(profileName) {
  const data = {};
  const nm = String(profileName || '').trim();
  if (nm) data.profile = nm;

  try {
    const fd = store.load('fleetData', { rows: [] });
    const rows = Array.isArray(fd.rows) ? fd.rows : [];
    if (rows.length) {
      data.fleetSize = rows.length + ' assets';
      const sites = [...new Set(rows.map(r => String(r.domicileSite || r.domicile || r.site || '').trim().toUpperCase()).filter(Boolean))].sort();
      data.sites = sites.join(', ');
      const ops = [...new Set(rows.map(r => String(r.operator || '').trim().toUpperCase()).filter(Boolean))].sort();
      data.operators = ops.join(', ');
    }
  } catch (e) { logger.warn('fleet read failed: ' + e.message); }

  // Primary vendor = the PRIMARY maintenance vendors assigned to the user's
  // domiciles. These are a FIXED set: COX, TA, Amerit. Dealers (Volvo ASIST,
  // CEI, Fleetnet, Decisiv shops, etc.) are NOT primary vendors and must never
  // appear here. We only ever emit from the known set — no contact/dealer leak.
  data.vendors = 'COX, TA, Amerit';

  // Region / Zone = the city + state of the user's domiciles, from the domicile
  // contacts (Contact Book → Domiciles) that carry addresses.
  try {
    const contacts = store.load('contacts', []) || [];
    const geos = [];
    contacts.forEach(c => {
      if (c && c.type === 'domicile') {
        const cs = [c.city, c.state].map(x => String(x || '').trim()).filter(Boolean).join(', ');
        if (cs && !geos.includes(cs)) geos.push(cs);
      }
    });
    if (geos.length) data.domicileGeo = geos.join(' | ');
  } catch (_) {}

  // Phonetool-sourced fields (manager, skip-level, hire date, alias, previous
  // roles, years) — populated by the scraper and cached on the card as
  // card._phonetool. Pulled in by _autofill below.
  return data;
}

// The 16 Amazon Leadership Principles (authoritative list, for LP fields).
const LEADERSHIP_PRINCIPLES = [
  'Customer Obsession', 'Ownership', 'Invent and Simplify', 'Are Right, A Lot',
  'Learn and Be Curious', 'Hire and Develop the Best', 'Insist on the Highest Standards',
  'Think Big', 'Bias for Action', 'Frugality', 'Earn Trust', 'Dive Deep',
  'Have Backbone; Disagree and Commit', 'Deliver Results',
  'Strive to be Earth\u2019s Best Employer', 'Success and Scale Bring Broad Responsibility',
];

// LP-aware rewrite: given the user's rough note + the LPs already used elsewhere
// on the card, the AI picks the single BEST-FIT Leadership Principle (that is
// NOT already used) and writes the entry in the required format. Returns
// { lp, text } so the caller can fill BOTH the LP-name field and its description.
async function _aiRewriteLP(note, format, usedLPs) {
  const raw = String(note || '').trim();
  if (!raw) return { lp: '', text: '' };
  try {
    const relay = require('../orcha/relay');
    const used = (usedLPs || []).filter(Boolean);
    const avail = LEADERSHIP_PRINCIPLES.filter(lp => !used.some(u => u.toLowerCase() === lp.toLowerCase()));
    const prompt =
      'You are filling one Leadership-Principle entry on an AFP Fleet Asset Specialist performance "baseball card".\n' +
      'The 16 Amazon Leadership Principles are:\n- ' + LEADERSHIP_PRINCIPLES.join('\n- ') + '\n\n' +
      'Based on the user\'s rough note, pick the SINGLE best-fit Leadership Principle, then write the entry.\n' +
      'IMPORTANT: it MUST be different from these already-used LPs: ' + (used.length ? used.join(', ') : '(none yet)') + '. ' +
      'Choose ONLY from these still-available LPs: ' + avail.join(', ') + '.\n' +
      'FORMAT for the write-up: ' + (format || 'Third person, specific example + measurable outcome, 1-2 sentences.') + '\n' +
      'Respond as STRICT JSON only: {"lp":"<exact LP name>","text":"<the write-up>"}. No other text.\n\n' +
      'Rough note: ' + raw;
    const resp = await _askTimed(prompt, 500);
    const jm = String(resp || '').match(/\{[\s\S]*\}/);
    if (!jm) return { lp: '', text: '' };
    let parsed; try { parsed = JSON.parse(jm[0]); } catch (_) { return { lp: '', text: '' }; }
    let lp = String(parsed.lp || '').trim();
    // Snap to the canonical LP name (and never return an already-used one).
    const match = LEADERSHIP_PRINCIPLES.find(x => x.toLowerCase() === lp.toLowerCase())
      || LEADERSHIP_PRINCIPLES.find(x => lp && x.toLowerCase().includes(lp.toLowerCase()));
    lp = match || lp;
    if (used.some(u => u.toLowerCase() === String(lp).toLowerCase())) {
      // Collision — fall back to the first available LP.
      lp = avail[0] || lp;
    }
    const text = String(parsed.text || '').trim().slice(0, 2000);
    return { lp, text };
  } catch (e) {
    logger.warn('AI LP rewrite failed (non-fatal): ' + e.message);
    return { lp: '', text: '' };
  }
}

// Call relay.ask with a hard timeout so a slow Claude lane can't hang the
// baseball-card UI. On timeout we abort (relay falls through lanes) and throw,
// which the callers turn into a clean "try again" rather than a silent hang.
async function _askTimed(prompt, maxTokens, ms) {
  const relay = require('../orcha/relay');
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (_) {} }, ms || 55000);
  try {
    return await relay.ask(prompt, { maxTokens: maxTokens || 500, signal: ac.signal });
  } finally { clearTimeout(timer); }
}

// Pull the FAS role context the interviewer AI should know about (never shown
// to anyone else) — the authoritative FAS role/ownership knowledge + the user's
// coverage (sites/SCACs/carriers) + their title/previous roles from the card.
function _roleContext(card) {
  const parts = [];
  try {
    const fk = require('../orcha/fas-knowledge');
    const kb = (fk && (fk.FAS_KNOWLEDGE || fk.SHAREABLE)) || '';
    if (kb) parts.push('FAS ROLE KNOWLEDGE (what a FAS owns/does):\n' + String(kb).slice(0, 4000));
  } catch (_) {}
  try {
    const cov = store.load('fasCoverage', null);
    if (cov) parts.push('ZILA COVERAGE: ' + JSON.stringify(cov).slice(0, 1500));
  } catch (_) {}
  const c = card || _loadCard();
  const pt = c._phonetool || {};
  const bio = [];
  if (pt.title || c.name) bio.push('Title: ' + (pt.title || 'Fleet Asset Specialist, L4'));
  if (c.sites) bio.push('Sites: ' + c.sites);
  if (c.operators) bio.push('Operators/SCACs: ' + c.operators);
  if (c.primaryVendor) bio.push('Primary vendors: ' + c.primaryVendor);
  if (c.previousRoles || pt.previousRoles) bio.push('Previous roles: ' + (c.previousRoles || pt.previousRoles));
  if (pt.years) bio.push('Tenure: ' + pt.years + ' years');
  if (bio.length) parts.push('ABOUT Z (the person this card is for):\n' + bio.join('\n'));
  return parts.join('\n\n');
}

// Interviewer: given the user's note + role context + the field's goal, the AI
// EITHER writes the final entry OR asks 1-3 clarifying questions (like a short
// interview). For LP fields it also picks a distinct Leadership Principle.
// Returns { done, value, lp?, questions? }.
async function _aiInterview(opts) {
  const { note, goal, format, isLP, usedLPs, prevAnswers } = opts;
  try {
    const relay = require('../orcha/relay');
    const ctx = _roleContext(opts.card);
    const lpBlock = isLP
      ? ('This is a LEADERSHIP-PRINCIPLE entry. The 16 Amazon LPs are:\n- ' + LEADERSHIP_PRINCIPLES.join('\n- ') +
         '\nPick the SINGLE best-fit LP that is NOT already used (' + ((usedLPs || []).join(', ') || 'none yet') + '). ' +
         'Include it as "lp" in your JSON.\n')
      : '';
    const prompt =
      'You are an interviewer helping Z (an AFP Fleet Asset Specialist, L4) complete one field of their performance "baseball card". ' +
      'Work like a sharp interviewer: use the CONTEXT below + Z\'s note. If you have ENOUGH to write a strong, specific, professional entry, write it. ' +
      'If you are missing something that would make it materially better (a metric, a concrete example, a date, a name), ASK 1-3 short, pointed questions instead of guessing. Never fabricate specifics.\n\n' +
      'FIELD GOAL: ' + goal + '\n' +
      'OUTPUT FORMAT when writing: ' + (format || 'Professional, concise.') + '\n' +
      lpBlock +
      'CONTEXT:\n' + (ctx || '(no extra context available)') + '\n\n' +
      'Z\'S NOTE: ' + (String(note || '').trim() || '(blank)') + '\n' +
      (prevAnswers ? ('Z\'S ANSWERS TO YOUR QUESTIONS:\n' + prevAnswers + '\n') : '') +
      '\nRespond as STRICT JSON only, one of:\n' +
      '  {"done":true,"value":"<the finished entry>"' + (isLP ? ',"lp":"<exact LP name>"' : '') + '}\n' +
      '  {"done":false,"questions":["q1","q2"]}\n' +
      'No text outside the JSON.';
    const resp = await _askTimed(prompt, 600);
    const jm = String(resp || '').match(/\{[\s\S]*\}/);
    if (!jm) return { done: false, questions: ['Could not reach the AI — try again, or type the entry manually.'] };
    let p; try { p = JSON.parse(jm[0]); } catch (_) { return { done: false, questions: ['AI response was unclear — add a bit more detail and try again.'] }; }
    if (p.done && p.value) {
      let lp = '';
      if (isLP) {
        lp = String(p.lp || '').trim();
        const match = LEADERSHIP_PRINCIPLES.find(x => x.toLowerCase() === lp.toLowerCase())
          || LEADERSHIP_PRINCIPLES.find(x => lp && x.toLowerCase().includes(lp.toLowerCase()));
        lp = match || lp;
        if ((usedLPs || []).some(u => u.toLowerCase() === String(lp).toLowerCase())) {
          const avail = LEADERSHIP_PRINCIPLES.filter(x => !(usedLPs || []).some(u => u.toLowerCase() === x.toLowerCase()));
          lp = avail[0] || lp;
        }
      }
      return { done: true, value: String(p.value).trim().slice(0, 2000), lp };
    }
    const qs = Array.isArray(p.questions) ? p.questions.filter(Boolean).slice(0, 3) : [];
    return { done: false, questions: qs.length ? qs : ['Tell me one specific example or metric for this.'] };
  } catch (e) {
    logger.warn('AI interview failed (non-fatal): ' + e.message);
    return { done: false, questions: ['AI backend not reachable right now — type the entry manually, or retry.'] };
  }
}

// Previous Roles: clean a (possibly duplicated/raw) roles string into a concise,
// de-duplicated list of "Role (year)" entries. If it only has the current/most
// recent role, ASK whether Z held other Amazon roles before. Interview-style.
async function _aiPreviousRoles(note, prevAnswers, card) {
  try {
    const relay = require('../orcha/relay');
    const pt = (card && card._phonetool) || {};
    const raw = String(note || pt.previousRoles || '').trim();
    const prompt =
      'Clean up the PREVIOUS ROLES line for an Amazon FAS performance card. ' +
      'Rules: de-duplicate (no role listed twice), ONE entry per distinct role, format each as "Role Title (YYYY)" when a year is known (else just the title), most recent first, comma-separated. ' +
      'Do NOT invent roles or years. If the input only shows ONE role (the current/most recent) and you are not sure there were earlier Amazon roles, ask.\n' +
      'Known current title: ' + (pt.title || 'Fleet Asset Specialist, L4') + '\n' +
      'Raw previous-roles text (may be messy/duplicated): ' + (raw || '(none provided)') + '\n' +
      (prevAnswers ? ('Z\'s answer about other roles: ' + prevAnswers + '\n') : '') +
      'Respond STRICT JSON only: {"done":true,"value":"<cleaned list>"} OR {"done":false,"questions":["Did you hold any other roles at Amazon before this? If so, which and roughly what years?"]}. No other text.';
    const resp = await _askTimed(prompt, 300);
    const jm = String(resp || '').match(/\{[\s\S]*\}/);
    if (!jm) return { done: true, value: raw };
    let p; try { p = JSON.parse(jm[0]); } catch (_) { return { done: true, value: raw }; }
    if (p.done && p.value) return { done: true, value: String(p.value).trim().slice(0, 1000) };
    const qs = Array.isArray(p.questions) ? p.questions.filter(Boolean).slice(0, 2) : ['Did you hold other Amazon roles before this one? Which, and roughly what years?'];
    return { done: false, questions: qs };
  } catch (e) {
    return { done: true, value: String(note || '').trim() };
  }
}

// Current Initiatives row: from ONE rough note in the Initiative box, write all
// three columns — initiative name, target outcome, timeline. Never asks
// questions (the user wants a one-click fill). Returns null on AI failure.
async function _aiInitiative(note, card) {
  const raw = String(note || '').trim();
  if (!raw) return null;
  const today = new Date();
  const todayStr = (today.getMonth() + 1) + '/' + today.getDate() + '/' + today.getFullYear();
  const ctx = _roleContext(card);
  const prompt =
    'You are filling one row of the "CURRENT INITIATIVES / ACTIONS" table on an AFP Fleet Asset Specialist (FAS) performance "baseball card". ' +
    'The table has three columns: Initiative | Target Outcome | Timeline. From Z\'s rough note, write all three.\n' +
    'Rules:\n' +
    '- initiative: short professional name/description of the initiative (max ~12 words).\n' +
    '- outcome: the expected result in one concise professional sentence (max ~20 words). Use any numbers/targets Z gave; do NOT invent specific numbers that Z did not give — describe the outcome qualitatively instead.\n' +
    '- timeline: when it will be done. If Z gave a date/quarter/month, use it. Otherwise give a realistic target from today (' + todayStr + ') as "MM/YYYY" or "Q# YYYY". Short, no sentence.\n' +
    'CONTEXT:\n' + (ctx || '(none)') + '\n\n' +
    'Z\'S NOTE: ' + raw + '\n\n' +
    'Respond as STRICT JSON only: {"initiative":"...","outcome":"...","timeline":"..."}. No other text.';
  try {
    const resp = await _askTimed(prompt, 400);
    const jm = String(resp || '').match(/\{[\s\S]*\}/);
    if (!jm) return null;
    const p = JSON.parse(jm[0]);
    const clean = (s, n) => String(s || '').replace(/\s*\r?\n+\s*/g, ' ').trim().replace(/^["']|["']$/g, '').slice(0, n);
    const out = { initiative: clean(p.initiative, 300), outcome: clean(p.outcome, 400), timeline: clean(p.timeline, 60) };
    return out.initiative ? out : null;
  } catch (e) {
    logger.warn('AI initiative fill failed (non-fatal): ' + e.message);
    return null;
  }
}

// ── AI prose rewrite (for 'prose' fields) ─────────────────────────────────────
// Takes the user's rough note + the field's required format and asks the AI to
// rewrite it professionally. Returns '' on any failure (never blocks).
async function _aiRewrite(note, format) {
  const raw = String(note || '').trim();
  if (!raw) return '';
  try {
    const relay = require('../orcha/relay');
    const prompt =
      'You are polishing one field of an AFP Fleet Asset Specialist performance "baseball card". ' +
      'Rewrite the user\'s rough note into a professional, concise entry. ' +
      'FORMAT REQUIREMENT: ' + (format || 'Professional and concise.') + '\n' +
      'Return ONLY the rewritten text — no quotes, no preamble, no markdown.\n\n' +
      'Rough note: ' + raw;
    const text = await _askTimed(prompt, 400);
    return String(text || '').trim().replace(/^["']|["']$/g, '').slice(0, 2000);
  } catch (e) {
    logger.warn('AI rewrite failed (non-fatal): ' + e.message);
    return '';
  }
}

// Auto-fill DATA fields from app data + cached Phonetool, merging onto the saved
// card ONLY where the field is blank (never clobber user edits).
function _autofill(profileName) {
  const card = _loadCard();
  const data = _appData(profileName);
  const pt = card._phonetool || {};
  const filled = [];
  const put = (key, val) => { const v = String(val || '').trim(); if (v && !String(card[key] || '').trim()) { card[key] = v; filled.push(key); } };

  for (const f of FIELDS) {
    if (f.mode !== 'data') continue;
    let val = '';
    switch (f.source) {
      case 'profile':    val = data.profile; break;
      case 'fleet':      val = data[f.key] || (f.key === 'sites' ? data.sites : f.key === 'operators' ? data.operators : f.key === 'fleetSize' ? data.fleetSize : ''); break;
      case 'vendors':    val = data.vendors; break;
      case 'domicileGeo':val = data.domicileGeo; break;
      case 'phonetool':
        // Map field -> phonetool record key.
        if (f.key === 'managerId' || f.key === 'managerId2') val = pt.manager;
        else if (f.key === 'skipLevelId') val = pt.skipLevel;
        else if (f.key === 'hireDate' || f.key === 'startDate') val = pt.hireDate;
        else if (f.key === 'alias') val = pt.alias;
        else if (f.key === 'previousRoles') val = pt.previousRoles;
        else if (f.key === 'summaryYears') val = pt.years;
        else if (f.key === 'summaryMonths') val = pt.months;
        break;
      default: val = '';
    }
    // mirrors (e.g. summaryName mirrors name) fall back to the mirror field.
    if (!val && f.mirror && String(card[f.mirror] || '').trim()) val = card[f.mirror];
    put(f.key, val);
  }
  return { card, filled };
}

// ── DOCX export (position-aware token replacement) ─────────────────────────────
function _xmlEscape(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Collapse run markup INSIDE any [ ... ] token so split placeholders become
// contiguous literals (safe — only touches text between a '[' and its ']').
function _normalizeSplitTokens(xml) {
  return xml.replace(/\[[^\]]*?<w:[^\]]*?\]/g, (m) => m.replace(/<[^>]+>/g, ''));
}

// Replace occurrences of ONE token in a single pass using a map of
// { occurrenceIndex(1-based) -> replacementValue }. Occurrences without an
// entry are left unchanged (placeholder stays). Doing all occurrences of a
// token together — by ORIGINAL index — avoids the index-shift bug you get when
// replacing occ 1 then trying to find occ 2 in the already-modified string.
function _replaceTokenByOcc(xml, token, occMap) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc, 'g');
  let i = 0, out = '', last = 0, m;
  while ((m = re.exec(xml)) !== null) {
    i++;
    if (Object.prototype.hasOwnProperty.call(occMap, i)) {
      out += xml.slice(last, m.index) + occMap[i];
      last = m.index + m[0].length;
    }
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  out += xml.slice(last);
  return out;
}

function _replaceTokens(documentXml, card) {
  let xml = _normalizeSplitTokens(documentXml);

  // Group all fields by their token, building { token -> { occ -> value } }.
  // Blank values and _dupOf helper fields are skipped (placeholder stays).
  // STAR accomplishments rewrite their whole template line first (their
  // placeholders are then gone, so the generic pass below can't touch them).
  xml = _replaceAccomplishments(xml, card);

  const byToken = {};
  for (const f of FIELDS) {
    if (f._dupOf || f.star) continue;
    const val = String(card[f.key] || '').trim();
    if (!val) continue;
    (byToken[f.token] || (byToken[f.token] = {}))[f.occ] = _xmlEscape(val);
  }

  for (const token of Object.keys(byToken)) {
    xml = _replaceTokenByOcc(xml, token, byToken[token]);
  }
  return xml;
}

async function _exportDocx(card, destPath) {
  const JSZip = require('jszip');
  const tpl = TEMPLATE_PATH();
  if (!fs.existsSync(tpl)) throw new Error('Baseball card template not found at ' + tpl);
  const zip = await JSZip.loadAsync(fs.readFileSync(tpl));
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('template is not a valid .docx (no word/document.xml)');
  const xml = await docFile.async('string');
  zip.file('word/document.xml', _replaceTokens(xml, card));
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(destPath, out);
  return destPath;
}

function registerBaseballCardIPC() {
  handle('baseball-card:get', () => _loadCard());

  handle('baseball-card:save', (_e, payload) => {
    requireObject(payload, 'payload');
    const card = _loadCard();
    for (const f of FIELDS) if (typeof payload[f.key] === 'string') card[f.key] = payload[f.key].slice(0, 8000);
    card.updatedAt = new Date().toISOString();
    if (card._phonetool) store.save('baseballCard', card); else store.save('baseballCard', card);
    return { ok: true, card };
  });

  handle('baseball-card:autofill', (_e, payload) => {
    const profileName = (payload && typeof payload.profileName === 'string') ? payload.profileName : '';
    const { card, filled } = _autofill(profileName);
    return { ok: true, card, filled };
  });

  // Per-field AI: data fields pull from app data; prose fields rewrite the note;
  // LP fields pick a (distinct) Leadership Principle AND write the entry.
  handle('baseball-card:ai-field', async (_e, payload) => {
    const key = payload && payload.key;
    const note = payload && payload.note;
    const profileName = (payload && payload.profileName) || '';
    const formCard = (payload && payload.card && typeof payload.card === 'object') ? payload.card : {};
    const f = FIELDS.find(x => x.key === key);
    if (!f) return { ok: false, error: 'unknown field' };

    // answers = the user's replies to a previous round of interviewer questions.
    const prevAnswers = (payload && payload.answers) ? String(payload.answers) : '';
    // aiMode overrides mode for the ✨ action (e.g. previousRoles autofills as
    // 'data' but its ✨ runs the dedupe/interview 'phonetool-roles' flow).
    const aiMode = f.aiMode || f.mode;

    if (aiMode === 'phonetool-roles') {
      const r = await _aiPreviousRoles(note || String(formCard.previousRoles || ''), prevAnswers, formCard);
      if (r.done) return { ok: true, value: r.value };
      return { ok: true, needsAnswers: true, questions: r.questions };
    }

    if (f.mode === 'lp') {
      const groupNameKeys = FIELDS.filter(x => x.mode === 'lp' && x.lpGroup === f.lpGroup && x.lpNameKey !== f.lpNameKey).map(x => x.lpNameKey);
      const usedLPs = groupNameKeys.map(k => String(formCard[k] || '').trim()).filter(Boolean);
      const r = await _aiInterview({ note, goal: 'A Leadership-Principle "super power" or growth entry for a FAS baseball card.', format: f.format, isLP: true, usedLPs, prevAnswers, card: formCard });
      if (r.done) return { ok: true, value: r.value, lpName: r.lp, lpNameKey: f.lpNameKey };
      return { ok: true, needsAnswers: true, questions: r.questions, lpNameKey: f.lpNameKey };
    }

    if (f.init) {
      // Initiative row: one note → initiative + target outcome + timeline.
      if (!String(note || '').trim()) return { ok: false, error: 'type the initiative first, then ✨ fills the row' };
      const r = await _aiInitiative(note, formCard);
      if (!r) return { ok: false, error: 'AI could not fill this initiative — try again' };
      const extra = {};
      extra['init' + f.init + 'Out'] = r.outcome;
      extra['init' + f.init + 'Time'] = r.timeline;
      return { ok: true, value: r.initiative, extra };
    }

    if (f.mode === 'prose') {
      // Interview-style: may ask questions, else writes the entry.
      const goal = f.star
        ? ('Biggest Accomplishment #' + f.star + ' for the card, written with the STAR method (Situation, Task, Action, Result) and real data. ' +
           'Turn Z\'s rough note into a short title plus labeled "Situation:", "Task:", "Action:", "Result:" lines; if the note has no measurable result, ask for the metric.')
        : (f.label + ' — ' + (f.format || ''));
      const r = await _aiInterview({ note, goal, format: f.format, prevAnswers, card: formCard });
      if (r.done) return { ok: true, value: f.star ? _cleanStarLine(r.value) : r.value };
      return { ok: true, needsAnswers: true, questions: r.questions };
    }

    if (f.mode === 'user') {
      // Plain user field: ✨ offers a light professional polish of what's typed.
      // If empty, there's nothing to polish — say so gently (not an error).
      if (!String(note || '').trim()) return { ok: false, error: 'type something first, then ✨ polishes it' };
      const text = await _aiRewrite(note, f.format || 'Lightly polish this into a clean, professional entry. Keep it short.');
      return { ok: true, value: text || String(note) };
    }
    // data field — compute just this one.
    const { card } = _autofill(profileName);
    return { ok: true, value: String(card[key] || '') };
  });

  // A to Z sign-in — opens a visible login window so Phonetool (atoz.amazon.work)
  // gets a session. A to Z is a SEPARATE login from Midway/AAP.
  handle('baseball-card:signin-atoz', async () => {
    try { return await require('../scrapers/phonetool').signInAtoZ(); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // Phonetool scrape — manager, skip-level, hire date, alias, previous roles.
  // Runs in the user's authenticated Electron session (same pattern as AAP).
  handle('baseball-card:fetch-phonetool', async (_e, payload) => {
    const user = (payload && payload.user) || 'zilasant';
    try {
      const pt = await require('../scrapers/phonetool').fetchPhonetool(user);
      if (pt && pt.ok) {
        const card = _loadCard();
        card._phonetool = pt.data;
        store.save('baseballCard', card);
        logger.info('Phonetool fetched for ' + user + ': ' + Object.keys(pt.data || {}).filter(k => pt.data[k]).join(', '));
        return { ok: true, data: pt.data };
      }
      return { ok: false, error: (pt && pt.error) || 'Phonetool fetch failed' };
    } catch (e) {
      logger.warn('Phonetool fetch error: ' + e.message);
      return { ok: false, error: e.message };
    }
  });

  // Preview — returns the current card values grouped like the template, so the
  // renderer can show exactly what will export BEFORE writing the .docx. Marks
  // which fields are still unfilled (will keep their [placeholder]).
  handle('baseball-card:preview', (_e, payload) => {
    requireObject(payload, 'payload');
    // Save the latest edits first so preview reflects the live form.
    const card = _loadCard();
    for (const f of FIELDS) if (typeof payload[f.key] === 'string') card[f.key] = payload[f.key];
    const items = FIELDS.filter(f => !f._dupOf).map(f => ({
      key: f.key, label: f.label, value: String(card[f.key] || '').trim(),
      filled: !!String(card[f.key] || '').trim(), mode: f.mode,
    }));
    return { ok: true, items, updatedAt: card.updatedAt };
  });

  handle('baseball-card:export', async (_e, payload) => {
    const card = _loadCard();
    let dest = payload && typeof payload.destPath === 'string' && payload.destPath.trim() ? payload.destPath.trim() : '';
    if (!dest) {
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      dest = path.join(os.homedir(), 'Downloads', '2026_AFP_FAS_Baseball_Card_' + stamp + '.docx');
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await _exportDocx(card, dest);
      logger.info('Baseball card exported to ' + dest);
      return { ok: true, path: dest };
    } catch (e) {
      logger.warn('Baseball card export failed: ' + e.message);
      return { ok: false, error: e.message };
    }
  });

  logger.info('Baseball-card IPC handlers registered');
}

module.exports = { registerBaseballCardIPC, FIELDS, _replaceTokens, _appData, _autofill };
