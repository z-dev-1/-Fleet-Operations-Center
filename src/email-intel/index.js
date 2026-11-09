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
 * Phase D (`actionsView`): stage 9 (actions/stage.js) keeps durable question states and the My Email
 * Actions items, notifies once per item, pins the referenced messages, and feeds open-action counts to the
 * conservative delete rule (R7.6).
 *
 * Every error ends in a LegacyResults object (never a throw to the caller); logs carry counts and
 * enums only (redact.js), never message content.
 *
 * Outlook REST transport (email.intel.apiTransport effective): the reader is transport/reader.js (no OWA page;
 * the transport's hidden token window is the only page), with per-folder REST cursors (checkpoint folders[label].api),
 * one conversation alias per API group (R4-M3) and a bounded scan-start auto-reconcile of uncertain API sends
 * (R4-M5). No DOM fallback. Flag OFF: no transport file is loaded and the DOM build runs unchanged.
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
const { errName } = require('./redact');                   // name:code only: reader / AI / triage errors may echo mail text
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

/**
 * One scan under the lock (design 8.2 steps 1-12). Always resolves to LegacyResults; throws only for
 * programming errors (caught by runIntelScan, which records outcome 'failed' and clears scan.current).
 *   1  flags + config (once per scan); a store from a newer build refuses the scan (read-only, NFR-3)
 *   3  durable job begin (NOOP unless jobs.emailTriage.durable is effective); busy -> skipped busy-other-run
 *   4  boot-style reconcile: a scan.current left by a crashed run -> interrupted (pending timeline writes and
 *      staged caps run in the fact pre-pass, step 5, with the legacy bootstrap)
 *   6-8  read (streaming, checkpoint per committed batch) and analysis (budget, deadline, signal)
 *   9-10 facts, actions, legacy results; 11 finalize (scan.last, owaAuth, job complete / fail)
 */
async function _scan(opts, trigger) {
  const triage = _triage();
  const prevResults = triage.loadResults();
  if (stores.isReadOnly('checkpoints') || stores.isReadOnly('messages')) {
    logger.warn('[email-intel] scan refused: a store is from a newer build (read-only)');
    return adapter.failedResults(prevResults, 'read failed', 'store-newer-version');
  }
  const job = require('./reliability/job').begin();
  if (job.skipped) return adapter.skippedResults(prevResults, job.skipped);
  let res;
  try {
    res = await _scanBody(opts, trigger, job, triage, prevResults);
  } catch (e) {
    job.fail('exception');
    throw e;
  }
  const intel = (res && res.intel) || {};
  job.finish(intel.outcome, { scanId: intel.scanId || null, partial: !!intel.partial });
  return res;
}

async function _scanBody(opts, trigger, job, triage, prevResults) {
  const startedAt = Number.isFinite(opts._now) ? opts._now : Date.now();
  const nowIso = new Date(startedAt).toISOString();
  const scanId = 'sc_' + crypto.randomBytes(4).toString('hex');
  const wallStart = Date.now();
  // F-20 (wall clock: the reader and AI queue compare to Date.now()); 20 min, below the supervisor's 30 min
  // timeout. The test hook can only shorten it.
  const deadlineMs = Number.isFinite(opts._deadlineMs) && opts._deadlineMs > 0 ? Math.min(opts._deadlineMs, C.SCAN_DEADLINE_MS) : C.SCAN_DEADLINE_MS;
  const deadlineAt = wallStart + deadlineMs;
  const legacyCfg = triage.getConfig();                                        // read ONCE per scan (F2-01)
  const cfg = cfgMod.normalize(stores.load('config'));
  const store = require('../store');
  const aborted = () => !!(opts.signal && opts.signal.aborted);

  // Step 4: this scan holds the lock, so a scan.current still on disk belongs to a run that never finished.
  try { require('./reliability/boot').interruptStale(Date.now(), true); } catch (e) { logger.warn('[email-intel] stale scan check failed ' + errName(e)); }

  const folders = _folderList(opts, cfg, legacyCfg);
  const maxReq = Number.isFinite(opts.max) ? opts.max : (Number.isFinite(legacyCfg.maxEmails) ? legacyCfg.maxEmails : cfg.caps.maxEmails);
  const startCk = stores.load('checkpoints');
  const plan = fp.planFolderBudgets({ folders, max: maxReq, rotationNext: Number.isFinite(startCk.rotation) ? startCk.rotation : 0 });
  const ckSnapshot = JSON.parse(JSON.stringify(startCk.folders || {}));       // the reader must not see this scan's own commits

  stores.update('checkpoints', (ck) => { ck.scan = ck.scan || {}; ck.scan.current = { scanId, startedAt: nowIso, trigger }; return ck; });
  logger.info('[email-intel] scan start id=' + scanId + ' trigger=' + trigger + ' folders=' + folders.length + ' max=' + plan.max);

  const stats = { newMessages: 0, upgraded: 0, committedRows: 0, migrated: 0 };
  const touched = new Set();
  let storeError = null;
  // Phase F (attachments): per-scan budget and the memory-only excerpts (messageKey -> [{index,status,text}], F-14).
  const att = _attachmentsOn() ? _attachSetup(cfg, startedAt, opts) : null;
  const excerpts = new Map();

  const api = flags.apiTransport();                                   // Outlook REST transport (no DOM fallback)
  const onBatch = async (folder, items) => {
    const r1 = stores.update('messages', (doc) => {
      ledger.ensureDoc(doc);
      for (const it of items) {
        if (api) _planApiGroup(doc, it, { banners: cfg.banners, now: startedAt, lookbackDays: cfg.caps.lookbackDays });
        for (const cap of it.captures) {
          const bctx = { me: cfg.me, banners: cfg.banners, scanId, now: startedAt, threadContextIncomplete: !!cap.threadContextIncomplete };
          if (api) bctx.lookbackDays = cfg.caps.lookbackDays;               // R4-M2: the pass-2 window (API captures only)
          const res = ledger.buildRecord(cap, doc, bctx);
          if (!res) continue;
          if (api && res.migrated) stats.migrated++;
          if (res.created) { ledger.upsert(doc, res.record); stats.newMessages++; } else if (res.upgraded) stats.upgraded++;
          touched.add(res.record.conversationKey);
          if (att) _keepExcerpts(doc, res, cap, excerpts);
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
    job.checkpoint({ scanId, folderIdx: Math.max(0, folders.indexOf(folder)), rows: stats.committedRows, newMessages: stats.newMessages });
  };

  // Outlook REST transport: the transport is required only here (flag OFF loads no transport file, AC-19).
  const transport = api ? require('./transport') : null;
  if (api) {
    // Scan-start auto-reconcile of uncertain API sends: read-only, can only confirm `sent`, bounded (R4-M5).
    try {
      await _reconcilePending({ max: transport.TC.RECONCILE_AUTO_MAX, signal: opts.signal, deadlineAt: Math.min(deadlineAt, Date.now() + transport.TC.RECONCILE_AUTO_BUDGET_MS), _apiFind: opts._apiFind });
    } catch (e) { logger.warn('[email-intel] auto-reconcile failed ' + errName(e)); }
  }
  const readFn = opts._readMailbox || (api ? transport.readMailbox : require('./capture/owa_capture').readMailbox);
  let reader = null;
  try {
    const readOpts = {
      folders, plan, checkpoints: ckSnapshot, onBatch, signal: opts.signal, deadlineAt,
      caps: { maxOpen: Math.min(cfg.caps.maxOpen, C.MAX_OPEN_HARD) }, lookbackDays: cfg.caps.lookbackDays, now: startedAt,
      timeoutMs: opts.readTimeoutMs, authGraceMs: opts.authGraceMs, _electron: opts._electron, _warm: opts._warm, _sleep: opts._sleep,
    };
    if (api) {
      Object.assign(readOpts, {
        apiCursors: _apiCursors(ckSnapshot), isKnownSeed: _knownSeedFn(), _transport: opts._transport,
        onApiCursor: async (folder, cursor) => {
          const r = stores.update('checkpoints', (ck) => {
            ck.folders = ck.folders || {};
            const f = ck.folders[folder] || (ck.folders[folder] = fp.emptyFolderCheckpoint(folder));
            f.api = cursor;
            return ck;
          });
          if (!r.ok) { storeError = r.code || 'store'; throw new Error('store-write'); }
        },
      });
    }
    if (att) Object.assign(readOpts, _attachReadOpts(att, excerpts, api));
    reader = await readFn(readOpts);
  } catch (e) {
    logger.warn('[email-intel] reader threw ' + errName(e));
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
    d = statusMod.deriveOutcome({ reader, committed: stats.newMessages + stats.upgraded, storeError, deadlineHit, aborted: aborted() });
    results = adapter.failedResults(prevResults, 'read failed', 'store');
    if (att) { try { _afterAnalysis(excerpts); } catch (_) { /* best effort */ } }
  } else if (_multiRecipient()) {
    const u = await _understand({ opts, trigger, cfg, legacyCfg, store, prevResults, touched, startedAt, deadlineAt, scanId, reader, committed: stats.newMessages + stats.upgraded, deadlineHit, att, excerpts });
    d = u.d; results = u.results;
  } else {
    d = statusMod.deriveOutcome({ reader, committed: stats.newMessages + stats.upgraded, storeError, deadlineHit, aborted: aborted() });
    results = await _buildLegacy({ opts, triage, store, prevResults, touched, legacyCfg, plan, d, scanId, endMs, readerOk: !!reader });
  }
  results.intel = Object.assign({}, results.intel, { scanId, outcome: d.outcome, partial: d.partial, coalesced: false });

  _recordScanEnd({
    scanId, startedAt: nowIso, endedAt: endIso, outcome: d.outcome, partial: d.partial, trigger, errorCode: d.errorCode || undefined,
    folders: reader ? reader.folders.map((f) => ({ folder: f.folder, status: f.status, requested: f.requested, examined: f.examined, opened: f.opened, ingested: f.ingested, skippedKnown: f.skippedKnown, caughtUp: f.caughtUp, backlog: f.backlog, backlogRemaining: f.backlogRemaining, retried: f.retried || 0 })) : [],
    counts: { newMessages: stats.newMessages, rows: stats.committedRows, opened: reader ? reader.opened : 0, rowsExamined: reader ? reader.rowsExamined : 0 },
  });
  logger.info('[email-intel] scan end id=' + scanId + ' outcome=' + d.outcome + ' new=' + stats.newMessages + ' opened=' + (reader ? reader.opened : 0) + ' ms=' + (Date.now() - wallStart)
    + (api ? ' api=1 migrated=' + stats.migrated : ''));
  return results;
}

// ── Outlook REST transport (apiTransport) helpers ──────────────────────────────
/** Per-folder REST cursors from the scan-start checkpoint snapshot. */
function _apiCursors(ckFolders) {
  const out = {};
  for (const k of Object.keys(ckFolders || {})) out[k] = (ckFolders[k] && ckFolders[k].api) || null;
  return out;
}

/** isKnownSeed(seed): the ledger already holds the message (by key or alias) at scan start. */
function _knownSeedFn() {
  const identity = require('./ingest/identity');
  const set = new Set();
  try {
    const doc = stores.load('messages');
    for (const k of Object.keys(doc.messages || {})) set.add(k);
    for (const k of Object.keys(doc.aliasIndex || {})) set.add(k);
  } catch (_) { /* empty set: everything is fetched */ }
  return (seed) => set.has(identity.itemKey(seed));
}

/** R4-M3: one alias for the whole API conversation group, decided before any record of the group is built. */
function _planApiGroup(doc, it, ctx) {
  const caps = (it.captures || []).filter((c) => c && c.source === 'api');
  if (!caps.length) return;
  const apiMigrate = require('./ingest/api-migrate');
  const plan = apiMigrate.planGroup(doc, caps, ctx);
  if (!plan) return;
  apiMigrate.recordConvAlias(doc, caps[0].conversationKey, { conversationKey: plan.conversationKey, legacyId: plan.legacyIdOverride });
  for (const cap of caps) {
    cap.conversationKey = plan.conversationKey;
    if (plan.legacyIdOverride) cap.legacyIdOverride = plan.legacyIdOverride;
  }
}

/**
 * _reconcilePending({ max, signal, deadlineAt }): scan-start check of uncertain Outlook REST sends (design 8.6).
 * Attempts in delivery-uncertain / unconfirmed-not-found with transport 'api' and a usable search input, clicked at
 * least 2 min ago and not checked in the last 10 min, newest first, at most `max`, each with onlyIfFound (can only
 * confirm `sent`). R4-M5: past deadlineAt (min(scan deadline, now + 90 s)) or on abort the rest are deferred; a
 * cut-off lookup is RECONCILE_INCONCLUSIVE and records no check. Counts only in the log.
 */
async function _reconcilePending(o) {
  const opts = o || {};
  const guard = require('./reply/send-guard');
  const rs = require('./reply/reconcile-send');
  const transport = require('./transport');
  const TC = transport.TC;
  const doc = ledger.ensureDoc(stores.load('messages'));
  const now = Date.now();
  const lastCheck = (a) => { const c = (a.reconcile && a.reconcile.checks) || []; return c.length ? (Date.parse(c[c.length - 1].at) || 0) : 0; };
  const picked = guard.list({ limit: 500 }).filter((a) => rs.RECONCILABLE.has(a.state) && a.transport === 'api'
    && transport.reconcileQuery(a, doc).strategies.length > 0
    && now - (Date.parse(a.sendClickedAt || a.createdAt) || 0) >= TC.RECONCILE_AUTO_MIN_AGE_MS
    && now - lastCheck(a) >= TC.RECONCILE_AUTO_GAP_MS).slice(0, Number.isFinite(opts.max) ? opts.max : TC.RECONCILE_AUTO_MAX);
  const counts = { checked: 0, sent: 0, notFound: 0, inconclusive: 0, busy: 0, failed: 0, deferred: 0 };
  for (let i = 0; i < picked.length; i++) {
    if ((opts.signal && opts.signal.aborted) || (Number.isFinite(opts.deadlineAt) && Date.now() >= opts.deadlineAt)) { counts.deferred = picked.length - i; break; }
    let r;
    try {
      r = await rs.reconcileSend(picked[i].attemptId, { onlyIfFound: true, signal: opts.signal, deadlineAt: opts.deadlineAt, messagesDoc: doc, _apiFind: opts._apiFind });
    } catch (_) { r = { ok: false, code: 'RECONCILE_FAILED' }; }
    counts.checked++;
    if (r && r.ok && r.found) counts.sent++;
    else if (r && r.ok) counts.notFound++;
    else if (r && r.code === 'RECONCILE_INCONCLUSIVE') counts.inconclusive++;
    else if (r && r.code === 'RECONCILE_IN_PROGRESS') counts.busy++;
    else counts.failed++;
  }
  if (picked.length) {
    logger.info('[email-intel] auto-reconcile checked=' + counts.checked + ' sent=' + counts.sent + ' notFound=' + counts.notFound + ' inconclusive=' + counts.inconclusive
      + ' busy=' + counts.busy + ' failed=' + counts.failed + ' deferred=' + counts.deferred);
  }
  return counts;
}

function _multiRecipient() {
  try { return flags.get().effective.multiRecipient === true; } catch (_) { return false; }
}

// ── Phase F (attachments) helpers. Excerpts never leave memory; only per-attachment status is stored. ──
const ANALYSIS_DONE = new Set(['ok', 'skipped-cheap', 'skipped-old', 'failed-permanent']);

function _attachmentsOn() {
  try { return require('./attach/policy').enabled(flags.get().effective); } catch (_) { return false; }
}

function _attachSetup(cfg, startedAt, opts) {
  const policyMod = require('./attach/policy');
  const policy = policyMod.policyOf(cfg);
  let unitIds = [];
  try {
    const idx = require('./understand/scope').buildScopeIndex({ now: startedAt, fasName: cfg.me && cfg.me.fasName });
    unitIds = Array.from(idx.byId.values()).map((d) => d.unit).filter(Boolean).slice(0, 500);
  } catch (_) { unitIds = []; }
  return { flagOn: true, policy, budget: policyMod.createBudget(policy, { now: Date.now() }), unitIds, deps: opts._attachDeps, fetchOne: opts._attachFetch };
}

/** onBatch: remember this scan's excerpts; a re-read of a message that is still waiting for analysis refreshes its statuses. */
function _keepExcerpts(doc, res, cap, excerpts) {
  const rec = doc.messages[res.record.messageKey] || res.record;
  if (!res.created) {
    const st = String((rec.analysis || {}).status || 'pending');
    if (ANALYSIS_DONE.has(st) || !Array.isArray(cap.attachments) || cap.attachments.length !== (rec.attachments || []).length) return;
    rec.attachments = cap.attachments;
  }
  if (Array.isArray(cap.attachmentExcerpts) && cap.attachmentExcerpts.length) excerpts.set(rec.messageKey, cap.attachmentExcerpts);
}

/** Reader options for Phase F: the budget, the pending re-extract targets (F-14) and their commit hook. */
function _attachReadOpts(att, excerpts, api) {
  const ex = require('./attach/extract');
  let targets = [];
  const r0 = stores.update('messages', (doc) => {
    ledger.ensureDoc(doc);
    const t = ex.reextractTargets(doc, { max: att.policy.maxPerScan });
    for (const k of t.unreachable) { const rec = doc.messages[k]; if (rec) ex.markNotFound(rec.attachments); }
    targets = api
      ? t.targets.map((x) => Object.assign({}, x, { attachments: JSON.parse(JSON.stringify(doc.messages[x.messageKey].attachments || [])), itemId: doc.messages[x.messageKey].itemId || null }))
      : t.targets.map((x) => Object.assign({}, x, { attachments: JSON.parse(JSON.stringify(doc.messages[x.messageKey].attachments || [])) }));
    return doc;
  });
  if (!r0.ok) targets = [];
  const onReextract = async (t, r) => {
    stores.update('messages', (doc) => {
      const rec = doc.messages && doc.messages[t.messageKey];
      if (!rec) return doc;
      const only = new Set(t.indexes);
      if (r.status === 'ok' && Array.isArray(r.attachments) && r.attachments.length === (rec.attachments || []).length) rec.attachments = r.attachments;
      else if (r.status === 'not-found') ex.markNotFound(rec.attachments, only);
      else ex.recordReextractFailure(rec.attachments, only, 'open-failed');
      return doc;
    });
    if (r.status === 'ok' && Array.isArray(r.excerpts) && r.excerpts.length) excerpts.set(t.messageKey, r.excerpts);
  };
  return {
    attachments: { flagOn: true, budget: att.budget, unitIds: att.unitIds, deps: att.deps, fetchOne: att.fetchOne },
    reextract: targets, onReextract,
  };
}

/** Scan end: analyzed attachments of messages whose analysis did not finish are re-fetched next scan; excerpts dropped. */
function _afterAnalysis(excerpts) {
  if (!excerpts || !excerpts.size) return;
  const ex = require('./attach/extract');
  const keys = Array.from(excerpts.keys());
  excerpts.clear();
  let marked = 0;
  stores.update('messages', (doc) => {
    for (const k of keys) {
      const rec = doc.messages && doc.messages[k];
      if (!rec || ANALYSIS_DONE.has(String((rec.analysis || {}).status || 'pending'))) continue;
      marked += ex.markPendingReextract(rec.attachments);
    }
    return doc;
  });
  if (marked) logger.info('[email-intel] attachments pending-reextract=' + marked);
}

/** Messages referenced by open staged items are never evicted (design 1.2). Phase B/C only. */
function _pinnedByStaged() {
  if (!_multiRecipient()) return null;
  let pinned;
  try { pinned = require('./facts/staged').openMessageKeys(stores.load('staged')); } catch (_) { return null; }
  // Phase D: messages referenced by open action items are pinned too (design 1.2).
  if (_actionsView()) {
    try { for (const k of require('./actions/store').pinnedMessageKeys(require('./actions/store').load())) pinned.add(k); } catch (_) { /* staged pins only */ }
  }
  return pinned;
}

function _actionsView() {
  try { return flags.get().effective.actionsView === true; } catch (_) { return false; }
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
  const excerpts = o.excerpts || null;
  const commit = (key, a) => {
    const rec = msgDoc.messages[key];
    if (rec) changed.add(rec.conversationKey);
    const r = stores.update('messages', (doc) => { const x = doc.messages && doc.messages[key]; if (x) x.analysis = a; return doc; });
    if (!r.ok && !commitFailed) commitFailed = r.code || 'store';
    if (excerpts && a && ANALYSIS_DONE.has(a.status)) excerpts.delete(key);          // F-14: dropped once the analysis finished
  };
  const pipeline = require('./facts/pipeline');
  let effective = {};
  try { effective = flags.get().effective || {}; } catch (_) { effective = {}; }
  // Steps 4-5 (Phase C): pending-write reconcile, staged caps, per-phase legacy bootstrap (before any rebuild).
  try { await pipeline.beforeAnalysis({ effective, prevResults, lookbackDays: cfg.caps.lookbackDays }); } catch (e) { logger.warn('[email-intel] fact pre-pass failed ' + errName(e)); }
  let stats = null;
  try {
    const actx = {
      index, me: cfg.me, cfg, trigger, signal: opts.signal, deadlineAt, now: startedAt, canonicalFor: _canonicalFor, lookbackDays: cfg.caps.lookbackDays,
    };
    if (o.att) Object.assign(actx, { attachmentsOn: true, attachmentExcerpts: excerpts });
    stats = await analyze.runScanAnalysis(msgDoc, actx, commit);
  } catch (e) {
    logger.warn('[email-intel] analysis failed ' + errName(e));
  }
  if (o.att) _afterAnalysis(excerpts);
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

  // Stage 9 (Phase D, actionsView): question states, action items (stable ids), notify once. A failed actions
  // store write fails the scan (previous items stay intact). The resolution pass shares the scan AI budget.
  let actionsOn = false;
  if (!commitFailed && effective.actionsView === true) {
    actionsOn = true;
    try {
      const lane = require('./understand/lane');
      const used = stats ? stats.aiCalls : 0;
      const laneSt = lane.state().state;
      const acts = await require('./actions/stage').runActionStage({
        msgDoc, conversations: changed, scanId, now: Date.now(), signal: opts.signal, deadlineAt,
        aiBudget: Math.max(0, ((cfg.caps && cfg.caps.aiCalls) || C.AI_CALLS_DEFAULT) - used),
        laneOk: !!(stats && stats.laneAvailable === true) && laneSt !== 'degraded' && laneSt !== 'unavailable',
        ask: (prompt) => lane.askIsolated(prompt, { trigger, signal: opts.signal }),
        osNotify: typeof opts._notify === 'function' ? opts._notify : undefined,
      });
      if (acts && acts.storeError) commitFailed = 'actions';
    } catch (e) {
      logger.warn('[email-intel] action stage failed ' + errName(e));
    }
  }
  let actDoc = null;
  if (actionsOn) { try { actDoc = require('./actions/store').load(); } catch (_) { actDoc = null; } }
  const openActionsFor = (records) => {
    if (!actDoc || !records || !records.length) return 0;
    try { return require('./actions/store').openActionsFor(actDoc, records[0].conversationKey); } catch (_) { return 0; }
  };

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
    const behind = !p || !p.intel || !adapter.sameLatest(p.intel.latestMessageKey, latest) || p.intel.analysisStatus !== String((latest.analysis || {}).status || 'pending');
    if (changed.has(ck) || behind) views.push({ conversationKey: ck, records });
  }
  const d = statusMod.deriveOutcome({ reader, committed: o.committed, storeError: commitFailed, deadlineHit: o.deadlineHit, pendingAnalysis, aborted: !!(opts.signal && opts.signal.aborted) });
  const doneMs = Date.now();
  const results = adapter.buildPhaseBResults({
    prev: prevResults, views, now: doneMs, cfg: { readyDmSuggested: legacyCfg.readyDmSuggested },
    canonicalFor: _canonicalFor,
    fleetRow: (unit) => index.byId.get(String(unit).toLowerCase()) || null,
    appliedFor: (messageKey) => applied.has(messageKey),      // display flag from the timeline ledger (Phase C)
    deleteFor: (records) => analyze.conservativeDelete(records, { openActions: openActionsFor(records), cfg }),
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
  const needs = views.filter((v) => { const l = latestOf(v); const p = prevById[l.legacyId]; return !(p && p.intel && adapter.sameLatest(p.intel.latestMessageKey, l)); });
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
      logger.warn('[email-intel] legacy triage failed ' + errName(e));
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
    logger.error('[email-intel] scan failed ' + errName(e));
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

// ── Supervisor outcome errors (design 8.5). Messages are fixed enum text, never message content. ──
class AuthBlockedError extends Error {
  constructor() { super('Outlook sign-in required; email scan blocked'); this.name = 'AuthBlockedError'; this.code = 'OWA_AUTH_BLOCKED'; }
}
class ScanFailedError extends Error {
  constructor(errorCode) {
    const c = /^[a-z0-9-]{1,40}$/i.test(String(errorCode || '')) ? String(errorCode) : 'read-failed';
    super('Email scan failed (' + c + ')'); this.name = 'ScanFailedError'; this.code = 'EMAIL_SCAN_FAILED'; this.errorCode = c;
  }
}
class ScanAbortedError extends Error {
  constructor() { super('Email scan aborted; progress saved'); this.name = 'ScanAbortedError'; this.code = 'EMAIL_SCAN_ABORTED'; }
}

function _lastErrorCode() {
  try { const l = stores.load('checkpoints').scan.last; return (l && l.errorCode) || null; } catch (_) { return null; }
}

/**
 * scheduledTick(ctx, cfg, deps): the supervisor / legacy timer entry (design 8.5).
 *  1 leader gate (cluster.mayRunProduction, fail-open) -> { skipped:'standby' }
 *  2 runIntelScan({ signal: ctx.signal, _trigger:'scheduled' }, 'scheduled') (F2-04: low AI priority)
 *  3 a skip (busy, busy-other-run) is returned untouched (the supervisor's isSkip), no notify
 *  4 legacy fact apply (inert once multiRecipient owns facts), overlay push, autoStatus counters
 *  5 outcome mapping so the supervisor's counts and breaker see reality: auth-blocked -> AuthBlockedError
 *    (code OWA_AUTH_BLOCKED), failed -> ScanFailedError, aborted -> ScanAbortedError; complete and partial
 *    (including a deadline-limited scan) return the result. The legacy setInterval path swallows the throw
 *    (`_autoTick().catch(() => {})`); the intel status records the outcome either way.
 */
async function scheduledTick(ctx, cfg, deps) {
  deps = deps || {};
  const autoStatus = deps.autoStatus || null;
  let gate = true;
  try { const cl = require('../cluster'); gate = typeof cl.mayRunProduction === 'function' ? cl.mayRunProduction() !== false : true; } catch (_) { gate = true; }
  if (!gate) { if (autoStatus && autoStatus.skipped) autoStatus.skipped.standby++; return { skipped: 'standby' }; }
  // deps._scanOpts: test-only injection (fake reader / window); the scheduler never passes it.
  const scanOpts = Object.assign({}, deps._scanOpts && typeof deps._scanOpts === 'object' ? deps._scanOpts : {}, { signal: ctx && ctx.signal, _trigger: 'scheduled' });
  const res = await runIntelScan(scanOpts, 'scheduled');
  if (res && res.skipped) { if (autoStatus) autoStatus.lastOutcome = 'skipped'; return res; }
  if (res && !res.authBlocked && cfg && cfg.autoApplyUnitUpdates) {
    try { _triage().applyPendingUnitUpdates(res); } catch (e) { logger.warn('[email-intel] legacy apply failed ' + errName(e)); }
  }
  if (typeof deps.notify === 'function') {
    try { deps.notify(typeof deps.loadResults === 'function' ? deps.loadResults() : res); } catch (_) { /* overlay push only */ }
  }
  const outcome = res && res.intel ? res.intel.outcome : null;
  const authBlocked = outcome === 'auth-blocked' || !!(res && res.authBlocked);
  const failed = outcome === 'failed' || outcome === 'aborted';
  const errorCode = failed ? (outcome === 'aborted' ? 'aborted' : ((res && res.intel && res.intel.errorCode) || _lastErrorCode() || 'read-failed')) : null;
  if (autoStatus) {
    autoStatus.runs++;
    autoStatus.lastOutcome = authBlocked ? 'authBlocked' : (failed ? 'fail' : 'ok');
    autoStatus.lastError = failed ? errorCode : null;                       // enum only
  }
  if (authBlocked) throw new AuthBlockedError();
  if (outcome === 'aborted') throw new ScanAbortedError();
  if (outcome === 'failed') throw new ScanFailedError(errorCode);
  return res;
}

/** Status document (design 8.6): enums, counts and timestamps only. */
function getStatus() {
  let f = {}; let warnings = [];
  try {
    const g = flags.get();
    // apiTransport appears in the status flags only while it is effective (flag OFF: the same object as before).
    f = g.apiTransportEffective === true ? Object.assign({}, g.effective, { apiTransport: true }) : g.effective;
    warnings = g.warnings || [];
  } catch (_) { /* flags only */ }
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
  let openActions = 0;
  if (f && f.actionsView) {
    try { const as = require('./actions/store'); openActions = as.openCount(as.load()); } catch (_) { /* status only */ }
  }
  let unreconciledSends = 0;
  if (f && (f.threadReplies || f.apiTransport)) {
    try { unreconciledSends = require('./reply/send-guard').unreconciledCount(); } catch (_) { /* status only */ }
  }
  const config = cfgMod.normalize(stores.load('config'));
  // Phase G (F2-05, F-17, R8.5): read-only views of the supervisor entry, the durable job, Midway and the AI gateway.
  let ext = {};
  try { ext = statusMod.collectExternal({ multiRecipient: !!(f && f.multiRecipient) }); } catch (_) { ext = {}; }
  const st = statusMod.buildStatus({
    enabled: engaged(), flags: f, flagWarnings: warnings, lane: laneSt, extraWarnings: extra, openStaged, openActions, unreconciledSends,
    config, checkpoints: stores.load('checkpoints'), messages: stores.load('messages'),
    running: lock.isBusy(), current: lock.current(),
    readOnlyStores: Object.keys(stores.KEYS).map((n) => stores.isReadOnly(n)),
    supervisor: ext.supervisor, jobs: ext.jobs, midway: ext.midway, aiGateway: ext.aiGateway,
  });
  // Phase F: the one-time vision notice state (F-28); present only while `attachments` is effective.
  if (f && f.attachments && st && typeof st === 'object') {
    try {
      const p = require('./attach/policy').policyOf(config);
      st.attachments = { visionNoticePending: p.visionNoticeAcknowledged !== true, maxVision: p.maxVision, maxPerScan: p.maxPerScan, maxBytes: p.maxBytes };
    } catch (_) { /* status only */ }
  }
  // Outlook REST transport: token presence / TTL bucket / hold and the throttle gate (no values).
  if (f && f.apiTransport && st && typeof st === 'object') {
    try { st.api = require('./transport').describe(); } catch (_) { /* status only */ }
  }
  return st;
}

module.exports = { engaged, runIntelScan, scheduledTick, getStatus, AuthBlockedError, ScanFailedError, ScanAbortedError, _reconcilePending };
