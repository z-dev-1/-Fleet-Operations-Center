/**
 * daily-call.js — Daily Call sheet auto-fill (FEATURE 2026-07-16)
 *
 * Replicates the manual "Bottom 10 by Domicile" / "Bottom 10 by SCAC" daily
 * call sheet (AFP-FAS SharePoint, "DAILY CALL WEEK NN.xlsx") the user fills
 * out every morning by hand. Auto-computes what's computable from live
 * fleet data, drafts the rest, and leaves genuinely-manual fields (Actions,
 * Help Needed) as editable text the user fills in themselves.
 *
 * Pure client-side computation from state.slice('fleet').rows, same
 * pattern as analytics.js — no new IPC needed for the read side.
 *
 * Column-by-column source of truth (per user's explicit ask 2026-07-16):
 *   - Uptime % / # Units Unavailable  -- fully computed from lifecycleState
 *   - Trends                          -- fully computed, FROM ISSUE DETAILS
 *                                        TEXT (per user correction — not from
 *                                        the 5-category savedPrimaryComponent
 *                                        field, which is too coarse). Keyword
 *                                        match against issueDetails/issueSummary/
 *                                        savedNotes, tracking the SPECIFIC term
 *                                        matched (e.g. "CCV module") rather than
 *                                        a broad category. Only surfaced when
 *                                        3+ units at that site/SCAC share it —
 *                                        matches the real sheet's own threshold.
 *   - Barriers                        -- DRAFT ONLY. Auto-detected candidate
 *                                        signals (no vendor, parts delay, tech
 *                                        shortage, etc.) pre-filled as a
 *                                        starting point; editable, NOT locked.
 *   - Expected Flips to A/H Today     -- DRAFT ONLY. Units showing completion-
 *                                        type language in notes/status; a
 *                                        starting count+list, editable.
 *   - Actions / Help Needed           -- ALWAYS manual. These require the
 *                                        user's judgment about what THEY are
 *                                        doing / whether THEY need help — the
 *                                        app has no basis to guess these.
 *
 * FAS (call runner name) and MMPM/BC (program manager names) columns are
 * intentionally NOT generated — that data doesn't exist anywhere in the
 * fleet dataset. The "Copy for SharePoint" export starts at the
 * Domicile/SCAC column; paste into the sheet starting at that column and
 * fill in the name columns by hand as before.
 *
 * Actions/Help Needed text is persisted to localStorage, keyed per
 * group+date, so it survives app restarts within the same day but starts
 * fresh each morning (matches the "fill out every morning" workflow).
 */

import bus   from '../bus.js';
import state from '../state.js';

let _el = null;

// ── Helpers ────────────────────────────────────────────────────────────────
const _safe = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _pct  = (n, t) => t ? Math.round((n / t) * 100) : 0;
const _todayKey = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

function _lsKey(kind, groupKey, field) {
  return `dailyCall__${kind}__${groupKey}__${field}__${_todayKey()}`;
}
function _lsGet(kind, groupKey, field) {
  try { return localStorage.getItem(_lsKey(kind, groupKey, field)) || ''; } catch (e) { return ''; }
}
function _lsSet(kind, groupKey, field, val) {
  try { localStorage.setItem(_lsKey(kind, groupKey, field), val); } catch (e) { /* ignore quota errors */ }
}

