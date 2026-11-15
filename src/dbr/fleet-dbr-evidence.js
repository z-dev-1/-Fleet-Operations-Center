// Fleet DBR evidence — one redacted, typed text block per down unit for the AI draft
// (design §4). Pure: no I/O, no clock (the caller passes `today` as 'YYYY-MM-DD'), no logging.
//
// A block is a list of segments (head, refs, [FAS actions logged], issue, [FAS notes], canonical,
// insights, timeline, manual entries, conversation, email evidence, ASIST notes, [verified facts]).
// Each rendered line carries a tag
// (fas | fasNotes | email | logged | conv | other) so the envelope gate (fleet-dbr-gate.js) can
// check a FAS quote and date against exactly the FAS-authored lines the model saw. `allocate`
// trims the oldest lines first (never a unit), and `planBatches` picks single vs map/reduce.
'use strict';

const { EMAIL_RE, parseTimelineLines, inferDate } = require('./fleet-dbr');
const { offsiteNewestFirst } = require('../utils/offsite-notes-order');

// ── Constants (§4.4) ────────────────────────────────────────────────────────
const EVIDENCE_BUDGET = 36000;
const SINGLE_SLACK = 1.15;                 // single mode up to 1.15 x budget, water-filled to it
const SINGLE_MAX_UNITS = 16;
const MAP_MAX_UNITS = 24;
const MAX_MAP_BATCHES = 4;
const MAX_UNITS_AI = MAP_MAX_UNITS * MAX_MAP_BATCHES;   // 96
const MIN_BLOCK = 600;
const UNIT_HARD_MAX = 14000;
const GAP_EVIDENCE_MAX = 18000;
const GAP_FAS_MAX = 16;

const HEAD_MAX = 560;
const JSON_CLIP = 600;
const ISSUE_DETAILS_MAX = 1500;
const CANONICAL_FIELD_MAX = 400;
const INSIGHTS_MAX = 800;
const CONV_ENTRY_MAX = 600;
const CONV_UNDATED_TAIL = 4000;
const MANUAL_MAX = 50;
const MANUAL_ENTRY_MAX = 400;
const EMAIL_MAX = 15;
const EMAIL_ENTRY_MAX = 300;
const ASIST_MAX = 3000;
const ASIST_KEEP = 1200;

const KEEP = Object.freeze({ timeline: 8, manual: 10, conv: 5, email: 3, facts: 6, fasLog: 4 });
// D6 (relay-extract output fix B): the protected FAS-authored segment.
const FAS_LOG_MAX = 6;
const FAS_LINE_CLIP = 160;
const FAS_LINE_MIN = 60;
const FAS_LOG_LABEL = 'FAS actions logged (newest first):';
const FACTS_LABEL = 'verified facts (extracted):';
const FACTS_BUDGET = 1200;

// ── Regexes (§4.1, §4.2) ────────────────────────────────────────────────────
// Phones need phone-shaped separators, so case/RO/ASIST numbers and "number date" runs survive.
const EVID_PHONE_RE = /(?<![\w-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w-])/g;
const EMAIL_MARKER_RE = /\[em:[0-9a-f]{8}\]/i;
const EMAIL_MARKER_ALL_RE = /\s*\[em:[0-9a-f]{8}\]/gi;
// One verb alternation, shared by classifyManual, the fasDates verb-attached rule and the gate.
const FAS_ACT_SRC = 'called|emailed|e-mailed|escalated|followed\\s+up|reached\\s+out|contacted|spoke|requested|messaged|texted|sent|'
  + 'left\\s+(?:a\\s+)?(?:vm|voicemail)|created|submitted|opened|asked|booked|scheduled|checked|sourced';
// FAS-subject position only: the verb LEADS the body, optionally after FAS / I / we / me.
const FAS_LEAD_RE = new RegExp('^\\s*(?:(?:fas|i|we|me)\\b[\\s,:-]*)?(?:' + FAS_ACT_SRC + ')\\b', 'i');
const LEAD_MD_RE = /^\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*-?\s*/;
// A date attached directly to an action verb; the window stops at , ; ( ).
const FAS_ACTION_DATE_RE = new RegExp('\\b(?:' + FAS_ACT_SRC + ')\\b[^\\n\\d,;()]{0,25}(\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)', 'gi');
const MD_RE = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?(?![\d/])/g;
const ENTRY_START_RE = /^\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*-|^-\s/;
const ENTRY_RE = /^\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?\s*-\s*([^:\n]{1,80}?)\s*:\s*(.*)$/s;
const CONV_NOISE_RE = /yard location update/i;
const TAG_PREFIX_RE = /^\s*(?:\[(?:fas notes|fas|email|logged)\]\s*)+/i;

