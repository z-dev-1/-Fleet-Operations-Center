// ============================================================================
// fas-roster.js — FAS roster table (scraped from the FAS roster page).
//
// Self-contained module: renders into a host element and loads data via the
// fasRoster bridge (fas-roster:* IPC). The roster page shows FAS personnel
// (FAS Name, Site Code, Email, Phone, Uptime Manager, Program, SCAC). This
// view fetches the FULL roster in-app (no manual export), with per-column
// filters, a sticky header, and copy-to-clipboard export.
// ============================================================================

import { fasRoster as rosterBridge } from '../bridge.js';
import toast from '../components/toast.js';

let _host = null;
let _data = { fetchedAt: null, columns: [], rows: [] };
let _filters = {}; // column label -> filter text

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Filtering ────────────────────────────────────────────────────────────────
function _rowMatches(row) {
  const active = Object.entries(_filters).filter(([, v]) => String(v || '').trim() !== '');
  if (!active.length) return true;
  for (const [col, needleRaw] of active) {
    const needle = String(needleRaw).trim().toLowerCase();
    if (!String(row[col] || '').toLowerCase().includes(needle)) return false;
  }
  return true;
}

function _filteredRows() {
  return (_data.rows || []).filter(_rowMatches);
}

// ── Rendering ────────────────────────────────────────────────────────────────
function _renderToolbar() {
  const total = (_data.rows || []).length;
  const fetchedAt = _data.fetchedAt ? new Date(_data.fetchedAt).toLocaleString() : null;
  const meta = total
    ? `<span class="ldc-meta"><strong>${total}</strong> people${fetchedAt ? ' \u00b7 fetched ' + _esc(fetchedAt) : ''}</span>`
    : '';
  return `
    <div class="an-ld-toolbar ldc-toolbar">
      <div class="an-ld-toolbar-row">
        ${meta}
        <div class="an-ld-toolbar-actions">
          <button id="fr-fetch" class="ec-preset-btn ldc-fetch-btn" title="Pull the full FAS roster from the FAS page (no download). Uses your signed-in session.">\uD83D\uDD04 Fetch Roster</button>
          ${total ? '<button id="fr-tocontacts" class="ec-preset-btn" title="Add every roster person to your Contact Book as an internal contact (deduped by email; re-import updates them).">\uD83D\uDC65 Add to Contact Book</button>' : ''}
          <button id="fr-copy" class="ec-preset-btn" title="Copy the roster to paste into Excel/SharePoint">\uD83D\uDCCB Copy</button>
          ${total ? '<button id="fr-clear" class="ec-preset-btn" title="Clear the stored roster snapshot">\u2715 Clear</button>' : ''}
        </div>
      </div>
    </div>`;
}

function _renderTable() {
  const cols = _data.columns || [];
  if (!(_data.rows || []).length) {
    return `<div class="an-empty">No roster yet. Click <strong>Fetch Roster</strong> to pull the full FAS roster.</div>`;
  }
  const rows = _filteredRows();

  const titleRow = `<tr class="ldc-head-titles">${cols.map((h) => `<th>${_esc(h)}</th>`).join('')}</tr>`;
  const filterRow = `<tr class="ldc-head-filters">${cols.map((h) =>
    `<th class="ldc-filter-th"><input class="fr-filter" type="text" data-col="${_esc(h)}" value="${_esc(_filters[h] || '')}" placeholder="\uD83D\uDD0D" /></th>`
  ).join('')}</tr>`;

  const body = rows.map((r) =>
    `<tr>${cols.map((h) => `<td class="ldc-csv-cell">${_esc(r[h] || '')}</td>`).join('')}</tr>`
  ).join('');

  const emptyMsg = !rows.length
    ? `<tr><td class="ldc-no-match" colspan="${cols.length}">No rows match the current filters.</td></tr>`
    : '';

  return `<div class="ldc-table-scroll"><table class="an-table ldc-table"><thead>${titleRow}${filterRow}</thead><tbody>${body}${emptyMsg}</tbody></table></div>`;
}

function _render() {
  if (!_host) return;
  _host.innerHTML = _renderToolbar() + '<div id="fr-table-wrap">' + _renderTable() + '</div>';
  _wire();
}

