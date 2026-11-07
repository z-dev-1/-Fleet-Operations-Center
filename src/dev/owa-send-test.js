'use strict';
/**
 * dev/owa-send-test.js — DEV-ONLY, double-env-gated LIVE self-addressed SEND test for Email Triage
 * (spike findings .agents/tasks/fleet-version-c-spike-owa-api-2026-11-07/). It answers the user's
 * follow-up ("did you already sent the email i did not recieve it? and you should do multiple tests
 * with attachements and html also abd plkaain text") by sending exactly THREE self-addressed messages
 * (plain text, HTML, HTML+attachments) through OWA's own REST API, with NO browser page per call.
 *
 * It runs ONLY when BOTH FLEET_OWA_PROBE_DIR and FLEET_OWA_PROBE_SEND=1 are set. The only recipient it
 * will ever accept is the user's OWN address (emailIntelConfig me.addresses[0]); anything else — any
 * other recipient, any CC/BCC, a missing/empty self address — is refused before a single request.
 *
 * Transport: Tier 1 (Electron main-process net.request on session.defaultSession — the recommended,
 * most windowless tier that worked for GET), reusing the bearer + x-anchormailbox captured in memory
 * from the hidden OWA page, plus the session cookies. Endpoint: POST https://<host>/api/v2.0/me/
 * sendmail with { Message:{…, ToRecipients, Attachments}, SaveToSentItems:true } — the same v2.0 REST
 * family and host (outlook.cloud.microsoft) that answered the GETs with 200.
 *
 * It lives in src/dev/ (NOT src/email-intel/**) on purpose: the R8.6 source guard forbids the v2.0 /
 * service.svc endpoint strings under src/email-intel. SOS/EOS (src/scheduler/**, owa-mailer.js) and
 * every auth module are never touched or called.
 *
 * Redaction: no token, cookie or header value is ever written to the JSON or the log. Addresses are
 * masked everywhere; the output exposes only a boolean `recipientIsSelf`.
 */
const fs = require('fs');
const path = require('path');

const ENV_DIR = 'FLEET_OWA_PROBE_DIR';
const ENV_SEND = 'FLEET_OWA_PROBE_SEND';

// The v2.0 REST send endpoint, on the SAME host/family that returned 200 for the GET probes.
const SENDMAIL_PATH = '/api/v2.0/me/sendmail';
// Read-back (verification) paths — GET only.
const SENTITEMS_PATH = '/api/v2.0/me/mailfolders/sentitems/messages';
const INBOX_PATH = '/api/v2.0/me/mailfolders/inbox/messages';
const MESSAGES_PATH = '/api/v2.0/me/messages';

const OUTLOOK_HOSTS = Object.freeze(['outlook.cloud.microsoft', 'outlook.office.com', 'outlook.office365.com']);
const DEFAULT_HOST = 'outlook.cloud.microsoft';

const ATTACHMENT_ODATA_TYPE = '#Microsoft.OutlookServices.FileAttachment';
const MAX_ATTACHMENT_BYTES = 50 * 1024;              // each attachment stays well under 50 KB
const SEND_TIMEOUT_MS = 30_000;
const VERIFY_WINDOW_MS = 60_000;                     // verify arrival within 60 s of a send
const VERIFY_POLL_MS = 3_000;

// The three test messages. Subjects are fixed so a relaunch can skip whatever already landed.
const TEST_SUBJECTS = Object.freeze([
  'FOC API send test 1/3 \u2013 plain text \u2013 ignore',
  'FOC API send test 2/3 \u2013 HTML \u2013 ignore',
  'FOC API send test 3/3 \u2013 attachments \u2013 ignore',
]);

// ───────────────────────────── redaction / masking ─────────────────────────────
const ADDRESS_RE = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g;

/** maskAddress('jane@corp.test') -> 'j***@corp.test'. Empty/invalid -> '' or '***'. Never the raw value. */
function maskAddress(addr) {
  const s = String(addr == null ? '' : addr).trim();
  const at = s.indexOf('@');
  if (at < 1) return s ? '***' : '';
  return s[0] + '***' + s.slice(at);
}

