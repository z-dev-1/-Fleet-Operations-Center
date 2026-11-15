'use strict';
/**
 * repair-intel/wo-extract.js — pure, deterministic fact extractor for Relay work
 * requests, Decisiv/ASIST activity notes, DTNA feeds and app text
 * (relay-extract design §3-§4).
 *
 * Every fact is built by _fact(), which rejects a value that is not present in its
 * own snippet ("never invent"). No I/O, no electron, no logging. The vocabulary
 * here is extraction-only (ref shapes, templates); it is not a gate token rule.
 */

const crypto = require('crypto');
const D = require('./wo-extract-dates');

// ── Enums and caps ──────────────────────────────────────────────────────────
const SOURCES = Object.freeze(['relay', 'relaygarage/vendor', 'relaygarage/fas', 'relaygarage/approver', 'decisiv', 'dtna', 'notes', 'email']);
const SIDES = Object.freeze(['amazon', 'vendor', 'dealer', 'oem', 'carrier', 'system', 'unknown']);
const KINDS = Object.freeze(['part', 'order', 'ro', 'case', 'dealerCode', 'decisivDealerId', 'dealer', 'phone', 'contact', 'callAttempt', 'vor',
  'cause', 'correction', 'delayReason', 'estimate', 'leadTime', 'tow', 'fleetnet', 'altId', 'dtnaEvent', 'pmAdded',
  'warranty', 'etcMention', 'partStatus', 'vin']);
const CAPS = Object.freeze({
  facts: 200, events: 150, snippet: 140, relayBlockBytes: 32 * 1024, offsiteBlockBytes: 40 * 1024,
  fleetBytes: 2 * 1024 * 1024, perCommentChars: 20000,
});
const BLOCK_VERSION = 2;
const PRIOR_EPISODE_MS = 3 * 86400000;

const VENDOR_SYSTEM_AUTHORS = ['Amerit', 'COX', 'TA', 'KWNE', 'PETE_STORE', 'CEI', 'DSP_ENTERED', 'FLEETNET', 'VELOCITY'];

