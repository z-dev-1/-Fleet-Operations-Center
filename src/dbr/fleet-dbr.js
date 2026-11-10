// Fleet DBR builder — the 24-column DBR (SharePoint DBR_Fleet_Health_<date>.xlsx layout)
// computed from the app's own fleet data. Pure: no I/O, no clock (the caller passes `today`
// as 'YYYY-MM-DD'), no logging. Requires only ./review-engine and crypto.
//
// Grain: one row per (Domicile x SCAC) pair present in the fleet data. Domicile metrics are
// domicile-wide, SCAC metrics are SCAC-wide across all domiciles, and every barrier / ETC
// column is computed from the pair's down units only. "Down" = review-engine.isUnavail, the
// same predicate as the Daily Call engine and the Slack DBR lookup.
//
// Every Y/N, count and Details line comes from a real field value or a verbatim (redacted,
// <= 80 char) snippet. Nothing is guessed: no parsed ETC date => NO ETC.
'use strict';

const crypto = require('crypto');
const engine = require('./review-engine');

const _col = (id, header, editable) => Object.freeze({ id, header, editable: !!editable });

const COLUMNS = Object.freeze([
  _col('fasName', 'FAS Name', true),
  _col('domicile', 'Domicile'),
  _col('domicileUptime', 'Domicile Uptime'),
  _col('domicileDown', 'Domicile Units Down'),
  _col('scac', 'SCAC'),
  _col('scacUptime', 'SCAC Uptime'),
  _col('scacDown', 'SCAC Units Down'),
  _col('vendor1pYN', '1P Vendor Barrier Y/N?'),
  _col('vendor1pDetails', '1P Vendor Barrier \u2014 Details', true),
  _col('oemYN', 'OEM Barrier Y/N?'),
  _col('oemDetails', 'OEM Barrier \u2014 Details', true),
  _col('estimateYN', 'Estimate Barrier Y/N?'),
  _col('estimateDetails', 'Estimate Barrier \u2014 Details', true),
  _col('partnerYN', 'Partner Barrier Y/N?'),
  _col('partnerDetails', 'Partner Barrier \u2014 Details', true),
  _col('partsYN', 'Parts Delay Y/N?'),
  _col('partsDetails', 'Parts Delay \u2014 Details', true),
  _col('commonYN', 'Common Repairs Y/N?'),
  _col('commonDetails', 'Common Repairs \u2014 Details', true),
  _col('etcToday', 'Expected units with ETC for Today', true),
  _col('noEtc', 'NO ETC', true),
  _col('missedEtc', 'Missed ETC', true),
  _col('fasActions', 'FAS Actions', true),
  _col('support', 'Where Do You Need Support?', true),
]);

const EDITABLE_IDS = Object.freeze(COLUMNS.filter((c) => c.editable).map((c) => c.id));

// Common Repairs fires when this many of the pair's down units share a category
// (the user's recorded site-trend rule, review-engine TREND_MIN_UNITS = 3).
const COMMON_REPAIR_MIN = engine.TREND_MIN_UNITS;
// Free-text heuristics read only the N latest dated repairTimeline lines.
const RECENT_TIMELINE_LINES = 3;
const SNIPPET_MAX = 80;
const BLANK = '(BLANK)';

// ── Basic helpers ────────────────────────────────────────────────────────────
const isDown = (row) => engine.isUnavail(row || {});

function uptimePct(total, down) {
  return total ? Math.round(((total - down) / total) * 1000) / 10 : 100;
}
function fmtPct(n) { return String(n) + '%'; }

function _str(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(_str).filter(Boolean).join(', ');
  return String(v);
}
function normCode(v) {
  const s = _str(v).trim().toUpperCase();
  return s || BLANK;
}
function _domicileOf(row) { return normCode((row && (row.domicileSite || row.domicile)) || ''); }
function _scacOf(row) { return normCode(row && row.operator); }
function groupKey(row) { return _domicileOf(row) + '|' + _scacOf(row); }
function _idOf(row) { return _str(row && row.equipmentId).trim() || '(no id)'; }
function _days(row) { return engine.parseDaysOpen(row || {}); }
function _norm(s) { return _str(s).toLowerCase().replace(/\s*_\s*/g, ' ').replace(/\s+/g, ' ').trim(); }
function _codeText(s) { return _str(s).replace(/\s*_\s*/g, ' ').replace(/\s+/g, ' ').trim(); }

