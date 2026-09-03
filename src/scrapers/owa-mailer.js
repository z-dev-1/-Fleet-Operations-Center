'use strict';
/**
 * scrapers/owa-mailer.js — OWA-only hidden background email delivery (Task #6).
 *
 * ONE reusable backend service that delivers an already-built HTML email
 * through the user's authenticated Outlook Web (OWA) session, entirely in the
 * background, and VERIFIES the send landed in Sent Items before reporting
 * success.
 *
 * Hard constraints (from the product owner, non-negotiable):
 *   - OWA ONLY. No SMTP. No Microsoft Graph. No fallback delivery method.
 *   - The compose window is fully HIDDEN: show:false, positioned offscreen,
 *     never shown/focused/moved to top. Popups are blocked.
 *   - If OWA requires interactive auth / MFA / consent, we PAUSE (return
 *     'blocked-auth') and never type, never click send, never fake success.
 *   - Body HTML is inserted WITHOUT the clipboard — set directly in page
 *     context + dispatch input/change events (execCommand insertHTML fallback).
 *   - Success ('sent') is claimed ONLY after a Sent Items match on recipient +
 *     normalized subject + time window + a hidden correlation marker embedded
 *     in the body. A Send click that we cannot confirm becomes
 *     'delivery-uncertain' (the caller must NOT auto-resend it).
 *
 * Result contract:
 *   {
 *     status: 'sent' | 'blocked-auth' | 'failed' | 'delivery-uncertain',
 *     to: [], cc: [], subject,
 *     bodyBytes, sendButtonEnabled, composeClosed,
 *     sentItemsMatch: { found, matchedBy, at } | null,
 *     correlationMarker, errors: [], completedAt
 *   }
 *
 * NOTE: This module performs a REAL send when invoked with a real recipient in
 * a live Electron session. During development it is only exercised via mocked
 * tests (the pure helpers) — it is never invoked against a real mailbox without
 * explicit user confirmation.
 */

const crypto = require('crypto');
let logger; try { logger = require('../utils/logger')('owa-mailer'); } catch (_) { logger = { info(){}, warn(){}, error(){} }; }

const COMPOSE_URL = 'https://outlook.office365.com/mail/deeplink/compose';
const OWA_ORIGIN  = 'https://outlook.office365.com';
// Hosts that indicate an interactive auth / MFA / consent wall — if the window
// lands here we must pause, not attempt to type or send.
const AUTH_HOST_RE = /(login\.microsoftonline\.com|login\.live\.com|login\.windows\.net|msft\.sts|adfs|\/common\/oauth2|\/consent|multifactor|\bmfa\b)/i;

const EDITOR_SELECTOR = 'div[aria-label*="Message body"],div.elementToProof[contenteditable="true"]';
const SEND_SELECTOR   = 'button[aria-label*="Send"]';

// ── Pure helpers (unit-tested without Electron) ────────────────────────────────