// ── Trend keyword taxonomy ──────────────────────────────────────────────────
// Word-boundary regex per specific term (NOT the broad 5-category classifier)
// so trend lines read like the real sheet: "CCV module — 4 units", not
// "Engine/Motor Systems — 4 units". Extend this list as new recurring terms
// show up in practice.
const TREND_TERMS = [
  ['CCV module',        /\bccv\b/i],
  ['Misfire',           /\bmisfire/i],
  ['Turbo',              /\bturbo/i],
  ['Injector',          /\binjector/i],
  ['Coolant leak',      /\bcoolant\s*leak/i],
  ['Oil leak',          /\boil\s*leak/i],
  ['Oil pan',           /\boil\s*pan/i],
  ['Transmission',      /\btransmission\b/i],
  ['Clutch',            /\bclutch\b/i],
  ['Accident',          /\baccident\b/i],
  ['5th Wheel',         /\b(5th|fifth)\s*wheel/i],
  ['Tires',             /\btires?\b/i],
  ['Brakes',            /\bbrakes?\b/i],
  ['Battery',           /\bbatter(y|ies)\b/i],
  ['Alternator',        /\balternator/i],
  ['Starter',           /\bstarter\b/i],
  ['Check engine light',/\b(check engine|\bcel\b)/i],
  ['Suspension',        /\bsuspension\b/i],
  ['Steering',          /\bsteering\b/i],
  ['Air conditioning',  /\b(air condition|\bhvac\b)/i],
  ['Air leak',          /\bair\s*leak/i],
  ['Liftgate',          /\bliftgate\b/i],
  ['Body damage',       /\bbody\s*(damage|shop)\b/i],
  ['DEF system',        /\bdef\b/i],
  ['DPF',               /\bdpf\b/i],
  ['EGR',               /\begr\b/i],
  ['Expired inspection',/\bexpired\s*inspection/i],
  ['Overdue PM',        /\boverdue\s*pm\b/i],
  ['Expired PM',        /\bexpired\s*pm\b/i],
  ['Wiring/harness',    /\b(wiring|harness)\b/i],
  ['Axle',              /\baxle\b/i],
  ['Differential',      /\bdifferential\b/i],
  ['Fuel system',       /\bfuel\s*(system|pump|line|tank)\b/i],
  ['Sensor fault',      /\bsensor\b/i],
  ['Crankcase',         /\bcrankcase\b/i],
  ['Wheel seal',        /\bwheel\s*seal/i],
  ['Alignment',         /\balignment\b/i],
  ['CNG tank',          /\bcng\s*tank/i],
  ['5th wheel parts',   /\b5th\s*wheel\s*parts/i],
];

const TREND_MIN_UNITS = 3; // per user: "must be 3 or more repairs of same for the site"

// Barrier candidate signals — DRAFT ONLY, always editable
const BARRIER_TERMS = [
  ['No vendor assigned',      /^(--|unassigned)$/i, 'vendor'],   // matched against row.vendor, not text
  ['Parts delay',              /\bparts?\b.*\b(delay|backorder|sourcing|eta|pending)\b|\bsourcing_parts\b/i],
  ['Technician shortage',      /\btech(nician)?\s*shortage/i],
  ['Vendor backlog',           /\bbacklog\b/i],
  ['Estimate rejected',        /\brejected\b/i],
  ['Estimate pending approval',/\b(pending|awaiting)\s*(estimate|approval)/i],
  ['Offsite repair delay',     /\boffsite\b/i],
  ['Dealer delay',             /\bdealer\b.*\b(delay|backlog|lead time)\b/i],
  ['Expired inspection',       /\bexpired\s*inspection/i],
  ['Expired/overdue PM',       /\b(expired|overdue)\s*pm\b/i],
];

// Expected-flip completion signals — DRAFT ONLY, always editable
const FLIP_SIGNAL = /\b(repair complete|repairs? completed|road[- ]?test(ed)?|ready for (pickup|release)|returning to service|release(d)? back to fleet|flip(ping)? (to|back) (a\/h|available)|complete[d]? (today|this morning))\b/i;

function _unitText(r) {
  return [r.issueDetails || '', r.issueSummary || '', r.savedNotes || '', r.savedRepairStatus || ''].join(' ');
}

function _isUnavail(r) {
  return (r.lifecycleState || '').toLowerCase().includes('unavail');
}

