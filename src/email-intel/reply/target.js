'use strict';
/**
 * email-intel/reply/target.js — the ONE rule for which ledger record a reply answers (draft, resolve and send agree).
 *
 *   replyTarget(records, apiOn) -> MessageRecord | null
 *     apiOn  (Outlook REST transport): the newest record with source:'api' (a leftover DOM-era twin that sorts last
 *            because it has no received time never wins, R4-M1), else the last record
 *     !apiOn the last record (unchanged DOM behavior)
 * Pure: records are the ledger conversation view, oldest first.
 */
function replyTarget(records, apiOn) {
  const list = Array.isArray(records) ? records : [];
  if (apiOn) for (let i = list.length - 1; i >= 0; i--) if (list[i] && list[i].source === 'api') return list[i];
  return list[list.length - 1] || null;
}

module.exports = { replyTarget };
