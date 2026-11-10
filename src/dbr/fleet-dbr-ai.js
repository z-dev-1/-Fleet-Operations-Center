// Fleet DBR AI drafting — the two free-text cells "FAS Actions" and "Where Do You Need
// Support?" for one (Domicile x SCAC) row, drafted from that row's real down-unit fields.
// Pure except the injected `ask` (main passes relay.askWithTimeout). Drafts are suggestions:
// they are validated here, stored by the IPC layer, and only leave the app on an explicit
// Copy. On any failure nothing is substituted (no mechanical fallback text).
//
// Anti-fabrication gate (validateDraft), line-level: a line is dropped when it cites an
// ID-like token that is neither one of the pair's down units nor present (token-bounded) in
// the evidence, cites a fleet unit outside the pair, cites a ticket ref absent from the
// evidence, states an ETC date that is not one of the pair's parsed ETC dates, or states a
// $ amount or fact-like date (drop-off/tow/arrival/delivery/pickup/repaired) absent from the evidence.
'use strict';

const { extractJsonObject } = require('../utils/ai-json');
const { parseTimelineLines } = require('./fleet-dbr');

const TOTAL_BUDGET = 48000;
const UNITS_BUDGET = 40000;
const UNIT_MIN = 800;
const UNIT_MAX = 6000;
const TIMELINE_SHARE = 0.7;
const MAX_UNITS = 40;
const SECTION_CAP = 1500; // per barrier Details / ETC list in the prompt

const MAX_LINES = { fasActions: 8, support: 5 };
const MAX_LINE_CHARS = 160;
const MAX_FIELD_CHARS = 1200;

