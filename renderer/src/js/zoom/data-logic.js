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
};

/** codeMessage(code) -- one fixed sentence per code; unknown -> 'Something went wrong (code)'. */
export function codeMessage(code) {
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(CODE_MESSAGES, code)) return CODE_MESSAGES[code];
  return 'Something went wrong (' + String(code == null ? 'unknown' : code).replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) + ')';
}

export const CODE_LIST = Object.keys(CODE_MESSAGES);

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