const EMAIL_RE = /\S+@\S+\.\S+/g;
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/g;
function _redact(s) { return s.replace(EMAIL_RE, '[redacted]').replace(PHONE_RE, '[redacted]'); }

// Up to 80 chars around a match, single-lined, emails / phone-like runs redacted.
function _snippet(text, index) {
  const t = _str(text);
  const i = Math.max(0, index | 0);
  // Widen to whitespace so an email / phone token is never cut in half before redaction.
  let start = Math.max(0, i - 30);
  while (start > 0 && start > i - 70 && !/\s/.test(t[start - 1])) start -= 1;
  let end = Math.min(t.length, i + 110);
  while (end < t.length && end < i + 150 && !/\s/.test(t[end])) end += 1;
  let s = t.slice(start, end).replace(/\s+/g, ' ').trim();
  s = _redact(s).trim();
  return s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX).trim() : s;
}

// ── Dates ───────────────────────────────────────────────────────────────────
function _pad(n) { return String(n).padStart(2, '0'); }
function _ymdUtc(y, m, d) { return y + '-' + _pad(m) + '-' + _pad(d); }
function _toUtc(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(_str(ymd));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
}
function _validYmd(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const DAY_MS = 86400000;

// M/D[/Y] -> 'YYYY-MM-DD' | null. No year: today's year, shifted -1 when the result is
// > 60 days ahead, +1 when > 300 days behind. Invalid dates (13/02, 2/30) -> null.
function inferDate(m, d, y, today) {
  const mo = parseInt(m, 10);
  const da = parseInt(d, 10);
  const t = _toUtc(today);
  if (!Number.isFinite(mo) || !Number.isFinite(da)) return null;
  if (y != null && y !== '') {
    let yr = parseInt(y, 10);
    if (!Number.isFinite(yr)) return null;
    if (String(y).length <= 2) yr += 2000;
    return _validYmd(yr, mo, da) ? _ymdUtc(yr, mo, da) : null;
  }
  if (!Number.isFinite(t)) return null;
  const yr = new Date(t).getUTCFullYear();
  if (!(mo >= 1 && mo <= 12 && da >= 1 && da <= 31)) return null;
  const ms = Date.UTC(yr, mo - 1, da);
  let cy = yr;
  if (ms - t > 60 * DAY_MS) cy = yr - 1;
  else if (t - ms > 300 * DAY_MS) cy = yr + 1;
  // Validate against the year actually returned (2/29 differs by year).
  return _validYmd(cy, mo, da) ? _ymdUtc(cy, mo, da) : null;
}

function _md(ymd) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? (+m[1]) + '/' + (+m[2]) : '';
}

const TIMELINE_LINE_RE = /^\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*[-\u2013:]\s*(.*)$/;

// repairTimeline -> [{ index, date: 'YYYY-MM-DD'|null, text, raw }] in source order.
function parseTimelineLines(text, today) {
  const out = [];
  const lines = _str(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const m = TIMELINE_LINE_RE.exec(raw);
    const date = m ? inferDate(m[1], m[2], m[3], today) : null;
    out.push({ index: i, date, text: m ? m[4] : raw.trim(), raw });
  }
  return out;
}

function _recentTimeline(row, today) {
  const lines = parseTimelineLines(row.repairTimeline, today);
  const dated = lines.filter((l) => l.date);
  if (!dated.length) return lines.slice(-RECENT_TIMELINE_LINES);
  return dated
    .slice()
    .sort((a, b) => (a.date === b.date ? b.index - a.index : (a.date < b.date ? 1 : -1)))
    .slice(0, RECENT_TIMELINE_LINES);
}

// Current-state free text: notes + canonical fields + the 3 latest dated timeline lines.
function _recentText(row, today) {
  const parts = [row.savedNotes, row.canonicalSituation, row.canonicalNextStep, row.canonicalWaitingOn]
    .map(_str).filter((s) => s.trim());
  for (const l of _recentTimeline(row, today)) parts.push(l.raw.trim());
  return parts.join('\n');
}

