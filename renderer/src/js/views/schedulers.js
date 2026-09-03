/**
 * schedulers.js — Scheduler status + control view (Task #8 rebuild)
 *
 * AUTHORITATIVE from the backend ledger. Everything shown here comes from
 * window.scheduler.getState() (structured values only). There is NO
 * localStorage run history and NO parsing of human-readable status strings —
 * the previous version derived status by regex-matching fleet:status messages,
 * which was fragile and could show "sent" when nothing was verified.
 *
 * Sources:
 *   window.scheduler.getState()            - full structured state
 *   window.scheduler.runSpNow()            - manual verified SP push
 *   window.scheduler.runEmailTestNow()     - run next email slot as TEST
 *   window.scheduler.retry/cancel/reconcile/resolveUncertain(jobId)
 *   window.scheduler.setEnabled/setFreshness(patch)
 *   window.scheduler.authenticateOwa() / openSentItems()
 *   window.scheduler.onJobUpdate(cb)       - live state pushes
 *   window.settings.saveScheduleSlots(s)   - save + hot-reload backend slots
 */

import bus      from '../bus.js';
import { settings as settingsBridge } from '../bridge.js';

let _el        = null;
let _tickTimer = null;
let _state     = null;   // last getState() snapshot
let _busy      = false;

// ── Helpers ───────────────────────────────────────────────────────────────
const _safe = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function _q(id) { return _el ? _el.querySelector('#' + id) : null; }
function _fmtDT(d) {
  if (!d) return '\u2014';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '\u2014';
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
    dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function _ageStr(min) {
  if (min == null) return '\u2014';
  if (min < 60) return min + 'm ago';
  return Math.floor(min / 60) + 'h ' + (min % 60) + 'm ago';
}
function _isWd() { const d = new Date().getDay(); return d >= 1 && d <= 5; }

// Structured state -> badge class (NO string parsing).
const _STATE_BADGE = {
  completed: 'ok', sent: 'ok',
  failed: 'err', 'partial-failure': 'err',
  'blocked-auth': 'auth', 'blocked-stale-data': 'stale',
  'delivery-uncertain': 'warn', 'verification-pending': 'warn',
  retry: 'run', running: 'run', syncing: 'run', validating: 'run', verifying: 'run', queued: 'run',
  cancelled: 'skip',
};
function _badge(stateVal) {
  const c = _STATE_BADGE[stateVal] || 'idle';
  return '<span class="sched-badge sched-badge--' + c + '">' + _safe((stateVal || 'idle').toUpperCase()) + '</span>';
}

// ── HTML ──────────────────────────────────────────────────────────────────
function _viewHtml() {
  return '<div class="sched-view" id="sched-view">'
    + '<div class="sched-header">'
    + '<div class="sched-header__left"><div class="sched-title"><span>\u23f1</span> Schedulers</div>'
    + '<div class="sched-subtitle" id="sched-weekday-badge">\u2014</div></div>'
    + '<div class="sched-header__right"><div class="sched-clock" id="sched-clock">\u2014</div>'
    + '<span class="sched-tz" id="sched-tz"></span>'
    + '<button class="sched-btn sched-btn--back" id="sched-back">\u2190 Fleet</button></div>'
    + '</div>'

    + '<div class="sched-next-banner">'
    + '<span class="sched-next-banner__label">Fleet data:</span>'
    + '<span class="sched-next-banner__slot" id="sched-data-info">\u2014</span>'
    + '<span class="sched-next-banner__in">\u00b7 sources:</span>'
    + '<span class="sched-next-banner__countdown" id="sched-sources">\u2014</span></div>'

    + '<div class="sched-grid">'

    // SP card
    + '<div class="sched-card" id="sched-card-sp">'
    + '<div class="sched-card__head"><div class="sched-card__icon sched-card__icon--sp">\ud83d\udce4</div>'
    + '<div><div class="sched-card__title">SharePoint Push</div><div class="sched-card__sub" id="sched-sp-sub">Weekdays \u2014</div></div>'
    + '<label class="sched-toggle" title="Enable/disable scheduled SP push"><input type="checkbox" id="sched-sp-enabled" /><span>On</span></label>'
    + '<div class="sched-card__badge" id="sched-sp-badge">\u2014</div></div>'
    + '<div class="sched-card__meta">'
    + '<div class="sched-card__meta-item"><span class="sched-card__meta-label">Last verified</span><span class="sched-card__meta-val" id="sched-sp-last">\u2014</span></div>'
    + '<div class="sched-card__meta-item"><span class="sched-card__meta-label">Next</span><span class="sched-card__meta-val" id="sched-sp-next">\u2014</span></div>'
    + '<div class="sched-card__meta-item"><span class="sched-card__meta-label">Last failure</span><span class="sched-card__meta-val" id="sched-sp-fail">\u2014</span></div>'
    + '</div>'
    + '<div class="sched-card__progress" id="sched-sp-progress" style="display:none">'
    + '<div class="sched-progress-bar" id="sched-sp-bar"></div>'
    + '<div class="sched-progress-msg" id="sched-sp-msg">\u2014</div></div>'
    + '<div class="sched-time-editor">'
    + '<span class="sched-time-editor__label">AM</span><input class="sched-time-input" type="time" id="sched-sp-am" />'
    + '<span class="sched-time-editor__label">PM</span><input class="sched-time-input" type="time" id="sched-sp-pm" />'
    + '<button class="sched-btn sched-btn--save" id="sched-sp-save">\u2713 Save</button></div>'
    + '<div class="sched-card__actions">'
    + '<button class="sched-btn sched-btn--primary" id="sched-sp-trigger">\ud83d\udce4 Run SP Push Now</button>'
    + '</div></div>'

    // Email card
    + '<div class="sched-card" id="sched-card-email">'
    + '<div class="sched-card__head"><div class="sched-card__icon sched-card__icon--email">\ud83d\udce7</div>'
    + '<div><div class="sched-card__title">Auto Email</div><div class="sched-card__sub" id="sched-em-sub">Weekdays \u2014</div></div>'
    + '<label class="sched-toggle" title="Enable/disable scheduled email"><input type="checkbox" id="sched-em-enabled" /><span>On</span></label>'
    + '<div class="sched-card__badge" id="sched-em-badge">\u2014</div></div>'
    + '<div class="sched-card__meta">'
    + '<div class="sched-card__meta-item"><span class="sched-card__meta-label">Last verified</span><span class="sched-card__meta-val" id="sched-em-last">\u2014</span></div>'
    + '<div class="sched-card__meta-item"><span class="sched-card__meta-label">Next</span><span class="sched-card__meta-val" id="sched-em-next">\u2014</span></div>'
    + '<div class="sched-card__meta-item"><span class="sched-card__meta-label">Last failure</span><span class="sched-card__meta-val" id="sched-em-fail">\u2014</span></div>'
    + '</div>'
    + '<div class="sched-time-editor">'
    + '<span class="sched-time-editor__label">AM</span><input class="sched-time-input" type="time" id="sched-em-am" />'
    + '<span class="sched-time-editor__label">PM</span><input class="sched-time-input" type="time" id="sched-em-pm" />'
    + '<button class="sched-btn sched-btn--save" id="sched-em-save">\u2713 Save</button></div>'
    + '<div class="sched-card__actions">'
    + '<button class="sched-btn sched-btn--primary" id="sched-em-test">\ud83e\uddea Run Next Slot as Test</button>'
    + '<button class="sched-btn sched-btn--ghost" id="sched-owa-auth">\ud83d\udd10 Authenticate OWA</button>'
    + '<button class="sched-btn sched-btn--ghost" id="sched-owa-sent">\ud83d\udce4 Sent Items</button>'
    + '</div></div>'

    + '</div>'   // /sched-grid

    // Attention (blockers / uncertain) surfaced prominently
    + '<div class="sched-section" id="sched-attention-sec" style="display:none">'
    + '<div class="sched-section__title">Needs Attention</div>'
    + '<div id="sched-attention"></div></div>'

    + '<div class="sched-section"><div class="sched-section__title">Today\'s Jobs (from ledger)</div>'
    + '<div class="sched-jobs" id="sched-jobs"></div></div>'

    + '<div class="sched-section"><div class="sched-section__head">'
    + '<div class="sched-section__title">Audit History</div></div>'
    + '<div class="sched-log" id="sched-log"></div></div>'

    + '</div>';
}

// ── CSS (extends the prior shell) ───────────────────────────────────────────
const _CSS = [
  '.view--schedulers{flex:1;overflow-y:auto;padding:16px 20px 32px;display:flex;flex-direction:column;gap:14px}',
  '.sched-view{display:flex;flex-direction:column;gap:14px;max-width:900px;width:100%}',
  '.sched-header{display:flex;align-items:center;justify-content:space-between;gap:12px}',
  '.sched-header__left,.sched-header__right{display:flex;align-items:center;gap:12px}',
  '.sched-title{font-size:15px;font-weight:700;color:var(--txt);display:flex;align-items:center;gap:7px}',
  '.sched-subtitle{font-family:var(--mono);font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:3px 9px;border-radius:5px;font-weight:700}',
  '.sched-subtitle.weekday{color:var(--grn);background:var(--grnd);border:1px solid rgba(126,231,135,.2)}',
  '.sched-subtitle.weekend{color:var(--mut);background:var(--el);border:1px solid var(--bdr)}',
  '.sched-clock{font-family:var(--mono);font-size:13px;color:var(--txt2)}',
  '.sched-tz{font-family:var(--mono);font-size:9px;color:var(--mut)}',
  '.sched-next-banner{display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--adim);border:1px solid rgba(88,166,255,.2);border-radius:8px;font-size:11px;flex-wrap:wrap}',
  '.sched-next-banner__label{color:var(--txt2)}.sched-next-banner__slot{font-family:var(--mono);font-weight:700;color:var(--acc2)}',
  '.sched-next-banner__in{color:var(--txt2)}.sched-next-banner__countdown{font-family:var(--mono);font-weight:700;font-size:11px;color:var(--acc)}',
  '.sched-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
  '.sched-card{background:var(--card);border:1px solid var(--bdr);border-radius:var(--r);padding:16px;display:flex;flex-direction:column;gap:12px;transition:border-color .2s}',
  '.sched-card:hover{border-color:var(--bdrs)}.sched-card.running{border-color:var(--acc);box-shadow:0 0 0 2px rgba(88,166,255,.12)}',
  '.sched-card__head{display:flex;align-items:center;gap:10px}',
  '.sched-card__icon{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}',
  '.sched-card__icon--sp{background:var(--adim)}.sched-card__icon--email{background:rgba(126,231,135,.12)}',
  '.sched-card__title{font-size:13px;font-weight:700;color:var(--txt)}.sched-card__sub{font-size:10px;color:var(--txt2);margin-top:2px;font-family:var(--mono)}',
  '.sched-toggle{display:flex;align-items:center;gap:4px;font-size:9px;color:var(--txt2);cursor:pointer;margin-left:auto}',
  '.sched-card__badge{}',
  '.sched-card__meta{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}',
  '.sched-card__meta-item{display:flex;flex-direction:column;gap:2px}',
  '.sched-card__meta-label{font-size:9px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px}',
  '.sched-card__meta-val{font-family:var(--mono);font-size:11px;color:var(--txt2);font-weight:600}',
  '.sched-card__progress{display:flex;flex-direction:column;gap:5px}',
  '.sched-progress-bar{height:3px;background:var(--acc);border-radius:2px;width:0%;transition:width .4s ease;animation:sched-pulse 1.5s ease-in-out infinite}',
  '@keyframes sched-pulse{0%,100%{opacity:1}50%{opacity:.5}}',
  '.sched-progress-msg{font-size:10px;color:var(--acc2);font-family:var(--mono)}',
  '.sched-card__actions{display:flex;gap:8px;flex-wrap:wrap}',
  '.sched-btn{padding:7px 13px;border-radius:7px;font-size:11px;font-weight:600;border:1px solid var(--bdr);background:var(--el);color:var(--txt);cursor:pointer;transition:all .2s;display:flex;align-items:center;gap:5px}',
  '.sched-btn:hover{border-color:var(--acc);background:var(--adim)}',
  '.sched-btn--primary{background:var(--adim);border-color:var(--acc);color:var(--acc2)}.sched-btn--primary:hover{background:rgba(88,166,255,.2)}',
  '.sched-btn--primary:disabled{opacity:.45;cursor:not-allowed}',
  '.sched-btn--ghost{background:transparent;color:var(--txt2)}.sched-btn--ghost:hover{color:var(--txt);background:var(--el)}',
  '.sched-btn--back{font-size:10px;padding:5px 10px}.sched-btn--sm{font-size:9px;padding:3px 8px}',
  '.sched-badge{font-family:var(--mono);font-size:8px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;padding:2px 7px;border-radius:4px;white-space:nowrap}',
  '.sched-badge--ok{background:var(--grnd);color:var(--grn);border:1px solid rgba(126,231,135,.25)}',
  '.sched-badge--err{background:var(--redd);color:var(--red);border:1px solid rgba(255,123,114,.25)}',
  '.sched-badge--run{background:var(--adim);color:var(--acc2);border:1px solid rgba(88,166,255,.3)}',
  '.sched-badge--warn{background:rgba(255,193,7,.12);color:#d9a406;border:1px solid rgba(255,193,7,.3)}',
  '.sched-badge--auth{background:rgba(255,123,114,.12);color:var(--red);border:1px solid rgba(255,123,114,.3)}',
  '.sched-badge--stale{background:rgba(255,193,7,.12);color:#d9a406;border:1px solid rgba(255,193,7,.3)}',
  '.sched-badge--skip,.sched-badge--idle{background:var(--el);border:1px solid var(--bdr)}',
  '.sched-badge--skip{color:var(--mut)}.sched-badge--idle{color:var(--txt2)}',
  '.sched-section{display:flex;flex-direction:column;gap:8px}',
  '.sched-section__head{display:flex;align-items:center;justify-content:space-between}',
  '.sched-section__title{font-family:var(--mono);font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--mut);font-weight:700;display:flex;align-items:center;gap:8px}',
  '.sched-section__title::before{content:"";width:10px;height:1px;background:var(--acc)}',
  '.sched-jobs{display:flex;flex-direction:column;gap:5px}',
  '.sched-job{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;border:1px solid var(--bdr);background:var(--card);font-size:11px}',
  '.sched-job__ch{font-size:13px}',
  '.sched-job__scope{font-family:var(--mono);font-size:11px;color:var(--txt);font-weight:600}',
  '.sched-job__meta{font-size:9px;color:var(--mut);font-family:var(--mono)}',
  '.sched-job__recips{font-size:9px;color:var(--txt2)}',
  '.sched-job__spacer{flex:1}',
  '.sched-job__actions{display:flex;gap:5px}',
  '.sched-attn{padding:10px 12px;border-radius:8px;border:1px solid rgba(255,193,7,.3);background:rgba(255,193,7,.08);font-size:11px;color:var(--txt);margin-bottom:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.sched-attn__actions{display:flex;gap:5px;margin-left:auto}',
  '.sched-log{background:var(--card);border:1px solid var(--bdr);border-radius:var(--r);overflow:hidden;max-height:280px;overflow-y:auto}',
  '.sched-log-empty{padding:18px;text-align:center;font-size:11px;color:var(--mut)}',
  '.sched-log-row{display:flex;align-items:flex-start;gap:10px;padding:8px 14px;border-bottom:1px solid rgba(48,54,61,.5);font-size:11px}',
  '.sched-log-row:last-child{border-bottom:none}.sched-log-row:hover{background:var(--hov)}',
  '.sched-log-ts{font-family:var(--mono);font-size:9px;color:var(--mut);white-space:nowrap;width:90px}',
  '.sched-log-msg{color:var(--txt2);line-height:1.4;flex:1}',
  '.sched-time-editor{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--el);border-radius:7px;flex-wrap:wrap}',
  '.sched-time-editor__label{font-size:9px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;font-weight:700}',
  '.sched-time-input{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--txt);background:var(--card);border:1px solid var(--bdr);border-radius:5px;padding:4px 8px;width:90px}',
  '.sched-time-input:focus{outline:none;border-color:var(--acc)}',
  '.sched-btn--save{background:var(--adim);border-color:var(--acc);color:var(--acc2);margin-left:auto}',
].join('\n');

let _cssInjected = false;
function _injectCss() {
  if (_cssInjected) return;
  const s = document.createElement('style');
  s.textContent = _CSS;
  document.head.appendChild(s);
  _cssInjected = true;
}

// ── Data ────────────────────────────────────────────────────────────────────
async function _refresh() {
  if (!window.scheduler || !window.scheduler.getState) return;
  try {
    const st = await window.scheduler.getState();
    if (st && !st.ok === false) _state = st;
    _render();
  } catch (_) {}
}

function _pad(n) { return String(n).padStart(2, '0'); }
function _toTimeStr(h, m) { return _pad(h) + ':' + _pad(m); }

function _render() {
  _rHeader();
  if (!_state) return;
  _rBanner();
  _rChannelCard('sp', _state.sharepoint, _state.slots.sp, _state.nextSlot.sp, _state.enabled.sp);
  _rChannelCard('em', _state.email, _state.slots.email, _state.nextSlot.email, _state.enabled.email);
  _rAttention();
  _rJobs();
  _rAudit();
}

function _rHeader() {
  const c = _q('sched-clock'), w = _q('sched-weekday-badge'), tz = _q('sched-tz');
  if (c) c.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  if (w) { const wd = _isWd(); w.textContent = wd ? '\u25cf Weekday \u2014 Active' : '\u25cf Weekend \u2014 Paused'; w.className = 'sched-subtitle ' + (wd ? 'weekday' : 'weekend'); }
  if (tz && _state) tz.textContent = _state.timezone || '';
}

function _rBanner() {
  const info = _q('sched-data-info'), src = _q('sched-sources');
  const d = _state.data || {};
  if (info) info.textContent = (d.rowCount || 0) + ' units \u00b7 ' + _ageStr(d.ageMin);
  if (src) {
    const last = (_state.sharepoint && _state.sharepoint.lastVerified && _state.sharepoint.lastVerified.syncResult) ||
                 (_state.email && _state.email.lastVerified && _state.email.lastVerified.syncResult) || null;
    if (last) src.textContent = (last.sourcesUpdated || []).join(',') + (last.sourcesFailed && last.sourcesFailed.length ? ' (failed: ' + last.sourcesFailed.join(',') + ')' : '');
    else src.textContent = '\u2014';
  }
}

function _rChannelCard(pfx, ch, slots, next, enabled) {
  ch = ch || {};
  const sub = _q('sched-' + pfx + '-sub');
  if (sub) sub.textContent = 'Weekdays ' + (slots || []).map(s => s.label).join(' \u00b7 ');
  const badge = _q('sched-' + pfx + '-badge');
  if (badge) {
    // Prefer an active job's state, else last verified/failure.
    const active = (ch.active && ch.active[0]) || (ch.blockedAuth && ch.blockedAuth[0]) || (ch.uncertain && ch.uncertain[0]) || (ch.retrying && ch.retrying[0]);
    const stateVal = active ? active.state : (ch.lastVerified ? 'completed' : (ch.lastFailure ? ch.lastFailure.state : null));
    badge.innerHTML = _badge(stateVal);
  }
  const last = _q('sched-' + pfx + '-last');
  if (last) last.textContent = ch.lastVerified ? _fmtDT(ch.lastVerified.updatedAt) : '\u2014';
  const nextEl = _q('sched-' + pfx + '-next');
  if (nextEl) nextEl.textContent = next ? (next.label + (next.when === 'today' ? '' : ' (' + next.when + ')')) : '\u2014';
  const fail = _q('sched-' + pfx + '-fail');
  if (fail) fail.textContent = ch.lastFailure ? _fmtDT(ch.lastFailure.updatedAt) : '\u2014';
  const en = _q('sched-' + pfx + '-enabled');
  if (en) en.checked = !!enabled;
}

function _jobScopeLabel(j) {
  if (j.channel === 'sharepoint') return 'SharePoint';
  const sc = j.scope || {};
  return (sc.operator || 'ALL') + (sc.domicile && sc.domicile !== 'ALL' ? '/' + sc.domicile : '') + ' \u00b7 ' + (sc.series || '');
}

function _rAttention() {
  const sec = _q('sched-attention-sec'), box = _q('sched-attention');
  if (!box) return;
  const items = [];
  for (const ch of [_state.sharepoint, _state.email]) {
    if (!ch) continue;
    (ch.blockedAuth || []).forEach(j => items.push({ j, kind: 'auth', text: 'OWA sign-in required for ' + _jobScopeLabel(j) }));
    (ch.blockedStale || []).forEach(j => items.push({ j, kind: 'stale', text: 'Blocked (stale data): ' + _jobScopeLabel(j) }));
    (ch.uncertain || []).forEach(j => items.push({ j, kind: 'uncertain', text: 'Delivery unconfirmed: ' + _jobScopeLabel(j) + ' \u2014 confirm in Sent Items' }));
    if (ch.lastFailure && ch.retrying) (ch.retrying || []).forEach(j => items.push({ j, kind: 'retry', text: 'Retrying: ' + _jobScopeLabel(j) + ' (attempt ' + j.attempts + '/' + j.maxAttempts + ')' }));
  }
  if (!items.length) { sec.style.display = 'none'; box.innerHTML = ''; return; }
  sec.style.display = 'flex';
  box.innerHTML = items.map(it => {
    let actions = '';
    if (it.kind === 'auth') actions = '<button class="sched-btn sched-btn--sm" data-act="auth">Authenticate OWA</button>';
    else if (it.kind === 'uncertain') actions =
      '<button class="sched-btn sched-btn--sm" data-act="sent">Sent Items</button>' +
      '<button class="sched-btn sched-btn--sm" data-act="verified" data-job="' + _safe(it.j.jobId) + '">Mark verified</button>' +
      '<button class="sched-btn sched-btn--sm" data-act="notsent" data-job="' + _safe(it.j.jobId) + '">Mark failed</button>';
    else if (it.kind === 'stale') actions = '<button class="sched-btn sched-btn--sm" data-act="retry" data-job="' + _safe(it.j.jobId) + '">Retry</button>';
    return '<div class="sched-attn">' + _safe(it.text) + '<span class="sched-attn__actions">' + actions + '</span></div>';
  }).join('');
}

function _rJobs() {
  const box = _q('sched-jobs');
  if (!box) return;
  const jobs = _state.jobsToday || [];
  if (!jobs.length) { box.innerHTML = '<div class="sched-log-empty">No jobs recorded today.</div>'; return; }
  box.innerHTML = jobs.map(j => {
    const icon = j.channel === 'sharepoint' ? '\ud83d\udce4' : '\ud83d\udce7';
    const recips = j.channel === 'email'
      ? ('to ' + (j.actualRecipients || []).join(', ') + (j.testMode ? ' [TEST intended: ' + (j.intendedRecipients || []).join(', ') + ']' : ''))
      : (j.deliveryResult ? ('verified ' + (j.deliveryResult.workbooksSucceeded || 0) + '/' + (j.deliveryResult.workbooksAttempted || 0) + ' workbooks') : '');
    const canCancel = !['completed', 'failed', 'cancelled'].includes(j.state);
    const canRetry = ['failed', 'partial-failure', 'retry'].includes(j.state);
    let acts = '';
    if (canRetry) acts += '<button class="sched-btn sched-btn--sm" data-act="retry" data-job="' + _safe(j.jobId) + '">Retry</button>';
    if (canCancel) acts += '<button class="sched-btn sched-btn--sm" data-act="cancel" data-job="' + _safe(j.jobId) + '">Cancel</button>';
    return '<div class="sched-job">'
      + '<span class="sched-job__ch">' + icon + (j.testMode ? '\ud83e\uddea' : '') + '</span>'
      + '<span class="sched-job__scope">' + _safe(_jobScopeLabel(j)) + ' @ ' + _safe(j.slotLabel) + '</span>'
      + _badge(j.state)
      + '<span class="sched-job__meta">' + _safe(j.origin) + (j.nextRetryAt ? ' \u00b7 retry ' + _fmtDT(j.nextRetryAt) : '') + '</span>'
      + '<span class="sched-job__recips">' + _safe(recips) + '</span>'
      + '<span class="sched-job__spacer"></span>'
      + '<span class="sched-job__actions">' + acts + '</span>'
      + '</div>';
  }).join('');
}

function _rAudit() {
  const el = _q('sched-log');
  if (!el) return;
  // Flatten the most recent history entries across today's jobs (no bodies/secrets).
  const rows = [];
  (_state.jobsToday || []).forEach(j => {
    (j.history || []).slice(-4).forEach(h => rows.push({ at: h.at, msg: _jobScopeLabel(j) + ' @ ' + j.slotLabel + ': ' + (h.from || 'start') + ' \u2192 ' + h.to + (h.note ? ' (' + h.note + ')' : '') }));
  });
  rows.sort((a, b) => (a.at < b.at ? 1 : -1));
  if (!rows.length) { el.innerHTML = '<div class="sched-log-empty">No audit entries yet.</div>'; return; }
  el.innerHTML = rows.slice(0, 40).map(r => '<div class="sched-log-row"><span class="sched-log-ts">' + _safe(_fmtDT(r.at)) + '</span><span class="sched-log-msg">' + _safe(r.msg) + '</span></div>').join('');
}

// ── Actions ───────────────────────────────────────────────────────────────
async function _guard(fn) {
  if (_busy) return;
  _busy = true;
  try { await fn(); } finally { _busy = false; _refresh(); }
}
function _toast(type, message) { try { bus.emit('ui:toast', { type, message, duration: 4000 }); } catch (_) {} }

async function _runSpNow() {
  await _guard(async () => {
    _toast('info', 'SharePoint push started (verified)...');
    const r = await window.scheduler.runSpNow();
    if (r && r.ok) _toast('success', 'SharePoint push verified');
    else _toast('error', 'SharePoint push not verified: ' + ((r && r.result && (r.result.status || r.result.blocked || r.result.skipped)) || 'see jobs'));
  });
}
async function _runEmailTest() {
  await _guard(async () => {
    const r = await window.scheduler.runEmailTestNow();
    if (r && r.result && r.result.blocked === 'no-test-recipient') { _toast('error', 'Set a test recipient in Settings first'); return; }
    _toast('info', 'Test email run started (goes to test recipient only)');
  });
}
async function _setEnabled(channel, on) {
  await window.scheduler.setEnabled({ [channel]: on });
  _toast('success', (channel === 'sp' ? 'SharePoint' : 'Email') + ' scheduler ' + (on ? 'enabled' : 'disabled'));
}
function _wireDelegatedActions(root) {
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    const jobId = btn.getAttribute('data-job');
    if (act === 'auth') return _guard(async () => { await window.scheduler.authenticateOwa(); _toast('info', 'Complete sign-in, then jobs resume on the next slot/catch-up'); });
    if (act === 'sent') return window.scheduler.openSentItems();
    if (act === 'retry' && jobId) return _guard(async () => { const r = await window.scheduler.retry(jobId); _toast(r && r.ok ? 'success' : 'error', r && r.ok ? 'Re-queued' : ('Retry failed: ' + (r && r.error))); });
    if (act === 'cancel' && jobId) return _guard(async () => { const r = await window.scheduler.cancel(jobId); _toast(r && r.ok ? 'success' : 'error', r && r.ok ? 'Cancelled' : ('Cancel failed: ' + (r && r.error))); });
    if (act === 'verified' && jobId) return _guard(async () => { const r = await window.scheduler.resolveUncertain(jobId, true); _toast(r && r.ok ? 'success' : 'error', r && r.ok ? 'Marked verified' : 'Failed'); });
    if (act === 'notsent' && jobId) return _guard(async () => { const r = await window.scheduler.resolveUncertain(jobId, false); _toast(r && r.ok ? 'success' : 'error', r && r.ok ? 'Marked not-sent' : 'Failed'); });
  });
}

