'use strict';
/**
 * email-intel/index.js — entry point of the Email Triage Intelligence module.
 *
 *   engaged()                      effective.capture (the master gate)
 *   runIntelScan(opts, trigger)    trigger: 'manual' | 'scheduled' (chat counts as manual) -> LegacyResults
 *   scheduledTick(ctx, cfg, deps)  supervisor / legacy timer entry
 *   getStatus()                    read-only status document (design 8.6)
 *
 * Phase A (`capture`): message-level capture, per-folder checkpoints with backlog drain, the message
 * ledger, single-flight, deadline and bounds. Understanding is still the legacy 1,500-character
 * triageEmails (Phase B replaces it); the ledger is mapped back onto the legacy results shape so every
 * existing caller keeps working (F-01). runIntelScan covers design 8.2 steps 0-2, 7 and 10-12.
 *
 * Phase B (`multiRecipient`): stage 5 replaces the legacy triage with the v2 analysis
 * (understand/analyze.js through the isolated lane only) and derives the legacy fields by code
 * (legacy-adapter buildPhaseBResults). Nothing is written to unit timelines in Phase B.
 *
 * Every error ends in a LegacyResults object (never a throw to the caller); logs carry counts and
 * enums only (redact.js), never message content.
 */
const crypto = require('crypto');
const flags = require('./flags');
const C = require('./constants');
const stores = require('./stores');
const cfgMod = require('./config');
const lock = require('./reliability/lock');
const statusMod = require('./reliability/status');
const fp = require('./capture/folder-plan');
const ledger = require('./ingest/ledger');
const adapter = require('./ingest/legacy-adapter');
const { safeErr, errName } = require('./redact');
let logger;
try { logger = require('../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

function engaged() {
  try { return flags.engaged(); } catch (_) { return false; }
}

const _triage = () => require('../scrapers/email_triage');

function _canonicalFor(unit) {
  try { return require('../orcha/canonical_state').getCanonical(unit); } catch (_) { return null; }
}

function _folderList(opts, cfg, legacyCfg) {
  const raw = Array.isArray(opts.folders) && opts.folders.length ? opts.folders
    : (Array.isArray(cfg.folders) && cfg.folders.length ? cfg.folders : (Array.isArray(legacyCfg.folders) && legacyCfg.folders.length ? legacyCfg.folders : ['Inbox']));
  const seen = new Set(); const out = [];
  for (const f of raw) {
    const s = String(f == null ? '' : f).trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase()); out.push(s);
    if (out.length >= C.MAILBOX_FOLDERS_MAX) break;
  }
  return out.length ? out : ['Inbox'];
}

function _recordScanEnd(scan, extra) {
  stores.update('checkpoints', (ck) => {
    ck.scan = ck.scan || {};
    ck.scan.last = Object.assign({}, scan, extra || {});
    ck.scan.current = null;
    return ck;
  });
}

/** One scan under the lock. Always resolves to LegacyResults; throws only for programming errors (caught by the caller). */
async function _scan(opts, trigger) {
  const startedAt = Number.isFinite(opts._now) ? opts._now : Date.now();
  const nowIso = new Date(startedAt).toISOString();
  const scanId = 'sc_' + crypto.randomBytes(4).toString('hex');
  const wallStart = Date.now();
  const deadlineAt = wallStart + C.SCAN_DEADLINE_MS;                          // F-20 (wall clock: the reader and AI queue compare to Date.now())
  const triage = _triage();
  const legacyCfg = triage.getConfig();                                        // read ONCE per scan (F2-01)
  const cfg = cfgMod.normalize(stores.load('config'));
  const store = require('../store');
  const prevResults = triage.loadResults();

  if (stores.isReadOnly('checkpoints') || stores.isReadOnly('messages')) {
    logger.warn('[email-intel] scan refused: a store is from a newer build (read-only)');
    return adapter.failedResults(prevResults, 'read failed', 'store-newer-version');
  }

  const folders = _folderList(opts, cfg, legacyCfg);
  const maxReq = Number.isFinite(opts.max) ? opts.max : (Number.isFinite(legacyCfg.maxEmails) ? legacyCfg.maxEmails : cfg.caps.maxEmails);
  const startCk = stores.load('checkpoints');
  const plan = fp.planFolderBudgets({ folders, max: maxReq, rotationNext: Number.isFinite(startCk.rotation) ? startCk.rotation : 0 });
  const ckSnapshot = JSON.parse(JSON.stringify(startCk.folders || {}));       // the reader must not see this scan's own commits

  stores.update('checkpoints', (ck) => { ck.scan = ck.scan || {}; ck.scan.current = { scanId, startedAt: nowIso, trigger }; return ck; });
  logger.info('[email-intel] scan start id=' + scanId + ' trigger=' + trigger + ' folders=' + folders.length + ' max=' + plan.max);

  const stats = { newMessages: 0, upgraded: 0, committedRows: 0 };
  const touched = new Set();
  let storeError = null;

  const onBatch = async (folder, items) => {
    const r1 = stores.update('messages', (doc) => {
      ledger.ensureDoc(doc);
      for (const it of items) {
        for (const cap of it.captures) {
          const res = ledger.buildRecord(cap, doc, { me: cfg.me, banners: cfg.banners, scanId, now: startedAt, threadContextIncomplete: !!cap.threadContextIncomplete });
          if (!res) continue;
          if (res.created) { ledger.upsert(doc, res.record); stats.newMessages++; } else if (res.upgraded) stats.upgraded++;
          touched.add(res.record.conversationKey);
        }
      }
      return doc;
    });
    if (!r1.ok) { storeError = r1.code || 'store'; throw new Error('store-write'); }
    // The row signature is checkpointed only AFTER its messages are committed.
    const r2 = stores.update('checkpoints', (ck) => {
      ck.folders = ck.folders || {};
      const f = ck.folders[folder] || (ck.folders[folder] = fp.emptyFolderCheckpoint(folder));
      for (const it of items) { fp.recordSeen(f, it.rowKey, it.rowSig); stats.committedRows++; }
      return ck;
    });
    if (!r2.ok) { storeError = r2.code || 'store'; throw new Error('store-write'); }
  };

  const readFn = opts._readMailbox || require('./capture/owa_capture').readMailbox;
  let reader = null;
  try {
    reader = await readFn({
      folders, plan, checkpoints: ckSnapshot, onBatch, signal: opts.signal, deadlineAt,
      caps: { maxOpen: Math.min(cfg.caps.maxOpen, C.MAX_OPEN_HARD) }, lookbackDays: cfg.caps.lookbackDays, now: startedAt,
      timeoutMs: opts.readTimeoutMs, authGraceMs: opts.authGraceMs, _electron: opts._electron, _warm: opts._warm, _sleep: opts._sleep,
    });
  } catch (e) {
    logger.warn('[email-intel] reader threw ' + safeErr(e));
    reader = null;
  }

  // Final per-folder checkpoint reconcile (the per-batch commits already hold the rows).
  const endMs = Date.now();
  const endIso = new Date(endMs).toISOString();
  if (reader && !storeError) {
    const r = stores.update('checkpoints', (ck) => {
      ck.folders = ck.folders || {};
      for (const o of reader.folders || []) {
        if (o.status === 'not-reached') continue;
        const f = ck.folders[o.folder] || (ck.folders[o.folder] = fp.emptyFolderCheckpoint(o.folder));
        f.backlog = !!o.backlog; f.backlogRemaining = o.backlogRemaining || 0; f.lastOutcome = o.status;
        if (o.newestSeenAt && (!f.newestReceivedAt || o.newestSeenAt > f.newestReceivedAt)) f.newestReceivedAt = o.newestSeenAt;
        if (o.status === 'ok' || o.status === 'skipped-budget') f.lastOkAt = endIso;
        for (const k of o.retryKeys || []) fp.recordRetry(f, k);
      }
      ck.rotation = fp.nextRotation(ck.rotation, folders.length);
      const a = ck.owaAuth || { state: 'unknown', lastOkAt: null, lastBlockedAt: null, blockedCount: 0 };
      if (reader.authBlocked) { a.state = 'blocked'; a.lastBlockedAt = endIso; a.blockedCount = (a.blockedCount || 0) + 1; }
      else if (reader.ok) { a.state = 'ok'; a.lastOkAt = endIso; }
      ck.owaAuth = a;
      return ck;
    });
    if (!r.ok) storeError = r.code || 'store';
  }
  if (!storeError) {
    const pinned = _pinnedByStaged();
    stores.update('messages', (doc) => { ledger.applyRetention(doc, pinned ? { now: endMs, pinned } : { now: endMs }); return doc; });
  }

  // Decisions + results. Phase A: the legacy triageEmails on the latest message of each conversation.
  // Phase B (multiRecipient): stage 5, the v2 analysis through the isolated lane; legacy fields by code.
  const deadlineHit = !!(reader && (reader.folders || []).some((f) => f.deadline));
  let d;
  let results;
  if (storeError) {
    d = statusMod.deriveOutcome({ reader, committed: stats.newMessages + stats.upgraded, storeError, deadlineHit });
    results = adapter.failedResults(prevResults, 'read failed', 'store');
  } else if (_multiRecipient()) {
    const u = await _understand({ opts, trigger, cfg, legacyCfg, store, prevResults, touched, startedAt, deadlineAt, scanId, reader, committed: stats.newMessages + stats.upgraded, deadlineHit });
    d = u.d; results = u.results;
  } else {
    d = statusMod.deriveOutcome({ reader, committed: stats.newMessages + stats.upgraded, storeError, deadlineHit });
    results = await _buildLegacy({ opts, triage, store, prevResults, touched, legacyCfg, plan, d, scanId, endMs, readerOk: !!reader });
  }
  results.intel = Object.assign({}, results.intel, { scanId, outcome: d.outcome, partial: d.partial, coalesced: false });

  _recordScanEnd({
    scanId, startedAt: nowIso, endedAt: endIso, outcome: d.outcome, partial: d.partial, trigger, errorCode: d.errorCode || undefined,
    folders: reader ? reader.folders.map((f) => ({ folder: f.folder, status: f.status, requested: f.requested, examined: f.examined, opened: f.opened, ingested: f.ingested, skippedKnown: f.skippedKnown, caughtUp: f.caughtUp, backlog: f.backlog, backlogRemaining: f.backlogRemaining, retried: f.retried || 0 })) : [],
    counts: { newMessages: stats.newMessages, rows: stats.committedRows, opened: reader ? reader.opened : 0, rowsExamined: reader ? reader.rowsExamined : 0 },
  });
  logger.info('[email-intel] scan end id=' + scanId + ' outcome=' + d.outcome + ' new=' + stats.newMessages + ' opened=' + (reader ? reader.opened : 0) + ' ms=' + (Date.now() - wallStart));
  return results;
}

function _multiRecipient() {
  try { return flags.get().effective.multiRecipient === true; } catch (_) { return false; }
}

/** Messages referenced by open staged items are never evicted (design 1.2). Phase B/C only. */
function _pinnedByStaged() {
  if (!_multiRecipient()) return null;
  try { return require('./facts/staged').openMessageKeys(stores.load('staged')); } catch (_) { return null; }
}

/**
 * Stage 5 (Phase B): analyze every eligible message through the isolated lane (one call at a time,
 * budgeted, deadline-aware), commit each analysis as it finishes, then derive the legacy results by
 * code. Legacy triageEmails is not called; legacy applyPendingUnitUpdates returns 0 (email_triage hook).
 */
async function _understand(o) {
  const { opts, trigger, cfg, legacyCfg, store, prevResults, touched, startedAt, deadlineAt, scanId, reader } = o;
  const analyze = require('./understand/analyze');
  const scopeMod = require('./understand/scope');
  const msgDoc = ledger.ensureDoc(stores.load('messages'));
  const index = scopeMod.buildScopeIndex({ now: startedAt, fasName: cfg.me && cfg.me.fasName });
  if (!index.ready || index.stale) logger.warn('[email-intel] fleet scope unknown reason=' + index.reason);
  const changed = new Set(touched);
  let commitFailed = null;
  const commit = (key, a) => {
    const rec = msgDoc.messages[key];
    if (rec) changed.add(rec.conversationKey);
    const r = stores.update('messages', (doc) => { const x = doc.messages && doc.messages[key]; if (x) x.analysis = a; return doc; });
    if (!r.ok && !commitFailed) commitFailed = r.code || 'store';
  };
  const pipeline = require('./facts/pipeline');
  let effective = {};
  try { effective = flags.get().effective || {}; } catch (_) { effective = {}; }
  // Steps 4-5 (Phase C): pending-write reconcile, staged caps, per-phase legacy bootstrap (before any rebuild).
  try { await pipeline.beforeAnalysis({ effective, prevResults, lookbackDays: cfg.caps.lookbackDays }); } catch (e) { logger.warn('[email-intel] fact pre-pass failed ' + errName(e)); }
  let stats = null;
  try {
    stats = await analyze.runScanAnalysis(msgDoc, {
      index, me: cfg.me, cfg, trigger, signal: opts.signal, deadlineAt, now: startedAt, canonicalFor: _canonicalFor, lookbackDays: cfg.caps.lookbackDays,
    }, commit);
  } catch (e) {
    logger.warn('[email-intel] analysis failed ' + safeErr(e));
  }
  if (stats) logger.info('[email-intel] analysis id=' + scanId + ' eligible=' + stats.eligible + ' ok=' + stats.ok + ' cheap=' + stats.skippedCheap + ' old=' + stats.skippedOld + ' unavailable=' + stats.aiUnavailable + ' invalid=' + stats.invalid + ' pending=' + stats.pending + ' calls=' + stats.aiCalls + ' lane=' + stats.laneState);

  // Stage 7 (Phase C): evaluate new facts; apply (timelineWrites), stage, corroborate or record evidence.
  // The legacy Email Triage opt-outs come from the config read once at scan start (F2-01).
  let facts = null;
  if (!commitFailed) {
    try {
      facts = await pipeline.runFactStage({
        effective, index, intelCfg: cfg, prevResults, canonicalFor: _canonicalFor, scanId,
        optCfg: { autoApplyUnitUpdates: legacyCfg.autoApplyUnitUpdates, readyDmSuggested: legacyCfg.readyDmSuggested },
      });
    } catch (e) {
      logger.warn('[email-intel] fact stage failed ' + errName(e));
    }
    if (facts && facts.ledgerError) commitFailed = 'ledger';
  }
  let applied = new Set();
  try { applied = require('./facts/timeline-writer').appliedMessageKeys(); } catch (_) { applied = new Set(); }

  // Rebuild the legacy record of every conversation touched or analyzed this scan, and of any whose stored
  // record is behind the ledger (self-heal after a crash between analysis and the results save).
  const prevById = {};
  for (const e of (prevResults && prevResults.emails) || []) prevById[e.id] = e;
  const views = [];
  let pendingAnalysis = 0;
  for (const ck of Object.keys(msgDoc.byConv || {})) {
    const records = ledger.conversation(msgDoc, ck);
    if (!records.length) continue;
    for (const r of records) if (ledger.isPending(r)) pendingAnalysis++;
    const latest = records[records.length - 1];
    const p = prevById[latest.legacyId];
    const behind = !p || !p.intel || p.intel.latestMessageKey !== latest.messageKey || p.intel.analysisStatus !== String((latest.analysis || {}).status || 'pending');
    if (changed.has(ck) || behind) views.push({ conversationKey: ck, records });
  }
  const d = statusMod.deriveOutcome({ reader, committed: o.committed, storeError: commitFailed, deadlineHit: o.deadlineHit, pendingAnalysis });
  const doneMs = Date.now();
  const results = adapter.buildPhaseBResults({
    prev: prevResults, views, now: doneMs, cfg: { readyDmSuggested: legacyCfg.readyDmSuggested },
    canonicalFor: _canonicalFor,
    fleetRow: (unit) => index.byId.get(String(unit).toLowerCase()) || null,
    appliedFor: (messageKey) => applied.has(messageKey),      // display flag from the timeline ledger (Phase C)
    deleteFor: (records) => analyze.conservativeDelete(records, { openActions: 0, cfg }),
    meta: {
      authBlocked: d.outcome === 'auth-blocked', readError: d.readError,
      intel: Object.assign({ scanId, outcome: d.outcome, partial: d.partial, coalesced: false },
        facts ? { facts: { evaluated: facts.evaluated, applied: facts.applied, staged: facts.staged, duplicate: facts.duplicate, stale: facts.stale, outOfScope: facts.outOfScope, filtered: facts.filtered } } : {}),
    },
  });
  store.save('emailTriageResults', results);
  return { d, results, stats, facts };
}

/** Triage the new / changed conversations with the legacy triageEmails and persist the legacy results. */
async function _buildLegacy(o) {
  const { opts, triage, store, prevResults, touched, legacyCfg, plan, d, scanId, endMs } = o;
  const msgDoc = stores.load('messages');
  const convKeys = new Set(touched);
  for (const ck of Object.keys(msgDoc.byConv || {})) {
    const recs = ledger.conversation(msgDoc, ck);
    const latest = recs[recs.length - 1];
    if (latest && !latest.legacyTriagedAt) convKeys.add(ck);       // self-heal: a triage that failed is retried next scan
  }
  const prevById = {};
  for (const e of prevResults.emails || []) prevById[e.id] = e;
  const views = [];
  for (const ck of convKeys) {
    const records = ledger.conversation(msgDoc, ck);
    if (records.length) views.push({ conversationKey: ck, records });
  }
  const latestOf = (v) => v.records[v.records.length - 1];
  const needs = views.filter((v) => { const l = latestOf(v); const p = prevById[l.legacyId]; return !(p && p.intel && p.intel.latestMessageKey === l.messageKey); });
  const stamp = (r) => Date.parse(r.receivedAt || '') || Date.parse(r.ingestedAt || '') || 0;
  needs.sort((a, b) => stamp(latestOf(b)) - stamp(latestOf(a)));
  const batch = needs.slice(0, plan.max);

  const triaged = {};
  if (batch.length) {
    try {
      const fn = opts._triageEmails || triage.triageEmails;
      const tr = await fn(batch.map(adapter.toLegacyEmail), { signal: opts.signal, requestId: opts.requestId });
      for (const rec of (tr && tr.records) || []) triaged[rec.id] = rec;
    } catch (e) {
      logger.warn('[email-intel] legacy triage failed ' + safeErr(e));
    }
  }
  const results = adapter.buildResults({
    prev: prevResults, views, triaged, now: endMs, cfg: { readyDmSuggested: legacyCfg.readyDmSuggested },
    canonicalFor: _canonicalFor,
    meta: { authBlocked: !!(d.outcome === 'auth-blocked'), readError: d.readError, intel: { scanId, outcome: d.outcome, partial: d.partial, coalesced: false } },
  });
  store.save('emailTriageResults', results);
  // Remember which latest messages now have a legacy record so they are not triaged again.
  const doneKeys = results.emails.filter((e) => e.intel && e.intel.latestMessageKey).map((e) => e.intel.latestMessageKey);
  if (doneKeys.length) {
    const set = new Set(doneKeys);
    stores.update('messages', (doc) => {
      for (const v of views) { const l = doc.messages[latestOf(v).messageKey]; if (l && set.has(l.messageKey)) l.legacyTriagedAt = new Date(endMs).toISOString(); }
      return doc;
    });
  }
  return results;
}

/**
 * runIntelScan(opts, trigger) -> Promise<LegacyResults>
 * opts: { max?, folders?, signal?, requestId?, _readMailbox?, _triageEmails?, _electron?, _warm?, _sleep? ... }
 */
async function runIntelScan(opts, trigger) {
  opts = opts || {};
  const t = trigger === 'scheduled' ? 'scheduled' : 'manual';
  let ran;
  try {
    ran = await lock.run(t, () => _scan(opts, t));
  } catch (e) {
    logger.error('[email-intel] scan failed ' + safeErr(e));
    try { _recordScanEnd({ scanId: null, endedAt: new Date().toISOString(), outcome: 'failed', partial: false, trigger: t, errorCode: 'exception', folders: [] }); } catch (_) { /* status only */ }
    return adapter.failedResults(_triage().loadResults(), 'read failed', 'exception');
  }
  if (ran.skipped) {
    logger.info('[email-intel] scheduled scan skipped: busy');
    return adapter.skippedResults(_triage().loadResults(), ran.skipped);
  }
  if (ran.coalesced) return Object.assign({}, ran.value, { intel: Object.assign({}, ran.value && ran.value.intel, { coalesced: true }) });
  return ran.value;
}

/**
 * scheduledTick: the supervisor / legacy timer entry (design 8.5). Phase A keeps the legacy semantics:
 * a leader gate, the scan, the legacy fact apply (multiRecipient will own facts later), the overlay push
 * and the auto-scan counters. Failure-to-throw mapping for the supervisor arrives with Phase G.
 */
async function scheduledTick(ctx, cfg, deps) {
  deps = deps || {};
  const autoStatus = deps.autoStatus || null;
  let gate = true;
  try { const cl = require('../cluster'); gate = typeof cl.mayRunProduction === 'function' ? cl.mayRunProduction() !== false : true; } catch (_) { gate = true; }
  if (!gate) { if (autoStatus && autoStatus.skipped) autoStatus.skipped.standby++; return { skipped: 'standby' }; }
  const res = await runIntelScan({ signal: ctx && ctx.signal, _trigger: 'scheduled' }, 'scheduled');
  if (res && res.skipped) { if (autoStatus) autoStatus.lastOutcome = 'skipped'; return res; }
  if (res && !res.authBlocked && cfg && cfg.autoApplyUnitUpdates) {
    try { _triage().applyPendingUnitUpdates(res); } catch (e) { logger.warn('[email-intel] legacy apply failed ' + safeErr(e)); }
  }
  if (typeof deps.notify === 'function') {
    try { deps.notify(typeof deps.loadResults === 'function' ? deps.loadResults() : res); } catch (_) { /* overlay push only */ }
  }
  if (autoStatus) {
    autoStatus.runs++;
    autoStatus.lastOutcome = res && res.authBlocked ? 'authBlocked' : (res && res.intel && res.intel.outcome === 'failed' ? 'fail' : 'ok');
    autoStatus.lastError = null;
  }
  return res;
}

/** Status document (design 8.6): enums, counts and timestamps only. */
function getStatus() {
  let f = {}; let warnings = [];
  try { const g = flags.get(); f = g.effective; warnings = g.warnings || []; } catch (_) { /* flags only */ }
  let laneSt = { state: 'unknown', checkedAt: null };
  const extra = [];
  if (f && f.multiRecipient) {
    try { const s = require('./understand/lane').state(); laneSt = { state: s.state, checkedAt: s.checkedAt }; } catch (_) { /* status only */ }
    if (laneSt.state === 'unavailable' || laneSt.state === 'degraded') extra.push('isolated-lane-unavailable');
  }
  let openStaged = 0;
  if (f && f.multiRecipient) {
    try {
      const sd = stores.load('staged');
      openStaged = require('./facts/staged').openCount(sd);
      if (sd.overCap) extra.push('stagedOverCap');
    } catch (_) { /* status only */ }
  }
  return statusMod.buildStatus({
    enabled: engaged(), flags: f, flagWarnings: warnings, lane: laneSt, extraWarnings: extra, openStaged,
    config: cfgMod.normalize(stores.load('config')), checkpoints: stores.load('checkpoints'), messages: stores.load('messages'),
    running: lock.isBusy(), current: lock.current(),
    readOnlyStores: ['config', 'checkpoints', 'messages'].map((n) => stores.isReadOnly(n)),
  });
}

module.exports = { engaged, runIntelScan, scheduledTick, getStatus };
