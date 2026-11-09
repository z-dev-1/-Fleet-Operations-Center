'use strict';
/**
 * email-intel/transport/sent-items.js — read-only Sent Items search and bounded post-send polling (design 8.5).
 *
 *   strategiesFor(q)                       the search strategies the query supports, in order
 *   findSent(http, q, strategies, spec?)   -> { found:true, matchedBy, internetMessageId } | { found:false, complete }
 *   verifySent(http, q, { timeoutMs, pollMs, sleep, now, spec })  -> { found, matchedBy? } (ignores `complete`)
 *
 * Strategies: 'imid' (exact InternetMessageId, one page), 'conversation-marker' and 'subject-marker' (marker
 * substring of Body.Content, paged by @odata.nextLink up to SENT_PAGES_MAX pages / SENT_ITEMS_MAX items; a too-large
 * page restarts the strategy at SENT_TOP_SMALL with a SENT_PAGES_HARD_MAX cap). `complete` is true only when every
 * strategy that ran searched to the end of its results; a strategy rejected with 400 is skipped, and a lookup in
 * which nothing ran is never complete. `spec` (signal, deadlineAt) is merged into every request (R4-M5).
 * GET only. Never sends.
 */
const { TC } = require('./constants');
const endpoints = require('./endpoints');
const E = require('./errors');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const str = (v) => (typeof v === 'string' && v ? v : null);

function strategiesFor(q) {
  const x = q || {};
  return [str(x.internetMessageId) && 'imid', str(x.conversationId) && str(x.marker) && 'conversation-marker', str(x.subject) && str(x.marker) && 'subject-marker'].filter(Boolean);
}

function _items(r) { return r && r.json && Array.isArray(r.json.value) ? r.json.value : []; }
function _hasMarker(item, marker) {
  const b = item && item.Body && typeof item.Body.Content === 'string' ? item.Body.Content : '';
  return !!marker && b.includes(marker);
}

async function _scanList(http, first, marker, owaRe, spec) {
  let small = false;
  let path = first(TC.SENT_TOP); let pages = 0; let items = 0;
  for (;;) {
    let r;
    try {
      r = await http.get(path, Object.assign({ op: 'sent' }, spec));
    } catch (e) {
      if (e instanceof E.ResponseTooLargeError) {
        if (small) return { ran: true, complete: false };
        small = true; path = first(TC.SENT_TOP_SMALL); pages = 0; items = 0;
        continue;
      }
      throw e;
    }
    pages++;
    const v = _items(r);
    items += v.length;
    const hit = v.find((it) => _hasMarker(it, marker));
    if (hit) return { ran: true, found: true, item: hit };
    const next = r.json && r.json['@odata.nextLink'];
    if (!next) return { ran: true, complete: true };
    if (items >= TC.SENT_ITEMS_MAX || pages >= (small ? TC.SENT_PAGES_HARD_MAX : TC.SENT_PAGES_MAX)) return { ran: true, complete: false, pages };
    path = endpoints.rebaseNextLink(next, owaRe && owaRe.OUTLOOK_HOST_RE);
    if (!path) { logger.info('[email-api] op=sent err=nextlink-host'); return { ran: true, complete: false }; }
  }
}

async function findSent(http, q, strategies, spec, owaRe) {
  const list = Array.isArray(strategies) ? strategies : [];
  if (!list.length) throw new E.RequestRefusedError('no-strategy');
  const re = owaRe || _owaRe();
  const searched = [];
  for (const s of list) {
    let res;
    try {
      if (s === 'imid') {
        const r = await http.get(endpoints.sentByInternetMessageId(q.internetMessageId), Object.assign({ op: 'sent' }, spec));
        const v = _items(r).filter((it) => it && it.InternetMessageId === q.internetMessageId);
        res = v.length ? { ran: true, found: true, item: v[0] } : { ran: true, complete: true };
      } else if (s === 'conversation-marker') {
        res = await _scanList(http, (top) => endpoints.sentByConversation(q.conversationId, top), q.marker, re, spec);
      } else if (s === 'subject-marker') {
        res = await _scanList(http, (top) => endpoints.sentBySubject(q.subject, top), q.marker, re, spec);
      } else continue;
    } catch (e) {
      if (e instanceof E.ApiHttpError && e.status === 400) { searched.push({ ran: false, rejected: true }); continue; }
      throw e;
    }
    if (res.found) {
      const imid = res.item && typeof res.item.InternetMessageId === 'string' ? res.item.InternetMessageId : null;
      return { found: true, matchedBy: s, internetMessageId: imid };
    }
    searched.push(res);
  }
  const ran = searched.filter((x) => x.ran);
  return { found: false, complete: ran.length > 0 && ran.every((x) => x.complete === true) };
}

async function verifySent(http, q, o) {
  const opts = o || {};
  const strategies = strategiesFor(q);
  if (!strategies.length) return { found: false };
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : TC.VERIFY_TIMEOUT_MS;
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : TC.VERIFY_POLL_MS;
  const until = now() + timeoutMs;
  for (;;) {
    try {
      const r = await findSent(http, q, strategies, opts.spec);
      if (r.found) return r;
    } catch (e) {
      if (e instanceof E.ApiAuthBlockedError || e instanceof E.AbortedError) return { found: false, error: e.code };
    }
    if (now() + pollMs > until) return { found: false };
    await sleep(pollMs);
  }
}

function _owaRe() {
  try { return require('../../scrapers/owa-mailer'); } catch (_) { return null; }
}

module.exports = { strategiesFor, findSent, verifySent };
