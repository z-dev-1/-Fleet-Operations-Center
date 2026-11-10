/**
 * zoom/obs-logic.js -- pure helpers and exact copy for the Studio "OBS output" section (design §5.1,
 * flag zoom.studio.obs). No DOM, no network, no timers: obs-panel.js renders from these and
 * obs-feed.js uses FEED_URL_RE / FEED_INTERVAL_MS / shouldSend.
 *
 * statusMessage(s) lookup order (review F4): (1) the renderer feed state s.feedState (obs-loop, in-use,
 * camera-lost), (2) s.reason when it is in the table, (3) s.code, (4) s.state; otherwise
 * codeMessage(s.code) or "Not connected.".
 */
import { esc, codeMessage } from './data-logic.js';

// ── Copy (exact; FR2 / FR6 / FR8 and review F1, F3, F9, F12, F15) ───────────
export const HONESTY_BANNER_OBS_LEAD = 'Preview.';
export const HONESTY_BANNER_OBS = "Preview. Zoom doesn't see Fleet directly: start OBS output below, then in Zoom choose 'OBS Virtual Camera' as your camera. Fleet can't be a camera by itself.";

export const OBS_STEPS = Object.freeze([
  'Start OBS output here.',
  'In Zoom, choose OBS Virtual Camera.',
  "Don't select your real camera in Zoom, because Fleet is using it.",
]);
// Review F5: the one-click start needs the one-time OBS setup first.
export const OBS_SETUP_NOTE = 'One-time setup in OBS: turn on the WebSocket server and enter its password here. After that, one click on Start OBS output handles the OBS side; then choose OBS Virtual Camera in Zoom.';
export const OBS_EFFECTS_NOTE = "Background replace needs a green screen. Avatar shows a full image or overlay, with no face tracking. Person-aware blur and replacement aren't available yet.";
export const OBS_RESTORE_NOTE = "Fleet switches OBS back to your previous scene when you stop output. If Fleet or OBS closes first, OBS shows a black 'feed stopped' screen and Fleet switches it back the next time you open Studio.";
export const OBS_TROUBLESHOOT = 'If Zoom shows something else, set OBS → Start Virtual Camera ⚙ → Output type: Program.';
export const OBS_BACKGROUNDS_NOTE = "Zoom's built-in backgrounds stay inside Zoom. Fleet uses images you import into the library.";
export const OBS_MIRROR_NOTE = 'Zoom mirrors your own self-view. Use Mirror here only if you want others to see a mirrored picture.';
export const OBS_HINT = 'Enable it in OBS: Tools → WebSocket Server Settings → Enable WebSocket server. Then click Show Connect Info and copy the Server Password into Fleet.';
export const OBS_TRAY_PREFIX = 'OBS is running in the system tray; open it from the tray icon. ';
export const IMAGE_LIVE_NOTE = 'The camera stays on while OBS output runs, so switching back is instant.';
export const PASSWORD_SAVED = 'Password saved';
export const PASSWORD_SESSION = 'Password kept for this session only.';

/** §5.1 status table plus review F3 camera-lost. */
export const STATUS_MESSAGES = Object.freeze({
  connected: 'Connected to OBS.',
  idle: 'Not connected.',
  OBS_NOT_RUNNING: "OBS isn't running.",
  'obs-starting': 'Starting OBS…',
  OBS_SERVER_DISABLED: 'The WebSocket server is off in OBS.',
  OBS_PASSWORD_REQUIRED: 'OBS needs its WebSocket password. Copy it from Tools → WebSocket Server Settings → Show Connect Info.',
  OBS_AUTH_FAILED: 'OBS rejected the password.',
  live: 'OBS output running. In Zoom, choose OBS Virtual Camera.',
  'vcam-stopped-in-obs': 'OBS Virtual Camera was stopped in OBS.',
  'obs-closed': 'OBS closed.',
  'feed-lost': "OBS output stopped because Fleet's feed ended.",
  recovered: 'Switched OBS back to your previous scene.',
  'obs-loop': "Fleet can't use OBS Virtual Camera as its own input. Pick your real camera.",
  'in-use': 'Your camera is busy. If Zoom or an OBS Video Capture source is using it, switch Zoom to OBS Virtual Camera or remove that source.',
  'camera-lost': 'OBS output stopped because the camera was disconnected or taken by another app.',
});