/** Replace any address-looking token inside free text with a masked form. */
function maskText(s) {
  return String(s == null ? '' : s).replace(ADDRESS_RE, (m) => maskAddress(m));
}

// ───────────────────────────── host allow-list ─────────────────────────────
function hostAllowed(hostOrUrl) {
  let h = String(hostOrUrl || '').toLowerCase();
  if (h.includes('://') || h.startsWith('//')) { try { h = new URL(h.startsWith('//') ? 'https:' + h : h).hostname.toLowerCase(); } catch (_) { return false; } }
  h = h.split('/')[0].split(':')[0];
  return OUTLOOK_HOSTS.some((x) => h === x || h.endsWith('.' + x));
}

// ───────────────────────────── synthetic attachments (in memory, no real data) ─────────────────────────────
/** A small plain-text attachment (a few lines). */
function buildTxtAttachment() {
  const content = [
    'FOC API send test attachment.',
    'This is synthetic text generated in-memory by the dev harness.',
    'No real fleet data. Safe to ignore and delete.',
  ].join('\r\n') + '\r\n';
  return _fileAttachment('foc-send-test.txt', 'text/plain', Buffer.from(content, 'utf8'));
}

/** A tiny CSV attachment with a header and exactly 3 data rows. */
function buildCsvAttachment() {
  const rows = [
    'id,label,value',
    '1,alpha,100',
    '2,bravo,200',
    '3,charlie,300',
  ];
  return _fileAttachment('foc-send-test.csv', 'text/csv', Buffer.from(rows.join('\r\n') + '\r\n', 'utf8'));
}

/**
 * buildMinimalPdf() — a hand-built, single-page PDF with a correct cross-reference table. No deps.
 * Returns a Buffer whose bytes start with '%PDF-' and end with '%%EOF', and whose xref offsets point
 * at each object. pdfjs-dist / any conformant parser accepts it.
 */
function buildMinimalPdf() {
  const header = '%PDF-1.4\n';
  // Four objects: Catalog, Pages, Page, Contents (a tiny text stream).
  const streamBody = 'BT /F1 18 Tf 72 720 Td (FOC API send test - ignore) Tj ET';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length ' + Buffer.byteLength(streamBody, 'latin1') + ' >>\nstream\n' + streamBody + '\nendstream\nendobj\n',
  ];
  // Build the body while tracking each object's byte offset from the start of the file.
  let body = header;
  const offsets = [];
  for (const obj of objects) { offsets.push(Buffer.byteLength(body, 'latin1')); body += obj; }
  const xrefStart = Buffer.byteLength(body, 'latin1');
  const pad = (n) => String(n).padStart(10, '0');
  let xref = 'xref\n0 ' + (objects.length + 1) + '\n';
  xref += '0000000000 65535 f \n';
  for (const off of offsets) xref += pad(off) + ' 00000 n \n';
  const trailer = 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF';
  return Buffer.from(body + xref + trailer, 'latin1');
}

/**
 * buildMinimalPng() — a tiny valid 1x1 PNG (generated in code). Used as an optional 4th attachment.
 * The bytes are a fixed, well-formed PNG; no remote fetch, no real data.
 */
function buildMinimalPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
}

/** Build a v2.0 REST FileAttachment from a buffer; refuses anything over the 50 KB cap. */
function _fileAttachment(name, contentType, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'utf8');
  if (b.length >= MAX_ATTACHMENT_BYTES) throw new Error('attachment-too-large:' + name);
  return {
    '@odata.type': ATTACHMENT_ODATA_TYPE,
    Name: name,
    ContentType: contentType,
    ContentBytes: b.toString('base64'),
    _bytes: b.length,                 // internal only; stripped before the request is built
  };
}

