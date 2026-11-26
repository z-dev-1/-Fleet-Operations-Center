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

// ── Copy fill columns ───────────────────────────────────────────────────────
// The fill columns = model.columns that are AI judgment cells (model.aiCellIds: every column
// except the 7 leading identity/count cells), in model.columns order (17 today).
export function fillColumns(model) {
  const cols = model && Array.isArray(model.columns) ? model.columns : [];
  const ids = new Set(aiCellIds(model));
  return cols.filter((c) => c && ids.has(c.id));
}

// One paste-safe fill cell: tabs and line breaks become single spaces, so every cell stays
// in one tab slot and every row on one line (Excel / Sheets paste).
export function fillCell(v) {
  return String(v == null ? '' : v).replace(/\t/g, ' ').replace(/[ \t]*[\r\n]+[ \t]*/g, ' ').trim();
}

// TSV of only the fill columns for `rows` (no header); getValue reads live textarea values.
export function fillColumnsTsv(model, rows, getValue) {
  const cols = fillColumns(model);
  const get = typeof getValue === 'function' ? getValue : _cellOf;
  return (rows || []).map((r) => cols.map((c) => fillCell(get(r, c.id))).join('\t')).join('\n');
}

const _down = (row) => (row && row.pair && Number(row.pair.down)) || 0;

// ── Copy for SharePoint (golden sheet format, design §3.12, I4) ─────────────
// Column kinds by id (the ids come from model.columns; nothing else is hard-coded).
const _isYn = (id) => /YN$/.test(String(id));
const _isUptime = (id) => /Uptime$/.test(String(id));
const COUNT_IDS = new Set(['etcToday', 'noEtc', 'missedEtc']);

// The one formatter for copied cells and on-screen non-editable cells: Y/N -> Yes/No, uptime
// '69%' -> '69', ETC counts -> the first line's digits (legacy "1\n• …" -> "1"), every value
// single-line (fillCell). A user-edited cell (source 'edit') is never normalized beyond fillCell,
// so typed text such as "1 – 211022: waiting on parts" copies as typed (DR2-6).
export function sheetValue(colId, v, source) {
  const s = fillCell(v);
  if (source === 'edit') return s;
  if (_isYn(colId)) {
    if (/^y/i.test(s)) return 'Yes';
    if (/^n/i.test(s)) return 'No';
    return s;
  }
  if (_isUptime(colId)) return s.replace(/\s*%$/, '');
  if (COUNT_IDS.has(colId)) {
    const first = String(v == null ? '' : v).split(/\r?\n/)[0];
    const m = /^\s*(\d+)/.exec(first);
    return m ? m[1] : s;
  }
  return s;
}

// TSV in the golden sheet format: sheetValue per cell, then tsvCell (a cell still holding '"'
// is quoted). getValue(row, colId) reads live values; opts.getSource(row, colId) the cell source
// (default row.source[colId]); opts.header adds the column headers line.
export function sheetTsv(columns, rows, getValue, opts = {}) {
  const cols = Array.isArray(columns) ? columns : [];
  const get = typeof getValue === 'function' ? getValue : _cellOf;
  const src = opts && typeof opts.getSource === 'function' ? opts.getSource : (r, id) => (r && r.source ? r.source[id] : undefined);
  const lines = [];
  if (opts && opts.header) lines.push(cols.map((c) => tsvCell(c.header)).join('\t'));
  for (const r of rows || []) lines.push(cols.map((c) => tsvCell(sheetValue(c.id, get(r, c.id), src(r, c.id)))).join('\t'));
  return lines.join('\n');
}

// Table and copy order (a view concern; the builder sort is unchanged): the user's pairs first,
// then pair units down desc, SCAC units down desc, domicile asc, SCAC asc.
export function sheetOrder(rows) {
  const n = (v) => Number(v) || 0;
  const s = (v) => String(v == null ? '' : v);
  return (Array.isArray(rows) ? rows : []).slice().sort((a, b) => (
    (b && b.mine ? 1 : 0) - (a && a.mine ? 1 : 0)
    || _down(b) - _down(a)
    || n(b && b.scacStats && b.scacStats.down) - n(a && a.scacStats && a.scacStats.down)
    || (s(a && a.domicile) < s(b && b.domicile) ? -1 : s(a && a.domicile) > s(b && b.domicile) ? 1 : 0)
    || (s(a && a.scac) < s(b && b.scac) ? -1 : s(a && a.scac) > s(b && b.scac) ? 1 : 0)));
}

