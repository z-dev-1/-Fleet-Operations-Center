// renderer/src/js/longdwell-sp-logic.js - pure view logic for the Long Dwell
// weekly SharePoint sheet panel ("Preview, then write").
//
// No DOM, no bridge, no logging: this module only turns state into HTML
// strings and reduces UI actions. Every value that reaches HTML goes through
// esc(). Failures are shown as friendly text keyed by code (never logged).

export const COMMIT_KEY = 'longDwell.sharepointWriteCommit';
export const DRY_RUN_TEXT = 'Write is turned off (dry run). Set ' + COMMIT_KEY + ' to enable.';
export const PANE_TIMEOUT_MS = 15000;
export const CONFIRM_REVERT_MS = 6000;

export function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// https, no userinfo, host *.sharepoint.com (same rule parseSheetLink applied
// when the link was stored). Anything else is never used as a webview src.
export function isAllowedSheetUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  return /^[a-z0-9-]+\.sharepoint\.com$/i.test(u.hostname);
}

const FRIENDLY = {
  'off': 'This feature is turned off.',
  'auth-required': 'Sign in: click Open sheet, sign in, then try again.',
  'write-disabled': 'Write is turned off. Set ' + COMMIT_KEY + ' to enable.',
  'changed-since-preview': 'changed since preview',
  'no-link': "Paste this week's sheet link first.",
  'bad-link': "That doesn't look like a SharePoint link.",
  'bad-host': 'Only SharePoint (*.sharepoint.com) links are supported.',
  'link-too-long': 'That link is too long.',
  'unsupported-link': "This kind of SharePoint link isn't supported. Copy the link from the file's Share or address bar.",
  'unsupported-format': 'Only .xlsx workbooks are supported.',
  'rate-limited': 'Please wait a few seconds before previewing again.',
  'too-many-units': 'Too many units in the current view. Filter the view and try again.',
  'needs-tab-choice': 'Several tabs look like the tracker. Pick one.',
  'header-mismatch': "The sheet's headers don't match the tracker columns.",
  'header-duplicate': 'A tracker header appears more than once in the sheet.',
  'unknown-tab': 'That tab is not in the workbook.',
  'not-found': "The file wasn't found. Check this week's link.",
  'unresolvable-link': "The link couldn't be opened as a file.",
  'too-large': 'The workbook is too large.',
  'unsupported-workbook': "This workbook type isn't supported.",
  'unsupported-xml': "The workbook's format isn't supported.",
  'guard-unavailable': "Couldn't read the file's version info. Nothing was written. Try again.",
  'timeout': 'SharePoint took too long. Try again.',
  'network': 'Network error. Try again.',
  'throttled': 'SharePoint is busy. Try again in a moment.',
  'internal': 'Something went wrong. Nothing was written.',
  'busy': 'Another write is in progress. Try again shortly.',
  'preview-expired': 'This preview expired. Preview again.',
  'week-rolled': 'A new week started. Paste the new link and preview again.',
  'link-changed': 'The link changed. Preview again.',
  'confirm-required': 'Confirmation is required.',
  'too-many-cells': 'Too many cells selected.',
  'invalid-cell': 'Some selected cells are no longer valid. Preview again.',
  'invalid-text': 'A cell text is empty, too long, or not in the allowed list.',
  'locked': 'The file is locked (open for editing). Close it and try again.',
  'precondition': 'changed since preview',
  'upload-unknown': "Upload result unknown; the cell didn't change. Preview again.",
  'verify-mismatch': 'Written, but the sheet shows a different value.',
  'verification-pending': 'Written; SharePoint has not shown it yet.',
  'not-approved': 'Not ticked',
  'no-change': 'Already matches',
  'layout-changed': 'The sheet layout changed since preview.',
  'self-check': 'Safety check failed. Nothing was written.',
  'formula': 'Cell holds a formula',
  'merged': 'Cell is merged',
  'protected': 'Cell is protected',
  'empty-source': 'No app value',
  'invalid-value': 'App value not in the allowed list',
  'bad-pane-url': 'Only SharePoint links can open in the side panel.',
};

