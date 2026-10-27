'use strict';
/**
 * wr_attach.js — add documents to an EXISTING (open) AAP work request.
 *
 * Reuses the same upload the WR create flow runs right after creating a WR
 * (aap_api.uploadWrAttachments: updateWorkRequest {images} first, presigned
 * doc/uploadLink fallback). Validation lives here so the IPC handler stays thin
 * and the rules are unit-testable.
 */

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ALLOWED_MIME = /^data:(image\/(png|jpe?g)|application\/pdf);base64,/i;
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // decoded size across all files

function _decodedBytes(dataUrl) {
  const i = dataUrl.indexOf(',');
  const b64 = i === -1 ? '' : dataUrl.slice(i + 1);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(b64.length * 3 / 4) - pad);
}

/**
 * validateAttachRequest({ workRequestId, attachments }) -> { ok, error?, workRequestId, attachments }
 * Accepts a raw UUID or an AAP /v2/service/<uuid> URL for the WR.
 */
function validateAttachRequest(req) {
  req = req || {};
  const m = String(req.workRequestId || '').match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
  const workRequestId = m ? m[0] : '';
  if (!UUID_RE.test(workRequestId)) return { ok: false, error: 'No valid work request id' };
  const list = Array.isArray(req.attachments) ? req.attachments : [];
  if (!list.length) return { ok: false, error: 'No files selected' };
  if (list.length > MAX_FILES) return { ok: false, error: 'Too many files (max ' + MAX_FILES + ')' };
  const attachments = [];
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    const a = list[i] || {};
    const dataUrl = String(a.dataUrl || '');
    const name = String(a.name || ('attachment-' + (i + 1))).slice(0, 200);
    if (!ALLOWED_MIME.test(dataUrl)) return { ok: false, error: '"' + name + '" is not a PNG, JPEG or PDF' };
    total += _decodedBytes(dataUrl);
    attachments.push({ name, dataUrl });
  }
  if (total > MAX_TOTAL_BYTES) return { ok: false, error: 'Files total ' + Math.round(total / 1048576) + ' MB (max 25 MB)' };
  return { ok: true, workRequestId, attachments };
}

/**
 * attachToOpenWr(req, deps?) -> { ok, workRequestId, results:[{name, ok, error?}], error? }
 */
async function attachToOpenWr(req, deps) {
  const v = validateAttachRequest(req);
  if (!v.ok) return { ok: false, error: v.error, results: [] };
  const upload = (deps && deps.uploadWrAttachments) || require('./aap_api').uploadWrAttachments;
  let results;
  try {
    results = await upload(v.workRequestId, v.attachments, {});
  } catch (e) {
    return { ok: false, workRequestId: v.workRequestId, error: e.message, results: [] };
  }
  results = Array.isArray(results) ? results : [];
  const okCount = results.filter((r) => r && r.ok).length;
  return { ok: okCount > 0 && okCount === results.length, partial: okCount > 0 && okCount < results.length,
    workRequestId: v.workRequestId, results };
}

module.exports = { validateAttachRequest, attachToOpenWr, MAX_FILES, MAX_TOTAL_BYTES };