// ── ETC parsing (best-effort, never fabricated) ─────────────────────────────
const ETC_SOURCES = Object.freeze(['canonicalNextStep', 'canonicalSituation', 'savedNotes', 'repairTimeline', 'asistNotes']);
const _DATE_TAIL = '[^\\n\\d]{0,25}?(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?';
// ETC / ETR are case-sensitive uppercase so "etc." (et cetera) never matches; bare ETA never counts.
const ETC_TOKEN_POS_RE = new RegExp('\\b(?:ETC|ETR)\\b' + _DATE_TAIL, 'g');
const _ETC_PHRASE = '\\b(?:est(?:\\.|imated)?\\s+(?:time\\s+of\\s+)?completion|expected\\s+completion|completion\\s+(?:date|eta)|repair\\s+eta|eta\\s+(?:for|on)\\s+(?:completion|repair))\\b';
const ETC_PHRASE_POS_RE = new RegExp(_ETC_PHRASE + _DATE_TAIL, 'gi');
const ETC_TOKEN_RE = /\b(?:ETC|ETR)\b/g;
const ETC_PHRASE_RE = new RegExp(_ETC_PHRASE, 'gi');
const NEG_BEFORE_RE = /\b(?:no|without|pending|tbd|unknown|n\/a)\s+(?:an?\s+)?$/i;
const NEG_AFTER_RE = /^\s*[:-]?\s*(?:tbd|pending|unknown|n\/a|none|not (?:yet )?(?:provided|given|available))\b/i;

// All ETC mentions in one text: [{ start, end, negated, date }]. Invalid dates are ignored
// (not negated). A positive match whose ETC/ETR token or ETC phrase ("estimated completion",
// "repair ETA", ...) lies inside a negated span is discarded.
function _etcMentions(text, today) {
  const t = _str(text);
  const neg = [];
  let m;
  for (const re of [ETC_TOKEN_RE, ETC_PHRASE_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(t))) {
      const tokS = m.index;
      const tokE = m.index + m[0].length;
      const before = NEG_BEFORE_RE.exec(t.slice(Math.max(0, tokS - 40), tokS));
      const after = NEG_AFTER_RE.exec(t.slice(tokE));
      if (before || after) {
        neg.push({
          start: before ? tokS - before[0].length : tokS,
          end: after ? tokE + after[0].length : tokE,
          negated: true, date: null,
        });
      }
    }
  }
  const inNeg = (i) => neg.some((n) => i >= n.start && i < n.end);
  const pos = [];
  for (const re of [ETC_TOKEN_POS_RE, ETC_PHRASE_POS_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(t))) {
      if (inNeg(m.index)) continue;
      const date = inferDate(m[1], m[2], m[3], today);
      if (!date) continue;
      pos.push({ start: m.index, end: m.index + m[0].length, negated: false, date });
    }
  }
  return neg.concat(pos).sort((a, b) => a.start - b.start);
}

function _classifyEtc(date, today) {
  if (!date) return 'none';
  if (date === today) return 'today';
  return date < today ? 'missed' : 'future';
}

// -> { state: 'today'|'missed'|'future'|'none', date: 'YYYY-MM-DD'|null, source, snippet }
function parseEtc(row, today) {
  const r = row || {};
  for (const field of ETC_SOURCES) {
    const text = _str(r[field]);
    if (!text.trim()) continue;
    let win = null;
    if (field === 'repairTimeline') {
      // Mention on the latest-dated line wins (ties -> later position); undated lines rank below dated ones.
      for (const line of parseTimelineLines(text, today)) {
        for (const mm of _etcMentions(line.raw, today)) {
          const cand = { m: mm, line, date: line.date, text: line.raw };
          if (!win) { win = cand; continue; }
          const a = cand.date || '';
          const b = win.date || '';
          if (a > b || (a === b && (line.index > win.line.index || (line.index === win.line.index && mm.start > win.m.start)))) win = cand;
        }
      }
    } else {
      const ms = _etcMentions(text, today);
      if (ms.length) win = { m: ms[ms.length - 1], text };
    }
    if (!win) continue;
    const snippet = _snippet(win.text, win.m.start);
    if (win.m.negated) return { state: 'none', date: null, source: field, snippet };
    return { state: _classifyEtc(win.m.date, today), date: win.m.date, source: field, snippet };
  }
  return { state: 'none', date: null, source: null, snippet: '' };
}