/** The three synthetic attachments for test (c): .txt, .csv, minimal .pdf, and an optional .png. */
function buildTestAttachments() {
  return [buildTxtAttachment(), buildCsvAttachment(), _pdfAttachment(), buildMinimalPng && _pngAttachment()].filter(Boolean);
}
function _pdfAttachment() { return _fileAttachment('foc-send-test.pdf', 'application/pdf', buildMinimalPdf()); }
function _pngAttachment() { return _fileAttachment('foc-send-test.png', 'image/png', buildMinimalPng()); }

// ───────────────────────────── message payloads ─────────────────────────────
const HTML_BODY =
  '<html><body>' +
  '<h2>FOC API send test</h2>' +
  '<p>This is a <b>self-addressed</b> API send test. Please ignore.</p>' +
  '<table border="1" cellpadding="4"><tr><th>A</th><th>B</th></tr>' +
  '<tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>' +
  '<p><a href="https://example.com">example.com</a></p>' +
  '</body></html>';

/**
 * buildSendPayload(index, selfAddress) -> the { Message, SaveToSentItems } body for sendmail. The ONLY
 * recipient is `selfAddress`; there is no CC and no BCC field, ever. Throws unless selfAddress is a
 * non-empty string that looks like an address.
 */
function buildSendPayload(index, selfAddress) {
  const self = String(selfAddress == null ? '' : selfAddress).trim();
  if (!self || !/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(self)) throw new Error('no-self-address');
  const Message = {
    Subject: TEST_SUBJECTS[index],
    ToRecipients: [{ EmailAddress: { Address: self } }],
  };
  if (index === 0) {
    Message.Body = { ContentType: 'Text', Content: 'test plain text' };
  } else if (index === 1) {
    Message.Body = { ContentType: 'HTML', Content: HTML_BODY };
  } else if (index === 2) {
    Message.Body = { ContentType: 'HTML', Content: HTML_BODY };
    Message.Attachments = buildTestAttachments().map((a) => { const c = Object.assign({}, a); delete c._bytes; return c; });
  } else {
    throw new Error('bad-test-index:' + index);
  }
  return { Message, SaveToSentItems: true };
}

/**
 * assertRecipientsAreSelf(payload, selfAddress) — the hard recipient guard. Throws unless the payload
 * has EXACTLY one ToRecipient equal to selfAddress and no CC/BCC. Called right before every send.
 */
function assertRecipientsAreSelf(payload, selfAddress) {
  const self = String(selfAddress == null ? '' : selfAddress).trim().toLowerCase();
  if (!self) throw new Error('refused:no-self-address');
  const msg = payload && payload.Message;
  if (!msg || typeof msg !== 'object') throw new Error('refused:no-message');
  const to = Array.isArray(msg.ToRecipients) ? msg.ToRecipients : [];
  if (to.length !== 1) throw new Error('refused:recipient-count-' + to.length);
  const addr = to[0] && to[0].EmailAddress && String(to[0].EmailAddress.Address || '').trim().toLowerCase();
  if (addr !== self) throw new Error('refused:recipient-not-self');
  if (msg.CcRecipients && msg.CcRecipients.length) throw new Error('refused:cc-present');
  if (msg.BccRecipients && msg.BccRecipients.length) throw new Error('refused:bcc-present');
  return true;
}

// ───────────────────────────── output record builders (redacted) ─────────────────────────────
/** Describe the attachments of a payload for the output JSON — names/types/sizes, never bytes. */
function describeAttachments(payload) {
  const list = payload && payload.Message && Array.isArray(payload.Message.Attachments) ? payload.Message.Attachments : [];
  return list.map((a) => ({ name: a.Name, contentType: a.ContentType, bytes: _b64Bytes(a.ContentBytes) }));
}
function _b64Bytes(b64) { try { return Buffer.from(String(b64 || ''), 'base64').length; } catch (_) { return null; } }

/** A per-test record safe to serialize (no bodies, no bytes, masked subject-free — subjects are fixed/safe). */
function buildTestRecord(index, payload) {
  const msg = payload.Message;
  const rec = {
    test: index + 1,
    subject: msg.Subject,                                   // fixed "ignore" subject — no user data
    contentType: msg.Body ? msg.Body.ContentType : null,
    recipientIsSelf: true,                                  // guaranteed by assertRecipientsAreSelf
    saveToSentItems: payload.SaveToSentItems === true,
    attachmentCount: Array.isArray(msg.Attachments) ? msg.Attachments.length : 0,
  };
  if (rec.attachmentCount) rec.attachments = describeAttachments(payload);
  return rec;
}