// ── Regexes (§4) ────────────────────────────────────────────────────────────
const ORDER_RE = /\border\s*(?:#|no\.?|number)\s*:?\s*(\d{6,14})\b/gi;
const PART_LABEL_RE = /\bpart\s*(?:#|no\.?|number)\s*:?\s*((?=[A-Z0-9-]{0,24}\d)[A-Z0-9][A-Z0-9-]{3,24})\b(?!\s*:)/gi;
const INTL_PART_RE = /\b(\d{7}C\d{1,2})\b/g;
const QTY_RE = /\bQty\.?\s*:?\s*(\d{1,3})\b/i;
const VOR_RE = /\b(?:ordered|it\s+was\s+ordered)\s+VOR\b/i;
const PART_STATUS = [
  ['ordered', /\b(?:was|been|is)\s+ordered\b|\bon\s+order\b/gi],
  ['backorder', /\bback[\s-]?order(?:ed)?\b/gi],
  ['shipped', /\b(?:has|have)\s+shipped\b|\bshipped\s+(?:on|out)\b|\btracking\s+(?:#|number)\s*:?\s*[A-Z0-9]{8,}/gi],
  ['arrived', /\b(?:ha(?:s|ve)\s+)?arrived\b(?![^.]{0,20}\?)|\breceived\s+the\s+parts?\b|\bparts?\s+(?:are|is)\s+(?:in|in\s+stock)\b|\ball\s+required\s+parts\s+(?:have\s+arrived|are\s+(?:currently\s+)?in\s+stock)\b/gi],
];
const STATUS_NEG_RE = /\b(?:not|n't|no|yet\s+to)\b/i;
const RO_RE = /\bR\.?O\.?\s*#\s*:?\s*((?=[A-Z0-9-]{0,20}\d)[A-Z0-9][A-Z0-9-]{2,20})\b/gi;
const AMERIT_RO_RE = /^\d{3}-\d{8}$/;
const SF_LABEL_RE = /\b(?:sale?s?\s?force|SF)\s*case\s*#?\s*:?\s*(\d{8})\b/gi;
const SF_BARE_RE = /(?<![\d|])(000\d{5})(?!\d)/g;
const DECISIV_CASE_RE = /\b(?:asist|decisiv)?\s*case\s*#?\s*:?\s*(2\d{7})\b/gi;
const OEM_CASE_RE = /\bcase\s*#?\s*:?\s*(\d{9})\b/gi;
const OEM_CONTEXT_RE = /dealer|volvo|uptime|oem/i;
const FLEETNET_RE = /\bfleet\s?net\s+(?:per\s+)?(\d{8})\b/gi;
const CASE_ANY_RE = /\bcase\s*#?\s*:?\s*(\d{3,12})\b/gi;
const DEALER_ID_URL_RE = /[?&]dealer_id=([A-Z0-9]{3,12})\b/g;
const DEALER_CODE_RE = /\bDEALER\s+CODE\s*:?\s*((?=[A-Z0-9]{0,8}\d)[A-Z0-9]{3,8})\b/gi;
const WR_DEALER_RE = /tow unit to dealer service shop (.{3,80}?)(?=\s+\d{1,6}\s|\s*\|\||$)/i;
const FAS_DEALER_RE = /\bCalled\s+(.{3,70}?,\s*[A-Z]{2})\s*\((Volvo|Peterbilt|Kenworth|Freightliner|Mack|International)\)\s+at\b/g;
const PHONE_RE = /(?<![\d,])(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-](\d{4})(?![\d,])/g;
const CARRIER_BLOCK_RE = /Carrier contact\s*=/i;
const ROLE_CONTACT_RE = /\b(Service (?:Manager|Advisor|Writer)|Parts (?:Manager|Advisor|Counter)|Shop Foreman|Field Service Advisor)\s+([A-Z][a-z]{1,15}(?:\s[A-Z][a-z]{1,20})?)\b/g;
const SPOKE_RE = /\bspoke (?:with|to) ([A-Z][a-z]{1,15})\b/g;
const FAS_CONTACT_RE = /\bFAS\s*=\s*([A-Z][A-Za-z.' -]{1,40}?)\s*\(([a-z0-9]{2,16})@amazon\.com\)/g;
const CARRIER_CONTACT_RE = /\bCarrier contact\s*=\s*([^\n|]{2,60}?)(?=\s*(?:\||\n|$))/gi;
const AMERIT_CC_RE = /Cause Of Repair:\s*([A-Z][A-Z /&-]{1,30}?)\s+Cause:\s*([\s\S]{1,600}?)\s+Correction:\s*([\s\S]{1,800}?)(?=\s+Cause Of Repair:|$)/gi;
const COX_LL_RE = /Labor Line\s*(\d{1,2})\s*:\s*COMPLAINT:\s*([\s\S]{0,600}?)\s*CAUSE:\s*([\s\S]{0,600}?)\s*CORRECTION:\s*([\s\S]{0,800}?)(?=Labor Line\s*\d{1,2}\s*:|$)/gi;
const APPROVED_V_RE = /\bApproved\s+V(\d{1,2})\s*\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/gi;
const APPROVED_RE = /\bApproved\s+\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/gi;
const REJ_TPL_RE = /Estimate rejection reason:\s*([^\n]{1,80})\s*\n+\s*Details:\s*([\s\S]{0,240})/gi;
const KWNE_REJECT_RE = /\breject\s+\$\s?(\d{1,3}(?:,\d{3})*\.\d{2})/gi;
const TA_SUBMITTED_RES = [
  /\bsubmitted\s+to\s+\d{2,4}\s+(\$[\d ]{4,14})/gi,
  /\bRevised estimate uploaded\b[\s\S]{0,120}?(\$[\d ,.]{4,14})/gi,
  /\bestimate for (\$\s?\d{1,3}(?:,\s?\d{3})*(?:\.\d{2})?)/gi,
];
const DECISIV_APPROVED_RES = [
  /\bEst(?:imate)?\.?\s+Approved\s+\$\s?([\d,]+\.\d{2})/gi,
  /\bTotal authorized:\s*\$\s?([\d,]+\.\d{2})/gi,
];
const AMERIT_DELAY_RE = /\bETC Delay Reason-([A-Z_]{3,40})\b/g;
const COX_CC_RE = /Cannot Complete \(CC\)\.?\s*Selected Reason:\s*(CC\s*-\s*[^.\n]{2,60})/gi;
const LEAD_TIME_RES = [
  /\b(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*(week|day)s?\s+(?:parts?\s+)?lead\s*time\b/gi,
  /\bexpected to take (\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*(week|day)s?\s+to ship\b/gi,
];
const TOW_RE = /\bamz-[a-z0-9]{12,}\b/gi;
const TOW_REQUESTED_RE = /\b(?:FN\s+tow|tow\s+to\s+dealer|Created new FN tow|FNA ticket)\b/i;
const PM_ADDED_RES = [
  /\bPM[\s-]?B\b[^.\n?]{0,40}\b(?:has\s+been|have|was)\s+added\b[^.\n?]{0,40}\b(?:repair order|RO|work order)\b/gi,
  /\badded a PM\s*-\s*B service to the (?:work|repair) order\b/gi,
];
const WARRANTY_RE = /\bwarrant(?:y|ies)\b[^.\n]{0,80}?\b(active|valid|in effect|covered|expired|not covered|void)\b/gi;
const WARRANTY_BOTH_RE = /\bboth\s+(?:are\s+)?expired\b/gi;
const VIN_RE = /\b(?=[A-HJ-NPR-Z0-9]{17}\b)(?=[^\s]*\d)(?=[^\s]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\b/g;
const CALL_RE = /\b(?:called|tried calling|left (?:a )?(?:vm|voicemail)|on hold for \d{1,3} min(?:ute)?s?)\b/i;
const CALL_FAIL_RE = /\bno answer\b|\bon hold\b|\bvoice ?mail\b|\bvm\b|\bno (?:reply|response|call back)\b|\bdid not (?:answer|pick up)\b/i;
const CALL_OK_RE = /\bspoke (?:with|to)\b|\bconfirmed\b/i;
const TA_SIG_RE = /\b\d{1,2} \d{1,2} \d{4} \d{1,2} \d{2} [AP]M\b/;
const DTNA_LINE_RE = /^([A-Z][a-z]{2,8} \d{1,2}, \d{4})(?: at (\d{1,2}):(\d{2}) ([AP])M)? — ([^:]{1,80}): ([\s\S]*)$/;
const DTNA_ENTER_RE = /has (entered|exited) (.{3,80}?) in (.{3,40}?, [A-Z]{2}) at (\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} [AP]M) ([A-Z]{3})/g;
const DTNA_CLOSE_RE = /closed this case as ([A-Za-z -]{3,30}?)(?: \(([^)]{3,60})\))?(?=[.\n]|$| \()/g;
const PART_DESC_RE = (() => { try { return require('./parts-extract')._PART_RE; } catch (_) { return null; } })();

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// ── Small helpers ───────────────────────────────────────────────────────────
function _str(v) { return v == null ? '' : String(v); }
function _iso(ms) { return ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString(); }
function _clip(s, n) { const t = _str(s); return t.length > n ? t.slice(0, n) : t; }
function _normCmp(s) { return _str(s).toLowerCase().replace(/[#,-]/g, '').replace(/\s+/g, ' ').trim(); }
function _sha8(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 8); }

function decodeEntities(t) {
  return _str(t)
    .replace(/&amp;?/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

// Copy of decisiv_api._plain (private there; that module is not loaded here).
function _plain(s) {
  return String(s == null ? '' : s)
    .replace(/<a\b[^>]*>(.*?)<\/a>/gi, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Window of <= CAPS.snippet chars around [start, end), whitespace collapsed.
function _snip(text, start, end) {
  const t = _str(text);
  const len = Math.max(0, end - start);
  const room = Math.max(0, CAPS.snippet - Math.min(len, CAPS.snippet));
  const a = Math.max(0, start - Math.floor(room / 2));
  const b = Math.min(t.length, end + (room - (start - a)));
  let s = t.slice(a, b).replace(/\s+/g, ' ').trim();
  if (s.length > CAPS.snippet) s = s.slice(0, CAPS.snippet).trim();
  return s;
}

// Sentence spans: split at newline / ';' always, at '.' / '!' / '?' followed by space or end
// (not after 'No.' / 'Qty.' / a digit-dot-digit).
function _sentences(text) {
  const t = _str(text);
  const out = [];
  let s = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    let cut = c === '\n' || c === ';';
    if (!cut && (c === '.' || c === '!' || c === '?')) {
      const nx = t[i + 1];
      if (nx === undefined || /\s/.test(nx)) {
        const prev = t.slice(Math.max(0, i - 4), i);
        cut = !(c === '.' && /(?:^|\W)(?:no|qty|st)$/i.test(prev));
      }
    }
    if (cut) { out.push({ start: s, end: i + 1 }); s = i + 1; }
  }
  if (s < t.length) out.push({ start: s, end: t.length });
  return out;
}
function _sentenceAt(sents, i) {
  let lo = 0; let hi = sents.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = sents[mid];
    if (i < s.start) hi = mid - 1; else if (i >= s.end) lo = mid + 1; else return s;
  }
  return { start: 0, end: 0 };
}
function _overlap(spans, start, end) { return spans.some((c) => start < c.end && c.start < end); }

// ── Fact constructor (the "never invent" invariant) ─────────────────────────
// _fact(kind, value, prov, extra) -> Fact | null. extra.snippet + extra.raw are required
// for the check: snippet must contain raw (or String(value)), compared case-insensitively
// after collapsing whitespace and stripping '#', ',' and '-'.
function _fact(kind, value, prov, extra) {
  const p = prov || {};
  const x = Object.assign({}, extra || {});
  if (!KINDS.includes(kind)) return null;
  if (!SOURCES.includes(p.source)) return null;
  const side = x.side || p.side || 'unknown';
  if (!SIDES.includes(side)) return null;
  const snippet = _clip(_str(x.snippet).replace(/\s+/g, ' ').trim(), CAPS.snippet);
  const probe = x.raw != null && x.raw !== '' ? x.raw : (value == null ? '' : String(value));
  if (!snippet || !probe || !_normCmp(snippet).includes(_normCmp(probe))) return null;
  delete x.snippet; delete x.side;
  const at = p.at || null;
  const author = p.author != null ? _clip(p.author, 60) : null;
  const normValue = value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
  const f = {
    id: 'f_' + _sha8([kind, normValue, at || '', p.source, author || '', x.etcKind || '', x.line || '', x.raw || ''].join('|')),
    kind, value: value == null ? null : value, source: p.source, at, author, side, snippet,
  };
  if (p.via && x.via == null) f.via = p.via;
  if (p.episode && x.episode == null) f.episode = p.episode;
  for (const k of Object.keys(x)) if (x[k] !== undefined) f[k] = x[k];
  return f;
}

function _ctx(opts) {
  return { facts: [], ids: new Set(), rejected: 0, truncated: 0, parts: [], opts: opts || {} };
}
function _push(ctx, f) {
  if (!f) { ctx.rejected++; return null; }
  if (ctx.ids.has(f.id)) return null;
  ctx.ids.add(f.id);
  ctx.facts.push(f);
  return f;
}
// Build a fact from a text match: snippet window around [start, end).
function _tf(ctx, kind, value, prov, text, start, end, extra) {
  return _push(ctx, _fact(kind, value, prov, Object.assign({ snippet: _snip(text, start, end) }, extra)));
}
// Structured fact with a synthetic "<field>: <value>" snippet.
function _sf(ctx, kind, value, prov, field, rawValue, extra) {
  const raw = _str(rawValue);
  return _push(ctx, _fact(kind, value, Object.assign({}, prov, { via: (extra && extra.via) || prov.via || 'structured' }),
    Object.assign({ snippet: _clip(field + ': ' + raw, CAPS.snippet), raw: _clip(raw, 100) }, extra)));
}

// ── Author classification (§3.3) ────────────────────────────────────────────
function classifyRelayAuthor(createdBy, opts = {}) {
  const a = _str(createdBy).trim();
  if (a === 'RelayGarage') return { source: 'relay', side: 'system' };
  if (a === 'Fleet Ops Center') return { source: 'relay', side: 'amazon' };
  if (a && (a === _str(opts.vendor).trim() || VENDOR_SYSTEM_AUTHORS.includes(a) || /^[A-Z][A-Z0-9_]{1,15}$/.test(a))) {
    return { source: 'relaygarage/vendor', side: 'vendor' };
  }
  if (/^[a-z][a-z0-9]{2,15}$/.test(a)) return { source: 'relaygarage/fas', side: 'amazon' };
  return { source: 'relay', side: 'unknown' };
}

// ── Shared text pass (§4) ───────────────────────────────────────────────────
function _isTa(text, prov, opts) {
  return prov.author === 'TA' || _str(opts.vendor) === 'TA' || (prov.side === 'vendor' && TA_SIG_RE.test(text));
}

function _textPass(ctx, rawText, prov) {
  const opts = ctx.opts;
  let text = decodeEntities(rawText);
  if (text.length > CAPS.perCommentChars) { text = text.slice(0, CAPS.perCommentChars); ctx.truncated++; }
  if (!text.trim()) return;
  const ta = _isTa(text, prov, opts);
  const sents = _sentences(text);
  const sentOf = (i) => _sentenceAt(sents, i);
  const isFas = prov.source === 'relaygarage/fas';
  const approverProv = isFas ? Object.assign({}, prov, { source: 'relaygarage/approver' }) : prov;
  const vendorWos = (opts.vendorWorkOrderIds || []).map(String);
  const altId = _str(opts.altId).toLowerCase();

  // Orders
  const orders = [];
  for (const m of text.matchAll(ORDER_RE)) {
    const s = m.index + m[0].indexOf(m[1]);
    orders.push({ value: m[1], start: s, end: s + m[1].length });
    _tf(ctx, 'order', m[1], prov, text, m.index, m.index + m[0].length, { raw: m[1] });
  }
  // Parts
  const parts = [];
  // 'Verify if ordered VOR (Y/N):' is a template question, never a VOR statement.
  let vor = null;
  for (const m of text.matchAll(new RegExp(VOR_RE.source, 'gi'))) {
    if (/^\s*\(Y\/N\)/i.test(text.slice(m.index + m[0].length)) || /\bif\s+$/i.test(text.slice(Math.max(0, m.index - 6), m.index))) continue;
    vor = m; break;
  }
  for (const m of text.matchAll(PART_LABEL_RE)) {
    const s = m.index + m[0].length - m[1].length;
    parts.push({ value: m[1].toUpperCase(), raw: m[1], start: s, end: s + m[1].length, mStart: m.index });
  }
  for (const m of text.matchAll(INTL_PART_RE)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    if (!/price\s+is\s+\$/i.test(after) && !/international/i.test(before)) continue;
    parts.push({ value: m[1].toUpperCase(), raw: m[1], start: m.index, end: m.index + m[0].length, mStart: m.index });
  }
  // Part <-> order link: same sentence, counts match one-to-one, each pair within 120 chars.
  const bySent = new Map();
  for (const p of parts) { const s = sentOf(p.start); const k = s.start; if (!bySent.has(k)) bySent.set(k, { s, parts: [], orders: [] }); bySent.get(k).parts.push(p); }
  for (const o of orders) { const s = sentOf(o.start); const k = s.start; if (bySent.has(k)) bySent.get(k).orders.push(o); }
  for (const g of bySent.values()) {
    if (g.parts.length && g.parts.length === g.orders.length) {
      g.parts.forEach((p, i) => { if (Math.abs(g.orders[i].start - p.start) <= 120) p.orderNo = g.orders[i].value; });
    }
  }
  for (const p of parts) {
    const qm = QTY_RE.exec(text.slice(p.end, p.end + 60));
    const s = sentOf(p.start);
    let desc;
    if (PART_DESC_RE) { const dm = PART_DESC_RE.exec(text.slice(s.start, s.end)); if (dm) desc = dm[1].toLowerCase(); }
    const f = _tf(ctx, 'part', p.value, prov, text, p.mStart, p.end, {
      raw: p.raw, qty: qm ? +qm[1] : undefined, orderNo: p.orderNo, desc, vor: vor ? true : undefined,
    });
    if (f) ctx.parts.push(f);
  }
  if (vor) _tf(ctx, 'vor', true, prov, text, vor.index, vor.index + vor[0].length, { raw: vor[0] });
  // Part status statements
  for (const [status, re] of PART_STATUS) {
    for (const m of text.matchAll(re)) {
      if (STATUS_NEG_RE.test(text.slice(Math.max(0, m.index - 25), m.index))) continue;
      const s = sentOf(m.index);
      const inSent = parts.filter((p) => p.start >= s.start && p.start < s.end);
      const open = ctx.parts.map((f) => f.value).filter((v, i, a) => a.indexOf(v) === i);
      let part = null; let unbound;
      if (inSent.length === 1) part = inSent[0].value;
      else if (open.length === 1) part = open[0];
      else unbound = true;
      _tf(ctx, 'partStatus', status, prov, text, m.index, m.index + m[0].length, { raw: m[0], part, unbound, status });
    }
  }
  // RO #
  for (const m of text.matchAll(RO_RE)) {
    const v = m[1].toUpperCase();
    _tf(ctx, 'ro', v, prov, text, m.index, m.index + m[0].length, {
      raw: m[1], isVendorWo: vendorWos.includes(m[1]) || AMERIT_RO_RE.test(m[1]) ? true : undefined,
    });
  }
  // Case ids (three namespaces) + FleetNet
  const caseSpans = [];
  const caseFact = (m, ns, kind = 'case') => {
    const s = m.index + m[0].lastIndexOf(m[1]);
    if (_overlap(caseSpans, s, s + m[1].length)) return;
    caseSpans.push({ start: s, end: s + m[1].length });
    _tf(ctx, kind, m[1], prov, text, m.index, m.index + m[0].length, kind === 'case' ? { raw: m[1], ns } : { raw: m[1] });
  };
  for (const m of text.matchAll(FLEETNET_RE)) caseFact(m, null, 'fleetnet');
  for (const m of text.matchAll(SF_LABEL_RE)) { if (/^000\d{5}$/.test(m[1])) caseFact(m, 'salesforce'); }
  for (const m of text.matchAll(SF_BARE_RE)) caseFact(m, 'salesforce');
  for (const m of text.matchAll(DECISIV_CASE_RE)) caseFact(m, 'decisivCase');
  for (const m of text.matchAll(OEM_CASE_RE)) {
    const ctxTxt = text.slice(Math.max(0, m.index - 120), m.index + m[0].length + 120);
    if (prov.side === 'dealer' || prov.side === 'oem' || OEM_CONTEXT_RE.test(ctxTxt)) caseFact(m, 'oemCase');
  }
  for (const m of text.matchAll(CASE_ANY_RE)) caseFact(m, 'unknown');
  // Dealer code / dealer names
  for (const m of text.matchAll(DEALER_ID_URL_RE)) _tf(ctx, 'dealerCode', m[1], prov, text, m.index, m.index + m[0].length, { raw: m[1], via: 'url' });
  for (const m of text.matchAll(DEALER_CODE_RE)) _tf(ctx, 'dealerCode', m[1].toUpperCase(), prov, text, m.index, m.index + m[0].length, { raw: m[1], via: 'text' });
  const dealerEnds = [];
  if (_str(prov.author) === 'Fleet Ops Center') {
    const m = WR_DEALER_RE.exec(text);
    if (m) {
      const name = m[1].trim();
      _tf(ctx, 'dealer', name, prov, text, m.index, m.index + m[0].length, { raw: name, via: 'wr' });
      dealerEnds.push({ end: m.index + m[0].length, name });
    }
  }
  for (const m of text.matchAll(FAS_DEALER_RE)) {
    const name = m[1].trim();
    _tf(ctx, 'dealer', name, prov, text, m.index, m.index + m[0].length, { raw: name, via: 'fas', oem: m[2] });
    dealerEnds.push({ end: m.index + m[0].length, name, start: m.index });
  }
  // Phones and contacts
  const carrierBlock = CARRIER_BLOCK_RE.test(text);
  for (const m of text.matchAll(PHONE_RE)) {
    const around = text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20);
    if (/,,,/.test(around)) continue;
    const value = m[1] + '-' + m[2] + '-' + m[3];
    const d = dealerEnds.filter((x) => x.end <= m.index && m.index - x.end <= 60).pop();
    const sent = text.slice(sentOf(m.index).start, sentOf(m.index).end);
    const side = carrierBlock ? 'carrier' : (/\buptime\b/i.test(sent) ? 'oem' : (d ? 'dealer' : prov.side));
    _tf(ctx, 'phone', value, prov, text, m.index, m.index + m[0].length, { raw: m[0].trim(), side, dealer: d ? d.name : undefined });
  }
  const hasDealerForm = dealerEnds.length > 0 || /dealer|shop/i.test(text);
  for (const m of text.matchAll(ROLE_CONTACT_RE)) _tf(ctx, 'contact', m[2], prov, text, m.index, m.index + m[0].length, { raw: m[2], role: m[1], side: 'dealer' });
  for (const m of text.matchAll(SPOKE_RE)) _tf(ctx, 'contact', m[1], prov, text, m.index, m.index + m[0].length, { raw: m[1], role: null, side: hasDealerForm ? 'dealer' : 'unknown' });
  for (const m of text.matchAll(FAS_CONTACT_RE)) _tf(ctx, 'contact', m[1].trim(), prov, text, m.index, m.index + m[0].length, { raw: m[1].trim(), role: 'FAS', side: 'amazon' });
  for (const m of text.matchAll(CARRIER_CONTACT_RE)) _tf(ctx, 'contact', m[1].trim(), prov, text, m.index, m.index + m[0].length, { raw: m[1].trim(), role: 'carrier', side: 'carrier' });

  // Templates: cause / correction per labor line
  let line = 0;
  for (const m of text.matchAll(AMERIT_CC_RE)) {
    line++;
    const cause = m[2].trim(); const corr = m[3].trim();
    const cS = m.index + m[0].indexOf(m[2]);
    if (cause) _tf(ctx, 'cause', _clip(cause, 600), prov, text, cS, cS + Math.min(cause.length, 100), { raw: _clip(cause, 100), line, category: m[1].trim() });
    const kS = m.index + m[0].lastIndexOf(m[3]);
    if (corr) _tf(ctx, 'correction', _clip(corr, 600), prov, text, kS, kS + Math.min(corr.length, 100), { raw: _clip(corr, 100), line, category: m[1].trim() });
  }
  const roBefore = (i) => { let r = null; for (const m of text.matchAll(RO_RE)) { if (m.index < i) r = m[1]; } return r; };
  for (const m of text.matchAll(COX_LL_RE)) {
    const ln = +m[1]; const ro = roBefore(m.index) || undefined;
    const complaint = m[2].trim(); const cause = m[3].trim(); const corr = m[4].trim();
    const cs = m.index + m[0].indexOf(cause || ' ', m[0].search(/CAUSE:/i));
    if (cause) _tf(ctx, 'cause', _clip(cause, 600), prov, text, cs, cs + Math.min(cause.length, 100), { raw: _clip(cause, 100), line: ln, ro, desc: complaint ? _clip(complaint, 120) : undefined });
    const ks = m.index + m[0].indexOf(corr || ' ', m[0].search(/CORRECTION:/i));
    if (corr) _tf(ctx, 'correction', _clip(corr, 600), prov, text, ks, ks + Math.min(corr.length, 100), { raw: _clip(corr, 100), line: ln, ro });
  }
  // Vendor delay reasons
  for (const m of text.matchAll(AMERIT_DELAY_RE)) _tf(ctx, 'delayReason', m[1], prov, text, m.index, m.index + m[0].length, { raw: m[1], via: 'amerit' });
  for (const m of text.matchAll(COX_CC_RE)) { const v = m[1].trim(); _tf(ctx, 'delayReason', v, prov, text, m.index, m.index + m[0].length, { raw: v, via: 'cox' }); }
  // Estimates
  const estSpans = [];
  const est = (m, valRaw, status, p, extra = {}) => {
    const s = m.index + m[0].lastIndexOf(valRaw);
    if (_overlap(estSpans, s, s + valRaw.length)) return null;
    estSpans.push({ start: s, end: s + valRaw.length });
    const amt = D.findAmounts(valRaw.startsWith('$') ? valRaw : '$' + valRaw, { ta })[0];
    if (!amt) return null;
    return _tf(ctx, 'estimate', amt.value, p, text, m.index, m.index + m[0].length, Object.assign({ raw: valRaw.trim(), amountStatus: status }, extra));
  };
  for (const re of DECISIV_APPROVED_RES) for (const m of text.matchAll(re)) est(m, m[1], 'approved', prov);
  for (const m of text.matchAll(APPROVED_V_RE)) {
    const rest = text.slice(m.index + m[0].length, sentOf(m.index + m[0].length).end).replace(/^[.\s]+/, '');
    const nextSent = !rest.trim() ? text.slice(m.index + m[0].length).replace(/^[.\s]+/, '').split(/(?<=[.!?])\s/)[0] : rest;
    est(m, m[2], 'approved', approverProv, { v: +m[1], reason: _clip(nextSent.trim(), 120) || undefined });
  }
  for (const m of text.matchAll(APPROVED_RE)) est(m, m[1], 'approved', approverProv);
  for (const m of text.matchAll(REJ_TPL_RE)) {
    const details = m[2];
    const status = /\bTemp\s+reject/i.test(details) ? 'temp-reject' : (/\bReject(?:ed)?\b/i.test(details) ? 'rejected' : 'rejected');
    const a = D.findAmounts(details, { ta })[0];
    const reason = m[1].trim();
    if (a) {
      const s = m.index + m[0].indexOf(details) + a.start;
      estSpans.push({ start: s, end: s + a.raw.length });
      _tf(ctx, 'estimate', a.value, approverProv, text, m.index, Math.min(m.index + m[0].length, s + a.raw.length), { raw: a.raw, amountStatus: status, reason, citedAmount: a.value });
    } else {
      _tf(ctx, 'estimate', null, approverProv, text, m.index, m.index + m[0].length, { raw: reason, amountStatus: status, reason });
    }
  }
  for (const m of text.matchAll(KWNE_REJECT_RE)) est(m, m[1], 'rejected', approverProv);
  for (const re of TA_SUBMITTED_RES) for (const m of text.matchAll(re)) est(m, m[1].trim(), 'submitted', prov);

  // ETC mentions, negations, markers (§5, §6)
  const scan = D.scanEtc(text, { at: prov.at, ta });
  const refIn = (s) => {
    const r = parts.find((p) => p.start >= s.start && p.start < s.end) || orders.find((o) => o.start >= s.start && o.start < s.end);
    return r ? r.value : undefined;
  };
  for (const mm of scan.mentions) {
    _tf(ctx, 'etcMention', mm.ymd, prov, text, mm.start, mm.end, {
      raw: mm.raw, etcKind: mm.kind, tentative: mm.tentative, approx: mm.approx, relative: mm.relative, pos: mm.start,
    });
  }
  for (const n of scan.negated) {
    _tf(ctx, 'etcMention', null, prov, text, n.start, n.end, { raw: n.phrase, etcKind: n.kind, negated: true, ref: refIn(sentOf(n.start)), pos: n.start });
  }
  for (const k of scan.miss.concat(scan.met)) {
    const raw = _clip(text.slice(k.start, k.end), 100);
    const marker = scan.miss.includes(k) ? 'miss' : 'met';
    _tf(ctx, 'etcMention', k.citedDate || null, prov, text, k.start, k.start + raw.length, { raw, marker, chain: k.chain, repair: k.repair, pos: k.start });
  }

  // Misc: lead time, tow / altId, PM added, warranty, VIN, call attempts
  for (const re of LEAD_TIME_RES) {
    for (const m of text.matchAll(re)) {
      const v = m[1] + '-' + m[2] + ' ' + m[3].toLowerCase();
      _tf(ctx, 'leadTime', v, prov, text, m.index, m.index + m[0].length, { raw: m[0], min: +m[1], max: +m[2], unit: m[3].toLowerCase() });
    }
  }
  const towReq = TOW_REQUESTED_RE.test(text) ? true : undefined;
  for (const m of text.matchAll(TOW_RE)) {
    const v = m[0].toLowerCase();
    if (altId && v === altId) _tf(ctx, 'altId', v, prov, text, m.index, m.index + m[0].length, { raw: m[0] });
    else _tf(ctx, 'tow', v, prov, text, m.index, m.index + m[0].length, { raw: m[0], towRequested: towReq });
  }
  for (const re of PM_ADDED_RES) {
    for (const m of text.matchAll(re)) {
      const s = sentOf(m.index);
      if (/\?\s*$/.test(text.slice(s.start, s.end))) continue;
      _tf(ctx, 'pmAdded', true, prov, text, m.index, m.index + m[0].length, { raw: m[0] });
    }
  }
  const warSpans = [];
  for (const m of text.matchAll(WARRANTY_RE)) {
    const w = m[1].toLowerCase();
    const v = /^(?:active|valid|in effect|covered)$/.test(w) ? 'active' : 'expired';
    warSpans.push({ start: m.index, end: m.index + m[0].length });
    _tf(ctx, 'warranty', v, prov, text, m.index, m.index + m[0].length, { raw: m[0] });
  }
  if (/warrant/i.test(text)) {
    for (const m of text.matchAll(WARRANTY_BOTH_RE)) {
      if (_overlap(warSpans, m.index, m.index + m[0].length)) continue;
      _tf(ctx, 'warranty', 'expired', prov, text, m.index, m.index + m[0].length, { raw: m[0] });
    }
  }
  for (const m of text.matchAll(VIN_RE)) _tf(ctx, 'vin', m[0], prov, text, m.index, m.index + m[0].length, { raw: m[0] });
  if (isFas) {
    for (const s of sents) {
      const sent = text.slice(s.start, s.end);
      if (!CALL_RE.test(sent) || !CALL_FAIL_RE.test(sent) || CALL_OK_RE.test(sent)) continue;
      const outcome = /\bon hold\b/i.test(sent) ? 'hold' : (/\bvoice ?mail\b|\bvm\b/i.test(sent) ? 'voicemail' : 'no-answer');
      const d = dealerEnds.find((x) => x.start != null && x.start >= s.start && x.start < s.end);
      const cm = CALL_RE.exec(sent);
      _tf(ctx, 'callAttempt', outcome, prov, text, s.start + cm.index, s.start + cm.index + cm[0].length, { raw: cm[0], outcome, dealer: d ? d.name : undefined });
    }
  }
}

// ── Trap: a part whose value is a known order is an order ───────────────────
// Per block after all comments, and (wo-facts) across blocks with the union of orders.
function reclassifyPartsAsOrders(facts, orderValues) {
  const orders = new Set((orderValues || []).map((v) => _str(v).toUpperCase()));
  if (!orders.size) return facts;
  return (facts || []).map((f) => {
    if (f && f.kind === 'part' && orders.has(_str(f.value).toUpperCase())) {
      const g = Object.assign({}, f, { kind: 'order', reclassifiedFrom: 'part' });
      delete g.qty; delete g.orderNo; delete g.desc; delete g.vor;
      return g;
    }
    if (f && f.kind === 'etcMention' && f.negated && f.ref && orders.has(_str(f.ref).toUpperCase())) {
      return Object.assign({}, f, { orderNo: f.ref });
    }
    return f;
  });
}
function _orderValues(facts) { return facts.filter((f) => f.kind === 'order').map((f) => f.value); }
function _finishRefs(facts) {
  const out = reclassifyPartsAsOrders(facts, _orderValues(facts));
  return out.map((f) => (f.kind === 'etcMention' && f.negated && f.ref && !f.orderNo ? Object.assign({}, f, { partNo: f.ref }) : f));
}

// ── Caps (§3.7) ─────────────────────────────────────────────────────────────
function _capBlock(block, maxBytes) {
  let dropped = 0;
  const byAt = (a, b) => _str(a.at).localeCompare(_str(b.at));
  if (block.events.length > CAPS.events) {
    block.events.sort(byAt);
    dropped += block.events.length - CAPS.events;
    block.events = block.events.slice(block.events.length - CAPS.events);
  }
  const restatements = () => {
    const seen = new Set(); const idx = [];
    block.facts.forEach((f, i) => {
      if (f.kind !== 'etcMention' || f.value == null) return;
      const k = f.etcKind + '|' + f.value;
      if (seen.has(k)) idx.push(i); else seen.add(k);
    });
    return idx;
  };
  const dropOne = () => {
    if (block.events.length > 0) { block.events.sort(byAt); block.events.shift(); dropped++; return true; }
    const r = restatements();
    if (r.length) { block.facts.splice(r[0], 1); dropped++; return true; }
    if (block.facts.length) {
      // oldest prior-episode facts first, then oldest facts
      let i = block.facts.findIndex((f) => f.episode === 'prior');
      if (i < 0) {
        i = 0;
        for (let j = 1; j < block.facts.length; j++) if (_str(block.facts[j].at) < _str(block.facts[i].at)) i = j;
      }
      block.facts.splice(i, 1); dropped++; return true;
    }
    return false;
  };
  while (block.facts.length > CAPS.facts) {
    const r = restatements();
    if (r.length) block.facts.splice(r[0], 1);
    else {
      let i = block.facts.findIndex((f) => f.episode === 'prior');
      if (i < 0) { i = 0; for (let j = 1; j < block.facts.length; j++) if (_str(block.facts[j].at) < _str(block.facts[i].at)) i = j; }
      block.facts.splice(i, 1);
    }
    dropped++;
  }
  let guard = 0;
  while (JSON.stringify(block).length > maxBytes && guard++ < 1000) { if (!dropOne()) break; }
  block.counts.truncated += dropped;
  return block;
}

function _block(extra) {
  return Object.assign({
    v: BLOCK_VERSION, at: _iso(Date.now()), wr: null, estimateId: null, wrCreatedAt: null,
    facts: [], events: [], dealer: null,
    counts: { comments: 0, notes: 0, pages: 0, rejected: 0, truncated: 0 }, partial: false,
  }, extra || {});
}

// ── Relay (§3.3) ────────────────────────────────────────────────────────────
function _defaultCollect(sd) {
  try { return require('../scrapers/aap_api_mapper').collectAllComments(sd); } catch (_) { return []; }
}

const HISTORY_FIELDS = {
  'Expected completion date time': { etcKind: 'repairCompletion' },
  'Expected technician arrival date time': { etcKind: 'techOnsite' },
  'Actual technician arrival date time': { etcKind: 'techOnsite', marker: 'met' },
};

function extractRelay(serviceDetail, opts = {}) {
  const sd = serviceDetail && typeof serviceDetail === 'object' ? serviceDetail : {};
  const wr = sd.workRequest && typeof sd.workRequest === 'object' ? sd.workRequest : {};
  const wos = Array.isArray(sd.workOrders) ? sd.workOrders.filter((w) => w && typeof w === 'object') : [];
  const vendorWorkOrderIds = (Array.isArray(opts.vendorWorkOrderIds) ? opts.vendorWorkOrderIds : [])
    .concat(...wos.map((w) => (Array.isArray(w.vendorWorkOrderIds) ? w.vendorWorkOrderIds : [])))
    .map(String).filter((v, i, a) => v && a.indexOf(v) === i);
  const altId = wr.alternateUniqueId ? _str(wr.alternateUniqueId) : '';
  const ctx = _ctx(Object.assign({}, opts, { vendorWorkOrderIds, altId }));
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const wrCreatedAt = _iso(D.parseTs(wr.createdDateTime));
  const block = _block({
    at: _iso(now), wr: wr.id != null ? String(wr.id) : (sd.id != null ? String(sd.id) : null), wrCreatedAt,
    wrCreatedBy: wr.createdBy ? _clip(wr.createdBy, 60) : null,
    wrNeedBy: _iso(D.parseTs(wr.needByDateTime)),
    wrAltId: altId || null,
  });
  const sys = { source: 'relay', side: 'system', at: null, author: null, via: 'structured' };

  if (altId) _sf(ctx, 'altId', altId.toLowerCase(), sys, 'alternateUniqueId', altId);
  if (wr.salesforceCaseId) _sf(ctx, 'case', _str(wr.salesforceCaseId), sys, 'salesforceCaseId', wr.salesforceCaseId, { ns: 'salesforce' });

  // History first, so the current structured value equal to the last newValue is a duplicate.
  const history = Array.isArray(opts.history) ? opts.history : [];
  const lastNew = {};
  for (const log of history) {
    if (!log || !Array.isArray(log.serviceChangeDetails)) continue;
    const at = _iso(D.parseTs(log.eventDateTime));
    const who = classifyRelayAuthor(log.requester, opts);
    const prov = { source: who.source, side: who.side, at, author: log.requester ? _clip(log.requester, 60) : null, via: 'history' };
    for (const det of log.serviceChangeDetails) {
      if (!det || !det.field) continue;
      const hf = HISTORY_FIELDS[det.field];
      if (hf) {
        const v = D.ymd(D.parseTs(det.newValue));
        if (!v) continue;
        lastNew[det.field] = _str(det.newValue);
        const prev = D.ymd(D.parseTs(det.oldValue));
        _sf(ctx, 'etcMention', v, prov, det.field, det.newValue, { etcKind: hf.etcKind, prev: prev || undefined, marker: hf.marker, chain: hf.marker ? hf.etcKind : undefined, via: 'history' });
      } else if (det.field === 'Estimate' && det.displayType === 'COST') {
        const n = Number(det.newValue);
        if (!Number.isFinite(n) || n === 0) continue;
        _sf(ctx, 'estimate', Math.round(n * 100) / 100, prov, 'Estimate', det.newValue, { amountStatus: 'submitted', via: 'history' });
      } else if (det.field === 'Estimate rejection reason' && det.newValue) {
        _sf(ctx, 'estimate', null, prov, 'Estimate rejection reason', det.newValue, { amountStatus: 'rejected', reason: _clip(det.newValue, 120), marker: 'rejection', via: 'history' });
      } else if (det.field === 'State' && /^ESTIMATE_(APPROVED|REJECTED)$/.test(_str(det.newValue))) {
        const st = /APPROVED/.test(det.newValue) ? 'approved' : 'rejected';
        _sf(ctx, 'estimate', null, prov, 'State', det.newValue, { amountStatus: st, marker: st, via: 'history' });
      }
    }
  }

  const topModified = sd.vendorModifiedTimestamp || null;
  const seenLines = new Set();
  const lineItems = [];
  for (const w of wos) {
    const at = _iso(D.parseTs(w.vendorModifiedTimestamp || topModified));
    const p = Object.assign({}, sys, { at });
    for (const rc of (Array.isArray(w.reasonCodes) ? w.reasonCodes : [])) {
      if (rc) _sf(ctx, 'delayReason', _str(rc), p, 'reasonCodes', rc);
    }
    if (w.expectedCompletionDateTime && lastNew['Expected completion date time'] !== _str(w.expectedCompletionDateTime)) {
      const v = D.ymd(D.parseTs(w.expectedCompletionDateTime));
      if (v) _sf(ctx, 'etcMention', v, p, 'expectedCompletionDateTime', w.expectedCompletionDateTime, { etcKind: 'repairCompletion' });
    }
    if (w.expectedTechnicianArrivalDateTime && lastNew['Expected technician arrival date time'] !== _str(w.expectedTechnicianArrivalDateTime)) {
      const v = D.ymd(D.parseTs(w.expectedTechnicianArrivalDateTime));
      if (v) _sf(ctx, 'etcMention', v, p, 'expectedTechnicianArrivalDateTime', w.expectedTechnicianArrivalDateTime, { etcKind: 'techOnsite' });
    }
    if (w.actualCompletionDateTime) {
      const v = D.ymd(D.parseTs(w.actualCompletionDateTime));
      if (v) _sf(ctx, 'etcMention', v, Object.assign({}, p, { at: _iso(D.parseTs(w.actualCompletionDateTime)) }), 'actualCompletionDateTime', w.actualCompletionDateTime, { etcKind: 'repairCompletion', marker: 'met', chain: 'repairCompletion' });
    }
    if (w.actualTechnicianArrivalDateTime && lastNew['Actual technician arrival date time'] !== _str(w.actualTechnicianArrivalDateTime)) {
      const v = D.ymd(D.parseTs(w.actualTechnicianArrivalDateTime));
      if (v) _sf(ctx, 'etcMention', v, Object.assign({}, p, { at: _iso(D.parseTs(w.actualTechnicianArrivalDateTime)) }), 'actualTechnicianArrivalDateTime', w.actualTechnicianArrivalDateTime, { etcKind: 'techOnsite', marker: 'met', chain: 'techOnsite' });
    }
    const e = w.estimate;
    if (e && typeof e === 'object' && e.totalCost != null && Number.isFinite(Number(e.totalCost))) {
      const st = _str(e.state).toUpperCase();
      const status = st === 'APPROVED' ? 'approved' : (st === 'REJECTED' ? 'rejected' : (/^PENDING/.test(st) ? 'submitted' : null));
      if (status) {
        const ep = Object.assign({}, p, {
          at: _iso(D.parseTs(e.estimateUpdatedAt)) || at,
          source: status === 'submitted' ? 'relay' : 'relaygarage/approver',
        });
        _sf(ctx, 'estimate', Math.round(Number(e.totalCost) * 100) / 100, ep, 'estimate.totalCost', e.totalCost, {
          amountStatus: status, reason: _clip(e.estimateRejectionReason || e.estimateApprovalReason || '', 120) || undefined,
        });
      }
    }
    for (const li of (Array.isArray(w.lineItems) ? w.lineItems : [])) lineItems.push({ li, at });
  }
  for (const li of (Array.isArray(sd.workOrderLineItems) ? sd.workOrderLineItems : [])) lineItems.push({ li, at: _iso(D.parseTs(topModified)) });
  let liNo = 0;
  for (const { li, at } of lineItems) {
    if (!li || typeof li !== 'object') continue;
    const key = li.id != null ? String(li.id) : null;
    if (key && seenLines.has(key)) continue;
    if (key) seenLines.add(key);
    liNo++;
    const p = Object.assign({}, sys, { at, source: 'relay' });
    if (_str(li.failureCause).trim()) _sf(ctx, 'cause', _clip(li.failureCause.trim(), 600), p, 'failureCause', li.failureCause.trim(), { line: liNo });
    if (_str(li.workAccomplished).trim()) _sf(ctx, 'correction', _clip(li.workAccomplished.trim(), 600), p, 'workAccomplished', li.workAccomplished.trim(), { line: liNo });
    if (li.partNumber != null && _str(li.partNumber).trim()) {
      const f = _sf(ctx, 'part', _str(li.partNumber).trim().toUpperCase(), p, 'partNumber', _str(li.partNumber).trim(), {
        qty: Number.isFinite(Number(li.quantity)) ? Number(li.quantity) : undefined, desc: li.description ? _clip(li.description, 80) : undefined,
      });
      if (f) ctx.parts.push(f);
    }
  }

  // Comments
  const collect = typeof opts.collect === 'function' ? opts.collect : _defaultCollect;
  let comments = [];
  try { comments = collect(sd) || []; } catch (_) { comments = []; }
  comments = comments.filter((c) => c && c.text)
    .map((c, i) => ({ c, i, ms: D.parseTs(c.timestamp) }))
    .sort((a, b) => ((a.ms == null ? Infinity : a.ms) - (b.ms == null ? Infinity : b.ms)) || (a.i - b.i))
    .map((x) => x.c);
  block.counts.comments = comments.length;
  for (const c of comments) {
    const who = classifyRelayAuthor(c.createdBy, opts);
    const at = _iso(D.parseTs(c.timestamp));
    const prov = { source: who.source, side: who.side, at, author: c.createdBy ? _clip(c.createdBy, 60) : null };
    block.events.push({ at, author: prov.author, side: who.side, role: null, internal: !!c.internalOnly, via: 'comment' });
    _textPass(ctx, c.text, prov);
  }
  block.facts = _finishRefs(ctx.facts);
  block.counts.rejected = ctx.rejected;
  block.counts.truncated = ctx.truncated;
  return _capBlock(block, CAPS.relayBlockBytes);
}

// ── Decisiv (§3.4) ──────────────────────────────────────────────────────────
function _decisivSide(groupId, location) {
  if (groupId === -1) return 'dealer';
  if (groupId === -2) return 'amazon';
  if (groupId === -3) return 'oem';
  const loc = _str(location);
  if (/^amazon\b/i.test(loc)) return 'amazon';
  if (/originator:\s*uptime/i.test(loc)) return 'oem';
  return 'dealer';
}

function normalizeDecisivNote(n) {
  const x = n && typeof n === 'object' ? n : {};
  const from = x.from && typeof x.from === 'object' ? x.from : {};
  const atMs = D.parseDecisivTs(x.created_at);
  const subject = _plain(x.subject || '');
  const body = _plain(x.message != null ? x.message : (x.body || x.text || ''));
  const recips = (Array.isArray(x.recipients) ? x.recipients : []).slice(0, 12).filter((r) => r && typeof r === 'object').map((r) => ({
    name: r.name ? _clip(r.name, 60) : null, location: r.location ? _clip(r.location, 120) : null,
    jobRole: r.job_role || null, side: _decisivSide(r.groupId, r.location),
  }));
  const version = x.version == null || x.version === '' ? null : (Number.isFinite(Number(x.version)) ? Number(x.version) : null);
  return {
    id: x.id != null ? x.id : null,
    at: _iso(atMs),
    author: from.name ? _clip(from.name, 60) : null,
    location: from.location ? _clip(from.location, 120) : null,
    groupId: Number.isFinite(from.groupId) ? from.groupId : null,
    jobRole: from.job_role || null,
    side: _decisivSide(from.groupId, from.location),
    recipients: recips,
    internal: !!x.internal,
    systemGenerated: !!(x.system_generated || x.platform_generated),
    context: x.context || null,
    version,
    text: [subject, body].filter(Boolean).join(' — '),
  };
}

function extractDecisivNotes(rawNotes, opts = {}) {
  const ctx = _ctx(opts);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const wrMs = D.parseTs(opts.wrCreatedAt);
  const notes = (Array.isArray(rawNotes) ? rawNotes : []).filter(Boolean).map(normalizeDecisivNote)
    .map((n, i) => ({ n, i, ms: D.parseTs(n.at) }))
    .sort((a, b) => ((a.ms == null ? Infinity : a.ms) - (b.ms == null ? Infinity : b.ms)) || (a.i - b.i))
    .map((x) => x.n);
  const block = _block({
    at: _iso(now), estimateId: opts.estimateId != null ? String(opts.estimateId) : null,
    wrCreatedAt: _iso(wrMs), partial: !!opts.partial,
  });
  block.counts.notes = notes.length;
  block.counts.pages = Number.isFinite(opts.pages) ? opts.pages : 0;
  const seenContacts = new Set();
  const seenLoc = new Set();
  for (const n of notes) {
    const ms = D.parseTs(n.at);
    const episode = wrMs != null && ms != null && ms < wrMs - PRIOR_EPISODE_MS ? 'prior' : undefined;
    const prov = { source: 'decisiv', side: n.side, at: n.at, author: n.author, episode };
    const ev = { at: n.at, author: n.author, side: n.side, role: n.jobRole, internal: n.internal, via: n.systemGenerated ? 'system' : 'note' };
    if (episode) ev.episode = episode;
    block.events.push(ev);
    const before = ctx.facts.length;
    _textPass(ctx, n.text, prov);
    // Structured approval marker: attaches to the amount stated in the same note.
    if (n.context === 'estimate_approved' && n.version != null) {
      const own = ctx.facts.slice(before).filter((f) => f.kind === 'estimate' && f.value != null);
      if (own.length) for (const f of own) { f.v = n.version; f.amountStatus = 'approved'; }
      else _sf(ctx, 'estimate', null, Object.assign({}, prov, { via: 'structured' }), 'context', 'estimate_approved v' + n.version, { amountStatus: 'approved', v: n.version, marker: 'approved' });
    }
    // Structured contacts (author + recipients).
    const people = [{ name: n.author, location: n.location, jobRole: n.jobRole, side: n.side }].concat(n.recipients);
    for (const c of people) {
      if (!c.name) continue;
      const key = c.name + '|' + _str(c.location);
      if (seenContacts.has(key)) continue;
      seenContacts.add(key);
      _sf(ctx, 'contact', c.name, Object.assign({}, prov, { via: 'structured' }), 'from', c.name + (c.location ? ' (' + c.location + ')' : ''), {
        raw: c.name, role: c.jobRole || null, location: c.location || undefined, side: c.side,
      });
    }
    if (n.side === 'dealer' && n.location && !seenLoc.has(n.location)) {
      seenLoc.add(n.location);
      _sf(ctx, 'dealer', n.location, Object.assign({}, prov, { via: 'location' }), 'from.location', n.location, { via: 'location' });
    }
  }
  const est = opts.estimateDetail && opts.estimateDetail.estimate;
  const dealer = est && est.dealer && typeof est.dealer === 'object' ? est.dealer : null;
  if (dealer && (dealer.id || dealer.name)) {
    block.dealer = { id: dealer.id ? String(dealer.id) : null, name: dealer.name ? _clip(dealer.name, 120) : null };
    const sp = { source: 'decisiv', side: 'dealer', at: null, author: null, via: 'structured' };
    if (dealer.id) _sf(ctx, 'decisivDealerId', String(dealer.id), sp, 'estimate.dealer.id', dealer.id);
    if (dealer.name) _sf(ctx, 'dealer', _clip(dealer.name, 120), sp, 'estimate.dealer.name', dealer.name);
  }
  block.facts = _finishRefs(ctx.facts);
  block.counts.rejected = ctx.rejected;
  block.counts.truncated = ctx.truncated;
  return _capBlock(block, CAPS.offsiteBlockBytes);
}

// ── DTNA (§3.5) ─────────────────────────────────────────────────────────────
function _dtnaSide(actor) {
  const a = _str(actor);
  if (/API User|ROSync API|Geofence/i.test(a)) return 'system';
  if (/^AFP FAS\b/i.test(a)) return 'amazon';
  if (/^CRM Admin\b/i.test(a)) return 'oem';
  return 'dealer';
}
function _dtnaDateMs(dateStr, h, mi, ap) {
  const m = /^([A-Z][a-z]{2,8}) (\d{1,2}), (\d{4})$/.exec(dateStr);
  if (!m) return null;
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (mon == null) return null;
  let hh = h != null ? (+h % 12) + (ap === 'P' ? 12 : 0) : 0;
  return new Date(+m[3], mon, +m[2], hh, mi != null ? +mi : 0).getTime();
}

// -> [{ at, actor, side, text }] in feed order (newest-first as rendered).
function parseDtnaFeedLines(thread) {
  const out = [];
  for (const line of _str(thread).split(/\r?\n/)) {
    const m = DTNA_LINE_RE.exec(line);
    if (m) {
      out.push({ at: _iso(_dtnaDateMs(m[1], m[2], m[3], m[4])), actor: m[5].trim(), side: _dtnaSide(m[5].trim()), text: m[6] });
    } else if (out.length && line.trim()) {
      out[out.length - 1].text += '\n' + line;
    }
  }
  return out;
}

function extractDtnaFeed(thread, opts = {}) {
  const ctx = _ctx(opts);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  let src = _str(thread);
  let fallback = false;
  if (!src && opts.offsiteText) { src = _str(opts.offsiteText); fallback = true; }
  const wrMs = D.parseTs(opts.wrCreatedAt);
  const block = _block({ at: _iso(now), estimateId: opts.estimateId != null ? String(opts.estimateId) : null, wrCreatedAt: _iso(wrMs) });
  const entries = parseDtnaFeedLines(src);
  block.counts.notes = entries.length;
  for (const e of entries) {
    const ms = D.parseTs(e.at);
    const episode = wrMs != null && ms != null && ms < wrMs - PRIOR_EPISODE_MS ? 'prior' : undefined;
    const prov = { source: 'dtna', side: e.side, at: e.at, author: _clip(e.actor, 60), episode };
    const ev = { at: e.at, author: prov.author, side: e.side, role: null, internal: false, via: 'feed' };
    if (episode) ev.episode = episode;
    block.events.push(ev);
    const text = e.text;
    for (const m of text.matchAll(DTNA_ENTER_RE)) {
      const kind = m[1] === 'entered' ? 'enter' : 'exit';
      const atMs = D.parseDecisivTs(m[4] + ' ' + m[5]);
      const p = Object.assign({}, prov, { at: _iso(atMs) || e.at });
      const dealer = m[2].trim();
      _tf(ctx, 'dtnaEvent', kind, p, text, m.index, m.index + m[0].length, { raw: 'has ' + m[1], dealer, city: m[3].trim() });
      if (kind === 'enter') _tf(ctx, 'dealer', dealer, p, text, m.index, m.index + m[0].length, { raw: dealer, via: 'dtna' });
    }
    for (const m of text.matchAll(DTNA_CLOSE_RE)) {
      _tf(ctx, 'dtnaEvent', 'close', prov, text, m.index, m.index + m[0].length, { raw: 'closed this case', status: m[1].trim(), transition: m[2] ? m[2].trim() : undefined });
    }
    _textPass(ctx, text, prov);
  }
  block.facts = _finishRefs(ctx.facts);
  block.counts.rejected = ctx.rejected;
  block.counts.truncated = ctx.truncated + (fallback ? 1 : 0);
  block.partial = fallback || !!opts.partial;
  return _capBlock(block, CAPS.offsiteBlockBytes);
}

// ── App text (§3.6) ─────────────────────────────────────────────────────────
// prov = { source: 'notes'|'email', at, author?, side? } -> { facts, counts: { rejected, truncated } }
function extractText(text, prov = {}) {
  const ctx = _ctx(prov.opts || {});
  const p = { source: prov.source === 'email' ? 'email' : 'notes', side: SIDES.includes(prov.side) ? prov.side : 'amazon', at: prov.at || null, author: prov.author || null };
  _textPass(ctx, text, p);
  return { facts: _finishRefs(ctx.facts).slice(0, CAPS.facts), counts: { rejected: ctx.rejected, truncated: ctx.truncated } };
}

module.exports = {
  extractRelay, extractDecisivNotes, extractDtnaFeed, extractText,
  normalizeDecisivNote, parseDtnaFeedLines, classifyRelayAuthor, reclassifyPartsAsOrders, decodeEntities,
  SOURCES, SIDES, KINDS, CAPS, BLOCK_VERSION, VENDOR_SYSTEM_AUTHORS,
  ORDER_RE, PART_LABEL_RE, INTL_PART_RE, QTY_RE, VOR_RE, RO_RE, SF_LABEL_RE, SF_BARE_RE, DECISIV_CASE_RE, OEM_CASE_RE,
  FLEETNET_RE, DEALER_ID_URL_RE, DEALER_CODE_RE, WR_DEALER_RE, FAS_DEALER_RE, PHONE_RE, ROLE_CONTACT_RE,
  AMERIT_CC_RE, COX_LL_RE, APPROVED_V_RE, APPROVED_RE, REJ_TPL_RE, KWNE_REJECT_RE, AMERIT_DELAY_RE, COX_CC_RE,
  TOW_RE, VIN_RE, CALL_RE, DTNA_LINE_RE, DTNA_ENTER_RE, DTNA_CLOSE_RE,
  _fact, _plain, _snip,
};
