'use strict';
/**
 * email-intel/reply/owa_reply.js — reply INSIDE the real Outlook conversation through the message's own Reply /
 * Reply all control (design 6.4; R5.4, R5.6, R5.9, AC-8, F-11, F-21). Called ONLY by the confirmed send-reply
 * executor (token + native dialog), never directly from IPC.
 *
 *   sendThreadReply({ convId, folder, mode, expected:{ to, cc }, html, bodyText, marker, subjectNorm,
 *                     attemptHooks:{ beforeSendClick() -> bool }, signal,
 *                     _electron, _warm, _sleep, _waitFor, _verify, timeoutMs, verifyTimeoutMs, authGraceMs })
 *     -> { status, mechanism:'owa-thread', detail:{ code?, diff?, sentItemsMatch?, where? } }
 *   status: sent | delivery-uncertain | failed-before-send | recipient-mismatch | mechanism-unavailable | blocked-auth
 *
 * Same hidden window and authorized session as the reader (capture/owa_capture.openSession: show:false, offscreen,
 * popups denied, no new endpoint). Steps:
 *   1. select the folder and open the conversation row; read the pane snapshot
 *   2. capability: the pane must expose an exact 'Reply' / 'Reply all' control, else mechanism-unavailable before any
 *      compose is opened (nothing changed; the UI offers the labeled "New message (not threaded)" fallback)
 *   3. click the control of the NEWEST expanded block (F-21); wait <= 10 s for the inline editor, else
 *      failed-before-send COMPOSE_NOT_INLINE (nothing typed)
 *   4. recipient verification (AC-8): To and Cc wells must equal the confirmed sets, else recipient-mismatch with
 *      { missing, extra } (returned to the UI, never logged) BEFORE any text is inserted or Send is clicked
 *   5. prepend the body above OWA's quoted conversation (F-11) and verify: quote hash unchanged, text grew by at
 *      least the inserted text, marker present; else failed-before-send INSERT_UNVERIFIED (compose discarded)
 *   6. Send button probe (disabled or missing -> failed-before-send; no keyboard fallback here); beforeSendClick()
 *      persists the attempt as 'sending'; the click follows immediately
 *   7. Sent Items verification (existing _verifySentItems). A click without a Sent Items match is ALWAYS
 *      delivery-uncertain, whatever else happened (auth wall, timeout, abort, window gone).
 * No retry exists anywhere here. All waits are bounded (120 s total, 75 s verification).
 */
const owaMailer = require('../../scrapers/owa-mailer');
const capturePs = require('../capture/page-scripts');
const { parseAddressList } = require('../capture/parse-snapshot');
const { compareSets } = require('./recipients');
const ps = require('./page-scripts');
const C = require('../constants');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const SEND_TIMEOUT_MS = 120_000;
const VERIFY_TIMEOUT_MS = 75_000;
const EDITOR_WAIT_ATTEMPTS = 10;
const EDITOR_WAIT_MS = 1_000;

function _parseWell(cands) {
  const out = [];
  for (const c of (Array.isArray(cands) ? cands : [])) {
    const src = [c && c.title, c && c.aria, c && c.text].filter(Boolean);
    let got = null;
    for (const s of src) { const list = parseAddressList(s); const withAddr = list.find((e) => e.address); got = withAddr || got || list[0] || null; if (withAddr) break; }
    if (got && !out.some((e) => (e.address && got.address ? e.address === got.address : e.name === got.name))) out.push(got);
  }
  return out;
}

/** Parsed compose recipients (main process) from the collector output. */
function parseComposeRecipients(raw) {
  if (!raw || raw.error || !raw.found || !raw.found.to) return null;
  return { to: _parseWell(raw.to), cc: _parseWell(raw.cc) };
}

/** compare the confirmed set with what OWA produced, To and Cc separately (a CC moved into To is a difference). */
function recipientDiff(expected, actual) {
  const t = compareSets((expected && expected.to) || [], (actual && actual.to) || []);
  const c = compareSets((expected && expected.cc) || [], (actual && actual.cc) || []);
  const tag = (list, role) => list.map((e) => ({ name: e.name || '', address: e.address || null, role }));
  return { equal: t.equal && c.equal, missing: tag(t.missing, 'to').concat(tag(c.missing, 'cc')), extra: tag(t.extra, 'to').concat(tag(c.extra, 'cc')) };
}

const _nonWs = (s) => String(s == null ? '' : s).replace(/\s+/g, '').length;

