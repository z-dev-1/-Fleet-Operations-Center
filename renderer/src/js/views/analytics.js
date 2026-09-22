/**
 * analytics.js — Fleet KPI analytics dashboard (Stage 13)
 *
 * Pure client-side computation from state.slice('fleet').rows.
 * No new IPC needed — all data is available in the renderer state.
 *
 * Sections:
 *   1. Summary bar         — total, unavailable %, available %, high-risk
 *   2. Lifecycle breakdown — CSS bar chart per lifecycle state
 *   3. By-operator table   — total / unavail / high-risk / open-WR per op
 *   4. Risk distribution   — HIGH/MEDIUM/LOW tiers with mini bars
 *   5. Top vendors         — ranked vendor counts from row.vendor (relay-merged)
 *   6. PM due dates        — pmB / pmX / DOT overdue/due-soon counts
 *   7. Body-type mix       — asset type distribution bar chart
 *
 * S13-fix: vendor data derived from row.vendor (relay-merged field on every
 * fleet row) — no relay cache IPC needed, relay bridge import removed.
 *
 * Updates reactively on fleet:data bus events.
 */

import bus   from '../bus.js';
import state from '../state.js';
import { longDwell as longDwellBridge, ai as aiBridge, relay as relayBridge, files as filesBridge } from '../bridge.js';
import toast from '../components/toast.js';

let _el = null;

// ── Helpers ────────────────────────────────────────────────────────────────
const _safe = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _pct  = (n, t) => t ? Math.round((n / t) * 100) : 0;

