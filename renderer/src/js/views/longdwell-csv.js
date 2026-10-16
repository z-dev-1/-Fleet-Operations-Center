// ============================================================================
// longdwell-csv.js — Imported Long Dwell tracker CSV (team-shared)
//
// Option 1 build: the team downloads the AAP long-dwell tracker CSV, imports it
// here, and fills the manual columns (Delay Reason, Escalation Level Action,
// Support Team POC, Asana Link, Required Notes) in-app. Columns A–M come from
// the CSV verbatim (read-only); N–R are editable and persisted per row so
// everyone shares one working copy (and it can be pushed to SharePoint later).
//
// Self-contained: renders into a host element and persists via the
// longDwellCsv bridge (long-dwell-csv:* IPC). Does not touch the existing
// fleet-row-based Long Dwell table.
// ============================================================================

import { longDwellCsv as csvBridge, ai as aiBridge, relay as relayBridge, longDwell as longDwellBridge } from '../bridge.js';
import state from '../state.js';
import toast from '../components/toast.js';
import { _buildAIFillPrompt, _stripCosts, DELAY_REASONS as AI_DELAY_REASONS, ESCALATION_LEVELS as AI_ESCALATION_LEVELS } from '../longdwell-ai.js';

// Match the computed Long Dwell fill's data-freshness window: refresh + deep
// scan a unit whose relay data is older than this before summarizing.
const LD_FRESH_MS = 30 * 60 * 1000;

// The manual (team-filled) columns, in display order. Keys match the server
// MANUAL_FIELDS in src/ipc/long-dwell-csv.js.
const MANUAL_COLS = [
  { key: 'delayReason',      label: 'Delay Reason' },
  { key: 'escalationAction', label: 'Escalation Level Action' },
  { key: 'supportPOC',       label: 'Support Team POC' },
  { key: 'asanaLink',        label: 'Asana Link (If at SEV2)' },
  { key: 'notes',            label: 'Required Notes for ALL Units' },
];
const MANUAL_KEYS = MANUAL_COLS.map((c) => c.key);

// Dropdown options for Delay Reason — mirrors the existing Long Dwell enum.
const DELAY_REASONS = [
  'Primary Vendor', 'Parts Delay', 'Offsite Shop', 'Estimate Process',
  'Payment', 'Speciality Vendor', 'Out of Scope for FAS',
  'End of Life Review', 'PMR', 'MCS SW Miss', 'Weather', 'Towing',
  'Reconditioning', 'Repaired',
];
const ESCALATION_LEVELS = ['SEV5', 'SEV4', 'SEV3', 'SEV2'];

let _host = null;          // the element we render into
let _data = { importedAt: null, columns: [], rows: {} };
// Per-column filter text, keyed by column label (CSV columns) or manual key.
let _filters = {};
// Click-to-sort state: { key, dir }. key = CSV column label or 'm:'+manualKey.
// Default: sort alphabetically by FAS (ascending) so each FAS owner's units
// group together on load. The user can click any header to re-sort.
let _sort = { key: 'FAS', dir: 1 };
// Selected row keys (for copying one or multiple rows).
let _selected = new Set();