// ── Per-group computation ───────────────────────────────────────────────────
function _computeGroup(groupRows, allRowsInGroup) {
  const total    = allRowsInGroup.length;
  const unavail  = groupRows; // already filtered to unavailable
  const uptime   = total ? Math.round(((total - unavail.length) / total) * 1000) / 10 : 100;

  // Trends — tally specific term -> Set(unitId)
  const trendMap = {};
  for (const r of unavail) {
    const text = _unitText(r);
    for (const [label, re] of TREND_TERMS) {
      if (re.test(text)) {
        if (!trendMap[label]) trendMap[label] = new Set();
        trendMap[label].add(r.equipmentId || r.id || '?');
      }
    }
  }
  const trends = Object.entries(trendMap)
    .filter(([, ids]) => ids.size >= TREND_MIN_UNITS)
    .map(([label, ids]) => ({ label, count: ids.size, units: Array.from(ids) }))
    .sort((a, b) => b.count - a.count);

  // Barriers (draft) — tally candidate signal -> count
  const barrierMap = {};
  let noVendorCount = 0;
  for (const r of unavail) {
    const v = (r.vendor || '--').trim();
    if (!v || v === '--' || v.toLowerCase() === 'unassigned') noVendorCount++;
    const text = _unitText(r);
    for (const [label, re] of BARRIER_TERMS) {
      if (label === 'No vendor assigned') continue; // handled above via vendor field
      if (re.test(text)) barrierMap[label] = (barrierMap[label] || 0) + 1;
    }
  }
  if (noVendorCount > 0) barrierMap['No vendor assigned'] = noVendorCount;
  const barriers = Object.entries(barrierMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([label, count]) => `${label} (${count})`);

  // Expected flips (draft)
  const flipUnits = unavail.filter(r => FLIP_SIGNAL.test(_unitText(r))).map(r => r.equipmentId || r.id || '?');

  return {
    total, unavailCount: unavail.length, uptime,
    trends, barriers, flipUnits,
  };
}

function _buildGroups(rows, keyFn, labelFn) {
  const byKey = {};
  for (const r of rows) {
    const key = keyFn(r);
    if (!key) continue;
    if (!byKey[key]) byKey[key] = [];
    byKey[key].push(r);
  }
  const groups = [];
  for (const key of Object.keys(byKey)) {
    const allInGroup = byKey[key];
    const unavailInGroup = allInGroup.filter(_isUnavail);
    if (unavailInGroup.length === 0) continue; // matches "bottom" semantics — nothing to report
    const computed = _computeGroup(unavailInGroup, allInGroup);
    groups.push({ key, label: labelFn(key), ...computed });
  }
  groups.sort((a, b) => a.uptime - b.uptime); // worst uptime first, matches "Bottom 10"
  return groups;
}

// ── Row render (editable) ───────────────────────────────────────────────────
function _renderGroupRow(kind, g) {
  const trendsHtml = g.trends.length
    ? g.trends.map(t => `<div class="dc-trend-line">${_safe(t.label)} — ${t.count} units <span class="dc-unit-list">(${t.units.slice(0, 8).map(_safe).join(', ')})</span></div>`).join('')
    : '<span class="an-empty">No trends</span>';

  const barriersDraft = g.barriers.length ? g.barriers.join('; ') : '';
  const flipCount = g.flipUnits.length;
  const flipDraft = flipCount > 0 ? `~${flipCount} (${g.flipUnits.slice(0, 6).map(_safe).join(', ')})` : '0';

  const barriersVal = _lsGet(kind, g.key, 'barriers') || barriersDraft;
  const flipsVal     = _lsGet(kind, g.key, 'flips')     || flipDraft;
  const actionsVal   = _lsGet(kind, g.key, 'actions');
  const helpVal      = _lsGet(kind, g.key, 'help');

  const uptimeCls = g.uptime < 65 ? 'dc-cell--danger' : g.uptime < 75 ? 'dc-cell--warn' : '';

  return `
    <tr data-group-key="${_safe(g.key)}">
      <td class="dc-col-label"><b>${_safe(g.label)}</b></td>
      <td class="dc-col-num ${uptimeCls}">${g.uptime}%</td>
      <td class="dc-col-num ${g.unavailCount > 0 ? 'dc-cell--warn' : ''}">${g.unavailCount}</td>
      <td class="dc-col-trends">${trendsHtml}</td>
      <td class="dc-col-editable"><textarea class="dc-input dc-input--barriers" data-field="barriers" rows="2" placeholder="Draft — edit as needed">${_safe(barriersVal)}</textarea></td>
      <td class="dc-col-editable"><textarea class="dc-input dc-input--flips" data-field="flips" rows="2" placeholder="Draft — edit as needed">${_safe(flipsVal)}</textarea></td>
      <td class="dc-col-editable"><textarea class="dc-input dc-input--actions" data-field="actions" rows="2" placeholder="What are you doing about it?">${_safe(actionsVal)}</textarea></td>
      <td class="dc-col-editable"><textarea class="dc-input dc-input--help" data-field="help" rows="2" placeholder="No help needed">${_safe(helpVal)}</textarea></td>
    </tr>`;
}