// ── Barrier rules (one table; tune here) ────────────────────────────────────
const OEM_VENDOR_RE = /volvo|asist|freightliner|daimler|peterbilt|paccar|kenworth|\bkwne\b|pete_store|\binternational\b|navistar|\bmack\b|dealer/i;
const ONSITE_VENDOR_RE = /amerit|\bta\b|travel\s*centers|\bcox\b|velociti|fleetnet|\bmobile\b|onsite|road\s*ready|goodyear/i;
const VENDOR_REJECT_RE = /\b(reject(ed)?|declin(ed|ing)|unable to (complete|repair|diagnose)|can(no|')t (complete|repair|fix)|not equipped|beyond (scope|capabilit)|refer(red)? (out|to (a )?(dealer|oem|shop))|send(ing)? (it )?to (the )?(dealer|oem))\b/gi;
const REJECT_CONTEXT_EXCLUDE_RE = /estimate|quote|approval|\bPO\b/i;
const ESTIMATE_TEXT_RE = /\b(awaiting|pending|waiting (on|for))\s+(an?\s+)?(estimate|approval)\b/i;
const PARTNER_TEXT_RE = /\b(carrier|dsp)[- ](managed|owned|handling|to (handle|repair))|insurance|adjuster|claim (filed|open|pending)\b/i;
const PARTS_CODE_RE = /parts|sourcing|back ?order/;
const PARTS_TEXT_RE = /back[- ]?order|parts? (delay|on order|eta)|waiting (on|for) parts/i;

const _eq = (a, b) => _str(a).trim().toLowerCase() === b.toLowerCase();

function _vendorRejectWhy(text) {
  VENDOR_REJECT_RE.lastIndex = 0;
  let m;
  while ((m = VENDOR_REJECT_RE.exec(text))) {
    const ctx = text.slice(Math.max(0, m.index - 25), m.index + m[0].length + 25);
    if (REJECT_CONTEXT_EXCLUDE_RE.test(ctx)) continue; // Amazon rejecting an estimate is an Estimate barrier
    return "vendor can't complete: '" + _snippet(text, m.index) + "'";
  }
  return null;
}

function _oemSignal(r, ctx) {
  const status = _str(r.savedRepairStatus).trim();
  if (_eq(status, 'Waiting for vendor') || _eq(status, 'Under diagnosis')) return 'status ' + status;
  if (/no status set by the dealer/i.test(_str(r.offsiteStageDetail))) return 'offsite: ' + _codeText(r.offsiteStageDetail);
  const codes = _norm(r.delayReasonCodes);
  if (codes.includes('tech shortage')) return 'delay code Tech shortage';
  if (codes.includes('waiting for diagnosis')) return 'delay code Waiting for diagnosis';
  if (ctx.daysDown != null && ctx.daysDown >= 14) return ctx.daysDown + 'd down';
  return null;
}

function _partsCodes(raw) {
  const pieces = _str(raw).split(/[,;|\n]/).map(_codeText).filter(Boolean);
  const hit = pieces.filter((p) => PARTS_CODE_RE.test(_norm(p)));
  return (hit.length ? hit : [_codeText(raw)]).join(', ');
}

const BARRIER_RULES = Object.freeze([
  Object.freeze({
    id: 'vendor1p', ynCol: 'vendor1pYN', detailsCol: 'vendor1pDetails',
    test(r, ctx) {
      if (!ONSITE_VENDOR_RE.test(_str(r.vendor))) return null;
      const rej = _vendorRejectWhy(ctx.recentText);
      if (rej) return { why: rej };
      if (_eq(r.savedRepairStatus, 'Waiting for vendor')) return { why: 'status Waiting for vendor' };
      if (_norm(r.delayReasonCodes).includes('tech shortage')) return { why: 'delay code Tech shortage' };
      return null;
    },
  }),
  Object.freeze({
    id: 'oem', ynCol: 'oemYN', detailsCol: 'oemDetails',
    test(r, ctx) {
      const vendor = _str(r.vendor).trim();
      if (!(OEM_VENDOR_RE.test(vendor) || _eq(r.lifecycleReason, 'Offsite Shop Repair'))) return null;
      const signal = _oemSignal(r, ctx);
      if (!signal) return null;
      return { why: 'at OEM/dealer ' + (vendor || 'no vendor') + ': ' + signal };
    },
  }),
  Object.freeze({
    id: 'estimate', ynCol: 'estimateYN', detailsCol: 'estimateDetails',
    test(r, ctx) {
      const cost = parseFloat(_str(r.estimatePendingCost).replace(/[$,\s]/g, ''));
      if (Number.isFinite(cost) && cost > 0) return { why: 'estimate pending $' + cost };
      const status = _str(r.savedRepairStatus).trim();
      if (_eq(status, 'Awaiting estimate') || _eq(status, 'Awaiting approval')) return { why: 'status ' + status };
      if (_eq(r.serviceState, 'Estimate rejected')) return { why: 'estimate rejected' };
      if (_eq(r.offsiteStage, 'approval')) return { why: 'offsite stage approval' };
      const esc = _str(r.escalations).trim();
      if (/estimate/i.test(esc)) return { why: 'escalation ' + _snippet(esc, esc.search(/estimate/i)) };
      const m = ESTIMATE_TEXT_RE.exec(ctx.recentText);
      if (m) return { why: "'" + _snippet(ctx.recentText, m.index) + "'" };
      return null;
    },
  }),
  Object.freeze({
    id: 'partner', ynCol: 'partnerYN', detailsCol: 'partnerDetails',
    test(r, ctx) {
      const vendor = _str(r.vendor).trim();
      if (/^dsp[_ ]?entered$/i.test(vendor)) return { why: 'DSP-entered (carrier-managed)' };
      if (/\bcei\b/i.test(vendor)) return { why: 'CEI (accident/claims managed)' };
      if (_eq(r.lifecycleReason, 'Accident')) return { why: 'Accident (carrier/insurance owned)' };
      const m = PARTNER_TEXT_RE.exec(ctx.recentText);
      if (m) return { why: "'" + _snippet(ctx.recentText, m.index) + "'" };
      return null;
    },
  }),
  Object.freeze({
    id: 'parts', ynCol: 'partsYN', detailsCol: 'partsDetails',
    test(r, ctx) {
      const whys = [];
      if (PARTS_CODE_RE.test(_norm(r.delayReasonCodes))) whys.push('delay code ' + _partsCodes(r.delayReasonCodes));
      const status = _str(r.savedRepairStatus).trim();
      if (/parts ordered|back ?order/i.test(status)) whys.push('status ' + status);
      if (_eq(r.lifecycleReason, 'Parts Delay')) whys.push('lifecycle Parts Delay');
      const detail = _str(r.offsiteStageDetail);
      if (/parts/i.test(detail)) whys.push('offsite: ' + _snippet(detail, detail.search(/parts/i)));
      const m = PARTS_TEXT_RE.exec(ctx.recentText);
      if (m) whys.push("'" + _snippet(ctx.recentText, m.index) + "'");
      return whys.length ? { why: whys.join('; ') } : null;
    },
  }),
]);

// One down unit -> { [ruleId]: { why } | null }
function classifyBarriers(row, ctx = {}) {
  const r = row || {};
  const c = {
    today: ctx.today,
    daysDown: ctx.daysDown !== undefined ? ctx.daysDown : _days(r),
    recentText: ctx.recentText !== undefined ? ctx.recentText : _recentText(r, ctx.today),
  };
  const out = {};
  for (const rule of BARRIER_RULES) out[rule.id] = rule.test(r, c) || null;
  return out;
}

// ── Common Repairs ──────────────────────────────────────────────────────────
function _unitCategories(r) {
  const cats = new Set();
  const text = _str(r.issueSummary) + ' ' + _str(r.issueDetails);
  for (const [label, re] of engine.TREND_TERMS) if (re.test(text)) cats.add(label);
  const lr = _str(r.lifecycleReason).trim();
  if (/^damaged/i.test(lr)) cats.add('Damage repair');
  if (_eq(lr, 'Accident')) cats.add('Accident');
  if (_eq(lr, 'Expired Inspection')) cats.add('Expired inspection');
  return cats;
}

// Down rows of one pair -> { yn, details, common: [{ label, ids }] }
function commonRepairs(downRows) {
  const byLabel = new Map();
  for (const r of downRows || []) {
    const id = _idOf(r);
    for (const label of _unitCategories(r)) {
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(id);
    }
  }
  const common = [...byLabel.entries()]
    .filter(([, ids]) => ids.length >= COMMON_REPAIR_MIN)
    .map(([label, ids]) => ({ label, ids: ids.slice().sort() }))
    .sort((a, b) => b.ids.length - a.ids.length || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return {
    yn: common.length ? 'Y' : 'N',
    details: common.map((c) => c.label + ' \u2014 ' + c.ids.length + ' units: ' + c.ids.join(', ')).join('\n'),
    common,
  };
}

// ── Guards / hashing ────────────────────────────────────────────────────────
// Units NOT counted as down whose other status signals say otherwise (shown, not counted).
function statusConflicts(rows) {
  const out = [];
  for (const r of rows || []) {
    if (!r || isDown(r)) continue;
    const signals = [];
    if (/unavail|out of service|down/i.test(_str(r.canonicalAvailability))) signals.push('canonicalAvailability=' + _str(r.canonicalAvailability).trim());
    if (/out of service|offsite|in repair/i.test(_str(r.serviceState))) signals.push('serviceState=' + _str(r.serviceState).trim());
    if (/out of service|offsite|in repair/i.test(_str(r.subState))) signals.push('subState=' + _str(r.subState).trim());
    if (signals.length) out.push({ id: _idOf(r), signals });
  }
  return out;
}

// sha1 over the pair's down fleet rows (order-independent). Drafts store it to detect staleness.
function unitsHash(downRows) {
  const parts = (downRows || []).map((r) => [
    _idOf(r), _str(r.lifecycleReason).trim(), _str(r.vendor).trim(),
    _str(r.savedRepairStatus).trim(), _str(r.serviceState).trim(),
  ].join(':')).sort();
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

// ── Builder ─────────────────────────────────────────────────────────────────
function _stats(total, down) { return { total, down, uptime: uptimePct(total, down) }; }
function _byDaysThenId(a, b) {
  const da = a.daysDown == null ? -1 : a.daysDown;
  const db = b.daysDown == null ? -1 : b.daysDown;
  if (da !== db) return db - da;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function _detailLine(u, why) {
  const v = u.vendor || 'no vendor';
  return u.id + ' (' + v + (u.daysDown == null ? '' : ', ' + u.daysDown + 'd') + '): ' + why;
}
function _countCell(ids) { return ids.length ? ids.length + ' \u2014 ' + ids.join(', ') : '0'; }

function buildFleetDbr(rows, opts = {}) {
  const today = opts.today;
  const fasName = typeof opts.fasName === 'string' ? opts.fasName : '';
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const dom = new Map();
  const scac = new Map();
  const pairs = new Map();
  let downCount = 0;
  const bump = (map, k) => { if (!map.has(k)) map.set(k, { total: 0, down: 0 }); return map.get(k); };
  for (const r of list) {
    const d = _domicileOf(r);
    const s = _scacOf(r);
    const key = d + '|' + s;
    const down = isDown(r);
    if (down) downCount += 1;
    for (const g of [bump(dom, d), bump(scac, s)]) { g.total += 1; if (down) g.down += 1; }
    if (!pairs.has(key)) pairs.set(key, { key, domicile: d, scac: s, total: 0, down: 0, downRows: [] });
    const p = pairs.get(key);
    p.total += 1;
    if (down) { p.down += 1; p.downRows.push(r); }
  }

  const out = [];
  for (const p of pairs.values()) {
    const ds = dom.get(p.domicile);
    const ss = scac.get(p.scac);
    const domicileStats = _stats(ds.total, ds.down);
    const scacStats = _stats(ss.total, ss.down);
    const details = {};
    const hits = {};
    for (const rule of BARRIER_RULES) { details[rule.id] = []; hits[rule.id] = false; }
    const etcBuckets = { today: [], missed: [], none: [] };
    const units = p.downRows.map((r) => {
      const daysDown = _days(r);
      const b = classifyBarriers(r, { today, daysDown });
      const etc = parseEtc(r, today);
      return {
        id: _idOf(r), daysDown,
        lifecycleReason: _str(r.lifecycleReason).trim(), vendor: _str(r.vendor).trim(),
        status: _str(r.savedRepairStatus).trim(), serviceState: _str(r.serviceState).trim(),
        etc, barriers: BARRIER_RULES.filter((x) => b[x.id]).map((x) => x.id),
        categories: [..._unitCategories(r)], _why: b,
      };
    }).sort(_byDaysThenId);
    for (const u of units) {
      for (const rule of BARRIER_RULES) {
        const hit = u._why[rule.id];
        if (hit) { hits[rule.id] = true; details[rule.id].push(_detailLine(u, hit.why)); }
      }
      if (u.etc.state === 'today') etcBuckets.today.push(u.id);
      else if (u.etc.state === 'missed') etcBuckets.missed.push(u.id + ' (ETC ' + _md(u.etc.date) + ')');
      else if (u.etc.state === 'none') etcBuckets.none.push(u.id);
      delete u._why;
    }
    const common = commonRepairs(p.downRows);
    const cells = {
      fasName,
      domicile: p.domicile,
      domicileUptime: fmtPct(domicileStats.uptime),
      domicileDown: String(domicileStats.down),
      scac: p.scac,
      scacUptime: fmtPct(scacStats.uptime),
      scacDown: String(scacStats.down),
      commonYN: common.yn,
      commonDetails: common.details,
      etcToday: _countCell(etcBuckets.today),
      noEtc: _countCell(etcBuckets.none),
      missedEtc: _countCell(etcBuckets.missed),
      fasActions: '',
      support: '',
    };
    for (const rule of BARRIER_RULES) {
      cells[rule.ynCol] = hits[rule.id] ? 'Y' : 'N';
      cells[rule.detailsCol] = details[rule.id].join('\n');
    }
    out.push({
      key: p.key, domicile: p.domicile, scac: p.scac,
      pair: { total: p.total, down: p.down }, domicileStats, scacStats,
      cells, units, unitsHash: unitsHash(p.downRows),
    });
  }

  out.sort((a, b) => (a.domicileStats.uptime - b.domicileStats.uptime)
    || (a.domicile < b.domicile ? -1 : a.domicile > b.domicile ? 1 : 0)
    || (b.pair.down - a.pair.down)
    || (a.scac < b.scac ? -1 : a.scac > b.scac ? 1 : 0));

  return { day: today, fleetCount: list.length, downCount, rows: out, conflicts: statusConflicts(list) };
}

// ── Overlays -> view model ──────────────────────────────────────────────────
// Precedence per cell: user edit > AI draft (fasActions/support only) > computed.
// FAS Name default per row: rosterFas[key] -> resolved user name -> ''.
// The caller passes edits already filtered to today.
function applyOverlays(built, overlays = {}) {
  const b = built || {};
  const edits = _plain(overlays.edits);
  const drafts = _plain(overlays.drafts);
  const roster = _plain(overlays.rosterFas);
  const override = _str(overlays.fasNameOverride).trim();
  const email = _str(overlays.emailFasName).trim();
  const fasName = override || email || '';
  const fasNameSource = override ? 'panel' : (email ? 'email-intel' : 'none');

  const rows = (b.rows || []).map((row) => {
    const rosterName = _str(roster[row.key]).trim();
    const fasSource = rosterName ? 'roster' : (fasName ? 'you' : 'none');
    const base = Object.assign({}, row.cells, { fasName: rosterName || fasName });
    const source = {};
    for (const c of COLUMNS) source[c.id] = 'computed';
    const d = _plain(drafts[row.key]);
    const hasDraft = Object.keys(d).length > 0;
    if (hasDraft) {
      for (const id of ['fasActions', 'support']) {
        if (typeof d[id] === 'string' && d[id]) { base[id] = d[id]; source[id] = 'ai'; }
      }
    }
    const cells = Object.assign({}, base);
    const e = _plain(edits[row.key]);
    for (const id of EDITABLE_IDS) {
      if (typeof e[id] === 'string') { cells[id] = e[id]; source[id] = 'edit'; }
    }
    const draft = hasDraft
      ? { state: d.unitsHash === row.unitsHash ? 'ok' : 'stale', draftedAt: d.draftedAt || null }
      : { state: 'none', draftedAt: null };
    return Object.assign({}, row, { cells, base, source, draft, fasSource, rosterFas: rosterName });
  });

  return {
    day: b.day || overlays.today || null,
    fleetCount: b.fleetCount || 0,
    downCount: b.downCount || 0,
    conflicts: b.conflicts || [],
    builtAt: b.builtAt || null,
    fleetSyncedAt: b.fleetSyncedAt || null,
    columns: COLUMNS,
    fasName, fasNameSource,
    flags: { aiDraft: !!(overlays.flags && overlays.flags.aiDraft) },
    rows,
  };
}
function _plain(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

module.exports = {
  COLUMNS, EDITABLE_IDS, BARRIER_RULES, COMMON_REPAIR_MIN, RECENT_TIMELINE_LINES,
  OEM_VENDOR_RE, ONSITE_VENDOR_RE,
  isDown, uptimePct, fmtPct, groupKey, normCode, parseTimelineLines, inferDate, parseEtc,
  classifyBarriers, commonRepairs, statusConflicts, buildFleetDbr, applyOverlays, unitsHash,
};
