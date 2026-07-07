/**
 * schedulers.js - Scheduler status + control view (Stage 15 / S28 update)
 *
 * Slot times are now user-configurable via Settings → Schedulers.
 * Saved via settings:save-schedule-slots IPC → restarts backend schedulers live.
 *
 * Sections:
 *   1. Header + weekday badge + live clock
 *   2. Next-slot countdown banner
 *   3. SP Push card  (last run, next slot, status, manual trigger, time editors)
 *   4. Auto-Email card (last run, next slot, status, time editors)
 *   5. Today's slot timeline (past/soon/upcoming/weekend badges)
 *   6. Run log (localStorage, 20 entries, type icons)
 *
 * IPC used:
 *   window.fleet.requestSync()              - full sync
 *   window.sp.push(rows)                    - manual SP push
 *   window.settings.getScheduleSlots()      - load saved slot config
 *   window.settings.saveScheduleSlots(s)    - save + hot-reload backend
 */

import bus      from '../bus.js';
import state    from '../state.js';
import { settings as settingsBridge } from '../bridge.js';

// Default slots — overwritten by _loadSlots() on init
const _DEFAULT_SP_SLOTS    = [{ h: 7,  m: 30, label: '07:30' }, { h: 15, m: 30, label: '15:30' }];
const _DEFAULT_EMAIL_SLOTS = [{ h: 8,  m:  0, label: '08:00' }, { h: 15, m: 15, label: '15:15' }];

let SP_SLOTS    = _DEFAULT_SP_SLOTS.map(s => ({ ...s }));
let EMAIL_SLOTS = _DEFAULT_EMAIL_SLOTS.map(s => ({ ...s }));

function _allSlots() {
  return [
    ...SP_SLOTS.map(s    => ({ ...s, type: 'sp'    })),
    ...EMAIL_SLOTS.map(s => ({ ...s, type: 'email' })),
  ].sort((a, b) => (a.h * 60 + a.m) - (b.h * 60 + b.m));
}

const MAX_LOG = 20;
const LOG_KEY = 'vc_scheduler_log';

let _el           = null;
let _tickTimer    = null;
let _log          = [];
let _spRunning    = false;
let _spLastRun    = null;    // { ts, status, msg }
let _emailLastRun = null;    // { ts, status, msg }

// ── Log ───────────────────────────────────────────────────────────────────
function _loadLog() {
  try { _log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (_) { _log = []; }
}
function _saveLog() {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(_log.slice(0, MAX_LOG))); } catch (_) {}
}
function _pushLog(entry) {
  _log.unshift({ ts: Date.now(), ...entry });
  if (_log.length > MAX_LOG) _log.length = MAX_LOG;
  _saveLog();
  _renderLog();
}