function _renderTable(kind, groups, showBottom10) {
  const visible = showBottom10 ? groups.slice(0, 10) : groups;
  if (!visible.length) return '<div class="an-empty" style="padding:16px">No unavailable units — nothing to report 🎉</div>';
  return `
    <table class="an-table dc-table">
      <thead>
        <tr>
          <th>${kind === 'site' ? 'DOMICILE' : 'SCAC'}</th>
          <th class="an-tbl--r">Uptime %</th>
          <th class="an-tbl--r"># Unavailable</th>
          <th>Trends (3+ units, same issue)</th>
          <th>Barriers <span class="dc-draft-badge">draft</span></th>
          <th>Expected Flips Today <span class="dc-draft-badge">draft</span></th>
          <th>Actions</th>
          <th>Help Needed</th>
        </tr>
      </thead>
      <tbody>${visible.map(g => _renderGroupRow(kind, g)).join('')}</tbody>
    </table>`;
}

// ── Copy-for-SharePoint export ───────────────────────────────────────────────
function _buildTsv(groups, kind, showBottom10) {
  const visible = showBottom10 ? groups.slice(0, 10) : groups;
  const header = [kind === 'site' ? 'DOMICILE' : 'SCAC', 'Uptime %', '# Units Unavailable', 'Trends (SITE/SCAC)', 'Barriers (SITE/SCAC)', 'Expected Flips to A/H Today', 'Actions', 'Help Needed'];
  const lines = [header.join('\t')];
  for (const g of visible) {
    const trendsTxt = g.trends.length ? g.trends.map(t => `${t.label} — ${t.count} units`).join('\n') : 'No Trends';
    const barriersTxt = _lsGet(kind, g.key, 'barriers') || (g.barriers.join('; ') || '');
    const flipsTxt = _lsGet(kind, g.key, 'flips') || (g.flipUnits.length ? `~${g.flipUnits.length}` : '0');
    const actionsTxt = _lsGet(kind, g.key, 'actions') || '';
    const helpTxt = _lsGet(kind, g.key, 'help') || 'No help needed';
    lines.push([g.label, g.uptime + '%', g.unavailCount, trendsTxt, barriersTxt, flipsTxt, actionsTxt, helpTxt].join('\t'));
  }
  return lines.join('\n');
}

// ── Full view HTML ───────────────────────────────────────────────────────────
function _viewHtml() {
  return `
    <style>
      #view-daily-call .dc-table { width: 100%; border-collapse: collapse; }
      #view-daily-call .dc-table th, #view-daily-call .dc-table td { border: 1px solid var(--border, #333); padding: 8px; vertical-align: top; font-size: 12px; }
      #view-daily-call .dc-col-label { min-width: 90px; }
      #view-daily-call .dc-col-num { text-align: right; min-width: 60px; }
      #view-daily-call .dc-col-trends { min-width: 220px; }
      #view-daily-call .dc-col-editable { min-width: 160px; }
      #view-daily-call .dc-input { width: 100%; box-sizing: border-box; resize: vertical; font-size: 12px; font-family: inherit; background: var(--bg2, #1a1a2e); color: var(--fg, #eee); border: 1px solid var(--border, #444); border-radius: 4px; padding: 4px 6px; }
      #view-daily-call .dc-trend-line { margin-bottom: 4px; }
      #view-daily-call .dc-unit-list { opacity: .65; font-size: 11px; }
      #view-daily-call .dc-draft-badge { font-size: 9px; opacity: .6; font-weight: normal; text-transform: uppercase; margin-left: 4px; }
      #view-daily-call .dc-cell--warn   { color: #d97706; font-weight: 600; }
      #view-daily-call .dc-cell--danger { color: #dc2626; font-weight: 600; }
      #view-daily-call .dc-section-title { font-size: 15px; font-weight: 600; margin: 20px 0 8px; }
      #view-daily-call .dc-toggle-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; }
    </style>
    <div class="an-header">
      <div class="an-header__left">
        <span class="an-title">Daily Call</span>
        <span class="an-subtitle">Auto-drafted from live fleet data — Trends computed, Barriers/Flips drafted, Actions/Help always manual</span>
      </div>
      <div class="an-header__actions">
        <button id="dc-copy-site" class="detail-panel__btn detail-panel__btn--secondary">📋 Copy Domicile table</button>
        <button id="dc-copy-scac" class="detail-panel__btn detail-panel__btn--secondary">📋 Copy SCAC table</button>
        <button id="dc-refresh" class="detail-panel__btn detail-panel__btn--secondary">↺ Refresh</button>
        <button id="dc-back" class="detail-panel__btn">Back to Fleet</button>
      </div>
    </div>
    <div class="an-body">
      <div class="dc-toggle-row">
        <label><input type="checkbox" id="dc-bottom10-toggle" /> Show bottom 10 only (default: show all sites/SCACs with unavailable units)</label>
      </div>

      <div class="dc-section-title">Bottom by Domicile</div>
      <div id="dc-site-table"></div>

      <div class="dc-section-title">Bottom by SCAC</div>
      <div id="dc-scac-table"></div>
    </div>`;
}

