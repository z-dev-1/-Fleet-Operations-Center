'use strict';
/**
 * email-intel/capture/parse-snapshot.js — turns the pane collector's plain JSON snapshot into
 * MessageCapture objects (design 2.3). Pure: the page script makes no parsing decisions.
 *
 *   parseSnapshot(snapshot, rowDesc, scanNow, opts) -> { captures:[MessageCapture], stubs:number }
 *   parseAddressList(text) -> [{ name, address|null }]
 *   bodyStatusOf(block, snapshot) -> bodyStatus enum
 *
 * Every field carries a quality flag instead of a guess: `from.quality` is 'ok' (address) or
 * 'name-only'; `recipientsKnown` is false when no To/Cc candidate exists at all (recipients are
 * never inferred); `receivedAtQuality` comes from received-time.js; `bodyStatus` is one of
 * complete | truncated-cap | truncated-ui | collapsed | low-quality | preview-only | unavailable.
 * Messages carry no messageKey yet: identity needs the stored ledger (ledger.buildRecord).
 */
const C = require('../constants');
const { parseReceived } = require('./received-time');
const identity = require('../ingest/identity');

const ADDRESS_ANY = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/;
const ADDRESS_ALL = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g;
const ADDRESS_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const NO_RECIPIENTS_RE = /\bno recipients\b|undisclosed[- ]recipients/i;
const HEADER_LINE_RE = /^\s*(from|to|cc|bcc|sent|date|subject|received|importance|reply-to)\s*:/i;
const CHROME_SUBJECT_RE = /^(navigation pane|folder pane|reading pane|message list|favorites|folders)$/i;
const EXPAND_CONTROL_RE = /show more|view entire|expand|trimmed/i;

function _clean(s) { return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim(); }

