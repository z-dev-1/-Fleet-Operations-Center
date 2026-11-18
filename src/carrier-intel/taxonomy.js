'use strict';
/**
 * carrier-intel/taxonomy.js — down-cause taxonomy (design B3, locked).
 *
 * downCause(row, fs, today) -> { cause, owner, offsite, flags[] }. Pure: no I/O, no logging.
 * `fs` is the fresh wo-facts fact set, or null when buildFactSet failed (the row mirrors are
 * used then). The first matching rule wins: impound -> accident -> DSP-hold -> parts-hold ->
 * dealer-offsite -> repair.
 */

const F = require('../dbr/fleet-dbr');
const EV = require('../dbr/fleet-dbr-evidence');
const W = require('../repair-intel/wo-facts');
const D = require('../repair-intel/wo-extract-dates');

// Same rule as dbr/target-resolver.normKey (kept local: this module's allowed requires, B3).
function normKey(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// facts.js requires this module, so it is loaded lazily (partsNoEta lives there, B3).
function _facts() { return require('./facts'); }

const CAUSES = Object.freeze(['impound', 'accident', 'DSP-hold', 'parts-hold', 'dealer-offsite', 'repair']);
const PARTS_DELAY_CODES = Object.freeze(['PARTS_ON_BACK_ORDER', 'SOURCING_PARTS']);
const PARTS_HOLD_STATUSES = Object.freeze(['ordered', 'backorder', 'shipped']);
const ACCIDENT_TEXT_RE = /\b(accident|collision|crash(ed)?|struck)\b/i;
const ACCESS_BLOCK_RE = /\b(credential|record\s*360|no\s+access|access\s+(issue|denied))/i;
const LAG_MS = 72 * 3600 * 1000;
const ROLLING_MIN = 3;
const ROLLING_DAYS = 7;
const ACCESS_DAYS = 14;

function _s(v) { return v == null ? '' : String(v); }
function _ms(v) { const n = D.parseTs(v); return n == null ? null : n; }

function isPlaceholder(vendor) { return W.PLACEHOLDER_RE.test(_s(vendor).trim()); }
function noVendor(vendor) { const v = _s(vendor).trim(); return !v || isPlaceholder(v); }
function isDealer(vendor) { const v = _s(vendor); return F.OEM_VENDOR_RE.test(v) || /\bcei\b/i.test(v); }

const OFFSITE = (row, fs) => !!row.offsiteShopEventUrl || !!row.asistSrUrl
  || (fs ? ((fs.caseIds && fs.caseIds.tow) || []).length > 0 : !!_s(row.towRefs).trim());

function unitText(row) {
  return [EV.conversationEntries(_s(row.fullConversation)).map((e) => e.body).join('\n'),
    row.repairTimeline, row.issueSummary, row.issueDetails].map((s) => _s(s)).join('\n');
}

// Whole ET calendar days from YYYY-MM-DD a to b.
function _dayDiff(a, b) {
  const p = (y) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(_s(y)); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; };
  const x = p(a); const y = p(b);
  return x == null || y == null ? null : Math.round((y - x) / 86400000);
}
// End of `today` (local, America/New_York per AS-1) as the pure "now".
function _nowOf(today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(_s(today));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999).getTime() : null;
}
// Year for an 'MM/DD' conversation date: the latest such date not after today.
function _ymdOfMd(md, today) {
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(_s(md).trim());
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(_s(today));
  if (!m || !t) return null;
  const pad = (n) => String(n).padStart(2, '0');
  let y = +t[1];
  if (+m[1] * 100 + +m[2] > +t[2] * 100 + +t[3]) y -= 1;
  return y + '-' + pad(+m[1]) + '-' + pad(+m[2]);
}

function _partsStatus(row, fs) { return fs ? _s(fs.partsStatus) : _s(row.partsStatus); }
function _openPartsEta(row, fs) {
  if (fs) return !!(fs.etc && fs.etc.partsEta && fs.etc.partsEta.date);
  return !!_s(row.partsEta).trim();
}
function _openPartsEtaDate(row, fs) {
  if (fs) return fs.etc && fs.etc.partsEta && fs.etc.partsEta.date ? fs.etc.partsEta.date : null;
  return /^\d{4}-\d{2}-\d{2}$/.test(_s(row.partsEta).trim()) ? _s(row.partsEta).trim() : null;
}
function _delayReason(row, fs) { return fs ? _s(fs.vendorDelayReason) : _s(row.vendorDelayReason); }
function _noEta(fs) { return fs ? _facts().partsNoEta(fs) : false; }

function _partsHold(row, fs, vendor) {
  if (noVendor(vendor)) return false;
  const ps = _partsStatus(row, fs);
  if (ps === 'arrived') return false;
  const dr = _delayReason(row, fs);
  return PARTS_DELAY_CODES.includes(dr.trim().toUpperCase()) || /parts\s+ordered/i.test(dr)
    || PARTS_HOLD_STATUSES.includes(ps) || _openPartsEta(row, fs) || _noEta(fs);
}

function _trend(row, fs) {
  if (fs && fs.history) return fs.history;
  const h = row && row.relayFacts && row.relayFacts.historyTrend;
  return h && typeof h === 'object' && h.etc ? h : null;
}

