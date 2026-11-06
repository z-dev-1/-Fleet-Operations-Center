'use strict';
/**
 * email-intel/capture/folder-plan.js — folder fairness, row signatures, backlog drain
 * (design 2.2, 2.7; F-04, F-05).
 *
 *   rowSig(...)                    stable row signature (ignores unread state and time token)
 *   planFolderBudgets(...)         per-folder quota, rotated order, spill budget
 *   allocateSpill(...)             pass 2: hand leftover budget to folders that still have rows
 *   classifyRow(...)               'known' | 'new' for a row vs the folder checkpoint
 *   computeBacklog(...)            the F-04 backlog rule
 *   nextRotation(...)              rotate which folder goes first
 *   emptyFolderCheckpoint / recordSeen / recordRetry   checkpoint shape helpers
 *
 * Folder checkpoint shape:
 *   { folder, seenRows:{[convKey]:rowSig} (LRU 300), rowRetries:{[convKey]:n}, backlog, backlogRemaining,
 *     newestReceivedAt, lastOutcome, lastOkAt }
 */
const crypto = require('crypto');
const C = require('../constants');

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

/** First 120 chars of the preview, lowercased with whitespace collapsed. */
function normPreview120(preview) {
  return String(preview == null ? '' : preview).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** "N messages" / "N items" count token from a row aria label, or ''. */
function parseMsgCount(aria) {
  const m = /\b(\d{1,4})\s+(messages?|items?)\b/i.exec(String(aria || ''));
  return m ? m[1] : '';
}

/**
 * rowSig({ convKey, preview, msgCountToken }) = sha1(convKey|normPreview120|msgCountToken)
 * Deliberately EXCLUDES the unread state (opening a row marks it read) and the relative time
 * token (it changes at day rollover), so an ingested row never looks new on the next scan. A new
 * reply changes the preview or the count, so it still produces a new signature.
 */
function rowSig(o) {
  o = o || {};
  return sha1(String(o.convKey || '') + '|' + normPreview120(o.preview) + '|' + (o.msgCountToken || ''));
}

function emptyFolderCheckpoint(folder) {
  return { folder, seenRows: {}, rowRetries: {}, backlog: false, backlogRemaining: 0, newestReceivedAt: null, lastOutcome: null, lastOkAt: null };
}

function _rotate(list, start) {
  const n = list.length;
  if (!n) return [];
  const s = ((start % n) + n) % n;
  return list.slice(s).concat(list.slice(0, s));
}

/**
 * planFolderBudgets({ folders, max, minPer, rotationNext, checkpoints }) ->
 *   { order, quota:{folder:n}, spill, max, warnings }
 * q = max(minPer, floor(max / folders)). When folders * minPer exceeds max, max is raised to
 * folders * minPer up to the hard cap and the status warns `too-many-folders-for-max`; when even
 * that does not fit, earlier folders in rotation order lose the surplus first.
 */
function planFolderBudgets(o) {
  o = o || {};
  const folders = Array.isArray(o.folders) ? o.folders.filter(Boolean) : [];
  const warnings = [];
  const minPer = Number.isFinite(o.minPer) ? o.minPer : C.MIN_PER_FOLDER;
  let max = Math.max(1, Math.min(C.MAX_EMAILS_HARD, Number.isFinite(o.max) ? Math.trunc(o.max) : C.MAX_EMAILS_DEFAULT));
  const order = _rotate(folders, Number.isFinite(o.rotationNext) ? o.rotationNext : 0);
  const n = order.length;
  const quota = {};
  if (!n) return { order, quota, spill: 0, max, warnings };
  if (n * minPer > max) {
    max = Math.min(n * minPer, C.MAX_EMAILS_HARD);
    warnings.push('too-many-folders-for-max');
  }
  const q = Math.max(minPer, Math.floor(max / n));
  for (const f of order) quota[f] = q;
  let sum = q * n;
  // Surplus (only when even the raised max cannot fit): earlier folders lose it first, down to 1.
  for (let i = 0; sum > max && i < n * q; i++) {
    const f = order[i % n];
    if (quota[f] > 1) { quota[f]--; sum--; }
  }
  return { order, quota, spill: Math.max(0, max - sum), max, warnings };
}

/**
 * allocateSpill({ order, spill, hasMore:{folder:bool}, checkpoints }) -> [{ folder, extra }]
 * Round-robin, one message at a time, to folders that reported unseen rows left; folders that
 * already carry a backlog go first.
 */
function allocateSpill(o) {
  o = o || {};
  const order = Array.isArray(o.order) ? o.order : [];
  const hasMore = o.hasMore || {};
  const cps = o.checkpoints || {};
  const wanting = order.filter((f) => hasMore[f]);
  const backlogFirst = wanting.filter((f) => cps[f] && cps[f].backlog).concat(wanting.filter((f) => !(cps[f] && cps[f].backlog)));
  const extra = {};
  let left = Math.max(0, Math.trunc(o.spill || 0));
  while (left > 0 && backlogFirst.length) {
    for (const f of backlogFirst) {
      if (left <= 0) break;
      extra[f] = (extra[f] || 0) + 1; left--;
    }
  }
  return Object.keys(extra).map((folder) => ({ folder, extra: extra[folder] }));
}

/** nextRotation(current, folderCount) -> the folder that went first this time goes last next time. */
function nextRotation(current, count) {
  const n = Math.max(1, Math.trunc(count || 1));
  return ((Number.isFinite(current) ? current : 0) + 1) % n;
}

/** classifyRow(ckpt, convKey, sig) -> 'known' when the stored signature matches, else 'new'. */
function classifyRow(ckpt, convKey, sig) {
  const seen = ckpt && ckpt.seenRows;
  return seen && seen[convKey] === sig ? 'known' : 'new';
}

/** Stop rule: a caught-up (non-backlog) folder stops after KNOWN_ROWS_STOP consecutive known rows. */
function shouldStopOnKnown(consecutiveKnown, backlog) {
  return !backlog && consecutiveKnown >= C.KNOWN_ROWS_STOP;
}

/**
 * computeBacklog({ prevBacklog, interrupted, budgetExhausted, leftUnseen, reachedEnd, reachedHorizon,
 *                  examinedCap, stoppedOnKnown }) -> boolean
 * true: the scan ended because the budget ran out, or unseen rows remain, or it was interrupted.
 * false: the scan reached the end of the list, passed the lookback horizon, examined every row up to the
 * cap without exhausting its budget, or (only when not already draining) stopped on 8 known rows.
 */
function computeBacklog(o) {
  o = o || {};
  if (o.interrupted) return true;
  if ((o.leftUnseen || 0) > 0) return true;
  if (o.reachedEnd || o.reachedHorizon) return false;
  if (o.examinedCap && !o.budgetExhausted) return false;
  if (o.budgetExhausted) return true;
  if (o.stoppedOnKnown && !o.prevBacklog) return false;
  return !!o.prevBacklog;
}

/** recordSeen(ckpt, convKey, sig): LRU insert (most recent last); trims to SEEN_ROWS_LRU. Mutates and returns ckpt. */
function recordSeen(ckpt, convKey, sig) {
  const seen = ckpt.seenRows || (ckpt.seenRows = {});
  if (Object.prototype.hasOwnProperty.call(seen, convKey)) delete seen[convKey];
  seen[convKey] = sig;
  const keys = Object.keys(seen);
  for (let i = 0; i < keys.length - C.SEEN_ROWS_LRU; i++) delete seen[keys[i]];
  if (ckpt.rowRetries && ckpt.rowRetries[convKey]) delete ckpt.rowRetries[convKey];
  return ckpt;
}

/** recordRetry(ckpt, convKey) -> new retry count (a failed pane read; the row is not checkpointed). */
function recordRetry(ckpt, convKey) {
  const r = ckpt.rowRetries || (ckpt.rowRetries = {});
  r[convKey] = (r[convKey] || 0) + 1;
  const keys = Object.keys(r);
  for (let i = 0; i < keys.length - C.SEEN_ROWS_LRU; i++) delete r[keys[i]];
  return r[convKey];
}

/** After PREVIEW_RETRY_MAX failed scans the message is committed as preview-only so it is not lost. */
function shouldCommitPreviewOnly(ckpt, convKey) {
  return ((ckpt && ckpt.rowRetries && ckpt.rowRetries[convKey]) || 0) + 1 >= C.PREVIEW_RETRY_MAX;
}

module.exports = {
  normPreview120, parseMsgCount, rowSig, emptyFolderCheckpoint, planFolderBudgets, allocateSpill, nextRotation,
  classifyRow, shouldStopOnKnown, computeBacklog, recordSeen, recordRetry, shouldCommitPreviewOnly,
};