// ── Helpers ───────────────────────────────────────────────────────────────
const _safe = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function _fmtDT(d) {
  if (!d) return '\u2014';
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
    dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function _isWd() { const d = new Date().getDay(); return d >= 1 && d <= 5; }
function _minsUntil(h, m) {
  const now = new Date();
  let diff = (h * 60 + m) - (now.getHours() * 60 + now.getMinutes());
  if (diff <= 0) diff += 24 * 60;
  return diff;
}
function _nextSlot() {
  let best = null;
  for (const s of _allSlots()) {
    const mins = _minsUntil(s.h, s.m);
    if (!best || mins < best.minsUntil) best = { slot: s, minsUntil: mins };
  }
  return best;
}
function _fmtCd(m) {
  if (m < 0) return '\u2014';
  const h = Math.floor(m / 60), mm = m % 60;
  return h > 0 ? (h + 'h ' + mm + 'm') : (mm + 'm');
}
function _icon(t)  { return t === 'sp' ? '\ud83d\udce4' : '\ud83d\udce7'; }
function _label(t) { return t === 'sp' ? 'SP Push' : 'Auto Email'; }
function _badge(status) {
  const map = { ok: 'ok', error: 'err', running: 'run', skipped: 'skip' };
  const c = map[status] || 'idle';
  const l = (status || 'idle').toUpperCase();
  return '<span class="sched-badge sched-badge--' + c + '">' + l + '</span>';
}

// ── Slot row ──────────────────────────────────────────────────────────────
function _slotRow(slot, lastRun) {
  const now = new Date();
  const nm  = now.getHours() * 60 + now.getMinutes();
  const sm  = slot.h * 60 + slot.m;
  const p   = sm < nm;
  const sn  = !p && (sm - nm) <= 30;
  const sfx = !_isWd() ? 'weekend' : p ? 'past' : sn ? 'soon' : 'upcoming';
  const bc  = !_isWd() ? 'skip' : (p && lastRun) ? 'ok' : p ? 'idle' : sn ? 'run' : 'idle';
  const bt  = !_isWd() ? 'WEEKEND' : (p && lastRun) ? 'DONE' : p ? 'MISSED' : sn ? 'SOON' : 'PENDING';
  return '<div class="sched-slot sched-slot--' + sfx + '">'
    + '<div class="sched-slot__time">' + _safe(slot.label) + '</div>'
    + '<div class="sched-slot__type">' + _icon(slot.type) + ' ' + _label(slot.type) + '</div>'
    + '<div class="sched-slot__last">Last: ' + _safe(lastRun ? _fmtDT(lastRun.ts) : '\u2014') + '</div>'
    + '<span class="sched-badge sched-badge--' + bc + '">' + bt + '</span>'
    + '</div>';
}

// ── HTML ──────────────────────────────────────────────────────────────────
function _viewHtml() {
  return '<div class="sched-view" id="sched-view">'

    + '<div class="sched-header">'
    + '<div class="sched-header__left"><div class="sched-title"><span>\u23f1</span> Schedulers</div>'
    + '<div class="sched-subtitle" id="sched-weekday-badge">\u2014</div></div>'
    + '<div class="sched-header__right"><div class="sched-clock" id="sched-clock">\u2014</div>'
    + '<button class="sched-btn sched-btn--back" id="sched-back">\u2190 Fleet</button></div>'
    + '</div>'

    + '<div class="sched-next-banner"><span class="sched-next-banner__label">Next slot:</span>'
    + '<span class="sched-next-banner__slot" id="sched-next-slot">\u2014</span>'
    + '<span class="sched-next-banner__in">in</span>'
    + '<span class="sched-next-banner__countdown" id="sched-next-countdown">\u2014</span></div>'

    + '<div class="sched-grid">'

   + '<div class="sched-card" id="sched-card-sp">'
    + '<div class="sched-card__head"><div class="sched-card__icon sched-card__icon--sp">\ud83d\udce4</div>'
    + '<div><div class="sched-card__title">SharePoint Push</div><div class="sched-card__sub" id="sched-sp-sub">Weekdays \u2014</div></div>'
    + '<div class="sched-card__badge" id="sched-sp-badge">\u2014</div></div>'
    + '<div class="sched-card__meta">'
    + '<div class="sched-card__meta-item"><span class="sched-card__meta-label">Last run</span><span class="sched-card__meta-val" id="sched-sp-last">\u2014</span></div>'
    + '<div class="sched-card__meta-item"><span class="sched-card__meta-label">Next</span><span class="sched-card__meta-val" id="sched-sp-next">\u2014</span></div>'
    + '<div class="sched-card__meta-item"><span class="sched-card__meta-label">Status</span><span class="sched-card__meta-val" id="sched-sp-status">\u2014</span></div>'
    + '</div>'
    + '<div class="sched-card__progress" id="sched-sp-progress" style="display:none">'
    + '<div class="sched-progress-bar" id="sched-sp-bar"></div>'
    + '<div class="sched-progress-msg" id="sched-sp-msg">\u2014</div></div>'
    + '<div class="sched-time-editor">'
    + '<span class="sched-time-editor__label">AM slot</span>'
    + '<input class="sched-time-input" type="time" id="sched-sp-am" />'
    + '<span class="sched-time-editor__label">PM slot</span>'
    + '<input class="sched-time-input" type="time" id="sched-sp-pm" />'
    + '<button class="sched-btn sched-btn--save" id="sched-sp-save">\u2713 Save times</button>'
    + '</div>'
    + '<div class="sched-card__actions">'
    + '<button class="sched-btn sched-btn--primary" id="sched-sp-trigger">\ud83d\udce4 Run SP Push Now</button>'
    + '<button class="sched-btn sched-btn--ghost" id="sched-sp-sync">\ud83d\udd04 Sync Only</button>'
    + '</div></div>'

    + '<div class="sched-card" id="sched-card-email">'
    + '<div class="sched-card__head"><div class="sched-card__icon sched-card__icon--email">\ud83d\udce7</div>'
    + '<div><div class="sched-card__title">Auto Email</div><div class="sched-card__sub" id="sched-em-sub">Weekdays \u2014</div></div>'
    + '<div class="sched-card__badge" id="sched-em-badge">\u2014</div></div>'
    + '<div class="sched-card__meta">'
    + '<div class="sched-card__meta-item"><span class="sched-card__meta-label">Last run</span><span class="sched-card__meta-val" id="sched-em-last">\u2014</span></div>'
    + '<div class="sched-card__meta-item"><span class="sched-card__meta-label">Next</span><span class="sched-card__meta-val" id="sched-em-next">\u2014</span></div>'
    + '<div class="sched-card__meta-item"><span class="sched-card__meta-label">Status</span><span class="sched-card__meta-val" id="sched-em-status">\u2014</span></div>'
    + '</div>'
    + '<div class="sched-time-editor">'
    + '<span class="sched-time-editor__label">AM slot</span>'
    + '<input class="sched-time-input" type="time" id="sched-em-am" />'
    + '<span class="sched-time-editor__label">PM slot</span>'
    + '<input class="sched-time-input" type="time" id="sched-em-pm" />'
    + '<button class="sched-btn sched-btn--save" id="sched-em-save">\u2713 Save times</button>'
    + '</div>'
    + '<div class="sched-card__note">Auto-email fires at scheduled slots \u2014 no manual trigger needed. Use the Email Composer for ad-hoc sends.</div>'
    + '</div>'

    + '</div>'   // /sched-grid

    + '<div class="sched-section"><div class="sched-section__title">Today\'s Schedule</div>'
    + '<div class="sched-timeline" id="sched-timeline"></div></div>'

    + '<div class="sched-section"><div class="sched-section__head">'
    + '<div class="sched-section__title">Run Log</div>'
    + '<button class="sched-btn sched-btn--ghost sched-btn--sm" id="sched-clear-log">Clear</button>'
    + '</div><div class="sched-log" id="sched-log"></div></div>'

    + '</div>';
}

// ── CSS ───────────────────────────────────────────────────────────────────
const _CSS = [
  '.view--schedulers{flex:1;overflow-y:auto;padding:16px 20px 32px;display:flex;flex-direction:column;gap:14px}',
  '.sched-view{display:flex;flex-direction:column;gap:14px;max-width:860px;width:100%}',
  '.sched-header{display:flex;align-items:center;justify-content:space-between;gap:12px}',
  '.sched-header__left,.sched-header__right{display:flex;align-items:center;gap:12px}',
  '.sched-title{font-size:15px;font-weight:700;color:var(--txt);display:flex;align-items:center;gap:7px}',
  '.sched-subtitle{font-family:var(--mono);font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:3px 9px;border-radius:5px;font-weight:700}',
  '.sched-subtitle.weekday{color:var(--grn);background:var(--grnd);border:1px solid rgba(126,231,135,.2)}',
  '.sched-subtitle.weekend{color:var(--mut);background:var(--el);border:1px solid var(--bdr)}',
  '.sched-clock{font-family:var(--mono);font-size:13px;color:var(--txt2)}',
  '.sched-next-banner{display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--adim);border:1px solid rgba(88,166,255,.2);border-radius:8px;font-size:11px}',
  '.sched-next-banner__label{color:var(--txt2)}.sched-next-banner__slot{font-family:var(--mono);font-weight:700;color:var(--acc2)}',
  '.sched-next-banner__in{color:var(--txt2)}.sched-next-banner__countdown{font-family:var(--mono);font-weight:800;font-size:13px;color:var(--acc)}',
  '.sched-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
  '.sched-card{background:var(--card);border:1px solid var(--bdr);border-radius:var(--r);padding:16px;display:flex;flex-direction:column;gap:12px;transition:border-color .2s}',
  '.sched-card:hover{border-color:var(--bdrs)}.sched-card.running{border-color:var(--acc);box-shadow:0 0 0 2px rgba(88,166,255,.12)}',
  '.sched-card__head{display:flex;align-items:flex-start;gap:10px}',
  '.sched-card__icon{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}',
  '.sched-card__icon--sp{background:var(--adim)}.sched-card__icon--email{background:rgba(126,231,135,.12)}',
  '.sched-card__title{font-size:13px;font-weight:700;color:var(--txt)}.sched-card__sub{font-size:10px;color:var(--txt2);margin-top:2px;font-family:var(--mono)}',
  '.sched-card__badge{margin-left:auto}',
  '.sched-card__meta{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}',
  '.sched-card__meta-item{display:flex;flex-direction:column;gap:2px}',
  '.sched-card__meta-label{font-size:9px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px}',
  '.sched-card__meta-val{font-family:var(--mono);font-size:11px;color:var(--txt2);font-weight:600}',
  '.sched-card__progress{display:flex;flex-direction:column;gap:5px}',
  '.sched-progress-bar{height:3px;background:var(--acc);border-radius:2px;width:0%;transition:width .4s ease;animation:sched-pulse 1.5s ease-in-out infinite}',
  '@keyframes sched-pulse{0%,100%{opacity:1}50%{opacity:.5}}',
  '.sched-progress-msg{font-size:10px;color:var(--acc2);font-family:var(--mono)}',
  '.sched-card__note{font-size:10px;color:var(--txt2);line-height:1.6;padding:8px 10px;background:var(--el);border-radius:6px;border-left:3px solid var(--grn)}',
  '.sched-card__actions{display:flex;gap:8px}',
  '.sched-btn{padding:7px 13px;border-radius:7px;font-size:11px;font-weight:600;border:1px solid var(--bdr);background:var(--el);color:var(--txt);cursor:pointer;transition:all .2s;display:flex;align-items:center;gap:5px}',
  '.sched-btn:hover{border-color:var(--acc);background:var(--adim)}',
  '.sched-btn--primary{background:var(--adim);border-color:var(--acc);color:var(--acc2)}.sched-btn--primary:hover{background:rgba(88,166,255,.2)}',
  '.sched-btn--primary:disabled{opacity:.45;cursor:not-allowed}',
  '.sched-btn--ghost{background:transparent;color:var(--txt2)}.sched-btn--ghost:hover{color:var(--txt);background:var(--el)}',
  '.sched-btn--back{font-size:10px;padding:5px 10px}.sched-btn--sm{font-size:9px;padding:3px 8px}',
  '.sched-badge{font-family:var(--mono);font-size:8px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;padding:2px 7px;border-radius:4px;white-space:nowrap}',
  '.sched-badge--ok{background:var(--grnd);color:var(--grn);border:1px solid rgba(126,231,135,.25)}',
  '.sched-badge--err{background:var(--redd);color:var(--red);border:1px solid rgba(255,123,114,.25)}',
  '.sched-badge--run{background:var(--adim);color:var(--acc2);border:1px solid rgba(88,166,255,.3);animation:sched-pulse 1s infinite}',
  '.sched-badge--skip,.sched-badge--idle{background:var(--el);border:1px solid var(--bdr)}',
  '.sched-badge--skip{color:var(--mut)}.sched-badge--idle{color:var(--txt2)}',
  '.sched-section{display:flex;flex-direction:column;gap:8px}',
  '.sched-section__head{display:flex;align-items:center;justify-content:space-between}',
  '.sched-section__title{font-family:var(--mono);font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--mut);font-weight:700;display:flex;align-items:center;gap:8px}',
  '.sched-section__title::before{content:"";width:10px;height:1px;background:var(--acc)}',
  '.sched-timeline{display:flex;flex-direction:column;gap:5px}',
  '.sched-slot{display:flex;align-items:center;gap:12px;padding:9px 14px;border-radius:8px;border:1px solid var(--bdr);background:var(--card);transition:all .2s}',
  '.sched-slot--past{opacity:.55}.sched-slot--soon{border-color:var(--acc);background:var(--adim)}',
  '.sched-slot--upcoming{opacity:.8}.sched-slot--weekend{opacity:.4}',
  '.sched-slot__time{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--txt);width:48px}',
  '.sched-slot__type{font-size:11px;color:var(--txt2);flex:1}.sched-slot__last{font-family:var(--mono);font-size:9px;color:var(--mut)}',
  '.sched-log{background:var(--card);border:1px solid var(--bdr);border-radius:var(--r);overflow:hidden;max-height:240px;overflow-y:auto}',
  '.sched-log-empty{padding:18px;text-align:center;font-size:11px;color:var(--mut)}',
  '.sched-log-row{display:flex;align-items:flex-start;gap:10px;padding:8px 14px;border-bottom:1px solid rgba(48,54,61,.5);font-size:11px}',
  '.sched-log-row:last-child{border-bottom:none}.sched-log-row:hover{background:var(--hov)}',
  '.sched-log-ts{font-family:var(--mono);font-size:9px;color:var(--mut);white-space:nowrap;width:80px}',
  '.sched-log-icon{font-size:12px;flex-shrink:0}',
  '.sched-log-msg{color:var(--txt2);line-height:1.4;flex:1}.sched-log-msg.ok{color:var(--grn)}.sched-log-msg.err{color:var(--red)}',
  // Time editor
  '.sched-time-editor{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--el);border-radius:7px;flex-wrap:wrap}',
  '.sched-time-editor__label{font-size:9px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;font-weight:700}',
  '.sched-time-input{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--txt);background:var(--card);border:1px solid var(--bdr);border-radius:5px;padding:4px 8px;width:90px}',
  '.sched-time-input:focus{outline:none;border-color:var(--acc)}',
  '.sched-btn--save{background:var(--adim);border-color:var(--acc);color:var(--acc2);margin-left:auto}',
  '.sched-btn--save:hover{background:rgba(88,166,255,.2)}',
].join('\n');

let _cssInjected = false;
function _injectCss() {
  if (_cssInjected) return;
  const s = document.createElement('style');
  s.textContent = _CSS;
  document.head.appendChild(s);
  _cssInjected = true;
}

// ── Render ────────────────────────────────────────────────────────────────
function _q(id) { return _el ? _el.querySelector('#' + id) : null; }

function _rHeader() {
  const c = _q('sched-clock'), w = _q('sched-weekday-badge');
  if (!c || !w) return;
  c.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const wd = _isWd();
  w.textContent = wd ? '\u25cf Weekday \u2014 Schedulers Active' : '\u25cf Weekend \u2014 Schedulers Paused';
  w.className = 'sched-subtitle ' + (wd ? 'weekday' : 'weekend');
}
function _rCountdown() {
  const ns = _nextSlot();
  if (!ns) return;
  const se = _q('sched-next-slot'), ce = _q('sched-next-countdown');
  if (se) se.textContent = _icon(ns.slot.type) + ' ' + _label(ns.slot.type) + ' @ ' + ns.slot.label;
  if (ce) ce.textContent = _fmtCd(ns.minsUntil);
}
function _rSpCard() {
  const nx = SP_SLOTS.map(s => ({ ...s, mu: _minsUntil(s.h, s.m) })).sort((a, b) => a.mu - b.mu)[0];
  const b = _q('sched-sp-badge'), l = _q('sched-sp-last'), n = _q('sched-sp-next'), s = _q('sched-sp-status');
  if (b) b.innerHTML   = _badge(_spRunning ? 'running' : (_spLastRun ? _spLastRun.status : null));
  if (l) l.textContent = _spLastRun ? _fmtDT(_spLastRun.ts) : '\u2014';
  if (n) n.textContent = nx.label + ' (in ' + _fmtCd(nx.mu) + ')';
  if (s) s.textContent = _spRunning ? 'Running...' : (_spLastRun ? _spLastRun.msg : '\u2014');
  const btn = _q('sched-sp-trigger');
  if (btn) btn.disabled = _spRunning;
}
function _rEmailCard() {
  const nx = EMAIL_SLOTS.map(s => ({ ...s, mu: _minsUntil(s.h, s.m) })).sort((a, b) => a.mu - b.mu)[0];
  const b = _q('sched-em-badge'), l = _q('sched-em-last'), n = _q('sched-em-next'), s = _q('sched-em-status');
  if (b) b.innerHTML   = _badge(_emailLastRun ? _emailLastRun.status : null);
  if (l) l.textContent = _emailLastRun ? _fmtDT(_emailLastRun.ts) : '\u2014';
  if (n) n.textContent = nx.label + ' (in ' + _fmtCd(nx.mu) + ')';
  if (s) s.textContent = _emailLastRun ? _emailLastRun.msg : '\u2014';
}
function _rTimeline() {
  const tl = _q('sched-timeline');
  if (!tl) return;
  tl.innerHTML = _allSlots().map(s => _slotRow(s, s.type === 'sp' ? _spLastRun : _emailLastRun)).join('');
}
function _renderLog() {
  const el = _q('sched-log');
  if (!el) return;
  if (!_log.length) { el.innerHTML = '<div class="sched-log-empty">No runs recorded yet.</div>'; return; }
  el.innerHTML = _log.map(e => {
    const dt = new Date(e.ts);
    const ts = String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0') + ':' + String(dt.getSeconds()).padStart(2, '0');
    const ic = e.type === 'sp' ? '\ud83d\udce4' : e.type === 'email' ? '\ud83d\udce7' : '\ud83d\udd04';
    const cl = e.status === 'ok' ? 'ok' : e.status === 'error' ? 'err' : '';
    return '<div class="sched-log-row"><span class="sched-log-ts">' + _safe(ts) + '</span>'
      + '<span class="sched-log-icon">' + ic + '</span>'
      + '<span class="sched-log-msg ' + cl + '">' + _safe(e.msg || '') + '</span></div>';
  }).join('');
}
function _rAll() { _rHeader(); _rCountdown(); _rSpCard(); _rEmailCard(); _rTimeline(); _renderLog(); }

// ── SP progress ────────────────────────────────────────────────────────────
function _onSpProg(p) {
  const msg  = p.message || '';
  const done = /complete|done|success|error|fail/i.test(msg);
  if (!_spRunning) {
    _spRunning = true;
    const c = _el && _el.querySelector('#sched-card-sp');
    if (c) c.classList.add('running');
  }
  const pr = _q('sched-sp-progress'), br = _q('sched-sp-bar'), me = _q('sched-sp-msg');
  if (pr) pr.style.display = 'flex';
  if (me) me.textContent = msg;
  if (br) { const cur = parseFloat(br.style.width) || 0; br.style.width = (done ? 100 : Math.min(cur + 8, 80)) + '%'; }
  _pushLog({ type: 'sp', msg, status: done ? 'ok' : 'running' });
  if (done) {
    _spRunning = false;
    _spLastRun = { ts: Date.now(), status: 'ok', msg };
    const c = _el && _el.querySelector('#sched-card-sp');
    if (c) c.classList.remove('running');
    setTimeout(() => { if (pr) pr.style.display = 'none'; if (br) br.style.width = '0%'; }, 2000);
  }
  _rSpCard();
}

// ── Manual SP push ────────────────────────────────────────────────────────
async function _triggerSP() {
  if (_spRunning) return;
  _pushLog({ type: 'sp', msg: 'Manual SP push triggered', status: 'running' });
  try {
    const rows = state.slice('fleet').rows || [];
    if (!rows.length) {
      _pushLog({ type: 'sync', msg: 'No fleet data \u2014 requesting sync first', status: 'running' });
      if (window.fleet && window.fleet.requestSync) window.fleet.requestSync();
      return;
    }
    _spRunning = true;
    _rSpCard();
    const r  = await window.sp.push(rows);
    const ok = r && r.ok !== false;
    _spLastRun = { ts: Date.now(), status: ok ? 'ok' : 'error', msg: (r && r.message) || (ok ? 'SP push complete' : 'SP push failed') };
    _pushLog({ type: 'sp', msg: _spLastRun.msg, status: _spLastRun.status });
  } catch (e) {
    _spLastRun = { ts: Date.now(), status: 'error', msg: 'SP push failed: ' + e.message };
    _pushLog({ type: 'sp', msg: _spLastRun.msg, status: 'error' });
  } finally {
    _spRunning = false;
    _rSpCard();
  }
}

function _triggerSync() {
  _pushLog({ type: 'sync', msg: 'Manual sync requested', status: 'running' });
  if (window.fleet && window.fleet.requestSync) window.fleet.requestSync();
}

// ── Tick ──────────────────────────────────────────────────────────────────
function _startTick() {
  _stopTick();
  _tickTimer = setInterval(() => {
    if (_el && _el.style.display !== 'none') {
      _rHeader(); _rCountdown(); _rSpCard(); _rEmailCard(); _rTimeline();
    }
  }, 1000);
}
function _stopTick() {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}


// ── Slot config helpers ───────────────────────────────────────────────────
async function _loadSlots() {
  try {
    const saved = await settingsBridge.getScheduleSlots();
    if (saved && Array.isArray(saved.sp) && Array.isArray(saved.email)) {
      SP_SLOTS    = saved.sp;
      EMAIL_SLOTS = saved.email;
    }
  } catch (_) {}
}

function _hm(str) {
  // Parse "HH:MM" time input value → { h, m }
  const [h, m] = (str || '').split(':').map(Number);
  return { h: h || 0, m: m || 0 };
}

function _pad(n) { return String(n).padStart(2, '0'); }
function _toTimeStr(h, m) { return _pad(h) + ':' + _pad(m); }

function _populateTimeInputs() {
  const spAm = _q('sched-sp-am'), spPm = _q('sched-sp-pm');
  const emAm = _q('sched-em-am'), emPm = _q('sched-em-pm');
  if (spAm) spAm.value = _toTimeStr(SP_SLOTS[0].h, SP_SLOTS[0].m);
  if (spPm) spPm.value = _toTimeStr(SP_SLOTS[1].h, SP_SLOTS[1].m);
  if (emAm) emAm.value = _toTimeStr(EMAIL_SLOTS[0].h, EMAIL_SLOTS[0].m);
  if (emPm) emPm.value = _toTimeStr(EMAIL_SLOTS[1].h, EMAIL_SLOTS[1].m);
}

function _updateCardSubs() {
  const spSub = _q('sched-sp-sub');
  const emSub = _q('sched-em-sub');
  if (spSub) spSub.textContent = 'Weekdays ' + SP_SLOTS.map(s => s.label).join(' \u00b7 ');
  if (emSub) emSub.textContent = 'Weekdays ' + EMAIL_SLOTS.map(s => s.label).join(' \u00b7 ');
}

async function _saveSlots(type) {
  const amId = type === 'sp' ? 'sched-sp-am' : 'sched-em-am';
  const pmId = type === 'sp' ? 'sched-sp-pm' : 'sched-em-pm';
  const amEl = _q(amId), pmEl = _q(pmId);
  if (!amEl || !pmEl) return;

  const am = _hm(amEl.value), pm = _hm(pmEl.value);
  const amLabel = _toTimeStr(am.h, am.m);
  const pmLabel = _toTimeStr(pm.h, pm.m);

  const newSlots = {
    sp:    type === 'sp'    ? [{ ...am, label: amLabel }, { ...pm, label: pmLabel }] : SP_SLOTS,
    email: type === 'email' ? [{ ...am, label: amLabel }, { ...pm, label: pmLabel }] : EMAIL_SLOTS,
  };

  const btn = _q(type === 'sp' ? 'sched-sp-save' : 'sched-em-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

  try {
    const result = await settingsBridge.saveScheduleSlots(newSlots);
    if (result && result.ok) {
      if (type === 'sp')    SP_SLOTS    = newSlots.sp;
      if (type === 'email') EMAIL_SLOTS = newSlots.email;
      _updateCardSubs();
      _pushLog({ type: 'sync', msg: (type === 'sp' ? 'SP' : 'Email') + ' schedule updated: ' + amLabel + ' · ' + pmLabel, status: 'ok' });
    }
  } catch (e) {
    _pushLog({ type: 'sync', msg: 'Save failed: ' + e.message, status: 'error' });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '\u2713 Save times'; }
  }
}

// ── init ──────────────────────────────────────────────────────────────────
export function init(container) {
  _injectCss();
  _loadLog();

  _el = document.createElement('div');
  _el.id        = 'view-schedulers';
  _el.className = 'view view--schedulers';
  _el.style.display = 'none';
  _el.innerHTML = _viewHtml();
  container.appendChild(_el);

  const bb = _q('sched-back');
  const sb = _q('sched-sp-trigger');
  const sy = _q('sched-sp-sync');
  const cl = _q('sched-clear-log');
  const ss = _q('sched-sp-save');
  const es = _q('sched-em-save');
  if (bb) bb.addEventListener('click', () => bus.emit('ui:view-change', { from: 'schedulers', to: 'fleet' }));
  if (sb) sb.addEventListener('click', _triggerSP);
  if (sy) sy.addEventListener('click', _triggerSync);
  if (cl) cl.addEventListener('click', () => { _log = []; _saveLog(); _renderLog(); });
  if (ss) ss.addEventListener('click', () => _saveSlots('sp'));
  if (es) es.addEventListener('click', () => _saveSlots('email'));

  // Load saved slot config, populate inputs, update card subtitles
  _loadSlots().then(() => {
    _populateTimeInputs();
    _updateCardSubs();
    _rAll();
  });

  bus.on('sp:progress', (p) => { if (_el && _el.style.display !== 'none') _onSpProg(p); });
  bus.on('fleet:status', (msg) => {
    if (!msg) return;
    const isErr = /error|fail/i.test(msg);
    const isEm  = /email|auto-email/i.test(msg);
    const isSP  = /sp push|sp:/i.test(msg);
    if (isEm) {
      _emailLastRun = { ts: Date.now(), status: isErr ? 'error' : 'ok', msg };
      _pushLog({ type: 'email', msg, status: _emailLastRun.status });
      if (_el && _el.style.display !== 'none') _rEmailCard();
    } else if (isSP) {
      _pushLog({ type: 'sp', msg, status: isErr ? 'error' : 'ok' });
    } else {
      _pushLog({ type: 'sync', msg, status: isErr ? 'error' : 'ok' });
    }
  });
  bus.on('fleet:data', () => {
    const sa = state.slice('fleet').syncedAt;
    if (sa) _pushLog({ type: 'sync', msg: 'Fleet data synced (' + (state.slice('fleet').count || 0) + ' units)', status: 'ok' });
  });
  bus.on('ui:view-change', ({ to }) => {
    const vis = to === 'schedulers';
    _el.style.display = vis ? 'flex' : 'none';
    if (vis) {
      _loadSlots().then(() => { _populateTimeInputs(); _updateCardSubs(); _rAll(); });
      _startTick();
    } else {
      _stopTick();
    }
  });
  _rAll();
}