// etc-rolling: >= 3 vendor-side repairCompletion revisions on distinct ET days in the last 7 days.
function _etcRolling(row, fs, today) {
  const t = _trend(row, fs);
  const revs = t && t.etc && Array.isArray(t.etc.revisions) ? t.etc.revisions : [];
  const days = new Set();
  for (const r of revs) {
    if (!r || r.kind !== 'repairCompletion' || r.side !== 'vendor') continue;
    const ms = _ms(r.at);
    if (ms == null) continue;
    const d = D.ymd(ms);
    const diff = _dayDiff(d, today);
    if (diff != null && diff >= 0 && diff < ROLLING_DAYS) days.add(d);
  }
  return days.size >= ROLLING_MIN;
}

function _assignmentMs(row, fs, vendor) {
  const t = _trend(row, fs);
  const ch = t && t.vendor && Array.isArray(t.vendor.changes) ? t.vendor.changes : [];
  const vk = normKey(vendor);
  const hits = ch.filter((c) => c && c.op === 'ASSIGN_VENDOR' && c.field === 'Vendor' && normKey(c.to) === vk && _ms(c.at) != null);
  if (hits.length) return _ms(hits[hits.length - 1].at);
  const rf = row && row.relayFacts;
  return rf ? _ms(rf.wrCreatedAt) : null;
}

// vendor-response-lag: the first vendor-side Relay comment came > 72 h after the vendor
// assignment, or there is none and 72 h have passed.
function _responseLag(row, fs, vendor, today) {
  if (noVendor(vendor)) return false;
  const assigned = _assignmentMs(row, fs, vendor);
  if (assigned == null) return false;
  const ev = row.relayFacts && Array.isArray(row.relayFacts.events) ? row.relayFacts.events : [];
  const first = ev.filter((e) => e && e.side === 'vendor' && e.via === 'comment').map((e) => _ms(e.at))
    .filter((t) => t != null).sort((a, b) => a - b)[0];
  if (first != null) return first - assigned > LAG_MS;
  const now = _nowOf(today);
  return now != null && now - assigned > LAG_MS;
}

// vendor-access-block: access wording in a vendor-side comment of the last 14 days.
function _accessBlock(row, vendor, today) {
  const vk = normKey(vendor);
  if (!vk) return false;
  for (const e of EV.conversationEntries(_s(row.fullConversation))) {
    if (normKey(e.author) !== vk || !ACCESS_BLOCK_RE.test(e.body)) continue;
    const diff = _dayDiff(_ymdOfMd(e.date, today), today);
    if (diff != null && diff >= 0 && diff < ACCESS_DAYS) return true;
  }
  return false;
}

/**
 * downCause(row, fs, today) -> { cause, owner, offsite, flags[] } (design B3).
 */
function downCause(row, fs, today) {
  const r = row && typeof row === 'object' ? row : {};
  const f = fs && typeof fs === 'object' ? fs : null;
  const vendor = _s(r.vendor).trim();
  const lr = _s(r.lifecycleReason).trim();
  const ut = unitText(r);
  const issue = _s(r.issueSummary) + '\n' + _s(r.issueDetails);
  let cause;
  let owner;
  let offsite;
  if (/impound/i.test(lr) || /\bimpound/i.test(ut)) {
    cause = 'impound'; owner = 'DSP'; offsite = OFFSITE(r, f);
  } else if (/^accident$/i.test(lr) || ACCIDENT_TEXT_RE.test(issue)) {
    cause = 'accident'; owner = noVendor(vendor) ? 'DSP' : 'vendor'; offsite = OFFSITE(r, f);
  } else if (/^dsp_entered$/i.test(vendor)) {
    cause = 'DSP-hold'; owner = 'DSP'; offsite = false;
  } else if (_partsHold(r, f, vendor)) {
    cause = 'parts-hold'; owner = 'vendor';
    offsite = isDealer(vendor) || !!r.offsiteShopEventUrl || !!r.asistSrUrl;
  } else if ((/offsite shop repair/i.test(lr) || !!r.offsiteShopEventUrl || !!r.asistSrUrl) && isDealer(vendor)) {
    cause = 'dealer-offsite'; owner = 'dealer'; offsite = true;
  } else {
    cause = 'repair'; owner = noVendor(vendor) ? 'Amazon' : 'vendor'; offsite = false;
  }

  const flags = [];
  if (cause === 'parts-hold') {
    const ne = _noEta(f);
    if (ne) flags.push('parts-no-eta');
    const eta = _openPartsEtaDate(r, f);
    if (eta && eta < _s(today) && !ne) flags.push('parts-eta-passed');
  }
  if (_etcRolling(r, f, today)) flags.push('etc-rolling');
  if (_responseLag(r, f, vendor, today)) flags.push('vendor-response-lag');
  if (_accessBlock(r, vendor, today)) flags.push('vendor-access-block');
  if (!_s(r.workRequestId).trim()) flags.push('no-open-wr');
  if (cause === 'repair' && noVendor(vendor)) flags.push('no-vendor');
  return { cause, owner, offsite, flags };
}

function causeLabel(cause, flags) {
  if (cause === 'repair' && Array.isArray(flags) && flags.includes('no-vendor')) return 'repair (awaiting vendor assignment)';
  return _s(cause);
}

module.exports = { downCause, CAUSES, causeLabel, OFFSITE, unitText, isPlaceholder, noVendor, isDealer, normKey, ymdOfMd: _ymdOfMd, dayDiff: _dayDiff };
