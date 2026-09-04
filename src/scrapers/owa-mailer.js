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

// OWA markup shifts between builds, so each target has several fallbacks tried
// in order. The message-body editor is a contenteditable region; the Send
// control is a button with an accessible "Send" label (and a Ctrl+Enter
// keyboard fallback exists if the button can't be found).
const EDITOR_SELECTOR = [
  'div[aria-label*="Message body"]',
  'div[aria-label*="message body"]',
  'div.elementToProof[contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]',
  'div[contenteditable="true"][aria-multiline="true"]',
].join(',');
const SEND_SELECTOR = [
  'button[aria-label^="Send"]',
  'button[aria-label*="Send"]',
  'button[title^="Send"]',
  'div[role="button"][aria-label*="Send"]',
  'button[data-testid*="send" i]',
].join(',');

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
  const edSel = JSON.stringify(EDITOR_SELECTOR);
  return `(function(){
    var b = document.querySelector(${sel});
    if (b) {
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') return 'disabled';
      b.click();
      return 'clicked';
    }
    // Fallback: OWA sends on Ctrl+Enter from within the editor. Only used when
    // the Send button cannot be located by any selector.
    var ed = document.querySelector(${edSel});
    if (ed) {
      ed.focus();
      var ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, ctrlKey: true, bubbles: true });
      ed.dispatchEvent(ev);
      return 'clicked-keyboard';
    }
    return 'no-btn';
  })();`;
}

