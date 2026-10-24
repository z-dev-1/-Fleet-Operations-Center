'use strict';
/**
 * scrapers/owa_reader.js — OWA-only hidden background INBOX READER.
 *
 * The read-only companion to owa-mailer.js. Opens the user's authenticated
 * Outlook Web (OWA) mailbox in a fully HIDDEN, offscreen BrowserWindow (exactly
 * the same window/session pattern as owa-mailer.sendViaOwa), lets OWA silently
 * refresh its own session (warmOwaSession), then scrapes the top N inbox
 * messages — sender, subject, received time, a body-text preview, and the list
 * of attachment chips (name + type) — via webContents.executeJavaScript.
 *
 * Hard constraints (mirror owa-mailer.js, non-negotiable):
 *   - OWA ONLY. No IMAP, no Graph, no SMTP. Reuses the shared defaultSession
 *     cookie jar so no new sign-in is ever required.
 *   - The window is fully HIDDEN: show:false, offscreen, never shown/focused,
 *     popups denied, re-hidden defensively on any 'show'.
 *   - READ-ONLY. This module NEVER deletes, replies, moves, marks-read, or
 *     mutates the mailbox in any way. It only reads rendered DOM text.
 *   - If OWA requires interactive auth / MFA / consent, we PAUSE and return
 *     { ok:false, authBlocked:true } — never typing, never faking data.
 *
 * Everything downstream (AI triage, unit-timeline updates, operator DMs,
 * reply drafting/sending) lives in email_triage.js + ipc/email-triage.js and is
 * confirm-gated. This file's only job is to produce grounded, real inbox data.
 */

