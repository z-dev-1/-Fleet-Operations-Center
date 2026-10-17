'use strict';
/**
 * orcha/fas/attachment-research.js — Digital FAS: read SHARED FILE attachments.
 *
 * Companion to link-research.js. Where link-research resolves URLs (incl. AAP
 * deep-links via the JSON API), THIS module reads the FILES a sender attaches
 * to a Slack message — the other half of the "it's failing on png urls / html
 * / pdfs" problem. For each Slack file object ({ name, mimetype, url_private }):
 *
 *   1. Download the raw bytes via the app's authenticated Slack path
 *      (slack_send.downloadFileBuffer — same Bearer-token auth used elsewhere).
 *   2. Extract readable content by type:
 *        - text / csv / json / md / log / plain html  -> decode directly
 *          (html is tag-stripped to visible text).
 *        - png / jpg / gif / webp (screenshots)        -> Bedrock vision
 *          (bedrock.readFileWithVision, `image` content block).
 *        - pdf / docx / xlsx (documents)               -> Bedrock document
 *          (bedrock.readFileWithVision, `document` content block).
 *   3. Run the extracted text through the injection guard (UNTRUSTED), cap it.
 *   4. Pull any unit/equipment ids out of the extracted text so the evidence
 *      builder can run the SAME per-unit research it runs for typed units and
 *      for AAP links — this is what turns "here's a screenshot of unit 320160"
 *      into real verified fleet facts instead of a stalled reply.
 *
 * Returns { evidence: [...], units: [...], refused: [...] } — matching the
 * shape researchLinks returns, so evidence.js can merge both uniformly.
 *
 * SECURITY: file content is UNTRUSTED. It is neutralized + fenced before it can
 * reach the model, and a discovered unit id never widens scope — GET_UNIT still
 * enforces per-unit authorization downstream.
 */

const guard = require('./injection-guard');
let logger; try { logger = require('../../utils/logger').createLogger('fas-attach'); } catch (_) { logger = { info(){}, warn(){} }; }

const MAX_TEXT = 6000;         // per-attachment excerpt cap fed to the model
const MAX_FILES = 3;           // cap files read per message (cost + latency)
const TEXT_DECODE_CAP = 20000; // raw text decode cap before trimming

// Lazily required so unit tests / non-app contexts don't hard-depend on them.
function _slackSend() { try { return require('../../scrapers/slack_send'); } catch (_) { return null; } }
function _bedrock() { try { return require('../../scrapers/bedrock'); } catch (_) { return null; } }

// Reuse the evidence builder's entity resolver so unit extraction here matches
// exactly how typed units are resolved (same fleet-row validation). Falls back
// to a simple token scan if that module isn't loadable (avoids a require cycle
// hard-failure — evidence.js requires THIS module).
function _extractUnits(text) {
  // Prefer fleet-validated units (resolveMessageEntities only returns tokens
  // that match a real equipmentId in synced fleetData) — those are safe to
  // research immediately.
  let validated = [];
  try {
    const ev = require('./evidence');
    if (ev && typeof ev.resolveMessageEntities === 'function') {
      const r = ev.resolveMessageEntities(text || '');
      validated = Array.isArray(r.units) ? r.units : [];
    }
  } catch (_) { /* fall through to token scan */ }
  // Also keep raw unit-shaped tokens as CANDIDATES. When fleet data is empty or
  // the attachment references a unit not in the current sync, validated[] is
  // empty and we'd otherwise drop a legit id — the raw candidates still get fed
  // to GET_UNIT, which re-validates + authorizes per unit (so a bogus token
  // simply yields "no record", it can't widen scope or fabricate a unit).
  const candidates = [];
  const re = /\b([A-Za-z]?\d{4,8})\b/g; let m;
  while ((m = re.exec(String(text || ''))) !== null) candidates.push(m[1]);
  return [...new Set([...validated, ...candidates])].slice(0, 10);
}

function _isTextual(file) {
  const mime = String((file && file.mimetype) || '').toLowerCase();
  const name = String((file && file.name) || '').toLowerCase();
  return mime.startsWith('text/') || mime.includes('json') || mime.includes('csv') ||
    mime.includes('markdown') || mime === 'text/html' ||
    /\.(txt|md|csv|json|log|tsv)$/.test(name);
}
function _isHtml(file) {
  const mime = String((file && file.mimetype) || '').toLowerCase();
  const name = String((file && file.name) || '').toLowerCase();
  return mime === 'text/html' || /\.html?$/.test(name);
}

