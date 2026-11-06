'use strict';
/**
 * email-intel/reliability/status.js — scan outcome derivation and the status document
 * (design 2.7, 8.6; R1.7, R8.5, F2-10). Pure: all inputs are passed in.
 *
 *   deriveOutcome(input)        -> { outcome, partial, readError, errorCode }
 *   buildWarnings(input)        -> [{ code, severity }]
 *   WARNING_SEVERITY / severityOf(code)
 *   buildStatus(input)          -> the emailIntel:status document
 *
 * Outcomes: complete | partial | auth-blocked | failed | aborted | skipped.
 * Every text produced here is built from enums and counts, never from message content.
 */
const cfgMod = require('../config');

// F2-10: identity-not-set is a real warning; fas-name-not-set is informational only.
const WARNING_SEVERITY = Object.freeze({
  'identity-not-set': 'warning',
  'fas-name-not-set': 'info',
  'timelineWrites-needs-actionsView': 'warning',
  'isolated-lane-unavailable': 'warning',
  'storeVersionNewer': 'warning',
  'stagedOverCap': 'warning',
  'storeError': 'error',
  'auth-blocked': 'error',
  'partial-scan': 'warning',
  'folder-not-found': 'warning',
  'too-many-folders-for-max': 'info',
  'unknown-folder': 'info',
  'minConfidence-reset': 'info',
});
const severityOf = (code) => WARNING_SEVERITY[code] || (/^(clamped|ignored|truncated)-/.test(String(code)) ? 'info' : 'info');

const PARTIAL_FOLDER = new Set(['partial', 'skipped-budget', 'timeout', 'not-found', 'not-reached', 'error']);

/**
 * deriveOutcome({ skipped, storeError, reader, committed, pendingAnalysis, deadlineHit })
 *   reader: the readMailbox result ({ ok, authBlocked, aborted, timedOut, folders, error }) or null
 *   committed: messages committed this scan
 * -> { outcome, partial, readError, errorCode }  (readError is the legacy enum text, no content)
 */
function deriveOutcome(o) {
  o = o || {};
  const r = o.reader || null;
  const committed = Number(o.committed) || 0;
  if (o.skipped) return { outcome: 'skipped', partial: false, readError: null, errorCode: 'busy' };
  if (o.storeError) return { outcome: 'failed', partial: committed > 0, readError: 'read failed', errorCode: 'store' };
  if (!r) return { outcome: 'failed', partial: false, readError: 'read failed', errorCode: 'read-failed' };
  if (r.authBlocked) return { outcome: 'auth-blocked', partial: committed > 0, readError: 'auth blocked', errorCode: 'auth' };
  if (r.aborted) return { outcome: 'aborted', partial: committed > 0, readError: 'read failed', errorCode: 'aborted' };
  const folders = Array.isArray(r.folders) ? r.folders : [];
  const readAny = folders.some((f) => f.status === 'ok' || f.status === 'skipped-budget' || f.status === 'partial' || f.status === 'timeout');
  if (!readAny && !committed) return { outcome: 'failed', partial: false, readError: 'read failed', errorCode: r.error ? String(r.error).replace(/[^a-z-]/gi, '').slice(0, 40) : 'read-failed' };
  // Something was read. Name the most significant reason a scan is not complete.
  let reason = null;
  if (o.deadlineHit || folders.some((f) => f.deadline)) reason = 'deadline';
  else if (r.timedOut || folders.some((f) => f.status === 'timeout')) reason = 'timeout';
  else if (folders.some((f) => f.status === 'not-found')) reason = 'folder-not-found';
  else if (folders.some((f) => f.status === 'skipped-budget' || (f.backlog && f.backlogRemaining > 0))) reason = 'budget';
  else if (folders.some((f) => PARTIAL_FOLDER.has(f.status))) reason = 'folder-' + (folders.find((f) => PARTIAL_FOLDER.has(f.status)).status);
  else if (folders.some((f) => (f.retried || 0) > 0)) reason = 'preview-retry';            // a pane could not be read; retried next scan (F-03)
  else if ((Number(o.pendingAnalysis) || 0) > 0) reason = 'pending-analysis';
  if (reason) return { outcome: 'partial', partial: true, readError: 'partial: ' + reason, errorCode: reason };
  return { outcome: 'complete', partial: false, readError: null, errorCode: null };
}