const ID_TOKEN_RE = /\b[A-Z]{1,4}\d{4,}[A-Z0-9]*\b|\b\d{5,}\b/g;
// amz-…, FNA-style refs. Only tokens containing a digit count as ticket refs, so ordinary
// hyphenated words ("re-escalated", "pre-approval") are not mistaken for invented tickets.
const TICKET_RE = /\b[a-z]{2,5}-[a-z0-9]{8,}\b/gi;
// Same ETC phrase list as the builder's parseEtc (fleet-dbr.js), so "repair ETA 11/14" is gated too.
const ETC_DATE_RE = /\b(ETC|ETR|est(?:\.|imated)?\s+(?:time\s+of\s+)?completion|expected\s+completion|completion\s+(?:date|eta)|repair\s+eta|eta\s+(?:for|on)\s+(?:completion|repair))\b[^\n\d]{0,25}(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/gi;
// Fact-like dates (drop-off, tow, arrival, delivery, pickup, repaired) must appear in the
// evidence; follow-up / due dates stay allowed because the draft proposes them.
const FACT_DATE_RE = /\b(drop[\s-]?off|dropped\s+off|tow(?:ed)?|arriv(?:ed|al)|deliver(?:ed|y)|picked\s+up|pick[\s-]?up|repaired)\b[^\n\d]{0,25}(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/gi;
// Dollar amounts must appear in the evidence ($4,200 / $4200 / $4,200.00 compare equal).
const AMOUNT_RE = /\$\s?(\d[\d,]*(?:\.\d+)?)/g;
const EVIDENCE_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b|\b\d{4}-(\d{2})-(\d{2})\b/g;

const BARRIER_LABELS = [
  ['vendor1p', '1P Vendor Barrier'], ['oem', 'OEM Barrier'], ['estimate', 'Estimate Barrier'],
  ['partner', 'Partner Barrier'], ['parts', 'Parts Delay'], ['common', 'Common Repairs'],
];

function _s(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(_s).filter(Boolean).join(', ');
  return String(v);
}
function _clip(s, max) { return s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s; }
function _escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function _idOf(r) { return _s(r && r.equipmentId).trim() || '(no id)'; }
function _md(ymd) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? (+m[1]) + '/' + (+m[2]) : '';
}
function _mdOf(token) {
  const m = /^(\d{1,2})\/(\d{1,2})/.exec(token || '');
  return m ? (+m[1]) + '/' + (+m[2]) : '';
}

// ── Prompt ──────────────────────────────────────────────────────────────────
function _unitBudget(n) { return Math.max(UNIT_MIN, Math.min(UNIT_MAX, Math.floor(UNITS_BUDGET / Math.max(n, 1)))); }

function _timelineNewestFirst(text, today) {
  const lines = parseTimelineLines(text, today);
  const dated = lines.filter((l) => l.date)
    .sort((a, b) => (a.date === b.date ? b.index - a.index : (a.date < b.date ? 1 : -1)));
  const undated = lines.filter((l) => !l.date).sort((a, b) => b.index - a.index);
  return dated.concat(undated).map((l) => l.raw.trim());
}

function _unitBlock(raw, unit, budget, today) {
  const u = unit || {};
  const days = u.daysDown == null ? 'days down unknown' : u.daysDown + 'd down';
  const etc = u.etc || {};
  const head = '[' + _idOf(raw) + '] ' + [
    days,
    'lifecycle: ' + (_s(raw.lifecycleReason).trim() || '-'),
    'vendor: ' + (_s(raw.vendor).trim() || 'no vendor assigned'),
    'repair status: ' + (_s(raw.savedRepairStatus).trim() || '-'),
    'service state: ' + (_s(raw.serviceState).trim() || '-'),
    'delay codes: ' + (_s(raw.delayReasonCodes).trim() || '-'),
    'offsite: ' + ([_s(raw.offsiteStage).trim(), _s(raw.offsiteStageDetail).trim()].filter(Boolean).join(' / ') || '-'),
    'escalations: ' + (_s(raw.escalations).trim() || '-'),
    'estimate pending: ' + (_s(raw.estimatePendingCost).trim() || '-'),
    'ETC: ' + (etc.state || 'none') + (etc.date ? ' ' + _md(etc.date) + (etc.source ? ' (from ' + etc.source + ')' : '') : ''),
    'barriers: ' + ((u.barriers && u.barriers.length) ? u.barriers.join(', ') : 'none'),
  ].join(' | ');

  const parts = [head];
  let used = head.length;
  const add = (label, text, cap) => {
    const t = _s(text).replace(/\r/g, '').trim();
    if (!t) return;
    const room = Math.min(cap, budget - used) - label.length - 2;
    if (room <= 20) return;
    const piece = label + ': ' + _clip(t, room);
    parts.push(piece);
    used += piece.length + 1;
  };
  add('issue', [_s(raw.issueSummary).trim(), _s(raw.issueDetails).trim()].filter(Boolean).join(' — '), budget);
  add('notes', raw.savedNotes, budget);

  const tl = _timelineNewestFirst(raw.repairTimeline, today);
  if (tl.length) {
    const tlCap = Math.floor(budget * TIMELINE_SHARE);
    const label = 'timeline (newest first):';
    const out = [];
    let tlUsed = used + label.length + 1;
    for (const line of tl) {
      if (tlUsed + line.length + 1 > tlCap && out.length) break;
      const l = _clip(line, Math.max(40, tlCap - tlUsed));
      out.push(l);
      tlUsed += l.length + 1;
      if (tlUsed >= tlCap) break;
    }
    const omitted = tl.length - out.length;
    const block = label + '\n' + out.join('\n') + (omitted > 0 ? '\n(+' + omitted + ' older timeline lines not shown)' : '');
    parts.push(block);
    used += block.length + 1;
  }

  const asist = _s(raw.asistNotes).replace(/\r/g, '').trim();
  if (asist) {
    const room = budget - used - 30;
    if (room > 40) {
      const tail = asist.length > room ? '…' + asist.slice(asist.length - room + 1) : asist;
      parts.push('asist notes (latest):\n' + tail);
    }
  }
  return parts.join('\n');
}

function _barrierSection(row) {
  const cells = (row && row.cells) || {};
  return BARRIER_LABELS.map(([id, label]) => {
    const yn = cells[id + 'YN'] || 'N';
    const det = _s(cells[id + 'Details']).trim();
    return label + ': ' + yn + (det ? '\n' + _clip(det, SECTION_CAP).split('\n').map((l) => '  - ' + l).join('\n') : '');
  }).join('\n');
}

function _etcSection(row) {
  const units = (row && row.units) || [];
  const by = { today: [], missed: [], future: [], none: [] };
  for (const u of units) {
    const st = (u.etc && u.etc.state) || 'none';
    const label = u.id + (u.etc && u.etc.date ? ' (ETC ' + _md(u.etc.date) + ')' : '');
    (by[st] || by.none).push(label);
  }
  return ['today', 'missed', 'future', 'none']
    .map((k) => k + ': ' + (by[k].length ? _clip(by[k].join(', '), SECTION_CAP) : '0'))
    .join('\n');
}

function _countsSection(row) {
  const p = row.pair || {};
  const d = row.domicileStats || {};
  const s = row.scacStats || {};
  return 'pair down/total: ' + (p.down || 0) + '/' + (p.total || 0) + '\n'
    + 'domicile ' + row.domicile + ': uptime ' + d.uptime + '%, units down ' + (d.down || 0) + '\n'
    + 'SCAC ' + row.scac + ': uptime ' + s.uptime + '%, units down ' + (s.down || 0);
}

const OUTPUT_CONTRACT = 'OUTPUT — Return ONLY JSON {"fasActions": string, "support": string}, no markdown, no prose.\n'
  + '- fasActions: one line per down unit that needs a FAS action, "• <ID>: <next concrete action>", at most 8 lines, at most 160 chars each, grounded in that unit\'s facts above.\n'
  + '- support: "• <team>: <ask> (<IDs>)" for asks of Uptime Manager / MCS / carrier-DSP / OEM-dealer / parts / accidents-insurance, at most 5 lines, or exactly "None".\n'
  + '- Cite unit IDs exactly as written. Never mention a unit not listed above. Never state an ETC date, ticket, claim or reference number that is not written above.';

// -> prompt string (<= 48 000 chars). `row` = builder row, `unitRows` = the pair's down fleet rows.
function buildDraftPrompt(row, unitRows, built, opts = {}) {
  const today = opts.today || (built && built.day) || (row && row.day) || null;
  const r = row || {};
  const raws = Array.isArray(unitRows) ? unitRows.filter((x) => x && typeof x === 'object') : [];
  const byId = new Map(((r.units) || []).map((u) => [u.id, u]));
  // Longest-down first (builder order), raw rows matched by id.
  const order = (r.units || []).map((u) => u.id);
  const sorted = raws.slice().sort((a, b) => {
    const ia = order.indexOf(_idOf(a));
    const ib = order.indexOf(_idOf(b));
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });
  const shown = sorted.slice(0, MAX_UNITS);
  const rest = sorted.slice(MAX_UNITS);

  const head = 'You are drafting two cells of a FAS Daily Business Review row for domicile ' + r.domicile + ' / SCAC ' + r.scac + '.\n\n'
    + 'RULES: Use ONLY the facts below. Do not invent vendors, dates, ETCs, estimates, people, ticket/claim numbers or units. If a fact isn\'t listed, don\'t state it.\n\n'
    + 'VERIFIED COUNTS (exact — do not recount)\n' + _countsSection(r) + '\n\n'
    + 'BARRIER FLAGS (computed in code — do not change)\n' + _barrierSection(r) + '\n\n'
    + 'ETC (parsed from text, best-effort)\n' + _etcSection(r) + '\n\n'
    + 'DOWN UNITS (' + raws.length + ')\n';
  const restLine = rest.length ? '\n+' + rest.length + ' more down units (IDs: ' + rest.map(_idOf).join(', ') + ')\n' : '';
  const tail = '\n\n' + OUTPUT_CONTRACT;

  const room = TOTAL_BUDGET - head.length - restLine.length - tail.length - 2 * shown.length - 16;
  const per = Math.min(_unitBudget(shown.length), Math.max(200, Math.floor(Math.min(UNITS_BUDGET, room) / Math.max(shown.length, 1))));
  const blocks = shown.map((raw) => _unitBlock(raw, byId.get(_idOf(raw)), per, today));
  const prompt = head + blocks.join('\n\n') + restLine + tail;
  return prompt.length > TOTAL_BUDGET ? prompt.slice(0, TOTAL_BUDGET - tail.length) + tail : prompt;
}

// ── Validation ──────────────────────────────────────────────────────────────
function _clean(v) {
  let s = typeof v === 'string' ? v : '';
  s = s.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
  s = s.replace(/\r/g, '').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function _inEvidence(tok, evidence, flags) {
  return new RegExp('(^|[^A-Za-z0-9])' + _escRe(tok) + '($|[^A-Za-z0-9])', flags || '').test(evidence);
}

// -> null when the line passes, else a reason code.
function _lineProblem(line, ctx) {
  ID_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = ID_TOKEN_RE.exec(line))) {
    const tok = m[0];
    if (ctx.foreign.has(tok) && !ctx.allowed.has(tok)) return 'foreign-id';
    if (!ctx.allowed.has(tok) && !_inEvidence(tok, ctx.evidence)) return 'unknown-id';
  }
  TICKET_RE.lastIndex = 0;
  while ((m = TICKET_RE.exec(line))) {
    if (!/\d/.test(m[0])) continue;
    if (!_inEvidence(m[0], ctx.evidence, 'i')) return 'unknown-ticket';
  }
  ETC_DATE_RE.lastIndex = 0;
  while ((m = ETC_DATE_RE.exec(line))) {
    if (!ctx.etcDates.has(_mdOf(m[2]))) return 'unknown-etc-date';
  }
  FACT_DATE_RE.lastIndex = 0;
  while ((m = FACT_DATE_RE.exec(line))) {
    if (!ctx.evidenceDates.has(_mdOf(m[2]))) return 'unknown-date';
  }
  AMOUNT_RE.lastIndex = 0;
  while ((m = AMOUNT_RE.exec(line))) {
    if (!ctx.evidenceAmounts.has(_amountOf(m[1]))) return 'unknown-amount';
  }
  return null;
}