// ── Slot config ─────────────────────────────────────────────────────────────
function _hm(str) { const [h, m] = (str || '').split(':').map(Number); return { h: h || 0, m: m || 0 }; }
function _populateTimeInputs() {
  if (!_state) return;
  const sp = _state.slots.sp, em = _state.slots.email;
  const set = (id, v) => { const el = _q(id); if (el && v) el.value = v; };
  if (sp[0]) set('sched-sp-am', _toTimeStr(sp[0].h, sp[0].m));
  if (sp[1]) set('sched-sp-pm', _toTimeStr(sp[1].h, sp[1].m));
  if (em[0]) set('sched-em-am', _toTimeStr(em[0].h, em[0].m));
  if (em[1]) set('sched-em-pm', _toTimeStr(em[1].h, em[1].m));
}
async function _saveSlots(type) {
  const amEl = _q('sched-' + (type === 'sp' ? 'sp' : 'em') + '-am');
  const pmEl = _q('sched-' + (type === 'sp' ? 'sp' : 'em') + '-pm');
  if (!amEl || !pmEl) return;
  const am = _hm(amEl.value), pm = _hm(pmEl.value);
  const mk = (t) => ({ h: t.h, m: t.m, label: _toTimeStr(t.h, t.m) });
  const cur = _state ? _state.slots : { sp: [], email: [] };
  const newSlots = {
    sp:    type === 'sp'    ? [mk(am), mk(pm)] : cur.sp,
    email: type === 'email' ? [mk(am), mk(pm)] : cur.email,
  };
  try {
    const result = await settingsBridge.saveScheduleSlots(newSlots);
    if (result && result.ok) { _toast('success', (type === 'sp' ? 'SP' : 'Email') + ' times saved'); _refresh(); }
    else _toast('error', 'Save failed: ' + ((result && result.error) || 'unknown'));
  } catch (e) { _toast('error', 'Save failed: ' + e.message); }
}