// ───────────────────────────── Tier 1 transport (main-process net.request) ─────────────────────────────
/**
 * sendOne({ electron, host, headers, payload, timeoutMs }) — ONE POST to sendmail via Electron
 * net.request on the shared session. Returns { status, latencyMs, error? } only; the response body
 * (empty on 202 for sendmail) is read and discarded. redirect:'manual' so a login redirect is caught,
 * not followed. The auth headers are passed in and nulled by the caller after the call.
 */
function sendOne(o) {
  const electron = o.electron;
  const url = 'https://' + o.host + SENDMAIL_PATH;
  const headers = Object.assign({ 'content-type': 'application/json', accept: 'application/json' }, o.headers || {});
  const bodyStr = JSON.stringify(o.payload);
  const timeoutMs = Math.max(1, Number.isFinite(o.timeoutMs) ? o.timeoutMs : SEND_TIMEOUT_MS);
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); v.latencyMs = Date.now() - t0; resolve(v); };
    if (!hostAllowed(url)) { resolve({ status: 0, error: 'host-blocked', latencyMs: 0 }); return; }
    let req;
    let timer = null;
    try {
      req = electron.net.request({ method: 'POST', url, session: electron.session.defaultSession, useSessionCookies: true, credentials: 'include', redirect: 'manual' });
    } catch (e) { resolve({ status: 0, error: _errName(e), latencyMs: Date.now() - t0 }); return; }
    timer = setTimeout(() => { try { req.abort(); } catch (_) { /* aborting */ } done({ status: 0, error: 'timeout' }); }, timeoutMs);
    req.on('redirect', (statusCode) => { done({ status: Number(statusCode) || 302, redirect: true }); try { req.abort(); } catch (_) { /* aborting */ } });
    req.on('response', (res) => {
      let n = 0; res.on('data', (c) => { n += c.length; });     // drain, never keep
      res.on('end', () => done({ status: res.statusCode }));
    });
    req.on('abort', () => done({ status: 0, error: 'aborted' }));
    req.on('error', (e) => done({ status: 0, error: _errName(e) }));
    for (const k of Object.keys(headers)) { if (headers[k] != null) { try { req.setHeader(k, headers[k]); } catch (_) { /* rejected */ } } }
    try { req.write(bodyStr); } catch (_) { /* fallthrough */ }
    req.end();
  });
}

/**
 * getJson({ electron, host, pathAndQuery, headers, timeoutMs }) — ONE read-only GET; returns
 * { status, json, latencyMs }. Used by verification and the pre-send "already landed?" check.
 */
function getJson(o) {
  const electron = o.electron;
  const url = 'https://' + o.host + o.pathAndQuery;
  const headers = Object.assign({ accept: 'application/json' }, o.headers || {});
  const timeoutMs = Math.max(1, Number.isFinite(o.timeoutMs) ? o.timeoutMs : SEND_TIMEOUT_MS);
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); v.latencyMs = Date.now() - t0; resolve(v); };
    if (!hostAllowed(url)) { resolve({ status: 0, error: 'host-blocked', latencyMs: 0 }); return; }
    let req;
    let timer = null;
    try {
      req = electron.net.request({ method: 'GET', url, session: electron.session.defaultSession, useSessionCookies: true, credentials: 'include', redirect: 'manual' });
    } catch (e) { resolve({ status: 0, error: _errName(e), latencyMs: Date.now() - t0 }); return; }
    let data = ''; let n = 0;
    timer = setTimeout(() => { try { req.abort(); } catch (_) { /* aborting */ } done({ status: 0, error: 'timeout' }); }, timeoutMs);
    req.on('redirect', (statusCode) => { done({ status: Number(statusCode) || 302, redirect: true }); try { req.abort(); } catch (_) { /* aborting */ } });
    req.on('response', (res) => {
      res.on('data', (c) => { n += c.length; if (n <= 512 * 1024) data += c.toString('utf8'); });
      res.on('end', () => { let j = null; try { j = JSON.parse(data); } catch (_) { /* non-json */ } data = ''; done({ status: res.statusCode, json: j }); });
    });
    req.on('abort', () => done({ status: 0, error: 'aborted' }));
    req.on('error', (e) => done({ status: 0, error: _errName(e) }));
    for (const k of Object.keys(headers)) { if (headers[k] != null) { try { req.setHeader(k, headers[k]); } catch (_) { /* rejected */ } } }
    req.end();
  });
}

