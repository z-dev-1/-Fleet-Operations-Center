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
  const rows = _data.rows || [];
  const active = Object.entries(_filters).filter(([, v]) => String(v || '').trim() !== '');
  if (!active.length) return rows;

  // Person-aware filtering: if ANY of a person's (Site+SCAC) rows matches ALL
  // active filters, show that person's FULL block (so filtering by one SCAC
  // still shows all of that person's sites/SCACs, per the display grouping).
  const matchNames = new Set();
  let hasNameFilter = false;
  for (const [col] of active) if (col === 'FAS Name') hasNameFilter = true;

  for (const r of rows) {
    if (_rowMatches(r)) {
      const nm = String(r['FAS Name'] || r['Name'] || '').trim().toLowerCase();
      if (nm) matchNames.add(nm);
    }
  }
  return rows.filter((r) => {
    const nm = String(r['FAS Name'] || r['Name'] || '').trim().toLowerCase();
    return nm && matchNames.has(nm);
  });
}

// ── Grouping (one person; sites listed; SCACs grouped per site) ───────────────
// Groups the flat per-(Site+SCAC) rows into:
//   [ { name, email, phone, program, uptimeManager,
//       sites: [ { site, scacs:[...] }, ... ] }, ... ]
// Keeps the underlying per-combo data untouched (used by the lookup/auto-fill);
// this grouping is DISPLAY ONLY.
const _g = (r, names) => {
  for (const n of names) { if (r[n] != null && String(r[n]).trim() !== '') return String(r[n]).trim(); }
  return '';
};

function _groupByPerson(rows) {
  const people = new Map(); // name -> { name, meta..., sites: Map(site -> Set(scac)) }
  for (const r of rows) {
    const name = _g(r, ['FAS Name', 'Name']);
    const site = _g(r, ['Site Code', 'Site']);
    const scac = _g(r, ['SCAC']);
    const key = name || ('(' + site + '/' + scac + ')');
    if (!people.has(key)) {
      people.set(key, {
        name,
        email: _g(r, ['Email']),
        phone: _g(r, ['Phone']),
        program: _g(r, ['Program']),
        uptimeManager: _g(r, ['Uptime Manager']),
        sites: new Map(),
      });
    }
    const p = people.get(key);
    if (site) {
      if (!p.sites.has(site)) p.sites.set(site, new Set());
      if (scac) p.sites.get(site).add(scac);
    }
    // keep first-seen contact fields; fill blanks
    if (!p.email) p.email = _g(r, ['Email']);
    if (!p.phone) p.phone = _g(r, ['Phone']);
    if (!p.program) p.program = _g(r, ['Program']);
    if (!p.uptimeManager) p.uptimeManager = _g(r, ['Uptime Manager']);
  }
  // Shape into arrays, sorted by name.
  return [...people.values()]
    .map((p) => ({
      ...p,
      sites: [...p.sites.entries()]
        .map(([site, scacs]) => ({ site, scacs: [...scacs].sort() }))
        .sort((a, b) => a.site.localeCompare(b.site)),
    }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

// ── Rendering ────────────────────────────────────────────────────────────────
function _renderToolbar() {
  const total = (_data.rows || []).length;
  const peopleCount = new Set((_data.rows || [])
    .map((r) => String(r['FAS Name'] || r['Name'] || '').trim().toLowerCase())
    .filter(Boolean)).size;
  const fetchedAt = _data.fetchedAt ? new Date(_data.fetchedAt).toLocaleString() : null;
  const meta = total
    ? `<span class="ldc-meta"><strong>${peopleCount}</strong> people \u00b7 ${total} combos${fetchedAt ? ' \u00b7 fetched ' + _esc(fetchedAt) : ''}</span>`
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

// Grouped columns: Name once (rowspan), then one line per Site with its SCACs,
// plus a few contact columns. The filter row keys on these display columns.
const GROUP_COLS = ['FAS Name', 'Site Code', 'SCAC', 'Email', 'Phone', 'Program', 'Uptime Manager'];

function _buildGroupBodyRows() {
  const people = _groupByPerson(_filteredRows());
  if (!people.length) {
    return `<tr><td class="ldc-no-match" colspan="${GROUP_COLS.length}">No rows match the current filters.</td></tr>`;
  }
  const out = [];
  for (const p of people) {
    const siteRows = p.sites.length ? p.sites : [{ site: '', scacs: [] }];
    const span = siteRows.length;
    siteRows.forEach((sr, i) => {
      const nameCell = i === 0
        ? `<td class="fr-name-cell" rowspan="${span}"><strong>${_esc(p.name)}</strong></td>`
        : '';
      const metaCells = i === 0
        ? `<td class="ldc-csv-cell" rowspan="${span}">${_esc(p.email)}</td>`
          + `<td class="ldc-csv-cell" rowspan="${span}">${_esc(p.phone)}</td>`
          + `<td class="ldc-csv-cell" rowspan="${span}">${_esc(p.program)}</td>`
          + `<td class="ldc-csv-cell" rowspan="${span}">${_esc(p.uptimeManager)}</td>`
        : '';
      out.push(
        `<tr class="${i === 0 ? 'fr-person-start' : ''}">`
        + nameCell
        + `<td class="ldc-csv-cell">${_esc(sr.site)}</td>`
        + `<td class="ldc-csv-cell">${_esc(sr.scacs.join(', '))}</td>`
        + metaCells
        + `</tr>`
      );
    });
  }
  return out.join('');
}

function _renderTable() {
  if (!(_data.rows || []).length) {
    return `<div class="an-empty">No roster yet. Click <strong>Fetch Roster</strong> to pull the full FAS roster.</div>`;
  }
  const titleRow = `<tr class="ldc-head-titles">${GROUP_COLS.map((h) => `<th>${_esc(h)}</th>`).join('')}</tr>`;
  const filterRow = `<tr class="ldc-head-filters">${GROUP_COLS.map((h) =>
    `<th class="ldc-filter-th"><input class="fr-filter" type="text" data-col="${_esc(h)}" value="${_esc(_filters[h] || '')}" placeholder="\uD83D\uDD0D" /></th>`
  ).join('')}</tr>`;

  return `<div class="ldc-table-scroll"><table class="an-table ldc-table fr-grouped"><thead>${titleRow}${filterRow}</thead><tbody>${_buildGroupBodyRows()}</tbody></table></div>`;
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
  tbody.innerHTML = _buildGroupBodyRows();
}

// ── Export (grouped: name once, one line per site with its SCACs) ─────────────
function _buildTsv() {
  const people = _groupByPerson(_filteredRows());
  const lines = [GROUP_COLS.join('\t')];
  for (const p of people) {
    const siteRows = p.sites.length ? p.sites : [{ site: '', scacs: [] }];
    siteRows.forEach((sr, i) => {
      const row = i === 0
        ? [p.name, sr.site, sr.scacs.join(', '), p.email, p.phone, p.program, p.uptimeManager]
        : ['', sr.site, sr.scacs.join(', '), '', '', '', ''];
      lines.push(row.map((c) => String(c || '').replace(/\r?\n/g, ' ').trim()).join('\t'));
    });
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
        const s = res.sources || {};
        const srcNote = (s.web != null || s.sharepoint != null)
          ? ` (web: ${s.web}, SharePoint: ${s.sharepoint})` : '';
        toast.show('success', `Fetched ${res.count} roster rows${srcNote}`, 4500);
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
