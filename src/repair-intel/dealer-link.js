'use strict';
/**
 * repair-intel/dealer-link.js — pure helpers that pick a historical WO's dealer
 * portal link and its 3C evidence from data we already have. NO URL is ever
 * built here: a dealer URL comes only from the AAP comment thread (via the
 * mapper's extractOffsiteFromComments, injected as `mapper`) or from the unit's
 * fleet row offsite, and only for the WO that owns that offsite.
 */

const { offsiteUrlOf } = require('../utils/offsite-owner');

const _BAD_CHARS = /[\s"'<>]/;

// https only; Decisiv estimate / service request or DTNA case pages only.
function isAllowedDealerUrl(url) {
  if (typeof url !== 'string' || !url || _BAD_CHARS.test(url)) return false;
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  const p = u.pathname;
  if (host.endsWith('.decisiv.net')) return p.startsWith('/fleet/estimates/') || p.startsWith('/service_requests/');
  if (host === 'dtna.my.site.com') return p.startsWith('/Servicetracker/s/case/');
  return false;
}

// Dealer link from a getService detail's comment thread → { url, source, label } | null.
function dealerFromDetail(detail, mapper) {
  if (!detail || !mapper || typeof mapper.extractOffsiteFromComments !== 'function') return null;
  let hit = null;
  try { hit = mapper.extractOffsiteFromComments(detail); } catch (_) { return null; }
  if (!hit || !isAllowedDealerUrl(hit.url)) return null;
  return { url: hit.url, source: hit.source || null, label: hit.label || null };
}

// The unit row's offsite belongs to row._offsiteWrId when stamped, else to the
// row's current workRequestId (same rule as src/window/index.js).
function ownsOffsite(row, workOrderId) {
  const id = String(workOrderId == null ? '' : workOrderId);
  if (!row || !id) return false;
  return row._offsiteWrId ? String(row._offsiteWrId) === id : String(row.workRequestId || '') === id;
}

function dealerFromUnitRow(row, workOrderId) {
  if (!ownsOffsite(row, workOrderId)) return null;
  const url = offsiteUrlOf(row);
  if (!isAllowedDealerUrl(url)) return null;
  return { url, source: 'unit_row', label: row.asistLabel || 'Dealer' };
}

function offsiteNotesFor(row, workOrderId) {
  return ownsOffsite(row, workOrderId) ? String(row.asistNotes || '').slice(0, 4000) : '';
}

const EV_MAX_COMMENTS = 30;
const EV_MAX_COMMENT_CHARS = 600;
const EV_MAX_TOTAL = 8000;

function _str(v) { return v == null ? '' : String(v).trim(); }
function _epoch(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
}

// Capped 3C evidence from a getService detail. Only text fields are copied —
// never author/createdBy/name fields.
function evidenceFromDetail(detail, mapper) {
  if (!detail) return null;
  const wr = detail.workRequest || {};
  const wos = Array.isArray(detail.workOrders) ? detail.workOrders : [];
  const join = (k) => wos.map(w => _str(w && w[k])).filter(Boolean).join('; ');
  let budget = EV_MAX_TOTAL;
  const take = (s) => { const out = s.slice(0, Math.max(0, budget)); budget -= out.length; return out; };
  const complaint = take(_str(wr.damageDescription || wr.title).slice(0, EV_MAX_COMMENT_CHARS * 2));
  const cause = take(join('cause').slice(0, EV_MAX_COMMENT_CHARS * 2));
  const correction = take(join('correction').slice(0, EV_MAX_COMMENT_CHARS * 2));

  let all = [];
  try { all = (mapper && typeof mapper.collectAllComments === 'function') ? (mapper.collectAllComments(detail) || []) : []; } catch (_) { all = []; }
  const newest = all.slice(-EV_MAX_COMMENTS); // collectAllComments is oldest-first
  // Fill the budget newest-first, then return oldest-first.
  const kept = [];
  for (let i = newest.length - 1; i >= 0 && budget > 0; i--) {
    const c = newest[i];
    const text = take(_str(c && c.text).slice(0, EV_MAX_COMMENT_CHARS));
    if (!text) continue;
    kept.unshift({ at: _epoch(c.timestamp), text });
  }
  const last = all.length ? _epoch(all[all.length - 1].timestamp) : null;
  return { v: 1, complaint, cause, correction, comments: kept, commentCount: all.length, lastCommentAt: last };
}

module.exports = {
  isAllowedDealerUrl, dealerFromDetail, ownsOffsite, dealerFromUnitRow, offsiteNotesFor, evidenceFromDetail,
  EV_MAX_COMMENTS, EV_MAX_COMMENT_CHARS, EV_MAX_TOTAL,
};