// The copy-scope choice: 'mine' (the user's roster pairs with units down) needs a loaded roster,
// a user name and at least one matching pair (DR2-13); otherwise it is disabled with a note and
// copy falls back to the visible rows.
// -> { mineOk, note, mineCount, visibleCount }
export function copyScopeInfo(model, hideZero, scacs) {
  const rows = model && Array.isArray(model.rows) ? model.rows : [];
  const mineCount = rows.filter((r) => r && r.mine && _down(r) > 0).length;
  const visibleCount = visibleRows(model, hideZero, scacs).length;
  const name = String((model && model.userName) || '').trim();
  let note = '';
  if (!(model && model.rosterLoaded)) note = 'FAS roster not loaded \u2014 copying all visible rows';
  else if (!name) note = 'Set your FAS name to copy only your pairs';
  else if (!rows.some((r) => r && r.mine)) note = "No roster pairs match '" + name + "' \u2014 check your FAS name";
  return { mineOk: !note, note, mineCount, visibleCount };
}

// Rows a Copy writes, in sheetOrder: 'mine' -> the user's pairs with units down (when the scope is
// available), anything else -> the visible rows (SCAC filter + hide-zero).
export function copyRows(model, scope, hideZero, scacs) {
  if (scope === 'mine' && copyScopeInfo(model, hideZero, scacs).mineOk) {
    return sheetOrder((model.rows || []).filter((r) => r && r.mine && _down(r) > 0));
  }
  return sheetOrder(visibleRows(model, hideZero, scacs));
}

// ── Freshness (design §3.13) ────────────────────────────────────────────────
export const FRESH_MAX_MS = 2 * 60 * 60 * 1000;

// "3h 9m" / "45m".
function _ageLabel(min) {
  const m = Math.max(0, Math.floor(Number(min) || 0));
  const h = Math.floor(m / 60);
  return h ? h + 'h ' + (m % 60) + 'm' : m + 'm';
}

// -> { ageMin, stale, label, syncedAt }: stale when the fleet sync time is missing/invalid or
// more than FRESH_MAX_MS before nowMs.
export function freshness(model, nowMs) {
  const syncedAt = (model && model.fleetSyncedAt) || null;
  const t = Date.parse(syncedAt);
  if (!syncedAt || !Number.isFinite(t)) return { ageMin: null, stale: true, label: '', syncedAt: null };
  const ms = Math.max(0, (Number(nowMs) || 0) - t);
  const ageMin = Math.floor(ms / 60000);
  return { ageMin, stale: ms > FRESH_MAX_MS, label: _ageLabel(ageMin), syncedAt };
}

// The stale-data alert ('' when fresh).
export function staleBannerHtml(fresh) {
  const f = fresh || {};
  if (!f.stale) return '';
  const text = f.label
    ? '\u26a0 Fleet data is ' + f.label + ' old (last sync ' + (_hhmm(f.syncedAt) || 'unknown') + '). Sync, then \u21ba Rebuild before you copy for SharePoint.'
    : '\u26a0 Fleet sync time unknown \u2014 sync before copying.';
  return '<div class="fdbr-banner fdbr-banner--stale" role="alert">' + esc(text) + '</div>';
}

// ── SCAC filter ─────────────────────────────────────────────────────────────
const _sortStr = (a, b) => a.localeCompare(b);

// Distinct non-empty SCACs of the model, sorted.
export function scacOptions(model) {
  const rows = model && Array.isArray(model.rows) ? model.rows : [];
  const set = new Set();
  for (const r of rows) {
    const s = r && r.scac != null ? String(r.scac) : '';
    if (s) set.add(s);
  }
  return [...set].sort(_sortStr);
}

// The selected SCACs (array or Set) that still exist in the model, deduped and sorted.
// SCACs no longer in the model are ignored; [] means "no SCAC filter" (show all).
export function normalizeScacs(selected, model) {
  if (!selected || typeof selected[Symbol.iterator] !== 'function' || typeof selected === 'string') return [];
  const opts = new Set(scacOptions(model));
  const out = new Set();
  for (const s of selected) if (typeof s === 'string' && opts.has(s)) out.add(s);
  return [...out].sort(_sortStr);
}