function _amountOf(s) {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? String(n) : '';
}

function _evidenceDates(evidence) {
  const out = new Set();
  EVIDENCE_DATE_RE.lastIndex = 0;
  let m;
  while ((m = EVIDENCE_DATE_RE.exec(evidence))) {
    out.add(m[1] ? (+m[1]) + '/' + (+m[2]) : (+m[3]) + '/' + (+m[4]));
  }
  return out;
}

function _evidenceAmounts(evidence) {
  const out = new Set();
  AMOUNT_RE.lastIndex = 0;
  let m;
  while ((m = AMOUNT_RE.exec(evidence))) out.add(_amountOf(m[1]));
  out.delete('');
  return out;
}

function _field(raw, max, ctx, counter) {
  const s = _clean(raw);
  if (!s) return '';
  const out = [];
  let total = 0;
  for (const line0 of s.split('\n')) {
    const line = line0.trim();
    if (!line) continue;
    if (_lineProblem(line, ctx)) { counter.dropped += 1; continue; }
    if (out.length >= max) break;
    const l = _clip(line, MAX_LINE_CHARS);
    if (total + l.length + (out.length ? 1 : 0) > MAX_FIELD_CHARS) break;
    out.push(l);
    total += l.length + (out.length > 1 ? 1 : 0);
  }
  return out.join('\n');
}