const TAGS = Object.freeze({ fas: '[FAS] ', fasNotes: '[FAS notes] ', email: '[email] ', logged: '[logged] ' });
const MARK = (n) => '(+' + n + ' older lines not shown)';

// ── Helpers ─────────────────────────────────────────────────────────────────
function _s(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(_s).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    let j = '';
    try { j = JSON.stringify(v); } catch (_) { j = ''; }
    return j.length > JSON_CLIP ? j.slice(0, JSON_CLIP) : j;
  }
  return String(v);
}
function _clip(s, max) { return s.length > max ? (max > 1 ? s.slice(0, max - 1) + '\u2026' : '') : s; }
function _clipTail(s, max) { return s.length > max ? (max > 1 ? '\u2026' + s.slice(s.length - max + 1) : '') : s; }
function _one(s) { return s.replace(/\s+/g, ' ').trim(); }
function redactEvidence(s) {
  EMAIL_RE.lastIndex = 0;
  EVID_PHONE_RE.lastIndex = 0;
  return _s(s).replace(EMAIL_RE, '[redacted]').replace(EVID_PHONE_RE, '[redacted]');
}
// Coerce, strip \r, redact.
function _t(v) { return redactEvidence(_s(v).replace(/\r/g, '')); }
function _mdOf(token) {
  const m = /^\s*(\d{1,2})\/(\d{1,2})/.exec(token || '');
  return m ? (+m[1]) + '/' + (+m[2]) : '';
}
function _mds(text) {
  const out = new Set();
  MD_RE.lastIndex = 0;
  let m;
  while ((m = MD_RE.exec(text))) {
    const mo = +m[1];
    const d = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.add(mo + '/' + d);
  }
  return out;
}
function _mdOfIso(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(_s(v).trim());
  return m ? (+m[2]) + '/' + (+m[3]) : '';
}
// deep-scan's manual-entry signature: strip "MM/DD - ", trim, lowercase (marker ignored too).
function _sig(s) {
  return _one(_s(s).replace(EMAIL_MARKER_ALL_RE, '').replace(LEAD_MD_RE, '')).toLowerCase();
}