const _scacFiltered = (model, scacs) => {
  const rows = model && Array.isArray(model.rows) ? model.rows : [];
  const sel = normalizeScacs(scacs, model);
  if (!sel.length) return rows;
  const set = new Set(sel);
  return rows.filter((r) => r && set.has(String(r.scac)));
};

// Server-side search filter for the selected SCACs: { assetDomicileSites: sorted unique
// domiciles of the rows whose SCAC is selected }, or null when no SCAC is selected.
export function serverFilterFor(model, scacs) {
  const sel = normalizeScacs(scacs, model);
  if (!sel.length) return null;
  const set = new Set();
  for (const r of _scacFiltered(model, sel)) {
    const d = r && r.domicile != null ? String(r.domicile) : '';
    if (d && d !== '(BLANK)') set.add(d);
  }
  return { assetDomicileSites: [...set].sort(_sortStr) };
}

// Rows shown in the table: SCAC filter (empty = all), then hide-zero.
export function visibleRows(model, hideZero, scacs) {
  const rows = _scacFiltered(model, scacs);
  return hideZero ? rows.filter((r) => _down(r) > 0) : rows;
}

// AI progress counted over the visible keys only: { done, total }.
export function aiProgress({ sessionKeys, doneKeys, visibleKeys } = {}) {
  const vis = visibleKeys instanceof Set ? visibleKeys : new Set(visibleKeys || []);
  const fin = doneKeys instanceof Set ? doneKeys : new Set(doneKeys || []);
  let done = 0; let total = 0;
  for (const k of sessionKeys || []) {
    if (!vis.has(k)) continue;
    total++;
    if (fin.has(k)) done++;
  }
  return { done, total };
}

// The AI judgment cells of the model (main: AI_CELL_IDS); older models only had the two.
export function aiCellIds(model) {
  return model && Array.isArray(model.aiCellIds) && model.aiCellIds.length ? model.aiCellIds : ['fasActions', 'support'];
}

