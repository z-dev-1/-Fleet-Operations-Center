'use strict';
/**
 * email-intel/transport/map.js — pure REST JSON -> MessageCapture mapping (design 5.5).
 *
 *   toCapture(msg, ctx) -> capture | null     ctx: { folderLabel, labelOf(id), isLatest, blockIndex, attachments, preview, stats }
 *   mapRecipients(list) -> [{ name, address|null }]
 *   mapAttachments(list, hasAttachments) -> attachment entries (filename-only analysis)
 *   legacyConvId(restId)   REST id alphabet -> the EWS form OWA's data-convid uses ('-' -> '/', '_' -> '+')
 *   keySeedOf(msg)         'imid:<InternetMessageId>' when present, else 'id:<Id>'
 *   rowSigOf(convKey, members)
 *
 * REST input is external data: every field is type-checked; a message without Id, ConversationId or a parseable
 * ReceivedDateTime is dropped and counted, never thrown. Strings are capped.
 */
const crypto = require('crypto');
const C = require('../constants');
const { TC } = require('./constants');
const identity = require('../ingest/identity');
const { htmlToText } = require('../../justme-context/extract');

const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ATT_MAX = 20;
const HTML_INPUT_CAP = 2_000_000;
const str = (v) => (typeof v === 'string' ? v : '');
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

function _bump(ctx, k) { if (ctx && ctx.stats) ctx.stats[k] = (ctx.stats[k] || 0) + 1; }

function legacyConvId(restId) { return String(restId == null ? '' : restId).replace(/-/g, '/').replace(/_/g, '+'); }

function keySeedOf(msg) {
  const m = msg || {};
  const imid = str(m.InternetMessageId).trim();
  if (imid && imid.length <= TC.IMID_MAX) return 'imid:' + imid;
  return 'id:' + str(m.Id);
}

function rowSigOf(convKey, members) {
  const list = Array.isArray(members) ? members : [];
  const newest = list.length ? str(list[list.length - 1].Id) : '';
  return sha1(String(convKey || '') + '|' + newest + '|' + list.length);
}

function _person(ea) {
  const e = ea && typeof ea === 'object' ? (ea.EmailAddress && typeof ea.EmailAddress === 'object' ? ea.EmailAddress : ea) : {};
  const name = str(e.Name).replace(CTRL_RE, ' ').trim().slice(0, 120);
  const a = str(e.Address).trim().toLowerCase();
  return { name, address: a && a.includes('@') && a.length <= 320 ? a : null };
}

function mapRecipients(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, C.RECIPIENTS_CAP).map(_person).filter((p) => p.name || p.address);
}

function _ext(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}
function _kind(ext) {
  try { return require('../../scrapers/owa_reader')._attachmentType(ext); } catch (_) { return 'file'; }
}

function mapAttachments(list, hasAttachments) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (out.length >= ATT_MAX) break;
    if (!a || typeof a !== 'object' || a.IsInline === true) continue;
    const name = str(a.Name).replace(CTRL_RE, ' ').trim().slice(0, 200);
    const type = str(a['@odata.type']);
    const isFile = !type || /FileAttachment$/i.test(type);
    const attId = str(a.Id);
    const ext = _ext(name);
    out.push({
      attId: attId && attId.length <= TC.ATT_ID_MAX ? attId : null, name, ext, sizeBytes: Number.isFinite(a.Size) ? a.Size : null,
      kind: _kind(ext), placeholder: false, hasDownloadHandle: isFile && !!attId && attId.length <= TC.ATT_ID_MAX,
      analysis: { status: 'filename-only' },
    });
  }
  if (!out.length && hasAttachments === true) {
    out.push({ attId: null, name: null, ext: '', sizeBytes: null, kind: 'file', placeholder: true, hasDownloadHandle: false, analysis: { status: 'filename-only' } });
  }
  return out;
}

/** REST ReceivedDateTime -> normalized ISO, or null. */
function parseRestTime(v) {
  const s = str(v);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function _body(msg, preview) {
  if (preview) {
    const t = str(msg.BodyPreview).slice(0, C.RAW_BODY_CAP);
    return { text: t, status: 'preview-only', source: 'api-preview', textLen: t.length };
  }
  const b = msg.Body && typeof msg.Body === 'object' ? msg.Body : {};
  const content = str(b.Content);
  let text;
  if (/^html$/i.test(str(b.ContentType))) text = htmlToText(content.slice(0, HTML_INPUT_CAP), C.RAW_BODY_CAP + 1);
  else text = content.slice(0, C.RAW_BODY_CAP + 1);
  text = String(text || '');
  const truncated = text.length > C.RAW_BODY_CAP;
  if (truncated) text = text.slice(0, C.RAW_BODY_CAP);
  const out = { text, status: truncated ? 'truncated-cap' : 'complete', source: 'api', textLen: text.length };
  if (truncated) out.truncatedAt = C.RAW_BODY_CAP;
  return out;
}

function toCapture(msg, ctx) {
  const c = ctx || {};
  if (!msg || typeof msg !== 'object') { _bump(c, 'dropped'); return null; }
  const id = str(msg.Id);
  const convId = str(msg.ConversationId);
  const receivedAt = parseRestTime(msg.ReceivedDateTime);
  if (!id || !convId || !receivedAt) { _bump(c, 'dropped'); return null; }
  if (id.length > TC.ITEM_ID_MAX || convId.length > TC.ITEM_ID_MAX) { _bump(c, 'badId'); return null; }
  const imidRaw = str(msg.InternetMessageId).trim();
  const internetMessageId = imidRaw && imidRaw.length <= TC.IMID_MAX ? imidRaw : null;
  const convIdRaw = legacyConvId(convId);
  const from = _person(msg.From);
  const to = mapRecipients(msg.ToRecipients);
  const cc = mapRecipients(msg.CcRecipients);
  const body = _body(msg, c.preview === true);
  const parent = str(msg.ParentFolderId);
  const known = parent && typeof c.labelOf === 'function' ? c.labelOf(parent) : null;
  const cap = {
    source: 'api', itemId: id, keySeed: keySeedOf(msg), apiIds: { conversationId: convId, internetMessageId },
    convIdRaw, convIdSource: 'owa', conversationKey: identity.conversationKey(convIdRaw), legacySeed: convIdRaw,
    folder: known || c.folderLabel || 'Inbox',
    subject: str(msg.Subject).replace(CTRL_RE, ' ').slice(0, 400),
    from: { name: from.name, address: from.address, quality: from.address ? 'ok' : 'name-only' },
    to, cc, toCount: Array.isArray(msg.ToRecipients) ? msg.ToRecipients.length : 0, ccCount: Array.isArray(msg.CcRecipients) ? msg.CcRecipients.length : 0,
    recipientsKnown: true,
    receivedAt, receivedAtQuality: 'exact', receivedAtPrecision: 'minute', receivedAtRaw: '', zoneExplicit: true,
    bodyText: body.text, bodyStatus: body.status, bodySource: body.source, textLen: body.textLen,
    attachments: mapAttachments(c.attachments, msg.HasAttachments === true),
    flags: { unread: msg.IsRead === false },
    isLatest: c.isLatest === true, blockIndex: Number.isFinite(c.blockIndex) ? c.blockIndex : 0, stub: false,
  };
  if (body.truncatedAt) cap.truncatedAt = body.truncatedAt;
  return cap;
}

module.exports = { toCapture, mapRecipients, mapAttachments, legacyConvId, keySeedOf, rowSigOf, parseRestTime };