export function friendlyText(code) {
  if (!code) return '';
  if (Object.prototype.hasOwnProperty.call(FRIENDLY, code)) return FRIENDLY[code];
  if (/^http-\d+$/.test(code)) return 'SharePoint returned an error (' + code.slice(5) + ').';
  return 'Something went wrong (' + code + ').';
}

const STATE_LABEL = { 'will-write': 'Will write', 'conflict': 'Conflict', 'no-change': 'No change', 'blocked': 'Blocked' };
const WARN_CHIP = {
  'needs-confirm': 'needs confirm',
  'vendor-match': 'matched by vendor, confirm row',
  'validation-mismatch': "not in the sheet's dropdown",
  'clipped': 'clipped to 4000 chars',
};

const _norm = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim();

// ── State ──────────────────────────────────────────────────────────────────
export function initialState(status) {
  return {
    status: status || null, preview: null, ticks: {}, edits: {}, busy: false, error: null,
    report: null, confirmArmed: false, promptShown: false, prompting: false,
    linkEditing: false, tabChoice: null, live: '',
  };
}

function _cell(state, id) {
  const p = state.preview;
  return p && Array.isArray(p.cells) ? p.cells.find((c) => c.id === id) || null : null;
}

export function cellText(state, cell) {
  return Object.prototype.hasOwnProperty.call(state.edits, cell.id) ? state.edits[cell.id] : String(cell.next == null ? '' : cell.next);
}

// State of a selectable cell re-derived from the (possibly edited) text,
// always against the previewed current value.
export function effectiveState(state, cell) {
  if (!cell.selectable) return cell.state;
  const t = _norm(cellText(state, cell));
  const cur = _norm(cell.current);
  if (t === cur) return 'no-change';
  return cur === '' ? 'will-write' : 'conflict';
}

export function reduce(state, action) {
  const s = { ...state };
  const a = action || {};
  switch (a.type) {
    case 'status': {
      const prevWeek = state.status && state.status.weekKey;
      s.status = a.status || null;
      if (prevWeek && s.status && s.status.weekKey !== prevWeek) {
        Object.assign(s, { preview: null, ticks: {}, edits: {}, report: null, tabChoice: null, confirmArmed: false, prompting: false, promptShown: false });
      }
      return s;
    }
    case 'preview-loaded': {
      const p = a.preview;
      const ticks = {};
      for (const c of (p && p.cells) || []) if (c.selectable) ticks[c.id] = c.defaultChecked === true;
      return { ...s, preview: p, ticks, edits: {}, report: null, confirmArmed: false, promptShown: false, prompting: false, tabChoice: null, error: null, busy: false };
    }
    case 'tick': {
      const c = _cell(state, a.cellId);
      if (!c || !c.selectable) return state;
      s.ticks = { ...state.ticks, [c.id]: a.checked === true };
      s.confirmArmed = false;
      return s;
    }
    case 'edit': {
      const c = _cell(state, a.cellId);
      if (!c || !c.selectable) return state;
      const edits = { ...state.edits };
      const text = String(a.text == null ? '' : a.text);
      if (text === String(c.next == null ? '' : c.next)) delete edits[c.id]; else edits[c.id] = text;
      s.edits = edits;
      s.confirmArmed = false;
      return s;
    }
    case 'reset': {
      const edits = { ...state.edits };
      delete edits[a.cellId];
      s.edits = edits;
      return s;
    }
    case 'select-all': {
      const ticks = { ...state.ticks };
      for (const c of (state.preview && state.preview.cells) || []) {
        if (c.selectable && c.state === 'will-write' && effectiveState(state, c) === 'will-write') ticks[c.id] = true;
      }
      return { ...s, ticks, confirmArmed: false };
    }
    case 'clear': {
      const ticks = {};
      for (const k of Object.keys(state.ticks)) ticks[k] = false;
      return { ...s, ticks, confirmArmed: false };
    }
    case 'busy': return { ...s, busy: a.busy === true, live: a.busy ? 'Working...' : s.live };
    case 'error': return { ...s, busy: false, error: a.code || null, live: a.code ? friendlyText(a.code) : '' };
    case 'tab-choice': return { ...s, busy: false, preview: null, tabChoice: { code: a.code, tabs: a.tabs || [], missing: a.missing || [] }, error: null };
    case 'report': {
      const r = a.report;
      const keep = !!(r && r.previewKept);
      return { ...s, busy: false, report: r, confirmArmed: false, prompting: false, preview: keep ? s.preview : null, live: 'Write finished: ' + (r && r.status ? r.status : 'done') };
    }
    case 'back-to-preview': return { ...s, report: null };
    case 'close-report': return { ...s, report: null, preview: null };
    case 'arm-confirm': return { ...s, confirmArmed: true };
    case 'disarm-confirm': return { ...s, confirmArmed: false };
    case 'prompt-show': return { ...s, prompting: true, promptShown: true };
    case 'prompt-hide': return { ...s, prompting: false };
    case 'link-edit': return { ...s, linkEditing: a.on === true, error: null };
    case 'pane': return { ...s, paneOpen: a.open === true };
    case 'discard': return { ...s, preview: null, ticks: {}, edits: {}, report: null, confirmArmed: false };
    default: return state;
  }
}