/** Renderer-only feed states (checked first, review F4). */
export const FEED_STATES = Object.freeze(['obs-loop', 'in-use', 'camera-lost']);

const _has = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(STATUS_MESSAGES, k);

/** statusMessage(s) -> the one status line (review F4 order: feedState > reason > code > state). */
export function statusMessage(s) {
  const o = s && typeof s === 'object' ? s : {};
  if (FEED_STATES.includes(o.feedState)) return STATUS_MESSAGES[o.feedState];
  if (_has(o.reason)) return STATUS_MESSAGES[o.reason];
  if (_has(o.code)) return STATUS_MESSAGES[o.code];
  if (_has(o.state)) return STATUS_MESSAGES[o.state];
  return typeof o.code === 'string' && o.code ? codeMessage(o.code) : 'Not connected.';
}

/** hintText(s) -> OBS_HINT, prefixed with the tray sentence after a Fleet launch (review F15). */
export function hintText(s) {
  return s && s.launchedByFleet ? OBS_TRAY_PREFIX + OBS_HINT : OBS_HINT;
}

const CONNECT_STATES = ['idle', 'error', 'obs-closed'];
const DISCONNECT_STATES = ['connected', 'live'];
const START_STATES = ['idle', 'error', 'obs-closed', 'connected'];

/**
 * buttonStates(status, inFlight) -> {connect, disconnect, start, stop, launch} (review F5 table).
 * Every button is disabled while an op is in flight.
 */
export function buttonStates(status, inFlight) {
  if (inFlight) return { connect: false, disconnect: false, start: false, stop: false, launch: false };
  const s = status && typeof status === 'object' ? status : {};
  const st = typeof s.state === 'string' ? s.state : 'idle';
  return {
    connect: CONNECT_STATES.includes(st),
    disconnect: DISCONNECT_STATES.includes(st),
    start: START_STATES.includes(st),
    stop: !!s.outputLive,
    launch: !!s.canLaunch,
  };
}

// ── Feed helpers ────────────────────────────────────────────────────────────
export const FEED_URL_RE = /^ws:\/\/127\.0\.0\.1:\d{1,5}\/feed\/[0-9a-f]{64}$/;
export const FEED_INTERVAL_MS = 33;
export const SEND_BUFFER_LIMIT = 1024 * 1024;

/** shouldSend({inFlight, bufferedAmount}) -> true when no frame is encoding and the socket isn't backed up. */
export function shouldSend(o) {
  const s = o && typeof o === 'object' ? o : {};
  if (s.inFlight) return false;
  const b = Number(s.bufferedAmount) || 0;
  return b < SEND_BUFFER_LIMIT;
}

