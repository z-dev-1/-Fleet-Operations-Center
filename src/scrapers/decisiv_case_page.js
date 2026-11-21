'use strict';
/**
 * scrapers/decisiv_case_page.js — pure parser for the server-rendered Decisiv
 * case page GET /fleet/estimates/{id} (Volvo ASIST and PACCAR look alike), plus
 * the "done offsite" / status-mismatch classifier for Pending Estimates.
 *
 * Field map confirmed from estimate 21383146: Show-Estimate money table
 * (Parts / Labor / grand total), <select id="fleet_status_select_{id}">,
 * renderEstimateRepairStatusTag({repairStatus:"..."}), labeled ETR / Created /
 * Checked In / Follow-Up stamps, RO Number, left-nav asset + Service Location.
 *
 * No requires, no I/O. Every function returns null/'' for what it cannot find
 * and never throws.
 */

const EST_RE = /https?:\/\/(?:volvopg\.asist|pssmfleet|paccarpg)\.decisiv\.net\/fleet\/estimates\/(\d+)/i;

function estimateIdFromUrl(url) {
  const m = EST_RE.exec(String(url || ''));
  return m ? m[1] : '';
}

function vendorKindOfUrl(url) {
  const s = String(url || '');
  let host = '';
  try { host = new URL(s).host; } catch (_) { host = s; }
  if (/(^|\.)volvopg\.asist\.decisiv\.net$/i.test(host) || /^https?:\/\/volvopg\.asist\.decisiv\.net\b/i.test(s)) return 'volvo';
  if (/(^|\.)(pssmfleet|paccarpg)\.decisiv\.net$/i.test(host) || /^https?:\/\/(pssmfleet|paccarpg)\.decisiv\.net\b/i.test(s)) return 'paccar';
  return '';
}

function _hostOf(url) {
  try { return new URL(String(url || '')).host || null; } catch (_) { return null; }
}

function _decode(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return ''; } })
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

function _text(s) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function _round(n) { return Math.round(n * 100) / 100; }

