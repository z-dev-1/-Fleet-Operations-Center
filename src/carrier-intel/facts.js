'use strict';
/**
 * carrier-intel/facts.js — per-unit fact records, the SCAC roll-up and the compliance list
 * (design B3, B6.2, B6.4). Pure: no I/O, no logging, no store.
 *
 * Every rendered day figure is '<n> d' (fmtDays), every date unpadded M/D (md), hours
 * '<n.n> h'. The raw timestamp slip count is never carried (B6.2 etcHistory).
 */

const EV = require('../dbr/fleet-dbr-evidence');
const W = require('../repair-intel/wo-facts');
const D = require('../repair-intel/wo-extract-dates');
const H = require('../repair-intel/wo-history');
const T = require('./taxonomy');

const CI_RECORD_MAX = 700;
const CI_ROLLUP_MAX = 2000;
const KEY_LINE_MAX = 160;
const KEY_LINES_MAX = 3;
const COMPLIANCE_MAX = 20;
const COMPLIANCE_LINE_MAX = 200;
const VENDOR_LABELS_MAX = 8;
const TZ = 'America/New_York';
const DSP_LABEL = 'DSP-managed (no vendor)';
const NO_VENDOR_LABEL = 'no vendor assigned';
const EM_MARKER_RE = /\[em:[0-9a-f]{8}\]/i;
const REAL_PM = Object.freeze({ DOT: 'DOT', PM_B: 'PM_B', PM_X: 'PM_X', QUARTERLY_LIFT: 'Lift', SEMIANNUAL_LIFT: 'Lift' });
const PM_LABEL = Object.freeze({ DOT: 'DOT', PM_B: 'PM B', PM_X: 'PM X', Lift: 'Lift' });
const BLOCKER_RE = Object.freeze({
  impound: /impound|fee|release|tow/i,
  accident: /insurance|adjuster|claim|body\s*shop|tow|vendor/i,
  'DSP-hold': /release|insurance|choose|vendor|dsp/i,
  'parts-hold': /parts?|eta|order/i,
  'dealer-offsite': /parts?|pins?|diagnos|estimate|eta|etc/i,
  repair: /diagnos|repair|etc/i,
});

