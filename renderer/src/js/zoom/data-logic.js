/**
 * zoom/data-logic.js -- pure render-to-HTML helpers for the Zoom hub (no DOM, no window).
 *
 * Every portal string goes through esc(). Every {ok:false, code} maps through codeMessage(code)
 * to one fixed sentence.
 */

/** esc(s) -- escape & < > " ' for HTML text and attribute values. */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CODE_MESSAGES = {
  DISABLED: 'This Zoom feature is turned off.',
  WRITE_DISABLED: 'Zoom portal actions are turned off.',
  FORBIDDEN: 'This request was blocked.',
  INVALID_INPUT: 'Fleet sent an invalid request.',
  SIGN_IN_REQUIRED: 'Sign in to Zoom to continue.',
  SSO_WALL: 'A sign-in or security check blocked Zoom. Try Connect.',
  SIGN_IN_TIMEOUT: 'Zoom sign-in timed out.',
  CANCELLED: 'Cancelled.',
  NETWORK: 'Zoom could not be reached. Check your connection.',
  TIMEOUT: 'Zoom took too long to respond.',
  THROTTLED: 'Zoom is busy. Try again in a minute.',
  HTTP_ERROR: 'Zoom returned an error.',
  ZOOM_ERROR: 'Zoom reported an error.',
  RESPONSE_TOO_LARGE: 'The Zoom response was too large to read.',
  SHAPE_UNRECOGNIZED: "Zoom changed its page format; Fleet couldn't read it safely.",
  CAPTURE_TIMEOUT: "The Zoom page didn't load its data in time.",
  CAPTURE_FAILED: "The Zoom page couldn't be read.",
  NEEDS_CAPTURE: 'Refreshing from the Zoom page.',
  NOT_FOUND: 'Not found. Refresh the list and try again.',
  TRANSCRIPT_UNAVAILABLE: "No transcript could be fetched. You can import a transcript file.",
  INVALID_FILE: "That file isn't a valid transcript or image.",
  CONSENT_REQUIRED: 'AI consent is needed first.',
  AI_UNAVAILABLE: 'The AI summary is unavailable right now.',
  UNKNOWN_TARGET: "That unit or carrier isn't in fleet data.",
  FLEET_DATA_UNAVAILABLE: 'Fleet data is not loaded yet.',
  LIMIT_REACHED: 'A size limit was reached.',
  DUPLICATE_NAME: 'A preset with that name already exists.',
  UNKNOWN_IMAGE: 'A preset uses an image that is missing.',
  IN_USE: 'That image is used by a preset.',
  IO_ERROR: 'A file could not be read or written.',
  INVALID_PATH: "That launcher path isn't valid.",
  LAUNCH_FAILED: "The launcher didn't start.",
  BUSY: 'Busy. Try again shortly.',
  UNAVAILABLE: 'Zoom is unavailable in this window. Restart Fleet.',
  NOT_IMPLEMENTED: 'Not available yet.',
  INTERNAL: 'Something went wrong.',
  // OBS (design §4.7; only reachable when zoom.studio.obs is on)
  OBS_UNREACHABLE: "Can't reach OBS.",
  OBS_NOT_RUNNING: "OBS isn't running.",
  OBS_SERVER_DISABLED: 'The WebSocket server is off in OBS.',
  OBS_PASSWORD_REQUIRED: 'OBS needs its WebSocket password.',
  OBS_AUTH_FAILED: 'OBS rejected the password.',
  OBS_NOT_INSTALLED: "OBS wasn't found at that path.",
  OBS_NAME_CONFLICT: "An OBS scene or source named 'Fleet Camera' / 'Fleet Camera Feed' already exists and isn't Fleet's. Rename it in OBS.",
  OBS_REQUEST_FAILED: 'OBS refused a request.',
  OBS_CLOSED: 'OBS closed the connection.',
  OBS_UNSUPPORTED: "This OBS WebSocket version isn't supported.",
  OBS_FEED_FAILED: "Fleet couldn't start the OBS feed.",
};

// code + reason specific sentences (review F-3, F-4).
const REASON_MESSAGES = {
  'TRANSCRIPT_UNAVAILABLE:not-loaded': 'Load or import the transcript first',
  'AI_UNAVAILABLE:no-isolated-lane': "Fleet's private AI lane isn't available on this PC.",
};

/** codeMessage(code, reason?) -- one fixed sentence per code; unknown -> 'Something went wrong (code)'. */
export function codeMessage(code, reason) {
  if (typeof code === 'string' && typeof reason === 'string') {
    const k = code + ':' + reason;
    if (Object.prototype.hasOwnProperty.call(REASON_MESSAGES, k)) return REASON_MESSAGES[k];
  }
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(CODE_MESSAGES, code)) return CODE_MESSAGES[code];
  return 'Something went wrong (' + String(code == null ? 'unknown' : code).replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) + ')';
}