const owa = require('./owa-mailer');
let logger; try { logger = require('../utils/logger')('owa-reader'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const { OWA_ORIGIN, MAILBOX_RE, AUTH_HOST_RE, OUTLOOK_HOST_RE } = owa;
const INBOX_URL = OWA_ORIGIN + '/mail/inbox';

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Poll for a selector to appear in the OWA page.
async function _waitFor(win, selectorsJoined, attempts, intervalMs) {
  const probe = '(function(){return document.querySelector(' + JSON.stringify(selectorsJoined) + ') ? "yes" : "no";})();';
  for (let i = 0; i < attempts; i++) {
    if (win.isDestroyed()) return false;
    try { const r = await win.webContents.executeJavaScript(probe); if (r === 'yes') return true; } catch (_) {}
    await _sleep(intervalMs);
  }
  return false;
}

// Message-list row selectors (several OWA builds). The inbox list virtualizes,
// so the newest messages render at the top — which is exactly what we want.
const ROW_SELECTOR = [
  'div[role="option"][aria-label]',
  'div[data-convid]',
  'div[role="listitem"]',
  'div[data-animation-id]',
].join(',');

// In-page script: read the top `max` inbox rows WITHOUT opening them. Returns a
// JSON string of lightweight row descriptors (sender/subject/preview/time +
// whether the row shows an attachment paperclip). We open each message
// individually afterwards for the full body + attachment names.
function _buildRowScanScript(max) {
  const rowSel = JSON.stringify(ROW_SELECTOR);
  return '(function(){\n' +
    '  try {\n' +
    '    var out = [];\n' +
    '    var rows = document.querySelectorAll(' + rowSel + ');\n' +
    '    var seen = {};\n' +
    '    for (var i=0; i<rows.length && out.length<' + max + '; i++){\n' +
    '      var r = rows[i];\n' +
    '      var aria = (r.getAttribute("aria-label")||"").trim();\n' +
    '      var txt  = (r.innerText||"").trim();\n' +
    '      if (!aria && !txt) continue;\n' +
    '      var convId = r.getAttribute("data-convid") || "";\n' +
    '      // A stable-ish key: prefer convId, else first 120 chars of aria/text.\n' +
    '      var key = convId || (aria||txt).slice(0,120);\n' +
    '      if (seen[key]) continue; seen[key] = 1;\n' +
    '      // Detect an attachment paperclip within the row.\n' +
    '      var hasAttach = !!r.querySelector(\'[aria-label*="attachment" i], [title*="attachment" i], i[data-icon-name*="Attach" i], span[data-icon-name*="Attach" i]\');\n' +
    '      out.push({ index:i, convId:convId, aria:aria, preview:txt.slice(0,400), hasAttach:hasAttach });\n' +
    '    }\n' +
    '    return JSON.stringify(out);\n' +
    '  } catch(e){ return JSON.stringify({error:String(e&&e.message||e)}); }\n' +
    '})();';
}

// In-page script: click the Nth inbox row open, then read the reading pane.
// Returns a JSON descriptor of the OPEN message: from, subject, receivedText,
// bodyText, and attachment chip names/types. READ-ONLY — a click to open a
// message does not modify it (OWA may mark it read; we accept that as the only
// unavoidable side effect of viewing, and never delete/reply/move).
function _buildOpenAndReadScript(rowIndex) {
  const rowSel = JSON.stringify(ROW_SELECTOR);
  return '(function(){\n' +
    '  try {\n' +
    '    var rows = document.querySelectorAll(' + rowSel + ');\n' +
    '    var r = rows[' + rowIndex + '];\n' +
    '    if (!r) return JSON.stringify({error:"no-row"});\n' +
    '    // Click a focusable inner element to open the message in the reading pane.\n' +
    '    var clickTarget = r.querySelector(\'[role="button"], a, span\') || r;\n' +
    '    clickTarget.click();\n' +
    '    return JSON.stringify({clicked:true});\n' +
    '  } catch(e){ return JSON.stringify({error:String(e&&e.message||e)}); }\n' +
    '})();';
}

// In-page script: read whatever message is currently open in the reading pane.
function _buildReadPaneScript() {
  return '(function(){\n' +
    '  try {\n' +
    '    function pick(sels){ for (var i=0;i<sels.length;i++){ var el=document.querySelector(sels[i]); if(el) return el; } return null; }\n' +
    '    // Reading pane container (several builds).\n' +
    '    var pane = pick(["div[aria-label*=\\"Reading Pane\\" i]","div[data-app-section=\\"ConversationContainer\\"]","div[role=\\"main\\"] div[role=\\"region\\"]","div[role=\\"document\\"]"]) || document.body;\n' +
    '    // Subject.\n' +
    '    var subjEl = pick(["div[role=\\"heading\\"][aria-level=\\"2\\"]","span[role=\\"heading\\"]","div[aria-label^=\\"Subject\\" i]","h1,h2"]);\n' +
    '    var subject = subjEl ? (subjEl.innerText||subjEl.textContent||"").trim() : "";\n' +
    '    // Sender — look for a mailto link, a person chip, or ANY element whose\n' +
    '    // title/aria-label contains an email address (OWA renders the sender\n' +
    '    // address in a title attribute even when there is no mailto link).\n' +
    '    var from = "", fromName = "";\n' +
    '    var mail = pane.querySelector(\'a[href^="mailto:"]\');\n' +
    '    if (mail) { from = (mail.getAttribute("href")||"").replace(/^mailto:/i,"").trim(); fromName = (mail.innerText||"").trim(); }\n' +
    '    var EMAIL_RE = /[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}/i;\n' +
    '    if (!from) {\n' +
    '      var sndr = pane.querySelector(\'[aria-label*="From" i] [title*="@"], span[title*="@"], [data-lpc-hover-target]\');\n' +
    '      if (sndr) { var tt=(sndr.getAttribute("title")||sndr.innerText||"").trim(); var m=tt.match(EMAIL_RE); if(m) from=m[0]; fromName=fromName||tt; }\n' +
    '    }\n' +
    '    if (!from) {\n' +
    '      // Broad fallback: scan the first elements in the pane with an @ in a\n' +
    '      // title/aria-label and take the first real-looking address.\n' +
    '      var cand = pane.querySelectorAll(\'[title*="@"],[aria-label*="@"]\');\n' +
    '      for (var ci=0; ci<cand.length && ci<40; ci++){\n' +
    '        var cv=(cand[ci].getAttribute("title")||cand[ci].getAttribute("aria-label")||"").trim();\n' +
    '        var cm=cv.match(EMAIL_RE);\n' +
    '        if (cm){ from=cm[0]; if(!fromName){ fromName=cv.replace(EMAIL_RE,"").replace(/[<>]/g,"").trim(); } break; }\n' +
    '      }\n' +
    '    }\n' +
    '    // Received time.\n' +
    '    var timeEl = pane.querySelector("time, span[aria-label*=\\"received\\" i], span[title*=\\":\\"]");\n' +
    '    var receivedText = timeEl ? (timeEl.getAttribute("datetime")||timeEl.getAttribute("title")||timeEl.innerText||"").trim() : "";\n' +
    '    // Body text — the message body region, falling back to the whole pane.\n' +
    '    var bodyEl = pick(["div[aria-label*=\\"Message body\\" i]","div[id*=\\"UniqueMessageBody\\"]","div.rps_", "div[role=\\"document\\"]"]) || pane;\n' +
    '    var bodyText = (bodyEl.innerText||"").trim();\n' +
    '    // Attachments: chips in the reading pane (name + inferred type from extension).\n' +
    '    var atts = [];\n' +
    '    var chips = pane.querySelectorAll(\'[aria-label*="attachment" i], [data-attachmentid], div[role="listitem"][title], button[title*="."]\');\n' +
    '    for (var i=0;i<chips.length && atts.length<20;i++){\n' +
    '      var c = chips[i];\n' +
    '      var nm = (c.getAttribute("title")||c.getAttribute("aria-label")||c.innerText||"").trim();\n' +
    '      nm = nm.replace(/^attachment[,:]?\\s*/i,"").trim();\n' +
    '      var em = nm.match(/[^\\s/\\\\]+\\.[a-z0-9]{2,5}\\b/i);\n' +
    '      if (!em) continue;\n' +
    '      var fname = em[0];\n' +
    '      var ext = (fname.split(".").pop()||"").toLowerCase();\n' +
    '      if (atts.some(function(a){return a.name===fname;})) continue;\n' +
    '      atts.push({ name:fname, ext:ext });\n' +
    '    }\n' +
    '    return JSON.stringify({ subject:subject, from:from, fromName:fromName, receivedText:receivedText, bodyText:bodyText.slice(0,8000), attachments:atts });\n' +
    '  } catch(e){ return JSON.stringify({error:String(e&&e.message||e)}); }\n' +
    '})();';
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'heic', 'tif', 'tiff'];
const DOC_EXTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'txt', 'eml', 'msg'];
function _attachmentType(ext) {
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (DOC_EXTS.includes(ext)) return 'document';
  return 'file';
}

// Normalize a raw read-pane descriptor into our stable email record shape.
function _normalizeEmail(raw, rowDesc) {
  const atts = Array.isArray(raw.attachments) ? raw.attachments : [];
  const subject = String(raw.subject || '').trim() || _subjectFromAria(rowDesc && rowDesc.aria) || '(no subject)';
  const from = String(raw.from || '').trim().toLowerCase();
  const fromName = String(raw.fromName || '').trim() || _nameFromAria(rowDesc && rowDesc.aria) || from;
  // Stable id: OWA conversation id when present, else a hash of from+subject+received.
  const stableSeed = (rowDesc && rowDesc.convId) || (from + '|' + subject + '|' + String(raw.receivedText || ''));
  const id = 'em_' + _hash(stableSeed);
  return {
    id,
    convId: (rowDesc && rowDesc.convId) || '',
    from,
    fromName,
    subject,
    receivedText: String(raw.receivedText || '').trim(),
    bodyText: String(raw.bodyText || '').trim(),
    attachments: atts.map((a) => ({ name: a.name, ext: a.ext, type: _attachmentType(a.ext) })),
  };
}

// Parse an OWA message-row aria-label into structured fields. The live format
// (confirmed against the real mailbox) is a single space-joined string:
//   [Unread] [Has attachments] <Sender> <Subject> <HH:MM | date> <body preview…>
// There is no delimiter between sender/subject, but the TIME token (e.g. "18:09"
// or a date like "Mon 10/6" / "Oct 9") is a reliable anchor: everything after it
// is the preview; the sender is the leading name; the subject is between the
// sender and the time. We split sender vs subject heuristically.
function _parseAriaLabel(aria) {
  let s = String(aria || '').trim();
  const out = { fromName: '', subject: '', receivedText: '', preview: '', unread: false, hasAttach: false };
  if (!s) return out;

  // Strip leading status flags.
  if (/^unread\b/i.test(s)) { out.unread = true; s = s.replace(/^unread\s+/i, ''); }
  if (/^has attachments\b/i.test(s)) { out.hasAttach = true; s = s.replace(/^has attachments\s+/i, ''); }
  // (flags can appear in either order)
  if (/^unread\b/i.test(s)) { out.unread = true; s = s.replace(/^unread\s+/i, ''); }

  // Find the time/date anchor: a HH:MM, or a short date token. Use the FIRST
  // standalone time-like token as the split point between header and preview.
  const timeRe = /\s(\d{1,2}:\d{2}(?:\s?[AP]M)?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b[^\s]*|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2})\s/i;
  const m = s.match(timeRe);
  let header = s;
  if (m) {
    const idx = s.indexOf(m[0]);
    header = s.slice(0, idx).trim();
    out.receivedText = m[1].trim();
    out.preview = s.slice(idx + m[0].length).trim().slice(0, 2000);
  }

  // Split the header into sender + subject. The sender is the leading
  // name/company. Heuristic: if it starts with "Last, First" (a comma name),
  // the sender is up to the first run that looks like a subject start. Simpler
  // robust rule: take the first 1–5 words as the sender until we hit a token
  // that strongly looks like subject content (brackets, #, "Unit", "RE:", etc.),
  // but cap the sender to a sensible length. Fall back to first 3 words.
  out.fromName = _guessSender(header);
  out.subject = header.slice(out.fromName.length).trim() || header;
  // If splitting produced an empty subject (sender == whole header), keep header
  // as subject and leave sender as the first 3 words.
  if (!out.subject || out.subject === out.fromName) {
    const words = header.split(/\s+/);
    out.fromName = words.slice(0, 3).join(' ');
    out.subject = words.slice(3).join(' ') || header;
  }
  return out;
}

