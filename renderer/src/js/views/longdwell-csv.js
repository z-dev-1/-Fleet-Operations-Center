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

import { longDwellCsv as csvBridge } from '../bridge.js';
import toast from '../components/toast.js';

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
function _rowKeys() {
  // Preserve import order (keys end in ::<index>) by sorting on the numeric tail.
  return Object.keys(_data.rows || {}).sort((a, b) => {
    const ai = parseInt(a.split('::').pop(), 10) || 0;
    const bi = parseInt(b.split('::').pop(), 10) || 0;
    return ai - bi;
  });
}

function _manualCellHtml(rowKey, col, value) {
  const v = value || '';
  if (col.key === 'delayReason') {
    const opts = ['<option value=""></option>']
      .concat(DELAY_REASONS.map((o) => `<option value="${_esc(o)}" ${o === v ? 'selected' : ''}>${_esc(o)}</option>`))
      .join('');
    return `<select class="settings__select ldc-input" data-rowkey="${_esc(rowKey)}" data-field="delayReason">${opts}</select>`;
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
  const keys = _rowKeys();
  if (!keys.length) {
    return `<div class="an-empty">No imported CSV yet. Click <strong>Import CSV</strong> and pick the AAP long-dwell tracker export.</div>`;
  }
  const headCsv    = cols.map((h) => `<th>${_esc(h)}</th>`).join('');
  const headManual = MANUAL_COLS.map((c) => `<th class="ldc-manual-th">${_esc(c.label)}</th>`).join('');
  const header = `<tr>${headCsv}${headManual}</tr>`;

  const body = keys.map((rowKey) => {
    const r = _data.rows[rowKey] || {};
    const csv = r.csv || {};
    const manual = r.manual || {};
    const csvCells = cols.map((h) => `<td class="ldc-csv-cell">${_esc(csv[h] || '')}</td>`).join('');
    const manualCells = MANUAL_COLS.map((c) => `<td class="ldc-manual-cell">${_manualCellHtml(rowKey, c, manual[c.key])}</td>`).join('');
    return `<tr data-rowkey="${_esc(rowKey)}">${csvCells}${manualCells}</tr>`;
  }).join('');

  return `<div class="ldc-table-scroll"><table class="an-table ldc-table"><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
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
          <button id="ldc-import" class="ec-preset-btn" title="Import the AAP long-dwell tracker CSV (A\u2013M columns). Your filled-in columns are preserved on re-import.">\u2b06\uFE0F Import CSV</button>
          <button id="ldc-copy" class="ec-preset-btn" title="Copy the full table (CSV + your filled columns) to paste into Excel/SharePoint">\uD83D\uDCCB Copy Table</button>
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
function _buildTsv() {
  const cols = _data.columns || [];
  const header = cols.concat(MANUAL_COLS.map((c) => c.label)).join('\t');
  const lines = [header];
  for (const rowKey of _rowKeys()) {
    const r = _data.rows[rowKey] || {};
    const csv = r.csv || {};
    const manual = r.manual || {};
    const cells = cols.map((h) => String(csv[h] || '').replace(/\r?\n/g, ' ').trim())
      .concat(MANUAL_KEYS.map((k) => String(manual[k] || '').replace(/\r?\n/g, ' ').trim()));
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

async function _copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
  }
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

  const copyBtn = _host.querySelector('#ldc-copy');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    if (!_rowKeys().length) { toast.show('warn', 'Nothing to copy \u2014 import a CSV first', 3000); return; }
    await _copyText(_buildTsv());
    toast.show('success', 'Table copied \u2014 paste into Excel/SharePoint', 2500);
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
  }
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
