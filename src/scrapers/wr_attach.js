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
// AAP's raw vendor code (e.g. "AMERIT") from a serviceaggregates response.
// The shape nests the work request at varying depths, so search breadth-first
// for the first non-empty string `vendor` (or vendorId) field.
function findVendorCode(detail) {
  const queue = [detail];
  let guard = 0;
  while (queue.length && guard++ < 2000) {
    const n = queue.shift();
    if (!n || typeof n !== 'object') continue;
    for (const k of ['vendor', 'vendorId', 'vendorCode']) {
      if (typeof n[k] === 'string' && n[k].trim()) return n[k].trim();
    }
    for (const v of Object.values(n)) if (v && typeof v === 'object') queue.push(v);
  }
  return '';
}

async function attachToOpenWr(req, deps) {
  const v = validateAttachRequest(req);
  if (!v.ok) return { ok: false, error: v.error, results: [] };
  const api = (deps && deps.api) || null;
  const upload = (deps && deps.uploadWrAttachments) || (api && api.uploadWrAttachments) || require('./aap_api').uploadWrAttachments;
  const getService = (deps && deps.getService) || (api && api.getService) || require('./aap_api').getService;

  // AAP's upload-link call requires the WR's vendor (non-null) — the create
  // flow has it in hand; for an existing WR, read it from AAP.
  let vendor = String((req && req.vendor) || '').trim();
  if (!vendor) {
    try { vendor = findVendorCode(await getService(v.workRequestId)); } catch (_) { vendor = ''; }
  }
  if (!vendor) {
    return { ok: false, workRequestId: v.workRequestId, results: [],
      error: 'Could not find the vendor on WR ' + v.workRequestId.slice(0, 8) + ' — AAP needs it to accept documents. Assign a vendor first.' };
  }

  let results;
  try {
    results = await upload(v.workRequestId, v.attachments, { vendor, skipImagesPath: true });
  } catch (e) {
    return { ok: false, workRequestId: v.workRequestId, error: e.message, results: [] };
  }
  results = Array.isArray(results) ? results : [];
  const okCount = results.filter((r) => r && r.ok).length;
  return { ok: okCount > 0 && okCount === results.length, partial: okCount > 0 && okCount < results.length,
    workRequestId: v.workRequestId, results };
}

module.exports = { validateAttachRequest, attachToOpenWr, findVendorCode, MAX_FILES, MAX_TOTAL_BYTES };