// ── HTML escaping ───────────────────────────────────────────────────────────
function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── RFC-4180-ish CSV parser ─────────────────────────────────────────────────
// Handles quoted fields, escaped quotes (""), and newlines INSIDE quoted cells
// (the Required Notes column has multi-line bullet blocks). Returns string[][].
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const s = String(text || '').replace(/^\uFEFF/, ''); // strip BOM
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  // flush last field/row (if the file didn't end with a newline)
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Find the header row: the first row that contains an "Asset ID" cell (the
// tracker has a title/blank line or two before the real header sometimes).
function _findHeaderIndex(matrix) {
  for (let r = 0; r < Math.min(matrix.length, 15); r++) {
    const cells = matrix[r].map((c) => String(c || '').trim().toLowerCase());
    if (cells.some((c) => c === 'asset id' || c === 'assetid')) return r;
  }
  return 0;
}

function _colIndex(headers, name) {
  const target = name.trim().toLowerCase();
  return headers.findIndex((h) => String(h || '').trim().toLowerCase() === target);
}

// Turn the parsed matrix into { columns, rows[] } where each row is
// { assetId, site, csv: {header: value} }. Only the CSV (A–M) columns are
// captured here; the manual N–R columns are owned by the app.
function _buildImportPayload(matrix) {
  if (!matrix.length) return null;
  const hIdx = _findHeaderIndex(matrix);
  const headers = matrix[hIdx].map((h) => String(h || '').trim());
  if (!headers.length) return null;

  // The manual columns live in the CSV header too (N–R), but the team fills
  // them in-app — so we DO NOT import their values; we only import A–M.
  const manualHeaderSet = new Set(MANUAL_COLS.map((c) => c.label.toLowerCase()));
  const csvHeaders = headers.filter((h) => h && !manualHeaderSet.has(h.toLowerCase()));

  const assetIdx = _colIndex(headers, 'Asset ID');
  const siteIdx  = _colIndex(headers, 'Site');

  const rows = [];
  for (let r = hIdx + 1; r < matrix.length; r++) {
    const cells = matrix[r];
    // skip fully-empty lines
    if (!cells.some((c) => String(c || '').trim() !== '')) continue;
    const assetId = assetIdx >= 0 ? String(cells[assetIdx] || '').trim() : '';
    const site    = siteIdx  >= 0 ? String(cells[siteIdx]  || '').trim() : '';
    // skip trailing/blank rows that have no asset id at all
    if (!assetId) continue;
    const csv = {};
    headers.forEach((h, ci) => {
      if (!h || manualHeaderSet.has(h.toLowerCase())) return;
      csv[h] = String(cells[ci] == null ? '' : cells[ci]);
    });
    rows.push({ assetId, site, csv });
  }
  return { columns: csvHeaders, rows };
}

// ── Rendering ────────────────────────────────────────────────────────────────
// All row keys in import order (unfiltered). Used for counts and TSV export.
function _allRowKeys() {
  return Object.keys(_data.rows || {}).sort((a, b) => {
    const ai = parseInt(a.split('::').pop(), 10) || 0;
    const bi = parseInt(b.split('::').pop(), 10) || 0;
    return ai - bi;
  });
}

// Does this row match ALL active column filters? CSV columns match on their
// value; manual columns match on the saved manual value. Case-insensitive
// substring match.
function _rowMatchesFilters(rowKey) {
  const active = Object.entries(_filters).filter(([, v]) => String(v || '').trim() !== '');
  if (!active.length) return true;
  const r = _data.rows[rowKey] || {};
  const csv = r.csv || {};
  const manual = r.manual || {};
  for (const [field, needleRaw] of active) {
    const needle = String(needleRaw).trim().toLowerCase();
    // field is either a CSV column label or a manual key (prefixed "m:").
    let hay;
    if (field.startsWith('m:')) hay = String(manual[field.slice(2)] || '');
    else hay = String(csv[field] || '');
    if (!hay.toLowerCase().includes(needle)) return false;
  }
  return true;
}

// Value for sorting a row by the active sort key (CSV label or 'm:'+manualKey).
function _sortVal(rowKey) {
  const r = _data.rows[rowKey] || {};
  const k = _sort.key;
  if (!k) return '';
  if (k.startsWith('m:')) return String((r.manual || {})[k.slice(2)] || '');
  return String((r.csv || {})[k] || '');
}

// Row keys after applying filters, then the active sort (if any). Numbers sort
// numerically; everything else case-insensitively. Blanks sort last.
function _rowKeys() {
  const keys = _allRowKeys().filter(_rowMatchesFilters);
  if (!_sort.key) return keys;
  const dir = _sort.dir;
  return keys.slice().sort((a, b) => {
    const va = _sortVal(a), vb = _sortVal(b);
    const ea = va.trim() === '', eb = vb.trim() === '';
    if (ea && eb) return 0;
    if (ea) return 1;        // blanks always last
    if (eb) return -1;
    const na = parseFloat(va), nb = parseFloat(vb);
    const bothNum = !isNaN(na) && !isNaN(nb) && /^-?\d/.test(va.trim()) && /^-?\d/.test(vb.trim());
    if (bothNum) return (na - nb) * dir;
    return va.toLowerCase().localeCompare(vb.toLowerCase()) * dir;
  });
}

function _manualCellHtml(rowKey, col, value) {
  const v = value || '';
  if (col.key === 'delayReason') {
    const opts = ['<option value=""></option>']
      .concat(DELAY_REASONS.map((o) => `<option value="${_esc(o)}" ${o === v ? 'selected' : ''}>${_esc(o)}</option>`))
      .join('');
    // Per-row AI Fill button sits with Delay Reason (the first manual column):
    // one click fills Delay Reason + Escalation + Notes for this row.
    return `<div class="ldc-dr-cell"><button class="ldc-ai-row" data-rowkey="${_esc(rowKey)}" title="AI-fill Delay Reason, Escalation & Notes for this unit">\u2728</button>`
      + `<select class="settings__select ldc-input" data-rowkey="${_esc(rowKey)}" data-field="delayReason">${opts}</select></div>`;
  }
  if (col.key === 'escalationAction') {
    const opts = ['<option value=""></option>']
      .concat(ESCALATION_LEVELS.map((o) => `<option value="${_esc(o)}" ${o === v ? 'selected' : ''}>${_esc(o)}</option>`))
      .join('');
    return `<select class="settings__select ldc-input" data-rowkey="${_esc(rowKey)}" data-field="escalationAction">${opts}</select>`;
  }
  if (col.key === 'notes') {
    return `<textarea class="settings__textarea ldc-input ldc-notes" rows="2" data-rowkey="${_esc(rowKey)}" data-field="notes" placeholder="Required notes\u2026">${_esc(v)}</textarea>`;
  }
  // supportPOC / asanaLink — plain text inputs
  return `<input class="settings__input ldc-input" type="text" value="${_esc(v)}" data-rowkey="${_esc(rowKey)}" data-field="${_esc(col.key)}" placeholder="\u2014" />`;
}

function _renderTable() {
  const cols = _data.columns || [];
  if (!_allRowKeys().length) {
    return `<div class="an-empty">No data yet. Click <strong>Fetch from AAP</strong> to pull the long-dwell tracker directly (no download), or <strong>Import CSV</strong> to load a downloaded export.</div>`;
  }
  const keys = _rowKeys();

  // Row 1: column titles (sticky, CLICK TO SORT). Row 2: per-column filter
  // inputs (sticky just below). data-sort / data-filter is the key: the CSV
  // column label, or "m:<key>" for a manual column.
  const sortArrow = (key) => (_sort.key === key ? (_sort.dir === 1 ? ' \u25B2' : ' \u25BC') : '');
  const titleCell = (key, label, cls) =>
    `<th class="ldc-sort-th ${cls || ''}" data-sort="${_esc(key)}" title="Click to sort">${_esc(label)}<span class="ldc-sort-ind">${sortArrow(key)}</span></th>`;
  // Selection column header: a select-all checkbox for the current (filtered) view.
  const allSelected = keys.length > 0 && keys.every((k) => _selected.has(k));
  const selTitle = `<th class="ldc-sel-th"><input type="checkbox" class="ldc-sel-all" ${allSelected ? 'checked' : ''} title="Select all (filtered) rows" /></th>`;
  const titleCsv    = cols.map((h) => titleCell(h, h)).join('');
  const titleManual = MANUAL_COLS.map((c) => titleCell('m:' + c.key, c.label, 'ldc-manual-th')).join('');
  const titleRow = `<tr class="ldc-head-titles">${selTitle}${titleCsv}${titleManual}</tr>`;

  const filterCell = (key) => {
    const v = _filters[key] || '';
    return `<th class="ldc-filter-th"><input class="ldc-filter" type="text" data-filter="${_esc(key)}" value="${_esc(v)}" placeholder="\uD83D\uDD0D" /></th>`;
  };
  const filterCsv    = cols.map((h) => filterCell(h)).join('');
  const filterManual = MANUAL_COLS.map((c) => filterCell('m:' + c.key)).join('');
  const filterRow = `<tr class="ldc-head-filters"><th class="ldc-filter-th ldc-sel-th"></th>${filterCsv}${filterManual}</tr>`;

  const body = keys.map(_bodyRowHtml).join('');

  const emptyMsg = !keys.length
    ? `<tr><td class="ldc-no-match" colspan="${cols.length + MANUAL_COLS.length + 1}">No rows match the current filters.</td></tr>`
    : '';

  return `<div class="ldc-table-scroll"><table class="an-table ldc-table"><thead>${titleRow}${filterRow}</thead><tbody>${body}${emptyMsg}</tbody></table></div>`;
}

function _renderToolbar() {
  const keys = _rowKeys();
  const importedAt = _data.importedAt ? new Date(_data.importedAt).toLocaleString() : null;
  const meta = keys.length
    ? `<span class="ldc-meta"><strong>${keys.length}</strong> rows${importedAt ? ' \u00b7 imported ' + _esc(importedAt) : ''}</span>`
    : '';
  return `
    <div class="an-ld-toolbar ldc-toolbar">
      <div class="an-ld-toolbar-row">
        ${meta}
        <div class="an-ld-toolbar-actions">
          <button id="ldc-fetch" class="ec-preset-btn ldc-fetch-btn" title="Pull the long-dwell tracker straight from AAP (no download). Uses your signed-in session; your filled-in columns are preserved.">\uD83D\uDD04 Fetch from AAP</button>
          ${keys.length ? '<button id="ldc-ai-all" class="ec-preset-btn" title="AI-fill Delay Reason, Escalation, and Notes for every row that\u2019s still blank (from live repair data).">\u2728 AI Fill All (blank)</button>' : ''}
          <button id="ldc-import" class="ec-preset-btn" title="Import a downloaded AAP long-dwell tracker CSV (A\u2013M columns). Your filled-in columns are preserved on re-import.">\u2b06\uFE0F Import CSV</button>
          <button id="ldc-copy" class="ec-preset-btn" title="Copy selected rows (or the whole filtered table if none selected) to paste into Excel/SharePoint">\uD83D\uDCCB Copy${_selected.size ? ' (' + _selected.size + ')' : ' Table'}</button>
          ${keys.length ? '<button id="ldc-clear" class="ec-preset-btn" title="Clear the imported dataset">\u2715 Clear</button>' : ''}
        </div>
      </div>
      <input id="ldc-file" type="file" accept=".csv,text/csv" style="display:none" />
    </div>`;
}

function _render() {
  if (!_host) return;
  _host.innerHTML = _renderToolbar() + '<div id="ldc-table-wrap">' + _renderTable() + '</div>';
  _wire();
}

// ── Export (TSV so it pastes into Excel/SharePoint cleanly) ──────────────────
// Build TSV (header + the given row keys). Pass includeHeader=false to copy
// just the row cells (handy for pasting a single row into an existing sheet).
function _buildTsvForKeys(keys, includeHeader = true) {
  const cols = _data.columns || [];
  const lines = [];
  if (includeHeader) lines.push(cols.concat(MANUAL_COLS.map((c) => c.label)).join('\t'));
  for (const rowKey of keys) {
    const r = _data.rows[rowKey] || {};
    const csv = r.csv || {};
    const manual = r.manual || {};
    const cells = cols.map((h) => String(csv[h] || '').replace(/\r?\n/g, ' ').trim())
      .concat(MANUAL_KEYS.map((k) => String(manual[k] || '').replace(/\r?\n/g, ' ').trim()));
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

// Whole (filtered) table.
function _buildTsv() { return _buildTsvForKeys(_rowKeys(), true); }

async function _copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
  }
}

// ── AI Fill (Delay Reason + Escalation + Notes/summary) ──────────────────────
// Mirrors the computed Long Dwell AI-fill: enriches the imported row with live
// fleet data (joined by Asset ID → equipmentId) for the rich repair timeline /
// vendor conversation the prompt needs, then asks the AI for delayReason /
// escalationLevel / 7-field summary. Writes delayReason→delayReason,
// escalationLevel→escalationAction, summary→notes. Support POC + Asana Link
// stay manual. Persists via the same save-row path a manual edit uses.
function _downDaysForRow(csv) {
  const dd = parseInt(String(csv['Days Down'] || '').replace(/[^0-9]/g, ''), 10);
  return isNaN(dd) ? 0 : dd;
}

// Build the row object the shared prompt expects, enriched from live fleetData.
// `fleetRow` (optional) is the already-freshened fleet row from _ensureUnitFresh;
// if not passed, we look it up from current state.
function _promptRowFor(rowKey, fleetRow) {
  const r   = _data.rows[rowKey] || {};
  const csv = r.csv || {};
  const assetId = String(r.assetId || csv['Asset ID'] || '').trim();

  // Start from the imported CSV columns (always present).
  const base = {
    equipmentId:     assetId,
    vendor:          csv['RG Vendor Assigned'] || '',
    domicileSite:    csv['Site'] || '',
    operator:        csv['SCAC'] || '',
    lifecycleReason: csv['Lifecycle State Reason'] || '',
    issueDetails:    [csv['Level 1'], csv['Level 2']].filter(Boolean).join(' / '),
    issueSummary:    csv['Vendor Delay Reason'] || '',
  };

  // Enrich from the (freshened) live fleet row for timeline / notes /
  // conversation / canonical state — the fields that make the summary rich.
  try {
    const live = fleetRow || (state.slice('fleet').rows || [])
      .find((x) => String(x.equipmentId || '').trim() === assetId);
    if (live) {
      for (const k of ['repairTimeline', 'savedNotes', 'notes', 'fullConversation',
                       'lastConversation', 'conversation', 'issueDetails', 'issueSummary',
                       'canonicalStatus', 'canonicalStale', 'canonicalWaitingOn',
                       'canonicalSituation', 'canonicalNextStep', 'vendor',
                       'domicileSite', 'operator', 'lifecycleReason']) {
        if (live[k] != null && String(live[k]).trim() !== '') base[k] = live[k];
      }
    }
  } catch (_) { /* no live fleet data — fall back to CSV-only context */ }

  return base;
}

// AI-fill gate (ref-counted) — pauses scheduled auto-sync + live rescan while a
// fill runs so a concurrent fleet:data push can't clobber state mid-fill.
// Identical to the computed Long Dwell gate.
let _aiFillGateCount = 0;
async function _aiFillGate(on) {
  if (on) {
    _aiFillGateCount++;
    if (_aiFillGateCount === 1) { try { await longDwellBridge.setAiFillActive(true); } catch (_) {} }
  } else {
    _aiFillGateCount = Math.max(0, _aiFillGateCount - 1);
    if (_aiFillGateCount === 0) { try { await longDwellBridge.setAiFillActive(false); } catch (_) {} }
  }
}

// Before filling, guarantee the unit's relay data is <=30 min old; if older,
// refresh that one unit's relay data + deep-scan it so the summary is built
// from current vendor/repair data — exactly like the computed Long Dwell fill.
// Returns a fleet-like row enriched with fresh timeline/notes/conversation, or
// null if the unit isn't in live fleet data. Degrades gracefully on any error.
async function _ensureUnitFresh(assetId, onStatus) {
  const findRow = () => (state.slice('fleet').rows || []).find((r) => String(r.equipmentId || '').trim() === assetId) || null;
  let row = findRow();
  if (!row) return null; // unit not in live fleet — caller falls back to CSV-only context

  let ageMs = Infinity;
  try {
    const cache = await relayBridge.getUnitCache(assetId);
    const cachedAt = cache && (cache._cachedAt || cache.cachedAt);
    if (cachedAt) ageMs = Date.now() - Number(cachedAt);
  } catch (_) { /* treat as stale */ }

  if (ageMs <= LD_FRESH_MS) return row;

  try {
    if (onStatus) onStatus('Refreshing ' + assetId + '\u2026');
    if (relayBridge && relayBridge.refreshUnit) {
      const rr = await relayBridge.refreshUnit(assetId);
      if (rr && rr.unit) row = rr.unit;
    }
  } catch (_) { /* non-fatal */ }
  try {
    if (onStatus) onStatus('Deep-scanning ' + assetId + '\u2026');
    if (aiBridge && aiBridge.deepProcess) {
      const dp = await aiBridge.deepProcess([assetId]);
      const u = dp && Array.isArray(dp.units) ? dp.units.find((x) => x.equipmentId === assetId) : null;
      if (u && row) {
        if (u.issueSummary)   { row.issueSummary = u.issueSummary; row.issue = u.issueSummary; }
        if (u.repairTimeline) row.repairTimeline = u.repairTimeline;
        if (u.notes)          row.savedNotes = u.notes;
      }
    }
  } catch (_) { /* non-fatal */ }
  return findRow() || row;
}

async function _aiFillRow(rowKey, btn, onStatus) {
  const r = _data.rows[rowKey];
  if (!r) return false;
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '\u2728 Filling\u2026'; }
  const _gatedHere = !onStatus; // single-row click gates itself; Fill-All gates the whole batch
  if (_gatedHere) await _aiFillGate(true);
  try {
    if (!aiBridge || !aiBridge.ask) throw new Error('AI bridge not available');
    const assetId = String(r.assetId || (r.csv || {})['Asset ID'] || '').trim();
    // Freshen the unit (refresh + deep-scan if stale) so the summary reflects
    // current data — same as the computed Long Dwell fill.
    const fresh = await _ensureUnitFresh(assetId, onStatus);
    const promptRow = _promptRowFor(rowKey, fresh);
    const dd = _downDaysForRow(r.csv || {});
    const prompt = _buildAIFillPrompt(promptRow, dd);
    const result = await aiBridge.ask(prompt);
    if (!result || result.ok === false) throw new Error((result && result.error) || 'AI call failed');
    const textOut = result.text || '';
    const jm = textOut.match(/\{[\s\S]*\}/);
    if (!jm) throw new Error('AI response was not JSON');
    let parsed;
    try { parsed = JSON.parse(jm[0]); } catch (e) { throw new Error('Could not parse AI JSON: ' + e.message); }

    let delayReason = String(parsed.delayReason || '').trim();
    let escalation  = String(parsed.escalationLevel || '').trim().toUpperCase();
    let notes       = _stripCosts(String(parsed.summary || '').trim()).slice(0, 8000);
    if (!AI_DELAY_REASONS.includes(delayReason)) delayReason = '';
    if (!AI_ESCALATION_LEVELS.includes(escalation)) escalation = '';

    // Persist each filled field via the same save-row path manual edits use.
    const saves = [];
    if (delayReason) saves.push(['delayReason', delayReason]);
    if (escalation)  saves.push(['escalationAction', escalation]);
    if (notes)       saves.push(['notes', notes]);
    for (const [field, value] of saves) {
      const res = await csvBridge.saveRow({ rowKey, field, value });
      if (res && res.row) {
        if (!_data.rows[rowKey]) _data.rows[rowKey] = {};
        _data.rows[rowKey].manual = res.row.manual;
      }
    }
    // Single-row click: re-render so the filled dropdowns/notes show at once.
    // (Fill-All re-renders per row via its own loop.)
    if (_gatedHere && saves.length) _renderBodyOnly();
    return saves.length > 0;
  } catch (e) {
    toast.show('error', 'AI fill failed: ' + e.message, 4000);
    return false;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
    if (_gatedHere) await _aiFillGate(false);
  }
}