// ── State + update ───────────────────────────────────────────────────────────
let _siteGroups = [];
let _scacGroups = [];
let _showBottom10 = false;

function _update(rows) {
  if (!_el) return;
  _siteGroups = _buildGroups(rows, r => r.domicileSite || '', k => k);
  _scacGroups = _buildGroups(rows, r => (r.operator || '').toUpperCase(), k => k);

  const siteEl = _el.querySelector('#dc-site-table');
  const scacEl = _el.querySelector('#dc-scac-table');
  if (siteEl) siteEl.innerHTML = _renderTable('site', _siteGroups, _showBottom10);
  if (scacEl) scacEl.innerHTML = _renderTable('scac', _scacGroups, _showBottom10);

  _wireEditableFields(siteEl, 'site');
  _wireEditableFields(scacEl, 'scac');
}

function _wireEditableFields(tableEl, kind) {
  if (!tableEl) return;
  tableEl.querySelectorAll('tr[data-group-key]').forEach(tr => {
    const key = tr.dataset.groupKey;
    tr.querySelectorAll('.dc-input').forEach(input => {
      input.addEventListener('input', () => {
        _lsSet(kind, key, input.dataset.field, input.value);
      });
    });
  });
}

async function _copyTable(kind) {
  const groups = kind === 'site' ? _siteGroups : _scacGroups;
  const tsv = _buildTsv(groups, kind, _showBottom10);
  try {
    await navigator.clipboard.writeText(tsv);
    return true;
  } catch (e) {
    // Fallback for environments without clipboard permission
    const ta = document.createElement('textarea');
    ta.value = tsv;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
    document.body.removeChild(ta);
    return true;
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
export function init(container) {
  _el = document.createElement('div');
  _el.id = 'view-daily-call';
  _el.className = 'view view--daily-call';
  _el.style.display = 'none';
  _el.innerHTML = _viewHtml();
  container.appendChild(_el);

  _el.querySelector('#dc-back').addEventListener('click', () => {
    bus.emit('ui:view-change', { from: 'daily-call', to: 'fleet' });
  });

  _el.querySelector('#dc-refresh').addEventListener('click', () => {
    _update(state.slice('fleet').rows || []);
  });

  _el.querySelector('#dc-bottom10-toggle').addEventListener('change', (e) => {
    _showBottom10 = !!e.target.checked;
    _update(state.slice('fleet').rows || []);
  });

  _el.querySelector('#dc-copy-site').addEventListener('click', async (e) => {
    const btn = e.target;
    const orig = btn.textContent;
    await _copyTable('site');
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });

  _el.querySelector('#dc-copy-scac').addEventListener('click', async (e) => {
    const btn = e.target;
    const orig = btn.textContent;
    await _copyTable('scac');
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });

  bus.on('fleet:data', (data) => {
    _update((data && data.rows) ? data.rows : []);
  });

  bus.on('ui:view-change', ({ to }) => {
    _el.style.display = to === 'daily-call' ? 'flex' : 'none';
    if (to === 'daily-call') _update(state.slice('fleet').rows || []);
  });

  _update(state.slice('fleet').rows || []);
}