// Guess the sender name prefix from a "<Sender> <Subject>" header string.
function _guessSender(header) {
  const h = String(header || '').trim();
  if (!h) return '';
  // "Last, First ..." → sender is "Last, First" (two tokens around the comma).
  const commaName = h.match(/^([^\s,]+,\s+[^\s]+)\s+/);
  if (commaName) return commaName[1];
  // Subject often starts with a known marker; sender is everything before it.
  // Markers: bracketed tags, "Unit#", RE:/FW:/Undeliverable:, a word ending in
  // a colon (e.g. "Left:"), a standalone number (e.g. "3 Days"), or a 4+ digit id.
  const marker = h.search(/\s(\[EXTERNAL\]|\[|Unit#|RE:|FW:|Undeliverable:|How\b|\d+\s+Days?\b|\b\w+:|\d{4,})/);
  if (marker > 0 && marker <= 60) return h.slice(0, marker).trim();
  // Otherwise take up to the first 4 words as the sender (company names like
  // "Hunter Buffalo Peterbilt" / "Gabrielli Truck Sales Ridgefield Park").
  const words = h.split(/\s+/);
  return words.slice(0, Math.min(4, words.length)).join(' ');
}

// Back-compat shims (older call sites / tests).
function _subjectFromAria(aria) { return _parseAriaLabel(aria).subject; }
function _nameFromAria(aria) { return _parseAriaLabel(aria).fromName; }
function _hash(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) { h = ((h << 5) + h) ^ str.charCodeAt(i); }
  return (h >>> 0).toString(36);
}

// In-page script: click a folder in the OWA left-nav folder tree by its visible
// label (case-insensitive, trimmed). OWA renders folders as treeitems; we match
// the folder NAME text (ignoring the trailing unread-count badge). Returns
// 'clicked' | 'not-found' | 'error:...'. READ-ONLY — selecting a folder only
// changes the view, it does not modify any mail.
function _buildFolderClickScript(folderName) {
  const want = JSON.stringify(String(folderName || '').trim().toLowerCase());
  return '(function(){\n' +
    '  try {\n' +
    '    var want = ' + want + ';\n' +
    '    if (!want) return "not-found";\n' +
    '    var nodes = document.querySelectorAll(\'[role="treeitem"], [role="option"], nav a, div[role="navigation"] span\');\n' +
    '    function labelOf(el){\n' +
    '      var t = (el.getAttribute("aria-label")||el.getAttribute("title")||el.innerText||"").trim();\n' +
    '      // strip a trailing numeric unread/total count badge, e.g. "DOMO 57" / "Inbox 1492".\n' +
    '      t = t.replace(/\\s+\\d[\\d,]*\\s*$/,"").trim();\n' +
    '      // some builds append ", <n> unread/items"; cut at the first comma.\n' +
    '      var comma = t.indexOf(","); if (comma > 0) t = t.slice(0, comma).trim();\n' +
    '      return t.toLowerCase();\n' +
    '    }\n' +
    '    for (var i=0;i<nodes.length;i++){\n' +
    '      if (labelOf(nodes[i]) === want){\n' +
    '        var click = nodes[i].querySelector(\'a,span,[role="button"]\') || nodes[i];\n' +
    '        click.click();\n' +
    '        return "clicked";\n' +
    '      }\n' +
    '    }\n' +
    '    return "not-found";\n' +
    '  } catch(e){ return "error:"+String(e&&e.message||e); }\n' +
    '})();';
}

// Read the top `max` messages currently visible in the OWA message list (the
// active folder), opening each to pull body + attachments. Returns an array of
// normalized email records tagged with `folder`. Pure DOM reads via the window.
async function _readRowsInWindow(win, max, folderLabel) {
  const emails = [];
  // Wait for the message list of the active folder to render.
  const listReady = await _waitFor(win, ROW_SELECTOR, 30, 1000);
  if (!listReady) return emails;
  await _sleep(1200); // let the virtualized list settle

  let rowDescs = [];
  try {
    const rawRows = await win.webContents.executeJavaScript(_buildRowScanScript(max));
    const parsed = JSON.parse(rawRows);
    if (Array.isArray(parsed)) rowDescs = parsed;
  } catch (e) { logger.warn('[owa-reader] row scan failed (' + folderLabel + '): ' + e.message); }

  // Build each email PRIMARILY from the row aria-label, which (confirmed
  // against the live mailbox) already contains sender + subject + time + a body
  // preview. This is far more robust than clicking each row open and scraping
  // the reading pane (whose selectors vary wildly between OWA builds). We then
  // OPTIONALLY open each row to enrich the body with full text — but only when
  // opening actually yields more than the preview; otherwise we keep the
  // aria-derived content. Row open failures are non-fatal.
  const count = Math.min(rowDescs.length || max, max);
  for (let i = 0; i < count; i++) {
    if (win.isDestroyed()) break;
    const rowDesc = rowDescs[i] || { index: i };
    const parsedAria = _parseAriaLabel(rowDesc.aria || '');
    // Require a real email signature: a sender name AND a subject/preview. Skip
    // anything that doesn't look like a message row (prevents chrome leaking in).
    if (!parsedAria.fromName && !parsedAria.subject && !parsedAria.preview) continue;

    const base = {
      subject: parsedAria.subject || '(no subject)',
      from: '',                       // OWA rows don't expose the address; name only
      fromName: parsedAria.fromName || '',
      receivedText: parsedAria.receivedText || '',
      bodyText: parsedAria.preview || '',
      attachments: rowDesc.hasAttach ? [{ name: 'attachment', ext: '' }] : [],
    };

    // Best-effort body enrichment via opening the message (non-fatal).
    try {
      await win.webContents.executeJavaScript(_buildOpenAndReadScript(rowDesc.index != null ? rowDesc.index : i));
      await _sleep(800);
      const rawRead = await win.webContents.executeJavaScript(_buildReadPaneScript());
      const pane = JSON.parse(rawRead);
      if (pane && !pane.error) {
        // Only trust reading-pane fields when they look real (not chrome). The
        // body is accepted when it's clearly longer than the preview.
        const paneBody = String(pane.bodyText || '').trim();
        if (paneBody && paneBody.length > base.bodyText.length && !/^navigation pane$/i.test(String(pane.subject || ''))) {
          base.bodyText = paneBody.slice(0, 8000);
        }
        // Prefer a real email address if the pane exposed one.
        const paneFrom = String(pane.from || '').trim();
        if (/@/.test(paneFrom)) base.from = paneFrom.toLowerCase();
        // Keep aria subject unless the pane subject is clearly a real one.
        const paneSubj = String(pane.subject || '').trim();
        if (paneSubj && !/^(navigation pane|reading pane|folder pane)$/i.test(paneSubj) && paneSubj.length > 3 && base.subject === '(no subject)') {
          base.subject = paneSubj;
        }
        if (Array.isArray(pane.attachments) && pane.attachments.length) base.attachments = pane.attachments;
      }
    } catch (e) {
      logger.warn('[owa-reader] enrich msg ' + i + ' failed (non-fatal, ' + folderLabel + '): ' + e.message);
    }

    const email = _normalizeEmail(base, rowDesc);
    email.folder = folderLabel || 'Inbox';
    emails.push(email);
  }
  return emails;
}

/**
 * readInbox(opts) -> Promise<{ ok, authBlocked, emails:[...], error?, readAt }>
 *
 * opts: {
 *   max?:number (default 25) — total emails across all folders,
 *   folders?:string[] (default ['Inbox']) — folder display names to scan, in
 *     order. "Inbox" loads the inbox URL; any other name is selected by
 *     clicking the matching folder in the OWA left-nav tree,
 *   timeoutMs?, _electron?
 * }
 *
 * Opens ONE hidden OWA window, warms the session, then for each configured
 * folder reads the top messages (full body + attachment names), aggregating +
 * de-duping by stable id across folders. Never mutates the mailbox. On an auth
 * wall, returns { ok:false, authBlocked:true } honestly.
 */
async function readInbox(opts) {
  opts = opts || {};
  const electron = opts._electron || require('electron');
  const { BrowserWindow, session } = electron;
  const max = Number.isFinite(opts.max) ? Math.max(1, Math.min(50, opts.max)) : 25;
  const timeoutMs = opts.timeoutMs || 240000;
  // Folders to scan, in order. Default: just the Inbox. Dedup + normalize.
  let folders = Array.isArray(opts.folders) && opts.folders.length
    ? opts.folders.map((f) => String(f || '').trim()).filter(Boolean)
    : ['Inbox'];
  folders = Array.from(new Set(folders));
  const result = { ok: false, authBlocked: false, emails: [], error: null, readAt: null, folders };

  // 1) Silent warmup first (same self-heal the mailer uses). An auth wall here
  //    means genuine interactive MFA/consent is required — stop honestly.
  try {
    const warm = await owa.warmOwaSession({ _electron: electron, timeoutMs: opts.warmupTimeoutMs || 60000 });
    if (warm && warm.authWall) {
      result.error = 'auth wall (warmup): ' + (warm.url || '');
      result.authBlocked = true;
      result.readAt = new Date().toISOString();
      return result;
    }
  } catch (e) {
    logger.warn('[owa-reader] warmup threw (non-fatal): ' + (e && e.message));
  }

  return new Promise((resolve) => {
    let win; let done = false; let started = false;
    const cleanup = () => { try { if (win && !win.isDestroyed()) win.close(); } catch (_) {} };
    const settle = (over) => {
      if (done) return; done = true;
      cleanup();
      result.readAt = new Date().toISOString();
      resolve(Object.assign(result, over || {}));
    };

    // Aggregate across folders, deduped by stable id (first folder wins the tag).
    const byId = {};
    const addEmails = (list) => { for (const em of list) { if (!byId[em.id]) byId[em.id] = em; } };
    const collected = () => Object.keys(byId).map((k) => byId[k]);

    // Sequentially read each configured folder in the SAME window.
    const runFolders = async () => {
      let remaining = max;
      for (const folder of folders) {
        if (win.isDestroyed() || remaining <= 0) break;
        try {
          if (/^inbox$/i.test(folder)) {
            if (!/\/mail\/inbox/i.test(win.webContents.getURL())) {
              win.loadURL(INBOX_URL);
              await _sleep(2500);
            }
          } else {
            const r = await win.webContents.executeJavaScript(_buildFolderClickScript(folder));
            if (r !== 'clicked') {
              logger.warn('[owa-reader] folder not found in nav: ' + folder + ' (' + r + ')');
              continue;
            }
            await _sleep(2000); // folder switch + list re-render
          }
          const got = await _readRowsInWindow(win, remaining, folder);
          addEmails(got);
          remaining = max - Object.keys(byId).length;
        } catch (e) {
          logger.warn('[owa-reader] folder read failed (' + folder + '): ' + e.message);
        }
      }
      const emails = collected();
      settle({ ok: emails.length > 0, emails, error: emails.length ? null : 'no messages read' });
    };

    try {
      win = new BrowserWindow({
        width: 1280, height: 900,
        show: false, x: -32000, y: -32000, skipTaskbar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.on('show', () => { try { win.hide(); } catch (_) {} });

      const hardTimeout = setTimeout(() => { settle({ ok: collected().length > 0, emails: collected(), error: 'overall timeout' }); }, timeoutMs);

      // Auth-wall grace: an SSO hop may momentarily pass a login host; only
      // conclude blocked-auth if we're STILL stuck after a grace window.
      let authGrace = null;
      const AUTH_GRACE_MS = 12000;
      const onNav = (_e, url) => {
        if (done) return;
        if (OUTLOOK_HOST_RE.test(url || '')) { if (authGrace) { clearTimeout(authGrace); authGrace = null; } return; }
        if (AUTH_HOST_RE.test(url || '')) {
          if (authGrace) return;
          authGrace = setTimeout(() => {
            if (done) return;
            let cur = '';
            try { cur = win && !win.isDestroyed() ? win.webContents.getURL() : ''; } catch (_) {}
            if (AUTH_HOST_RE.test(cur) && !OUTLOOK_HOST_RE.test(cur)) {
              clearTimeout(hardTimeout);
              settle({ ok: false, authBlocked: true, error: 'auth wall (stuck): ' + cur });
            }
          }, AUTH_GRACE_MS);
        }
      };
      win.webContents.on('did-navigate', onNav);
      win.webContents.on('did-redirect-navigation', onNav);
      win.webContents.on('did-fail-load', (_e, code, desc) => {
        if (code === -3) return; // normal SPA abort
        if (done) return;
        logger.warn('[owa-reader] load failed: ' + desc);
      });

      win.webContents.on('did-finish-load', async () => {
        if (done || started) return;
        let curUrl = '';
        try { curUrl = win.webContents.getURL(); } catch (_) {}
        if (AUTH_HOST_RE.test(curUrl) && !OUTLOOK_HOST_RE.test(curUrl)) return; // wait for grace/redirect
        if (!MAILBOX_RE.test(curUrl)) return; // wait for the real mailbox
        // Reached the mailbox — drive the folder sequence exactly once.
        started = true;
        clearTimeout(hardTimeout);
        try {
          await runFolders();
        } catch (e) {
          settle({ ok: collected().length > 0, emails: collected(), error: 'exception: ' + e.message });
        }
      });

      win.loadURL(INBOX_URL);
    } catch (e) {
      settle({ ok: false, error: 'window error: ' + e.message });
    }
  });
}

// ── DELETE (move to Deleted Items) ─────────────────────────────────────────────
// In-page script: find the message row by its conversation id (data-convid),
// select it, then click a Delete control to move it to Deleted Items (NOT a
// permanent erase — fully recoverable). Several selector fallbacks are tried
// because OWA markup shifts between builds; a right-click context menu and the
// Delete keyboard shortcut are last-resort fallbacks. Returns a status string:
//   'deleted' | 'row-not-found' | 'no-delete-control' | 'still-present' | 'error:..'
// STEP 1: find + SELECT the target row (so OWA renders the toolbar Delete
// button, which only exists once a message is selected). convIds contain '/'
// and '=' which break CSS attribute selectors, so we match by iterating rows and
// comparing getAttribute('data-convid') exactly (no CSS escaping needed).
function _buildSelectRowScript(convId) {
  const cid = JSON.stringify(String(convId || ''));
  return '(function(){\n' +
    '  try {\n' +
    '    var cid = ' + cid + ';\n' +
    '    if (!cid) return "row-not-found";\n' +
    '    var rows = document.querySelectorAll(' + JSON.stringify(ROW_SELECTOR) + ');\n' +
    '    var row = null;\n' +
    '    for (var i=0;i<rows.length;i++){ if (rows[i].getAttribute("data-convid") === cid){ row = rows[i]; break; } }\n' +
    '    if (!row) return "row-not-found";\n' +
    '    var sel = row.querySelector(\'[role="button"], a, span\') || row;\n' +
    '    sel.click();\n' +
    '    try { row.scrollIntoView({block:"center"}); } catch(e){}\n' +
    '    return "selected";\n' +
    '  } catch(e){ return "error:"+String(e&&e.message||e); }\n' +
    '})();';
}

// STEP 2: click the (now-rendered) Delete control. Confirmed against the live
// build: a toolbar BUTTON with aria-label="Delete", or an <i> icon
// data-icon-name="DeleteRegularLight" whose closest button we click. Keyboard
// Delete is the final fallback.
function _buildDeleteClickScript() {
  return '(function(){\n' +
    '  try {\n' +
    '    // 1) Toolbar/command-bar Delete button (exact aria-label="Delete").\n' +
    '    var btn = document.querySelector(\'button[aria-label="Delete"]\')\n' +
    '           || document.querySelector(\'button[aria-label^="Delete" i]\')\n' +
    '           || document.querySelector(\'[role="menuitem"][aria-label^="Delete" i]\');\n' +
    '    if (btn) { btn.click(); return "clicked:button"; }\n' +
    '    // 2) The Delete icon (DeleteRegularLight) — click its enclosing button.\n' +
    '    var ic = document.querySelector(\'i[data-icon-name*="Delete" i], span[data-icon-name*="Delete" i]\');\n' +
    '    if (ic) { var b = ic.closest("button,[role=button]") || ic; b.click(); return "clicked:icon"; }\n' +
    '    // 3) Keyboard Delete as last resort.\n' +
    '    var ev = new KeyboardEvent("keydown", { key:"Delete", code:"Delete", keyCode:46, which:46, bubbles:true });\n' +
    '    (document.activeElement||document.body).dispatchEvent(ev);\n' +
    '    return "clicked:key";\n' +
    '  } catch(e){ return "error:"+String(e&&e.message||e); }\n' +
    '})();';
}

// Is the Delete control present yet? (used to poll after selecting a row)
function _buildDeleteReadyScript() {
  return '(function(){ try { return (document.querySelector(\'button[aria-label="Delete"], button[aria-label^="Delete" i], i[data-icon-name*="Delete" i]\') ? "yes" : "no"); } catch(e){ return "no"; } })();';
}

function _buildStillPresentScript(convId) {
  const cid = JSON.stringify(String(convId || ''));
  return '(function(){ try { var cid=' + cid + '; var rows=document.querySelectorAll(' + JSON.stringify(ROW_SELECTOR) + '); for (var i=0;i<rows.length;i++){ if (rows[i].getAttribute("data-convid")===cid) return "present"; } return "gone"; } catch(e){ return "err"; } })();';
}

/**
 * deleteMessage(opts) -> Promise<{ ok, status, error? }>
 * opts: { convId (required), folder?, _electron? }
 * Opens the hidden mailbox (warming the session first), navigates to the folder
 * the message is in, moves the message to Deleted Items, and verifies the row
 * is gone. Reversible (Deleted Items), confirm-gated by the caller.
 */
async function deleteMessage(opts) {
  opts = opts || {};
  const electron = opts._electron || require('electron');
  const { BrowserWindow, session } = electron;
  const convId = String(opts.convId || '').trim();
  const folder = String(opts.folder || 'Inbox').trim() || 'Inbox';
  if (!convId) return { ok: false, status: 'no-convid', error: 'convId required' };

  try {
    const warm = await owa.warmOwaSession({ _electron: electron, timeoutMs: 60000 });
    if (warm && warm.authWall) return { ok: false, status: 'blocked-auth', error: 'OWA needs sign-in' };
  } catch (_) {}

  return new Promise((resolve) => {
    let win; let done = false; let started = false;
    const settle = (o) => { if (done) return; done = true; try { if (win && !win.isDestroyed()) win.close(); } catch (_) {} resolve(o); };
    try {
      win = new BrowserWindow({ width: 1280, height: 900, show: false, x: -32000, y: -32000, skipTaskbar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession } });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.on('show', () => { try { win.hide(); } catch (_) {} });
      const t = setTimeout(() => settle({ ok: false, status: 'timeout', error: 'delete timeout' }), 90000);
      win.webContents.on('did-finish-load', async () => {
        if (done || started) return;
        let url = ''; try { url = win.webContents.getURL(); } catch (_) {}
        if (AUTH_HOST_RE.test(url) && !OUTLOOK_HOST_RE.test(url)) return;
        if (!MAILBOX_RE.test(url)) return;
        started = true;
        try {
          // Navigate to the right folder first (so the row is in the list).
          if (!/^inbox$/i.test(folder)) {
            await _sleep(1500);
            const r = await win.webContents.executeJavaScript(_buildFolderClickScript(folder));
            if (r === 'clicked') await _sleep(2000);
          }
          await _waitFor(win, ROW_SELECTOR, 20, 1000);
          await _sleep(800);
          // STEP 1: select the target row so the toolbar Delete button renders.
          const selRes = await win.webContents.executeJavaScript(_buildSelectRowScript(convId));
          if (selRes === 'row-not-found') { clearTimeout(t); settle({ ok: false, status: 'row-not-found', error: 'message not found in ' + folder + ' (already moved?)' }); return; }
          if (typeof selRes === 'string' && selRes.indexOf('error:') === 0) { clearTimeout(t); settle({ ok: false, status: 'error', error: selRes }); return; }
          // STEP 2: wait for the Delete control to appear (it only renders after
          // a message is selected), then click it.
          let ready = 'no';
          for (let k = 0; k < 15; k++) {
            try { ready = await win.webContents.executeJavaScript(_buildDeleteReadyScript()); } catch (_) {}
            if (ready === 'yes') break;
            await _sleep(400);
          }
          if (ready !== 'yes') { clearTimeout(t); settle({ ok: false, status: 'no-delete-control', error: 'Delete control did not appear after selecting the message' }); return; }
          const clickRes = await win.webContents.executeJavaScript(_buildDeleteClickScript());
          if (typeof clickRes === 'string' && clickRes.indexOf('error:') === 0) { clearTimeout(t); settle({ ok: false, status: 'error', error: clickRes }); return; }
          logger.info('[owa-reader] delete click: ' + clickRes);
          // Verify the row disappeared from the list.
          await _sleep(1800);
          let gone = 'present';
          try { gone = await win.webContents.executeJavaScript(_buildStillPresentScript(convId)); } catch (_) {}
          clearTimeout(t);
          if (gone === 'gone') settle({ ok: true, status: 'deleted' });
          else settle({ ok: false, status: 'still-present', error: 'could not confirm the message was deleted (the Delete control may not have matched this Outlook build)' });
        } catch (e) {
          clearTimeout(t);
          settle({ ok: false, status: 'error', error: e.message });
        }
      });
      win.loadURL(INBOX_URL);
    } catch (e) { settle({ ok: false, status: 'error', error: 'window error: ' + e.message }); }
  });
}

// ── DIAGNOSTIC: probe the live OWA inbox DOM ───────────────────────────────────
// Opens the hidden mailbox and dumps what our selectors actually see — the raw
// aria-label of the first several message rows, plus whether key candidate
// selectors match anything. Read-only, no clicks beyond loading /mail/inbox.
// Used to tune the real selectors against the user's actual OWA build instead
// of guessing. Returns { ok, authBlocked, url, rows:[{aria,text,convId}], probes:{...}, error? }.
function _buildProbeScript() {
  return '(function(){\n' +
    '  try {\n' +
    '    function count(sel){ try { return document.querySelectorAll(sel).length; } catch(e){ return -1; } }\n' +
    '    var rowSel = ' + JSON.stringify(ROW_SELECTOR) + ';\n' +
    '    var rows = document.querySelectorAll(rowSel);\n' +
    '    var sample = [];\n' +
    '    for (var i=0;i<rows.length && sample.length<8;i++){\n' +
    '      var r = rows[i];\n' +
    '      sample.push({\n' +
    '        aria: (r.getAttribute("aria-label")||"").slice(0,300),\n' +
    '        text: (r.innerText||"").replace(/\\s+/g," ").slice(0,200),\n' +
    '        convId: r.getAttribute("data-convid")||"",\n' +
    '        tag: r.tagName + "." + (r.className||"").toString().slice(0,60)\n' +
    '      });\n' +
    '    }\n' +
    '    var probes = {\n' +
    '      "role=option[aria-label]": count(\'div[role="option"][aria-label]\'),\n' +
    '      "data-convid": count("div[data-convid]"),\n' +
    '      "role=listitem": count(\'div[role="listitem"]\'),\n' +
    '      "mailto links": count(\'a[href^="mailto:"]\'),\n' +
    '      "role=heading": count(\'[role="heading"]\'),\n' +
    '      "title has @": count(\'[title*="@"]\'),\n' +
    '      "delete aria-label": count(\'[aria-label*="Delete" i]\'),\n' +
    '      "delete title": count(\'[title*="Delete" i]\'),\n' +
    '      "delete icon": count(\'[data-icon-name*="Delete" i]\')\n' +
    '    };\n' +
    '    // Dump actual delete-ish controls so the real selector can be matched.\n' +
    '    var delCtrls = [];\n' +
    '    var cands = document.querySelectorAll(\'button,[role="button"],[role="menuitem"],i,span\');\n' +
    '    for (var di=0; di<cands.length && delCtrls.length<25; di++){\n' +
    '      var c = cands[di];\n' +
    '      var al = (c.getAttribute("aria-label")||"");\n' +
    '      var ti = (c.getAttribute("title")||"");\n' +
    '      var ic = (c.getAttribute("data-icon-name")||"");\n' +
    '      var blob = (al+" "+ti+" "+ic);\n' +
    '      if (/delete|trash|discard/i.test(blob)){\n' +
    '        delCtrls.push({ tag:c.tagName, role:c.getAttribute("role")||"", aria:al.slice(0,60), title:ti.slice(0,60), icon:ic.slice(0,40), cls:(c.className||"").toString().slice(0,50) });\n' +
    '      }\n' +
    '    }\n' +
    '    // Also dump the first row\'s inner buttons (hover actions live here).\n' +
    '    var firstRowBtns = [];\n' +
    '    if (rows[0]){\n' +
    '      var rb = rows[0].querySelectorAll(\'button,[role="button"],i[data-icon-name],span[data-icon-name]\');\n' +
    '      for (var ri=0; ri<rb.length && firstRowBtns.length<20; ri++){\n' +
    '        firstRowBtns.push({ tag:rb[ri].tagName, aria:(rb[ri].getAttribute("aria-label")||"").slice(0,50), title:(rb[ri].getAttribute("title")||"").slice(0,50), icon:(rb[ri].getAttribute("data-icon-name")||"").slice(0,40) });\n' +
    '      }\n' +
    '    }\n' +
    '    return JSON.stringify({ rowCount: rows.length, sample: sample, probes: probes, deleteControls: delCtrls, firstRowButtons: firstRowBtns, title: document.title });\n' +
    '  } catch(e){ return JSON.stringify({error:String(e&&e.message||e)}); }\n' +
    '})();';
}

async function probeInbox(opts) {
  opts = opts || {};
  const electron = opts._electron || require('electron');
  const { BrowserWindow, session } = electron;
  const out = { ok: false, authBlocked: false, url: null, data: null, error: null };
  try {
    const warm = await owa.warmOwaSession({ _electron: electron, timeoutMs: 60000 });
    if (warm && warm.authWall) { out.authBlocked = true; out.error = 'auth wall'; return out; }
  } catch (_) {}
  return new Promise((resolve) => {
    let win; let done = false;
    const settle = (o) => { if (done) return; done = true; try { if (win && !win.isDestroyed()) win.close(); } catch (_) {} resolve(Object.assign(out, o || {})); };
    try {
      win = new BrowserWindow({ width: 1280, height: 900, show: false, x: -32000, y: -32000, skipTaskbar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession } });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.on('show', () => { try { win.hide(); } catch (_) {} });
      const t = setTimeout(() => settle({ error: 'timeout' }), 90000);
      win.webContents.on('did-finish-load', async () => {
        if (done) return;
        let url = ''; try { url = win.webContents.getURL(); } catch (_) {}
        out.url = url;
        if (AUTH_HOST_RE.test(url) && !OUTLOOK_HOST_RE.test(url)) return;
        if (!MAILBOX_RE.test(url)) return;
        await _sleep(3500);
        try {
          // Select the first row first — OWA's toolbar Delete button and the
          // per-row hover-action delete only render once a message is selected,
          // so probing without selecting would miss them.
          await win.webContents.executeJavaScript(
            '(function(){try{var rows=document.querySelectorAll(' + JSON.stringify(ROW_SELECTOR) + ');' +
            'if(rows[0]){var s=rows[0].querySelector(\'[role="button"],a,span\')||rows[0];s.click();' +
            'rows[0].dispatchEvent(new MouseEvent("mouseover",{bubbles:true}));}return "ok";}catch(e){return "err";}})();'
          );
          await _sleep(1500);
          const raw = await win.webContents.executeJavaScript(_buildProbeScript());
          clearTimeout(t);
          settle({ ok: true, data: JSON.parse(raw) });
        } catch (e) { clearTimeout(t); settle({ error: e.message }); }
      });
      win.loadURL(INBOX_URL);
    } catch (e) { settle({ error: 'window error: ' + e.message }); }
  });
}

module.exports = {
  readInbox,
  probeInbox,
  deleteMessage,
  // exported for tests / reuse
  _normalizeEmail,
  _attachmentType,
  _parseAriaLabel,
  _guessSender,
  _buildSelectRowScript,
  _buildDeleteClickScript,
  _subjectFromAria,
  _nameFromAria,
  _hash,
  _buildFolderClickScript,
  _readRowsInWindow,
  ROW_SELECTOR,
  INBOX_URL,
};