// ── Write button / payload ─────────────────────────────────────────────────
export function tickedCells(state) {
  const p = state.preview;
  if (!p || !Array.isArray(p.cells)) return [];
  return p.cells.filter((c) => c.selectable && state.ticks[c.id] === true);
}

export function writeInfo(state) {
  const p = state.preview;
  const ticked = tickedCells(state);
  const overwrites = ticked.filter((c) => effectiveState(state, c) === 'conflict').length;
  const empty = ticked.some((c) => _norm(cellText(state, c)) === '');
  let reason = '';
  if (!p) reason = 'Preview first.';
  else if (p.commit !== true) reason = DRY_RUN_TEXT;
  else if (state.busy) reason = 'Working...';
  else if (!ticked.length) reason = 'Tick at least one cell to write.';
  else if (empty) reason = 'A ticked cell is empty.';
  const n = ticked.length;
  let label = 'Write ' + n + ' cell' + (n === 1 ? '' : 's') + ' to sheet';
  if (overwrites) label += ' (' + overwrites + ' overwrite existing text)';
  if (state.confirmArmed && overwrites) label = 'Confirm: overwrite ' + overwrites + ' cell' + (overwrites === 1 ? '' : 's');
  return { count: n, overwrites, disabled: !!reason, reason, label };
}

// Exactly { previewId, cells:[{cellId, text}], confirm:true } and nothing else.
export function buildWritePayload(state) {
  return {
    previewId: state.preview ? state.preview.previewId : null,
    cells: tickedCells(state).map((c) => ({ cellId: c.id, text: cellText(state, c) })),
    confirm: true,
  };
}

// ── HTML ───────────────────────────────────────────────────────────────────
const _btn = (action, label, extra = '') => '<button type="button" class="ec-preset-btn" data-ldsp-action="' + action + '"' + extra + '>' + esc(label) + '</button>';

function _hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

export function renderControlHtml(state) {
  const st = state.status || {};
  const link = st.link || null;
  const week = st.weekLabel || st.weekKey || '';
  let h = '<div class="ldsp-control" role="group" aria-label="This week\'s sheet">';
  h += '<span class="ldsp-control__title">\uD83D\uDCCE This week\'s sheet</span> <span class="ldsp-control__week">' + esc(week) + '</span> ';
  if (!link || state.linkEditing) {
    h += '<span class="ldsp-control__hint">paste this week\'s sheet link</span> ';
    h += '<input type="url" class="settings__select ldsp-control__input" data-ldsp-input="link" aria-label="This week\'s sheet link" placeholder="https://...sharepoint.com/..."> ';
    h += _btn('save-link', 'Save');
    if (link) h += ' ' + _btn('cancel-link', 'Cancel');
  } else {
    const name = link.fileName || _hostOf(link.url) || 'sheet';
    h += '<span class="ldsp-control__file">' + esc(name) + '</span> ';
    h += (state.paneOpen ? _btn('goto-pane', '\u2193 Go to sheet') : _btn('open-pane', 'Open sheet')) + ' ' + _btn('pop-out', 'Pop out') + ' ' + _btn('preview', 'Preview', state.busy ? ' disabled' : '') + ' ' + _btn('change-link', 'Change link');
  }
  if (state.error) h += ' <span class="ldsp-error" role="alert">' + esc(friendlyText(state.error)) + '</span>';
  h += '<div class="ldsp-live" aria-live="polite">' + esc(state.live || '') + '</div>';
  h += '</div>';
  return h;
}

