'use strict';
/**
 * timeline-freshness.js — decide when a unit's AI timeline must be rebuilt.
 *
 * The timeline is generated from the WR conversation(s) + the offsite dealer
 * notes (ASIST/Decisiv/DTNA). If those inputs change, the timeline is stale.
 * The signature only covers what the timeline builder actually reads (offsite
 * text is truncated to 3000 chars there), so cosmetic row changes don't cause
 * extra AI calls.
 */

const crypto = require('crypto');

function _norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function timelineInputSignature(row) {
  if (!row) return '';
  const parts = [
    _norm(row.fullConversation),
    _norm(String(row.asistNotes || '').slice(0, 3000)),
    _norm(row._plannedWRData && row._plannedWRData.fullConversation),
    ...(Array.isArray(row._secondaryWRs) ? row._secondaryWRs.map((w) => _norm(w && w.fullConversation)) : []),
  ];
  if (!parts.some(Boolean)) return '';
  return crypto.createHash('sha1').update(parts.join('\u0001')).digest('hex').slice(0, 16);
}

module.exports = { timelineInputSignature };