// ── PM field parser ────────────────────────────────────────────────────────
// pmB / pmX / dot values come as strings: "3 days", "overdue", "0 days", "--"
function _pmDaysNum(s) {
  if (!s || s === '--') return null;
  const lo = s.toLowerCase().trim();
  if (lo === 'overdue' || lo.startsWith('overdue'))  return -1;
  if (lo === '0 days' || lo === '0')                 return 0;
  const m = lo.match(/^(-?\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ── Core computation ───────────────────────────────────────────────────────
function _compute(rows) {
  const total = rows.length;

  // — Lifecycle buckets —
  const lcMap = {};
  for (const r of rows) {
    const lc = (r.lifecycleState || 'Unknown').trim();
    lcMap[lc] = (lcMap[lc] || 0) + 1;
  }
  const lcSorted = Object.entries(lcMap).sort((a, b) => b[1] - a[1]);

  const unavailCount = rows.filter(r => {
    const s = (r.lifecycleState || '').toLowerCase();
    return s.includes('unavailable');
  }).length;
  const availCount = rows.filter(r => {
    const s = (r.lifecycleState || '').toLowerCase();
    return s.includes('available') && !s.includes('un');
  }).length;

  // — Risk tiers —
  const highRisk = rows.filter(r => (r.riskScore || 0) >= 75).length;
  const medRisk  = rows.filter(r => { const s = r.riskScore || 0; return s >= 40 && s < 75; }).length;
  const lowRisk  = rows.filter(r => (r.riskScore || 0) < 40).length;

  // — By operator —
  const opMap = {};
  for (const r of rows) {
    const op = (r.operator || 'Unknown').toUpperCase().trim();
    if (!opMap[op]) opMap[op] = { total: 0, unavail: 0, highRisk: 0, openWR: 0 };
    opMap[op].total++;
    if ((r.lifecycleState || '').toLowerCase().includes('unavailable')) opMap[op].unavail++;
    if ((r.riskScore || 0) >= 75) opMap[op].highRisk++;
    if ((r.openUnplanned || 0) > 0) opMap[op].openWR++;
  }
  const opSorted = Object.entries(opMap).sort((a, b) => b[1].total - a[1].total);

  // — Top vendors — derived from row.vendor (relay-merged field on every fleet row)
  const vendMap = {};
  for (const r of rows) {
    const v = (r.vendor || '').trim();
    if (v) vendMap[v] = (vendMap[v] || 0) + 1;
  }
  const vendSorted = Object.entries(vendMap).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // — PM health —
  let pmBOver = 0, pmBSoon = 0;
  let pmXOver = 0, pmXSoon = 0;
  let dotOver = 0, dotSoon = 0;
  const SOON_DAYS = 14;
  for (const r of rows) {
    const b = _pmDaysNum(r.pmB);
    const x = _pmDaysNum(r.pmX);
    const d = _pmDaysNum(r.dot);
    if (b !== null) { if (b < 0) pmBOver++; else if (b <= SOON_DAYS) pmBSoon++; }
    if (x !== null) { if (x < 0) pmXOver++; else if (x <= SOON_DAYS) pmXSoon++; }
    if (d !== null) { if (d < 0) dotOver++; else if (d <= SOON_DAYS) dotSoon++; }
  }

  // — Body-type mix —
  const btMap = {};
  for (const r of rows) {
    const bt = (r.assetType || r.bodyType || 'Unknown').trim();
    btMap[bt] = (btMap[bt] || 0) + 1;
  }
  const btSorted = Object.entries(btMap).sort((a, b) => b[1] - a[1]);

  // — Sync meta —
  const fleetState = state.slice('fleet');
  const syncedAt   = fleetState.syncedAt;
  const stale      = fleetState.stale;

  return {
    total, unavailCount, availCount, highRisk, medRisk, lowRisk,
    lcSorted, opSorted, vendSorted,
    pmBOver, pmBSoon, pmXOver, pmXSoon, dotOver, dotSoon,
    btSorted,
    syncedAt, stale,
  };
}

// ── Bar render helper ─────────────────────────────────────────────────────
function _bar(value, max, cls) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return `<div class="an-bar-track"><div class="an-bar-fill an-bar-fill--${cls}" style="width:${pct}%"></div></div>`;
}

// ── HTML renderers ────────────────────────────────────────────────────────

function _renderSummary(c) {
  const unavailPct  = _pct(c.unavailCount, c.total);
  const availPct    = _pct(c.availCount,   c.total);
  const highRiskPct = _pct(c.highRisk,     c.total);
  const staleHtml = c.stale
    ? `<div class="an-stale-banner">⚠ Data may be stale — trigger a sync for current counts</div>`
    : '';
  const syncedStr = c.syncedAt
    ? new Date(c.syncedAt).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
    : 'never';
  return `
    ${staleHtml}
    <div class="an-summary-bar">
      <div class="an-kpi an-kpi--total">
        <span class="an-kpi__val">${c.total}</span>
        <span class="an-kpi__lbl">Total units</span>
      </div>
      <div class="an-kpi an-kpi--unavail">
        <span class="an-kpi__val">${c.unavailCount} <span class="an-kpi__pct">${unavailPct}%</span></span>
        <span class="an-kpi__lbl">Unavailable</span>
      </div>
      <div class="an-kpi an-kpi--avail">
        <span class="an-kpi__val">${c.availCount} <span class="an-kpi__pct">${availPct}%</span></span>
        <span class="an-kpi__lbl">Available</span>
      </div>
      <div class="an-kpi an-kpi--risk">
        <span class="an-kpi__val">${c.highRisk} <span class="an-kpi__pct">${highRiskPct}%</span></span>
        <span class="an-kpi__lbl">High risk (≥75)</span>
      </div>
      <div class="an-kpi an-kpi--synced">
        <span class="an-kpi__val an-kpi__val--sm">${syncedStr}</span>
        <span class="an-kpi__lbl">Last synced</span>
      </div>
    </div>`;
}

function _renderLifecycle(c) {
  if (!c.lcSorted.length) return '<span class="an-empty">No data</span>';
  const maxCount = c.lcSorted[0][1];
  const rows = c.lcSorted.map(([lc, count]) => {
    const lo  = lc.toLowerCase();
    const cls = lo.includes('unavailable') ? 'unavail'
              : lo.includes('available')   ? 'avail'
              : 'other';
    return `
      <div class="an-lc-row">
        <span class="an-lc-label" title="${_safe(lc)}">${_safe(lc)}</span>
        <div class="an-lc-bar-wrap">${_bar(count, maxCount, cls)}</div>
        <span class="an-lc-count">${count}</span>
        <span class="an-lc-pct">${_pct(count, c.total)}%</span>
      </div>`;
  }).join('');
  return `<div class="an-lc-chart">${rows}</div>`;
}

function _renderRisk(c) {
  const total = c.total || 1;
  const items = [
    { label: 'HIGH ≥75',  count: c.highRisk, cls: 'risk-high' },
    { label: 'MED 40–74', count: c.medRisk,  cls: 'risk-med'  },
    { label: 'LOW <40',   count: c.lowRisk,  cls: 'risk-low'  },
  ];
  return `
    <div class="an-risk-wrap">
      ${items.map(item => `
        <div class="an-risk-tier">
          <div class="an-risk-tier__header">
            <span class="an-risk-badge an-risk-badge--${item.cls}">${item.label}</span>
            <span class="an-risk-tier__count">${item.count}</span>
            <span class="an-risk-tier__pct">${_pct(item.count, total)}%</span>
          </div>
          ${_bar(item.count, total, item.cls)}
        </div>`).join('')}
    </div>`;
}

function _renderOperators(c) {
  if (!c.opSorted.length) return '<span class="an-empty">No data</span>';
  const headerRow = `
    <tr>
      <th>Operator</th>
      <th class="an-tbl--r">Total</th>
      <th class="an-tbl--r">Unavail</th>
      <th class="an-tbl--r">Unavail %</th>
      <th class="an-tbl--r">High risk</th>
      <th class="an-tbl--r">Open WRs</th>
    </tr>`;
  const dataRows = c.opSorted.map(([op, d]) => `
    <tr>
      <td class="an-op-name">${_safe(op)}</td>
      <td class="an-tbl--r">${d.total}</td>
      <td class="an-tbl--r ${d.unavail   > 0 ? 'an-cell--warn'   : ''}">${d.unavail}</td>
      <td class="an-tbl--r">${_pct(d.unavail, d.total)}%</td>
      <td class="an-tbl--r ${d.highRisk  > 0 ? 'an-cell--danger' : ''}">${d.highRisk}</td>
      <td class="an-tbl--r ${d.openWR    > 0 ? 'an-cell--accent' : ''}">${d.openWR}</td>
    </tr>`).join('');
  return `<table class="an-table"><thead>${headerRow}</thead><tbody>${dataRows}</tbody></table>`;
}

function _renderVendors(c) {
  if (!c.vendSorted.length) return '<span class="an-empty">No vendor data — run a relay sync first</span>';
  const maxCount = c.vendSorted[0][1];
  const rows = c.vendSorted.map(([vendor, count]) => `
    <div class="an-vend-row">
      <span class="an-vend-name" title="${_safe(vendor)}">${_safe(vendor)}</span>
      <div class="an-vend-bar-wrap">${_bar(count, maxCount, 'vendor')}</div>
      <span class="an-vend-count">${count}</span>
    </div>`).join('');
  return `<div class="an-vend-chart">${rows}</div>`;
}

function _renderPM(c) {
  const items = [
    { label: 'PM B', overdue: c.pmBOver, soon: c.pmBSoon },
    { label: 'PM X', overdue: c.pmXOver, soon: c.pmXSoon },
    { label: 'DOT',  overdue: c.dotOver, soon: c.dotSoon  },
  ];
  return `
    <div class="an-pm-wrap">
      ${items.map(item => `
        <div class="an-pm-card">
          <div class="an-pm-card__title">${item.label}</div>
          <div class="an-pm-card__rows">
            <div class="an-pm-row an-pm-row--over">
              <span class="an-pm-dot an-pm-dot--over"></span>
              <span class="an-pm-lbl">Overdue</span>
              <span class="an-pm-val ${item.overdue > 0 ? 'an-pm-val--danger' : ''}">${item.overdue}</span>
            </div>
            <div class="an-pm-row an-pm-row--soon">
              <span class="an-pm-dot an-pm-dot--soon"></span>
              <span class="an-pm-lbl">Due ≤14 days</span>
              <span class="an-pm-val ${item.soon > 0 ? 'an-pm-val--warn' : ''}">${item.soon}</span>
            </div>
          </div>
        </div>`).join('')}
    </div>`;
}

function _renderBodyTypes(c) {
  if (!c.btSorted.length) return '<span class="an-empty">No data</span>';
  const maxCount = c.btSorted[0][1];
  const rows = c.btSorted.map(([bt, count]) => `
    <div class="an-bt-row">
      <span class="an-bt-label" title="${_safe(bt)}">${_safe(bt)}</span>
      <div class="an-bt-bar-wrap">${_bar(count, maxCount, 'bodytype')}</div>
      <span class="an-bt-count">${count}</span>
      <span class="an-bt-pct">${_pct(count, c.total)}%</span>
    </div>`).join('');
  return `<div class="an-bt-chart">${rows}</div>`;
}

// ── Long Dwell Units (Analytics tab, 2026-07-20) ───────────────────────────
// Units currently unavailable and down for an extended period. Delay reason
// / escalation level / summary are user-entered and persisted server-side
// via long-dwell:* IPC (src/ipc/long-dwell.js) -- NOT stored on the fleet row
// itself, because fleetData rows are wholly replaced on every sync/relay
// pull and would silently wipe any annotation on the next refresh.
//
// Fixed enums -- MUST stay in sync with src/ipc/long-dwell.js's server-side
// validation lists (that file is the source of truth; a mismatch here would
// just mean the dropdown offers a value the server then rejects).
const DELAY_REASONS = [
  'Primary Vendor', 'Parts Delay', 'Offsite Shop', 'Estimate Process',
  'Payment', 'Speciality Vendor', 'Out of Scope for FAS',
  'End of Life Review', 'PMR', 'MCS SW Miss', 'Weather', 'Towing',
  'Reconditioning', 'Repaired',
];
const ESCALATION_LEVELS = ['SEV5', 'SEV4', 'SEV3', 'SEV2']; // SEV2 = highest

let _longDwellData  = {};        // { equipmentId: { delayReason, escalationLevel, summary, updatedAt } }
let _activeTab      = 'overview'; // 'overview' | 'longdwell'
let _dwellThreshold = 14;         // days -- matches the app's existing "Stuck 14d+" convention (toolbar.js / unit-detail.js downDays() red threshold)

// Long Dwell filters (2026-07-20) -- '' means "any" / no filter applied.
// Domicile/Vendor are read straight off the fleet row; Delay Reason and
// Escalation Level are NOT on the row (they live in _longDwellData, the
// user-entered store), so filtering by those requires a join against that
// store rather than a plain row.field comparison.
let _filterDomicile      = '';
let _filterOperator      = '';
let _filterVendor        = '';
let _filterDelayReason   = '';
let _filterEscalation    = '';

// Long Dwell sort state (2026-07-21). Default matches the table's original
// fixed behavior exactly (longest-down first) so nothing changes on screen
// until a user actually clicks a column header.
let _sortColumn = 'downDays'; // 'unit' | 'domicile' | 'downDays' | 'vendor' | 'delayReason' | 'escalation'
let _sortDir    = 'desc';     // 'asc' | 'desc'

// Escalation has a real severity order (SEV2 = worst) that plain alphabetical
// sort would get backwards (SEV2 < SEV3 < SEV4 < SEV5 alphabetically happens
// to match, but relying on that would be a coincidence, not a guarantee --
// this makes the intended order explicit and correct regardless).
const ESCALATION_RANK = { SEV2: 0, SEV3: 1, SEV4: 2, SEV5: 3 };

function _ldCompare(a, b, col) {
  switch (col) {
    case 'unit':     return (a.row.equipmentId || '').localeCompare(b.row.equipmentId || '', undefined, { numeric: true });
    case 'domicile': return (a.row.domicileSite || a.row.domicile || '').localeCompare(b.row.domicileSite || b.row.domicile || '');
    case 'operator': return (a.row.operator || '').localeCompare(b.row.operator || '');
    case 'vendor':   return (a.row.vendor || '').localeCompare(b.row.vendor || '');
    case 'delayReason': {
      const av = (_longDwellData[a.row.equipmentId] || {}).delayReason || '';
      const bv = (_longDwellData[b.row.equipmentId] || {}).delayReason || '';
      return av.localeCompare(bv);
    }
    case 'escalation': {
      const av = ESCALATION_RANK[(_longDwellData[a.row.equipmentId] || {}).escalationLevel];
      const bv = ESCALATION_RANK[(_longDwellData[b.row.equipmentId] || {}).escalationLevel];
      // Unset escalation sorts last regardless of direction (it's genuinely
      // "unknown severity", not "low severity" -- treating it as either
      // extreme would misrepresent it).
      if (av === undefined && bv === undefined) return 0;
      if (av === undefined) return 1;
      if (bv === undefined) return -1;
      return av - bv;
    }
    case 'downDays':
    default:
      return a.dd - b.dd;
  }
}

// Small arrow indicator next to whichever column header is currently active.
function _sortArrow(col) {
  if (_sortColumn !== col) return '';
  return _sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
}

// FIX (confirmed live, 2026-07-20): unit-detail.js's downDays() does
// `new Date(unit.created).getTime()` directly, but row.created frequently
// comes through as a human display string with a trailing elapsed-time
// annotation baked in by the scraper -- e.g.
// "Jul 7, 2026 10:27AM -04:00 (13 days ago)" -- which `new Date()` cannot
// parse (returns Invalid Date -> NaN). That silently makes ANY date-diff
// math run directly against this field wrong (not throw -- just wrong,
// since NaN comparisons are always false), for every unit whose created
// field has this format. This almost certainly also affects unit-detail.js's
// own vitals-card red/orange/green "days down" threshold coloring, though
// that's out of scope to fix here.
// Prefer the scraper's own already-computed "(N days ago)" suffix when
// present (always reliable regardless of the surrounding date format);
// fall back to Date-parsing the raw string only if no such suffix exists.
function _downDays(row) {
  const ts = row.created;
  if (!ts) return null;
  const s = String(ts);
  const dm = s.match(/\((\d+)\s*days?\s*ago\)/i);
  if (dm) return parseInt(dm[1], 10);
  const hm = s.match(/\((\d+)\s*hours?\s*ago\)/i);
  if (hm) return 0; // less than a full day down
  const ym = s.match(/\((\d+)\s*years?\s*ago\)/i);
  if (ym) return parseInt(ym[1], 10) * 365;
  const mm = s.match(/\((\d+)\s*months?\s*ago\)/i);
  if (mm) return parseInt(mm[1], 10) * 30;
  // Singular relative phrasing has no leading digit ("a month ago", "an hour ago").
  if (/\(an?\s+year\s+ago\)/i.test(s)) return 365;
  if (/\(an?\s+month\s+ago\)/i.test(s)) return 30;
  if (/\(an?\s+day\s+ago\)/i.test(s)) return 1;
  if (/\(an?\s+hour\s+ago\)/i.test(s)) return 0;
  // Fallback: strip any trailing "(...)" relative-time annotation before
  // attempting a straight Date parse -- the raw string (with the
  // parenthetical still attached) never parses successfully otherwise.
  const stripped = s.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const d = new Date(stripped || s);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}


// Base set -- threshold + unavailable only, NO domicile/vendor/delay/escalation
// filters applied. This is what filter dropdown OPTIONS are built from, so
// picking one filter (e.g. a domicile) never causes another dropdown's
// available choices to shrink to nothing -- all dropdowns always reflect
// the full long-dwell candidate pool, independent of each other.
function _computeLongDwellBase(rows) {
  return rows
    .map(r => ({ row: r, dd: _downDays(r) }))
    .filter(x => x.dd !== null && x.dd >= _dwellThreshold
      && (x.row.lifecycleState || '').toLowerCase().includes('unavailable'))
    .sort((a, b) => b.dd - a.dd);
}

// Filtered set -- base set + Domicile / Vendor (from the row) + Delay
// Reason / Escalation Level (joined against _longDwellData, since those
// two fields are user-entered and not present on the fleet row itself).
// This is what actually renders in the table / feeds the count badge / TSV
// export -- every one of those three call sites must see the same list.
function _computeLongDwell(rows) {
  const filtered = _computeLongDwellBase(rows).filter(({ row }) => {
    if (_filterDomicile && (row.domicileSite || row.domicile || '') !== _filterDomicile) return false;
    if (_filterOperator && (row.operator || '') !== _filterOperator) return false;
    if (_filterVendor && (row.vendor || '') !== _filterVendor) return false;
    if (_filterDelayReason || _filterEscalation) {
      const saved = _longDwellData[row.equipmentId] || {};
      if (_filterDelayReason && saved.delayReason !== _filterDelayReason) return false;
      if (_filterEscalation && saved.escalationLevel !== _filterEscalation) return false;
    }
    return true;
  });
  // Overrides _computeLongDwellBase()'s fixed "longest down first" sort
  // with whatever column/direction the user has actually clicked -- see
  // _sortColumn/_sortDir above. Sorted AFTER filtering (cheaper: sorts a
  // smaller list) but the result is identical either order since filtering
  // doesn't depend on rank.
  return filtered.sort((a, b) => {
    const c = _ldCompare(a, b, _sortColumn);
    return _sortDir === 'asc' ? c : -c;
  });
}


// Distinct, sorted Domicile/Vendor values across the base set -- used to
// populate the filter dropdown <option> lists.
function _longDwellFilterChoices(rows) {
  const base = _computeLongDwellBase(rows);
  const doms = new Set(), ops = new Set(), vendors = new Set();
  for (const { row } of base) {
    const d = row.domicileSite || row.domicile || '';
    const o = row.operator || '';
    const v = row.vendor || '';
    if (d) doms.add(d);
    if (o) ops.add(o);
    if (v) vendors.add(v);
  }
  return {
    domiciles: [...doms].sort(),
    operators: [...ops].sort(),
    vendors:   [...vendors].sort(),
  };
}



function _escSeverityCls(level) {
  if (level === 'SEV2') return 'sev2';
  if (level === 'SEV3') return 'sev3';
  if (level === 'SEV4') return 'sev4';
  if (level === 'SEV5') return 'sev5';
  return '';
}

function _optionsHtml(options, selected) {
  return ['<option value="">-- select --</option>']
    .concat(options.map(o => `<option value="${_safe(o)}" ${o === selected ? 'selected' : ''}>${_safe(o)}</option>`))
    .join('');
}

async function _refreshLongDwellData() {
  try {
    _longDwellData = (await longDwellBridge.getAll()) || {};
  } catch (e) {
    console.warn('[analytics] failed to load long-dwell data:', e);
  }
}

// Strips dollar amounts before anything derived from row data reaches an AI
// prompt or a copy-paste export -- mirrors src/orcha/deep-scan.js's
// _stripCosts() (Node-side, not importable into the renderer bundle) so the
// same "no cost figures in a leadership-facing summary" rule applies here.
function _stripCosts(text) {
  if (!text) return text;
  return String(text)
    .replace(/\s*\$[\d,]+\.?\d*\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Compact context block for the AI prompt -- same source fields deep-scan.js
// already reads off a merged row (repairTimeline / issueSummary / savedNotes
// / fullConversation), truncated so a single unit's prompt stays reasonable.
function _sourceContextForRow(row) {
  const parts = [];
  if (row.issueDetails)   parts.push('Issue: ' + _stripCosts(String(row.issueDetails)).slice(0, 300));
  if (row.issueSummary)   parts.push('Summary so far: ' + _stripCosts(String(row.issueSummary)).slice(0, 300));
  if (row.repairTimeline) parts.push('Repair timeline:\n' + _stripCosts(String(row.repairTimeline)).slice(0, 1200));
  else if (row.savedNotes) parts.push('Notes: ' + _stripCosts(String(row.savedNotes)).slice(0, 500));
  let conv = row.fullConversation || row.lastConversation || row.conversation || '';
  if (conv) {
    const cs = conv.indexOf('Conversation');
    if (cs > 0) conv = conv.substring(cs);
    parts.push('Vendor/WO conversation:\n' + _stripCosts(String(conv)).slice(0, 1500));
  }
  return parts.length ? parts.join('\n\n') : '(no repair notes or conversation on file)';
}

// Builds the AI-fill prompt for one Long Dwell row. Requests strict JSON so
// parsing is a simple regex + JSON.parse (same defensive pattern
// daily-call.js's _runAI already uses for its own AI calls) rather than the
// looser REPAIR_STATUS:/ISSUE: line-regex format deep-scan.js uses -- JSON
// is a better fit here since there are three independent fields to fill.
function _buildAIFillPrompt(row, dd) {
  const id     = row.equipmentId || '';
  const vendor = row.vendor || 'unassigned';
  const dom    = row.domicileSite || row.domicile || 'unknown';
  const op     = row.operator || 'unknown';
  const reason = row.lifecycleReason || 'unknown';
  // Inject TODAY so the AI can compute a real, concrete follow-up date (it has
  // no inherent sense of "now"). Format: "Wed 9/24/2026".
  const _now   = new Date();
  const _dow   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][_now.getDay()];
  const todayStr = _dow + ' ' + (_now.getMonth() + 1) + '/' + _now.getDate() + '/' + _now.getFullYear();
  return (
    'You are Orcha, the AI brain for Fleet Operations. This unit is a LONG DWELL unit -- ' +
    'down and unavailable for an extended period -- and needs a leadership-facing status ' +
    'entry filled in for the Long Dwell Units report.\n\n' +
    'TODAY IS: ' + todayStr + '. Use this to compute a concrete follow-up date.\n\n' +
    'UNIT: ' + id + ' | Vendor: ' + vendor + ' | Domicile: ' + dom + ' | Operator: ' + op + ' | Down ' + dd + ' days | Lifecycle reason: ' + reason + '\n\n' +
    'SOURCE DATA:\n' + _sourceContextForRow(row) + '\n\n' +
    'TASK -- return exactly three fields:\n\n' +
    '1. delayReason -- pick EXACTLY ONE of this fixed list (verbatim, no variation):\n' +
    '   Primary Vendor, Parts Delay, Offsite Shop, Estimate Process, Payment, Speciality Vendor, ' +
    'Out of Scope for FAS, End of Life Review, PMR, MCS SW Miss, Weather, Towing, Reconditioning, Repaired\n\n' +
    '2. escalationLevel -- pick EXACTLY ONE of: SEV5, SEV4, SEV3, SEV2 (SEV2 is the HIGHEST severity, SEV5 the lowest).\n\n' +
    '   SEVERITY RUBRIC (use day count + ETC status + situation to decide):\n' +
    '   SEV5 = 5-14 days down; vendor actively engaged; ETC exists OR repair clearly in progress -> Monitor only\n' +
    '   SEV4 = 7-30 days down; ETC approaching or just passed; needs follow-up -> Request repair status and firm ETC\n' +
    '   SEV3 = 14-60+ days down; ETC significantly past OR vendor unresponsive OR complex/multi-attempt repair OR EOL/SWAP pending -> Active escalation\n' +
    '   SEV2 = 40-150+ days down; no resolution path; major component failure; parts severely backordered; leadership intervention required -> Leadership escalation, Asana ticket required\n\n' +
    '   ESCALATION TRIGGERS (apply BEFORE finalizing the SEV level -- each trigger bumps up one level):\n' +
    '   - No ETC at all -> bump up one SEV level (e.g. SEV4 becomes SEV3)\n' +
    '   - ETC has passed with no update -> bump up one SEV level\n' +
    '   - Vendor rejected repair or marked out of scope for primary vendor -> minimum SEV3, likely SEV2\n' +
    '   - Multiple repair attempts or multiple vendor handoffs -> minimum SEV3\n' +
    '   - DOT-critical safety item (brakes, air systems, steering) -> escalate one level faster than day count alone suggests\n\n' +
    '3. summary -- a STRUCTURED status block in EXACTLY this 7-field format, in this order,\n' +
    '   one field per line, each line starting with "\\u2022 " (bullet + space) then the label\n' +
    '   and a colon. Use a literal \\n between lines. This EXACT format is required for EVERY\n' +
    '   unit -- accidents, EOL, and rentals included (they still fill every field; see below).\n\n' +
    '   The 7 fields (verbatim labels, in this order):\n' +
    '   \\u2022 Initial Issue Reported: <what the unit originally came in for -- the reported problem>\n' +
    '   \\u2022 Primary Vendor Rejection: <if the primary vendor rejected/declined/routed it out, WHY and where it went; else "N/A">\n' +
    '   \\u2022 Primary Barrier: <the single biggest thing blocking completion right now -- parts, estimate approval, payment, vendor capacity, diagnosis, etc.>\n' +
    '   \\u2022 Actions Taken: <write in FIRST PERSON, past tense, as the actions I (the fleet coordinator)\n' +
    '        personally took -- lead with strong ownership verbs (Diagnosed, Coordinated, Escalated,\n' +
    '        Expedited, Secured, Drove, Followed up, Opened, Confirmed, Pushed). Professional and\n' +
    '        proactive so it reflects well on me. Example: "Diagnosed with Cummins, opened parts SIM,\n' +
    '        expedited the RDC order, and escalated to MCS for firm ETC." Base it ONLY on what the source\n' +
    '        shows actually happened -- do NOT invent actions, vendor calls, or follow-ups that are not in\n' +
    '        the source; frame the REAL actions in the strongest, most ownership-forward professional light.>\n' +
    '   \\u2022 Repair Status: <where the repair stands right now -- e.g. "Awaiting parts", "In repair", "Estimate pending approval", "Diagnosis in progress">\n' +
    '   \\u2022 ETC: <estimated completion date if known; if none, "Pending \\u2014 <reason>" e.g. "Pending \\u2014 turbo backordered">\n' +
    '   \\u2022 Follow-up date: <a CONCRETE calendar date (M/D) when we should next follow up to get a status\n' +
    '        update -- ALWAYS an actual date, computed from TODAY, never "Follow-up required" or a bare owner.\n' +
    '        You MAY prefix the owner, e.g. "FAS follow-up 9/26" or "MCS follow-up by 9/25", but the DATE is mandatory.>\n\n' +
    '   FOLLOW-UP DATE RULE (this field must ALWAYS be a real M/D date computed from TODAY):\n' +
    '   - Pick the date based on urgency, then write it as M/D (e.g. "9/26"):\n' +
    '       * Vendor unresponsive / no update logged / DOT-critical / SEV2-SEV3 -> follow up in 1-2 days from today.\n' +
    '       * Estimate pending approval or awaiting vendor resubmission -> follow up in 2-3 days from today.\n' +
    '       * Parts backordered / long lead time -> follow up in ~7 days from today (or the day AFTER the stated\n' +
    '         parts ETA if one exists in the source).\n' +
    '       * A firm ETC exists -> follow up the day AFTER that ETC.\n' +
    '   - Compute the date from TODAY (given above) and output the resulting M/D. Do NOT output words like\n' +
    '     "Follow-up required", "TBD", "Pending", or an owner with no date -- this field is never allowed to be dateless.\n' +
    '   - EXCEPTION UNITS (accident / EOL / rental) are the ONLY case where Follow-up date may be "N/A".\n\n' +
    '   FILL RULES (apply to every field):\n' +
    '   - Ground EVERY field ONLY in the SOURCE DATA above. NEVER invent a part, link, owner,\n' +
    '     vendor, or rejection that is not supported by the source. (The Follow-up date is the ONE\n' +
    '     allowed computed value -- it is derived from today + urgency, per the rule above.)\n' +
    '   - If a field genuinely does not apply, write "N/A" (e.g. no vendor rejection -> "Primary Vendor Rejection: N/A").\n' +
    '   - If a field applies but the value is unknown from the source, write "Pending \\u2014 <short reason>"\n' +
    '     (never leave a field blank after the colon). This does NOT apply to Follow-up date, which is always a date.\n' +
    '   - If a Parts SIM/ticket link appears in the source, include the actual link in "Primary Barrier"\n' +
    '     or "Actions Taken" (whichever fits). Never fabricate a link.\n' +
    '   - Keep each field to one concise line. Be specific: vendor names, part names, dates, days down.\n' +
    '   - EXCEPTION UNITS (accident / EOL / rental): still use all 7 fields, but they are not within FAS\n' +
    '     control, so ETC and Follow-up date may be "N/A" and Primary Barrier states the situation\n' +
    '     (e.g. "Primary Barrier: Accident \\u2014 CEI managing", "ETC: N/A", "Follow-up date: N/A"). For ALL\n' +
    '     other (FAS-controlled) units, Follow-up date MUST be a concrete M/D date per the rule above.\n' +
    '   - NEVER include dollar amounts, personal names, phone numbers, emails, VINs.\n' +
    '   - Allowed: vendor names, dealer locations, case/SIM numbers, part names, SIM links, dates, ETAs.\n\n' +
    '   EXAMPLE summary value (note the literal \\n between lines):\n' +
    '   "\\u2022 Initial Issue Reported: Turbo failure, no-start.\\n\\u2022 Primary Vendor Rejection: N/A\\n' +
    '\\u2022 Primary Barrier: Turbo backordered (PN 5581552).\\n\\u2022 Actions Taken: Diagnosed with Cummins, opened the parts SIM, expedited the RDC order, and escalated to MCS for a firm ETC.\\n' +
    '\\u2022 Repair Status: Awaiting parts.\\n\\u2022 ETC: Pending \\u2014 turbo backordered.\\n\\u2022 Follow-up date: FAS follow-up 8/18"\n\n' +
    'RESPOND WITH RAW JSON ONLY -- no markdown, no code fences, no explanation, exactly this shape\n' +
    '(the summary value is a single JSON string containing the 7 bulleted lines separated by \\n):\n' +
    '{"delayReason": "...", "escalationLevel": "...", "summary": "..."}'
  );
}

// Freshness window for a unit's relay data before an AI Fill. If the unit's
// cached relay data is older than this, refresh it (live re-scrape + per-unit
// deep-scan) so the summary is built from current data — not stale/inaccurate
// info. 30 minutes per the agreed rule.
const LD_FRESH_MS = 30 * 60 * 1000;

// _ensureUnitFresh — before filling, guarantee this unit's relay data is fresh.
// Reads relay.getUnitCache(id)._cachedAt; if <=30 min old, returns the current
// row unchanged. If older (or unknown), live-refreshes the unit's relay data
// (relay.refreshUnit) then runs a per-unit deep-scan (ai.deepProcess) so the
// timeline/summary are regenerated from the fresh data, and returns the fresh
// row. Degrades gracefully: any step failing falls back to the existing row so
// the fill still proceeds (never blocks the user on a flaky backend).
// `onStatus(text)` is optional (used by Fill-All to show progress).
async function _ensureUnitFresh(unitId, onStatus) {
  const rowsNow = () => (state.slice('fleet').rows || []);
  const findRow = () => rowsNow().find(r => r.equipmentId === unitId) || null;
  let row = findRow();

  // Determine data age from the relay cache _cachedAt (the real vendor-data
  // freshness marker). Missing/unparseable => treat as stale.
  let ageMs = Infinity;
  try {
    const cache = await relayBridge.getUnitCache(unitId);
    const cachedAt = cache && (cache._cachedAt || cache.cachedAt);
    if (cachedAt) ageMs = Date.now() - Number(cachedAt);
  } catch (_) { /* treat as stale */ }

  if (ageMs <= LD_FRESH_MS) {
    return { row, refreshed: false, ageMin: Math.round(ageMs / 60000) };
  }

  // Stale — refresh this one unit's relay data, then deep-scan it.
  try {
    if (onStatus) onStatus('Refreshing ' + unitId + ' (data ' + (ageMs === Infinity ? 'unknown' : Math.round(ageMs / 60000) + 'min') + ' old)\u2026');
    if (relayBridge && relayBridge.refreshUnit) {
      const rr = await relayBridge.refreshUnit(unitId);
      if (rr && rr.unit) row = rr.unit; // fresh merged row from main
    }
  } catch (e) { /* non-fatal — fall through to deep-scan / existing row */ }

  try {
    if (onStatus) onStatus('Deep-scanning ' + unitId + '\u2026');
    if (aiBridge && aiBridge.deepProcess) {
      const dp = await aiBridge.deepProcess([unitId]);
      const u = dp && Array.isArray(dp.units) ? dp.units.find(x => x.equipmentId === unitId) : null;
      if (u && row) {
        // Overlay the freshly regenerated AI fields onto the row we'll summarize.
        if (u.issueSummary)   { row.issueSummary = u.issueSummary; row.issue = u.issueSummary; }
        if (u.repairTimeline) row.repairTimeline = u.repairTimeline;
        if (u.notes)          row.savedNotes = u.notes;
      }
    }
  } catch (e) { /* non-fatal — use whatever row we have */ }

  // Prefer the latest row from state (main may have pushed an update mid-refresh).
  row = findRow() || row;
  return { row, refreshed: true, ageMin: ageMs === Infinity ? null : Math.round(ageMs / 60000) };
}

// Runs the AI fill for one row, validates the result against the fixed
// enums (never trust the model to stay in-list; the long-dwell:save-unit
// IPC handler also validates server-side and would throw on anything else),
// updates that row's DOM in place, and persists via the same saveUnit path
// manual edits use.
//
// FRESHNESS (2026): before summarizing, ensure the unit's relay data is <=30
// min old; if not, refresh + deep-scan just this unit so the summary reflects
// current vendor/repair data. `onStatus` is optional progress reporting.
async function _aiFillRow(unitId, tr, onStatus) {
  if (!tr) return false;
  let row = (state.slice('fleet').rows || []).find(r => r.equipmentId === unitId);
  if (!row) { toast.show('warn', 'Unit not found in current fleet data', 3000); return false; }

  const btn = tr.querySelector('[data-action="ai-fill"]');
  tr.classList.add('an-ld-row--ai-loading');
  if (btn) { btn.disabled = true; btn.textContent = '\u2728 Filling...'; }

  try {
    if (!aiBridge || !aiBridge.ask) throw new Error('AI bridge not available');
    // Guarantee fresh data first (refresh + deep-scan if stale).
    if (btn && onStatus === undefined) btn.textContent = '\u2728 Refreshing...';
    const fresh = await _ensureUnitFresh(unitId, onStatus);
    if (fresh.row) row = fresh.row;
    if (btn && onStatus === undefined) btn.textContent = '\u2728 Filling...';
    const dd = _downDays(row);
    const prompt = _buildAIFillPrompt(row, dd == null ? 0 : dd);
    const result = await aiBridge.ask(prompt);
    if (!result || result.ok === false) throw new Error((result && result.error) || 'AI call failed');
    const text = result.text || '';
    const jm = text.match(/\{[\s\S]*\}/);
    if (!jm) throw new Error('AI response was not JSON');
    let parsed;
    try { parsed = JSON.parse(jm[0]); } catch (e) { throw new Error('Could not parse AI JSON: ' + e.message); }

    let delayReason     = String(parsed.delayReason || '').trim();
    let escalationLevel = String(parsed.escalationLevel || '').trim().toUpperCase();
    let summary         = _stripCosts(String(parsed.summary || '').trim()).slice(0, 1500);

    if (!DELAY_REASONS.includes(delayReason))     delayReason     = '';
    if (!ESCALATION_LEVELS.includes(escalationLevel)) escalationLevel = '';

    const dSel = tr.querySelector('[data-field="delayReason"]');
    const eSel = tr.querySelector('[data-field="escalationLevel"]');
    const sTa  = tr.querySelector('[data-field="summary"]');
    if (dSel && delayReason)     dSel.value = delayReason;
    if (eSel && escalationLevel) { eSel.value = escalationLevel; eSel.className = 'settings__select an-ld-select an-ld-esc-select an-ld-esc--' + _escSeverityCls(escalationLevel); }
    if (sTa)                     sTa.value  = summary;

    const woKey = (tr.dataset && tr.dataset.woId) || 'primary';
    const res = await longDwellBridge.saveUnit({ equipmentId: unitId, woKey, delayReason, escalationLevel, summary });
    if (res && res.unit) _longDwellData[_ldKey(unitId, woKey)] = res.unit;
    _flashSavedRow(tr);
    toast.show('success', 'AI filled ' + unitId, 2000);
    return true;
  } catch (e) {
    toast.show('error', 'AI fill failed for ' + unitId + ': ' + e.message, 4000);
    return false;
  } finally {
    tr.classList.remove('an-ld-row--ai-loading');
    if (btn) { btn.disabled = false; btn.textContent = '\u2728 AI Fill'; }
  }
}

// Same shape as _optionsHtml() but with a filter-appropriate "All ..." /
// "Any ..." default label instead of "-- select --" (that label reads
// wrong for a filter -- an unfilled table cell and an inactive filter are
// different concepts to the user, even though the underlying HTML is
// nearly identical).
function _filterOptionsHtml(options, selected, allLabel) {
  return [`<option value="">${_safe(allLabel)}</option>`]
    .concat(options.map(o => `<option value="${_safe(o)}" ${o === selected ? 'selected' : ''}>${_safe(o)}</option>`))
    .join('');
}

function _renderLongDwellHeader(rows) {
  const count   = _computeLongDwell(rows).length;
  const choices = _longDwellFilterChoices(rows);
  const anyFilterActive = _filterDomicile || _filterOperator || _filterVendor || _filterDelayReason || _filterEscalation;
  return `
    <div class="an-ld-toolbar">
      <div class="an-ld-toolbar-row">
        <span class="an-ld-count">${count}</span> unit(s) down &ge;
        <input id="an-ld-threshold" type="number" min="1" value="${_dwellThreshold}" class="settings__input an-ld-threshold-input" />
        days
        <div class="an-ld-toolbar-actions">
          <button id="an-ld-fill-all" class="ec-preset-btn" title="AI-fill Delay Reason / Escalation / Summary for every row that's still blank">\u2728 AI Fill All (blank rows)</button>
          <button id="an-ld-copy" class="ec-preset-btn" title="Copy this table as a paste-ready block (Excel/Outlook/Slack)">\uD83D\uDCCB Copy Table</button>
        </div>
      </div>
      <div class="an-ld-toolbar-row an-ld-filter-row">
        <label class="an-ld-filter-label">Domicile
          <select id="an-ld-filter-domicile" class="settings__select an-ld-filter-select">
            ${_filterOptionsHtml(choices.domiciles, _filterDomicile, 'All Domiciles')}
          </select>
        </label>
        <label class="an-ld-filter-label">Operator
          <select id="an-ld-filter-operator" class="settings__select an-ld-filter-select">
            ${_filterOptionsHtml(choices.operators, _filterOperator, 'All Operators')}
          </select>
        </label>
        <label class="an-ld-filter-label">Vendor
          <select id="an-ld-filter-vendor" class="settings__select an-ld-filter-select">
            ${_filterOptionsHtml(choices.vendors, _filterVendor, 'All Vendors')}
          </select>
        </label>
        <label class="an-ld-filter-label">Delay Reason
          <select id="an-ld-filter-delay" class="settings__select an-ld-filter-select">
            ${_filterOptionsHtml(DELAY_REASONS, _filterDelayReason, 'Any Reason')}
          </select>
        </label>
        <label class="an-ld-filter-label">Escalation
          <select id="an-ld-filter-esc" class="settings__select an-ld-filter-select">
            ${_filterOptionsHtml(ESCALATION_LEVELS, _filterEscalation, 'Any Level')}
          </select>
        </label>
        ${anyFilterActive ? '<button id="an-ld-filter-clear" class="ec-preset-btn" title="Clear all filters">\u2715 Clear filters</button>' : ''}
      </div>
    </div>`;
}

// Tab-separated export -- pastes as real columns into Excel/Outlook tables,
// and reads fine as plain text in Slack/email too. Summary text is
// single-lined (newlines -> spaces) since a literal newline inside a TSV
// cell would shift every following row out of alignment when pasted.
function _buildLongDwellTsv(rows) {
  const list = _computeLongDwell(rows);
  const header = ['Unit', 'Work Order', 'Reason', 'Domicile', 'Operator', 'Down Days', 'Vendor', 'Delay Reason', 'Escalation Level', 'Summary'];
  const lines = [header.join('\t')];
  // One line PER WORK ORDER, matching the on-screen table.
  for (const { row, dd } of list) {
    const id  = row.equipmentId || '';
    const dom = row.domicileSite || row.domicile || '';
    const op  = row.operator || '';
    for (const wo of _expandRowToWOs(row)) {
      const saved   = _savedForWO(id, wo.woKey, wo.isPrimary);
      const vendor  = wo.woVendor || row.vendor || '';
      const woLabel = wo.woAmz || wo.woNumber || (wo.woType === 'planned' ? 'Planned WR' : (wo.isPrimary ? 'Primary WR' : 'Open WR'));
      const reason  = String(wo.woReason || '').replace(/\r?\n/g, ' ').trim();
      const summary = String(saved.summary || '').replace(/\r?\n/g, ' ').trim();
      lines.push([id, woLabel, reason, dom, op, dd + 'd', vendor, saved.delayReason || '', saved.escalationLevel || '', summary].join('\t'));
    }
  }
  return lines.join('\n');
}


async function _copyLongDwellTable(rows) {
  const tsv = _buildLongDwellTsv(rows);
  try {
    await navigator.clipboard.writeText(tsv);
  } catch (e) {
    // Fallback for environments without clipboard permission (same pattern
    // as daily-call.js's _copyTable()).
    const ta = document.createElement('textarea');
    ta.value = tsv;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
    document.body.removeChild(ta);
  }
}

// ── Per-work-order expansion ────────────────────────────────────────────────
// A unit can have multiple open work orders (e.g. an unplanned repair + a
// planned PM). Long Dwell shows ONE ROW PER WORK ORDER so each WO gets its own
// delay reason / escalation / summary. This helper turns one fleet row into
// N "WO views": the PRIMARY work order (the flat top-level WR fields on the
// row) plus any row._secondaryWRs (the multi-WR pass array). Single-WO units
// yield exactly one entry, so behavior is unchanged for them.

// Extract a stable service UUID from a Relay service URL, if present.
function _uuidFromUrl(url) {
  const m = String(url || '').match(/\/service\/([0-9a-f-]{8,})/i);
  return m ? m[1] : '';
}

// Stable per-WO key for one WO view. Prefer the Relay service UUID (survives
// re-syncs and WO reassignment detection), then the vendor WO id, then a
// positional fallback so a WO without any id still gets a distinct, stable-ish
// key within its unit.
function _woKeyFor(wo, idx) {
  return String(
    wo._serviceUUID
    || _uuidFromUrl(wo._relayUrl || wo.serviceUrl)
    || wo.vendorWorkOrderId
    || (idx === 0 ? 'primary' : 'wo' + idx)
  ).trim() || ('wo' + idx);
}

// Compound store key: one saved annotation per (unit, work order).
function _ldKey(equipmentId, woKey) {
  return String(equipmentId || '').trim() + '::' + String(woKey || 'primary').trim();
}

// Look up the saved annotation for a WO, with backward-compat fallback to the
// old unit-only key so annotations saved before the per-WO change still show
// (on the unit's PRIMARY work order row).
function _savedForWO(equipmentId, woKey, isPrimary) {
  const compound = _longDwellData[_ldKey(equipmentId, woKey)];
  if (compound) return compound;
  if (isPrimary) {
    const legacy = _longDwellData[String(equipmentId || '').trim()];
    if (legacy) return legacy;
  }
  return {};
}

// Expand one fleet row into its list of WO views. Each view carries the WO's
// own identifying/status fields plus a reference back to the parent row (used
// for domicile/operator/vendor/down-days and the AI prompt source).
function _expandRowToWOs(row) {
  const views = [];
  const primaryKey = _woKeyFor({
    _serviceUUID: '', _relayUrl: row.serviceUrl, serviceUrl: row.serviceUrl,
    vendorWorkOrderId: row.vendorWorkOrderId,
  }, 0);
  views.push({
    row,
    isPrimary:  true,
    woKey:      primaryKey,
    woNumber:   row.vendorWorkOrderId || row.workRequestId || '',
    woAmz:      row.alternativeId || row.altId || '',
    woReason:   _woShortReason(row),
    woStatus:   row.serviceState || '',
    woVendor:   row.vendor || '',
    woUrl:      row.serviceUrl || '',
    woType:     'primary',
  });

  const sec = Array.isArray(row._secondaryWRs) ? row._secondaryWRs : [];
  sec.forEach((wo, i) => {
    const k = _woKeyFor(wo, i + 1);
    if (k === primaryKey) return; // dedup: secondary resolved to primary UUID
    views.push({
      row,
      isPrimary:  false,
      woKey:      k,
      woNumber:   wo.vendorWorkOrderId || '',
      woAmz:      wo.alternativeId || wo.altId || '',
      woReason:   _woShortReason(wo),
      woStatus:   wo.serviceState || wo.state || '',
      woVendor:   wo.vendor || row.vendor || '',
      woUrl:      wo._relayUrl || '',
      woType:     wo._wrType || 'unplanned',
    });
  });
  return views;
}

// A really short, human reason for a work order, for the Long Dwell WO cell.
// Prefers the vendor cause, then the AI issue summary, then raw issue details.
// Kept tight (~60 chars) so the cell stays scannable.
function _woShortReason(wo) {
  const raw = String(
    wo.cause
    || (wo.issueSummary ? String(wo.issueSummary).split('TIMELINE:')[0] : '')
    || wo.issueDetails
    || ''
  ).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  return raw.length > 60 ? raw.slice(0, 57).trimEnd() + '\u2026' : raw;
}

function _renderLongDwellTable(rows) {
  const list = _computeLongDwell(rows);
  if (!list.length) {
    return `<span class="an-empty">No units currently down \u2265 ${_dwellThreshold} days.</span>`;
  }
  // Summary/Actions are intentionally left as plain, non-clickable <th>s --
  // free text and a button column have no meaningful sort order.
  const headerRow = `
    <tr>
      <th class="an-ld-sortable" data-sort-col="unit">Unit${_sortArrow('unit')}</th>
      <th>Work Order</th>
      <th class="an-ld-sortable" data-sort-col="domicile">Domicile${_sortArrow('domicile')}</th>
      <th class="an-ld-sortable" data-sort-col="operator">Operator${_sortArrow('operator')}</th>
      <th class="an-tbl--r an-ld-sortable" data-sort-col="downDays">Down Days${_sortArrow('downDays')}</th>
      <th class="an-ld-sortable" data-sort-col="vendor">Vendor${_sortArrow('vendor')}</th>
      <th class="an-ld-sortable" data-sort-col="delayReason">Delay Reason${_sortArrow('delayReason')}</th>
      <th class="an-ld-sortable" data-sort-col="escalation">Escalation${_sortArrow('escalation')}</th>
      <th>Summary</th>
      <th>Actions</th>
    </tr>`;
  // One row PER WORK ORDER: expand each qualifying unit into its WO views
  // (primary WR + any secondary WRs). A unit with 3 open WOs => 3 rows.
  const dataRows = list.flatMap(({ row, dd }) => {
    const id     = row.equipmentId || '';
    const dom    = row.domicileSite || row.domicile || '\u2014';
    const op     = row.operator || '\u2014';
    const ddCls  = dd >= 30 ? 'an-cell--danger' : dd >= 21 ? 'an-cell--warn' : '';
    const wos    = _expandRowToWOs(row);
    const multi  = wos.length > 1;

    return wos.map((wo, i) => {
      const saved  = _savedForWO(id, wo.woKey, wo.isPrimary);
      const vendor = wo.woVendor || row.vendor || '\u2014';
      // Primary label: prefer the AMZ alt ID (what leadership references), then
      // vendor WO#, then a type label. Show vendor WO# as a secondary tag when
      // both exist.
      const woLabel = wo.woAmz || wo.woNumber || (wo.woType === 'planned' ? 'Planned WR' : (wo.isPrimary ? 'Primary WR' : 'Open WR'));
      const woSubTag = (wo.woAmz && wo.woNumber && wo.woNumber !== wo.woAmz)
        ? `<span class="an-ld-wo-sub">${_safe(wo.woNumber)}</span>` : '';
      const woStat  = wo.woStatus ? `<span class="an-ld-wo-status">${_safe(wo.woStatus)}</span>` : '';
      const woLinkOpen  = wo.woUrl ? `<a class="an-ld-wo-link" data-action="open-wo" data-wo-url="${_safe(wo.woUrl)}" title="Open work order in Relay">` : '<span class="an-ld-wo-link">';
      const woLinkClose = wo.woUrl ? '</a>' : '</span>';
      const woReason = wo.woReason ? `<div class="an-ld-wo-reason" title="${_safe(wo.woReason)}">${_safe(wo.woReason)}</div>` : '';
      const unitCell = i === 0
        ? `<td class="an-op-name an-ld-unit-link" data-action="open-unit" title="Open unit detail">${_safe(id)}${multi ? ` <span class="an-ld-wo-count">(${wos.length} WOs)</span>` : ''}</td>`
        : `<td class="an-ld-unit-cont" title="${_safe(id)} \u2014 additional work order">\u21B3</td>`;
      const rowCls = 'an-ld-row' + (multi ? ' an-ld-row--multi' + (i === 0 ? ' an-ld-row--multi-first' : '') : '');
      return `
      <tr data-unit-id="${_safe(id)}" data-wo-id="${_safe(wo.woKey)}" data-wo-primary="${wo.isPrimary ? '1' : '0'}" class="${rowCls}">
        ${unitCell}
        <td class="an-ld-wo-cell">
          <div class="an-ld-wo-idline">${woLinkOpen}${_safe(woLabel)}${woLinkClose}${woSubTag} ${woStat}</div>
          ${woReason}
        </td>
        <td>${_safe(dom)}</td>
        <td>${_safe(op)}</td>
        <td class="an-tbl--r ${ddCls}">${dd}d</td>
        <td>${_safe(vendor)}</td>
        <td>
          <select class="settings__select an-ld-select" data-field="delayReason">
            ${_optionsHtml(DELAY_REASONS, saved.delayReason)}
          </select>
        </td>
        <td>
          <select class="settings__select an-ld-select an-ld-esc-select an-ld-esc--${_escSeverityCls(saved.escalationLevel)}" data-field="escalationLevel">
            ${_optionsHtml(ESCALATION_LEVELS, saved.escalationLevel)}
          </select>
        </td>
        <td>
          <textarea class="settings__textarea an-ld-summary" data-field="summary" placeholder="&#8226; Initial Issue Reported:&#10;&#8226; Primary Vendor Rejection:&#10;&#8226; Primary Barrier:&#10;&#8226; Actions Taken:&#10;&#8226; Repair Status:&#10;&#8226; ETC:&#10;&#8226; Follow-up date:">${_safe(saved.summary || '')}</textarea>
        </td>
        <td>
          <button class="ec-preset-btn an-ld-ai-btn" data-action="ai-fill" title="AI-fill this work order from repair notes">\u2728 AI Fill</button>
        </td>
      </tr>`;
    });
  }).join('');
  return `<table class="an-table an-ld-table"><thead>${headerRow}</thead><tbody>${dataRows}</tbody></table>`;
}

// Rebuilds the Long Dwell tab's toolbar + table from scratch. Deliberately
// NOT wired to the live fleet:data bus event -- this view has free-text
// (summary) and in-progress select inputs; a background sync pushing new
// rows mid-edit would blow away unsaved keystrokes via the innerHTML
// replace below. Instead this only runs on: tab-open, the explicit Refresh
// button, and the threshold input changing -- all user-initiated moments
// where losing in-progress edits is expected/acceptable.
function _renderLongDwellTab(rows) {
  if (!_el) return;
  const toolbarEl = _el.querySelector('#an-ld-toolbar-wrap');
  const tableEl   = _el.querySelector('#an-ld-table-wrap');
  if (toolbarEl) toolbarEl.innerHTML = _renderLongDwellHeader(rows);
  if (tableEl)   tableEl.innerHTML   = _renderLongDwellTable(rows);

  const thInput = _el.querySelector('#an-ld-threshold');
  if (thInput) {
    thInput.addEventListener('change', () => {
      const v = parseInt(thInput.value, 10);
      _dwellThreshold = (Number.isFinite(v) && v > 0) ? v : 14;
      _renderLongDwellTab(state.slice('fleet').rows || []);
    });
  }

  // Filter dropdowns -- each just sets its module-level filter var and
  // does a full re-render, same pattern as the threshold input above.
  // Re-rendering also rebuilds the dropdowns themselves (via
  // _renderLongDwellHeader), so a filter selection is preserved across
  // re-renders because the module-level var, not DOM state, is the source
  // of truth -- see _filterOptionsHtml()'s `selected` param.
  const filterDomSel  = _el.querySelector('#an-ld-filter-domicile');
  const filterOpSel   = _el.querySelector('#an-ld-filter-operator');
  const filterVenSel  = _el.querySelector('#an-ld-filter-vendor');
  const filterDlySel  = _el.querySelector('#an-ld-filter-delay');
  const filterEscSel  = _el.querySelector('#an-ld-filter-esc');
  const filterClearBtn = _el.querySelector('#an-ld-filter-clear');

  if (filterDomSel) filterDomSel.addEventListener('change', () => {
    _filterDomicile = filterDomSel.value;
    _renderLongDwellTab(state.slice('fleet').rows || []);
  });
  if (filterOpSel) filterOpSel.addEventListener('change', () => {
    _filterOperator = filterOpSel.value;
    _renderLongDwellTab(state.slice('fleet').rows || []);
  });
  if (filterVenSel) filterVenSel.addEventListener('change', () => {
    _filterVendor = filterVenSel.value;
    _renderLongDwellTab(state.slice('fleet').rows || []);
  });
  if (filterDlySel) filterDlySel.addEventListener('change', () => {
    _filterDelayReason = filterDlySel.value;
    _renderLongDwellTab(state.slice('fleet').rows || []);
  });
  if (filterEscSel) filterEscSel.addEventListener('change', () => {
    _filterEscalation = filterEscSel.value;
    _renderLongDwellTab(state.slice('fleet').rows || []);
  });
  if (filterClearBtn) filterClearBtn.addEventListener('click', () => {
    _filterDomicile = _filterOperator = _filterVendor = _filterDelayReason = _filterEscalation = '';
    _renderLongDwellTab(state.slice('fleet').rows || []);
  });

  // Toolbar innerHTML is rebuilt every call, so these must be re-wired
  // every time too (same reasoning as the threshold input above).
  const copyBtn = _el.querySelector('#an-ld-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      await _copyLongDwellTable(rows);
      toast.show('success', 'Long Dwell table copied \u2014 paste into Excel, Outlook, or Slack', 2500);
    });
  }

  const fillAllBtn = _el.querySelector('#an-ld-fill-all');
  if (fillAllBtn) {
    fillAllBtn.addEventListener('click', async () => {
      const trs = Array.from(tableEl.querySelectorAll('tr[data-unit-id]'));
      // Only rows with NOTHING entered yet -- a bulk action must never
      // silently overwrite a manually-typed delay reason / escalation /
      // summary. The single-row "AI Fill" button (explicit per-unit click)
      // is where an intentional overwrite is expected instead.
      const blankTrs = trs.filter(tr => {
        const id = tr.dataset.unitId;
        const woKey = tr.dataset.woId || 'primary';
        const isPrimary = tr.dataset.woPrimary === '1';
        const saved = _savedForWO(id, woKey, isPrimary);
        return !saved.delayReason && !saved.escalationLevel && !(saved.summary || '').trim();
      });
      if (!blankTrs.length) { toast.show('info', 'No blank rows to AI-fill', 2500); return; }

      fillAllBtn.disabled = true;
      let done = 0;
      const total = blankTrs.length;
      fillAllBtn.textContent = `\u2728 Filling 0/${total}...`;
      // Sequential (never parallel) so we don't hammer AAP/Relay with concurrent
      // per-unit re-scrapes. Each unit is refreshed + deep-scanned only if its
      // relay data is stale (>30 min); the onStatus callback surfaces that
      // per-unit progress on the button so the user sees what's happening.
      for (const tr of blankTrs) {
        const uid = tr.dataset.unitId;
        const n = done + 1;
        const onStatus = (msg) => { fillAllBtn.textContent = `\u2728 ${n}/${total}: ${msg}`; };
        await _aiFillRow(uid, tr, onStatus);
        done++;
        fillAllBtn.textContent = `\u2728 Filling ${done}/${total}...`;
      }
      fillAllBtn.disabled = false;
      fillAllBtn.textContent = '\u2728 AI Fill All (blank rows)';
      toast.show('success', `AI filled ${done} row(s)`, 2500);
    });
  }
}

function _flashSavedRow(tr) {
  if (!tr) return;
  tr.classList.add('an-ld-row--saved');
  setTimeout(() => tr.classList.remove('an-ld-row--saved'), 900);
}

// ── Full dashboard HTML ─────────────────────────────────────────────────────
function _dashboardHtml() {
  return `
    <div class="an-header">
      <div class="an-header__left">
        <span class="an-title">Analytics</span>
        <span class="an-subtitle">Fleet KPI dashboard — computed from current sync data</span>
      </div>
      <div class="an-header__actions">
        <button id="an-refresh" class="detail-panel__btn detail-panel__btn--secondary">↺ Refresh</button>
        <button id="an-back"    class="detail-panel__btn">Back to Fleet</button>
      </div>
    </div>

    <div class="sd-tabs an-tabs">
      <button class="sd-tab active" data-an-tab="overview">Overview</button>
      <button class="sd-tab" data-an-tab="longdwell">Long Dwell Units</button>
    </div>

    <div id="an-tab-overview" class="an-tab-panel">
      <div class="an-body">

        <!-- Summary bar -->
        <div id="an-summary"></div>

        <!-- Two-col grid: lifecycle + risk -->
        <div class="an-grid-2">
          <div class="an-card">
            <div class="an-card__title">Lifecycle Breakdown</div>
            <div id="an-lifecycle"></div>
          </div>
          <div class="an-card">
            <div class="an-card__title">Risk Distribution</div>
            <div id="an-risk"></div>
          </div>
        </div>

        <!-- PM health + body-type mix -->
        <div class="an-grid-2">
          <div class="an-card">
            <div class="an-card__title">PM Due Dates</div>
            <div class="an-card__hint">Computed from pmB / pmX / DOT fields</div>
            <div id="an-pm"></div>
          </div>
          <div class="an-card">
            <div class="an-card__title">Asset Type Mix</div>
            <div id="an-bodytypes"></div>
          </div>
        </div>

        <!-- Full-width: by-operator -->
        <div class="an-card">
          <div class="an-card__title">By Operator</div>
          <div id="an-operators"></div>
        </div>

        <!-- Full-width: vendor distribution -->
        <div class="an-card">
          <div class="an-card__title">Top Vendors</div>
          <div id="an-vendors"></div>
        </div>

      </div>
    </div>

    <div id="an-tab-longdwell" class="an-tab-panel" style="display:none">
      <div class="an-body">
        <div class="an-card">
          <div class="an-card__title">Long Dwell Units</div>
          <div class="an-card__hint">Units currently unavailable and down for an extended period. Log the delay reason, escalation level, and a short status summary for leadership visibility.</div>
          <div id="an-ld-toolbar-wrap"></div>
          <div id="an-ld-table-wrap"></div>
        </div>
      </div>
    </div>
  `;
}

// ── Render / update ───────────────────────────────────────────────────────
function _update(rows) {
  if (!_el) return;
  const c = _compute(rows);

  const summaryEl   = _el.querySelector('#an-summary');
  const lifecycleEl = _el.querySelector('#an-lifecycle');
  const riskEl      = _el.querySelector('#an-risk');
  const operatorsEl = _el.querySelector('#an-operators');
  const vendorsEl   = _el.querySelector('#an-vendors');
  const pmEl        = _el.querySelector('#an-pm');
  const btEl        = _el.querySelector('#an-bodytypes');

  if (summaryEl)   summaryEl.innerHTML   = _renderSummary(c);
  if (lifecycleEl) lifecycleEl.innerHTML = _renderLifecycle(c);
  if (riskEl)      riskEl.innerHTML      = _renderRisk(c);
  if (operatorsEl) operatorsEl.innerHTML = _renderOperators(c);
  if (vendorsEl)   vendorsEl.innerHTML   = _renderVendors(c);
  if (pmEl)        pmEl.innerHTML        = _renderPM(c);
  if (btEl)        btEl.innerHTML        = _renderBodyTypes(c);
}

// ── Init ───────────────────────────────────────────────────────────────────
export function init(container) {
  _el = document.createElement('div');
  _el.id = 'view-analytics';
  _el.className = 'view view--analytics';
  _el.style.display = 'none';
  _el.innerHTML = _dashboardHtml();
  container.appendChild(_el);

  // Back button
  _el.querySelector('#an-back').addEventListener('click', () => {
    bus.emit('ui:view-change', { from: 'analytics', to: 'fleet' });
  });

  // Manual refresh -- also refreshes the Long Dwell tab (fresh from disk)
  // if it's the one currently open. See _renderLongDwellTab()'s comment for
  // why that tab isn't auto-refreshed by the fleet:data bus event.
  _el.querySelector('#an-refresh').addEventListener('click', async () => {
    const btn = _el.querySelector('#an-refresh');
    btn.disabled = true; btn.textContent = 'Refreshing...';
    _update(state.slice('fleet').rows || []);
    if (_activeTab === 'longdwell') {
      await _refreshLongDwellData();
      _renderLongDwellTab(state.slice('fleet').rows || []);
    }
    btn.disabled = false; btn.textContent = '\u21ba Refresh';
  });

  // Tab switching (Overview / Long Dwell Units)
  _el.querySelectorAll('[data-an-tab]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tab = btn.dataset.anTab;
      if (tab === _activeTab) return;
      _activeTab = tab;
      _el.querySelectorAll('[data-an-tab]').forEach(b => b.classList.toggle('active', b.dataset.anTab === tab));
      _el.querySelector('#an-tab-overview').style.display  = tab === 'overview'  ? '' : 'none';
      _el.querySelector('#an-tab-longdwell').style.display = tab === 'longdwell' ? '' : 'none';
      if (tab === 'longdwell') {
        await _refreshLongDwellData();
        _renderLongDwellTab(state.slice('fleet').rows || []);
      }
    });
  });

  // Long Dwell table -- delegated events (table is rebuilt via innerHTML on
  // every _renderLongDwellTab() call, so listeners must live on the stable
  // wrapper, not the rows themselves).
  const ldTableWrap = _el.querySelector('#an-ld-table-wrap');

  // Select changes (Delay Reason / Escalation Level) -- save immediately.
  ldTableWrap.addEventListener('change', async (e) => {
    const field = e.target.dataset && e.target.dataset.field;
    if (!field || e.target.tagName !== 'SELECT') return;
    const tr = e.target.closest('tr[data-unit-id]');
    if (!tr) return;
    const unitId = tr.dataset.unitId;
    const woKey  = tr.dataset.woId || 'primary';
    const value  = e.target.value;
    if (field === 'escalationLevel') {
      e.target.className = 'settings__select an-ld-select an-ld-esc-select an-ld-esc--' + _escSeverityCls(value);
    }
    try {
      const res = await longDwellBridge.saveUnit({ equipmentId: unitId, woKey, [field]: value });
      if (res && res.unit) _longDwellData[_ldKey(unitId, woKey)] = res.unit;
      _flashSavedRow(tr);
    } catch (err) {
      toast.show('error', 'Save failed: ' + err.message, 3000);
    }
  });

  // Summary textarea -- save on blur (focusout bubbles, unlike blur, so
  // event delegation works here without a capture-phase listener).
  ldTableWrap.addEventListener('focusout', async (e) => {
    if (!(e.target.tagName === 'TEXTAREA' && e.target.dataset.field === 'summary')) return;
    const tr = e.target.closest('tr[data-unit-id]');
    if (!tr) return;
    const unitId = tr.dataset.unitId;
    const woKey  = tr.dataset.woId || 'primary';
    const value  = e.target.value;
    try {
      const res = await longDwellBridge.saveUnit({ equipmentId: unitId, woKey, summary: value });
      if (res && res.unit) _longDwellData[_ldKey(unitId, woKey)] = res.unit;
      _flashSavedRow(tr);
    } catch (err) {
      toast.show('error', 'Save failed: ' + err.message, 3000);
    }
  });

  // Unit ID click -- opens the existing global unit detail overlay (works
  // regardless of current view; see unit-detail.js's ui:unit-select listener).
  // Also handles the per-row "AI Fill" button and sortable column headers
  // in this same delegated listener (table + thead are both rebuilt via
  // innerHTML on every render, so all of this must live on the stable
  // wrapper, not the elements themselves).
  ldTableWrap.addEventListener('click', (e) => {
    const sortTh = e.target.closest('[data-sort-col]');
    if (sortTh) {
      const col = sortTh.dataset.sortCol;
      // Clicking the already-active column flips its direction; clicking a
      // different column switches to it and resets to descending (matches
      // the common "biggest/most-recent first" expectation on first click --
      // e.g. click Down Days and you want the longest-down units first, not
      // buried at the bottom).
      if (_sortColumn === col) {
        _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        _sortColumn = col;
        _sortDir = 'desc';
      }
      _renderLongDwellTab(state.slice('fleet').rows || []);
      return;
    }
    const aiBtn = e.target.closest('[data-action="ai-fill"]');
    if (aiBtn) {
      const tr = aiBtn.closest('tr[data-unit-id]');
      if (tr) _aiFillRow(tr.dataset.unitId, tr);
      return;
    }
    // Work Order link -- open that specific WR in Relay (external browser).
    const woLink = e.target.closest('[data-action="open-wo"]');
    if (woLink) {
      e.preventDefault();
      const url = woLink.dataset.woUrl;
      if (url && filesBridge && filesBridge.openRelayUrl) filesBridge.openRelayUrl(url);
      else if (url) window.open(url, '_blank');
      return;
    }
    const link = e.target.closest('[data-action="open-unit"]');
    if (!link) return;
    const tr = link.closest('tr[data-unit-id]');
    if (!tr) return;
    const unitId = tr.dataset.unitId;
    const row = (state.slice('fleet').rows || []).find(r => r.equipmentId === unitId);
    if (row) bus.emit('ui:unit-select', { unit: row });
  });

  // Reactive update on fleet data push (Overview tab only -- see comment
  // above _renderLongDwellTab() for why the Long Dwell tab is excluded).
  bus.on('fleet:data', (data) => {
    _update((data && data.rows) ? data.rows : []);
  });

  // Show/hide + refresh on view change. Deliberately does NOT reset
  // _activeTab back to 'overview' -- if the user was on Long Dwell Units
  // when they left this view, it stays open when they come back.
  bus.on('ui:view-change', async ({ to }) => {
    _el.style.display = to === 'analytics' ? 'flex' : 'none';
    if (to === 'analytics') {
      _update(state.slice('fleet').rows || []);
      if (_activeTab === 'longdwell') {
        await _refreshLongDwellData();
        _renderLongDwellTab(state.slice('fleet').rows || []);
      }
    }
  });

  // Initial render (data already in state)
  _update(state.slice('fleet').rows || []);
  // Warm the long-dwell cache in the background so the tab opens instantly
  // the first time the user clicks it (still re-fetched fresh on open/tab
  // switch, so this is purely a latency optimization, not a correctness dependency).
  _refreshLongDwellData();
}