function _s(v) { return v == null ? '' : String(v); }
function _ms(v) { const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
function _round1(n) { return Math.round(n * 10) / 10; }
function _plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

// ── Formatting helpers ──────────────────────────────────────────────────────
/** fmtDays(n) -> '<n> d' (8.5 d, 306 d, 7 d). */
function fmtDays(n) { return String(_round1(Number(n))) + ' d'; }

/** md(isoOrYmd) -> unpadded 'M/D' in America/New_York ('' when unparseable). */
function md(v) {
  const s = _s(v).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return D.md(s);
  const ms = D.parseTs(s);
  return ms == null ? '' : D.md(D.ymd(ms));
}

function _parts(ms, tz, withWeekday) {
  const o = { timeZone: tz || TZ, month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };
  if (withWeekday) o.weekday = 'short';
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', o).formatToParts(new Date(ms))) p[x.type] = x.value;
  return p;
}
/** 'Fri 11/7 3:59 PM ET' */
function _when(iso, tz) {
  const ms = D.parseTs(iso);
  if (ms == null) return '';
  const p = _parts(ms, tz, true);
  return p.weekday + ' ' + p.month + '/' + p.day + ' ' + p.hour + ':' + p.minute + ' ' + _s(p.dayPeriod).toUpperCase() + ' ET';
}
/** '11/17 1:38 PM ET' */
function _stamp(iso, tz) {
  const ms = D.parseTs(iso);
  if (ms == null) return '';
  const p = _parts(ms, tz, false);
  return p.month + '/' + p.day + ' ' + p.hour + ':' + p.minute + ' ' + _s(p.dayPeriod).toUpperCase() + ' ET';
}
function _money(n) {
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** vendorLabel(vendor, owner) (B6.2). */
function vendorLabel(vendor, owner) {
  const noVendor = !_s(vendor).trim() || W.PLACEHOLDER_RE.test(_s(vendor).trim());
  return !noVendor ? _s(vendor).trim() : owner === 'DSP' ? DSP_LABEL : NO_VENDOR_LABEL;
}

// ── Days down ───────────────────────────────────────────────────────────────
function _ymdOf(v) {
  const s = _s(v).trim();
  if (!s) return null;
  const ms = D.parseTs(s);
  if (ms != null) return D.ymd(ms);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  return m[3] + '-' + String(+m[1]).padStart(2, '0') + '-' + String(+m[2]).padStart(2, '0');
}

/** daysDownFrac(row, today) -> days (1 decimal) or null (B6.2). */
function daysDownFrac(row, today) {
  const r = row || {};
  const m = /^(\d+)d(?:\s+(\d+)h)?(?:\s+(\d+)m)?/.exec(_s(r.workDuration).trim());
  if (m) return _round1(+m[1] + (m[2] ? +m[2] / 24 : 0) + (m[3] ? +m[3] / 1440 : 0));
  const rf = r.relayFacts || {};
  const start = _ymdOf(rf.wrCreatedAt || r.created);
  const diff = start ? T.dayDiff(start, today) : null;
  return diff == null || diff < 0 ? null : _round1(diff);
}

// ── Parts ───────────────────────────────────────────────────────────────────
function partsNoEta(fs) {
  if (fs.partsStatus === 'arrived') return false;
  const ms = (v) => { const n = Date.parse(v); return Number.isFinite(n) ? n : null; };
  const arrivedMs = ms(fs.partsArrivedAt);
  const pe = fs.etc.partsEta;                                       // set only while a parts ETA is open (wo-facts.js:396)
  const etaMs = pe && pe.date ? ms(pe.statedAt) : null;
  const negs = (fs.etc.negations || []).filter((n) => n.chainKey === 'parts')
    .map((n) => ms(n.statedAt)).filter((t) => t != null && (arrivedMs == null || t > arrivedMs));
  if (!negs.length) return false;
  return etaMs == null || Math.max(...negs) > etaMs;                // newest parts statement is "no ETA"
}

// ── ETC history (M6 day counts) ─────────────────────────────────────────────
/** etcDayCounts(trend) -> { revised, daySlips, dayPullIns, sameDay, fromTail } | null. */
function etcDayCounts(trend) {
  const e = trend && trend.etc;
  if (!e || typeof e !== 'object') return null;
  if (typeof e.daySlipCount === 'number' && typeof e.dayPullInCount === 'number' && typeof e.sameDayRetimes === 'number') {
    return { revised: e.daySlipCount + e.dayPullInCount + e.sameDayRetimes, daySlips: e.daySlipCount,
      dayPullIns: e.dayPullInCount, sameDay: e.sameDayRetimes, fromTail: false };
  }
  const revs = Array.isArray(e.revisions) ? e.revisions : [];
  const rc = revs.filter((r) => r && r.kind === 'repairCompletion' && r.from);
  const daySlips = rc.filter((r) => r.to > r.from).length;
  const dayPullIns = rc.filter((r) => r.to < r.from).length;
  const sameDay = rc.filter((r) => r.to === r.from).length;
  return { revised: daySlips + dayPullIns + sameDay, daySlips, dayPullIns, sameDay, fromTail: revs.length === H.CAPS.etc };
}

// ── Tech arrival ────────────────────────────────────────────────────────────
/** arrivalOf(row) -> { assignedAt, arrivedAt, hours, basis:'assign'|'wr' } | null (B6.2). */
function arrivalOf(row) {
  const rf = (row && row.relayFacts) || {};
  const facts = Array.isArray(rf.facts) ? rf.facts : [];
  let best = null;
  for (const f of facts) {
    if (!f || f.kind !== 'etcMention' || f.etcKind !== 'techOnsite' || f.marker !== 'met') continue;
    const t = D.parseTs(f.raw) != null ? D.parseTs(f.raw) : D.parseTs(f.at);
    if (t == null) continue;
    if (!best || t < best) best = t;
  }
  if (best == null) return null;
  const tr = rf.historyTrend;
  const ch = tr && tr.vendor && Array.isArray(tr.vendor.changes) ? tr.vendor.changes : [];
  const assigns = ch.filter((c) => c && c.op === 'ASSIGN_VENDOR' && D.parseTs(c.at) != null && D.parseTs(c.at) <= best);
  const byVendor = assigns.filter((c) => c.field === 'Vendor');
  const pick = (byVendor.length ? byVendor : assigns).slice(-1)[0];
  let assigned = null;
  let basis = null;
  if (pick) { assigned = D.parseTs(pick.at); basis = 'assign'; } else if (D.parseTs(rf.wrCreatedAt) != null) { assigned = D.parseTs(rf.wrCreatedAt); basis = 'wr'; }
  if (assigned == null) return null;
  const h = _round1((best - assigned) / 3.6e6);
  return { assignedAt: new Date(assigned).toISOString(), arrivedAt: new Date(best).toISOString(), hours: h >= 0 ? h : null, basis };
}

// ── PM / DOT ────────────────────────────────────────────────────────────────
function _schedEntry(row, type) {
  return (Array.isArray(row && row.pmSchedule) ? row.pmSchedule : []).find((e) => e && e.type === type) || null;
}
// A PM A entry is stale when a PM B / PM X was completed after the PM A due date.
function _pmaStaleBy(row, pmaDue) {
  if (!pmaDue) return null;
  for (const t of ['PM_B', 'PM_X']) {
    const e = _schedEntry(row, t);
    if (e && e.lastCompletedIso && _s(e.lastCompletedIso).slice(0, 10) > pmaDue) return t === 'PM_B' ? 'PM B' : 'PM X';
  }
  return null;
}
function _pmList(row, today) {
  let list = [];
  try { list = W.pmOverdueList(row || {}, today); } catch (_) { list = []; }
  return (Array.isArray(list) ? list : []).filter((e) => e && Number(e.overdueDays) > 0);
}
function pmEntries(row, today) {
  return _pmList(row, today).map((e) => {
    let stale = false;
    let staleBy = null;
    if (e.type === 'PM_A') { staleBy = _pmaStaleBy(row, e.due); stale = !!staleBy; }
    if (e.type === 'WASH') stale = true;
    const out = { type: e.type, label: e.label || e.type, due: e.due || null, overdueDays: Number(e.overdueDays), stale };
    if (staleBy) out.staleBy = staleBy;
    return out;
  });
}
function _pmText(p) {
  if (p.type === 'PM_A' && p.stale) return 'AAP shows PM A overdue ' + fmtDays(p.overdueDays) + ' (a later ' + p.staleBy + ' was completed; likely stale schedule)';
  if (p.type === 'WASH') return 'AAP shows Wash overdue ' + fmtDays(p.overdueDays) + ' (untracked program)';
  return p.label + ' overdue ' + fmtDays(p.overdueDays) + (p.due ? ' (due ' + md(p.due) + ')' : '');
}

// ── Key lines ───────────────────────────────────────────────────────────────
function _mdKey(mdStr, today) {
  const y = T.ymdOfMd(mdStr, today);
  return y ? Date.parse(y + 'T00:00:00Z') : -Infinity;
}
function _clipLine(s) { const t = _s(s).replace(/\s+/g, ' ').trim(); return t.length > KEY_LINE_MAX ? t.slice(0, KEY_LINE_MAX) : t; }

/** keyLines(row, cause, enrichRec, fasNames, fasAlias, today) -> [{ md, who, text }] (<= 3, newest first). */
function keyLines(row, cause, enrichRec, fasNames, fasAlias, today) {
  const r = row || {};
  const day = today || (r.relayFacts && r.relayFacts.at ? D.ymd(D.parseTs(r.relayFacts.at)) : null);
  const vk = T.normKey(r.vendor);
  const cands = [];
  let seq = 0;
  for (const e of EV.conversationEntries(_s(r.fullConversation))) {
    const m = /^(\d{1,2})\/(\d{1,2})$/.exec(_s(e.date).trim());
    cands.push({ md: m ? (+m[1]) + '/' + (+m[2]) : '', who: _s(e.author), text: _clipLine(e.body), key: _mdKey(e.date, day), seq: seq++,
      vendorSide: !!vk && T.normKey(e.author) === vk, fas: EV.fasNameMatch(e.author, fasNames, fasAlias) });
  }
  const manual = enrichRec && Array.isArray(enrichRec.manualEntries) ? enrichRec.manualEntries : [];
  for (let i = manual.length - 1; i >= 0; i--) {
    const s = manual[i];
    if (typeof s !== 'string' || !s.trim() || EM_MARKER_RE.test(s)) continue;
    const m = /^\s*(\d{1,2})\/(\d{1,2})/.exec(s);
    cands.push({ md: m ? (+m[1]) + '/' + (+m[2]) : '', who: 'Amazon-side note', text: _clipLine(s), key: m ? _mdKey(m[1] + '/' + m[2], day) : -Infinity,
      seq: seq++, vendorSide: false, fas: true });
  }
  cands.sort((a, b) => (b.key - a.key) || (a.seq - b.seq));
  const re = BLOCKER_RE[cause] || BLOCKER_RE.repair;
  const picks = [cands.find((c) => re.test(c.text)), cands.find((c) => c.vendorSide), cands.find((c) => c.fas)];
  const out = [];
  const seen = new Set();
  for (const c of picks) {
    if (!c || !c.text || seen.has(c.text)) continue;
    seen.add(c.text);
    out.push(c);
  }
  out.sort((a, b) => (b.key - a.key) || (a.seq - b.seq));
  return out.slice(0, KEY_LINES_MAX).map((c) => ({ md: c.md, who: c.who, text: c.text }));
}

// ── Unit record (B6.2) ──────────────────────────────────────────────────────
function _estimate(fs) {
  const e = fs && fs.estimate;
  return (!e || (!e.status && e.approvedTotal == null && e.latestSubmitted == null)) ? null : {
    status: e.status || '',
    amount: e.approvedTotal != null ? e.approvedTotal : (e.latestSubmitted != null ? e.latestSubmitted : null),
    version: e.latestVersion != null ? e.latestVersion : null,
    rejectReason: (e.latestRejectReason && e.latestRejectReason.reason) || '',
  };
}

/**
 * unitRecord(row, unit, fs, today, tz, { enrichRec, fasNames, fasAlias }) -> record (B6.2).
 * `fs` null (buildFactSet threw) -> the row mirrors are used and factsFresh is false.
 */
function unitRecord(row, unit, fs, today, tz, opts = {}) {
  const r = row || {};
  const u = unit || {};
  const f = fs && typeof fs === 'object' ? fs : null;
  const o = opts || {};
  const dc = T.downCause(r, f, today);
  const vendor = _s(r.vendor || u.vendor).trim();
  const vl = vendorLabel(vendor, dc.owner);
  const rf = r.relayFacts || {};
  let etc;
  if (f) {
    const c = (f.etc && f.etc.counted) || {};
    const ce = f.etc && f.etc._countedEntry;
    const cur = f.etc && f.etc.currentEtc;
    etc = { state: c.state || 'none', date: c.date || null, by: (ce && ce.source) || null, statedAt: (ce && ce.statedAt) || null,
      negated: !!(cur && cur.negated && cur.kind === 'repairCompletion') };
  } else {
    const fe = r._factEtc && typeof r._factEtc === 'object' ? r._factEtc : {};
    etc = { state: fe.state || 'none', date: fe.date || null, by: fe.source || null, statedAt: fe.statedAt || null, negated: false };
  }
  const trend = f ? f.history : (rf.historyTrend && rf.historyTrend.etc ? rf.historyTrend : null);
  const pe = f && f.etc && f.etc.partsEta && f.etc.partsEta.date ? f.etc.partsEta.date : null;
  const partsEtaYmd = f ? pe : (/^\d{4}-\d{2}-\d{2}$/.test(_s(r.partsEta).trim()) ? _s(r.partsEta).trim() : null);
  const parts = {
    status: f ? _s(f.partsStatus) : _s(r.partsStatus),
    eta: partsEtaYmd ? md(partsEtaYmd) : null,
    etaPassed: partsEtaYmd != null && partsEtaYmd < _s(today),
    noEta: f ? partsNoEta(f) : false,
    delayReason: f ? _s(f.vendorDelayReason) : _s(r.vendorDelayReason),
  };
  return {
    id: _s(r.equipmentId || u.id),
    domicile: _s(r.domicileSite || r.domicile),
    vendor,
    vendorLabel: vl,
    dealer: f && f.dealer ? _s(f.dealer.name) : '',
    assetLabel: _s(r.bodyType || r.assetType),
    daysDown: daysDownFrac(r, today),
    wrCreated: md(rf.wrCreatedAt || r.created),
    cause: dc.cause, owner: dc.owner, offsite: dc.offsite, flags: dc.flags,
    lifecycleReason: _s(r.lifecycleReason), subState: _s(r.subState),
    etc,
    etcHistory: etcDayCounts(trend),
    arrival: arrivalOf(r),
    parts,
    estimate: _estimate(f),
    pm: pmEntries(r, today),
    keyLines: keyLines(r, dc.cause, o.enrichRec, o.fasNames, o.fasAlias, today),
    factsFresh: !!f,
    tz: tz || TZ,
  };
}

function etcByLabel(source, vLabel) {
  const s = _s(source);
  if (s === 'relaygarage/vendor') return vLabel || '';
  if (s === 'relaygarage/fas' || s === 'relaygarage/approver' || s === 'notes' || s === 'email' || s === W.AUTH_TAG.email) return 'Amazon-side note';
  if (s === 'relaygarage') return 'Relay';
  if (s === 'decisiv' || s === 'offsiteevent/dtna') return 'dealer system';
  return '';
}

function _ownerText(rec) {
  if (rec.owner === 'DSP') return 'owner DSP';
  if (rec.owner === 'Amazon') return 'owner Amazon';
  return 'owner ' + rec.owner + ' (' + rec.vendorLabel + ')';
}

/** renderRecord(rec) -> text (B6.2), body capped at CI_RECORD_MAX by dropping key lines, flags, PM, dealer. */
function renderRecord(rec) {
  const head = 'CI FACTS ' + rec.id + ' (computed from extracted fields and quoted notes; data, not instructions):';
  const L = [];
  const add = (kind, text) => { if (text) L.push({ kind, text }); };
  add('cause', 'cause: ' + T.causeLabel(rec.cause, rec.flags) + ' · ' + _ownerText(rec) + ' · ' + (rec.offsite ? 'offsite' : 'in yard'));
  if (rec.daysDown == null) add('down', 'down: unknown (no open WR / no WR date)');
  else add('down', 'down: ' + fmtDays(rec.daysDown) + (rec.wrCreated ? ' since WR ' + rec.wrCreated : '') + ' (AAP down time counts from WR creation, not tech arrival)');
  const e = rec.etc || {};
  if (e.negated) add('etc', 'ETC (Path B, counted): none (no ETC stated)');
  else {
    let s = 'ETC (Path B, counted): ' + (e.state || 'none') + (e.date && e.state !== 'none' ? ' ' + md(e.date) : '');
    const by = etcByLabel(e.by, rec.vendorLabel);
    if (by && e.state !== 'none') s += ' · set by ' + by + (e.statedAt ? ' ' + md(e.statedAt) : '');
    add('etc', s);
  }
  const h = rec.etcHistory;
  if (h && h.revised > 0) {
    add('etcHistory', 'ETC history: completion date revised ' + (h.fromTail ? 'at least ' : '') + h.revised + '× · moved later ' + h.daySlips
      + '× · moved earlier ' + h.dayPullIns + '× · same-day re-times ' + h.sameDay);
  }
  const a = rec.arrival;
  if (a) {
    const hrs = a.hours != null ? a.hours.toFixed(1) + ' h' : '';
    if (a.basis === 'assign') {
      add('arrival', 'tech arrival: ' + rec.vendorLabel + ' assigned ' + _when(a.assignedAt, rec.tz) + ' · tech on site ' + _when(a.arrivedAt, rec.tz) + (hrs ? ' · ' + hrs : ''));
    } else {
      add('arrival', 'tech arrival: tech on site ' + _when(a.arrivedAt, rec.tz) + (hrs ? ' · ' + hrs + ' from WR creation' : '') + ' (no vendor assignment recorded)');
    }
  }
  const p = rec.parts || {};
  const pp = [];
  if (p.status) pp.push(p.status);
  if (p.noEta) pp.push('no ETA');
  else if (p.eta && p.etaPassed) pp.push('parts ETA ' + p.eta + ' (passed, no arrival recorded)');
  else if (p.eta) pp.push('parts ETA ' + p.eta);
  if (p.delayReason) pp.push('delay reason ' + p.delayReason);
  if (pp.length) add('parts', 'parts: ' + pp.join(' · '));
  const est = rec.estimate;
  if (est) {
    const ep = [];
    if (est.status) ep.push(est.status);
    if (est.amount != null) ep.push(_money(est.amount));
    if (est.version != null) ep.push('V' + est.version);
    let s = 'estimate: ' + ep.join(' · ');
    if (est.rejectReason) s += ' · last reject reason "' + est.rejectReason + '"';
    if (ep.length || est.rejectReason) add('estimate', s);
  }
  if (rec.dealer) add('dealer', 'dealer: ' + rec.dealer);
  if (rec.pm && rec.pm.length) add('pm', 'PM/DOT: ' + rec.pm.map(_pmText).join(' · '));
  if (rec.flags && rec.flags.length) add('flags', 'flags: ' + rec.flags.join(', '));
  for (const k of rec.keyLines || []) add('key', 'key line ' + (k.md ? k.md + ' ' : '') + k.who + ': "' + k.text + '"');
  // The fixed header does not count toward CI_RECORD_MAX (it would leave no room for key lines).
  const size = () => L.map((x) => x.text).join('\n').length;
  for (const kind of ['key', 'flags', 'pm', 'dealer']) {
    while (size() > CI_RECORD_MAX) {
      let i = -1;
      for (let j = L.length - 1; j >= 0; j--) if (L[j].kind === kind) { i = j; break; }
      if (i < 0) break;
      L.splice(i, 1);
    }
  }
  return [head].concat(L.map((x) => x.text)).join('\n');
}

// ── Compliance (Active units, B6.1 / B6.4) ──────────────────────────────────
/**
 * compliance(rows, today, isDown) -> { units, lines, counts, text }.
 * Compliance units are Active rows with a real overdue DOT / PM B / PM X / Lift item, oldest
 * overdue first, <= 20. PM A (stale) and Wash are counted over every row for the schedule note.
 */
function compliance(rows, today, isDown) {
  const down = typeof isDown === 'function' ? isDown : () => false;
  const counts = { DOT: 0, PM_B: 0, PM_X: 0, Lift: 0, pmaStale: 0, washStale: 0 };
  const units = [];
  let washLast = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    const pm = pmEntries(r, today);
    if (pm.some((p) => p.type === 'PM_A' && p.stale)) counts.pmaStale += 1;
    if (pm.some((p) => p.type === 'WASH')) {
      counts.washStale += 1;
      const w = _schedEntry(r, 'WASH');
      const lc = w && w.lastCompletedIso ? _s(w.lastCompletedIso).slice(0, 10) : null;
      if (lc && (!washLast || lc > washLast)) washLast = lc;
    }
    if (down(r)) continue;
    const items = pm.filter((p) => REAL_PM[p.type]).map((p) => ({ type: p.type, cat: REAL_PM[p.type], label: PM_LABEL[REAL_PM[p.type]], due: p.due, overdueDays: p.overdueDays }));
    if (!items.length) continue;
    for (const c of new Set(items.map((i) => i.cat))) counts[c] += 1;
    units.push({ id: _s(r.equipmentId), items, oldest: Math.max(...items.map((i) => i.overdueDays)) });
  }
  units.sort((a, b) => (b.oldest - a.oldest) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const kept = units.slice(0, COMPLIANCE_MAX);
  const lines = {};
  for (const u of kept) {
    let s = u.id + ' (Active): ' + u.items.map((i) => i.label + ' due ' + md(i.due) + ', ' + (i.cat === 'DOT' ? 'expired ' : 'overdue ') + fmtDays(i.overdueDays)).join('; ');
    if (s.length > COMPLIANCE_LINE_MAX) s = s.slice(0, COMPLIANCE_LINE_MAX);
    lines[u.id] = s;
  }
  const groups = [];
  for (const cat of ['DOT', 'PM_B', 'PM_X', 'Lift']) {
    const hits = [];
    for (const u of kept) for (const i of u.items) if (i.cat === cat) hits.push({ id: u.id, due: i.due });
    if (!hits.length) continue;
    hits.sort((a, b) => (_s(a.due) < _s(b.due) ? -1 : _s(a.due) > _s(b.due) ? 1 : (a.id < b.id ? -1 : 1)));
    groups.push(PM_LABEL[cat] + (cat === 'DOT' ? ' expired ' : ' overdue ') + hits.length + ' (' + hits.map((x) => x.id + ' due ' + md(x.due)).join(', ') + ')');
  }
  const out = [];
  if (groups.length) out.push('compliance (Active units): ' + groups.join(' · '));
  const notes = [];
  if (counts.pmaStale) notes.push('PM A shows overdue on ' + _plural(counts.pmaStale, 'unit', 'units') + ' that completed a later PM B/X');
  if (counts.washStale) {
    let s = 'Wash shows overdue on ' + _plural(counts.washStale, 'unit', 'units');
    if (washLast) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(washLast); if (m) s += ' (last recorded ' + (+m[2]) + '/' + (+m[3]) + '/' + m[1] + ')'; }
    notes.push(s);
  }
  if (notes.length) out.push('AAP schedule notes: ' + notes.join(' · '));
  return { units: kept, lines, counts, text: out.join('\n') };
}

// ── SCAC roll-up (B6.4) ─────────────────────────────────────────────────────
function _idList(ids, detailed) {
  const shown = ids.filter((id) => detailed.has(id));
  const more = ids.length - shown.length;
  return shown.join(', ') + (more > 0 ? (shown.length ? ', ' : '') + '+' + more + ' more' : '');
}
function _byId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }
function _pct(part, whole) { return whole > 0 ? Math.round((part / whole) * 100) : 0; }