/** containRect(sw, sh, dw, dh) -> {x, y, w, h}: fit sw x sh inside dw x dh, centred (same math as the OBS viewer page). */
export function containRect(sw, sh, dw, dh) {
  if (!(sw > 0 && sh > 0 && dw > 0 && dh > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  const s = Math.min(dw / sw, dh / sh);
  const w = sw * s;
  const h = sh * s;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}

// ── Render (pure) ───────────────────────────────────────────────────────────

function _btn(action, label, on) {
  return `<button type="button" class="zh-btn" data-action="${action}" aria-label="${esc(label)}"${on ? '' : ' disabled'}>${esc(label)}</button>`;
}

/**
 * renderObsSection(view) -> the OBS status / buttons / guide HTML.
 * view = {status, feedState, message, inFlight, showHint}
 */
export function renderObsSection(view) {
  const v = view && typeof view === 'object' ? view : {};
  const s = v.status && typeof v.status === 'object' ? v.status : { state: 'idle' };
  const line = v.message ? String(v.message) : statusMessage(Object.assign({}, s, { feedState: v.feedState || null }));
  const b = buttonStates(s, !!v.inFlight);
  const hintOpen = !!(v.showHint || s.hint);
  return '<section class="zs-obs-section" aria-label="OBS output">' +
    '<h4 class="zs-sub">OBS output</h4>' +
    `<p class="zs-obs-status" role="status" aria-live="polite"><span>${esc(line)}</span> ` +
      `<button type="button" class="zh-btn zs-obs-hint-btn" data-action="obs-hint" aria-label="How to enable the OBS WebSocket server" aria-expanded="${hintOpen ? 'true' : 'false'}">?</button></p>` +
    (hintOpen ? `<p class="zs-note zs-obs-hint">${esc(hintText(s))}</p>` : '') +
    '<div class="zs-row">' +
      _btn('obs-connect', 'Connect', b.connect) + ' ' +
      _btn('obs-disconnect', 'Disconnect', b.disconnect) + ' ' +
      _btn('obs-start', 'Start OBS output', b.start) + ' ' +
      _btn('obs-stop', 'Stop OBS output', b.stop) + ' ' +
      _btn('obs-launch', 'Start OBS', b.launch) +
    '</div>' +
    `<p class="zs-note">${esc(OBS_SETUP_NOTE)}</p>` +
    `<ol class="zs-obs-steps">${OBS_STEPS.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>` +
    `<p class="zs-note">${esc(OBS_EFFECTS_NOTE)}</p>` +
    `<p class="zs-note">${esc(OBS_RESTORE_NOTE)}</p>` +
    `<p class="zs-note">${esc(OBS_TROUBLESHOOT)}</p>` +
    `<p class="zs-note">${esc(OBS_BACKGROUNDS_NOTE)}</p>` +
    `<p class="zs-note">${esc(OBS_MIRROR_NOTE)}</p>` +
  '</section>';
}

/**
 * renderObsForm(view) -> host / port / password fields and the Advanced exe path (pure).
 * The password input is always rendered empty: a saved password is never shown again.
 * view = {host, port, exePath, passwordNote, inFlight}
 */
export function renderObsForm(view) {
  const v = view && typeof view === 'object' ? view : {};
  const dis = v.inFlight ? ' disabled' : '';
  return '<div class="zs-obs-form">' +
    '<div class="zs-row">' +
      `<label class="zs-field" for="zs-obs-host">OBS host</label> <input type="text" id="zs-obs-host" class="zs-input" data-role="obs-host" value="${esc(v.host == null ? '127.0.0.1' : v.host)}" aria-label="OBS host"> ` +
      `<label class="zs-field" for="zs-obs-port">Port</label> <input type="number" id="zs-obs-port" class="zs-input" data-role="obs-port" min="1024" max="65535" value="${esc(v.port == null ? 4455 : v.port)}" aria-label="OBS WebSocket port"> ` +
      '<label class="zs-field" for="zs-obs-password">Password</label> <input type="password" id="zs-obs-password" class="zs-input" data-role="obs-password" autocomplete="off" value="" aria-label="OBS WebSocket password"> ' +
      `<button type="button" class="zh-btn" data-action="obs-save" aria-label="Save OBS connection settings"${dis}>Save</button>` +
    '</div>' +
    `<p class="zs-note zs-obs-pw-note">${v.passwordNote ? esc(v.passwordNote) : ''}</p>` +
    '<details class="zs-obs-advanced"><summary>Advanced</summary>' +
      `<label class="zs-field" for="zs-obs-exe">OBS program (obs64.exe)</label> <input type="text" id="zs-obs-exe" class="zs-input" data-role="obs-exe" value="${esc(v.exePath || '')}" aria-label="OBS program path"> ` +
    '</details>' +
  '</div>';
}
