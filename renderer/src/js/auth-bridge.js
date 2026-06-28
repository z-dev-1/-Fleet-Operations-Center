/**
 * auth-bridge.js — Module 5: Auth Status Bridge
 * Fleet Ops V-C, Stage 1
 *
 * Surfaces live auth state for three services into the UI:
 *   1. Midway   — auth:check-midway (P.midwayCookie exists)
 *   2. Slack    — slack:check-auth  (token present)
 *   3. Orcha AI — ai.test()         (relay health ping)
 *
 * UI touchpoints:
 *   A. Injects #auth-status-bar pill row into .topbar-right (before .live-ind)
 *   B. Updates .cp-st text in the Orcha AI chat panel header
 *   C. Listens on auth.onMwinitStatus for real-time mwinit progress toasts
 *   D. (S7) fleet:auth-failure -> amber mwinit prompt banner + OS notification
 *
 * Poll interval: every 5 minutes (300 000 ms).
 * First poll: 2 s after DOMContentLoaded (non-blocking startup).
 *
 * Capability flags (captured once at load time):
 *   HAS_AUTH   — window.auth.checkMidway available
 *   HAS_SLACK  — window.slack.checkAuth available
 *   HAS_AI_TEST — window.ai.test available
 *
 * Dev mode: if none of the above are available, the bar shows static
 * "(dev mode)" label and no polls fire.
 */