export function renderPaneHtml(link) {
  const name = (link && (link.fileName || _hostOf(link.url))) || 'Sheet';
  return '<div class="ldsp-pane__head"><span class="ldsp-pane__title">' + esc(name) + '</span> '
    + _btn('pane-popout', 'Pop out') + ' ' + _btn('pane-reload', 'Reload') + ' ' + _btn('pane-close', 'Close')
    + '</div><div class="ldsp-pane__body"></div>';
}

export function renderPaneNoticeHtml() {
  return '<div class="ldsp-pane__head">' + _btn('pane-close', 'Close') + '</div>'
    + '<p class="ldsp-notice">Couldn\'t load the sheet here. Opening it in a window instead.</p>';
}

function _valueHtml(v) {
  const s = String(v == null ? '' : v);
  if (s.length > 80 || s.indexOf('\n') >= 0) {
    return '<details class="ldsp-diff"><summary>' + esc(s.split('\n')[0].slice(0, 60)) + '\u2026</summary><pre>' + esc(s) + '</pre></details>';
  }
  return esc(s);
}

function _chip(text, cls = '') { return '<span class="ldsp-chip' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</span>'; }

function _editorHtml(state, c) {
  const text = cellText(state, c);
  const label = 'New ' + c.header + ' for unit ' + c.equipmentId;
  const common = ' data-ldsp-field="edit" data-cell-id="' + esc(c.id) + '" aria-label="' + esc(label) + '"';
  if (c.editor === 'select') {
    const opts = Array.isArray(c.options) ? c.options.slice() : [];
    if (text && !opts.includes(text)) opts.unshift(text);
    return '<select class="settings__select"' + common + '>' + opts.map((o) => '<option value="' + esc(o) + '"' + (o === text ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
  }
  return '<textarea class="ldsp-textarea" rows="2"' + common + '>' + esc(text) + '</textarea>';
}

function _cellRowHtml(state, c) {
  const eff = effectiveState(state, c);
  const edited = Object.prototype.hasOwnProperty.call(state.edits, c.id);
  let tick = '';
  if (c.selectable) {
    tick = '<input type="checkbox" data-ldsp-field="tick" data-cell-id="' + esc(c.id) + '"' + (state.ticks[c.id] === true ? ' checked' : '')
      + ' aria-label="' + esc('Write ' + c.header + ' for unit ' + c.equipmentId) + '">';
  }
  let next = c.selectable ? _editorHtml(state, c) : _valueHtml(c.next);
  if (edited) next += ' ' + _chip('edited', 'ldsp-chip--edited') + ' ' + _btn('reset-cell', 'reset', ' data-cell-id="' + esc(c.id) + '"');
  const chips = (c.warnings || []).filter((w) => WARN_CHIP[w]).map((w) => _chip(WARN_CHIP[w], 'ldsp-chip--warn')).join(' ');
  let label = STATE_LABEL[eff] || eff;
  if (eff === 'blocked' && c.reason) label += ': ' + friendlyText(c.reason);
  const wo = c.woKey && c.woKey !== c.equipmentId ? c.woKey : '';
  return '<tr data-cell-id="' + esc(c.id) + '" class="ldsp-row--' + esc(eff) + '">'
    + '<td>' + tick + '</td><td>' + esc(c.equipmentId) + '</td><td>' + esc(wo) + '</td><td>' + esc(c.sheetRow) + '</td>'
    + '<td>' + esc(c.column + ' ' + c.header) + '</td><td>' + _valueHtml(c.current) + '</td><td>' + next + '</td>'
    + '<td><span class="ldsp-state">' + esc(label) + '</span>' + (chips ? ' ' + chips : '') + '</td></tr>';
}

export function renderFooterHtml(state) {
  const p = state.preview;
  if (!p) return '';
  const w = writeInfo(state);
  let h = '';
  if (state.prompting) {
    h += '<div class="ldsp-prompt" role="alertdialog" aria-label="Close the sheet pane first?">Close the sheet pane first? Co-authoring can lock the file. '
      + _btn('prompt-close-write', 'Close and write') + ' ' + _btn('prompt-write-anyway', 'Write anyway') + ' ' + _btn('prompt-cancel', 'Cancel') + '</div>';
  }
  h += '<button type="button" class="ec-preset-btn ldsp-write" data-ldsp-action="write"' + (w.disabled ? ' disabled aria-disabled="true"' : '') + '>' + esc(w.label) + '</button>';
  if (w.reason) h += ' <span class="ldsp-write__reason">' + esc(w.reason) + '</span>';
  h += '<p class="ldsp-footnote">Another person saving in the same instant could be overwritten; SharePoint version history can restore it.</p>';
  return h;
}

function _unitList(title, items, fmt) {
  if (!items.length) return '';
  return '<details class="ldsp-list"><summary>' + esc(title + ' (' + items.length + ')') + '</summary><ul>'
    + items.map((u) => '<li>' + fmt(u) + '</li>').join('') + '</ul></details>';
}

export function renderPreviewHtml(state) {
  const p = state.preview;
  if (!p) return '';
  const f = p.file || {};
  const k = p.counts || {};
  const cells = Array.isArray(p.cells) ? p.cells : [];
  const units = Array.isArray(p.units) ? p.units : [];
  let h = '<section class="ldsp-preview" aria-label="Sheet preview">';
  h += '<div class="ldsp-preview__head">' + esc(f.name || '') + ' \u00b7 tab ' + esc(f.tab || '') + ' \u00b7 header row ' + esc(f.headerRow || '')
    + ' \u00b7 ' + esc((k.unitsInView != null ? k.unitsInView : units.length) + ' units from the current view') + ' ' + _chip('Nothing written yet');
  if (p.expiresAt) {
    const d = new Date(p.expiresAt);
    if (!isNaN(d.getTime())) h += ' <span class="ldsp-expiry">expires ' + esc(d.toTimeString().slice(0, 5)) + '</span>';
  }
  if (p.commit !== true) h += '<p class="ldsp-notice ldsp-notice--dry">' + esc(DRY_RUN_TEXT) + '</p>';
  h += '</div>';
  // mapping
  h += '<table class="an-table ldsp-mapping"><caption>Computed field -&gt; Sheet column</caption><thead><tr><th scope="col">Computed field</th><th scope="col">Sheet column</th></tr></thead><tbody>';
  for (const m of p.mapping || []) h += '<tr><td>' + esc(m.fieldLabel || m.field) + '</td><td>' + esc((m.column || '?') + ' ' + m.header) + '</td></tr>';
  h += '</tbody></table>';
  const nw = (p.untouched || []).map((u) => (u.column === 'A-M' ? 'A to M (read-only)' : ((u.column ? u.column + ' ' : '') + u.header)));
  h += '<p class="ldsp-untouched">Not written: ' + esc(nw.join(', ')) + '</p>';
  // chips
  const needsConfirm = cells.filter((c) => (c.warnings || []).includes('needs-confirm')).length;
  const byVendor = cells.filter((c) => (c.warnings || []).includes('vendor-match')).length;
  h += '<div class="ldsp-chips">'
    + _chip('will write ' + (k.willWrite || 0)) + ' ' + _chip('no change ' + (k.noChange || 0)) + ' ' + _chip('conflicts ' + (k.conflict || 0))
    + ' ' + _chip('needs confirm ' + needsConfirm) + ' ' + _chip('matched by vendor ' + byVendor) + ' ' + _chip('ambiguous ' + (k.ambiguous || 0))
    + ' ' + _chip('not in sheet ' + (k.notInSheet || 0)) + ' ' + _chip('blocked ' + (k.blocked || 0)) + '</div>';
  h += '<div class="ldsp-actions">' + _btn('select-all', 'Select all will-write') + ' ' + _btn('clear-ticks', 'Clear selection') + '</div>';
  // table
  h += '<table class="an-table ldsp-table"><thead><tr>'
    + ['Write', 'Unit', 'WO', 'Sheet row', 'Column', 'Current in sheet', 'New from app (editable)', 'State'].map((t) => '<th scope="col">' + esc(t) + '</th>').join('')
    + '</tr></thead><tbody>';
  for (const c of cells) h += _cellRowHtml(state, c);
  h += '</tbody></table>';
  if (p.truncated) h += '<p class="ldsp-notice">The sheet has more rows than the preview reads; only the first part was checked.</p>';
  h += _unitList('Not in sheet', units.filter((u) => u.match === 'not-in-sheet'), (u) => esc(u.equipmentId));
  h += _unitList('Ambiguous', units.filter((u) => u.match === 'ambiguous'), (u) => esc(u.equipmentId + ' (rows ' + (u.candidates || []).join(', ') + ')'));
  h += _unitList('Extra work orders', units.filter((u) => u.match === 'extra-wo'), (u) => esc(u.equipmentId + ' ' + (u.woKey || '')));
  h += '<div class="ldsp-footer" data-ldsp-footer="1">' + renderFooterHtml(state) + '</div>';
  h += '</section>';
  return h;
}

export function renderTabChoiceHtml(state) {
  const t = state.tabChoice;
  if (!t) return '';
  let h = '<fieldset class="ldsp-tabs"><legend>' + esc(friendlyText(t.code)) + '</legend>';
  (t.tabs || []).forEach((tab, i) => {
    const miss = tab.qualifies ? '' : ' <span class="ldsp-chip ldsp-chip--warn">does not match fully' + (tab.missing && tab.missing.length ? ': ' + esc(tab.missing.join(', ')) : '') + '</span>';
    h += '<label><input type="radio" name="ldsp-tab" data-ldsp-field="tab" value="' + esc(tab.name) + '"' + (i === 0 ? ' checked' : '') + '> '
      + esc(tab.name) + ' (header row ' + esc(tab.headerRow || '-') + ', score ' + esc(tab.score || 0) + ')' + miss + '</label><br>';
  });
  if (t.missing && t.missing.length) h += '<p>Missing: ' + esc(t.missing.join(', ')) + '</p>';
  h += _btn('use-tab', 'Use this tab') + '</fieldset>';
  return h;
}

export function renderReportHtml(report) {
  if (!report) return '';
  const k = report.counts || {};
  let h = '<section class="ldsp-report" aria-label="Write report"><div class="ldsp-chips">'
    + _chip('written ' + (k.written || 0)) + ' ' + _chip('skipped ' + (k.skipped || 0)) + ' ' + _chip('conflict ' + (k.conflict || 0)) + ' ' + _chip('failed ' + (k.failed || 0))
    + ' <span class="ldsp-state">' + esc(report.status || '') + '</span></div>';
  for (const e of report.errors || []) h += '<p class="ldsp-error">' + esc(friendlyText(e && e.code)) + '</p>';
  h += '<table class="an-table ldsp-table"><thead><tr>' + ['Unit', 'Column', 'Status', 'Reason', 'Notes'].map((t) => '<th scope="col">' + esc(t) + '</th>').join('') + '</tr></thead><tbody>';
  for (const c of report.cells || []) {
    const marks = [];
    if (c.edited) marks.push(_chip('edited', 'ldsp-chip--edited'));
    if (c.overwrote) marks.push(_chip('overwrote', 'ldsp-chip--warn'));
    if (c.verified === false) marks.push(_chip('not verified yet'));
    h += '<tr data-cell-id="' + esc(c.id) + '" class="ldsp-row--' + esc(c.status) + '"><td>' + esc(c.equipmentId) + '</td><td>' + esc((c.column || '') + ' ' + (c.header || ''))
      + '</td><td><span class="ldsp-state">' + esc(c.status) + '</span></td><td>' + esc(c.reason ? friendlyText(c.reason) : '') + '</td><td>' + marks.join(' ') + '</td></tr>';
  }
  h += '</tbody></table>';
  if (report.previewKept) h += _btn('back-to-preview', 'Back to preview') + ' ';
  h += _btn('preview', 'Preview again') + ' ' + _btn('close-report', 'Close') + '</section>';
  return h;
}

export function renderBodyHtml(state) {
  if (state.report) return renderReportHtml(state.report);
  if (state.tabChoice) return renderTabChoiceHtml(state);
  return renderPreviewHtml(state);
}