export const CODE_LIST = Object.keys(CODE_MESSAGES);

/** resultMessage(r) -- the user-facing sentence for an {ok:false, code, reason?} result. */
export function resultMessage(r) {
  return codeMessage(r && r.code ? r.code : 'INTERNAL', r && r.reason);
}

// ── A2 panels (design §13) ─────────────────────────────────────────────────

/** fmtStart(iso) -- local start time; null -> 'Recurring — no fixed time'. */
export function fmtStart(iso) {
  if (!iso) return 'Recurring — no fixed time';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown time';
  try {
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch (_) {
    return d.toLocaleString();
  }
}

/** fmtDuration(min) -- 'N min' | ''. */
export function fmtDuration(min) {
  return typeof min === 'number' && Number.isFinite(min) && min > 0 ? Math.round(min) + ' min' : '';
}

function _targetLabel(t) {
  return (t.kind === 'unit' ? 'unit ' : '') + String(t.id);
}

/** linkedSummary(link) -- 'Linked: unit 123456, AMZL' | ''. */
export function linkedSummary(link) {
  const targets = link && Array.isArray(link.targets) ? link.targets : [];
  if (!targets.length) return '';
  return 'Linked: ' + targets.map(_targetLabel).join(', ');
}

/**
 * renderLinkChips(link, {removable}) -- chips for each linked unit / carrier; removable chips carry an
 * unlink button (data-action="unlink" data-kind data-id).
 */
export function renderLinkChips(link, opts = {}) {
  const targets = link && Array.isArray(link.targets) ? link.targets : [];
  if (!targets.length) return '<span class="zh-muted">Not linked</span>';
  return targets.map((t) => {
    const label = (t.kind === 'unit' ? 'Unit ' : 'Carrier ') + String(t.id);
    const rm = opts.removable
      ? ` <button type="button" class="zh-chip-x" data-action="unlink" data-kind="${esc(t.kind)}" data-id="${esc(t.id)}" aria-label="Remove link ${esc(label)}">&times;</button>`
      : '';
    return `<span class="zh-chip">${esc(label)}${rm}</span>`;
  }).join(' ');
}

function _linkedChip(link) {
  const s = linkedSummary(link);
  return s ? ` <span class="zh-chip zh-chip-linked">${esc(s)}</span>` : '';
}

/** joinLabel(item) -- 'Join' | 'Join (may ask for passcode)'. */
export function joinLabel(item) {
  return item && item.joinNeedsPasscode ? 'Join (may ask for passcode)' : 'Join';
}

/**
 * renderMeetingRows(items, {links, selectedKey}) -- one row per meeting with local start, duration,
 * topic, Linked chip and a Join button only when hasJoin. Empty -> 'No meetings found'.
 */
export function renderMeetingRows(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const links = opts.links || {};
  if (!list.length) return '<li class="zh-empty">No meetings found</li>';
  return list.map((it) => {
    const topic = it.topic ? esc(it.topic) : '<span class="zh-muted">(no topic)</span>';
    const dur = fmtDuration(it.durationMin);
    const sel = opts.selectedKey === it.key ? ' zh-row-selected' : '';
    const join = it.hasJoin
      ? ` <button type="button" class="zh-btn zh-btn-primary" data-action="join" data-key="${esc(it.key)}" aria-label="${esc(joinLabel(it))}: ${esc(it.topic || 'meeting')}">${esc(joinLabel(it))}</button>`
      : '';
    return `<li class="zh-row${sel}" data-action="select" data-key="${esc(it.key)}">` +
      `<span class="zh-when">${esc(fmtStart(it.startIso))}</span>` +
      (dur ? ` <span class="zh-dur">${esc(dur)}</span>` : '') +
      ` <span class="zh-topic">${topic}</span>${_linkedChip(links[it.key])}${join}</li>`;
  }).join('');
}

/** transcriptBadge(hasTranscript) -- 'Available' | 'None' | 'Unknown'. */
export function transcriptBadge(v) {
  if (v === true) return 'Available';
  if (v === false) return 'None';
  return 'Unknown';
}

/** renderRecordingRows(items, {links, selectedKey}) -- rows with a transcript badge. Empty -> 'No recordings found'. */
export function renderRecordingRows(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const links = opts.links || {};
  if (!list.length) return '<li class="zh-empty">No recordings found</li>';
  return list.map((it) => {
    const topic = it.topic ? esc(it.topic) : '<span class="zh-muted">(no topic)</span>';
    const dur = fmtDuration(it.durationMin);
    const sel = opts.selectedKey === it.key ? ' zh-row-selected' : '';
    const badge = transcriptBadge(it.hasTranscript);
    return `<li class="zh-row${sel}" data-action="select" data-key="${esc(it.key)}">` +
      `<span class="zh-when">${esc(fmtStart(it.startIso))}</span>` +
      (dur ? ` <span class="zh-dur">${esc(dur)}</span>` : '') +
      ` <span class="zh-topic">${topic}</span>` +
      ` <span class="zh-badge zh-badge-${badge.toLowerCase()}">Transcript: ${badge}</span>${_linkedChip(links[it.key])}</li>`;
  }).join('');
}

/** renderItemDetail(item) -- detail pane header (same fields as the row). */
export function renderItemDetail(item) {
  if (!item) return '<p class="zh-muted">Select an item to see details.</p>';
  const dur = fmtDuration(item.durationMin);
  return `<h3 class="zh-detail-title">${item.topic ? esc(item.topic) : '(no topic)'}</h3>` +
    `<p class="zh-detail-meta">${esc(fmtStart(item.startIso))}${dur ? ' · ' + esc(dur) : ''}</p>`;
}

export const TRANSCRIPT_WINDOW = 500;

/**
 * renderTranscript(transcript, {focus}) -- virtualized viewer: at most 500 rows around `focus`
 * (a global segment number), each '[S#] speaker: text' with id zh-seg-<i>.
 */
export function renderTranscript(transcript, opts = {}) {
  const segs = transcript && Array.isArray(transcript.segments) ? transcript.segments : [];
  if (!segs.length) return '<p class="zh-muted">No transcript loaded.</p>';
  const n = segs.length;
  const focus = Number.isInteger(opts.focus) ? Math.min(Math.max(opts.focus, 1), n) : 1;
  let start = Math.max(0, focus - 1 - Math.floor(TRANSCRIPT_WINDOW / 10));
  if (start + TRANSCRIPT_WINDOW > n) start = Math.max(0, n - TRANSCRIPT_WINDOW);
  const end = Math.min(n, start + TRANSCRIPT_WINDOW);
  const rows = [];
  for (let k = start; k < end; k++) {
    const g = segs[k];
    const cls = g.i === opts.focus ? 'zh-seg zh-seg-focus' : 'zh-seg';
    rows.push(`<div class="${cls}" id="zh-seg-${Number(g.i)}" data-seg="${Number(g.i)}">[S${Number(g.i)}] ` +
      (g.speaker ? `<span class="zh-speaker">${esc(g.speaker)}</span>: ` : '') + `${esc(g.text)}</div>`);
  }
  const src = transcript.source === 'import' ? 'Imported file' : 'Zoom portal';
  const note = `<p class="zh-muted zh-seg-note">${esc(src)} · segments ${start + 1}–${end} of ${n}` +
    (transcript.truncated ? ' (transcript was truncated)' : '') + '</p>';
  const nav = n > TRANSCRIPT_WINDOW
    ? `<div class="zh-seg-nav">` +
      (start > 0 ? `<button type="button" class="zh-btn" data-action="seg-page" data-seg="${Math.max(1, start + 1 - TRANSCRIPT_WINDOW)}" aria-label="Show earlier segments">Earlier</button>` : '') +
      (end < n ? ` <button type="button" class="zh-btn" data-action="seg-page" data-seg="${end + 1}" aria-label="Show later segments">Later</button>` : '') +
      `</div>`
    : '';
  return note + nav + `<div class="zh-seg-list">${rows.join('')}</div>`;
}

function _refChips(refs) {
  return (Array.isArray(refs) ? refs : []).filter((r) => Number.isInteger(r)).map((r) =>
    `<button type="button" class="zh-ref" data-action="ref" data-seg="${r}" aria-label="Show segment ${r}">[S${r}]</button>`).join(' ');
}

/**
 * renderSummary(result) -- three sections with clickable [S#] chips, an 'N unsupported items removed'
 * footer when dropped > 0, and 'Summary covers the first N of M segments' when coverage is partial.
 */
export function renderSummary(result) {
  const s = result && result.summary;
  if (!s) return '';
  const section = (title, list, isAction) => {
    const items = Array.isArray(list) ? list : [];
    const body = items.length
      ? '<ul class="zh-sum-list">' + items.map((it) => {
        const meta = isAction
          ? (it.owner ? ` <span class="zh-sum-meta">Owner: ${esc(it.owner)}</span>` : '') + (it.due ? ` <span class="zh-sum-meta">Due: ${esc(it.due)}</span>` : '')
          : '';
        return `<li>${esc(it.text)}${meta} ${_refChips(it.refs)}</li>`;
      }).join('') + '</ul>'
      : '<p class="zh-muted">None</p>';
    return `<section class="zh-sum-section"><h4>${title}</h4>${body}</section>`;
  };
  let footer = '';
  const dropped = Number(result.dropped) || 0;
  if (dropped > 0) footer += `<p class="zh-sum-foot">${dropped} unsupported item${dropped === 1 ? '' : 's'} removed</p>`;
  const c = result.coverage;
  if (c && Number.isInteger(c.segmentsCovered) && Number.isInteger(c.segmentsTotal) && c.segmentsCovered < c.segmentsTotal) {
    footer += `<p class="zh-sum-foot">Summary covers the first ${c.segmentsCovered} of ${c.segmentsTotal} segments</p>`;
  }
  return `<div class="zh-summary">` +
    section('Key points', s.keyPoints, false) +
    section('Action items', s.actionItems, true) +
    section('Decisions', s.decisions, false) +
    footer + `</div>`;
}

/**
 * renderRecordingActions(item, {write, busy, hasTranscript, hasSummary}) -- the recording detail buttons.
 */
export function renderRecordingActions(item, opts = {}) {
  if (!item) return '';
  const b = [];
  if (item.hasTranscript !== false) b.push(`<button type="button" class="zh-btn" data-action="get-transcript" aria-label="Get transcript from Zoom">Get transcript</button>`);
  b.push(`<button type="button" class="zh-btn" data-action="import-transcript" aria-label="Import transcript file">Import transcript file…</button>`);
  const dis = opts.busy ? ' disabled' : '';
  b.push(`<button type="button" class="zh-btn zh-btn-primary" data-action="summarize" aria-label="Summarize transcript"${dis}>Summarize</button>`);
  if (opts.hasSummary) b.push(`<button type="button" class="zh-btn" data-action="regenerate" aria-label="Regenerate summary"${dis}>Regenerate</button>`);
  if (opts.write) b.push(`<button type="button" class="zh-btn" data-action="delete-portal" aria-label="Delete in Zoom portal">Delete in Zoom portal…</button>`);
  return b.join(' ');
}

/** renderLinkResults(items) -- link-target search results with an Add button each. */
export function renderLinkResults(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '<li class="zh-empty">No matches</li>';
  return list.map((t) =>
    `<li class="zh-link-result"><span>${esc(t.label || t.id)}</span> ` +
    `<button type="button" class="zh-btn" data-action="add" data-id="${esc(t.id)}" aria-label="Add link ${esc(t.label || t.id)}">Add</button></li>`).join('');
}

/**
 * connectionFromStatus(r) -- reduce a status()/connect() result to a connection state.
 * -> {phase:'signed-in'|'signed-out'|'error', code?, note?}
 */
export function connectionFromStatus(r) {
  if (!r || r.ok !== true) return { phase: 'error', code: (r && r.code) || 'INTERNAL' };
  if (r.signedIn === true) return { phase: 'signed-in' };
  if (r.signedIn === false) return { phase: 'signed-out' };
  return { phase: 'error', code: r.code || 'INTERNAL' };
}

/**
 * renderConnection(state) -- the connection card's inner HTML.
 * state.phase: 'checking' | 'signed-in' | 'signed-out' | 'connecting' | 'error'
 */
export function renderConnection(state) {
  const s = state || { phase: 'checking' };
  const note = s.note ? `<div class="zh-conn-note">${esc(s.note)}</div>` : '';
  switch (s.phase) {
    case 'signed-in':
      return `<span class="zh-conn-text zh-conn-ok" role="status" aria-live="polite">Signed in to Zoom</span>` +
        `<button type="button" class="zh-btn zh-btn-icon" data-action="refresh" aria-label="Refresh Zoom sign-in status">&#x21BB;</button>${note}`;
    case 'signed-out':
      return `<span class="zh-conn-text" role="status" aria-live="polite">Sign in to Zoom</span>` +
        `<button type="button" class="zh-btn zh-btn-primary" data-action="connect" aria-label="Connect to Zoom">Connect</button>${note}`;
    case 'connecting':
      return `<span class="zh-conn-text" role="status" aria-live="polite">A Zoom window may open — sign in there</span>` +
        `<button type="button" class="zh-btn" data-action="connect" aria-label="Connect to Zoom" disabled>Connect</button>`;
    case 'error':
      return `<span class="zh-conn-text zh-conn-err" role="status" aria-live="polite">Zoom unreachable (${esc(s.code || 'INTERNAL')})</span>` +
        `<button type="button" class="zh-btn" data-action="retry" aria-label="Retry Zoom connection check">Retry</button>${note}`;
    case 'checking':
    default:
      return `<span class="zh-conn-text" role="status" aria-live="polite">Checking…</span>`;
  }
}