(function () {
  'use strict';

  /* ── 1. Capability detection ────────────────────────────────────────── */
  const HAS_AUTH    = !!(window.auth  && typeof window.auth.checkMidway  === 'function');
  const HAS_SLACK   = !!(window.slack && typeof window.slack.checkAuth   === 'function');
  const HAS_AI_TEST = !!(window.ai    && typeof window.ai.test           === 'function');
  const HAS_MWINIT  = !!(window.auth  && typeof window.auth.onMwinitStatus === 'function');

  const HAS_ANY = HAS_AUTH || HAS_SLACK || HAS_AI_TEST;

  /* ── 2. State ───────────────────────────────────────────────────────── */
  const _state = {
    midway:  null,   // true | false | null (unknown)
    slack:   null,
    orcha:   null,
    lastPoll: null,
  };

  /* ── 3. DOM helpers ─────────────────────────────────────────────────── */

  /** Return an existing pill by id, or create + insert it. */
  function getOrCreateBar() {
    let bar = document.getElementById('auth-status-bar');
    if (bar) return bar;

    bar = document.createElement('div');
    bar.id = 'auth-status-bar';
    bar.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:5px',
      'margin-right:8px',
    ].join(';');

    // Insert before .live-ind inside .topbar-right
    const topRight = document.querySelector('.topbar-right');
    if (topRight) {
      const liveInd = topRight.querySelector('.live-ind');
      topRight.insertBefore(bar, liveInd || topRight.firstChild);
    }
    return bar;
  }

  /** Create or update a single status pill. */
  function setPill(id, label, ok) {
    const bar = getOrCreateBar();
    let pill = document.getElementById('auth-pill-' + id);
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'auth-pill-' + id;
      pill.title = label;
      pill.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:3px',
        'padding:2px 7px',
        'border-radius:10px',
        'font-size:9px',
        'font-weight:700',
        'font-family:var(--mono)',
        'letter-spacing:.4px',
        'cursor:default',
        'transition:all .3s',
      ].join(';');
      bar.appendChild(pill);
    }

    if (ok === true) {
      pill.style.background  = 'rgba(63,185,80,.15)';
      pill.style.color       = 'var(--grn)';
      pill.style.border      = '1px solid rgba(63,185,80,.25)';
      pill.innerHTML = '&#9679; ' + label;
    } else if (ok === false) {
      pill.style.background  = 'rgba(248,81,73,.12)';
      pill.style.color       = 'var(--red)';
      pill.style.border      = '1px solid rgba(248,81,73,.25)';
      pill.innerHTML = '&#9675; ' + label;
    } else {
      // null = pending / unknown
      pill.style.background  = 'rgba(139,148,158,.1)';
      pill.style.color       = 'var(--mut)';
      pill.style.border      = '1px solid rgba(139,148,158,.2)';
      pill.innerHTML = '&#9472; ' + label;
    }
  }

  /** Update .cp-st in the Orcha chat panel header. */
  function updateChatStatus() {
    const el = document.querySelector('.cp-st');
    if (!el) return;

    if (!HAS_ANY) {
      el.textContent = 'Dev mode · No IPC';
      return;
    }

    const orchaOk   = _state.orcha;
    const midwayOk  = _state.midway;

    let text;
    if (orchaOk === true) {
      text = 'Online · Fleet context loaded';
    } else if (orchaOk === false) {
      text = midwayOk === false
        ? 'Offline · Midway expired — run mwinit'
        : 'Offline · Orcha unreachable';
    } else {
      text = 'Connecting...';
    }

    // Preserve the green dot (::before pseudo — just update text node)
    // .cp-st uses ::before for the dot, safe to set textContent
    el.textContent = text;
  }

  /* ── 4. Poll logic ──────────────────────────────────────────────────── */

  async function checkMidway() {
    if (!HAS_AUTH) return;
    try {
      const r = await window.auth.checkMidway();
      _state.midway = !!(r && r.ok);
    } catch (_) {
      _state.midway = false;
    }
    setPill('midway', 'MIDWAY', _state.midway);
  }

  async function checkSlack() {
    if (!HAS_SLACK) return;
    try {
      const r = await window.slack.checkAuth();
      _state.slack = !!(r && r.authenticated);
    } catch (_) {
      _state.slack = false;
    }
    setPill('slack', 'SLACK', _state.slack);
  }

  async function checkOrcha() {
    if (!HAS_AI_TEST) return;
    try {
      const r = await window.ai.test();
      _state.orcha = !!(r && r.ok);
    } catch (_) {
      _state.orcha = false;
    }
    setPill('orcha', 'ORCHA', _state.orcha);
    updateChatStatus();
  }

  async function pollAll() {
    _state.lastPoll = new Date().toISOString();
    // Parallel — failures are silenced inside each checker
    await Promise.all([checkMidway(), checkSlack(), checkOrcha()]);
  }

  /* ── 5. Dev-mode static bar ─────────────────────────────────────────── */
  function mountDevBar() {
    const bar = getOrCreateBar();
    const pill = document.createElement('div');
    pill.style.cssText = [
      'padding:2px 8px',
      'border-radius:10px',
      'font-size:9px',
      'font-weight:700',
      'font-family:var(--mono)',
      'background:rgba(139,148,158,.1)',
      'color:var(--mut)',
      'border:1px solid rgba(139,148,158,.2)',
    ].join(';');
    pill.textContent = 'DEV MODE';
    bar.appendChild(pill);
  }

  /* ── 6. mwinit live status listener ────────────────────────────────── */
  function registerMwinitListener() {
    if (!HAS_MWINIT) return;
    window.auth.onMwinitStatus(function (msg) {
      if (!msg) return;
      if (typeof window.toast !== 'function') return;
      if (msg === 'running') {
        window.toast('mwinit launched — complete auth in terminal', 'info', 'Midway Auth');
      } else if (msg === 'launched') {
        window.toast('mwinit complete — re-checking Midway...', 'success', 'Midway Auth');
        // Re-poll after a short delay to pick up the new cookie
        setTimeout(function () { checkMidway().catch(function () {}); }, 3000);
      } else if (typeof msg === 'string' && msg.startsWith('error:')) {
        window.toast('mwinit error: ' + msg.slice(6), 'error', 'Midway Auth');
      }
    });
  }

    /* ── 7. fleet:auth-failure -> mwinit prompt (Stage 7) ─────────────────── */

  /**
   * Inject (or replace) a fixed amber banner at top of viewport.
   * Includes a "Run mwinit" button that calls window.auth.runMwinit().
   * Dismiss (x) always available. Banner auto-dismisses after mwinit completes.
   */
  function _showMwinitPrompt(code) {
    var existing = document.getElementById('mwinit-prompt-bar');
    if (existing) existing.remove();

    var bar = document.createElement('div');
    bar.id = 'mwinit-prompt-bar';
    bar.setAttribute('data-code', code || '');
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
      'background:#b45309', 'color:#fff',
      'padding:8px 16px', 'font-size:13px',
      'display:flex', 'align-items:center', 'gap:10px',
      'box-shadow:0 2px 6px rgba(0,0,0,.4)',
    ].join(';');
    bar.innerHTML = [
      '<span id="mwinit-prompt-msg">',
        'Midway session expired — run ',
        '<code style="background:rgba(255,255,255,.15);padding:1px 5px;border-radius:3px;">',
          'mwinit',
        '</code>',
        ' to re-authenticate',
      '</span>',
      '<button id="mwinit-prompt-btn" style="',
        'background:#fff;color:#b45309;border:none;border-radius:4px;',
        'padding:3px 10px;cursor:pointer;font-size:12px;font-weight:600;',
        'white-space:nowrap;flex-shrink:0;">Run mwinit</button>',
      '<button id="mwinit-prompt-dismiss" style="',
        'background:transparent;color:#fff;border:none;font-size:18px;',
        'cursor:pointer;margin-left:auto;line-height:1;padding:0 4px;opacity:.8;">',
        '×</button>',
    ].join('');

    document.body.prepend(bar);

    document.getElementById('mwinit-prompt-btn').addEventListener('click', function () {
      var msgEl = document.getElementById('mwinit-prompt-msg');
      var btnEl = document.getElementById('mwinit-prompt-btn');
      if (msgEl) msgEl.textContent =
        'Launching mwinit — complete authentication in the terminal window…';
      if (btnEl) { btnEl.disabled = true; btnEl.style.opacity = '.5'; }
      if (window.auth && typeof window.auth.runMwinit === 'function') {
        window.auth.runMwinit().catch(function () {});
      }
    });

    document.getElementById('mwinit-prompt-dismiss').addEventListener('click', function () {
      var b = document.getElementById('mwinit-prompt-bar');
      if (b) b.remove();
    });
  }

  /**
   * Update the banner message based on mwinit progress events.
   * Called by the auth:mwinit-status subscription below and the existing
   * registerMwinitListener handler.
   */
  function _updateMwinitPrompt(status) {
    var msgEl = document.getElementById('mwinit-prompt-msg');
    if (!msgEl) return;
    if (status === 'launched') {
      msgEl.textContent = 'mwinit launched — complete auth in terminal, then click Sync Now';
      setTimeout(function () {
        var b = document.getElementById('mwinit-prompt-bar');
        if (b) b.remove();
      }, 15000);
    } else if (status === 'complete') {
      msgEl.textContent = 'mwinit complete — click Sync Now to retry';
      setTimeout(function () {
        var b = document.getElementById('mwinit-prompt-bar');
        if (b) b.remove();
      }, 8000);
    } else if (typeof status === 'string' && status.startsWith('error:')) {
      msgEl.textContent = 'mwinit failed to launch: ' + status.slice(6);
    }
  }

  /**
   * Wire fleet:auth-failure via window.__fleet_bus (exposed by bridge.js init()).
   * Falls back gracefully if bus not yet set -- defers to DOMContentLoaded.
   */
  function registerAuthFailureHandler() {
    function _attach(bus) {
      bus.on('fleet:auth-failure', function (payload) {
        _showMwinitPrompt(payload && payload.code);
        if (window.app && typeof window.app.notify === 'function') {
          window.app.notify(
            'Fleet: Midway session expired',
            'Run mwinit to re-authenticate, then click Sync Now'
          ).catch(function () {});
        }
      });
      // Update prompt banner on mwinit progress events
      bus.on('auth:mwinit-status', function (msg) {
        _updateMwinitPrompt(typeof msg === 'string' ? msg : (msg && msg.status));
      });
    }

    if (window.__fleet_bus) {
      _attach(window.__fleet_bus);
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        if (window.__fleet_bus) _attach(window.__fleet_bus);
      });
    }
  }