async function _aiFillAll(btn) {
  // Fill only rows whose manual delay/escalation/notes are all still blank.
  const keys = _rowKeys().filter((k) => {
    const m = (_data.rows[k] || {}).manual || {};
    return !m.delayReason && !m.escalationAction && !(m.notes || '').trim();
  });
  if (!keys.length) { toast.show('info', 'No blank rows to AI-fill', 2500); return; }
  const orig = btn ? btn.innerHTML : '';
  if (btn) btn.disabled = true;
  let done = 0;
  // Gate the WHOLE batch (so auto-sync/rescan stay paused for the duration),
  // and pass an onStatus so each row doesn't re-gate per-row.
  await _aiFillGate(true);
  try {
    for (const k of keys) {
      const n = done + 1;
      const onStatus = (msg) => { if (btn) btn.innerHTML = `\u2728 ${n}/${keys.length}: ${msg}`; };
      if (btn) btn.innerHTML = `\u2728 Filling ${n}/${keys.length}\u2026`;
      await _aiFillRow(k, null, onStatus);
      done++;
      _renderBodyOnly(); // show each fill as it lands
    }
  } finally {
    await _aiFillGate(false);
  }
  if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  toast.show('success', `AI filled ${done} row(s)`, 3000);
  _renderBodyOnly();
}