// text -> { ok:true, fasActions, support, dropped } | { ok:false, code:'ai-invalid'|'ai-empty', dropped? }
function validateDraft(text, opts = {}) {
  const obj = extractJsonObject(typeof text === 'string' ? text : '');
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, code: 'ai-invalid' };
  const ctx = {
    allowed: new Set((opts.allowedIds || []).map(String)),
    foreign: new Set((opts.foreignIds || []).map(String)),
    evidence: typeof opts.evidenceText === 'string' ? opts.evidenceText : '',
    etcDates: new Set((opts.etcDates || []).map((d) => (/^\d{4}-/.test(d) ? _md(d) : _mdOf(d))).filter(Boolean)),
  };
  ctx.evidenceDates = _evidenceDates(ctx.evidence);
  ctx.evidenceAmounts = _evidenceAmounts(ctx.evidence);
  const counter = { dropped: 0 };
  const fasActions = _field(obj.fasActions, MAX_LINES.fasActions, ctx, counter);
  const support = _field(obj.support, MAX_LINES.support, ctx, counter);
  if (!fasActions && !support) return { ok: false, code: 'ai-empty', dropped: counter.dropped };
  return { ok: true, fasActions, support, dropped: counter.dropped };
}

// ── Draft one row ───────────────────────────────────────────────────────────
function draftContext({ row, unitRows, built, fleetIds, today } = {}) {
  const r = row || {};
  const prompt = buildDraftPrompt(r, unitRows, built, { today });
  const allowedIds = (r.units || []).map((u) => u.id);
  const own = new Set(allowedIds);
  const foreign = new Set();
  for (const x of (built && built.rows) || []) {
    if (x.key === r.key) continue;
    for (const u of x.units || []) if (!own.has(u.id)) foreign.add(u.id);
  }
  // fleetIds = equipmentIds of every fleet unit OUTSIDE this pair (the IPC layer passes them).
  for (const id of fleetIds || []) if (id && !own.has(String(id))) foreign.add(String(id));
  const etcDates = (r.units || []).map((u) => u.etc && u.etc.date).filter(Boolean);
  return { prompt, allowedIds, foreignIds: [...foreign], evidenceText: prompt, etcDates };
}

function _isTimeout(e) {
  return !!(e && (e.code === 'AI_TIMEOUT' || /timed?\s*out|timeout/i.test(String(e.message || ''))));
}

// -> validated draft | { ok:false, code:'ai-timeout'|'ai-failed'|'ai-invalid'|'ai-empty' }. Never throws.
async function draftRow({ row, unitRows, built, ask, signal, fleetIds, today } = {}) {
  let ctx;
  try {
    ctx = draftContext({ row, unitRows, built, fleetIds, today });
  } catch (_) {
    return { ok: false, code: 'ai-failed' };
  }
  if (typeof ask !== 'function') return { ok: false, code: 'ai-failed' };
  let res;
  try {
    res = await ask(ctx.prompt, signal ? { signal } : {});
  } catch (e) {
    return { ok: false, code: _isTimeout(e) ? 'ai-timeout' : 'ai-failed' };
  }
  const text = (res && typeof res === 'object' && typeof res.text === 'string') ? res.text : (typeof res === 'string' ? res : '');
  try {
    return validateDraft(text, ctx);
  } catch (_) {
    return { ok: false, code: 'ai-invalid' };
  }
}

module.exports = {
  TOTAL_BUDGET, MAX_UNITS, MAX_LINES, MAX_LINE_CHARS, MAX_FIELD_CHARS, TICKET_RE, ETC_DATE_RE,
  buildDraftPrompt, validateDraft, draftContext, draftRow,
};
