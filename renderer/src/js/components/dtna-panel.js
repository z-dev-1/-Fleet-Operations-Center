/**
 * dtna-panel.js — DTNA Service Tracker panel, opened from the bottom status
 * bar DTNA pill (#tb-dtna, status-bar.js). Pattern: auth-health-panel.js.
 *
 * Opening the panel reads dtna.status() and the session time once
 * (dtna.sessionTime, also on "Check session"). Sign in runs only from the
 * Sign in button; "Pull open cases" closes the panel and opens the DTNA Pull
 * bulk modal (which itself starts nothing until Start is pressed).
 */
import { dtnaPill, fmtExpiresIn } from './status-bar-logic.js';

const OVERLAY_ID = 'dtna-panel-overlay';

const _dtna = () => (typeof window !== 'undefined' && window.dtna) || null;

function defaultDeps() {
  return {
    dtna: _dtna(),
    document: typeof document !== 'undefined' ? document : null,
    openBulk: () => import('../views/dtna-bulk-modal.js').then((m) => m.openDtnaBulkModal()),
  };
}

function _lastText(s) {
  const at = s && s.lastPullAt;
  if (!at) return 'never';
  const d = new Date(at);
  return isNaN(d.getTime()) ? 'never' : d.toLocaleString();
}

let _open = null; // { overlay, dispose }

export function isOpen() { return !!_open; }

export function close() {
  if (!_open) return;
  const o = _open;
  _open = null;
  o.dispose();
}

export function open(deps = defaultDeps()) {
  if (_open) return _open.overlay;
  const doc = deps.document;
  if (!doc) return null;
  const dt = deps.dtna || null;
  const overlay = doc.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'ai-config-overlay dtna-panel-overlay open';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'dtna-panel-title');
  overlay.innerHTML = `
    <div class="ai-config-panel dtna-panel">
      <button type="button" class="ai-config-close" id="dtna-panel-close" title="Close" aria-label="Close">✕</button>
      <div class="sd-section">
        <div class="sd-section-title" id="dtna-panel-title">DTNA Service Tracker</div>
        <div id="dtna-panel-state" class="sd-status warn" style="margin-bottom:8px">${dt ? 'DTNA \u2026' : 'DTNA is not available in this build'}</div>
        <div class="sd-hint" style="margin-bottom:8px">Last pull: <b id="dtna-panel-last">never</b></div>
        <div class="sd-hint" style="margin-bottom:8px">Session: <b id="dtna-panel-session">not checked</b></div>
        <div class="sd-hint" style="margin-bottom:8px">DTNA is read only when you press a button here, on a unit, or in DTNA Pull.</div>
        <div class="sd-btn-row">
          <button type="button" class="sd-btn primary" id="dtna-panel-signin">Sign in</button>
          <button type="button" class="sd-btn secondary" id="dtna-panel-pull">Pull open cases</button>
          <button type="button" class="sd-btn secondary" id="dtna-panel-check">Check session</button>
        </div>
      </div>
    </div>`;
  doc.body.appendChild(overlay);

  const stateEl = overlay.querySelector('#dtna-panel-state');
  const lastEl = overlay.querySelector('#dtna-panel-last');
  const signinBtn = overlay.querySelector('#dtna-panel-signin');
  const pullBtn = overlay.querySelector('#dtna-panel-pull');
  const apply = (s) => {
    if (!_open || _open.overlay !== overlay) return;
    if (stateEl) {
      const p = dtnaPill(s);
      stateEl.textContent = p.text;
      const st = s && s.state;
      stateEl.className = 'sd-status ' + (st === 'connected' || st === 'pulling' ? 'ok' : st === 'expired' ? 'err' : 'warn');
    }
    if (lastEl) lastEl.textContent = _lastText(s);
  };
  const read = () => {
    if (!dt || typeof dt.status !== 'function') return Promise.resolve();
    return Promise.resolve().then(() => dt.status()).then(apply).catch(() => {});
  };
  // Session time: one servlet read per panel open / Check session click. The new state reaches the
  // pill and this panel through the pushed dtna:status-changed (onStatus), so status() is not re-read.
  const sessionEl = overlay.querySelector('#dtna-panel-session');
  const checkBtn = overlay.querySelector('#dtna-panel-check');
  const checkSession = () => {
    if (!dt || typeof dt.sessionTime !== 'function') return Promise.resolve();
    return Promise.resolve().then(() => dt.sessionTime()).then((r) => {
      if (!_open || _open.overlay !== overlay || !sessionEl) return;
      if (r && r.ok && !r.expired && Number(r.remainingSec) > 0) sessionEl.textContent = 'expires in ' + fmtExpiresIn(r.remainingSec);
      else if (r && r.ok) sessionEl.textContent = 'expired \u2014 sign in again';
      else sessionEl.textContent = 'could not check (' + String((r && r.code) || 'unknown') + ')';
    }).catch(() => { if (sessionEl) sessionEl.textContent = 'could not check (unknown)'; });
  };

  if (!dt) {
    if (signinBtn) signinBtn.disabled = true;
    if (pullBtn) pullBtn.disabled = true;
  }
  if (checkBtn) {
    if (!dt || typeof dt.sessionTime !== 'function') checkBtn.disabled = true;
    checkBtn.addEventListener('click', () => { if (!checkBtn.disabled) checkSession(); });
  }
  if (signinBtn) signinBtn.addEventListener('click', () => {
    if (!dt || typeof dt.login !== 'function' || signinBtn.disabled) return;
    signinBtn.disabled = true;
    Promise.resolve().then(() => dt.login()).catch(() => {})
      .finally(() => { signinBtn.disabled = false; return read(); });
  });
  if (pullBtn) pullBtn.addEventListener('click', () => {
    close();
    try {
      Promise.resolve(deps.openBulk && deps.openBulk()).catch(() => {});
    } catch (_) {}
  });

  const onBackdrop = (e) => { if (e && e.target === overlay) close(); };
  const onKey = (e) => { if (e && e.key === 'Escape') close(); };
  const closeBtn = overlay.querySelector('#dtna-panel-close');
  if (closeBtn) closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', onBackdrop);
  doc.addEventListener('keydown', onKey);

  let unsub = null;
  try { if (dt && typeof dt.onStatus === 'function') unsub = dt.onStatus(apply); } catch (_) {}

  _open = {
    overlay,
    dispose: () => {
      try { if (typeof unsub === 'function') unsub(); } catch (_) {}
      try { doc.removeEventListener('keydown', onKey); } catch (_) {}
      try { overlay.remove(); } catch (_) {}
    },
  };
  read().then(() => checkSession());
  return overlay;
}