// ── Wiring ───────────────────────────────────────────────────────────────────
function _wire() {
  const importBtn = _host.querySelector('#ldc-import');
  const fileInput = _host.querySelector('#ldc-file');
  if (importBtn && fileInput) {
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const matrix = parseCsv(reader.result);
          const payload = _buildImportPayload(matrix);
          if (!payload || !payload.rows.length) {
            toast.show('warn', 'No data rows found in that CSV (couldn\u2019t find an "Asset ID" column).', 5000);
            return;
          }
          const res = await csvBridge.import(payload);
          if (res && res.ok) {
            toast.show('success', `Imported ${res.count} rows`, 3000);
            await refresh();
          } else {
            toast.show('warn', (res && res.error) || 'Import failed', 4000);
          }
        } catch (e) {
          toast.show('error', 'Import failed: ' + e.message, 5000);
        } finally {
          fileInput.value = ''; // allow re-importing the same file
        }
      };
      reader.onerror = () => toast.show('error', 'Could not read file', 4000);
      reader.readAsText(file);
    });
  }

  const fetchBtn = _host.querySelector('#ldc-fetch');
  if (fetchBtn) fetchBtn.addEventListener('click', async () => {
    const orig = fetchBtn.innerHTML;
    fetchBtn.disabled = true;
    fetchBtn.innerHTML = '\u23F3 Fetching from AAP\u2026';
    toast.show('info', 'Pulling the long-dwell tracker from AAP\u2026', 2500);
    try {
      const res = await csvBridge.fetchAap({});
      if (res && res.ok) {
        toast.show('success', `Fetched ${res.count} rows from AAP`, 3000);
        await refresh();
      } else {
        toast.show('warn', (res && res.error) || 'AAP fetch failed', 6000);
      }
    } catch (e) {
      toast.show('error', 'AAP fetch failed: ' + e.message, 6000);
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.innerHTML = orig;
    }
  });

  const aiAllBtn = _host.querySelector('#ldc-ai-all');
  if (aiAllBtn) aiAllBtn.addEventListener('click', () => _aiFillAll(aiAllBtn));

  const copyBtn = _host.querySelector('#ldc-copy');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    if (!_rowKeys().length) { toast.show('warn', 'Nothing to copy \u2014 import a CSV first', 3000); return; }
    // If rows are selected, copy ONLY the selected ones (in current view order);
    // otherwise copy the whole filtered table.
    const selKeys = _rowKeys().filter((k) => _selected.has(k));
    if (selKeys.length) {
      await _copyText(_buildTsvForKeys(selKeys, false)); // rows only — no header
      toast.show('success', `Copied ${selKeys.length} selected row(s)`, 2500);
    } else {
      await _copyText(_buildTsv());
      toast.show('success', 'Table copied \u2014 paste into Excel/SharePoint', 2500);
    }
  });

  const clearBtn = _host.querySelector('#ldc-clear');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    if (!window.confirm('Clear the imported CSV and all filled-in columns?')) return;
    try { await csvBridge.clear(); toast.show('info', 'Cleared', 2000); await refresh(); }
    catch (e) { toast.show('error', 'Clear failed: ' + e.message, 3000); }
  });

  // Inline edits on the manual columns — save on change (selects/inputs) and
  // on blur (textarea), persisted per row via the bridge. Delegated on the
  // stable table wrapper so it survives re-renders.
  const wrap = _host.querySelector('#ldc-table-wrap');
  if (wrap) {
    const save = async (el) => {
      const rowKey = el.getAttribute('data-rowkey');
      const field  = el.getAttribute('data-field');
      if (!rowKey || !MANUAL_KEYS.includes(field)) return;
      const value = el.value;
      try {
        const res = await csvBridge.saveRow({ rowKey, field, value });
        if (res && res.row) {
          if (!_data.rows[rowKey]) _data.rows[rowKey] = {};
          _data.rows[rowKey].manual = res.row.manual;
          el.classList.add('ldc-saved');
          setTimeout(() => el.classList.remove('ldc-saved'), 800);
        }
      } catch (e) {
        toast.show('error', 'Save failed: ' + e.message, 3000);
      }
    };
    wrap.addEventListener('change', (ev) => {
      const el = ev.target;
      if (el && el.classList && el.classList.contains('ldc-input')) save(el);
    });
    wrap.addEventListener('blur', (ev) => {
      const el = ev.target;
      if (el && el.tagName === 'TEXTAREA' && el.classList.contains('ldc-input')) save(el);
    }, true);

    // Per-column filters — update _filters and re-render ONLY the tbody so the
    // filter input keeps focus and the caret position. Debounced lightly.
    let _filterTimer = null;
    wrap.addEventListener('input', (ev) => {
      const el = ev.target;
      if (!el || !el.classList || !el.classList.contains('ldc-filter')) return;
      const key = el.getAttribute('data-filter');
      if (key == null) return;
      _filters[key] = el.value;
      clearTimeout(_filterTimer);
      _filterTimer = setTimeout(() => _renderBodyOnly(), 120);
    });

    // Per-row AI Fill (✨). Delegated so it survives re-renders.
    wrap.addEventListener('click', (ev) => {
      const aiBtn = ev.target && ev.target.closest ? ev.target.closest('.ldc-ai-row') : null;
      if (!aiBtn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const rowKey = aiBtn.getAttribute('data-rowkey');
      if (rowKey) _aiFillRow(rowKey, aiBtn);
    });

    // Per-row Copy (📋 in the selection column) — copies that one row (header +
    // row) to the clipboard.
    wrap.addEventListener('click', async (ev) => {
      const cp = ev.target && ev.target.closest ? ev.target.closest('.ldc-copy-row') : null;
      if (!cp) return;
      ev.preventDefault();
      ev.stopPropagation();
      const rowKey = cp.getAttribute('data-rowkey');
      if (!rowKey) return;
      await _copyText(_buildTsvForKeys([rowKey], false)); // row only — no header
      toast.show('success', 'Row copied', 1800);
    });

    // Row selection + select-all checkboxes.
    wrap.addEventListener('change', (ev) => {
      const cb = ev.target;
      if (!cb || !cb.classList) return;

      // Select-all: select/clear every row in the current (filtered) view.
      if (cb.classList.contains('ldc-sel-all')) {
        const keys = _rowKeys();
        if (cb.checked) keys.forEach((k) => _selected.add(k));
        else keys.forEach((k) => _selected.delete(k));
        _renderBodyOnly();
        return;
      }

      // Single row toggle — update membership + highlight without a full re-render.
      if (cb.classList.contains('ldc-sel')) {
        const rowKey = cb.getAttribute('data-rowkey');
        if (!rowKey) return;
        if (cb.checked) _selected.add(rowKey); else _selected.delete(rowKey);
        const tr = cb.closest('tr');
        if (tr) tr.classList.toggle('ldc-row-selected', cb.checked);
        const keys = _rowKeys();
        const all = _host.querySelector('.ldc-sel-all');
        if (all) all.checked = keys.length > 0 && keys.every((k) => _selected.has(k));
      }
    });

    // Click-to-sort on header titles. First click = ascending, second on the
    // same column = descending, third = clear. Re-renders the whole table so
    // the arrow indicator updates.
    wrap.addEventListener('click', (ev) => {
      const th = ev.target && ev.target.closest ? ev.target.closest('.ldc-sort-th') : null;
      if (!th) return;
      const key = th.getAttribute('data-sort');
      if (!key) return;
      if (_sort.key !== key) { _sort = { key, dir: 1 }; }
      else if (_sort.dir === 1) { _sort.dir = -1; }
      else { _sort = { key: null, dir: 1 }; } // third click clears
      _render();
    });
  }
}