// ── Tick ──────────────────────────────────────────────────────────────────
function _startTick() {
  _stopTick();
  _tickTimer = setInterval(() => {
    if (_el && _el.style.display !== 'none') { _rHeader(); }
  }, 1000);
}
function _stopTick() { if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; } }

// ── init ──────────────────────────────────────────────────────────────────
export function init(container) {
  _injectCss();
  _el = document.createElement('div');
  _el.id        = 'view-schedulers';
  _el.className = 'view view--schedulers';
  _el.style.display = 'none';
  _el.innerHTML = _viewHtml();
  container.appendChild(_el);

  const bind = (id, ev, fn) => { const el = _q(id); if (el) el.addEventListener(ev, fn); };
  bind('sched-back', 'click', () => bus.emit('ui:view-change', { from: 'schedulers', to: 'fleet' }));
  bind('sched-sp-trigger', 'click', _runSpNow);
  bind('sched-em-test', 'click', _runEmailTest);
  bind('sched-owa-auth', 'click', () => _guard(async () => { await window.scheduler.authenticateOwa(); _toast('info', 'Sign-in window opened'); }));
  bind('sched-owa-sent', 'click', () => window.scheduler.openSentItems());
  bind('sched-sp-save', 'click', () => _saveSlots('sp'));
  bind('sched-em-save', 'click', () => _saveSlots('email'));
  bind('sched-sp-enabled', 'change', (e) => _setEnabled('sp', e.target.checked));
  bind('sched-em-enabled', 'change', (e) => _setEnabled('email', e.target.checked));
  _wireDelegatedActions(_el);

  // SP push progress bar (informational only — status of record is the ledger).
  bus.on('sp:progress', (p) => {
    if (!_el || _el.style.display === 'none') return;
    const pr = _q('sched-sp-progress'), br = _q('sched-sp-bar'), me = _q('sched-sp-msg');
    if (pr) pr.style.display = 'flex';
    if (me) me.textContent = (p && p.message) || '';
    if (br) { const cur = parseFloat(br.style.width) || 0; br.style.width = Math.min(cur + 8, 90) + '%'; }
  });
  // Live job-state updates from the pipeline -> refresh authoritative state.
  if (window.scheduler && window.scheduler.onJobUpdate) window.scheduler.onJobUpdate(() => { if (_el && _el.style.display !== 'none') _refresh(); });

  bus.on('ui:view-change', ({ to }) => {
    const vis = to === 'schedulers';
    _el.style.display = vis ? 'flex' : 'none';
    if (vis) { _refresh().then(() => _populateTimeInputs()); _startTick(); }
    else _stopTick();
  });

  _refresh().then(() => _populateTimeInputs());
}