// Strip HTML to visible text (no DOM; good enough for an untrusted excerpt).
function _htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * readAttachment(file) -> Promise<{ ok, title, text, kind } | { ok:false, reason }>
 * Downloads one Slack file and extracts readable content. Best-effort.
 */
async function readAttachment(file) {
  if (!file || !file.url_private) return { ok: false, reason: 'no downloadable file (missing url_private)' };
  const ss = _slackSend();
  if (!ss || typeof ss.downloadFileBuffer !== 'function') {
    return { ok: false, reason: 'slack download path unavailable (non-app context)' };
  }
  const name = file.name || 'attachment';

  // 1) Textual files: decode directly (no AI needed). Try the fast text path.
  if (_isTextual(file)) {
    try {
      let raw = null;
      if (typeof ss.downloadFileContent === 'function') {
        const r = await ss.downloadFileContent(file);
        if (r && typeof r.content === 'string') raw = r.content;
      }
      if (raw == null) {
        const buf = await ss.downloadFileBuffer(file);
        raw = buf && buf.buffer ? buf.buffer.toString('utf8') : null;
      }
      if (raw != null) {
        let text = _isHtml(file) ? _htmlToText(raw) : String(raw).slice(0, TEXT_DECODE_CAP);
        return { ok: true, kind: 'text', title: name, text: text.slice(0, TEXT_DECODE_CAP) };
      }
    } catch (e) { /* fall through to buffer/vision path */ }
  }

  // 2) Binary (image / pdf / office doc): download bytes, read via Bedrock.
  let dl;
  try { dl = await ss.downloadFileBuffer(file); }
  catch (e) { return { ok: false, reason: 'download failed: ' + e.message }; }
  if (!dl || !dl.buffer || !dl.buffer.length) return { ok: false, reason: 'download returned no bytes' };

  // HTML that slipped past the text path (served as octet-stream): tag-strip.
  if (_isHtml(file) || /text\/html/i.test(dl.mimetype || '')) {
    const text = _htmlToText(dl.buffer.toString('utf8'));
    if (text) return { ok: true, kind: 'html', title: name, text: text.slice(0, TEXT_DECODE_CAP) };
  }

  const bd = _bedrock();
  if (!bd || typeof bd.readFileWithVision !== 'function') {
    return { ok: false, reason: 'cannot read ' + (dl.mimetype || name) + ' (vision/document reader unavailable)' };
  }
  const vis = await bd.readFileWithVision({ name, mimetype: dl.mimetype, buffer: dl.buffer });
  if (vis && vis.ok && vis.text) return { ok: true, kind: vis.kind || 'binary', title: name, text: vis.text };
  return { ok: false, reason: (vis && vis.error) || 'could not read file content' };
}

/**
 * researchAttachments(files) -> Promise<{ evidence, units, refused }>
 * files: the Slack message's file objects ([] when nothing was attached).
 * Mirrors link-research.researchLinks' return shape so evidence.js merges both.
 */
async function researchAttachments(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const evidence = [];
  const refused = [];
  const units = [];
  for (const file of list.slice(0, MAX_FILES)) {
    let r;
    try { r = await readAttachment(file); }
    catch (e) { r = { ok: false, reason: 'read error: ' + e.message }; }
    const label = (file && file.name) || (file && file.id) || 'attachment';
    if (r && r.ok && r.text) {
      // UNTRUSTED: neutralize + fence-ready + cap before it reaches the model.
      const safe = guard.neutralize(r.text).slice(0, MAX_TEXT);
      const inj = guard.detectInjection(r.text);
      const found = _extractUnits(r.text);
      found.forEach(u => { if (u) units.push(u); });
      evidence.push({
        field: 'attachmentContent',
        value: {
          title: r.title || label,
          kind: r.kind || 'file',
          excerpt: safe,
          units: found.length ? found : undefined,
          injectionFlagged: inj.suspicious,
        },
        source: 'slack-attachment:' + label,
        retrievedAt: new Date().toISOString(),
      });
      logger.info('[fas-attach] read ' + label + ' (' + (r.kind || '?') + ')' + (found.length ? ' units=' + found.join(',') : ''));
    } else {
      refused.push({ file: label, reason: (r && r.reason) || 'unreadable' });
      logger.warn('[fas-attach] could not read ' + label + ' — ' + ((r && r.reason) || 'unreadable'));
    }
  }
  return { evidence, units: [...new Set(units)], refused };
}

module.exports = { readAttachment, researchAttachments, _htmlToText, _isTextual, _extractUnits };
