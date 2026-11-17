/**
 * auth-health-panel.js — Midway / AAP Auth Health panel (moved out of
 * Settings -> Integrations). Opened as a focused overlay from the bottom
 * status bar auth pill (#tb-auth, status-bar.js).
 *
 * Renders the single Midway/AAP self-healing supervisor's live state. Health is
 * defined by a VERIFIED authenticated call to the real AAP target — not VPN,
 * not cookie existence. The panel is read-only except for three actions:
 * Refresh (re-read snapshot), Retry now (silent convergence), Run mwinit
 * (interactive escalation). Opening the panel only reads health (healthGet);
 * mwinit runs ONLY from an explicit Run mwinit button click.
 */
import bus from '../bus.js';
import { auth as authBridge } from '../bridge.js';

const OVERLAY_ID = 'auth-health-overlay';

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

function _fmtMin(m) {
  if (typeof m !== 'number' || !isFinite(m)) return '—';
  if (m <= 0) return 'expired';
  if (m < 60) return Math.round(m) + ' min';
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  return r ? `${h}h ${r}m` : `${h}h`;
}

function _authHealthStateClass(state) {
  switch (state) {
    case 'HEALTHY':          return 'ok';
    case 'DEGRADED':
    case 'RECOVERING':
    case 'COOLDOWN':
    case 'UNKNOWN':          return 'warn';
    case 'WAITING_FOR_USER':
    case 'OFFLINE':
    case 'FAILED':           return 'err';
    default:                 return 'warn';
  }
}

function _authHealthLabel(state) {
  const map = {
    HEALTHY:          '\u2705 Healthy — AAP target verified',
    DEGRADED:         '\u26A0\uFE0F Degraded — auto-recovery armed',
    RECOVERING:       '\u231B Recovering…',
    COOLDOWN:         '\u23F3 Cooldown — waiting before next retry',
    WAITING_FOR_USER: '\uD83D\uDD11 Waiting for you — run mwinit (PIN + YubiKey)',
    OFFLINE:          '\uD83D\uDCF6 Offline — will re-verify on reconnect',
    FAILED:           '\u274C Failed — manual mwinit required',
    UNKNOWN:          '\u2139\uFE0F Not checked yet',
  };
  return map[state] || ('\u2139\uFE0F ' + (state || 'Unknown'));
}

/** The Auth Health section markup (same ids the Settings section used). */
export function panelHtml() {
  return `
        <div class="sd-section" id="sect-auth-health">
          <div class="sd-section-title" id="auth-health-title">Midway / AAP Auth Health</div>
          <div id="auth-health-state" class="sd-status warn" style="margin-bottom:8px">\u2139\uFE0F Not checked yet</div>
          <div id="auth-health-grid" class="sd-hint" style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin-bottom:8px"></div>
          <div class="sd-hint" style="margin-bottom:8px">VPN is <b>not required</b> for Midway/AAP auth. Health is verified by a real authenticated call to the AAP target.</div>
          <div class="sd-btn-row">
            <button class="sd-btn secondary" id="auth-health-refresh">Refresh</button>
            <button class="sd-btn primary"   id="auth-health-retry">Retry now</button>
            <button class="sd-btn secondary" id="auth-health-mwinit">Run mwinit</button>
          </div>
          <div id="auth-health-history" class="sd-hint" style="margin-top:10px"></div>
        </div>`;
}