// ── Quote normalization / identity / classification ─────────────────────────
// Lowercase, drop [em:...] markers, tag prefixes and the leading M/D date, keep only
// [a-z0-9/$.#-], collapse whitespace. Conversation lines are indexed by their body only
// (buildUnitEvidence), so the author is never part of a citable quote.
function normQuote(s) {
  let t = _s(s).replace(EMAIL_MARKER_ALL_RE, ' ');
  t = t.replace(TAG_PREFIX_RE, '').replace(LEAD_MD_RE, '');
  return t.toLowerCase().replace(/[^a-z0-9/$.#-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function _normName(s) {
  return _s(s).toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
// Equality or equal token sets, both sides >= 2 tokens (single-token names never match).
// fasAlias (the AAP login) matches only the whole author string, case-insensitively.
function fasNameMatch(author, fasNames, fasAlias) {
  const raw = _s(author).trim();
  if (!raw) return false;
  if (typeof fasAlias === 'string' && fasAlias.trim() && raw.toLowerCase() === fasAlias.trim().toLowerCase()) return true;
  const a = _normName(raw);
  const at = a.split(' ').filter(Boolean);
  if (at.length < 2) return false;
  const aset = [...new Set(at)].sort().join(' ');
  for (const n of Array.isArray(fasNames) ? fasNames : []) {
    if (typeof n !== 'string') continue;
    const b = _normName(n);
    const bt = b.split(' ').filter(Boolean);
    if (bt.length < 2) continue;
    if (a === b || aset === [...new Set(bt)].sort().join(' ')) return true;
  }
  return false;
}

// 'email' (email-intel line with [em:...]), 'fas' (body leads with a FAS action verb), else 'logged'.
function classifyManual(line) {
  const s = _s(line);
  if (EMAIL_MARKER_RE.test(s)) return 'email';
  const body = s.replace(LEAD_MD_RE, '');
  return FAS_LEAD_RE.test(body) ? 'fas' : 'logged';
}

// FAS dates of one FAS-authored line: its leading M/D (or the entry date) plus each date
// attached directly to an action verb.
function _fasDatesOf(body, entryMd) {
  const out = new Set();
  const lead = entryMd || (LEAD_MD_RE.test(body) ? _mdOf(body) : '');
  if (lead) out.add(lead);
  FAS_ACTION_DATE_RE.lastIndex = 0;
  let m;
  while ((m = FAS_ACTION_DATE_RE.exec(body))) {
    const md = _mdOf(m[1]);
    if (md && _mds(m[1]).size) out.add(md);
  }
  return out;
}

// ── fullConversation parsing (§4.2) ─────────────────────────────────────────
// -> [{ date: 'MM/DD'|'' (as written), author, body }] newest first.
function conversationEntries(text) {
  const raw = _s(text).replace(/\r/g, '');
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (i < lines.length && /^\s*conversation\s*$/i.test(lines[i])) i += 1;
  const chunks = [];
  let cur = null;
  let dated = false;
  for (; i < lines.length; i++) {
    const l = lines[i];
    const m = ENTRY_START_RE.exec(l);
    if (m) {
      if (m[1]) dated = true;
      cur = [l];
      chunks.push(cur);
    } else if (cur) {
      cur.push(l);
    } else if (l.trim()) {
      cur = [l];
      chunks.push(cur);
    }
  }
  if (!dated) {
    const body = _one(raw.replace(/^\s*conversation\s*\n/i, ''));
    return body ? [{ date: '', author: '', body: _clipTail(body, CONV_UNDATED_TAIL) }] : [];
  }
  const entries = [];
  for (const c of chunks) {
    const whole = c.join('\n');
    const m = ENTRY_RE.exec(whole);
    let date = '';
    let author = '';
    let body;
    if (m) { date = m[1] || ''; author = _one(m[2]); body = m[3]; } else body = whole;
    body = _clip(_one(body), CONV_ENTRY_MAX);
    if (!body || CONV_NOISE_RE.test(body)) continue;
    entries.push({ date, author, body });
  }
  // De-dup by body signature, keeping the newest (last) copy, then newest first.
  const seen = new Set();
  const out = [];
  for (let k = entries.length - 1; k >= 0; k--) {
    const sig = _sig(entries[k].body);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(entries[k]);
  }
  return out;
}

// ── Block construction (§4.1) ───────────────────────────────────────────────
// Line: { text, tag, entryMd, fasAuthored, bodyAt }. bodyAt = where the citable body starts.
function _line(text, tag, opts = {}) {
  return { text, tag, entryMd: opts.entryMd || '', fasAuthored: !!opts.fasAuthored, bodyAt: opts.bodyAt || 0 };
}
function _seg(kind, label, lines, keep) {
  return { kind, label: label || '', lines, keep: keep == null ? lines.length : keep, dropped: 0 };
}
function _newestFirst(texts, today) {
  const parsed = texts.map((raw, index) => {
    const m = /^\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(raw);
    return { raw, index, date: m ? inferDate(m[1], m[2], m[3], today) : null };
  });
  const dated = parsed.filter((p) => p.date)
    .sort((a, b) => (a.date === b.date ? b.index - a.index : (a.date < b.date ? 1 : -1)));
  const undated = parsed.filter((p) => !p.date).sort((a, b) => b.index - a.index);
  return dated.concat(undated).map((p) => p.raw);
}
function _timelineNewestFirst(text, today) {
  const lines = parseTimelineLines(text, today);
  const dated = lines.filter((l) => l.date)
    .sort((a, b) => (a.date === b.date ? b.index - a.index : (a.date < b.date ? 1 : -1)));
  const undated = lines.filter((l) => !l.date).sort((a, b) => b.index - a.index);
  return dated.concat(undated).map((l) => l.raw.trim());
}
function _tagged(tag, body, opts) {
  const pre = TAGS[tag] || '';
  return _line(pre + body, tag, Object.assign({ bodyAt: pre.length }, opts));
}
const _manualTag = { fas: 'fas', email: 'email', logged: 'logged' };

function _head(raw, unit) {
  const u = unit || {};
  const f = (v) => _clip(_one(_t(v)), 120);
  const etc = u.etc || {};
  const etcMd = etc.date ? _mdOf(String(etc.date).slice(5).replace('-', '/')) : '';
  const parts = [
    '[' + (u.id || _one(_t(raw.equipmentId)) || '(no id)') + ']',
    u.daysDown == null ? 'days down unknown' : u.daysDown + 'd down',
    'status: ' + (f(raw.savedRepairStatus) || '-'),
    'vendor: ' + (f(raw.vendor) || 'no vendor assigned'),
  ];
  const opt = [
    ['lifecycle', raw.lifecycleReason], ['sub-vendor', raw.subVendor], ['service state', raw.serviceState],
    ['delay codes', raw.delayReasonCodes], ['offsite', [_s(raw.offsiteStage).trim(), _s(raw.offsiteStageDetail).trim()].filter(Boolean).join(' / ')],
    ['escalations', raw.escalations], ['estimate pending', raw.estimatePendingCost], ['urgent', raw.urgent],
    ['created', raw.created], ['work duration', raw.workDuration], ['component', raw.savedPrimaryComponent],
    ['dealer', raw.dealerName],
  ];
  for (const [k, v] of opt) { const s = f(v); if (s) parts.push(k + ': ' + s); }
  const hints = Array.isArray(u.barriers) && u.barriers.length ? u.barriers.join(', ') : 'none';
  parts.push('rule hints (may be wrong): ' + hints);
  parts.push('parsed ETC: ' + (etc.state || 'none') + (etcMd ? ' ' + etcMd : '') + (etc.source ? ' (from ' + etc.source + ')' : ''));
  return _clip(parts[0] + ' ' + parts.slice(1).join(' | '), HEAD_MAX);
}

// raw: fleet row; unit: builder unit ({ id, daysDown, barriers, etc }); enrichRec:
// { canonical, manualEntries, email } (any part may be missing); fasNames: string[];
// fasAlias: the AAP login alias or ''/null.
function buildUnitEvidence(raw, unit, enrichRec, today, fasNames, fasAlias) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const u = unit && typeof unit === 'object' ? unit : {};
  const en = enrichRec && typeof enrichRec === 'object' ? enrichRec : {};
  const id = _s(u.id).trim() || _s(r.equipmentId).trim() || '(no id)';
  const segs = [];

  segs.push(_seg('head', '', [_line(_head(r, Object.assign({}, u, { id })), 'other')]));

  const refs = [
    ['WO', r.vendorWorkOrderId], ['WR', r.workRequestId], ['service', r.serviceUrl], ['asset', r.assetUrl],
    ['offsite event', r.offsiteShopEventUrl], ['SF case', r.salesforceCase], ['SF case', r.savedSalesforceCase],
    ['SF case url', r.salesforceCaseUrl], ['SF case url', r.savedSalesforceCaseUrl], ['open cases', r.openCases],
  ].map(([k, v]) => [k, _one(_t(v))]).filter(([, v]) => v);
  const seenRef = new Set();
  const refText = refs.filter(([k, v]) => { const key = k + v; if (seenRef.has(key)) return false; seenRef.add(key); return true; })
    .map(([k, v]) => k + ' ' + v).join(' | ');
  if (refText) segs.push(_seg('refs', '', [_line('refs: ' + refText, 'other')]));

  const issue = [_one(_t(r.issueSummary)), _clip(_one(_t(r.issueDetails)), ISSUE_DETAILS_MAX)].filter(Boolean).join(' \u2014 ');
  if (issue) segs.push(_seg('issue', '', [_line('issue: ' + issue, 'other')]));

  const notes = _t(r.savedNotes).split('\n').map(_one).filter(Boolean);
  if (notes.length) {
    segs.push(_seg('fasNotes', '', notes.map((n) => _tagged('fasNotes', n, { fasAuthored: true }))));
  }

  const canon = en.canonical && typeof en.canonical === 'object' && !Array.isArray(en.canonical) ? en.canonical : {};
  const canonLines = [['situation', canon.situation], ['next step', canon.nextStep], ['waiting on', canon.waitingOn],
    ['vendor message', canon.vendorMessage], ['updated', canon.updatedAt]]
    .map(([k, v]) => [k, _clip(_one(_t(v)), CANONICAL_FIELD_MAX)]).filter(([, v]) => v)
    .map(([k, v]) => _line(k + ': ' + v, 'other'));
  if (canonLines.length) segs.push(_seg('canonical', 'canonical (derived summary \u2014 verify against raw lines):', canonLines));

  const insights = _clip(_one(_t(r.insights)), INSIGHTS_MAX);
  if (insights) segs.push(_seg('insights', '', [_line('insights: ' + insights, 'other')]));

  // Manual entries (validated upstream: strings, <= 50 newest, each <= 400).
  const manual = (Array.isArray(en.manualEntries) ? en.manualEntries : [])
    .filter((x) => typeof x === 'string' && x.trim()).slice(-MANUAL_MAX)
    .map((x) => _clip(_one(_t(x)), MANUAL_ENTRY_MAX));
  const manualBySig = new Map();
  for (const m of manual) manualBySig.set(_sig(m), classifyManual(m));

  const tl = _timelineNewestFirst(_t(r.repairTimeline), today);
  const tlSigs = new Set();
  const tlLines = tl.map((line) => {
    const sig = _sig(line);
    tlSigs.add(sig);
    const cls = manualBySig.get(sig) || (EMAIL_MARKER_RE.test(line) ? 'email' : null);
    const body = _one(line.replace(EMAIL_MARKER_ALL_RE, ''));
    if (!cls) return _line(body, 'other');
    return _tagged(_manualTag[cls], body, { fasAuthored: cls === 'fas' });
  });
  if (tlLines.length) segs.push(_seg('timeline', 'timeline (newest first):', tlLines, KEEP.timeline));

  const manualOnly = _newestFirst(manual.filter((m) => !tlSigs.has(_sig(m))), today).map((m) => {
    const cls = classifyManual(m);
    return _tagged(_manualTag[cls], _one(m.replace(EMAIL_MARKER_ALL_RE, '')), { fasAuthored: cls === 'fas' });
  });
  if (manualOnly.length) segs.push(_seg('manual', 'manual entries (newest first):', manualOnly, KEEP.manual));

  const fasManualSigs = new Set(manual.filter((m) => classifyManual(m) === 'fas').map(_sig));
  const conv = conversationEntries(_s(r.fullConversation)).map((e) => {
    const author = _one(_t(e.author));
    const body = _t(e.body);
    const fas = fasNameMatch(e.author, fasNames, fasAlias) || fasManualSigs.has(_sig(body));
    const prefix = (fas ? TAGS.fas : '') + (e.date ? e.date + ' - ' : (author ? '- ' : '')) + (author ? author + ': ' : '');
    return _line(prefix + body, fas ? 'fas' : 'conv', { entryMd: _mdOf(e.date), fasAuthored: fas, bodyAt: prefix.length });
  });
  if (conv.length) segs.push(_seg('conv', 'conversation (newest first):', conv, KEEP.conv));

  const emails = (Array.isArray(en.email) ? en.email : []).filter((x) => x && typeof x === 'object' && !Array.isArray(x))
    .map((x, index) => ({ x, index, at: _s(x.observedAt) }))
    .sort((a, b) => ((b.x.usedInConclusion === true) - (a.x.usedInConclusion === true))
      || (a.at === b.at ? b.index - a.index : (a.at < b.at ? 1 : -1)))
    .slice(0, EMAIL_MAX)
    .map(({ x }) => {
      const md = _mdOfIso(x.observedAt);
      const type = _one(_t(x.informationType));
      const label = /^stale$/i.test(type) ? '(stale) ' : (/^contradiction$/i.test(type) ? '(contradicts other evidence) ' : '');
      const sender = _one(_t(x.sender));
      const fas = fasNameMatch(sender, fasNames, null);
      const what = [type, _one(_t(x.field))].filter(Boolean).join('/');
      const pre = (fas ? TAGS.fas : '') + label;
      const body = _clip((md ? md + ' \u00b7 ' : '') + (what ? what + ': ' : '') + _one(_t(x.value)) + (sender ? ' (' + sender + ')' : ''), EMAIL_ENTRY_MAX);
      return _line(pre + body, fas ? 'fas' : 'email', { entryMd: md, fasAuthored: fas, bodyAt: pre.length });
    });
  if (emails.length) segs.push(_seg('email', 'email evidence:', emails, KEEP.email));

  // D1 (§15.2): asistNotes are newest-first; keep the head (newest), never the tail.
  const asist = offsiteNewestFirst(_t(r.asistNotes).trim());
  if (asist) segs.push(_seg('asist', 'ASIST notes (newest first):', [_line(_clip(asist, ASIST_MAX), 'other')]));

  // D2 (relay-extract): verified facts segment, only for rows with _factsOn. Tagged 'other', so
  // a fact line can never back a FAS claim. Any failure omits the segment (§14.7).
  if (r._factsOn) {
    try {
      const lines = require('../repair-intel/wo-fact-output').dbrFactLines(r, { today, budget: FACTS_BUDGET, notesFacts: userNotesFacts(en) });
      if (lines.length) segs.push(_seg('facts', FACTS_LABEL, lines.map((l) => _line(_one(_s(l)), 'other')), KEEP.facts));
    } catch (_) { /* facts segment omitted */ }
  }

  _protectFasLog(segs, today);

  const ev = _finish(id, segs, 0, 0);
  const rawDemand = ev.text().length;
  const capped = rawDemand > UNIT_HARD_MAX ? _trim(ev, UNIT_HARD_MAX) : ev;
  capped.rawDemand = rawDemand;
  capped.demand = capped.text().length;
  return capped;
}

// relay-extract notesFacts: the user's own app text typed by the extractor (manualEntries minus
// [em:] email-intel writes, source 'notes'; email evidence values, source 'email'). savedNotes is
// never typed (deep-scan writes it from the AI NOTE). Lazy require: no load-time cycle.
function userNotesFacts(enrichRec) {
  const en = enrichRec && typeof enrichRec === 'object' ? enrichRec : {};
  const X = require('../repair-intel/wo-extract');
  const facts = [];
  for (const m of Array.isArray(en.manualEntries) ? en.manualEntries : []) {
    if (typeof m !== 'string' || !m.trim() || EMAIL_MARKER_RE.test(m)) continue;
    facts.push(...X.extractText(m, { source: 'notes' }).facts);
  }
  for (const e of Array.isArray(en.email) ? en.email : []) {
    if (!e || typeof e !== 'object' || typeof e.value !== 'string' || !e.value.trim()) continue;
    facts.push(...X.extractText(e.value, { source: 'email', at: typeof e.observedAt === 'string' ? e.observedAt : null }).facts);
  }
  return facts;
}

function _lineYmd(l, today) {
  const md = l.entryMd || _mdOf(l.text.slice(l.bodyAt));
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(md || '');
  return m ? (inferDate(m[1], m[2], undefined, today) || '') : '';
}
// D6: MOVE the newest FAS_LOG_MAX FAS-authored lines of timeline / manual / conv (by entry date,
// then position) into a protected 'fasLog' segment right after the head and refs. Tags, entryMd and
// fasAuthored are kept, so _finish indexes them in fasLines / fasDates exactly as before.
function _protectFasLog(segs, today) {
  const pool = [];
  let pos = 0;
  for (const s of segs) {
    if (!['timeline', 'manual', 'conv'].includes(s.kind)) continue;
    for (const l of s.lines) { if (l.fasAuthored) pool.push({ l, s, pos, ymd: _lineYmd(l, today) }); pos += 1; }
  }
  if (!pool.length) return;
  pool.sort((a, b) => (a.ymd === b.ymd ? a.pos - b.pos : (a.ymd < b.ymd ? 1 : -1)));
  const pick = pool.slice(0, FAS_LOG_MAX);
  const moved = new Set(pick.map((p) => p.l));
  for (const s of segs) if (s.lines.some((l) => moved.has(l))) s.lines = s.lines.filter((l) => !moved.has(l));
  for (let i = segs.length - 1; i >= 0; i--) if (['timeline', 'manual', 'conv'].includes(segs[i].kind) && !segs[i].lines.length) segs.splice(i, 1);
  const at = segs.findIndex((s) => s.kind !== 'head' && s.kind !== 'refs');
  segs.splice(at < 0 ? segs.length : at, 0, _seg('fasLog', FAS_LOG_LABEL, pick.map((p) => p.l), KEEP.fasLog));
}

// relay-extract §14.3.1 (8): plain prompt text as one evidence block (timeline / trends gate).
// One 'data' segment, one line per input line; entryMd = the line's leading M/D or the nearest
// one above it. No FAS tagging, no trimming, no redaction (the evidence equals what the model saw).
function textEvidence(id, text, today) {
  void today;
  let md = '';
  const lines = _s(text).replace(/\r/g, '').split('\n').map((t) => {
    const lead = /^\s*(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?(?![\d/])/.exec(t);
    if (lead && +lead[1] >= 1 && +lead[1] <= 12 && +lead[2] >= 1 && +lead[2] <= 31) md = (+lead[1]) + '/' + (+lead[2]);
    return _line(t, 'other', { entryMd: md });
  });
  const ev = _finish(_s(id) || 'U', [_seg('data', '', lines)], 0, 0);
  ev.demand = ev.rawDemand = ev.text().length;
  return ev;
}

// Render + indexes over the prompt-visible lines (rebuilt after every trim).
function _render(segs) {
  const out = [];
  let orphan = 0;
  for (const s of segs) {
    if (!s.lines.length) { orphan += s.dropped; continue; }
    const body = s.lines.map((l) => l.text).join('\n');
    out.push((s.label ? s.label + '\n' : '') + body + (s.dropped ? '\n' + MARK(s.dropped) : ''));
  }
  if (orphan) out.push(MARK(orphan));
  return out.join('\n');
}
function _finish(id, segs, demand, rawDemand) {
  const lines = [];
  const fasLines = [];
  const fasDates = new Set();
  for (const s of segs) {
    for (const l of s.lines) {
      const body = l.text.slice(l.bodyAt);
      const mds = _mds(l.text);
      if (l.entryMd) mds.add(l.entryMd);
      const norm = normQuote(body);
      lines.push({ tag: l.tag, mds, norm });
      if (l.fasAuthored) {
        const fd = _fasDatesOf(body, l.entryMd);
        for (const d of fd) fasDates.add(d);
        fasLines.push({ mds: fd, norm });
      }
    }
  }
  return {
    id, segments: segs, fasDates, lines, fasLines, demand, rawDemand,
    text() { return _render(segs); },
  };
}
function _cloneSegs(segs) {
  return segs.map((s) => Object.assign({}, s, { lines: s.lines.map((l) => Object.assign({}, l)) }));
}

// ── Trimming (§4.3) ─────────────────────────────────────────────────────────
// Trim one block to <= cap chars: oldest lines first, then the fixed char-clip order, then
// (maximal trimming) everything but the head line. Never removes the unit.
function _trim(ev, cap) {
  const segs = _cloneSegs(ev.segments);
  const by = (kind) => segs.find((s) => s.kind === kind);
  const len = () => _render(segs).length;
  const over = () => len() - cap;
  const dropTo = (kind, min) => {
    const s = by(kind);
    if (!s) return;
    // Pop a batch worth the measured overflow, then re-measure (the marker adds a few chars).
    for (let o = over(); o > 0 && s.lines.length > min; o = over()) {
      while (o > 0 && s.lines.length > min) { o -= s.lines.pop().text.length + 1; s.dropped += 1; }
    }
  };
  const clipEach = (kind, max, tail) => {
    const s = by(kind);
    if (!s) return;
    for (let i = s.lines.length - 1; i >= 0 && over() > 0; i--) {
      const l = s.lines[i];
      const target = Math.max(max, l.text.length - over());
      if (l.text.length <= target) continue;
      if (tail) {
        const keepBody = Math.max(1, target - l.bodyAt);
        l.text = l.text.slice(0, l.bodyAt) + _clipTail(l.text.slice(l.bodyAt), keepBody);
      } else l.text = _clip(l.text, Math.max(l.bodyAt + 1, target));
    }
  };
  const clipTotalTail = (kind, max) => {    // keep the newest `max` chars of a multi-line segment
    const s = by(kind);
    if (!s) return;
    const size = () => s.lines.reduce((n, l) => n + l.text.length + 1, 0);
    while (s.lines.length > 1 && size() > max && over() > 0) { s.lines.shift(); s.dropped += 1; }
    if (s.lines.length === 1 && over() > 0) clipEach(kind, max, true);
  };
  if (over() <= 0) return _finish(ev.id, segs, ev.demand, ev.rawDemand);

  // Line trimming, oldest first. asist is newest-first: clips keep its head (D1).
  dropTo('conv', KEEP.conv);
  dropTo('email', KEEP.email);
  dropTo('timeline', KEEP.timeline);
  dropTo('facts', KEEP.facts);
  clipEach('asist', ASIST_KEEP, false);
  dropTo('manual', KEEP.manual);
  dropTo('conv', 2);
  dropTo('timeline', 3);
  // Char clipping of kept content, fixed order.
  clipEach('asist', 300, false);
  dropTo('email', 1);
  dropTo('conv', 1);
  dropTo('timeline', 1);
  dropTo('manual', 2);
  dropTo('fasLog', KEEP.fasLog);
  dropTo('fasLog', 2);
  dropTo('insights', 0);
  clipEach('canonical', 120, false);
  clipTotalTail('fasNotes', 300);
  clipEach('issue', 200, false);
  clipEach('refs', 300, false);
  clipEach('head', HEAD_MAX, false);
  // D6: head-clip every remaining fasLog line (keeps '[FAS] M/D - ' and the lead verb).
  const fl = by('fasLog');
  if (fl && over() > 0) for (const l of fl.lines) if (l.text.length > FAS_LINE_CLIP) l.text = _clip(l.text, FAS_LINE_CLIP);
  // Maximal trimming: only the head line, one fasLog line (and markers) can remain. The one-line
  // floor holds for every allocate budget (>= MIN_BLOCK); a direct trim below MIN_BLOCK gives
  // fasLog no protection (dropped first), as before D6.
  const floor = cap >= MIN_BLOCK;
  for (const kind of (floor ? [] : ['fasLog']).concat(['asist', 'email', 'conv', 'timeline', 'manual', 'canonical', 'fasNotes', 'issue', 'facts', 'refs'])) dropTo(kind, 0);
  dropTo('fasLog', floor ? 1 : 0);
  if (over() > 0) clipEach('fasLog', FAS_LINE_MIN, false);
  return _finish(ev.id, segs, ev.demand, ev.rawDemand);
}

// Water-filling: find c with sum(min(demand_i, c)) = budget; units above c are trimmed to c.
// Never drops a unit; c is never below MIN_BLOCK.
function allocate(evidences, budget = EVIDENCE_BUDGET) {
  const list = Array.isArray(evidences) ? evidences : [];
  const size = (e) => e.text().length;
  const total = list.reduce((n, e) => n + size(e), 0);
  if (total <= budget) return list.slice();
  const sorted = list.map(size).sort((a, b) => a - b);
  let remaining = budget;
  let c = MIN_BLOCK;
  for (let i = 0; i < sorted.length; i++) {
    const share = remaining / (sorted.length - i);
    if (sorted[i] <= share) { remaining -= sorted[i]; continue; }
    c = Math.floor(share);
    break;
  }
  c = Math.max(MIN_BLOCK, c);
  return list.map((e) => (size(e) > c ? _trim(e, c) : e));
}

// Plan (§4.4): too-large above MAX_UNITS_AI; single when n <= 16 and demand <= 1.15 x budget
// (water-filled to budget); otherwise exactly B contiguous map batches in builder order whose
// sizes differ by <= 1, each water-filled to budget.
function planBatches(evidences, budget = EVIDENCE_BUDGET) {
  const list = Array.isArray(evidences) ? evidences : [];
  const n = list.length;
  const total = list.reduce((s, e) => s + (e.demand || 0), 0);
  if (n > MAX_UNITS_AI) return { mode: 'too-large', demand: total };
  if (n <= SINGLE_MAX_UNITS && total <= Math.floor(SINGLE_SLACK * budget)) {
    return { mode: 'single', demand: total, batches: [allocate(list, budget)] };
  }
  const B = Math.min(MAX_MAP_BATCHES, Math.max(2, Math.ceil(total / budget), Math.ceil(n / MAP_MAX_UNITS)));
  const base = Math.floor(n / B);
  const extra = n % B;
  const groups = [];
  for (let i = 0, start = 0; i < B; i++) {
    const sz = base + (i < extra ? 1 : 0);
    groups.push(list.slice(start, start + sz));
    start += sz;
  }
  const k = base + (extra ? 1 : 0);
  if (k * MIN_BLOCK > budget) return { mode: 'too-large', demand: total };
  return { mode: 'mapreduce', demand: total, batches: groups.map((g) => allocate(g, budget)) };
}

module.exports = {
  EVIDENCE_BUDGET, SINGLE_SLACK, SINGLE_MAX_UNITS, MAP_MAX_UNITS, MAX_MAP_BATCHES, MAX_UNITS_AI,
  MIN_BLOCK, UNIT_HARD_MAX, GAP_EVIDENCE_MAX, GAP_FAS_MAX, KEEP,
  FAS_LOG_MAX, FAS_LINE_CLIP, FAS_LINE_MIN, FAS_LOG_LABEL, FACTS_LABEL,
  FAS_ACT_SRC, FAS_LEAD_RE, LEAD_MD_RE, EMAIL_MARKER_RE, FAS_ACTION_DATE_RE, EVID_PHONE_RE, ENTRY_RE,
  buildUnitEvidence, conversationEntries, redactEvidence, fasNameMatch, classifyManual, normQuote,
  allocate, planBatches, trimEvidence: _trim, textEvidence, userNotesFacts,
};
