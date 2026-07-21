'use strict';
/**
 * action_capture.js — External-site workflow capture [Phase 8, Phase 1.4]
 *
 * Generalizes two techniques already proven elsewhere in this codebase:
 *   - Navigation capture via native `did-navigate` / `did-navigate-in-page`
 *     Electron events -- the exact pattern already used for post-Midway AAP
 *     scrape detection (see src/window/index.js commit history) and for
 *     WR-URL capture (src/window/wr_capture.js's pushState interception).
 *   - Click/input capture via `executeJavaScript` DOM injection with a
 *     resilient multi-strategy selector -- the same fallback family as
 *     src/scrapers/aap_autofill_engine.js (id -> data-* -> class+nth-of-type).
 *
 * Attached ONLY when a recording session is active (see
 * getActiveSessionId() in src/ipc/workflow-intel.js) -- called from the
 * `open-popup` handler in src/ipc/orcha.js, the same window every external
 * site (Relay, AAP, Slack, Outlook, SharePoint) already opens through, so
 * this piggybacks the existing POPUP_ALLOWED_HOSTS-gated window rather than
 * creating a new window type.
 *
 * Zero execution risk: this module only OBSERVES (reads DOM events). It
 * never calls click()/fill()/navigate() -- that is playwright_bridge.js's
 * job in Phase 4, which this module has no relationship to.
 *
 * See docs/PHASE8_WORKFLOW_INTELLIGENCE_PLAN.md §3.1(B) for the full design.
 */

const logger = require('../utils/logger')('window:action-capture');

const POLL_INTERVAL_MS = 1200;

// Rough hostname -> app-name mapping for step tagging. Deliberately loose --
// falls back to 'external' for anything unrecognized rather than throwing.
const APP_HOST_MAP = [
  { match: 'relay.amazon',      app: 'relay' },
  { match: 'aap-na.corp.amazon', app: 'aap' },
  { match: 'aap.amazon',        app: 'aap' },
  { match: 'enterprise.slack.com', app: 'slack' },
  { match: 'outlook.office',    app: 'outlook' },
  { match: 'sharepoint.com',    app: 'sharepoint' },
  { match: 'issues.amazon.com', app: 'asist' },
];

function _appNameFor(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const hit = APP_HOST_MAP.find(m => host.includes(m.match));
    return hit ? hit.app : 'external';
  } catch (_) {
    return 'external';
  }
}

// -- The DOM-side capture bootstrap, injected via executeJavaScript -----------
// Idempotent: repeated injection (SPA re-renders trigger did-finish-load more
// than once) is guarded by window.__wiCaptureInstalled.
const CAPTURE_BOOTSTRAP = `
(function() {
  if (window.__wiCaptureInstalled) return;
  window.__wiCaptureInstalled = true;
  window.__wiCapturedEvents = window.__wiCapturedEvents || [];

  function selectorFor(el) {
    if (!el || el === document || el === document.body) return 'body';
    if (el.id) return '#' + el.id;
    if (el.dataset) {
      var keys = Object.keys(el.dataset);
      if (keys.length) return '[data-' + keys[0] + '="' + el.dataset[keys[0]] + '"]';
    }
    var tag = el.tagName ? el.tagName.toLowerCase() : 'div';
    var cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
      : '';
    var nth = '';
    if (el.parentElement) {
      var sibs = Array.prototype.filter.call(el.parentElement.children, function(c) { return c.tagName === el.tagName; });
      if (sibs.length > 1) nth = ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')';
    }
    return tag + cls + nth;
  }

  function isSensitive(el) {
    if (!el) return false;
    if ((el.type || '').toLowerCase() === 'password') return true;
    var name = ((el.name || '') + ' ' + (el.id || '')).toLowerCase();
    return name.indexOf('password') > -1 || name.indexOf('secret') > -1 || name.indexOf('token') > -1;
  }

  function labelFor(el) {
    return ((el && (el.getAttribute('aria-label') || el.title || el.textContent || '')) || '').trim().slice(0, 60);
  }

  function push(step) {
    step.ts = new Date().toISOString();
    window.__wiCapturedEvents.push(step);
    if (window.__wiCapturedEvents.length > 500) window.__wiCapturedEvents.splice(0, window.__wiCapturedEvents.length - 500);
  }

  document.addEventListener('click', function(e) {
    var el = e.target && e.target.closest ? (e.target.closest('button, a, [role="button"], input[type="checkbox"], input[type="radio"], td, tr, li') || e.target) : e.target;
    if (!el || (el.tagName || '').toLowerCase() === 'select') return;
    push({ type: 'click', selector: selectorFor(el), label: labelFor(el) });
  }, true);

  document.addEventListener('change', function(e) {
    var el = e.target;
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'select') {
      push({ type: 'select', selector: selectorFor(el), value: el.value, label: labelFor(el) });
    } else if (tag === 'input' || tag === 'textarea') {
      var sensitive = isSensitive(el);
      push({ type: 'type', selector: selectorFor(el), value: sensitive ? undefined : el.value, sensitive: sensitive, fieldType: (el.type || 'text').toLowerCase(), label: labelFor(el) });
    }
  }, true);
})();
true;
`;

const DRAIN_SCRIPT = `
(function() {
  if (!window.__wiCapturedEvents) return '[]';
  var out = window.__wiCapturedEvents.splice(0, window.__wiCapturedEvents.length);
  return JSON.stringify(out);
})();
`;

/**
 * attachCapture(win, sessionId) -- wires navigation + DOM capture for the
 * lifetime of the given BrowserWindow, forwarding every captured event into
 * the given recording session via recordStepFromMain.
 *
 * @param {BrowserWindow} win
 * @param {string} sessionId
 */
function attachCapture(win, sessionId) {
  const { recordStepFromMain } = require('../ipc/workflow-intel');
  let pollTimer = null;
  let destroyed = false;

  function safeUrl() {
    try { return win.webContents.getURL(); } catch (_) { return ''; }
  }

  function record(step) {
    if (destroyed) return;
    try {
      recordStepFromMain(sessionId, { app: _appNameFor(safeUrl()), ...step });
    } catch (e) {
      logger.warn('record step failed (session likely ended):', e.message);
      _stop();
    }
  }

  async function _inject() {
    if (destroyed) return;
    try {
      await win.webContents.executeJavaScript(CAPTURE_BOOTSTRAP);
    } catch (e) {
      logger.warn('capture bootstrap injection failed:', e.message);
    }
  }

  async function _drain() {
    if (destroyed) return;
    try {
      const raw = await win.webContents.executeJavaScript(DRAIN_SCRIPT);
      const events = JSON.parse(raw || '[]');
      events.forEach(record);
    } catch (e) {
      // Page mid-navigation or window closing -- non-fatal, next poll retries.
    }
  }

  function _stop() {
    if (destroyed) return;
    destroyed = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    logger.info('Capture detached for session ' + sessionId);
  }

  win.webContents.on('did-finish-load', _inject);
  win.webContents.on('did-navigate', (_e, url) => record({ type: 'navigate', selector: 'url:' + url, value: url, label: 'Navigated' }));
  win.webContents.on('did-navigate-in-page', (_e, url) => record({ type: 'navigate', selector: 'url:' + url, value: url, label: 'Route changed' }));

  pollTimer = setInterval(_drain, POLL_INTERVAL_MS);
  win.once('closed', _stop);

  // Cover the case where the window is already loaded before attachCapture runs.
  _inject();

  logger.info('Capture attached for session ' + sessionId + ' on ' + safeUrl());
  return { detach: _stop };
}

module.exports = { attachCapture };