export function renderAuthHealth(root, res) {
  if (!root) return;
  const stateEl = root.querySelector('#auth-health-state');
  const gridEl  = root.querySelector('#auth-health-grid');
  const histEl  = root.querySelector('#auth-health-history');

  if (!stateEl || !gridEl) return;

  if (!res || !res.ok) {
    stateEl.className = 'sd-status err';
    stateEl.textContent = '\u274C Auth supervisor unavailable' + (res && res.error ? ' (' + res.error + ')' : '');
    gridEl.innerHTML = '';
    if (histEl) histEl.innerHTML = '';
    return;
  }

  const state = res.state || (res.snapshot && res.snapshot.state) || 'UNKNOWN';
  stateEl.className = 'sd-status ' + _authHealthStateClass(state);
  stateEl.textContent = _authHealthLabel(state);

  const s = res.snapshot || {};
  const smoke = s.aapApiSmokeTest || null;
  const verified = !!(smoke && smoke.ok);
  const rows = [
    ['AAP target verified', verified ? 'yes' : 'no' + (smoke && smoke.class ? ' (' + smoke.class + ')' : '')],
    ['Internet', s.internet && s.internet.online ? 'online' : 'offline'],
    ['VPN', (s.vpn && s.vpn.connected === true ? 'connected' : s.vpn && s.vpn.connected === false ? 'not connected' : 'unknown') + ' — not required'],
    ['Midway session', s.diskSession ? _fmtMin(s.diskSession.expiresInMin) + ' left' : '—'],
    ['AEA cookie', s.diskAea ? _fmtMin(s.diskAea.expiresInMin) + ' left' : '—'],
    ['Next auto-retry', s.nextRetryAt ? new Date(s.nextRetryAt).toLocaleTimeString() : '—'],
    ['Checked', s.at ? new Date(s.at).toLocaleTimeString() : '—'],
  ];
  // auth.propagation: res.status is present only with the flag on.
  const st = (res.status && typeof res.status === 'object') ? res.status : null;
  if (st) {
    const ev = st.evidence || {};
    const _t = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '—');
    const _left = (m) => (typeof m === 'number' && isFinite(m) ? _fmtMin(m) + ' left' : '—');
    const aeaIdx = rows.findIndex((r) => r[0] === 'AEA cookie');
    rows.splice(aeaIdx, 1,
      ['AEA (live)', _left(ev.liveAeaMin)],
      ['AEA (disk)', _left(typeof ev.diskAeaMin === 'number' ? ev.diskAeaMin : (s.diskAea && s.diskAea.expiresInMin))]);
    rows.unshift(
      ['Status', _esc(st.message || st.state || '—')],
      ['Verified', st.verifiedAt ? _esc(_t(st.verifiedAt) + (st.verifiedBy ? ' (' + st.verifiedBy + ')' : '')) : '—']);
    rows.push(['Last AAP call', 'ok ' + _esc(_t(st.lastApiOkAt)) + ' · fail ' + _esc(_t(st.lastApiFailAt))]);
    // F9: after a completed full sign-in (action 'wait' + stepUp) show the
    // message only and do not emphasise Run mwinit; emphasise it only when
    // the status actually asks for mwinit.
    const stepUpWait = st.action === 'wait' && st.stepUp === true;
    if (stepUpWait) stateEl.textContent = '\u23F3 ' + String(st.message || '');
    const mwBtn = root.querySelector('#auth-health-mwinit');
    if (mwBtn) {
      const emph = st.action === 'mwinit';
      mwBtn.classList.toggle('primary', emph);
      mwBtn.classList.toggle('secondary', !emph);
    }
  }
  gridEl.innerHTML = rows.map(([k, v]) =>
    `<div style="opacity:.75">${k}</div><div><b>${v}</b></div>`
  ).join('');

  if (histEl) {
    const hist = Array.isArray(res.history) ? res.history.slice(-5).reverse() : [];
    if (!hist.length) { histEl.innerHTML = ''; }
    else {
      histEl.innerHTML = '<div style="opacity:.75;margin-bottom:4px">Recent recovery attempts</div>' +
        hist.map((h) => {
          const when = h.at ? new Date(h.at).toLocaleTimeString() : '';
          const outcome = h.result || (h.recovered ? 'recovered' : 'failed');
          const note = h.note || h.reason || '';
          return `<div style="font-size:11px;opacity:.85">• ${when} — ${outcome}${note ? ' (' + note + ')' : ''}</div>`;
        }).join('');
    }
  }
}