/** Warnings derived from config, flags and the last scan. `extra` carries codes from other modules. */
function buildWarnings(o) {
  o = o || {};
  const codes = [];
  const add = (c) => { if (c && !codes.includes(c)) codes.push(c); };
  const cfg = o.config || null;
  if (cfg) {
    if (!cfgMod.isIdentitySet(cfg)) add('identity-not-set');
    if (!cfgMod.isFasNameSet(cfg)) add('fas-name-not-set');
  }
  for (const w of o.flagWarnings || []) add(w);
  for (const w of o.extra || []) add(w);
  const last = o.lastScan || null;
  if (last) {
    if (last.outcome === 'auth-blocked') add('auth-blocked');
    if (last.outcome === 'failed' && last.errorCode === 'store') add('storeError');
    if (last.partial && last.outcome === 'partial') add('partial-scan');
    if ((last.folders || []).some((f) => f.status === 'not-found')) add('folder-not-found');
  }
  for (const s of o.readOnlyStores || []) { if (s) add('storeVersionNewer'); }
  return codes.map((code) => ({ code, severity: severityOf(code) }));
}

/**
 * buildStatus(input) -> status document (design 8.6). Never contains identity values, subjects,
 * bodies or addresses; folder names are the user's configured labels and are returned to the UI only.
 * input: { enabled, flags, config, checkpoints, messages, running, current, flagWarnings, readOnlyStores, extraWarnings }
 */
function buildStatus(i) {
  i = i || {};
  const ck = i.checkpoints || {};
  const scan = ck.scan || {};
  const folders = Object.keys(ck.folders || {}).map((name) => {
    const f = ck.folders[name] || {};
    return { folder: name, newestSeenAt: f.newestReceivedAt || null, caughtUp: f.backlog ? false : f.lastOutcome != null, lastOutcome: f.lastOutcome || null, lastOkAt: f.lastOkAt || null, backlog: !!f.backlog, backlogRemaining: f.backlogRemaining || 0 };
  });
  const auth = ck.owaAuth || { state: 'unknown', lastOkAt: null, lastBlockedAt: null, blockedCount: 0 };
  let pendingAnalysis = 0;
  const msgs = (i.messages && i.messages.messages) || {};
  for (const k of Object.keys(msgs)) if (/^pending/.test(String((msgs[k].analysis || {}).status || ''))) pendingAnalysis++;
  const warnings = buildWarnings({ config: i.config, flagWarnings: i.flagWarnings, extra: i.extraWarnings, lastScan: scan.last, readOnlyStores: i.readOnlyStores });
  return {
    ok: true, enabled: !!i.enabled, flags: i.flags || {},
    scan: { running: !!i.running, current: i.running ? (i.current || scan.current || null) : null, last: scan.last || null },
    checkpoints: { folders },
    backlog: { pendingAnalysis, openActions: 0, openStaged: 0, unreconciledSends: 0 },
    owaAuth: { state: auth.state || 'unknown', lastOkAt: auth.lastOkAt || null, lastBlockedAt: auth.lastBlockedAt || null, blockedCount: auth.blockedCount || 0 },
    lane: i.lane && i.lane.state ? { state: i.lane.state, checkedAt: i.lane.checkedAt || null } : { state: 'unknown', checkedAt: null },
    aiGateway: null,
    identity: { set: i.config ? cfgMod.isIdentitySet(i.config) : false },
    midway: null, supervisor: null, jobs: null,
    warnings: warnings.map((w) => w.code),
    warningDetails: warnings,
  };
}

module.exports = { WARNING_SEVERITY, severityOf, deriveOutcome, buildWarnings, buildStatus };