function _renderBodyOnly() {
  if (!_host) return;
  const tbody = _host.querySelector('.ldc-table tbody');
  if (!tbody) { _render(); return; }
  const cols = _data.columns || [];
  const rows = _filteredRows();
  const body = rows.map((r) =>
    `<tr>${cols.map((h) => `<td class="ldc-csv-cell">${_esc(r[h] || '')}</td>`).join('')}</tr>`
  ).join('');
  const emptyMsg = !rows.length
    ? `<tr><td class="ldc-no-match" colspan="${cols.length}">No rows match the current filters.</td></tr>`
    : '';
  tbody.innerHTML = body + emptyMsg;
}

// ── Export ───────────────────────────────────────────────────────────────────
function _buildTsv() {
  const cols = _data.columns || [];
  const lines = [cols.join('\t')];
  for (const r of _filteredRows()) {
    lines.push(cols.map((h) => String(r[h] || '').replace(/\r?\n/g, ' ').trim()).join('\t'));
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
  const fetchBtn = _host.querySelector('#fr-fetch');
  if (fetchBtn) fetchBtn.addEventListener('click', async () => {
    const orig = fetchBtn.innerHTML;
    fetchBtn.disabled = true;
    fetchBtn.innerHTML = '\u23F3 Fetching roster\u2026';
    toast.show('info', 'Pulling the FAS roster\u2026', 2500);
    try {
      const res = await rosterBridge.fetch();
      if (res && res.ok) {
        toast.show('success', `Fetched ${res.count} people`, 3000);
        await refresh();
      } else {
        toast.show('warn', (res && res.error) || 'Roster fetch failed', 6000);
      }
    } catch (e) {
      toast.show('error', 'Roster fetch failed: ' + e.message, 6000);
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.innerHTML = orig;
    }
  });

  const toContactsBtn = _host.querySelector('#fr-tocontacts');
  if (toContactsBtn) toContactsBtn.addEventListener('click', async () => {
    const orig = toContactsBtn.innerHTML;
    toContactsBtn.disabled = true;
    toContactsBtn.innerHTML = '\u23F3 Adding\u2026';
    try {
      const res = await rosterBridge.importContacts();
      if (res && res.ok) {
        toast.show('success', `Contact Book: ${res.created} added, ${res.updated} updated${res.skipped ? ', ' + res.skipped + ' skipped' : ''}`, 4000);
      } else {
        toast.show('warn', (res && res.error) || 'Import to Contact Book failed', 5000);
      }
    } catch (e) {
      toast.show('error', 'Import failed: ' + e.message, 5000);
    } finally {
      toContactsBtn.disabled = false;
      toContactsBtn.innerHTML = orig;
    }
  });

  const copyBtn = _host.querySelector('#fr-copy');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    if (!(_data.rows || []).length) { toast.show('warn', 'Nothing to copy \u2014 fetch the roster first', 3000); return; }
    await _copyText(_buildTsv());
    toast.show('success', 'Roster copied \u2014 paste into Excel/SharePoint', 2500);
  });

  const clearBtn = _host.querySelector('#fr-clear');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    if (!window.confirm('Clear the stored FAS roster snapshot?')) return;
    try { await rosterBridge.clear(); toast.show('info', 'Cleared', 2000); await refresh(); }
    catch (e) { toast.show('error', 'Clear failed: ' + e.message, 3000); }
  });

  // Per-column filters — re-render only the tbody to keep focus.
  const wrap = _host.querySelector('#fr-table-wrap');
  if (wrap) {
    let _t = null;
    wrap.addEventListener('input', (ev) => {
      const el = ev.target;
      if (!el || !el.classList || !el.classList.contains('fr-filter')) return;
      const col = el.getAttribute('data-col');
      if (col == null) return;
      _filters[col] = el.value;
      clearTimeout(_t);
      _t = setTimeout(() => _renderBodyOnly(), 120);
    });
  }
}

// ── Public API ───────────────────────────────────────────────────────────────
export async function refresh() {
  try { _data = (await rosterBridge.get()) || { fetchedAt: null, columns: [], rows: [] }; }
  catch (e) { _data = { fetchedAt: null, columns: [], rows: [] }; }
  _render();
}

export function mount(hostEl) {
  _host = hostEl;
  _render();
  refresh();
}