/* ── 8. Boot ─────────────────────────────────────────────────────────── */
  function boot() {
    if (!HAS_ANY) {
      mountDevBar();
      updateChatStatus();
      console.log('[auth-bridge] loaded — dev mode (no IPC available)');
      return;
    }

    // Mount pending pills immediately so the bar appears right away
    if (HAS_AUTH)    setPill('midway', 'MIDWAY', null);
    if (HAS_SLACK)   setPill('slack',  'SLACK',  null);
    if (HAS_AI_TEST) setPill('orcha',  'ORCHA',  null);

    registerMwinitListener();
    registerAuthFailureHandler();

    // First poll: slight delay so app is fully rendered
    setTimeout(function () {
      pollAll().catch(function (e) {
        console.warn('[auth-bridge] Initial poll error:', e);
      });
    }, 2000);

    // Recurring poll every 5 minutes
    setInterval(function () {
      pollAll().catch(function () {});
    }, 300000);

    console.log('[auth-bridge] loaded — IPC mode (midway=' + HAS_AUTH +
      ' slack=' + HAS_SLACK + ' orcha=' + HAS_AI_TEST + ')');
  }

  /* ── 9. Debug handle ─────────────────────────────────────────────────── */
  window._authBridge = {
    version:            '2.0.0',
    HAS_AUTH:            HAS_AUTH,
    HAS_SLACK:           HAS_SLACK,
    HAS_AI_TEST:         HAS_AI_TEST,
    state:               _state,
    pollNow:             function () { return pollAll(); },
    checkMidway:         checkMidway,
    checkSlack:          checkSlack,
    checkOrcha:          checkOrcha,
    // S7: test helpers
    showMwinitPrompt:    _showMwinitPrompt,
    updateMwinitPrompt:  _updateMwinitPrompt,
  };

  /* ── 10. Start ────────────────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