async function sendThreadReply(opts) {
  const o = opts || {};
  const mode = o.mode === 'reply-all' ? 'reply-all' : 'reply';
  const waitFor = o._waitFor || owaMailer._waitFor;
  const verify = o._verify || owaMailer._verifySentItems;
  const sig = { result: null, clickIssued: false, sendClicked: false, sentItemsFound: false, sentItemsMatch: null, where: null };
  const done = (status, detail) => { if (!sig.result) sig.result = { status, detail: detail || {} }; };

  const session = await require('../capture/owa_capture').openSession({
    _electron: o._electron, _warm: o._warm, _sleep: o._sleep, signal: o.signal, authGraceMs: o.authGraceMs,
    timeoutMs: Number.isFinite(o.timeoutMs) ? o.timeoutMs : SEND_TIMEOUT_MS,
  }, async (ctx) => {
    // 1. open the conversation
    const folder = o.folder || 'Inbox';
    if ((await ctx.selectFolder(folder)) !== 'selected') return done('failed-before-send', { code: 'FOLDER_NOT_FOUND' });
    const open = await ctx.execJson(capturePs.buildOpenRowScript({ convId: o.convId }));
    if (!open || open.status !== 'opened') return done('failed-before-send', { code: 'ROW_NOT_FOUND' });
    await ctx.sleep(C.OPEN_WAIT_MS);
    const snap = await ctx.execJson(capturePs.buildPaneCollector({ maxBlocks: C.MAX_PANE_BLOCKS }));
    // 2. capability check before any compose is opened
    if (!snap || snap.error || !ps.hasReplyControl(snap.buttons, mode)) return done('mechanism-unavailable', { code: 'NO_REPLY_CONTROL' });
    // 3. the newest block's control (F-21)
    const click = await ctx.execJson(ps.buildReplyControlClickScript(mode));
    if (!click || click.status !== 'clicked') return done('mechanism-unavailable', { code: 'NO_REPLY_CONTROL' });
    sig.where = click.where;
    if (!(await waitFor(ctx.win, owaMailer.EDITOR_SELECTOR, EDITOR_WAIT_ATTEMPTS, EDITOR_WAIT_MS))) return done('failed-before-send', { code: 'COMPOSE_NOT_INLINE' });
    // 4. recipient verification (AC-8) before inserting text or clicking Send
    const actual = parseComposeRecipients(await ctx.execJson(ps.buildComposeRecipientsCollector()));
    if (!actual) return done('failed-before-send', { code: 'RECIPIENTS_UNREADABLE' });
    const diff = recipientDiff(o.expected, actual);
    if (!diff.equal) return done('recipient-mismatch', { code: 'RECIPIENT_MISMATCH', diff: { missing: diff.missing, extra: diff.extra } });
    // 5. prepend above the quoted conversation (F-11) and verify the quote is intact
    const minAdded = Math.max(1, Math.floor(_nonWs(o.bodyText) * 0.9));
    const prep = await ctx.execJson(ps.buildPrependScript(o.html, { marker: o.marker }));
    const v = ps.verifyPrepend(prep, minAdded);
    if (!v.ok) return done('failed-before-send', { code: v.code, why: v.why });
    // 6. Send button, persisted 'sending', click
    const probe = await ctx.exec(owaMailer._buildSendButtonProbeScript());
    if (probe !== 'enabled') return done('failed-before-send', { code: probe === 'disabled' ? 'SEND_DISABLED' : 'SEND_NOT_FOUND' });
    let persisted = false;
    try { persisted = !!(o.attemptHooks && typeof o.attemptHooks.beforeSendClick === 'function' && o.attemptHooks.beforeSendClick()); } catch (_) { persisted = false; }
    if (!persisted) return done('failed-before-send', { code: 'ATTEMPT_NOT_PERSISTED' });
    sig.clickIssued = true;
    const clicked = await ctx.exec(owaMailer._buildSendClickScript());
    if (clicked !== 'clicked' && clicked !== 'clicked-keyboard') { sig.clickIssued = false; return done('failed-before-send', { code: 'SEND_NOT_CLICKED' }); }
    sig.sendClicked = true;
    // 7. Sent Items verification (the window navigates to Sent Items; nothing else is clicked)
    const recipients = [].concat((o.expected && o.expected.to) || [], (o.expected && o.expected.cc) || []).map((e) => e.address).filter(Boolean);
    const m = await verify(ctx.win, { marker: o.marker, normSubject: o.subjectNorm, recipients, timeoutMs: Number.isFinite(o.verifyTimeoutMs) ? o.verifyTimeoutMs : VERIFY_TIMEOUT_MS });
    sig.sentItemsFound = !!(m && m.found);
    sig.sentItemsMatch = m ? { found: !!m.found, matchedBy: m.matchedBy || null, at: m.at || null } : null;
    return done(sig.sentItemsFound ? 'sent' : 'delivery-uncertain', { sentItemsMatch: sig.sentItemsMatch });
  });

  const st = (session && session.settled) || {};
  let out;
  if (sig.clickIssued) {
    // A click without a Sent Items match is always delivery-uncertain (never blocked-auth, never failed).
    out = { status: sig.sentItemsFound ? 'sent' : 'delivery-uncertain', detail: { sentItemsMatch: sig.sentItemsMatch, code: sig.sentItemsFound ? undefined : (st.error ? 'UNCONFIRMED_' + String(st.error).toUpperCase().replace(/[^A-Z]/g, '_') : 'NOT_IN_SENT_ITEMS') } };
  } else if (st.authBlocked) {
    out = { status: 'blocked-auth', detail: { code: 'AUTH_WALL' } };
  } else if (sig.result) {
    out = sig.result;
  } else {
    out = { status: 'failed-before-send', detail: { code: st.timedOut ? 'TIMEOUT' : st.aborted ? 'ABORTED' : 'WINDOW_' + String(st.error || 'error').toUpperCase().replace(/[^A-Z]/g, '_') } };
  }
  if (sig.where) out.detail.where = sig.where;
  logger.info('[email-intel] thread reply mode=' + mode + ' status=' + out.status + (out.detail.code ? ' code=' + out.detail.code : '') + (out.detail.diff ? ' missing=' + out.detail.diff.missing.length + ' extra=' + out.detail.diff.extra.length : ''));
  return Object.assign({ mechanism: 'owa-thread' }, out);
}

module.exports = { sendThreadReply, parseComposeRecipients, recipientDiff, SEND_TIMEOUT_MS, VERIFY_TIMEOUT_MS };