function defaultDeps() {
  return {
    healthGet: authBridge.healthGet,
    healthRetry: authBridge.healthRetry,
    healthRunMwinit: authBridge.healthRunMwinit,
    on: (ev, fn) => bus.on(ev, fn),
    document: typeof document !== 'undefined' ? document : null,
  };
}

export function loadAuthHealth(root, deps = defaultDeps()) {
  if (!deps.healthGet) return Promise.resolve();
  const stateEl = root && root.querySelector('#auth-health-state');
  if (stateEl) { stateEl.className = 'sd-status warn'; stateEl.textContent = '\u231B Checking…'; }
  return Promise.resolve().then(() => deps.healthGet()).then((r) => renderAuthHealth(root, r)).catch((e) => {
    renderAuthHealth(root, { ok: false, error: e && e.message });
  });
}

/**
 * Wire the Refresh / Retry now / Run mwinit buttons inside `root` and
 * subscribe to auth:mwinit-status. Loads health once (never runs mwinit).
 * Returns a dispose function that drops the bus subscription.
 */
export function wireAuthHealth(root, deps = defaultDeps()) {
  const refreshBtn = root && root.querySelector('#auth-health-refresh');
  const retryBtn   = root && root.querySelector('#auth-health-retry');
  const mwinitBtn  = root && root.querySelector('#auth-health-mwinit');

  if (!refreshBtn) return () => {}; // section not present
  const load = () => loadAuthHealth(root, deps);

  refreshBtn.addEventListener('click', load);

  if (retryBtn) retryBtn.addEventListener('click', () => {
    if (!deps.healthRetry) return;
    retryBtn.disabled = true;
    const orig = retryBtn.textContent;
    retryBtn.textContent = 'Retrying…';
    Promise.resolve().then(() => deps.healthRetry()).then((r) => renderAuthHealth(root, r && r.snapshot ? { ok: true, state: r.state, snapshot: r.snapshot, history: [] } : null) || load())
      .catch(() => {})
      .finally(() => { retryBtn.disabled = false; retryBtn.textContent = orig; load(); });
  });

  // The ONLY place this panel starts mwinit: an explicit Run mwinit click.
  if (mwinitBtn) mwinitBtn.addEventListener('click', () => {
    if (!deps.healthRunMwinit) return;
    mwinitBtn.disabled = true;
    const orig = mwinitBtn.textContent;
    mwinitBtn.textContent = 'Running mwinit…';
    Promise.resolve().then(() => deps.healthRunMwinit()).catch(() => {})
      .finally(() => { mwinitBtn.disabled = false; mwinitBtn.textContent = orig; load(); });
  });

  // Live update when the supervisor pushes an mwinit status change.
  let unsub = null;
  try { unsub = deps.on ? deps.on('auth:mwinit-status', () => load()) : null; } catch (_) {}
  load();
  return () => { try { if (typeof unsub === 'function') unsub(); } catch (_) {} };
}

// ── Overlay (opened from the status bar auth pill) ──────────────────────────
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
  const overlay = doc.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'ai-config-overlay auth-health-overlay open';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'auth-health-title');
  overlay.innerHTML = `
    <div class="ai-config-panel auth-health-panel">
      <button type="button" class="ai-config-close" id="auth-health-close" title="Close" aria-label="Close">✕</button>
      ${panelHtml()}
    </div>`;
  doc.body.appendChild(overlay);

  const onBackdrop = (e) => { if (e && e.target === overlay) close(); };
  const onKey = (e) => { if (e && e.key === 'Escape') close(); };
  const closeBtn = overlay.querySelector('#auth-health-close');
  if (closeBtn) closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', onBackdrop);
  doc.addEventListener('keydown', onKey);
  const unwire = wireAuthHealth(overlay, deps);

  _open = {
    overlay,
    dispose: () => {
      unwire();
      try { doc.removeEventListener('keydown', onKey); } catch (_) {}
      try { overlay.remove(); } catch (_) {}
    },
  };
  return overlay;
}
