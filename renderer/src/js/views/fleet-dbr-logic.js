/**
 * fleet-dbr-logic.js — pure helpers for the Daily Call "📊 DBR DATA" panel
 * (24-column Fleet Health DBR built from fleet data; see ./fleet-dbr-panel.js).
 *
 * No imports and no DOM globals, so tests/fleet-dbr-render.test.js can import
 * it directly (no jsdom in this repo). The column list is NOT hard-coded here:
 * every table / TSV helper iterates `model.columns` (COLUMNS from
 * src/dbr/fleet-dbr.js, shipped in the IPC view model) so on-screen order and
 * paste order can never drift from the main-process source of truth.
 */

// ── Escaping ────────────────────────────────────────────────────────────────
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Same quoting rule as daily-call.js _tsvCell: a cell containing a tab,
// newline, CR or double-quote is wrapped in quotes (inner quotes doubled) so a
// multi-line cell pastes into ONE spreadsheet cell.
export function tsvCell(v) {
  const s = String(v == null ? '' : v);
  if (/[\t\n"\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const _cellOf = (row, id) => (row && row.cells && row.cells[id] != null ? row.cells[id] : '');

// Rows joined by \n, cells by \t, in `columns` order. getValue(row, colId)
// lets the panel read live textarea values (unsaved typing is copied too).
export function rowsToTsv(columns, rows, getValue, opts = {}) {
  const cols = Array.isArray(columns) ? columns : [];
  const get = typeof getValue === 'function' ? getValue : _cellOf;
  const lines = [];
  if (opts && opts.header) lines.push(cols.map((c) => tsvCell(c.header)).join('\t'));
  for (const r of rows || []) lines.push(cols.map((c) => tsvCell(get(r, c.id))).join('\t'));
  return lines.join('\n');
}

const _down = (row) => (row && row.pair && Number(row.pair.down)) || 0;

export function visibleRows(model, hideZero) {
  const rows = model && Array.isArray(model.rows) ? model.rows : [];
  return hideZero ? rows.filter((r) => _down(r) > 0) : rows;
}

// The AI judgment cells of the model (main: AI_CELL_IDS); older models only had the two.
export function aiCellIds(model) {
  return model && Array.isArray(model.aiCellIds) && model.aiCellIds.length ? model.aiCellIds : ['fasActions', 'support'];
}

// Auto-draft eligibility: has down units, the user hasn't edited EVERY editable AI cell, and
// the draft is missing (none) or stale by 'units' / 'identity'. A draft stale only by
// 'evidence' is queued by "Draft all" / ↻ (includeEvidenceStale), not on panel open.
export function eligibleForAutoDraft(model, { includeEvidenceStale = false } = {}) {
  const rows = model && Array.isArray(model.rows) ? model.rows : [];
  const cols = model && Array.isArray(model.columns) ? model.columns : [];
  const ids = aiCellIds(model);
  const editable = cols.length ? ids.filter((id) => cols.some((c) => c.id === id && c.editable)) : ids;
  const out = [];
  for (const r of rows) {
    if (_down(r) <= 0) continue;
    const src = r.source || {};
    if (editable.length && editable.every((id) => src[id] === 'edit')) continue;
    const d = r.draft || {};
    const state = d.state || 'none';
    if (state === 'stale') {
      const why = d.staleReason || 'units';
      if (why === 'evidence' && !includeEvidenceStale) continue;
    } else if (state !== 'none') continue;
    out.push(r.key);
  }
  return out;
}

// Cells flagged ⚠ for review across rows, excluding cells the user edited (saved or live).
export function flaggedCount(rows, isEdited) {
  let n = 0;
  for (const r of rows || []) {
    const flags = (r && r.flags) || {};
    const src = (r && r.source) || {};
    for (const [id, v] of Object.entries(flags)) {
      if (v !== 'review' || src[id] === 'edit') continue;
      if (typeof isEdited === 'function' && isEdited(r, id)) continue;
      n++;
    }
  }
  return n;
}

// Minutes left for the AI queue (§7): measured per-row rate once a row is done, else
// 240 s per row spread over the in-flight slots.
export function etaMinutes({ done = 0, total = 0, startedAt = 0, now = 0, slots = 2 } = {}) {
  const remaining = Math.max(0, total - done);
  if (!remaining) return 0;
  const perRowMs = done > 0 && startedAt ? Math.max(0, now - startedAt) / done : 240000 / Math.max(1, slots);
  return Math.ceil((remaining * perRowMs) / 60000);
}

// ── Notes ───────────────────────────────────────────────────────────────────
export const ETC_NOTE = "ETC is best-effort: parsed from notes/timeline text (ETC / ETR / estimated completion / expected ready + a date). The ETC cells are whole-number counts; the unit IDs are in each row's drill-down. 'Expected today' counts every down unit with an ETC today (not only 1P/OEM). A bare parts/tow 'ETA' is not an ETC. Nothing is guessed.";
export const OEM_NOTE = 'OEM = at OEM/dealer and stalled (waiting/diagnosis/no dealer status/\u226514d).';
export const ROW_NOTE = 'One row per Domicile \u00d7 SCAC in your fleet data; Domicile and SCAC uptime are whole-domicile / whole-SCAC figures.';
export const DOWN_NOTE = 'Down = lifecycle state Unavailable; Ordered units count in totals, not as down.';
export const AI_NOTE = "AI decides each barrier Y/N and writes Details, ETC, FAS Actions and Support from every down unit's full record. Specifics are fact-checked against the evidence. \u26a0 marks cells to review. Review before pasting.";
export const OFF_NOTICE = 'Fleet DBR is turned off (settings.dbr.fleetData = false).';
export const UNAVAILABLE_NOTICE = 'Fleet DBR unavailable in this build.';
export const TITLE = '\ud83d\udcca DBR \u2014 Fleet Health (from fleet data)';

// ── Status line ─────────────────────────────────────────────────────────────
function _hhmm(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// "Built 10:31 from fleet sync 10:30 · 21 rows · 53 down · AI 7/15 · 2 rows use your name (no roster match)"
export function statusLine(model, opts = {}) {
  if (!model) return '';
  const rows = Array.isArray(model.rows) ? model.rows : [];
  const parts = [];
  const built = _hhmm(model.builtAt);
  if (built) {
    const synced = _hhmm(model.fleetSyncedAt);
    parts.push('Built ' + built + (synced ? ' from fleet sync ' + synced : ''));
  }
  if (model.day) parts.push(model.day);
  parts.push(rows.length + (rows.length === 1 ? ' row' : ' rows'));
  parts.push((Number(model.downCount) || 0) + ' down');
  const ai = opts && opts.ai;
  if (ai && ai.total > 0) {
    const eta = ai.done < ai.total && Number.isFinite(ai.etaMin) && ai.etaMin > 0 ? ' \u00b7 ~' + ai.etaMin + ' min left' : '';
    parts.push('AI ' + ai.done + '/' + ai.total + eta);
  }
  const you = rows.filter((r) => r && r.fasSource === 'you').length;
  if (you) parts.push(you + (you === 1 ? ' row uses' : ' rows use') + ' your name (no roster match)');
  return parts.join(' \u00b7 ');
}

// ── Per-row drill-down ──────────────────────────────────────────────────────
const ETC_LABEL = { today: 'ETC today', missed: 'Missed ETC', future: 'ETC future', none: 'NO ETC' };

const BARRIER_LABEL = {
  vendor1p: '1P Vendor', oem: 'OEM', estimate: 'Estimate', partner: 'Partner', parts: 'Parts Delay', common: 'Common Repairs',
};
const _arr = (v) => (Array.isArray(v) ? v : []);
const _line = (text) => '<br><span class="fdbr-muted">' + esc(text) + '</span>';

// Per-unit AI lines of the drill-down (AI ETC, ETC disagreements / overrides, FAS sources,
// unverified names, unbound dates). Every value is escaped.
function _aiUnitLines(r, id, units) {
  const out = [];
  const etcU = _arr(r.etcUnits).find((e) => e && e.unit === id);
  if (etcU) out.push('AI ETC: ' + [etcU.state || 'none', etcU.date || '', '(' + (etcU.origin || 'ai') + ')'].filter(Boolean).join(' '));
  for (const d of _arr(r.etcDisagreements)) if (d && d.unit === id) out.push('ETC: AI ' + (d.ai || '') + ' vs rules ' + (d.code || ''));
  for (const o of _arr(r.etcOverrides)) {
    if (!o || o.unit !== id) continue;
    out.push('ETC: AI none (rules ' + (o.code || '') + ')' + (etcU && etcU.why ? " \u2014 '" + etcU.why + "'" : ''));
  }
  const seen = new Set();
  for (const byUnit of Object.values(r.provenance && typeof r.provenance === 'object' ? r.provenance : {})) {
    for (const it of _arr(byUnit && byUnit[id])) {
      if (!it) continue;
      const s = 'sources: ' + (it.date || '') + " [FAS] '" + (it.quote || '') + "'";
      if (!seen.has(s)) { seen.add(s); out.push(s); }
    }
  }
  for (const n of _arr(r.unverifiedNames)) {
    if (!n) continue;
    const on = Array.isArray(n.units) ? n.units.includes(id) : (n.unit === id || (!n.unit && units === 1));
    if (on) out.push('unverified name: ' + (n.name || '') + ' (' + (n.cell || '') + ')');
  }
  for (const b of _arr(r.unboundDates)) if (b && b.unit === id) out.push('unbound date: ' + (b.kw || '') + ' ' + (b.date || '') + ' (' + (b.cell || '') + ')');
  return out.map(_line).join('');
}

export function unitsDrillHtml(row) {
  const r = row || {};
  const pair = r.pair || {};
  const units = Array.isArray(r.units) ? r.units : [];
  const fasSrc = r.fasSource || 'none';
  const items = units.map((u) => {
    const etc = u.etc || {};
    const bits = [
      u.daysDown == null ? '' : u.daysDown + 'd',
      u.lifecycleReason || '',
      u.vendor || 'no vendor',
      u.status || '',
      u.serviceState || '',
    ].filter(Boolean).map(esc).join(' \u00b7 ');
    const etcBits = [ETC_LABEL[etc.state] || 'NO ETC', etc.date || '', etc.source ? '(' + etc.source + ')' : ''].filter(Boolean).join(' ');
    const tags = [...(u.barriers || []), ...(u.categories || [])];
    return '<li><strong>' + esc(u.id) + '</strong> ' + bits
      + '<br><span class="fdbr-muted">' + esc(etcBits) + (etc.snippet ? ': ' + esc(etc.snippet) : '') + '</span>'
      + (tags.length ? '<br><span class="fdbr-muted">tags: ' + esc(tags.join(', ')) + '</span>' : '')
      + _aiUnitLines(r, u.id, units.length)
      + '</li>';
  }).join('');
  const rowLines = [];
  const dis = _arr(r.disagreements).map((b) => {
    const ai = String((r.cells && r.cells[b + 'YN']) || '').trim().toUpperCase().startsWith('Y') ? 'Y' : 'N';
    return (BARRIER_LABEL[b] || b) + ' AI=' + ai + ' rules=' + (ai === 'Y' ? 'N' : 'Y');
  });
  if (dis.length) rowLines.push('AI vs rules: ' + dis.join('; '));
  if (r.reviewSkipped) rowLines.push('AI self-review skipped: ' + r.reviewSkipped);
  return '<details class="fdbr-drill"><summary>' + esc((pair.down || 0) + ' down / ' + (pair.total || 0)) + '</summary>'
    + '<div class="fdbr-muted">FAS source: ' + esc(fasSrc) + (r.rosterFas ? ' (roster: ' + esc(r.rosterFas) + ')' : '') + '</div>'
    + rowLines.map((t) => '<div class="fdbr-muted">' + esc(t) + '</div>').join('')
    + (items ? '<ul class="fdbr-units">' + items + '</ul>' : '<div class="fdbr-muted">No down units.</div>')
    + '</details>';
}

// Row status badge: renderer-side draft progress first, then the model's draft state.
export function badgeHtml(row, status) {
  const s = status || {};
  if (s.state === 'queued') return '<span class="fdbr-badge">\u23f3 queued</span>';
  if (s.state === 'pending') return '<span class="fdbr-badge">\u23f3 drafting</span>';
  if (s.state === 'error') return '<span class="fdbr-badge fdbr-badge--warn">\u26a0 ' + esc(s.code || 'failed') + '</span>';
  const d = (row && row.draft && row.draft.state) || 'none';
  if (d === 'stale') return '<span class="fdbr-badge fdbr-badge--warn">\u26a0 data changed since draft</span>';
  if (d === 'ok') return '<span class="fdbr-badge fdbr-badge--ok">\u2713 AI draft</span>';
  return '';
}

// ── Table ───────────────────────────────────────────────────────────────────
// Text markers (never color-only): "edited", "AI" on AI-written cells, "⚠ check" on
// cells the fact-check flagged for review (not shown once the user edited the cell).
export function markHtml(row, col) {
  const src = (row && row.source) || {};
  const flags = (row && row.flags) || {};
  if (src[col] === 'edit') return '<span class="fdbr-mark">edited</span>';
  let out = src[col] === 'ai' ? '<span class="fdbr-mark">AI</span>' : '';
  if (flags[col] === 'review') out += '<span class="fdbr-mark fdbr-mark--warn">\u26a0 check</span>';
  return out;
}
// Inner HTML of a non-editable AI cell (value + markers, escaped); refreshRow patches it.
export function cellInnerHtml(row, col, value) {
  const v = value !== undefined ? value : _cellOf(row, col);
  return esc(v) + markHtml(row, col);
}

// 24 <th scope="col"> in model.columns order, plus one UI-only last column
// (drill-down + row buttons) that is never copied. Non-editable AI cells (the 6 Y/N) carry
// data-key/data-col so the panel can patch them; hard cells are plain <td>.
export function tableHtml(model, opts = {}) {
  const cols = model && Array.isArray(model.columns) ? model.columns : [];
  const aiIds = new Set(aiCellIds(model));
  const aiDraft = !!opts.aiDraft;
  const rowStatus = opts.rowStatus || {};
  const get = typeof opts.getValue === 'function' ? opts.getValue : _cellOf;
  const rows = visibleRows(model, !!opts.hideZero);
  if (!rows.length) {
    return '<div class="dc-empty">' + (model && model.rows && model.rows.length
      ? 'Every row has 0 down \u2014 untick "Hide rows with 0 down" to see them.'
      : 'No rows yet \u2014 click \u21ba Build from fleet data.') + '</div>';
  }
  const head = '<thead><tr>' + cols.map((c) => '<th scope="col">' + esc(c.header) + '</th>').join('')
    + '<th scope="col">Units / Row</th></tr></thead>';
  const body = rows.map((r) => {
    const label = (r.domicile || '') + '/' + (r.scac || '');
    const tds = cols.map((c) => {
      const v = get(r, c.id);
      if (!c.editable) {
        if (!aiIds.has(c.id)) return '<td>' + esc(v) + '</td>';
        return '<td data-key="' + esc(r.key) + '" data-col="' + esc(c.id) + '">' + cellInnerHtml(r, c.id, v) + '</td>';
      }
      return '<td class="fdbr-td">'
        + '<textarea class="dc-input fdbr-cell" rows="2" data-key="' + esc(r.key) + '" data-col="' + esc(c.id) + '"'
        + ' aria-label="' + esc(c.header + ' \u2014 ' + label) + '">' + esc(v) + '</textarea>'
        + '<span class="fdbr-marks" data-mark-key="' + esc(r.key) + '" data-mark-col="' + esc(c.id) + '">' + markHtml(r, c.id) + '</span></td>';
    }).join('');
    const btn = (action, text, aria) => '<button type="button" class="detail-panel__btn detail-panel__btn--secondary fdbr-mini"'
      + ' data-fdbr-action="' + action + '" data-key="' + esc(r.key) + '" aria-label="' + esc(aria + ' ' + label) + '">' + text + '</button>';
    const ui = '<td class="fdbr-ui">' + unitsDrillHtml(r)
      + '<div class="fdbr-row-btns">'
      + (aiDraft && _down(r) > 0 ? btn('redraft', '\u2728 Redraft', 'Redraft AI cells for') : '')
      + btn('reset-row', '\u21ba Reset row', 'Reset edits for')
      + btn('copy-row', '\ud83d\udccb Copy row', 'Copy row')
      + '</div><span data-fdbr-badge="' + esc(r.key) + '">' + badgeHtml(r, rowStatus[r.key]) + '</span></td>';
    return '<tr data-key="' + esc(r.key) + '">' + tds + ui + '</tr>';
  }).join('');
  return '<table class="dc-table fdbr-table">' + head + '<tbody>' + body + '</tbody></table>';
}

export function bannerHtml(show) {
  if (!show) return '';
  return '<div class="fdbr-banner" role="alert">Fleet data updated \u2014 '
    + '<button type="button" class="detail-panel__btn detail-panel__btn--secondary fdbr-mini" data-fdbr-action="build">\u21ba Build</button> to refresh</div>';
}

// ── Panel frame ─────────────────────────────────────────────────────────────
// The overlay is appended to document.body (outside #view-daily-call), so it
// carries its own rules for the shared dc-* classes. The first block is copied
// verbatim from the retired daily-call.js panel (_dbrPanelHtml).
export const PANEL_CSS = `
    /* DBR overlay is appended directly to document.body (not inside
       #view-daily-call), so it needs its own unscoped rules for the
       dc-* classes shared with the main Daily Call view's table CSS. */
    #dbr-overlay .dc-table { width: 100%; border-collapse: collapse; }
    #dbr-overlay .dc-table th, #dbr-overlay .dc-table td { border: 1px solid var(--border, #333); padding: 6px; vertical-align: top; font-size: 11px; }
    #dbr-overlay .dc-input { width: 100%; box-sizing: border-box; resize: vertical; font-size: 11px; font-family: inherit; background: var(--bg2, #1a1a2e); color: var(--fg, #eee); border: 1px solid var(--border, #444); border-radius: 4px; padding: 4px 6px; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
    #dbr-overlay .dc-input.dbr-cell--autogrow { resize: none; overflow: hidden; min-height: 36px; }
    #dbr-overlay td { max-width: 260px; }
    #dbr-overlay .dc-section-title { font-size: 20px; font-weight: 700; margin: 18px 0 2px; }
    #dbr-overlay .dc-section-subtitle { font-size: 13px; font-weight: 600; margin: 4px 0 8px; text-transform: uppercase; }
    #dbr-overlay .dc-empty { padding: 10px; font-size: 11px; color: var(--mut, #888); }
    /* Fleet DBR additions */
    #dbr-overlay .fdbr-cell { resize: none; overflow: hidden; min-height: 36px; }
    #dbr-overlay .fdbr-td { min-width: 170px; }
    #dbr-overlay .fdbr-scroll { flex: 1 1 auto; overflow: auto; padding: 0 18px 14px; }
    #dbr-overlay .dc-table thead th { position: sticky; top: 0; z-index: 1; background: var(--bg2, #0d1117); white-space: nowrap; }
    #dbr-overlay .fdbr-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
    #dbr-overlay .fdbr-notes { font-size: 10px; color: var(--mut, #888); margin: 0 0 4px; padding-left: 16px; }
    #dbr-overlay .fdbr-muted { font-size: 10px; color: var(--mut, #888); }
    #dbr-overlay .fdbr-mark { display: block; font-size: 9px; color: var(--mut, #888); }
    #dbr-overlay .fdbr-mark--warn { color: #f0a800; font-weight: 600; }
    #dbr-overlay .fdbr-mini { font-size: 10px; margin: 2px 2px 0 0; }
    #dbr-overlay .fdbr-ui { min-width: 190px; }
    #dbr-overlay .fdbr-units { margin: 4px 0; padding-left: 14px; }
    #dbr-overlay .fdbr-badge { font-size: 10px; display: inline-block; margin-top: 4px; }
    #dbr-overlay .fdbr-badge--warn { color: #f0a800; }
    #dbr-overlay .fdbr-badge--ok { color: #3fb950; }
    #dbr-overlay .fdbr-banner { margin: 0 18px 6px; padding: 6px 10px; font-size: 11px; border: 1px solid #f0a800; border-radius: 4px; }
    #dbr-overlay .fdbr-status { font-size: 11px; color: var(--mut, #888); padding: 0 18px 6px; min-height: 14px; }
`;

// state: { status:'ready'|'loading'|'off'|'unavailable'|'error', aiDraft, drafting,
//          fasName, hideZero, message, conflicts:[{id}] }
export function panelHtml(state = {}) {
  const s = state || {};
  const header = '<style>' + PANEL_CSS + '</style>'
    + '<div class="wr-modal__header"><div class="wr-modal__title-row">'
    + '<span class="wr-modal__title" id="fdbr-title">' + esc(TITLE) + '</span></div>'
    + '<button type="button" class="wr-modal__close" data-fdbr-action="close" aria-label="Close">\u00d7</button></div>';
  if (s.status === 'off') return header + '<div class="wr-modal__body"><div class="dc-empty" role="note">' + esc(OFF_NOTICE) + '</div></div>';
  if (s.status === 'unavailable') return header + '<div class="wr-modal__body"><div class="dc-empty" role="note">' + esc(UNAVAILABLE_NOTICE) + '</div></div>';
  if (s.status === 'error') return header + '<div class="wr-modal__body"><div class="dc-empty" role="note">' + esc(s.message || 'Fleet DBR could not load.') + '</div></div>';

  const btn = (action, text, extra) => '<button type="button" class="detail-panel__btn' + (extra || '') + '" data-fdbr-action="' + action + '">' + text + '</button>';
  const ai = s.aiDraft
    ? (s.drafting ? btn('stop', '\u25a0 Stop', ' detail-panel__btn--secondary') : btn('draft-all', '\u2728 Draft with AI', ' detail-panel__btn--secondary'))
    : '';
  const fas = String(s.fasName || '');
  const toolbar = '<div class="fdbr-toolbar">'
    + '<label style="font-size:11px;display:flex;align-items:center;gap:6px;">FAS Name:'
    + '<input type="text" class="dc-input" style="width:180px;display:inline-block;" data-fdbr-field="fasName" maxlength="120"'
    + ' placeholder="Enter your FAS name" value="' + esc(fas) + '"></label>'
    + btn('build', '\u21ba Build from fleet data')
    + ai
    + btn('copy', '\ud83d\udccb Copy rows', ' detail-panel__btn--secondary')
    + btn('copy-header', '\ud83d\udccb Copy with header', ' detail-panel__btn--secondary')
    + '<label style="font-size:11px;display:flex;align-items:center;gap:4px;">'
    + '<input type="checkbox" data-fdbr-field="hideZero"' + (s.hideZero ? ' checked' : '') + '> Hide rows with 0 down</label>'
    + '</div>';
  const hint = fas ? '' : '<div class="fdbr-muted" style="margin-bottom:6px;">No FAS name set \u2014 rows without a roster match stay blank until you enter one (or type it per row).</div>';
  const conflicts = Array.isArray(s.conflicts) ? s.conflicts : [];
  const notes = [ROW_NOTE, ETC_NOTE, OEM_NOTE, DOWN_NOTE];
  if (s.aiDraft) notes.push(AI_NOTE);
  if (conflicts.length) {
    notes.push(conflicts.length + ' unit(s) have conflicting status signals (counted by lifecycle state): '
      + conflicts.slice(0, 20).map((c) => c && c.id).filter(Boolean).join(', ') + (conflicts.length > 20 ? ', \u2026' : ''));
  }
  return header + '<div class="wr-modal__body" style="flex:0 0 auto;padding-bottom:4px;">' + toolbar + hint
    + '<ul class="fdbr-notes">' + notes.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul></div>';
}