const MONEY_RE = /\$\s?(-?[\d,]+\.\d{2})/;
function _money(s) {
  const m = MONEY_RE.exec(String(s || ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function _rows(html) {
  const out = [];
  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(html))) {
    const cells = [];
    const cre = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let c;
    while ((c = cre.exec(m[1]))) cells.push(_text(c[1]));
    if (cells.length) out.push(cells);
  }
  return out;
}

// ── Timestamps ───────────────────────────────────────────────────────────────
const ZONES = { EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7 };
const STD = { E: -5, C: -6, M: -7, P: -8 };
const STAMP_SRC = '(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})(?:\\s*(\\d{1,2}):(\\d{2})\\s*([ap])\\.?m\\.?)?(?:\\s*\\b([ECMP][SD]T)\\b)?';

// nth Sunday (1-based) of month m (0-based) in year y, as a day-of-month.
function _nthSunday(y, m, n) {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return 1 + ((7 - first) % 7) + (n - 1) * 7;
}

function _isUsDst(y, mo, d, h) {
  // Local wall time; DST from 2nd Sunday of March 02:00 to 1st Sunday of November 02:00.
  const start = _nthSunday(y, 2, 2);
  const end = _nthSunday(y, 10, 1);
  const key = (mo * 100 + d) * 100 + h;
  return key >= (2 * 100 + start) * 100 + 2 && key < (10 * 100 + end) * 100 + 2;
}

// Parse one stamp match -> { iso, text } or null.
function _stampFromMatch(m, family) {
  if (!m) return null;
  const mo = Number(m[1]) - 1, d = Number(m[2]), y = Number(m[3]);
  let h = 0, mi = 0;
  if (m[4] != null) {
    h = Number(m[4]) % 12; mi = Number(m[5]);
    if (m[6] && m[6].toLowerCase() === 'p') h += 12;
  }
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  let ms;
  const zone = m[7] ? m[7].toUpperCase() : '';
  if (zone && ZONES[zone] != null) {
    ms = Date.UTC(y, mo, d, h, mi) - ZONES[zone] * 3600000;
  } else if (family && STD[family] != null) {
    const off = STD[family] + (_isUsDst(y, mo, d, h) ? 1 : 0);
    ms = Date.UTC(y, mo, d, h, mi) - off * 3600000;
  } else {
    ms = new Date(y, mo, d, h, mi).getTime();
  }
  if (!Number.isFinite(ms)) return null;
  return { iso: new Date(ms).toISOString(), ms, text: m[0].trim() };
}

function _labeled(text, labelSrc, family) {
  const re = new RegExp('(?:^|[^A-Za-z])(?:' + labelSrc + ')\\s*:?\\s*' + STAMP_SRC, 'i');
  const m = re.exec(text);
  // Re-match the stamp alone so .text excludes the label.
  return m ? _stampFromMatch(new RegExp(STAMP_SRC, 'i').exec(m[0]), family) : null;
}

// ── Version totals (Angular Estimate History data) ───────────────────────────
function _num(s) {
  const n = Number(String(s).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function _versionData(decoded) {
  const re = /["']?\bversion\b["']?\s*:\s*/gi;
  const hits = [];
  let m;
  while ((m = re.exec(decoded))) hits.push(m.index + m[0].length);
  let best = null;
  hits.forEach((start, i) => {
    const end = i + 1 < hits.length ? hits[i + 1] : Math.min(decoded.length, start + 4000);
    const win = decoded.slice(start, end);
    const vm = /^["']?(\d+)/.exec(win);
    const ver = vm ? Number(vm[1]) : i;
    const key = (k) => {
      const km = new RegExp('(?:^|[^A-Za-z_])["\']?' + k + '["\']?\\s*:\\s*["\']?\\$?(-?[\\d,]+(?:\\.\\d+)?)', 'i').exec(win);
      return km ? _num(km[1]) : null;
    };
    const rec = { ver, total: key('total'), parts: key('parts_total'), labor: key('labor_total'), dates: [] };
    const dre = /["']?(?:created_at|updated_at|approved_at|submitted_at)["']?\s*:\s*["'](\d{4}-\d{2}-\d{2}T[^"']+)["']/gi;
    let dm;
    while ((dm = dre.exec(win))) { const t = Date.parse(dm[1]); if (Number.isFinite(t)) rec.dates.push(t); }
    if (rec.total == null && rec.parts == null && rec.labor == null) return;
    if (!best || rec.ver >= best.ver) best = rec;
  });
  return best;
}

const EMPTY_FIELDS = [
  'fleetStatus', 'repairStatus', 'stage', 'stageStatus', 'stageSince',
  'total', 'partsTotal', 'laborTotal', 'totalSource',
  'etr', 'etrText', 'createdAt', 'checkedInAt', 'followUpAt', 'updatedAt',
  'roNumber', 'dealerName', 'dealerShortName', 'dealerCity', 'dealerState',
  'unit', 'serial', 'make', 'model', 'year',
];

function _base(opts) {
  const o = opts || {};
  const url = o.url ? String(o.url) : null;
  const rec = {
    estimateId: o.estimateId != null && String(o.estimateId) ? String(o.estimateId) : (url ? estimateIdFromUrl(url) || null : null),
    url,
    host: _hostOf(url),
    vendorKind: url ? (vendorKindOfUrl(url) || null) : null,
  };
  EMPTY_FIELDS.forEach((k) => { rec[k] = null; });
  const now = o.now != null ? new Date(o.now) : new Date();
  rec.scrapedAt = Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString();
  rec.ok = false;
  rec.error = null;
  return rec;
}

/**
 * parseCasePage(html, { estimateId, now, url? }) -> DecisivCase (plan §1.1).
 */
function parseCasePage(html, opts) {
  const rec = _base(opts);
  try {
    const o = opts || {};
    const nowMs = o.now != null ? new Date(o.now).getTime() : Date.now();
    const decoded = _decode(html);
    if (!decoded) { rec.error = 'DECISIV_PARSE_EMPTY'; return rec; }

    // Fleet Status: selected option of the fleet_status select.
    const id = rec.estimateId || '';
    let sel = null;
    if (id) sel = new RegExp('<select\\b[^>]*\\bid=["\']fleet_status_select_' + id + '["\'][^>]*>([\\s\\S]*?)<\\/select>', 'i').exec(decoded);
    if (!sel) sel = /<select\b[^>]*\bid=["']fleet_status_select_\d+["'][^>]*>([\s\S]*?)<\/select>/i.exec(decoded);
    if (sel) {
      const ore = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
      let om;
      while ((om = ore.exec(sel[1]))) {
        if (/\bselected\b/i.test(om[1])) { rec.fleetStatus = _text(om[2]) || null; break; }
      }
    }

    // Repair Status: renderEstimateRepairStatusTag({ repairStatus: "..." }).
    const rs = /renderEstimateRepairStatusTag\(\s*\{[^}]*?["']?repairStatus["']?\s*:\s*(["'])([^"']*)\1/i.exec(decoded);
    if (rs) rec.repairStatus = rs[2].trim() || null;

    // Money rows.
    let parts = null, labor = null, grand = null;
    const rows = _rows(decoded);
    for (const cells of rows) {
      const label = cells[0].toLowerCase().replace(/:\s*$/, '').trim();
      let money = null;
      for (let i = cells.length - 1; i >= 1; i--) { const v = _money(cells[i]); if (v != null) { money = v; break; } }
      if (money == null) continue;
      if (parts == null && /^parts( total)?$/.test(label)) parts = money;
      else if (labor == null && /^labou?r( total)?$/.test(label)) labor = money;
      else if (grand == null && /^(grand total|estimate total|total( estimate)?|total amount)$/.test(label)) grand = money;
    }

    // Stripped page text (scripts/styles removed) for labeled values.
    const text = _text(decoded.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' '));
    if (parts == null || labor == null || grand == null) {
      // 'Parts Total' / 'Labor Total' are the parts / labor amounts, never the grand total.
      const tre = /\b(Parts(?: Total)?|Labou?r(?: Total)?|Grand Total|(?<!\b(?:Parts|Labou?r)\s+)Total)\b\s*:?\s*\$\s?([\d,]+\.\d{2})/gi;
      let tm;
      while ((tm = tre.exec(text))) {
        const v = _num(tm[2]);
        const l = tm[1].toLowerCase().replace(/^(parts|labou?r) total$/, '$1');
        if (l === 'parts' && parts == null) parts = v;
        else if ((l === 'labor' || l === 'labour') && labor == null) labor = v;
        else if ((l === 'grand total' || l === 'total') && grand == null) grand = v;
      }
    }
    const ver = _versionData(decoded);
    if (parts == null && ver && ver.parts != null) parts = ver.parts;
    if (labor == null && ver && ver.labor != null) labor = ver.labor;
    rec.partsTotal = parts != null ? _round(parts) : null;
    rec.laborTotal = labor != null ? _round(labor) : null;
    if (grand != null) { rec.total = _round(grand); rec.totalSource = 'grand'; }
    else if (ver && ver.total != null) { rec.total = _round(ver.total); rec.totalSource = 'version'; }
    else if (parts != null || labor != null) { rec.total = _round((parts || 0) + (labor || 0)); rec.totalSource = 'sum'; }

    // Left-nav asset info.
    const li = /<table\b[^>]*class=["'][^"']*\bleftinfo\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i.exec(decoded);
    if (li) {
      for (const cells of _rows(li[1])) {
        if (cells.length < 2) continue;
        const k = cells[0].toLowerCase().replace(/:\s*$/, '').trim();
        const v = cells[1] || null;
        if (k === 'unit #' && rec.unit == null) rec.unit = v;
        else if (k === 'serial #' && rec.serial == null) rec.serial = v;
        else if (k === 'make' && rec.make == null) rec.make = v;
        else if (k === 'model' && rec.model == null) rec.model = v;
        else if (k === 'year' && rec.year == null) rec.year = v;
      }
    }

    // Dealer (Service Location).
    const dl = /<h4\b[^>]*>\s*Service Location:?\s*<\/h4>\s*<h5\b[^>]*>([\s\S]*?)<\/h5>/i.exec(decoded);
    if (dl) {
      const name = _text(dl[1]);
      if (name) {
        rec.dealerName = name;
        rec.dealerShortName = name.split(' - ')[0].trim() || null;
        const cs = /-\s*([A-Za-z .'-]+),\s*([A-Z]{2})\b/.exec(name);
        if (cs) { rec.dealerCity = cs[1].trim() || null; rec.dealerState = cs[2]; }
      }
    }

    // Timestamps.
    const fam = /\b([ECMP])[SD]T\b/.exec(text);
    const family = fam ? fam[1] : '';
    const etr = _labeled(text, 'ETR', family);
    if (etr) { rec.etr = etr.iso; rec.etrText = etr.text; }
    const created = _labeled(text, 'Created', family);
    const checked = _labeled(text, 'Checked[ -]?In', family);
    const follow = _labeled(text, 'Follow[- ]?Up', family);
    const updated = _labeled(text, '(?:Last )?Updated', family);
    if (created) rec.createdAt = created.iso;
    if (checked) rec.checkedInAt = checked.iso;
    if (follow) rec.followUpAt = follow.iso;

    // Estimate-History version dates: table rows whose first cell is a version number.
    const past = [];
    [created, checked, updated].forEach((s) => { if (s) past.push(s.ms); });
    const sre = new RegExp(STAMP_SRC, 'i');
    for (const cells of rows) {
      if (!/^\d+$/.test(cells[0])) continue;
      for (let i = 1; i < cells.length; i++) {
        const s = _stampFromMatch(sre.exec(cells[i]), family);
        if (s) { past.push(s.ms); break; }
      }
    }
    if (ver) ver.dates.forEach((t) => past.push(t));
    const latest = past.filter((t) => Number.isFinite(t) && t <= nowMs).reduce((a, b) => Math.max(a, b), -Infinity);
    if (Number.isFinite(latest)) rec.updatedAt = new Date(latest).toISOString();

    // RO number.
    const ro = /\bRO\s*(?:Number|No\.?|#)\s*:?\s*([A-Z0-9-]{3,})/i.exec(text);
    if (ro) rec.roNumber = ro[1];

    rec.ok = EMPTY_FIELDS.some((k) => rec[k] != null);
    if (!rec.ok) rec.error = 'DECISIV_PARSE_EMPTY';
    return rec;
  } catch (e) {
    const fresh = _base(opts);
    fresh.error = 'DECISIV_PARSE_ERROR';
    return fresh;
  }
}

/**
 * mergeCaseStatus(caseRec, statusSummary, { now }) -> new record with the
 * case-status API stage/status/since and history folded into updatedAt.
 */
function mergeCaseStatus(caseRec, statusSummary, opts) {
  const out = Object.assign({}, caseRec || {});
  try {
    const s = statusSummary;
    if (!s || s.ok === false) return out;
    const nowMs = opts && opts.now != null ? new Date(opts.now).getTime() : Date.now();
    if (s.stage != null) out.stage = String(s.stage) || null;
    if (s.status != null) out.stageStatus = String(s.status) || null;
    if (s.since != null) out.stageSince = String(s.since) || null;
    const times = [];
    if (out.updatedAt) times.push(Date.parse(out.updatedAt));
    (Array.isArray(s.history) ? s.history : []).forEach((h) => { if (h && h.at) times.push(Date.parse(h.at)); });
    if (s.since) times.push(Date.parse(s.since));
    const latest = times.filter((t) => Number.isFinite(t) && t <= nowMs).reduce((a, b) => Math.max(a, b), -Infinity);
    if (Number.isFinite(latest)) out.updatedAt = new Date(latest).toISOString();
  } catch (_) { /* keep what we have */ }
  return out;
}

// ── Status-mismatch classifier (requirement 1) ───────────────────────────────
// "Done offsite" = Repair Status reached complete/ready. Fleet Status (the
// estimate approval) is never an input: Approved-but-Waiting is not done.
const DONE_REPAIR_STATUS_RE = /^(complete(d)?\b|repairs? complete(d)?\b|ready\b)/i;

function isOffsiteRepairDone(o) {
  const x = o || {};
  if (String(x.stage || '').toLowerCase() === 'ready') return true;
  return DONE_REPAIR_STATUS_RE.test(String(x.repairStatus || '').trim())
    || DONE_REPAIR_STATUS_RE.test(String(x.stageStatus || '').trim());
}

function classifyStatusMismatch(args) {
  const a = args || {};
  const offsiteDone = !!(a.offsite && isOffsiteRepairDone(a.offsite));
  return { offsiteDone, statusMismatch: offsiteDone && a.rgOpen === true };
}

module.exports = {
  EST_RE,
  estimateIdFromUrl,
  vendorKindOfUrl,
  parseCasePage,
  mergeCaseStatus,
  DONE_REPAIR_STATUS_RE,
  isOffsiteRepairDone,
  classifyStatusMismatch,
};
