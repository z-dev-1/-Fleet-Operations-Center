/**
 * aperia-panel.js — Aperia HALO Connect panel, opened from the bottom status
 * bar Aperia pill (#tb-aperia, status-bar.js). Pattern: dtna-panel.js.
 *
 * Opening the panel only reads aperia.status(). Every other call runs from a
 * button: Sign in / Sign out, the Tire Alerts ON/OFF toggle, Check now (only
 * while alerts are on), and the Issues / Bulk buttons, which close the panel
 * and open their modal (which itself reads nothing but status() until Load /
 * Look up is pressed). Every action ends with a status() re-read and
 * deps.onChange(status) so the pill refreshes.
 */
import { aperiaPill, alertsLabel, alertsOn, fmtEt } from './aperia-pill-logic.js';

const OVERLAY_ID = 'aperia-panel-overlay';

const _aperia = () => (typeof window !== 'undefined' && window.aperia) || null;

function defaultDeps() {
  return {
    aperia: _aperia(),
    document: typeof document !== 'undefined' ? document : null,
    openIssues: () => import('../views/aperia-issues-modal.js').then((m) => m.openAperiaIssuesModal()),
    openBulk: () => import('../views/aperia-bulk-modal.js').then((m) => m.openAperiaBulkModal()),
    onChange: null,
  };
}

const MESSAGES = {
  APERIA_SIGNIN_REQUIRED: 'Sign in to Aperia first.',
  APERIA_SESSION_EXPIRED: 'Aperia session expired. Press Sign in.',
  APERIA_ALERTS_OFF: 'Tire Alerts are off.',
  APERIA_BUSY: 'An Aperia pull is already running.',
};
const _msgFor = (code) => MESSAGES[code] || ('Aperia request failed (' + String(code || 'unknown') + ')');

function _modeText(s) {
  if (!alertsOn(s)) return alertsLabel(s);
  if (s.alerts === 'ws') return alertsLabel(s) + ' (live)';
  const n = Number(s.minutes);
  return alertsLabel(s) + ' (polling' + (Number.isInteger(n) && n > 0 ? ' every ' + n + ' min' : '') + ')';
}

let _open = null; // { overlay, dispose }

export function isOpen() { return !!_open; }

export function close() {
  if (!_open) return;
  const o = _open;
  _open = null;
  o.dispose();
}