/** Split on `sepRe` characters that are outside double quotes, angle brackets and parentheses. */
function _splitOutside(text, seps) {
  const out = []; let cur = ''; let quote = false; let depth = 0;
  for (const ch of String(text)) {
    if (ch === '"') quote = !quote;
    else if (!quote && (ch === '<' || ch === '(')) depth++;
    else if (!quote && (ch === '>' || ch === ')') && depth > 0) depth--;
    if (!quote && depth === 0 && seps.includes(ch)) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function _oneRecipient(seg) {
  const s = _clean(seg);
  if (!s) return null;
  const am = ADDRESS_ANY.exec(s);
  const address = am && ADDRESS_OK.test(am[0]) ? am[0].toLowerCase() : null;
  let name = s;
  if (am) name = s.replace(am[0], ' ');
  name = name.replace(/[<>()"]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '').trim();
  if (!address && !name) return null;
  return { name: name.slice(0, 120), address };
}

/** parseAddressList(text) -> de-duplicated [{ name, address|null }] (cap applied by the caller). */
function parseAddressList(text) {
  const t = String(text == null ? '' : text);
  const out = [];
  const seen = new Set();
  for (const seg of _splitOutside(t, ';')) {
    const addrs = seg.match(ADDRESS_ALL) || [];
    const parts = new Set(addrs.map((a) => a.toLowerCase())).size > 1 ? _splitOutside(seg, ',') : [seg];
    for (const p of parts) {
      const r = _oneRecipient(p);
      if (!r) continue;
      const k = r.address || ('n:' + r.name.toLowerCase());
      if (seen.has(k)) continue;
      seen.add(k); out.push(r);
    }
  }
  return out;
}

function _candidateRecipients(c) {
  if (!c || typeof c !== 'object') return [];
  const href = String(c.href || '');
  const hrefAddr = /^mailto:/i.test(href) ? href.replace(/^mailto:/i, '').split('?')[0].trim() : '';
  const text = _clean(c.text); const title = _clean(c.title); const aria = _clean(c.aria);
  const multi = (s) => ((s.match(ADDRESS_ALL) || []).length > 1) || /;/.test(s);
  if (multi(text)) return parseAddressList(text);
  if (multi(title)) return parseAddressList(title);
  const addrSrc = hrefAddr || (ADDRESS_ANY.exec(title) || ADDRESS_ANY.exec(aria) || ADDRESS_ANY.exec(text) || [''])[0];
  const address = addrSrc && ADDRESS_OK.test(addrSrc) ? addrSrc.toLowerCase() : null;
  let name = text && !ADDRESS_ANY.test(text) ? text : (title || aria || text);
  name = _clean(String(name).replace(ADDRESS_ALL, ' ').replace(/[<>()"]/g, ' ')).replace(/^[\s,;:-]+|[\s,;:-]+$/g, '');
  if (!address && !name) return [];
  return [{ name: name.slice(0, 120), address }];
}

function _recipients(candidates) {
  const out = []; const seen = new Set();
  for (const c of Array.isArray(candidates) ? candidates : []) {
    for (const r of _candidateRecipients(c)) {
      const k = r.address || ('n:' + r.name.toLowerCase());
      if (seen.has(k)) continue;
      seen.add(k); out.push(r);
    }
  }
  return out;
}

function _from(block, rowParsed) {
  const cands = Array.isArray(block && block.fromCandidates) ? block.fromCandidates : [];
  for (const c of cands) {
    const rs = _candidateRecipients(c);
    const withAddr = rs.find((r) => r.address);
    if (withAddr) return { name: withAddr.name || rowParsed.fromName || '', address: withAddr.address, quality: 'ok' };
  }
  const name = (cands.map((c) => _clean(c && (c.text || c.title || c.aria))).find(Boolean)) || rowParsed.fromName || '';
  return { name: _clean(name).replace(ADDRESS_ALL, '').slice(0, 120), address: null, quality: 'name-only' };
}

const HEADER_DATE_RES = [
  /(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*,?\s+\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*[AaPp]?\.?[Mm]?\.?/,
  /\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*[AaPp]?\.?[Mm]?\.?/,
  /(?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*,?\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4},?\s+(?:at\s+)?\d{1,2}:\d{2}(?::\d{2})?\s*[AaPp]?\.?[Mm]?\.?/,
  /\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*[AaPp]?\.?[Mm]?\.?/,
];

function _receivedAt(block, rowDesc, rowParsed, now, tzMinutes) {
  const tried = [];
  const attempt = (raw) => { if (!raw) return null; const r = parseReceived(raw, { now, tzMinutes }); tried.push(r); return r.iso ? r : null; };
  const tc = Array.isArray(block && block.timeCandidates) ? block.timeCandidates : [];
  for (const t of tc) { const r = attempt(t && t.datetime); if (r) return r; }
  const header = _clean(block && block.headerText);
  for (const re of HEADER_DATE_RES) { const m = re.exec(header); if (m) { const r = attempt(m[0]); if (r) return r; } }
  for (const t of tc) {
    for (const k of ['title', 'aria', 'text']) { const r = attempt(t && t[k]); if (r) return r; }
  }
  const rowTok = (rowDesc && rowDesc.timeTokenRaw) || rowParsed.receivedText;
  const r = attempt(rowTok);
  if (r) return r;
  const raw = _clean(rowTok || (tc[0] && (tc[0].datetime || tc[0].title || tc[0].text)) || '');
  return { iso: null, quality: 'unknown', precision: null, raw, zoneExplicit: false };
}

function _bodyWithoutHeader(block) {
  const text = String((block && block.text) || '');
  const header = new Set(String((block && block.headerText) || '').split('\n').map((l) => l.trim()).filter(Boolean));
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const l = lines[i].trim();
    if (!l || HEADER_LINE_RE.test(l) || header.has(l)) { i++; continue; }
    break;
  }
  return lines.slice(i).join('\n').trim().slice(0, C.RAW_BODY_CAP);
}

/** bodyStatus rules, first match wins (design 2.5). `paneOk` false means the pane could not be read. */
function bodyStatusOf(block, snapshot, paneOk) {
  if (paneOk === false) return 'preview-only';
  const text = String((block && block.text) || '').trim();
  if (!text) return 'unavailable';
  if (block && block.collapsed) return 'collapsed';
  if (snapshot && snapshot.paneFallback) return 'low-quality';
  if (Number(block && block.textLen) > C.RAW_BODY_CAP) return 'truncated-cap';
  const controls = Array.isArray(block && block.controls) ? block.controls : [];
  if (controls.some((c) => EXPAND_CONTROL_RE.test(String(c)))) return 'truncated-ui';
  return 'complete';
}

const SIZE_RE = /(\d+(?:\.\d+)?)\s*(KB|MB|GB|bytes?|B)\b/i;
function _sizeBytes(s) {
  const m = SIZE_RE.exec(String(s || ''));
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult = unit === 'KB' ? 1024 : unit === 'MB' ? 1024 * 1024 : unit === 'GB' ? 1024 ** 3 : 1;
  return Math.round(n * mult);
}

function _hrefAllowed(h) {
  const s = String(h || '');
  if (!/^https:\/\//i.test(s)) return false;
  try { return require('../../scrapers/owa-mailer').OUTLOOK_HOST_RE.test(s); } catch (_) { return false; }
}

function _attachments(block, rowHasAttach) {
  const out = [];
  const seen = new Set();
  const owa = require('../../scrapers/owa_reader');
  for (const a of Array.isArray(block && block.attachments) ? block.attachments : []) {
    if (!a || typeof a !== 'object') continue;
    const blob = [a.title, a.aria, a.text].map(_clean).filter(Boolean).join(' ');
    const nm = /[^\s/\\]+\.[a-z0-9]{2,5}\b/i.exec(String(a.title || '').replace(/^attachment[,:]?\s*/i, '') || '')
      || /[^\s/\\]+\.[a-z0-9]{2,5}\b/i.exec(blob.replace(/^attachment[,:]?\s*/i, ''));
    const attrs = a.attrs && typeof a.attrs === 'object' ? a.attrs : {};
    const attId = String(attrs['data-attachmentid'] || attrs['data-attachment-id'] || '').trim().slice(0, 120) || null;
    const hasDownloadHandle = (Array.isArray(a.hrefs) ? a.hrefs : []).some(_hrefAllowed);
    if (!nm) {
      out.push({ attId, name: null, ext: '', sizeBytes: _sizeBytes(blob), kind: 'file', placeholder: true, hasDownloadHandle, analysis: { status: 'filename-only' } });
      continue;
    }
    const name = nm[0].slice(0, 200);
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const ext = (name.split('.').pop() || '').toLowerCase();
    out.push({ attId, name, ext, sizeBytes: _sizeBytes(blob), kind: owa._attachmentType(ext), placeholder: false, hasDownloadHandle, analysis: { status: 'filename-only' } });
  }
  if (!out.length && rowHasAttach) out.push({ attId: null, name: null, ext: '', sizeBytes: null, kind: 'file', placeholder: true, hasDownloadHandle: false, analysis: { status: 'filename-only' } });
  return out.slice(0, 20);
}

function _validSnapshot(s) { return s && typeof s === 'object' && !s.error && Array.isArray(s.blocks) && s.blocks.length > 0; }

/**
 * parseSnapshot(snapshot, rowDesc, scanNow, opts) -> { captures, stubs }
 * opts: { tzMinutes, folder }
 * An unreadable pane (null / malformed / error) yields ONE preview-only capture built from the row.
 */
function parseSnapshot(snapshot, rowDesc, scanNow, opts) {
  opts = opts || {};
  rowDesc = rowDesc || {};
  const owa = require('../../scrapers/owa_reader');
  const rowParsed = owa._parseAriaLabel(rowDesc.aria || '');
  const now = Number.isFinite(scanNow) ? scanNow : Date.now();
  const paneOk = _validSnapshot(snapshot);
  const blocks = paneOk ? snapshot.blocks.slice(0, C.MAX_PANE_BLOCKS) : [null];
  const convRaw = String(rowDesc.convId || (paneOk && blocks[0] && blocks[0].idAttrs && blocks[0].idAttrs['data-convid']) || '').trim();
  const convIdSource = convRaw ? 'owa' : 'derived';
  const conversationKey = convRaw ? identity.conversationKey(convRaw) : identity.conversationKeyFromAria(rowDesc.aria || '');
  const paneSubject = paneOk ? _clean(snapshot.subject) : '';
  // The pane heading is more reliable than the aria sender/subject split; chrome headings are ignored.
  const subject = (paneSubject && !CHROME_SUBJECT_RE.test(paneSubject) && paneSubject.length > 3 ? paneSubject : '') || _clean(rowParsed.subject) || '(no subject)';
  const legacySeed = convRaw || (String(rowDesc.aria || '').slice(0, 120));
  const captures = [];
  let stubs = 0;

  blocks.forEach((block, idx) => {
    const base = {
      convIdRaw: convRaw, convIdSource, conversationKey, legacySeed, folder: opts.folder || 'Inbox', subject,
      blockIndex: idx, isLatest: idx === blocks.length - 1,
    };
    if (!paneOk) {
      const to = []; const cc = [];
      const t = _receivedAt(null, rowDesc, rowParsed, now, opts.tzMinutes);
      captures.push(Object.assign(base, {
        itemId: identity.itemIdFrom({ rowAttrs: rowDesc.itemIdCandidates && rowDesc.itemIdCandidates.dataAttrs }) || null,
        from: { name: _clean(rowParsed.fromName).slice(0, 120), address: null, quality: 'name-only' },
        to, cc, toCount: 0, ccCount: 0, recipientsKnown: false,
        receivedAt: t.iso, receivedAtQuality: t.quality, receivedAtPrecision: t.precision, receivedAtRaw: t.raw, zoneExplicit: false,
        bodyText: String(rowParsed.preview || '').slice(0, C.RAW_BODY_CAP), bodyStatus: 'preview-only', bodySource: 'preview', textLen: String(rowParsed.preview || '').length,
        attachments: _attachments(null, rowDesc.hasAttach || rowParsed.hasAttach),
        flags: { unread: !!(rowDesc.unread || rowParsed.unread) },
      }));
      return;
    }
    const status = bodyStatusOf(block, snapshot, true);
    if (status === 'collapsed' || block.collapsed) { stubs++; captures.push(Object.assign(base, { stub: true, bodyStatus: 'collapsed', bodyText: '', bodySource: 'pane', textLen: 0, attachments: [], flags: {} })); return; }
    const toCands = Array.isArray(block.toCandidates) ? block.toCandidates : [];
    const ccCands = Array.isArray(block.ccCandidates) ? block.ccCandidates : [];
    const toAll = _recipients(toCands); const ccAll = _recipients(ccCands);
    const cap = C.RECIPIENTS_CAP;
    const recipientsKnown = (toAll.length + ccAll.length) > 0 || NO_RECIPIENTS_RE.test(String(block.headerText || ''));
    const t = _receivedAt(block, rowDesc, rowParsed, now, opts.tzMinutes);
    const itemId = identity.itemIdFrom({
      idAttrs: block.idAttrs, rowAttrs: rowDesc.itemIdCandidates && rowDesc.itemIdCandidates.dataAttrs, url: snapshot.url, blockCount: blocks.length,
    });
    const body = _bodyWithoutHeader(block);
    captures.push(Object.assign(base, {
      itemId,
      from: _from(block, rowParsed),
      to: toAll.slice(0, cap), cc: ccAll.slice(0, cap), toCount: toAll.length, ccCount: ccAll.length, recipientsKnown,
      receivedAt: t.iso, receivedAtQuality: t.quality, receivedAtPrecision: t.precision, receivedAtRaw: t.raw, zoneExplicit: !!t.zoneExplicit,
      bodyText: body, bodyStatus: status, bodySource: 'pane', textLen: Number(block.textLen) || body.length,
      truncatedAt: status === 'truncated-cap' ? C.RAW_BODY_CAP : undefined,
      attachments: _attachments(block, idx === blocks.length - 1 && (rowDesc.hasAttach || rowParsed.hasAttach)),
      flags: { unread: !!(rowDesc.unread || rowParsed.unread) },
    }));
  });
  return { captures, stubs };
}

module.exports = { parseAddressList, bodyStatusOf, parseSnapshot, EXPAND_CONTROL_RE };