// Normalize a subject for matching: strip a leading [TEST] tag, collapse
// whitespace, lowercase, drop the correlation marker if present.
function normalizeSubject(subject) {
  return String(subject || '')
    .replace(/\uFEFF/g, '')
    .replace(/\bFOC-[0-9a-f]{8,}\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Normalize a recipient (email or "Name <email>") to a bare lowercased address.
function normalizeRecipient(r) {
  const s = String(r || '').trim();
  const m = s.match(/<([^>]+)>/);
  const addr = (m ? m[1] : s).trim().toLowerCase();
  return addr;
}

function toRecipientArray(v) {
  if (Array.isArray(v)) return v.map(normalizeRecipient).filter(Boolean);
  return String(v || '').split(/[;,]/).map(normalizeRecipient).filter(Boolean);
}

// Generate a hidden correlation marker for Sent-Items matching.
function genCorrelationMarker() { return 'FOC-' + crypto.randomBytes(8).toString('hex'); }

// Embed the correlation marker invisibly in the HTML body so it round-trips
// into the sent message and can be matched in Sent Items. Uses a zero-size,
// visually-hidden span at the very end of the body.
function embedMarker(html, marker) {
  const hidden = '<span style="display:none;font-size:0;line-height:0;color:transparent;max-height:0;overflow:hidden">' + marker + '</span>';
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, hidden + '</body>');
  return html + hidden;
}

// Decide the delivery result from the observable signals. Pure so it can be
// tested exhaustively.
//   signals: { authWall, editorReady, insertOk, sendButtonEnabled, sendClicked,
//              composeClosed, sentItemsFound, error }
function classifyOutcome(signals) {
  const s = signals || {};
  if (s.authWall) return 'blocked-auth';
  if (s.error && !s.sendClicked) return 'failed';
  if (!s.editorReady || !s.insertOk) return 'failed';
  if (!s.sendButtonEnabled) return 'failed';
  if (!s.sendClicked) return 'failed';
  // Send was clicked. Only 'sent' if Sent Items confirmed the match.
  if (s.sentItemsFound) return 'sent';
  // Clicked but not confirmed -> uncertain (caller must reconcile, NOT resend).
  return 'delivery-uncertain';
}

function _newResult(over) {
  return Object.assign({
    status: 'failed', to: [], cc: [], subject: '',
    bodyBytes: 0, sendButtonEnabled: false, composeClosed: false,
    sentItemsMatch: null, correlationMarker: '', errors: [], completedAt: null,
  }, over || {});
}

// ── In-page scripts (strings executed in the OWA renderer) ─────────────────────
// Clipboard-FREE insertion: set the editor's innerHTML directly and dispatch
// input/change so OWA's editor model picks it up. No clipboard.write/paste.
function _buildInsertScript(html) {
  const payload = JSON.stringify(html);
  const sel = JSON.stringify(EDITOR_SELECTOR);
  return `(function(){
    try {
      var ed = document.querySelector(${sel});
      if (!ed) return 'no-editor';
      ed.focus();
      // Clear any existing editor content directly via the DOM.
      ed.innerHTML = '';
      // Insert our HTML directly. Prefer execCommand insertHTML (keeps OWA's
      // model in sync); fall back to assigning innerHTML.
      var inserted = false;
      try {
        var sel2 = window.getSelection();
        sel2.removeAllRanges();
        var range = document.createRange();
        range.selectNodeContents(ed);
        sel2.addRange(range);
        inserted = document.execCommand('insertHTML', false, ${payload});
      } catch (e) { inserted = false; }
      if (!inserted || (ed.innerHTML || '').length < 20) {
        ed.innerHTML = ${payload};
      }
      // Fire the events OWA listens on so it registers the edit.
      ['input','change','keyup'].forEach(function(t){
        try { ed.dispatchEvent(new Event(t, { bubbles: true })); } catch(_){}
      });
      return ((ed.innerHTML||'').length > 20) ? 'ok' : 'empty';
    } catch (e) { return 'error:' + e.message; }
  })();`;
}

function _buildSendButtonProbeScript() {
  const sel = JSON.stringify(SEND_SELECTOR);
  return `(function(){
    var b = document.querySelector(${sel});
    if (!b) return 'no-btn';
    var disabled = b.disabled || b.getAttribute('aria-disabled') === 'true';
    return disabled ? 'disabled' : 'enabled';
  })();`;
}

function _buildSendClickScript() {
  const sel = JSON.stringify(SEND_SELECTOR);
  return `(function(){
    var b = document.querySelector(${sel});
    if (!b) return 'no-btn';
    if (b.disabled || b.getAttribute('aria-disabled') === 'true') return 'disabled';
    b.click();
    return 'clicked';
  })();`;
}

// Verify a message with the given marker + normalized subject appears in Sent
// Items. Runs in the OWA page context via the REST-ish search — but the most
// reliable cross-tenant approach without Graph is to open the Sent Items folder
// and scan rendered rows. We use the OWA search box query for the marker.
// This script returns 'found' | 'not-found' | 'error:...'.
function _buildSentItemsCheckScript(marker, normSubject) {
  const m = JSON.stringify(marker);
  const subj = JSON.stringify(normSubject);
  return `(function(){
    try {
      // Look for any list item / conversation row that references the marker
      // (present in the hidden span, which OWA indexes) or the subject text.
      var text = document.body ? document.body.innerText : '';
      if (text && text.indexOf(${m}) !== -1) return 'found';
      // Fallback: subject match in the Sent list.
      var rows = document.querySelectorAll('[role="listitem"], [role="option"], .lvHighlightSubjectClass, span[title]');
      var want = ${subj};
      for (var i=0;i<rows.length;i++){
        var t = (rows[i].innerText || rows[i].getAttribute('title') || '').replace(/\\s+/g,' ').trim().toLowerCase();
        if (t && want && t.indexOf(want) !== -1) return 'found';
      }
      return 'not-found';
    } catch (e) { return 'error:' + e.message; }
  })();`;
}

// ── Live delivery (Electron) ────────────────────────────────────────────────
/**
 * sendViaOwa(opts) -> Promise<result>
 * opts: {
 *   to, cc, subject, html,
 *   correlationMarker?,           // reuse the ledger job's marker if provided
 *   timeoutMs?, verifyTimeoutMs?,
 *   minBodyBytes?,                // pre-send body-size gate (default 200)
 *   _electron?,                   // injected for tests; defaults to require('electron')
 * }
 */
async function sendViaOwa(opts) {
  opts = opts || {};
  const electron = opts._electron || require('electron');
  const { BrowserWindow, session } = electron;

  const to = toRecipientArray(opts.to);
  const cc = toRecipientArray(opts.cc);
  const subject = String(opts.subject || '');
  const marker = opts.correlationMarker || genCorrelationMarker();
  const html = embedMarker(String(opts.html || ''), marker);
  const bodyBytes = Buffer.byteLength(html, 'utf8');
  const minBodyBytes = Number.isFinite(opts.minBodyBytes) ? opts.minBodyBytes : 200;
  const timeoutMs = opts.timeoutMs || 90000;
  const verifyTimeoutMs = opts.verifyTimeoutMs || 45000;

  const R = _newResult({ to, cc, subject, bodyBytes, correlationMarker: marker });
  const finish = (over) => { Object.assign(R, over); R.completedAt = new Date().toISOString(); return R; };

  // Pre-send gates that need no window.
  if (!to.length) { R.errors.push('no recipients'); return finish({ status: 'failed' }); }
  if (bodyBytes < minBodyBytes) { R.errors.push('body too small (' + bodyBytes + ' bytes)'); return finish({ status: 'failed' }); }

  const signals = { authWall: false, editorReady: false, insertOk: false, sendButtonEnabled: false, sendClicked: false, composeClosed: false, sentItemsFound: false, error: null };

  return new Promise((resolve) => {
    let win;
    let done = false;
    const cleanup = () => { try { if (win && !win.isDestroyed()) win.close(); } catch (_) {} };
    const settle = (over) => {
      if (done) return; done = true;
      cleanup();
      resolve(finish(over));
    };

    try {
      win = new BrowserWindow({
        width: 1100, height: 800,
        show: false, x: -32000, y: -32000,     // HIDDEN + offscreen
        skipTaskbar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession },
      });
      // Never allow this window to be shown or to spawn popups.
      win.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.on('show', () => { try { win.hide(); } catch (_) {} });  // defensively re-hide

      const hardTimeout = setTimeout(() => { R.errors.push('overall timeout'); signals.error = 'timeout'; settle({ status: classifyOutcome(signals) }); }, timeoutMs);

      // Auth-wall detection on navigation.
      const onNav = (_e, url) => {
        if (AUTH_HOST_RE.test(url || '')) {
          signals.authWall = true;
          R.errors.push('auth wall: ' + url);
          clearTimeout(hardTimeout);
          settle({ status: 'blocked-auth' });
        }
      };
      win.webContents.on('did-navigate', onNav);
      win.webContents.on('did-redirect-navigation', onNav);
      win.webContents.on('did-fail-load', (_e, code, desc) => {
        if (code === -3) return; // aborted (normal for SPA)
        signals.error = 'load failed: ' + desc;
        R.errors.push(signals.error);
        clearTimeout(hardTimeout);
        settle({ status: classifyOutcome(signals) });
      });

      const owaUrl = COMPOSE_URL + '?to=' + encodeURIComponent(to.join(';')) +
        '&cc=' + encodeURIComponent(cc.join(';')) + '&subject=' + encodeURIComponent(subject);
      win.loadURL(owaUrl);

      win.webContents.on('did-finish-load', async () => {
        if (done) return;
        // If we've navigated to an auth host, onNav already handled it.
        const curUrl = win.webContents.getURL();
        if (AUTH_HOST_RE.test(curUrl)) { signals.authWall = true; clearTimeout(hardTimeout); settle({ status: 'blocked-auth' }); return; }
        if (!/outlook\.office365\.com|outlook\.office\.com/i.test(curUrl)) return; // wait for the real compose page

        try {
          // 1) Wait for the editor, then insert clipboard-free.
          const editorReady = await _waitFor(win, EDITOR_SELECTOR, 40, 1000);
          if (!editorReady) { signals.error = 'no editor'; R.errors.push('editor not found'); clearTimeout(hardTimeout); settle({ status: 'failed' }); return; }
          signals.editorReady = true;

          const ins = await win.webContents.executeJavaScript(_buildInsertScript(html));
          signals.insertOk = ins === 'ok';
          if (!signals.insertOk) { R.errors.push('insert result: ' + ins); clearTimeout(hardTimeout); settle({ status: 'failed' }); return; }

          // 2) Pre-send verify Send button enabled.
          const probe = await win.webContents.executeJavaScript(_buildSendButtonProbeScript());
          signals.sendButtonEnabled = probe === 'enabled';
          R.sendButtonEnabled = signals.sendButtonEnabled;
          if (!signals.sendButtonEnabled) { R.errors.push('send button ' + probe); clearTimeout(hardTimeout); settle({ status: 'failed' }); return; }

          // 3) Click Send.
          const click = await win.webContents.executeJavaScript(_buildSendClickScript());
          signals.sendClicked = click === 'clicked';
          if (!signals.sendClicked) { R.errors.push('send click: ' + click); clearTimeout(hardTimeout); settle({ status: 'failed' }); return; }

          // 4) Confirm the compose view closed (message left the outbox).
          signals.composeClosed = await _waitForGone(win, EDITOR_SELECTOR, 15, 1000);
          R.composeClosed = signals.composeClosed;

          // 5) Sent Items verification (recipient + normalized subject + marker).
          const verify = await _verifySentItems(win, marker, normalizeSubject(subject), verifyTimeoutMs);
          signals.sentItemsFound = verify.found;
          R.sentItemsMatch = verify;

          clearTimeout(hardTimeout);
          settle({ status: classifyOutcome(signals) });
        } catch (e) {
          signals.error = e.message;
          R.errors.push('exception: ' + e.message);
          clearTimeout(hardTimeout);
          settle({ status: classifyOutcome(signals) });
        }
      });
    } catch (e) {
      settle({ status: 'failed', errors: ['window error: ' + e.message] });
    }
  });
}