export function open(deps) {
  const d = Object.assign(defaultDeps(), deps || {});
  if (_open) return _open.overlay;
  const doc = d.document;
  if (!doc) return null;
  const ap = d.aperia || null;
  const overlay = doc.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'ai-config-overlay aperia-panel-overlay open';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'aperia-panel-title');
  overlay.innerHTML = `
    <div class="ai-config-panel dp-aperia-panel">
      <button type="button" class="ai-config-close" id="aperia-panel-close" title="Close" aria-label="Close">✕</button>
      <div class="sd-section">
        <div class="sd-section-title" id="aperia-panel-title">Aperia HALO Connect</div>
        <div id="aperia-panel-state" class="sd-status warn" style="margin-bottom:8px">${ap ? 'Aperia \u2026' : 'Aperia is not available in this build'}</div>
        <div class="sd-hint" style="margin-bottom:8px"><b id="aperia-panel-alerts-state">Tire Alerts: OFF</b></div>
        <div class="sd-hint" style="margin-bottom:8px">Last pull: <b id="aperia-panel-last">never</b></div>
        <div class="sd-hint" style="margin-bottom:8px">Aperia is read only when you press a button. Sign out stops a running pull and closes the Aperia sign-in window.</div>
        <div class="sd-hint" id="aperia-panel-alerts-note" style="margin-bottom:8px">Tire Alerts notify once per new alert, and once more each time an alert's severity goes up (for example MAJOR to CRITICAL).</div>
        <div class="sd-btn-row">
          <button type="button" class="sd-btn primary" id="aperia-panel-signin">Sign in</button>
          <button type="button" class="sd-btn secondary" id="aperia-panel-signout">Sign out</button>
        </div>
        <div class="sd-btn-row">
          <button type="button" class="sd-btn secondary" id="aperia-panel-alerts">Turn Tire Alerts ON</button>
          <button type="button" class="sd-btn secondary" id="aperia-panel-poll" disabled>Check now</button>
        </div>
        <div class="sd-btn-row">
          <button type="button" class="sd-btn secondary" id="aperia-panel-issues">Tire issues</button>
          <button type="button" class="sd-btn secondary" id="aperia-panel-bulk">Bulk / fleet tires</button>
        </div>
        <div id="aperia-panel-msg" class="sd-hint dp-aperia-msg"></div>
      </div>
    </div>`;
  doc.body.appendChild(overlay);

  const q = (sel) => overlay.querySelector(sel);
  const stateEl = q('#aperia-panel-state');
  const alertsEl = q('#aperia-panel-alerts-state');
  const lastEl = q('#aperia-panel-last');
  const msgEl = q('#aperia-panel-msg');
  const signinBtn = q('#aperia-panel-signin');
  const signoutBtn = q('#aperia-panel-signout');
  const toggleBtn = q('#aperia-panel-alerts');
  const pollBtn = q('#aperia-panel-poll');
  const issuesBtn = q('#aperia-panel-issues');
  const bulkBtn = q('#aperia-panel-bulk');
  let last = null;
  let busy = false;

  const setMsg = (t) => { if (msgEl) msgEl.textContent = t || ''; };
  const refreshButtons = () => {
    const on = alertsOn(last);
    if (toggleBtn) {
      toggleBtn.textContent = on ? 'Turn Tire Alerts OFF' : 'Turn Tire Alerts ON';
      toggleBtn.disabled = !ap || busy;
    }
    if (pollBtn) pollBtn.disabled = !ap || busy || !on;
    if (signinBtn) signinBtn.disabled = !ap || busy;
    if (signoutBtn) signoutBtn.disabled = !ap || busy;
    if (issuesBtn) issuesBtn.disabled = !ap;
    if (bulkBtn) bulkBtn.disabled = !ap;
  };
  const apply = (s) => {
    if (!_open || _open.overlay !== overlay) return;
    last = s || null;
    if (stateEl) {
      stateEl.textContent = aperiaPill(s).text;
      const st = s && s.state;
      stateEl.className = 'sd-status ' + (st === 'connected' ? 'ok' : st === 'expired' ? 'err' : 'warn');
    }
    if (alertsEl) alertsEl.textContent = _modeText(s);
    if (lastEl) lastEl.textContent = fmtEt(s && s.lastPullAt) || 'never';
    refreshButtons();
    try { if (typeof d.onChange === 'function') d.onChange(s); } catch (_) {}
  };
  const read = () => {
    if (!ap || typeof ap.status !== 'function') return Promise.resolve();
    return Promise.resolve().then(() => ap.status()).then(apply).catch(() => {});
  };
  // Run one user action: buttons disabled while it runs, then status() re-read.
  const act = (fn, onResult) => {
    if (!ap || busy) return Promise.resolve();
    busy = true;
    setMsg('');
    refreshButtons();
    return Promise.resolve().then(fn)
      .then((r) => { if (r && r.ok === false) setMsg(_msgFor(r.code)); else if (onResult) onResult(r); })
      .catch(() => setMsg(_msgFor('APERIA_INTERNAL')))
      .finally(() => { busy = false; refreshButtons(); return read(); });
  };

  if (signinBtn) signinBtn.addEventListener('click', () => {
    if (signinBtn.disabled) return;
    act(() => ap.login());
  });
  if (signoutBtn) signoutBtn.addEventListener('click', () => {
    if (signoutBtn.disabled) return;
    act(() => ap.logout());
  });
  if (toggleBtn) toggleBtn.addEventListener('click', () => {
    if (toggleBtn.disabled) return;
    if (alertsOn(last)) act(() => ap.stopAlerts());
    else act(() => ap.startAlerts({}));
  });
  if (pollBtn) pollBtn.addEventListener('click', () => {
    if (pollBtn.disabled) return;
    act(() => ap.pollNow(), (r) => {
      const n = r && Number(r.newCount);
      setMsg(Number.isFinite(n) ? (n === 1 ? '1 new tire issue.' : n + ' new tire issues.') : '');
    });
  });
  const launch = (fn) => {
    close();
    try { Promise.resolve(fn && fn()).catch(() => {}); } catch (_) {}
  };
  if (issuesBtn) issuesBtn.addEventListener('click', () => { if (!issuesBtn.disabled) launch(d.openIssues); });
  if (bulkBtn) bulkBtn.addEventListener('click', () => { if (!bulkBtn.disabled) launch(d.openBulk); });

  const onBackdrop = (e) => { if (e && e.target === overlay) close(); };
  const onKey = (e) => { if (e && e.key === 'Escape') close(); };
  const closeBtn = q('#aperia-panel-close');
  if (closeBtn) closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', onBackdrop);
  doc.addEventListener('keydown', onKey);

  let unsub = null;
  try { if (ap && typeof ap.onAlert === 'function') unsub = ap.onAlert(() => { read(); }); } catch (_) {}

  _open = {
    overlay,
    dispose: () => {
      try { if (typeof unsub === 'function') unsub(); } catch (_) {}
      try { doc.removeEventListener('keydown', onKey); } catch (_) {}
      try { overlay.remove(); } catch (_) {}
    },
  };
  refreshButtons();
  read();
  return overlay;
}