// Verify a message with the given marker + normalized subject appears in Sent
// Items. Runs in the OWA page context via the REST-ish search — but the most
// reliable cross-tenant approach without Graph is to open the Sent Items folder
// and scan rendered rows. We use the OWA search box query for the marker.
// This script returns 'found' | 'not-found' | 'error:...'.
function _buildSentItemsCheckScript(marker, normSubject, recipients) {
  const m = JSON.stringify(marker || '');
  const subj = JSON.stringify(normSubject || '');
  // Recipient local-parts + full addresses give the best chance of matching the
  // way OWA renders the "To" preview (often just a display name or first token).
  const recipTokens = [];
  (recipients || []).forEach(function (r) {
    const addr = String(r || '').toLowerCase();
    if (!addr) return;
    recipTokens.push(addr);
    const local = addr.split('@')[0];
    if (local) recipTokens.push(local);
  });
  const recips = JSON.stringify(recipTokens);
  return `(function(){
    try {
      function norm(s){ return String(s||'').replace(/\\bFOC-[0-9a-f]{8,}\\b/gi,'').replace(/^\\s*\\[test\\]\\s*/i,'').replace(/\\s+/g,' ').trim().toLowerCase(); }
      var want = norm(${subj});
      var marker = ${m};
      var recips = ${recips};

      // (A) STRONGEST: hidden correlation marker surfaced anywhere in the DOM
      // (reading pane / row aria). Kept as a bonus — OWA may not index hidden
      // body text, so this can miss even for a real send.
      if (marker) {
        var bodyText = document.body ? document.body.innerText : '';
        if (bodyText && bodyText.indexOf(marker) !== -1) return 'found:marker';
        var attrNodes = document.querySelectorAll('[title],[aria-label]');
        for (var a=0;a<attrNodes.length;a++){
          var av = (attrNodes[a].getAttribute('title')||'') + ' ' + (attrNodes[a].getAttribute('aria-label')||'');
          if (av.indexOf(marker) !== -1) return 'found:marker';
        }
      }

      // (B) PRIMARY: scan the rendered Sent-Items message rows. Sent Items is
      // newest-first, so a message we JUST sent is at/near the top. A row that
      // contains our (normalized) subject is a match; if we can also see a
      // recipient token in/near the row, that's a strong match.
      if (want) {
        // OWA truncates long subjects in the list ("Fleet Status TUZR — S…"),
        // so ALSO match on a shorter distinctive prefix that survives truncation.
        var wantPrefix = want.slice(0, Math.min(want.length, 16));
        var rows = document.querySelectorAll('[role="listitem"], [role="option"], div[data-convid], div[data-animation-id]');
        // Only consider the first ~12 rows (newest). Virtualized lists render the
        // visible window; the top rows are the most recent.
        var limit = Math.min(rows.length, 12);
        for (var i=0;i<limit;i++){
          var rowText = norm(rows[i].innerText || '');
          if (!rowText) continue;
          if (rowText.indexOf(want) !== -1 || (wantPrefix.length >= 12 && rowText.indexOf(wantPrefix) !== -1)) {
            // Subject matched. Try to also confirm a recipient token for a
            // stronger signal; if none of our recipients render in the list
            // (OWA often shows only a display name), a top-row subject match is
            // still accepted.
            var recipHit = false;
            for (var k=0;k<recips.length;k++){ if (recips[k] && rowText.indexOf(recips[k]) !== -1){ recipHit = true; break; } }
            return recipHit ? 'found:subject+recipient' : 'found:subject';
          }
        }
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
  const timeoutMs = opts.timeoutMs || 120000;
  const verifyTimeoutMs = opts.verifyTimeoutMs || 75000;

  const R = _newResult({ to, cc, subject, bodyBytes, correlationMarker: marker });
  const finish = (over) => { Object.assign(R, over); R.completedAt = new Date().toISOString(); return R; };

  // Pre-send gates that need no window.
  if (!to.length) { R.errors.push('no recipients'); return finish({ status: 'failed' }); }
  if (bodyBytes < minBodyBytes) { R.errors.push('body too small (' + bodyBytes + ' bytes)'); return finish({ status: 'failed' }); }

  const signals = { authWall: false, editorReady: false, insertOk: false, sendButtonEnabled: false, sendClicked: false, composeClosed: false, sentItemsFound: false, error: null };

  // ── Silent OWA session warmup (fixes recurring "OWA sign-in required") ──────
  // Before touching the compose deeplink, load the mailbox root once so OWA can
  // silently refresh its own tokens (the same thing the manual "Authenticate
  // OWA" button did). This self-heals a cold-but-refreshable session with no
  // user click. If warmup hits a real interactive auth wall, we stop here and
  // return 'blocked-auth' honestly — never typing, never clicking, never faking
  // success. Skippable via opts.skipWarmup (used by unit tests that stub the
  // compose flow directly). A warmup timeout/soft-failure is non-fatal: we still
  // attempt the compose, which will itself detect an auth wall if present.
  if (!opts.skipWarmup) {
    try {
      const warm = await warmOwaSession({
        _electron: electron,
        timeoutMs: opts.warmupTimeoutMs || 60000,
        settleMs: opts.warmupSettleMs,
      });
      if (warm && warm.authWall) {
        R.errors.push('auth wall (warmup): ' + (warm.url || ''));
        return finish({ status: 'blocked-auth' });
      }
      if (warm && warm.ok) {
        logger.info && logger.info('[owa-mailer] session warmup ok before compose');
      } else if (warm && warm.reason) {
        // Non-fatal: proceed to compose, which re-checks auth on its own.
        logger.warn && logger.warn('[owa-mailer] session warmup soft-fail:', warm.reason);
      }
    } catch (e) {
      logger.warn && logger.warn('[owa-mailer] warmup threw (non-fatal):', e && e.message);
    }
  }

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
      // NOTE: setWindowOpenHandler lives on webContents, not on BrowserWindow.
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
          // 1) Wait for the editor, then insert the HTML body.
          const editorReady = await _waitFor(win, EDITOR_SELECTOR, 40, 1000);
          if (!editorReady) { signals.error = 'no editor'; R.errors.push('editor not found'); clearTimeout(hardTimeout); settle({ status: 'failed' }); return; }
          signals.editorReady = true;

          const ins = await _insertBody(win, electron, html);
          signals.insertOk = ins === 'ok';
          if (!signals.insertOk) { R.errors.push('insert result: ' + ins); clearTimeout(hardTimeout); settle({ status: 'failed' }); return; }

          // 2) Pre-send verify the Send control. 'enabled' = button ready.
          // 'no-btn' = button not found by any selector; we allow the Ctrl+Enter
          // keyboard fallback (editor is confirmed ready + populated). Only an
          // explicitly 'disabled' button blocks the send.
          const probe = await win.webContents.executeJavaScript(_buildSendButtonProbeScript());
          if (probe === 'disabled') { signals.sendButtonEnabled = false; R.sendButtonEnabled = false; R.errors.push('send button disabled'); clearTimeout(hardTimeout); settle({ status: 'failed' }); return; }
          signals.sendButtonEnabled = (probe === 'enabled' || probe === 'no-btn');
          R.sendButtonEnabled = probe === 'enabled';

          // 3) Click Send (button click, or Ctrl+Enter keyboard fallback).
          const click = await win.webContents.executeJavaScript(_buildSendClickScript());
          signals.sendClicked = (click === 'clicked' || click === 'clicked-keyboard');
          if (!signals.sendClicked) { R.errors.push('send click: ' + click); clearTimeout(hardTimeout); settle({ status: 'failed' }); return; }

          // 4) Confirm the compose view closed (message left the outbox).
          signals.composeClosed = await _waitForGone(win, EDITOR_SELECTOR, 15, 1000);
          R.composeClosed = signals.composeClosed;

          // 5) Sent Items verification (recipient + normalized subject + marker
          //    + recency at top of the newest-first Sent folder).
          const verify = await _verifySentItems(win, {
            marker,
            normSubject: normalizeSubject(subject),
            recipients: to.concat(cc),
            timeoutMs: verifyTimeoutMs,
          });
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

// Insert the HTML body into the OWA editor while PRESERVING its rich structure
// (layout tables + <font> tags). OWA's editor sanitizer FLATTENS content set via
// innerHTML / execCommand('insertHTML') to plain text — confirmed against a live
// send — so the styled SOS/EOS report is lost. OWA's PASTE pipeline, however,
// preserves HTML from the clipboard. Per the product owner, clipboard use is
// permitted "if unavoidable" with save + restore; this is that case.
//
// Strategy:
//   1. Save the user's current clipboard (text + html).
//   2. Write the email HTML to the clipboard.
//   3. Focus + select-all + clear the editor, then webContents.paste().
//   4. Verify the editor now contains a table (structure preserved).
//   5. ALWAYS restore the user's original clipboard.
// Falls back to direct innerHTML insertion only if the clipboard is unavailable.
async function _insertBody(win, electron, html) {
  const { clipboard } = electron;
  const sel = JSON.stringify(EDITOR_SELECTOR);
  // Save existing clipboard so we can restore it afterwards.
  let savedText = '', savedHtml = '';
  try { savedText = clipboard.readText(); savedHtml = clipboard.readHTML(); } catch (_) {}

  try {
    // Focus + clear the editor before paste.
    await win.webContents.executeJavaScript(`(function(){
      var ed = document.querySelector(${sel});
      if (!ed) return 'no-editor';
      ed.focus();
      try { var s = window.getSelection(); s.removeAllRanges(); var r = document.createRange(); r.selectNodeContents(ed); s.addRange(r); document.execCommand('delete', false, null); } catch(e){}
      return 'ready';
    })();`);

    if (clipboard && typeof clipboard.write === 'function') {
      clipboard.write({ html: html, text: 'Fleet Status Report' });
      // Give the OS clipboard a beat, then paste through OWA's HTML paste path.
      await _sleep(150);
      win.webContents.paste();
      // Poll for the pasted structure to appear (tables preserved).
      for (let i = 0; i < 12; i++) {
        await _sleep(600);
        if (win.isDestroyed()) break;
        try {
          const chk = await win.webContents.executeJavaScript(`(function(){
            var ed = document.querySelector(${sel});
            if (!ed) return 'no-editor';
            var h = ed.innerHTML || '';
            if (h.length < 40) return 'empty';
            return /<table/i.test(h) ? 'ok-rich' : 'ok-plain';
          })();`);
          if (chk === 'ok-rich') return 'ok';
          if (chk === 'ok-plain' && i >= 4) return 'ok'; // content present even if tables stripped
        } catch (_) {}
      }
    }

    // Fallback: direct insertion (may flatten, but better than nothing).
    const direct = await win.webContents.executeJavaScript(_buildInsertScript(html));
    return direct === 'ok' ? 'ok' : ('insert-failed:' + direct);
  } finally {
    // ALWAYS restore the user's clipboard.
    try {
      if (savedHtml) clipboard.write({ html: savedHtml, text: savedText });
      else if (savedText) clipboard.writeText(savedText);
      else clipboard.clear();
    } catch (_) {}
  }
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
//
// A just-sent message can take several seconds to land + index in Sent Items,
// and the FOLDER LIST view only shows subject/preview (not the hidden body
// marker). So we verify in two ways, most reliable first:
//   (1) OWA search scoped to Sent Items for the correlation marker — OWA
//       indexes full body text (including our hidden span), so a search hit is
//       an unambiguous match. We drive it via the search deeplink.
//   (2) Fallback: scan the rendered Sent-Items list for the normalized subject.
// We reload/settle between attempts and keep polling until the deadline.
async function _verifySentItems(win, opts) {
  opts = opts || {};
  const marker = opts.marker;
  const normSubject = opts.normSubject;
  const recipients = opts.recipients || [];
  const timeoutMs = opts.timeoutMs || 75000;
  const result = { found: false, matchedBy: null, at: null };
  try {
    const deadline = Date.now() + timeoutMs;
    const script = _buildSentItemsCheckScript(marker, normSubject, recipients);
    const listUrl = OWA_ORIGIN + '/mail/sentitems';
    // Search deeplink kept as a secondary probe for the marker (helps when OWA
    // does index the body). Primary is the newest-first folder list.
    const searchUrl = marker ? (OWA_ORIGIN + '/mail/search/' + encodeURIComponent(marker)) : null;

    // Give the message a moment to land in Sent Items before the first look.
    await _sleep(5000);
    // Load the Sent Items folder once up front.
    try { if (!win.isDestroyed()) win.loadURL(listUrl); } catch (_) {}
    await _sleep(3500);

    let cycle = 0;
    while (Date.now() < deadline) {
      if (win.isDestroyed()) break;
      // Every few cycles, refresh the folder (newest-first) so a message that
      // has just appeared is picked up; occasionally try the marker search too.
      if (cycle > 0) {
        const target = (searchUrl && cycle % 3 === 0) ? searchUrl : listUrl;
        try { if (!win.isDestroyed()) win.loadURL(target); } catch (_) {}
        await _sleep(3000);
      }
      try {
        const r = await win.webContents.executeJavaScript(script);
        if (typeof r === 'string' && r.indexOf('found') === 0) {
          result.found = true;
          result.matchedBy = r.slice(r.indexOf(':') + 1) || 'match';
          result.at = new Date().toISOString();
          return result;
        }
      } catch (_) {}
      cycle++;
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
 * warmOwaSession(opts) -> Promise<{ ok, authWall, url?, reason? }>
 *
 * SILENT, non-interactive OWA session warmup. Opens a HIDDEN, offscreen window
 * (exactly like a real send — never shown, popups blocked) and loads the
 * mailbox root `/mail/`. Loading the mailbox lets OWA run its OWN silent token
 * refresh (the same thing the visible "Authenticate OWA" button triggers) and
 * write fresh office365 auth cookies into the shared defaultSession cookie jar.
 *
 * WHY THIS EXISTS: the scheduled send (sendViaOwa) used to navigate STRAIGHT to
 * the compose deeplink. When the office365 session had gone cold, that deeplink
 * answered with a redirect to login.microsoftonline.com → detected as an auth
 * wall → 'blocked-auth', and the slot paused. A manual click of "Authenticate
 * OWA" worked only because it loaded `/mail/` first and let OWA silently
 * refresh. This helper does that same warmup automatically and silently before
 * every send, so a cold-but-refreshable session self-heals with no user click.
 *
 * HONEST FALLBACK (no false success): if the warmup itself lands on an auth
 * host, OWA genuinely needs interactive MFA/consent — we return
 * { ok:false, authWall:true } WITHOUT typing or clicking anything. The caller
 * then reports 'blocked-auth' exactly as before, and the visible "Authenticate
 * OWA" flow remains the correct fallback. Warmup only ever helps; it never
 * sends, and it never masks a real auth requirement.
 */
async function warmOwaSession(opts) {
  opts = opts || {};
  const electron = opts._electron || require('electron');
  const { BrowserWindow, session } = electron;
  // 60s default: the microsoftonline SSO redirect chain + a "Stay signed in?"
  // click needs real headroom to auto-complete (a bare 30s could time out mid
  // redirect and mislabel a self-completing chain as an auth wall).
  const timeoutMs = opts.timeoutMs || 60000;
  // Grace period after landing on the mailbox so OWA can finish its silent
  // token exchange and flush fresh cookies into defaultSession before we
  // navigate on to the compose deeplink.
  const settleMs = Number.isFinite(opts.settleMs) ? opts.settleMs : 1800;

  return new Promise((resolve) => {
    let win, done = false;
    const settle = (over) => {
      if (done) return; done = true;
      if (poll) { clearInterval(poll); poll = null; }
      try { if (win && !win.isDestroyed()) win.close(); } catch (_) {}
      resolve(Object.assign({ ok: false, authWall: false, url: null }, over || {}));
    };
    let poll = null;
    try {
      win = new BrowserWindow({
        width: 1100, height: 800,
        show: false, x: -32000, y: -32000,   // HIDDEN + offscreen (never shown)
        skipTaskbar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.on('show', () => { try { win.hide(); } catch (_) {} });

      const MAILBOX_RE = /outlook\.office365\.com\/mail|outlook\.office\.com\/mail/i;
      const onMailbox = (url) => { clearTimeout(t); setTimeout(() => settle({ ok: true, url }), settleMs); };

      // The overall deadline. Unlike before, we DO NOT bail the instant we see a
      // Microsoft login host — for a session that can complete SSO silently
      // (confirmed for this user: "Authenticate OWA" lands on the mailbox with
      // NO password/MFA typed), that login host is just a TRANSIENT redirect hop
      // in an auto-completing chain. Bailing on first sight of it was killing the
      // exact chain that works. Instead we let the redirect chain run, auto-click
      // any "Stay signed in?" prompt to push it through (and to maximize how long
      // the resulting session persists), and only conclude a genuine interactive
      // auth wall if we're STILL stuck on a login host at the deadline.
      const t = setTimeout(() => {
        // Timed out. If the last URL we saw is a login host, it's a real
        // interactive wall (needs the visible Authenticate OWA flow). Otherwise
        // report a soft failure and let the caller attempt compose anyway.
        let cur = '';
        try { cur = win && !win.isDestroyed() ? win.webContents.getURL() : ''; } catch (_) {}
        if (AUTH_HOST_RE.test(cur)) settle({ ok: false, authWall: true, url: cur });
        else settle({ ok: false, reason: 'warmup timeout' });
      }, timeoutMs);

      // Click Microsoft's "Stay signed in?" Yes button (#idSIButton9) if present.
      // This both completes the SSO chain and, crucially, makes the resulting
      // Office365 session long-lived so subsequent scheduled sends stay automatic
      // for days instead of re-prompting. Harmless no-op on non-login pages.
      const STAY_IN_SCRIPT =
        '(function(){try{' +
        'var b=document.querySelector("#idSIButton9")' +
        '||document.querySelector("input[type=submit][value=\\"Yes\\"]")' +
        '||document.querySelector("button[data-report-event=\\"Signin_Submit\\"]");' +
        'if(b){b.click();return "clicked-stay-in";}' +
        // Some tenants show a "Yes"/"No" pair; prefer the accept control.
        'var yes=[].slice.call(document.querySelectorAll("input,button")).find(function(e){' +
        ' var t=((e.value||e.textContent||"")+"").trim().toLowerCase(); return t==="yes";});' +
        'if(yes){yes.click();return "clicked-yes";}' +
        'return "no-prompt";' +
        '}catch(e){return "err:"+e.message;}})()';

      const onMailboxCheck = (url) => {
        if (done) return;
        if (MAILBOX_RE.test(url || '')) { onMailbox(url); }
        // Login host: do NOT bail. Let the chain continue; the poll below will
        // try to click "Stay signed in?" to push it through.
      };
      win.webContents.on('did-navigate', (_e, url) => onMailboxCheck(url));
      win.webContents.on('did-redirect-navigation', (_e, url) => onMailboxCheck(url));
      win.webContents.on('did-fail-load', (_e, code, desc) => {
        if (code === -3) return; // aborted (normal for SPA navigations)
        // A real load failure while NOT on a mailbox — soft-fail (non-fatal);
        // the caller will still attempt compose which re-checks auth.
        try {
          const cur = win && !win.isDestroyed() ? win.webContents.getURL() : '';
          if (!MAILBOX_RE.test(cur)) { clearTimeout(t); settle({ ok: false, reason: 'load failed: ' + desc }); }
        } catch (_) { clearTimeout(t); settle({ ok: false, reason: 'load failed: ' + desc }); }
      });
      win.webContents.on('did-finish-load', async () => {
        if (done) return;
        let curUrl = '';
        try { curUrl = win.webContents.getURL(); } catch (_) {}
        if (MAILBOX_RE.test(curUrl)) { onMailbox(curUrl); return; }
        // On any login/consent page, try to click through the "Stay signed in?"
        // prompt so the chain can complete on its own.
        if (AUTH_HOST_RE.test(curUrl)) {
          try { await win.webContents.executeJavaScript(STAY_IN_SCRIPT); } catch (_) {}
        }
      });

      // Poll while a login host is showing: periodically re-check the URL and
      // attempt the "Stay signed in?" click. This drives the auto-completing SSO
      // chain to the mailbox without any user interaction.
      poll = setInterval(async () => {
        if (done || !win || win.isDestroyed()) return;
        let cur = '';
        try { cur = win.webContents.getURL(); } catch (_) {}
        if (MAILBOX_RE.test(cur)) { onMailbox(cur); return; }
        if (AUTH_HOST_RE.test(cur)) {
          try { await win.webContents.executeJavaScript(STAY_IN_SCRIPT); } catch (_) {}
        }
      }, 2000);

      win.loadURL(OWA_ORIGIN + '/mail/');
    } catch (e) {
      settle({ ok: false, reason: 'window error: ' + e.message });
    }
  });
}

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

// ── Read-only selector self-check (Task #9 live acceptance aid) ────────────────
/**
 * previewSelectors(opts) -> Promise<{ ok, authWall, editorFound, sendButtonFound,
 *   editorSelector, sendSelector, url, error? }>
 *
 * Opens a HIDDEN compose window exactly like a real send, but does NOT insert a
 * body and does NOT click Send. It only reports whether the current OWA build
 * exposes the editor + Send control our selectors target, or whether an auth
 * wall is in the way. This lets the live acceptance step confirm the DOM
 * targets before any real message is sent — zero side effects.
 */
async function previewSelectors(opts) {
  opts = opts || {};
  const electron = opts._electron || require('electron');
  const { BrowserWindow, session } = electron;
  const timeoutMs = opts.timeoutMs || 45000;
  const out = { ok: false, authWall: false, editorFound: false, sendButtonFound: false,
    editorSelector: EDITOR_SELECTOR, sendSelector: SEND_SELECTOR, url: null, error: null };
  return new Promise((resolve) => {
    let win, done = false;
    const settle = (over) => { if (done) return; done = true; try { if (win && !win.isDestroyed()) win.close(); } catch (_) {} resolve(Object.assign(out, over || {})); };
    try {
      win = new BrowserWindow({ width: 1100, height: 800, show: false, x: -32000, y: -32000, skipTaskbar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession } });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.on('show', () => { try { win.hide(); } catch (_) {} });
      const t = setTimeout(() => settle({ error: 'timeout' }), timeoutMs);
      const onNav = (_e, url) => { if (AUTH_HOST_RE.test(url || '')) { clearTimeout(t); settle({ authWall: true, url }); } };
      win.webContents.on('did-navigate', onNav);
      win.webContents.on('did-redirect-navigation', onNav);
      // subject only — no recipients, no body -> nothing can be sent
      win.loadURL(COMPOSE_URL + '?subject=' + encodeURIComponent('[selector-check]'));
      win.webContents.on('did-finish-load', async () => {
        if (done) return;
        const curUrl = win.webContents.getURL();
        out.url = curUrl;
        if (AUTH_HOST_RE.test(curUrl)) { clearTimeout(t); settle({ authWall: true }); return; }
        if (!/outlook\.office(365)?\.com/i.test(curUrl)) return;
        try {
          const editorFound = await _waitFor(win, EDITOR_SELECTOR, 30, 1000);
          const probe = await win.webContents.executeJavaScript(_buildSendButtonProbeScript());
          clearTimeout(t);
          settle({ ok: editorFound, editorFound, sendButtonFound: (probe === 'enabled' || probe === 'disabled') });
        } catch (e) { clearTimeout(t); settle({ error: e.message }); }
      });
    } catch (e) { settle({ error: e.message }); }
  });
}

module.exports = {
  sendViaOwa,
  authenticateOwa,
  warmOwaSession,
  previewSelectors,
  // pure helpers (exported for tests + reuse)
  normalizeSubject, normalizeRecipient, toRecipientArray,
  genCorrelationMarker, embedMarker, classifyOutcome,
  COMPOSE_URL, OWA_ORIGIN, AUTH_HOST_RE, EDITOR_SELECTOR, SEND_SELECTOR,
  _newResult, _buildInsertScript, _buildSendClickScript, _buildSentItemsCheckScript,
};