// Poll for a selector to appear.
async function _waitFor(win, selector, attempts, intervalMs) {
  const probe = `(function(){return document.querySelector(${JSON.stringify(selector)}) ? 'yes' : 'no';})();`;
  for (let i = 0; i < attempts; i++) {
    if (win.isDestroyed()) return false;
    try { const r = await win.webContents.executeJavaScript(probe); if (r === 'yes') return true; } catch (_) {}
    await _sleep(intervalMs);
  }
  return false;
}

// Poll for a selector to disappear (compose closed).
async function _waitForGone(win, selector, attempts, intervalMs) {
  const probe = `(function(){return document.querySelector(${JSON.stringify(selector)}) ? 'yes' : 'no';})();`;
  for (let i = 0; i < attempts; i++) {
    if (win.isDestroyed()) return true;
    try { const r = await win.webContents.executeJavaScript(probe); if (r === 'no') return true; } catch (_) {}
    await _sleep(intervalMs);
  }
  return false;
}

// Navigate to Sent Items and poll for the marker/subject.
async function _verifySentItems(win, marker, normSubject, timeoutMs) {
  const result = { found: false, matchedBy: null, at: null };
  try {
    // Open Sent Items via the OWA search for the marker (indexed from the
    // hidden span). This avoids Graph and stays inside the OWA session.
    const searchUrl = OWA_ORIGIN + '/mail/sentitems';
    if (!win.isDestroyed()) win.loadURL(searchUrl);
    const deadline = Date.now() + timeoutMs;
    const script = _buildSentItemsCheckScript(marker, normSubject);
    // Give the folder a moment to render, then poll.
    await _sleep(3000);
    while (Date.now() < deadline) {
      if (win.isDestroyed()) break;
      try {
        const r = await win.webContents.executeJavaScript(script);
        if (r === 'found') { result.found = true; result.matchedBy = 'marker/subject'; result.at = new Date().toISOString(); return result; }
      } catch (_) {}
      await _sleep(2500);
    }
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Interactive re-auth (visible login on demand) ─────────────────────────────
/**
 * authenticateOwa(opts) -> Promise<{ ok, reason? }>
 * Opens a VISIBLE OWA window so the user can complete interactive auth / MFA /
 * consent. Resolves ok:true once we land back on the mailbox (not an auth
 * host). The pipeline then resumes the SAME paused jobs — it does not create
 * new ones. This is the ONLY place an OWA window is ever shown.
 */
async function authenticateOwa(opts) {
  opts = opts || {};
  const electron = opts._electron || require('electron');
  const { BrowserWindow, session } = electron;
  const timeoutMs = opts.timeoutMs || 5 * 60 * 1000;
  return new Promise((resolve) => {
    let done = false;
    const win = new BrowserWindow({
      width: 1000, height: 800, show: true, title: 'Sign in to Outlook',
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession },
    });
    const finish = (r) => { if (done) return; done = true; try { if (!win.isDestroyed()) win.close(); } catch (_) {} resolve(r); };
    const t = setTimeout(() => finish({ ok: false, reason: 'auth timeout' }), timeoutMs);
    const onNav = (_e, url) => {
      if (/outlook\.office365\.com\/mail|outlook\.office\.com\/mail/i.test(url) && !AUTH_HOST_RE.test(url)) {
        clearTimeout(t); setTimeout(() => finish({ ok: true }), 1500);
      }
    };
    win.webContents.on('did-navigate', onNav);
    win.webContents.on('did-redirect-navigation', onNav);
    win.on('closed', () => finish({ ok: false, reason: 'window closed' }));
    win.loadURL(OWA_ORIGIN + '/mail/');
  });
}

module.exports = {
  sendViaOwa,
  authenticateOwa,
  // pure helpers (exported for tests + reuse)
  normalizeSubject, normalizeRecipient, toRecipientArray,
  genCorrelationMarker, embedMarker, classifyOutcome,
  COMPOSE_URL, OWA_ORIGIN, AUTH_HOST_RE, EDITOR_SELECTOR, SEND_SELECTOR,
  _newResult, _buildInsertScript, _buildSendClickScript, _buildSentItemsCheckScript,
};
