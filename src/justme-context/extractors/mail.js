'use strict';
// extractors/mail.js — worker only. EML (mailparser) and Outlook MSG (msgreader).
// Header/body text only; attachment NAMES are listed, attachment bodies are not read.

const { LIMITS } = require('../constants');
const { errTag } = require('../log-safe');

function _addr(v) {
  if (!v) return '';
  const list = Array.isArray(v) ? v : [v];
  return list.map((a) => (a && a.text) || '').filter(Boolean).join(', ');
}

function _ok(kind, text, truncated) {
  let t = String(text || '');
  let tr = !!truncated;
  if (t.length > LIMITS.RAW_TEXT_MAX_CHARS) { t = t.slice(0, LIMITS.RAW_TEXT_MAX_CHARS); tr = true; }
  return { ok: true, kind, text: t, truncated: tr };
}

async function extractEml(buf, ctx, deps) {
  const { htmlToText } = require('../extract');
  const simpleParser = (deps && deps.mailparser && deps.mailparser.simpleParser) || require('mailparser').simpleParser;
  try {
    const m = await simpleParser(buf, { skipImageLinks: true, skipTextLinks: true, skipHtmlToText: false, maxHtmlLengthToParse: 2000000 });
    const lines = [];
    if (m.from) lines.push('From: ' + _addr(m.from));
    if (m.to) lines.push('To: ' + _addr(m.to));
    if (m.cc) lines.push('Cc: ' + _addr(m.cc));
    if (m.date) lines.push('Date: ' + new Date(m.date).toISOString());
    if (m.subject) lines.push('Subject: ' + m.subject);
    let body = typeof m.text === 'string' && m.text.trim() ? m.text : (typeof m.html === 'string' ? htmlToText(m.html) : '');
    body = String(body || '').trim();
    const atts = (m.attachments || []).slice(0, 50).map((a) => (a.filename || 'attachment') + ' (' + (a.contentType || '?') + ', ' + (a.size || 0) + ' bytes)');
    const text = lines.join('\n') + (body ? '\n\n' + body : '') + (atts.length ? '\n\nAttachments: ' + atts.join('; ') : '');
    return text.trim() ? _ok('eml', text) : { ok: false, kind: 'eml', reason: 'EMPTY' };
  } catch (e) {
    return { ok: false, kind: 'eml', reason: 'EML_FAILED', errCode: errTag(e) };
  }
}

async function extractMsg(buf, ctx, deps) {
  const MsgReader = (deps && deps.msgreader) || (() => { const m = require('@kenjiuno/msgreader'); return m.default || m; })();
  try {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const d = new MsgReader(ab).getFileData();
    if (!d || d.error) return { ok: false, kind: 'msg', reason: 'MSG_FAILED', errCode: 'MsgError' };
    const lines = [];
    const from = [d.senderName, d.senderEmail && '<' + d.senderEmail + '>'].filter(Boolean).join(' ');
    if (from) lines.push('From: ' + from);
    const rec = (d.recipients || []).map((r) => [r.name, r.email && '<' + r.email + '>'].filter(Boolean).join(' ')).filter(Boolean);
    if (rec.length) lines.push('To: ' + rec.join(', '));
    if (d.subject) lines.push('Subject: ' + d.subject);
    const body = String(d.body || '').trim();
    const atts = (d.attachments || []).slice(0, 50).map((a) => a.fileName || a.name || 'attachment');
    const text = lines.join('\n') + (body ? '\n\n' + body : '') + (atts.length ? '\n\nAttachments: ' + atts.join('; ') : '');
    return text.trim() ? _ok('msg', text) : { ok: false, kind: 'msg', reason: 'EMPTY' };
  } catch (e) {
    return { ok: false, kind: 'msg', reason: 'MSG_FAILED', errCode: errTag(e) };
  }
}

module.exports = { extractEml, extractMsg };