// ───────────────────────────── verification / reconcile ─────────────────────────────
const _odFilter = (subject) => "?$filter=" + encodeURIComponent("Subject eq '" + String(subject).replace(/'/g, "''") + "'") + '&$top=5&$select=Id,Subject,HasAttachments,Body&$orderby=ReceivedDateTime desc';

/**
 * findBySubject({ electron, host, headers, subject, folderPath }) -> { found, status, id?, hasAttachments?,
 * bodyContentType? }. A read-only GET filtered by the exact (fixed) subject. Used both to verify arrival
 * and to decide, before sending, whether a test already landed in Sent Items (skip-if-present).
 */
async function findBySubject(o) {
  const r = await getJson({ electron: o.electron, host: o.host, headers: o.headers, pathAndQuery: (o.folderPath || SENTITEMS_PATH) + _odFilter(o.subject), timeoutMs: o.timeoutMs });
  if (r.status !== 200 || !r.json) return { found: false, status: r.status, latencyMs: r.latencyMs };
  const items = Array.isArray(r.json.value) ? r.json.value : [];
  const hit = items.find((m) => String(m.Subject || '') === String(o.subject));
  if (!hit) return { found: false, status: 200, latencyMs: r.latencyMs };
  return {
    found: true, status: 200, id: hit.Id, latencyMs: r.latencyMs,
    hasAttachments: hit.HasAttachments === true,
    bodyContentType: hit.Body && hit.Body.ContentType ? hit.Body.ContentType : null,
  };
}

/** Read an item's attachment metadata (names, types, sizes) — never the bytes. */
async function getAttachmentsMeta(o) {
  const q = '/' + encodeURIComponent(o.id) + '/attachments?$select=Name,ContentType,Size';
  const r = await getJson({ electron: o.electron, host: o.host, headers: o.headers, pathAndQuery: MESSAGES_PATH + q, timeoutMs: o.timeoutMs });
  if (r.status !== 200 || !r.json) return { status: r.status, attachments: [] };
  const list = Array.isArray(r.json.value) ? r.json.value : [];
  return { status: 200, attachments: list.map((a) => ({ name: a.Name, contentType: a.ContentType, size: Number(a.Size) || null })) };
}

/**
 * verifyArrival({ electron, host, headers, subject, wantAttachments, deadline, sleep }) — polls Sent
 * Items then Inbox by subject until found or the 60 s window elapses. Returns a redacted record with
 * where it landed, HTTP status, latency, preserved body ContentType, and (when wantAttachments) the
 * attachment count/names/sizes from the attachments endpoint.
 */
async function verifyArrival(o) {
  const sleep = o.sleep || _sleep;
  const deadline = Number.isFinite(o.deadline) ? o.deadline : (Date.now() + VERIFY_WINDOW_MS);
  const started = Date.now();
  let last = { found: false, status: null };
  let where = null;
  while (Date.now() < deadline) {
    const sent = await findBySubject({ electron: o.electron, host: o.host, headers: o.headers, subject: o.subject, folderPath: SENTITEMS_PATH, timeoutMs: o.timeoutMs });
    last = sent;
    if (sent.found) { where = 'sentitems'; break; }
    const inbox = await findBySubject({ electron: o.electron, host: o.host, headers: o.headers, subject: o.subject, folderPath: INBOX_PATH, timeoutMs: o.timeoutMs });
    last = inbox;
    if (inbox.found) { where = 'inbox'; break; }
    if (Date.now() + VERIFY_POLL_MS >= deadline) break;
    await sleep(VERIFY_POLL_MS);
  }
  const rec = {
    verified: !!where,
    where,
    status: last.status,
    verifyLatencyMs: Date.now() - started,
    bodyContentTypePreserved: where ? (last.bodyContentType || null) : null,
  };
  if (where && o.wantAttachments && last.id) {
    const meta = await getAttachmentsMeta({ electron: o.electron, host: o.host, headers: o.headers, id: last.id, timeoutMs: o.timeoutMs });
    rec.attachmentStatus = meta.status;
    rec.attachmentCount = meta.attachments.length;
    rec.attachmentsObserved = meta.attachments;
  }
  return rec;
}

// ───────────────────────────── the run ─────────────────────────────
/**
 * runSendTest(deps) — the ONLY entry point. deps:
 *   { electron, headers()|headers, selfAddress, dir, log, _now, _sleep, timeoutMs, verifyWindowMs }
 * `headers` supplies the captured bearer + x-anchormailbox (+ cookies are added by useSessionCookies).
 *
 * Returns { ok, sent, results, skipped } and (when dir is set) writes owa-probe-send-<ts>.json. It
 * stops at the FIRST failure, never resends blindly, and skips a test whose subject is already in
 * Sent Items (so a relaunch only retries what did not land). It logs `[owa-probe] send done` in every
 * terminal case, including a stop-after-failure (the failure is recorded in the JSON).
 */
async function runSendTest(deps) {
  const d = deps || {};
  const log = _logger(d.log);
  const dir = d.dir;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const electron = d.electron;
  const sleep = d._sleep || _sleep;
  const timeoutMs = Number.isFinite(d.timeoutMs) ? d.timeoutMs : SEND_TIMEOUT_MS;
  const verifyWindowMs = Number.isFinite(d.verifyWindowMs) ? d.verifyWindowMs : VERIFY_WINDOW_MS;

  // Resolve + validate the self address. A missing/empty self address refuses the whole run.
  const selfAddress = String(d.selfAddress == null ? '' : d.selfAddress).trim();
  const host = (d.host && hostAllowed(d.host)) ? d.host : DEFAULT_HOST;

  const out = {
    at: new Date().toISOString(),
    transport: 'tier1-electron-net.request',
    endpoint: 'POST ' + SENDMAIL_PATH,
    host,
    recipientIsSelf: null,
    selfAddressMasked: maskAddress(selfAddress),
    results: [],
  };

  const finish = (ok, extra) => {
    Object.assign(out, extra || {});
    out.ok = !!ok;
    if (dir) { try { _writeJson(dir, 'owa-probe-send-' + ts + '.json', out); } catch (e) { log.warn('[owa-probe] send write failed: ' + _errName(e)); } }
    log.info('[owa-probe] send done');
    return out;
  };

  if (!selfAddress || !/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(selfAddress)) {
    out.recipientIsSelf = false;
    return finish(false, { refused: 'no-self-address', sent: 0 });
  }
  out.recipientIsSelf = true;

  if (!electron || !electron.net || !electron.session) {
    return finish(false, { refused: 'electron-unavailable', sent: 0 });
  }

  const headers = () => {
    const h = typeof d.headers === 'function' ? d.headers() : (d.headers || {});
    // Only the allow-listed auth headers ever leave here; cookies ride useSessionCookies.
    const out2 = {};
    for (const k of Object.keys(h || {})) {
      const name = String(k).toLowerCase();
      if (name === 'authorization' || name === 'x-anchormailbox' || name === 'x-owa-canary') { if (h[k]) out2[name] = h[k]; }
    }
    return out2;
  };

  let sent = 0;
  const skipped = [];
  try {
    for (let i = 0; i < 3; i++) {
      const subject = TEST_SUBJECTS[i];
      const h = headers();
      // Skip-if-already-landed: a relaunch must not duplicate a test that already reached Sent Items.
      const pre = await findBySubject({ electron, host, headers: h, subject, folderPath: SENTITEMS_PATH, timeoutMs });
      for (const k of Object.keys(h)) h[k] = null;
      if (pre.found) {
        skipped.push(i + 1);
        out.results.push({ test: i + 1, subject, skipped: true, reason: 'already-in-sent-items', bodyContentTypePreserved: pre.bodyContentType || null });
        continue;
      }

      const payload = buildSendPayload(i, selfAddress);
      assertRecipientsAreSelf(payload, selfAddress);             // hard guard immediately before the send
      const record = buildTestRecord(i, payload);

      const sh = headers();
      const sendRes = await sendOne({ electron, host, headers: sh, payload, timeoutMs });
      for (const k of Object.keys(sh)) sh[k] = null;
      record.httpStatus = sendRes.status;
      record.sendLatencyMs = sendRes.latencyMs;

      const sendOk = sendRes.status === 202 || sendRes.status === 200;
      const uncertain = !sendOk && (sendRes.error === 'timeout' || sendRes.error === 'aborted' || sendRes.status === 0);

      // Verify arrival (always check Sent Items first — also the only safe check after an uncertain send).
      const vh = headers();
      const verify = await verifyArrival({ electron, host, headers: vh, subject, wantAttachments: i === 2, deadline: Date.now() + verifyWindowMs, timeoutMs, sleep });
      for (const k of Object.keys(vh)) vh[k] = null;
      Object.assign(record, verify);
      record.uncertainSend = uncertain;

      out.results.push(record);

      if (verify.verified) { sent++; continue; }

      // Not verified. Stop at the first failure. NEVER resend blindly (we already checked Sent Items).
      record.failed = true;
      record.failureReason = uncertain ? 'uncertain-send-not-found-in-sent-items' : ('send-status-' + sendRes.status + (sendRes.error ? ':' + sendRes.error : ''));
      return finish(false, { sent, skipped, stoppedAt: i + 1, failure: { test: i + 1, reason: record.failureReason } });
    }
  } catch (e) {
    return finish(false, { sent, skipped, error: _errName(e) });
  }

  return finish(true, { sent, skipped });
}

// ───────────────────────────── gate ─────────────────────────────
/** engaged(env) — true ONLY when both the probe dir and the explicit send flag are set. */
function engaged(env) {
  const e = env || process.env;
  return !!e[ENV_DIR] && e[ENV_SEND] === '1';
}

// ───────────────────────────── helpers ─────────────────────────────
function _sleep(ms) { return new Promise((r) => { const t = setTimeout(r, Math.max(0, ms)); if (t && t.unref) t.unref(); }); }
function _writeJson(dir, name, obj) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* exists */ }
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 1));
}
function _logger(log) {
  if (log && typeof log.info === 'function') return log;
  try { return require('../utils/logger')('owa-probe'); } catch (_) { return { info() {}, warn() {}, error() {} }; }
}
function _errName(e) {
  const name = (e && typeof e === 'object' && e.name) ? String(e.name) : 'Error';
  const msg = (e && typeof e === 'object' && e.message) ? ':' + String(e.message) : '';
  return (name + msg).replace(/[^A-Za-z0-9_:.@-]/g, '').replace(ADDRESS_RE, '<addr>').slice(0, 80);
}

module.exports = {
  runSendTest,
  engaged,
  ENV_DIR,
  ENV_SEND,
  OUTLOOK_HOSTS,
  SENDMAIL_PATH,
  TEST_SUBJECTS,
  // builders / guards (exported for unit tests)
  maskAddress,
  maskText,
  hostAllowed,
  buildSendPayload,
  assertRecipientsAreSelf,
  buildTestRecord,
  describeAttachments,
  buildTxtAttachment,
  buildCsvAttachment,
  buildMinimalPdf,
  buildMinimalPng,
  buildTestAttachments,
  findBySubject,
  getAttachmentsMeta,
  verifyArrival,
  sendOne,
  getJson,
};