/**
 * rollup({ scac, records, stats, asOf, tz, compliance, themes, detailedIds })
 *   -> { text, countBy } (B6.4). `records` holds every down unit (detailed or not); id lists
 * name detailed units only and end with '+K more'.
 */
function rollup(args = {}) {
  const recs = Array.isArray(args.records) ? args.records : [];
  const detailed = args.detailedIds instanceof Set ? args.detailedIds : new Set(recs.map((r) => r.id));
  const stats = args.stats || {};
  const comp = args.compliance || { counts: {}, text: '' };
  const countBy = new Map();
  const N = recs.length;
  countBy.set('total', Number.isFinite(stats.total) ? stats.total : N);
  countBy.set('down', N);
  const L = [];

  const fp = ['fleet: ' + _plural(countBy.get('total'), 'unit', 'units'), N + ' down'];
  if (stats.uptime != null && Number.isFinite(Number(stats.uptime))) fp.push('uptime ' + Number(stats.uptime).toFixed(1) + '%');
  const st = args.asOf ? _stamp(args.asOf, args.tz) : '';
  L.push(fp.join(' · ') + (st ? ' (live fleet data as of ' + st + ')' : ''));

  // vendors: real vendors largest first (ties by name), then the no-vendor groups.
  const vc = new Map();
  for (const r of recs) vc.set(r.vendorLabel, (vc.get(r.vendorLabel) || 0) + 1);
  const real = [...vc.entries()].filter(([k]) => k !== DSP_LABEL && k !== NO_VENDOR_LABEL)
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  const groups = [DSP_LABEL, NO_VENDOR_LABEL].filter((k) => vc.has(k)).map((k) => [k, vc.get(k)]);
  const vlist = real.slice(0, VENDOR_LABELS_MAX).concat(groups);
  const otherK = real.slice(VENDOR_LABELS_MAX).reduce((s, x) => s + x[1], 0);
  for (const [k, n] of vc.entries()) countBy.set('vendor:' + k, n);
  if (vlist.length) L.push('vendors: ' + vlist.map(([k, n]) => k + ' ' + n).join(' · ') + (otherK ? ' · other ' + otherK : ''));

  const known = recs.filter((r) => r.daysDown != null);
  const totalUd = known.reduce((s, r) => s + r.daysDown, 0);
  const causes = T.CAUSES.map((c) => {
    const rs = recs.filter((r) => r.cause === c);
    return { c, n: rs.length, ud: rs.filter((r) => r.daysDown != null).reduce((s, r) => s + r.daysDown, 0), known: rs.filter((r) => r.daysDown != null).length };
  });
  for (const x of causes) countBy.set(x.c, x.n);
  const cs = causes.filter((x) => x.n > 0).sort((a, b) => (b.n - a.n) || (b.ud - a.ud) || (a.c < b.c ? -1 : 1));
  if (cs.length) {
    L.push('down-cause split: ' + cs.map((x) => x.c + ' ' + _plural(x.n, 'unit', 'units')
      + (x.known ? ' ' + x.ud.toFixed(1) + ' unit-days (' + _pct(x.ud, totalUd) + '%)' : ' (days unknown)')).join(' · '));
  }

  const vSide = recs.filter((r) => r.owner === 'vendor' || r.owner === 'dealer');
  const dsp = recs.filter((r) => r.owner === 'DSP');
  const amz = recs.filter((r) => r.owner === 'Amazon');
  countBy.set('owner:vendor', vSide.length);
  countBy.set('owner:DSP', dsp.length);
  if (amz.length) countBy.set('owner:Amazon', amz.length);
  if (N) {
    const dspUd = dsp.filter((r) => r.daysDown != null).reduce((s, r) => s + r.daysDown, 0);
    const op = ['vendor/dealer-side ' + _plural(vSide.length, 'unit', 'units'),
      'DSP-managed ' + _plural(dsp.length, 'unit', 'units') + (totalUd > 0 ? ' (' + _pct(dspUd, totalUd) + '% of down-days)' : '')];
    if (amz.length) op.push('awaiting vendor assignment ' + _plural(amz.length, 'unit', 'units'));
    L.push('owner split: ' + op.join(' · '));
  }

  const unknown = recs.filter((r) => r.daysDown == null).map((r) => r.id);
  countBy.set('daysUnknown', unknown.length);
  if (unknown.length) L.push('days down unknown: ' + _idList(unknown, detailed) + ' (no open WR / no WR date)');

  const es = { today: 0, future: 0, missed: 0, none: 0 };
  for (const r of recs) { const s = r.etc && es[r.etc.state] != null ? r.etc.state : 'none'; es[s] += 1; }
  for (const k of Object.keys(es)) countBy.set('etc:' + k, es[k]);
  if (N) L.push('ETC (Path B counted): today ' + es.today + ' · future ' + es.future + ' · missed ' + es.missed + ' · none ' + es.none);

  const eh = recs.filter((r) => detailed.has(r.id) && r.etcHistory && r.etcHistory.revised > 0).sort(_byId);
  if (eh.length) L.push('ETC history (vendor-set units): moved later ' + eh.map((r) => (r.etcHistory.fromTail ? 'at least ' : '') + r.etcHistory.daySlips + '×').join(', ') + ' (' + eh.map((r) => r.id).join(', ') + ')');

  const noEta = recs.filter((r) => r.parts && r.parts.noEta).sort(_byId);
  const passed = recs.filter((r) => r.parts && !r.parts.noEta && r.parts.etaPassed).sort(_byId);
  countBy.set('noEta', noEta.length);
  countBy.set('etaPassed', passed.length);
  const pp = [];
  if (noEta.length) pp.push('no ETA on ' + _plural(noEta.length, 'unit', 'units') + ' (' + _idList(noEta.map((r) => r.id), detailed) + ')');
  if (passed.length) {
    const shown = passed.filter((r) => detailed.has(r.id));
    const more = passed.length - shown.length;
    pp.push('parts ETA passed, no arrival recorded on ' + _plural(passed.length, 'unit', 'units') + ' ('
      + shown.map((r) => r.id + ' ' + r.parts.eta).join(', ') + (more > 0 ? (shown.length ? ', ' : '') + '+' + more + ' more' : '') + ')');
  }
  if (pp.length) L.push('parts: ' + pp.join(' · '));

  const arr = recs.filter((r) => r.arrival && r.arrival.basis === 'assign' && r.arrival.hours != null);
  countBy.set('arrivalN', arr.length);
  if (arr.length) {
    const hs = arr.map((r) => r.arrival.hours).sort((a, b) => a - b);
    const mid = Math.floor(hs.length / 2);
    const med = hs.length % 2 ? hs[mid] : _round1((hs[mid - 1] + hs[mid]) / 2);
    const vend = [...new Set(arr.map((r) => r.vendorLabel))].sort().join('/');
    L.push('tech arrival (current ' + vend + ' work orders, measured from vendor assignment, n = ' + arr.length + '): median '
      + med.toFixed(1) + ' h · range ' + hs[0].toFixed(1) + ' h to ' + hs[hs.length - 1].toFixed(1) + ' h');
  }

  const cc = comp.counts || {};
  for (const k of ['DOT', 'PM_B', 'PM_X', 'Lift', 'pmaStale', 'washStale']) countBy.set(k, cc[k] || 0);
  if (comp.text) L.push(comp.text);

  const hits = args.themes && args.themes.hits ? args.themes.hits : {};
  for (const name of Object.keys(hits)) countBy.set('theme:' + name, new Set((hits[name] || []).map((h) => h.id)).size);

  if (detailed.size < N) countBy.set('detailed', recs.filter((r) => detailed.has(r.id)).length);

  const head = 'CI ROLLUP ' + _s(args.scac);
  const keep = [];
  for (const l of L) { if ([head].concat(keep, [l]).join('\n').length > CI_ROLLUP_MAX) break; keep.push(l); }
  return { text: [head].concat(keep).join('\n'), countBy };
}

module.exports = {
  unitRecord, renderRecord, etcDayCounts, arrivalOf, rollup, compliance, keyLines, daysDownFrac, partsNoEta,
  fmtDays, md, vendorLabel, etcByLabel, pmEntries, estimateOf: _estimate,
  CI_RECORD_MAX, CI_ROLLUP_MAX, DSP_LABEL, NO_VENDOR_LABEL, BLOCKER_RE,
};