// Re-render just the table body (keeps the sticky header + filter inputs, and
// therefore keyboard focus, intact while typing a filter).
function _renderBodyOnly() {
  if (!_host) return;
  const tbody = _host.querySelector('.ldc-table tbody');
  if (!tbody) { _render(); return; }
  const cols = _data.columns || [];
  const keys = _rowKeys();
  const body = keys.map(_bodyRowHtml).join('');
  const emptyMsg = !keys.length
    ? `<tr><td class="ldc-no-match" colspan="${cols.length + MANUAL_COLS.length + 1}">No rows match the current filters.</td></tr>`
    : '';
  tbody.innerHTML = body + emptyMsg;
}

// Single source of truth for a body row's HTML (selection column + CSV cells +
// manual cells). Used by both _renderTable and _renderBodyOnly.
function _bodyRowHtml(rowKey) {
  const cols = _data.columns || [];
  const r = _data.rows[rowKey] || {};
  const csv = r.csv || {};
  const manual = r.manual || {};
  const selCell = `<td class="ldc-sel-cell"><input type="checkbox" class="ldc-sel" data-rowkey="${_esc(rowKey)}" ${_selected.has(rowKey) ? 'checked' : ''} />`
    + `<button class="ldc-copy-row" data-rowkey="${_esc(rowKey)}" title="Copy this row">\uD83D\uDCCB</button></td>`;
  const csvCells = cols.map((h) => `<td class="ldc-csv-cell">${_esc(csv[h] || '')}</td>`).join('');
  const manualCells = MANUAL_COLS.map((c) => `<td class="ldc-manual-cell">${_manualCellHtml(rowKey, c, manual[c.key])}</td>`).join('');
  return `<tr data-rowkey="${_esc(rowKey)}" class="${_selected.has(rowKey) ? 'ldc-row-selected' : ''}">${selCell}${csvCells}${manualCells}</tr>`;
}

// ── Public API ───────────────────────────────────────────────────────────────
export async function refresh() {
  try { _data = (await csvBridge.get()) || { importedAt: null, columns: [], rows: {} }; }
  catch (e) { _data = { importedAt: null, columns: [], rows: {} }; }
  _render();
}

// Mount into a host element and load current data.
export function mount(hostEl) {
  _host = hostEl;
  _render();
  refresh();
}