// Auto-draft eligibility: has down units, the user hasn't edited EVERY editable AI cell, and
// the draft is missing (none) or stale by 'units' / 'identity'. A draft stale by 'format' (an
// older draft version) or 'evidence' is queued on panel open only for the user's pairs
// (row.mine); "Draft all" / ↻ (includeEvidenceStale) queues it for every row.
// Only rows visible under { hideZero, scacs } are considered (no opts = every row).
export function eligibleForAutoDraft(model, { includeEvidenceStale = false, hideZero = false, scacs } = {}) {
  const rows = visibleRows(model, hideZero, scacs);
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
      if ((why === 'evidence' || why === 'format') && !includeEvidenceStale && !r.mine) continue;
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
export const ETC_NOTE = "ETC is best-effort: read from Relay, notes and timeline (ETC / ETR / expected completion + a date). 'Expected today' counts a down unit only when its ETC is today and nothing undercuts it (a newer 'no ETC' / at-risk / blocked note, parts not arrived, repair not started, an appointment date, a vendor ETR re-dated 5+ times, or an ETR stated over 7 days ago). Missed ETC needs an explicit miss, or a saved 'No ETC' note plus an extracted ETR that already passed. Everything else is NO ETC, so the three whole-number counts add up to the units down. Reasons per unit are in each row's drill-down. A bare parts/tow 'ETA' is not an ETC.";
export const OEM_NOTE = 'OEM = unit at an OEM/dealer (or Offsite Shop Repair), unless the dealer finished and the unit was released.';
export const ROW_NOTE = 'One row per Domicile \u00d7 SCAC in your fleet data; Domicile and SCAC uptime are whole-domicile / whole-SCAC figures.';
export const DOWN_NOTE = 'Down = lifecycle state Unavailable; Ordered units count in totals, not as down.';
export const AI_NOTE = 'Y/N and counts come from rules. AI writes only Details, FAS Actions and Support, and only when its sentence passes the fact check; otherwise auto text is shown.';
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
// With a SCAC filter: "… · 3 of 21 rows · 7 down · SCAC: TUZR · …" (counts over the filtered rows).
export function statusLine(model, opts = {}) {
  if (!model) return '';
  const all = Array.isArray(model.rows) ? model.rows : [];
  const sel = normalizeScacs(opts && opts.scacs, model);
  const rows = sel.length ? visibleRows(model, false, sel) : all;
  const parts = [];
  const built = _hhmm(model.builtAt);
  if (built) {
    const synced = _hhmm(model.fleetSyncedAt);
    // opts.nowMs given -> the fleet data age: "Built 13:05 from fleet sync 11:56 (3h 9m old)".
    const fresh = synced && opts && Number.isFinite(opts.nowMs) ? freshness(model, opts.nowMs) : null;
    parts.push('Built ' + built + (synced ? ' from fleet sync ' + synced : '') + (fresh && fresh.label ? ' (' + fresh.label + ' old)' : ''));
  }
  if (model.day) parts.push(model.day);
  if (sel.length) {
    parts.push(rows.length + ' of ' + all.length + (all.length === 1 ? ' row' : ' rows'));
    parts.push(rows.reduce((n, r) => n + _down(r), 0) + ' down');
    parts.push('SCAC: ' + sel.join(', '));
  } else {
    parts.push(rows.length + (rows.length === 1 ? ' row' : ' rows'));
    parts.push((Number(model.downCount) || 0) + ' down');
  }
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

const BUCKET_LABEL = { today: 'ETC Today', none: 'NO ETC', missed: 'Missed ETC' };
const BUCKET_REASON = {
  'etc-today': 'ETC today, nothing undercuts it',
  'explicit-miss': 'explicit miss reported',
  'no-etc-note-passed-etr': "saved note says No ETC and the extracted ETR passed",
  future: 'ETC is after today',
  'no-etc': 'no ETC stated',
  'newer-negation': 'a newer line says the ETC is gone, unsure or blocked',
  'parts-wait': 'parts not arrived',
  'not-started': 'repair not started',
  appointment: 'the date is an appointment, not completion',
  'rolling-etr': 'vendor ETR re-dated 5+ times',
  'stale-etr': 'ETR stated more than 7 days ago',
};
// 'YYYY-MM-DD' -> 'M/D' ('' otherwise).
function _md(ymd) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  return m ? (+m[1]) + '/' + (+m[2]) : '';
}
// Sheet-bucket, override and evidence lines of one unit (escaped by _line).
function _unitEtcLines(u) {
  const etc = u.etc || {};
  const out = [];
  if (etc.bucket) {
    const why = BUCKET_REASON[etc.bucketReason] || etc.bucketReason || '';
    out.push('Sheet: ' + (BUCKET_LABEL[etc.bucket] || etc.bucket) + (why ? ' \u2014 ' + why : '') + (etc.undercut ? ": '" + etc.undercut + "'" : ''));
  }
  if (etc.overrode && etc.bucket === 'missed') {
    out.push('Missed ETC ' + (_md(etc.date) || '?') + ' (' + (etc.source || 'extracted') + ") \u2014 overrode the saved note '" + (etc.overrode.userSnippet || '') + "'");
  } else if (etc.missDowngraded && etc.passedDate && etc.bucket !== 'missed') {
    out.push('ETR ' + _md(etc.passedDate) + ' passed, no miss reported');
  }
  const why = u.why && typeof u.why === 'object' ? u.why : {};
  for (const [b, text] of Object.entries(why)) if (text) out.push((BARRIER_LABEL[b] || b) + ': ' + text);
  if (_arr(u.systems).length) out.push('systems: ' + u.systems.join(', '));
  return out;
}
// AI unit notes (drill-down only, never copied): the draft's bullets naming this unit.
function _unitNoteLines(r, id) {
  const notes = r.unitNotes && typeof r.unitNotes === 'object' ? r.unitNotes : {};
  const flags = r.unitNoteFlags && typeof r.unitNoteFlags === 'object' ? r.unitNoteFlags : {};
  const head = '\u2022 ' + id + ':';
  const out = [];
  for (const [cell, text] of Object.entries(notes)) {
    for (const ln of String(text || '').split('\n')) {
      const t = ln.trim();
      if (t.startsWith(head)) out.push('AI note (' + cell + '): ' + t.slice(head.length).trim() + (flags[cell] === 'review' ? ' \u26a0 check' : ''));
    }
  }
  return out;
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
      + _unitEtcLines(u).map(_line).join('')
      + (tags.length ? '<br><span class="fdbr-muted">tags: ' + esc(tags.join(', ')) + '</span>' : '')
      + _unitNoteLines(r, u.id).map(_line).join('')
      + _aiUnitLines(r, u.id, units.length)
      + '</li>';
  }).join('');
  const rowLines = [];
  for (const w of _arr(r.missedWhy)) {
    if (w && w.unit) rowLines.push('Missed ETC: ' + w.unit + (w.date ? ' (ETC ' + _md(w.date) + ')' : '') + (w.why ? ': ' + w.why : ''));
  }
  // The Y/N cells are the rules' values (AI Y/N is never overlaid); a disagreement is the opposite.
  const dis = _arr(r.disagreements).map((b) => {
    const rules = String((r.base && r.base[b + 'YN']) || (r.cells && r.cells[b + 'YN']) || '').trim().toUpperCase().startsWith('Y') ? 'Y' : 'N';
    return (BARRIER_LABEL[b] || b) + ' AI=' + (rules === 'Y' ? 'N' : 'Y') + ' rules=' + rules;
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
  if (d === 'stale') return '<span class="fdbr-badge fdbr-badge--warn">\u26a0 AI draft out of date \u2014 showing auto text</span>';
  if (d === 'ok') return '<span class="fdbr-badge fdbr-badge--ok">\u2713 AI draft</span>';
  return '';
}

// ── Table ───────────────────────────────────────────────────────────────────
// Text markers (never color-only): "edited", "AI" on AI-written cells, "⚠ check" on
// cells the fact-check flagged for review (not shown once the user edited the cell).
// Missed ETC: "↺ overrode the saved note" when an extracted miss overrode a saved "No ETC" note
// (the title names each unit, the note and the evidence). NO ETC: "⚠ counts ≠ N down" when the
// three ETC cells don't add up to the pair's units down (a user edit can break the sum, I1).
// Markers are never cell text, so the copied cell stays a bare number.
const _count = (v) => { const m = /^\s*(\d+)/.exec(String(v == null ? '' : v)); return m ? Number(m[1]) : NaN; };
export function markHtml(row, col) {
  const src = (row && row.source) || {};
  const flags = (row && row.flags) || {};
  if (src[col] === 'edit') return '<span class="fdbr-mark">edited</span>';
  let out = src[col] === 'ai' ? '<span class="fdbr-mark">AI</span>' : '';
  if (flags[col] === 'review') out += '<span class="fdbr-mark fdbr-mark--warn">\u26a0 check</span>';
  if (col === 'missedEtc' && _arr(row && row.userEtcOverrides).length) {
    const title = row.userEtcOverrides.filter(Boolean).map((o) => (o.unit || '') + ": saved note '" + (o.userSnippet || '')
      + "' \u2192 Relay/offsite: '" + (o.extractedSnippet || '') + "'").join('\n');
    out += '<span class="fdbr-mark fdbr-mark--warn" title="' + esc(title) + '">\u21ba overrode the saved note</span>';
  }
  if (col === 'noEtc' && row && row.pair) {
    const c = (row.cells) || {};
    const sum = _count(c.etcToday) + _count(c.noEtc) + _count(c.missedEtc);
    if (sum !== _down(row)) out += '<span class="fdbr-mark fdbr-mark--warn">\u26a0 counts \u2260 ' + _down(row) + ' down</span>';
  }
  return out;
}
// Inner HTML of a non-editable AI cell (value in the sheet format + markers, escaped);
// refreshRow patches it.
export function cellInnerHtml(row, col, value) {
  const v = value !== undefined ? value : _cellOf(row, col);
  return esc(sheetValue(col, v, row && row.source ? row.source[col] : undefined)) + markHtml(row, col);
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
  const rows = sheetOrder(visibleRows(model, !!opts.hideZero, opts.scacs));
  if (!rows.length) {
    const scacOn = normalizeScacs(opts.scacs, model).length > 0;
    return '<div class="dc-empty">' + (model && model.rows && model.rows.length
      ? (scacOn
        ? 'No rows with down units for the selected SCACs \u2014 untick "Hide rows with 0 down" or pick other SCACs.'
        : 'Every row has 0 down \u2014 untick "Hide rows with 0 down" to see them.')
      : 'No rows yet \u2014 click \u21ba Build from fleet data.') + '</div>';
  }
  const head = '<thead><tr>' + cols.map((c) => '<th scope="col">' + esc(c.header) + '</th>').join('')
    + '<th scope="col">Units / Row</th></tr></thead>';
  const body = rows.map((r) => {
    const label = (r.domicile || '') + '/' + (r.scac || '');
    const tds = cols.map((c) => {
      const v = get(r, c.id);
      if (!c.editable) {
        if (!aiIds.has(c.id)) return '<td>' + esc(sheetValue(c.id, v, r.source && r.source[c.id])) + '</td>';
        return '<td data-key="' + esc(r.key) + '" data-col="' + esc(c.id) + '">' + cellInnerHtml(r, c.id, v) + '</td>';
      }
      // Screen-only hint under an empty FAS Name: the site/SCAC fallback owner (never copied).
      const hint = c.id === 'fasName' && !String(v == null ? '' : v).trim() && r.rosterHint
        ? '<span class="fdbr-muted">site match: ' + esc(r.rosterHint) + '</span>' : '';
      return '<td class="fdbr-td">'
        + '<textarea class="dc-input fdbr-cell" rows="2" data-key="' + esc(r.key) + '" data-col="' + esc(c.id) + '"'
        + ' aria-label="' + esc(c.header + ' \u2014 ' + label) + '">' + esc(v) + '</textarea>'
        + '<span class="fdbr-marks" data-mark-key="' + esc(r.key) + '" data-mark-col="' + esc(c.id) + '">' + markHtml(r, c.id) + '</span>' + hint + '</td>';
    }).join('');
    const btn = (action, text, aria) => '<button type="button" class="detail-panel__btn detail-panel__btn--secondary fdbr-mini"'
      + ' data-fdbr-action="' + action + '" data-key="' + esc(r.key) + '" aria-label="' + esc(aria + ' ' + label) + '">' + text + '</button>';
    const ui = '<td class="fdbr-ui">' + unitsDrillHtml(r)
      + '<div class="fdbr-row-btns">'
      + (aiDraft && _down(r) > 0 ? btn('redraft', '\u2728 Redraft', 'Redraft AI cells for') : '')
      + btn('reset-row', '\u21ba Reset row', 'Reset edits for')
      + btn('copy-row', '\ud83d\udccb Copy row', 'Copy row (1P Vendor Barrier Y/N onward) for')
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

// ── First-class DBR view (auto-build when stale) ────────────────────────────
// True when the fleet sync timestamp is newer than the one the cached build was made
// from (model.fleetSyncedAt) — the same comparison the live "Fleet data updated" banner makes.
export function isFleetNewer(modelFleetSyncedAt, fleetSyncedAt) {
  if (!fleetSyncedAt) return false;
  if (!modelFleetSyncedAt) return true;
  const a = Date.parse(modelFleetSyncedAt);
  const b = Date.parse(fleetSyncedAt);
  if (Number.isFinite(a) && Number.isFinite(b)) return b > a;
  return String(modelFleetSyncedAt) !== String(fleetSyncedAt);
}

// Local HH:MM, or '' when the timestamp is missing/invalid.
export function fmtClock(iso) { return _hhmm(iso); }

export function refreshingBannerHtml() {
  return '<div class="fdbr-banner fdbr-banner--loading" role="status" aria-live="polite">\u23f3 Fleet data updated \u2014 Building DBR\u2026</div>';
}

export function fallbackBannerHtml(builtAt) {
  const t = fmtClock(builtAt);
  return '<div class="fdbr-banner fdbr-banner--fallback" role="alert">Couldn\'t refresh \u2014 showing data from '
    + (t ? esc(t) : 'the last build') + ' \u00b7 '
    + '<button type="button" class="detail-panel__btn detail-panel__btn--secondary fdbr-mini" data-fdbr-action="build">\u21ba Rebuild</button></div>';
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
    #dbr-overlay .fdbr-banner--stale { border-color: #f85149; font-weight: 600; }
    #dbr-overlay .fdbr-status { font-size: 11px; color: var(--mut, #888); padding: 0 18px 6px; min-height: 14px; }
    #dbr-overlay .fdbr-scac { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; border: 1px solid var(--border, #444); border-radius: 4px; padding: 2px 8px; margin: 0; font-size: 11px; }
    #dbr-overlay .fdbr-scac legend { padding: 0 4px; font-size: 10px; color: var(--mut, #888); }
    #dbr-overlay .fdbr-scac label { display: flex; align-items: center; gap: 3px; }
`;

// The same rules scoped to the first-class view container (#view-dbr), plus view-only rules.
export const VIEW_CSS = PANEL_CSS.replace(/#dbr-overlay/g, '#view-dbr') + `
    #view-dbr .fdbr-view { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden; }
    #view-dbr .fdbr-banner--fallback { border-color: #f85149; }
    #view-dbr .fdbr-banner--loading { border-color: #58a6ff; }
`;

// Multi-select SCAC filter: one checkbox per SCAC (no selection = all rows).
function _scacHtml(options, selected) {
  const opts = Array.isArray(options) ? options : [];
  if (!opts.length) return '';
  const sel = new Set(Array.isArray(selected) ? selected : []);
  return '<fieldset class="fdbr-scac"><legend>SCAC</legend>'
    + opts.map((s) => '<label><input type="checkbox" data-fdbr-field="scac" data-scac="' + esc(s) + '" value="' + esc(s) + '"'
      + (sel.has(s) ? ' checked' : '') + '> ' + esc(s) + '</label>').join('')
    + (sel.size ? '<button type="button" class="detail-panel__btn detail-panel__btn--secondary fdbr-mini" data-fdbr-action="scac-all">All SCACs</button>' : '')
    + '</fieldset>';
}

// Copy-scope select: "Copy: My pairs with units down (N) | All visible rows (M)". The 'mine'
// option is disabled (with the reason) when copyScopeInfo says it is unavailable.
function _copyScopeHtml(scope, info) {
  if (!info) return '';
  const mine = info.mineOk && scope !== 'visible';
  return '<label style="font-size:11px;display:flex;align-items:center;gap:4px;">Copy:'
    + '<select class="dc-input" style="width:auto;display:inline-block;" data-fdbr-field="copyScope" aria-label="Rows to copy">'
    + '<option value="mine"' + (mine ? ' selected' : '') + (info.mineOk ? '' : ' disabled') + '>My pairs with units down (' + esc(info.mineCount) + ')</option>'
    + '<option value="visible"' + (mine ? '' : ' selected') + '>All visible rows (' + esc(info.visibleCount) + ')</option>'
    + '</select></label>'
    + (info.note ? '<span class="fdbr-muted" role="note">' + esc(info.note) + '</span>' : '');
}

// state: { status:'ready'|'loading'|'off'|'unavailable'|'error', aiDraft, drafting,
//          fasName, hideZero, message, conflicts:[{id}], scacOptions:[], scacs:[],
//          copyScope:'mine'|'visible', copyInfo: copyScopeInfo(...) | undefined }
export function panelHtml(state = {}) {
  const s = state || {};
  const isView = s.mode === 'view';
  const header = '<style>' + (isView ? VIEW_CSS : PANEL_CSS) + '</style>'
    + '<div class="wr-modal__header"><div class="wr-modal__title-row">'
    + '<span class="wr-modal__title" id="fdbr-title">' + esc(TITLE) + '</span></div>'
    + (isView ? '' : '<button type="button" class="wr-modal__close" data-fdbr-action="close" aria-label="Close">\u00d7</button>') + '</div>';
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
    + btn('build', isView ? '\u21ba Rebuild' : '\u21ba Build from fleet data')
    + ai
    + _copyScopeHtml(s.copyScope, s.copyInfo)
    + btn('copy', '\ud83d\udccb Copy rows', ' detail-panel__btn--secondary')
    + btn('copy-header', '\ud83d\udccb Copy with header', ' detail-panel__btn--secondary')
    + btn('copy-fill', '\ud83d\udccb Copy fill columns', ' detail-panel__btn--secondary')
    + '<label style="font-size:11px;display:flex;align-items:center;gap:4px;">'
    + '<input type="checkbox" data-fdbr-field="hideZero"' + (s.hideZero ? ' checked' : '') + '> Hide rows with 0 down</label>'
    + _scacHtml(s.scacOptions, s.scacs)
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
