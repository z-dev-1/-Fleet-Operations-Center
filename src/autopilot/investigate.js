'use strict';
/**
 * autopilot/investigate.js — one case investigation run (§B8 steps 1-10, plan R1, R10).
 *
 * runInvestigation(caseId, deps) -> Promise<{ ok, caseId, runId, outcome, state, aiStatus, aiCalled, code? }>
 *
 * deps (all injectable for tests):
 *   ports        ports.create() object (required)
 *   limiter      limiter.createLimiter() instance or null (no live reads)
 *   cfg          effective config (config.resolveAutopilotConfig)
 *   signal       AbortSignal; reason in master_pause | master_stop | reconfigure | budget | shutdown
 *   trigger      ap_run.trigger (new | evidence_changed | eta_due | scheduled | auth_restored |
 *                retry_due | manual | retry | recovered | feature_on | harness)
 *   owner        lease owner id
 *   now()        clock; rand() jitter source
 *   fleet        { doc: fleetData, ff: ports.fleetFreshness(now) } (read when missing)
 *   docs         store documents already read this tick (optional)
 *   staleDays    relayReconcileConfig.staleDays (default 3)
 *   cheapFpOf(caseRec, row) -> cheap fingerprint to store (optional)
 *   caseStore, reason, jobs, logger
 *
 * Checkpoints (ap_run.checkpoint_json is the source of truth): evidence_done (with plan_json and
 * source_calls_json, R10), ai_pending (written atomically with the daily-cap reservation),
 * analysis_done. A resumed run copies the findings, plan and source calls and never repeats a
 * completed step; an ai_pending checkpoint never leads to a second AI call for the same
 * fingerprint. No ai/trace handle is created: the gateway records the call under
 * bySource.autopilot and the ap_run row is Autopilot's own record.
 */

const crypto = require('crypto');
const {
  STATES: S, LIMITS, AUTH_DOWN, OPERATIONAL_CADENCE, normUnit, unitIndex, UNIT_KEY_OF, localDate, HOUR, MIN,
} = require('./constants');
const { buildScope, inScopeExisting } = require('./scope');
const { planSources, decisivRef, tireRelevant } = require('./plan');
const evidence = require('./evidence');
const fingerprint = require('./fingerprint');
const resolution = require('./resolution');
const { analyze, trivial } = require('./analyze');
const { buildPrompt } = require('./prompt');
const { validateAiOutput } = require('./validate');
const { deterministicRecommendation } = require('./fallback');
const { buildConflicts } = require('./conflicts');
const { score } = require('./priority');
const { newestLoggedUpdate, toMs } = require('./updates');

let logger;
try { logger = require('../utils/logger')('autopilot'); } catch (_) { logger = { debug() {}, info() {}, warn() {}, error() {} }; }

const LEASE_MS = 10 * MIN;
const AI_TIMEOUT_MS = 60000;
const RED_UNUSABLE = new Set(['age>3x', 'superseded', 'wedged']);
const AI_ANSWERED = new Set(['ok', 'invalid', 'not_needed']);
const AI_RETRY = new Set(['timeout', 'unavailable', 'skipped_cap', 'skipped_busy', 'interrupted']);
const PAUSE_ABORTS = new Set(['master_pause', 'master_stop']);

function _sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function _jitter(ms, rand) { return Math.round(ms * (1 + (rand() * 0.2 - 0.1))); }
function _abortReason(signal) {
  const r = signal && signal.reason;
  return typeof r === 'string' && r ? r : 'shutdown';
}
function _codeOf(e) { return (e && e.code) || 'INTERNAL'; }
function _cpuMs(cpu0) { const u = process.cpuUsage(cpu0); return Math.round((u.user + u.system) / 1000); }

/** Required-source rule (§B8 step 4). -> null when usable, else a reason code. */
function requiredSourceUnusable(row, ff, syncedAt, now) {
  if (!row) return 'no_row';
  const f = ff || {};
  if (f.level === 'red' && (f.reasons || []).some((r) => RED_UNUSABLE.has(r))) return 'fleet_red';
  if (f.level === 'grey') {
    const s = toMs(syncedAt);
    if (s == null) return 'fleet_grey';
    const factor = Number.isFinite(f.redAgeFactor) ? f.redAgeFactor : 3;
    if (Number.isFinite(f.intervalMs) && now - s > factor * f.intervalMs) return 'fleet_grey';
  }
  return null;
}

/** AI yield rule (§B8 step 8), both gateway priority modes. */
function aiBusy(q) {
  if (!q || typeof q !== 'object') return false;
  const bp = q.byPriority || {};
  const w = (p) => (bp[p] && bp[p].waiting) || 0;
  if (q.flags && q.flags.priorities) return (w('high') + w('critical') > 0) || q.active >= q.max;
  return (q.waiting > 0) || q.active >= Math.max(1, (q.max || 0) - (q.reserve || 0));
}

function _backendsDown(st) {
  const b = st && st.backends;
  if (!b || typeof b !== 'object') return false;
  return !Object.keys(b).some((k) => b[k] === true);
}

/** next_review_at from the output hours, an earlier FUTURE ETC (09:00 local), +-10% jitter. */
function nextReviewAt(output, eta, now, rand) {
  const h = Number(output && output.nextReviewInHours);
  const hours = Number.isFinite(h) ? Math.min(72, Math.max(1, h)) : OPERATIONAL_CADENCE.reviewHours.default;
  let t = now + hours * HOUR;
  if (eta && eta.status === 'FUTURE' && typeof eta.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(eta.date)) {
    const at = new Date(eta.date + 'T09:00:00').getTime();
    if (Number.isFinite(at) && at > now && at < t) t = at;
  }
  return now + _jitter(t - now, rand);
}

function _sourceCallsSummary(pack) {
  const out = {};
  for (const s of Object.keys(pack.sourceStatus || {})) out[s] = { status: pack.sourceStatus[s], live: 0, errors: {}, ms: 0 };
  for (const c of pack.sourceCalls || []) {
    const o = out[c.source] || (out[c.source] = { status: null, live: 0, errors: {}, ms: 0 });
    o.live += c.attempts || 0;
    o.ms += c.ms || 0;
    if (c.status !== 'ok') { const k = c.code || c.status; o.errors[k] = (o.errors[k] || 0) + 1; }
  }
  return out;
}

function _docsReader(deps) {
  const given = deps.docs || {};
  const cache = {};
  return (k) => {
    if (Object.prototype.hasOwnProperty.call(given, k)) return given[k];
    if (!Object.prototype.hasOwnProperty.call(cache, k)) {
      try { cache[k] = deps.ports.readStore(k); } catch (_) { cache[k] = null; }
    }
    return cache[k];
  };
}

async function runInvestigation(caseId, deps) {
  const d = deps || {};
  const ports = d.ports;
  const cs = d.caseStore || require('./case-store');
  const jobs = d.jobs || require('../jobs');
  const reasonFn = d.reason || require('../orcha/reason').reason;
  const log = d.logger || logger;
  const clock = typeof d.now === 'function' ? d.now : Date.now;
  const rand = typeof d.rand === 'function' ? d.rand : Math.random;
  const cfg = d.cfg || {};
  const features = cfg.features || {};
  const owner = d.owner || 'autopilot';
  const signal = d.signal || null;
  const trigger = d.trigger || 'scheduled';
  const t0 = clock();
  const cpu0 = process.cpuUsage();
  const aborted = () => !!(signal && signal.aborted);

  const got = cs.getCase(caseId);
  if (!got) return { ok: false, code: 'NOT_FOUND', caseId };
  let rec = got.case;
  if (rec.state !== S.QUEUED) return { ok: false, code: 'INVALID_STATE', caseId, state: rec.state };

  // ── step 1: lease, open ─────────────────────────────────────────────────
  if (!cs.lease(caseId, owner, t0 + LEASE_MS, { now: t0 })) return { ok: false, code: 'LEASED', caseId };
  cs.transition(caseId, S.INVESTIGATING, { reason: trigger, now: t0 });
  let job = jobs.NOOP_HANDLE || { start() {}, setCheckpoint() {}, complete() {}, fail() {}, cancel() {}, jobId: null };
  try { job = jobs.begin({ type: 'autopilotInvestigate', scopeKey: 'case:' + caseId }) || job; } catch (_) { /* non-durable */ }
  try { job.start(); } catch (_) {}
  const runId = cs.openRun({ caseId, trigger, jobId: job.jobId || null, now: t0 });

  const ctx = { runId, aiStatus: null, aiCalled: false, aiLane: null, aiModel: null, aiIsolated: null, aiLatencyMs: null, aiRequestId: null, plan: null, sourceCalls: null };
  const runMeta = (outcome, extra) => Object.assign({
    outcome, aiStatus: ctx.aiStatus, aiRequestId: ctx.aiRequestId, aiLatencyMs: ctx.aiLatencyMs, aiLane: ctx.aiLane,
    aiModel: ctx.aiModel, aiIsolated: ctx.aiIsolated, cpuMs: _cpuMs(cpu0),
    durationMs: clock() - t0, sourceCalls: ctx.sourceCalls, plan: ctx.plan, jobId: job.jobId || null,
  }, extra || {});
  const RELEASE = { lease_owner: null, lease_until: null };
  const done = (outcome, state, extra) => Object.assign({ ok: true, caseId, runId, outcome, state, aiStatus: ctx.aiStatus, aiCalled: ctx.aiCalled, isolated: ctx.aiIsolated }, extra || {});

  const onAbort = () => {
    const why = _abortReason(signal);
    const now = clock();
    const pause = PAUSE_ABORTS.has(why);
    const to = pause ? S.PAUSED : S.QUEUED;
    cs.persistRun(caseId, runId, Object.assign({}, RELEASE, pause ? {} : { next_attempt_at: null }), to,
      { reason: why, pauseReason: pause ? why : undefined, run: runMeta('aborted'), event: { kind: 'control', reason: 'aborted:' + why }, now });
    try { job.cancel(why); } catch (_) {}
    return done('aborted', to, { abortReason: why });
  };

  try {
    const now = () => clock();
    const doc = _docsReader(d);
    const fleetDoc = (d.fleet && d.fleet.doc) || doc('fleetData') || {};
    const ff = (d.fleet && d.fleet.ff) || ports.fleetFreshness(t0);
    const buildAtMs = ff && Number.isFinite(ff.lastOkAt) ? ff.lastOkAt : null;
    const rows = Array.isArray(fleetDoc.rows) ? fleetDoc.rows : [];
    const row = rows.find((r) => r && typeof r.equipmentId === 'string' && normUnit(r.equipmentId) === rec.unit_id) || null;
    const isDownFn = (r) => { try { return !!ports.isDown(r); } catch (_) { return false; } };
    const down = row ? isDownFn(row) : false;
    const staleDays = Number.isFinite(d.staleDays) ? d.staleDays : 3;

    // ── step 2: resume lookup ─────────────────────────────────────────────
    let resumeStep = null;
    let cp = null;
    const prior = cs.findResumable(caseId, t0);
    if (prior && prior.run_id !== runId) {
      cp = cs.copyRunForResume(prior.run_id, runId, { now: t0 });
      if (cp && cp.step) resumeStep = cp.step;
      ctx.plan = prior.plan || null;
      ctx.sourceCalls = prior.source_calls || null;
    }

    // ── step 3: scope re-check, plan, auth snapshot ───────────────────────
    if (row && !inScopeExisting(row, buildScope(cfg))) {
      cs.persistRun(caseId, runId, RELEASE, S.PAUSED, { reason: 'out_of_scope', pauseReason: 'out_of_scope', run: runMeta('paused'), now: now() });
      try { job.complete({ outcome: 'paused' }); } catch (_) {}
      return done('paused', S.PAUSED);
    }
    let auth = {};
    try { auth = ports.authState() || {}; } catch (_) { auth = {}; }

    let pack;
    let fp;
    if (resumeStep) {
      const items = cs.findingsForRun(runId);
      pack = { items, conflicts: buildConflicts(items, { isDown: down }), sourceStatus: (cp && cp.sourceStatus) || {}, sourceCalls: [], flags: (cp && cp.flags) || [], events: [] };
      fp = cp.fp || fingerprint.fp(pack);
    } else {
      // Plan (written now, R10).
      const unit = rec.unit_id;
      const ref = decisivRef(row || {});
      const decDoc = doc('decisivCaseCache');
      const decEntry = ref.estimateId && decDoc && typeof decDoc === 'object' ? decDoc[ref.estimateId] : null;
      let dtnaCount = 0;
      try { const l = ports.dtnaCasesForUnit(unit); dtnaCount = Array.isArray(l) ? l.length : 0; } catch (_) { dtnaCount = 0; }
      const email = doc('emailEvidence');
      const fas = doc('fasCases');
      let aperiaCache = null;
      if (row && tireRelevant(row)) { try { aperiaCache = ports.aperiaCachedIssues(); } catch (_) { aperiaCache = null; } }
      const lim = d.limiter || null;
      const budgetOf = (s) => !!(lim && lim.tokensLeft(s) > 0 && lim.tickLeft() > 0);
      const plan = planSources({
        row: row || { equipmentId: unit },
        features,
        now: t0,
        gate: { aap: auth.midway === 'HEALTHY', decisiv: true },
        aapWarm: (() => { try { return ports.aapIsWarm() === true; } catch (_) { return false; } })(),
        decisivWarm: (() => { try { return ref.srUrl ? ports.decisivIsWarm(ref.srUrl) === true : false; } catch (_) { return false; } })(),
        newestAapCommentAt: row ? newestLoggedUpdate(row.fullConversation, fleetDoc.syncedAt) : null,
        decisivStageAt: decEntry ? toMs(decEntry.scrapedAt) : null,
        budget: { aap_live: budgetOf('aap_live'), decisiv: budgetOf('decisiv') },
        dtnaCount,
        hasEmail: !!(email && typeof email === 'object' && unitIndex(email, UNIT_KEY_OF.emailEvidence).has(unit)),
        hasFasCase: !!(fas && typeof fas === 'object' && fas['unit-' + unit.toLowerCase()]),
        longDwellListed: (rec.reasons || []).some((r) => r && r.code === 'LONG_DWELL_LISTED'),
        aperiaCache,
      });
      ctx.plan = plan.sources;
      cs.writeCheckpoint(runId, null, { plan: plan.sources });
      cs.appendEvent({ caseId, at: now(), kind: 'plan', reason: 'planned', runId, detail: { sources: plan.sources.map((s) => s.source + ':' + s.status) } });

      // ── step 4: evidence ────────────────────────────────────────────────
      pack = await evidence.collect(plan, ports, lim, signal, {
        row: row || { equipmentId: unit }, now: t0, syncedAt: fleetDoc.syncedAt, buildAtMs, staleDays, isDown: down,
        docs: d.docs,
      });
      if (aborted()) return onAbort();
      cs.writeFindings(caseId, runId, pack.items);
      fp = fingerprint.fp(pack);
      ctx.sourceCalls = _sourceCallsSummary(pack);
      cs.writeCheckpoint(runId, { step: 'evidence_done', fp, at: now(), sourceStatus: pack.sourceStatus, flags: pack.flags }, { sourceCalls: ctx.sourceCalls, step: 'evidence' });
      try { job.setCheckpoint({ runId, step: 'evidence_done', fp }); } catch (_) {}
      const kinds = {};
      for (const e of pack.events || []) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
      for (const k of Object.keys(kinds)) cs.appendEvent({ caseId, at: now(), kind: 'evidence', reason: k, runId, detail: { count: kinds[k] } });

      const unusable = requiredSourceUnusable(row, ff, fleetDoc.syncedAt, now());
      if (unusable) {
        const to = AUTH_DOWN.has(auth.midway) ? S.AUTH_REQUIRED : S.WAITING_FOR_DATA;
        const outcome = to === S.AUTH_REQUIRED ? 'auth_required' : 'waiting_for_data';
        const t = now();
        const f = Object.assign({}, RELEASE, { next_attempt_at: t + _jitter(HOUR, rand), last_checked_at: t, last_error_code: unusable, evidence_fp: fp });
        if (typeof d.cheapFpOf === 'function') { try { f.cheap_fp = d.cheapFpOf(rec, row); } catch (_) {} }
        cs.persistRun(caseId, runId, f, to, { reason: unusable, run: runMeta(outcome), now: t });
        try { job.complete({ outcome }); } catch (_) {}
        return done(outcome, to);
      }
    }

    // ── step 5: resolution ────────────────────────────────────────────────
    if (row && !down) {
      const r = resolution.verifyResolution(rec, row, { source: fleetDoc.source, syncedAt: fleetDoc.syncedAt, buildAtMs, isDown: isDownFn }, now());
      if (r && r.token) {
        cs.persistRun(caseId, runId, RELEASE, S.RESOLVED, { reason: 'resolved', resolution: r.token, run: runMeta('resolved'), event: { kind: 'resolution', reason: 'aap_active', detail: resolution.payloadOf(r.token) }, now: now() });
        try { job.complete({ outcome: 'resolved' }); } catch (_) {}
        return done('resolved', S.RESOLVED);
      }
    }

    const cheap = (() => { if (typeof d.cheapFpOf !== 'function') return undefined; try { return d.cheapFpOf(rec, row); } catch (_) { return undefined; } })();

    // ── step 6: unchanged ─────────────────────────────────────────────────
    const aiOn = features.aiInvestigation === true;
    if (resumeStep !== 'ai_pending' && resumeStep !== 'analysis_done' && fp === rec.evidence_fp && rec.recommendation_json
      && (rec.ai_fp === fp || !aiOn || (rec.ai_retry_at != null && rec.ai_retry_at > now()))) {
      const t = now();
      const prev = rec.ai_findings || {};
      let nra = nextReviewAt(prev, rec.eta, t, rand);
      if (rec.ai_retry_at != null) nra = Math.min(nra, rec.ai_retry_at);
      const to = rec.review_status === 'pending' ? S.RECOMMENDATION_READY : S.MONITORING;
      const f = Object.assign({}, RELEASE, {
        last_checked_at: t, next_review_at: nra, attempts: 0, next_attempt_at: null, last_error_code: null,
        priority: score({ reasons: rec.reasons, daysDown: rec.days_down, trigger, aiUrgency: prev.urgency, aiInvestigation: aiOn, state: to, unchanged: true }),
      });
      if (cheap !== undefined) f.cheap_fp = cheap;
      cs.persistRun(caseId, runId, f, to, { reason: 'unchanged', run: runMeta('unchanged'), event: { kind: 'unchanged', reason: 'evidence_unchanged' }, now: t });
      try { job.complete({ outcome: 'unchanged' }); } catch (_) {}
      return done('unchanged', to);
    }

    // ── step 7: analysis ──────────────────────────────────────────────────
    if (aborted()) return onAbort();
    cs.transition(caseId, S.ANALYZING, { reason: resumeStep ? 'resumed:' + resumeStep : 'analyze', runId, now: now() });
    let canonical = null;
    if (row) { try { canonical = ports.canonical(row); } catch (_) { canonical = null; } }
    const analysis = analyze(pack, rec, { row, syncedAt: fleetDoc.syncedAt, canonical, now: now() });

    // ── step 8: AI decision ───────────────────────────────────────────────
    let output = null;
    let warnings = [];
    if (resumeStep === 'analysis_done' && cp && cp.output) {
      output = cp.output;
      ctx.aiStatus = cp.aiStatus || null;
      ctx.aiLane = cp.aiLane || null;
      ctx.aiModel = cp.aiModel || null;
      ctx.aiIsolated = cp.aiIsolated == null ? null : cp.aiIsolated;
      ctx.aiLatencyMs = cp.aiLatencyMs == null ? null : cp.aiLatencyMs;
      ctx.aiRequestId = cp.aiRequestId || null;
    } else {
      let v = null;
      if (resumeStep === 'ai_pending') ctx.aiStatus = 'interrupted';
      else if (!aiOn) ctx.aiStatus = 'disabled';
      else if (fp === rec.ai_fp || trivial(analysis)) ctx.aiStatus = 'not_needed';
      else {
        let q = null;
        try { q = ports.aiQueue(); } catch (_) { q = null; }
        if (aiBusy(q)) {
          if ((rec.ai_defer_count || 0) < LIMITS.aiDeferMax) {
            ctx.aiStatus = 'skipped_busy';
            const t = now();
            cs.persistRun(caseId, runId, Object.assign({}, RELEASE, { ai_defer_count: (rec.ai_defer_count || 0) + 1, next_attempt_at: t + (cfg.intervalMs || 300000) }),
              S.QUEUED, { reason: 'ai_deferred', run: runMeta('deferred'), event: { kind: 'ai', reason: 'deferred_busy' }, now: t });
            try { job.complete({ outcome: 'deferred' }); } catch (_) {}
            return done('deferred', S.QUEUED);
          }
          ctx.aiStatus = 'skipped_busy';
        } else {
          let st = null;
          try { st = ports.aiStatus(); } catch (_) { st = null; }
          if (_backendsDown(st)) ctx.aiStatus = 'unavailable';
          else if (!cs.reserveAiCallAndMarkPending(runId, localDate(now()), Number.isFinite(cfg.dailyCap) ? cfg.dailyCap : 48, fp, { now: now() })) ctx.aiStatus = 'skipped_cap';
          else {
            try { job.setCheckpoint({ runId, step: 'ai_pending', fp }); } catch (_) {}
            let isolated = false;
            try { isolated = ports.isolatedLaneAvailable() === true; } catch (_) { isolated = false; }
            const pr = buildPrompt(pack, analysis, { isolatedLaneAvailable: isolated });
            ctx.aiRequestId = 'ap-' + runId;
            ctx.aiLane = pr.isolated ? 'isolated' : 'gateway';
            ctx.aiIsolated = pr.isolated;
            try { ctx.aiModel = (st && st.model) || null; } catch (_) { ctx.aiModel = null; }
            const t1 = now();
            ctx.aiCalled = true;
            const r = await reasonFn({
              prompt: pr.prompt, source: 'autopilot', label: 'autopilot', timeoutMs: AI_TIMEOUT_MS,
              isolated: pr.isolated, signal: signal || undefined, requestId: ctx.aiRequestId,
            });
            ctx.aiLatencyMs = now() - t1;
            if (aborted()) return onAbort();
            if (r && r.ok) {
              v = validateAiOutput(r.data, pack);
              ctx.aiStatus = v.ok ? 'ok' : 'invalid';
              warnings = v.warnings || [];
            } else if (r && r.error === 'reason-timeout') ctx.aiStatus = 'timeout';
            else if (r && (r.error === 'unparseable' || r.error === 'missing-array')) ctx.aiStatus = 'invalid';
            else ctx.aiStatus = 'unavailable';
          }
        }
      }
      // ── step 9: merge ───────────────────────────────────────────────────
      output = (ctx.aiStatus === 'ok' && v && v.ok) ? v.output : deterministicRecommendation(analysis, pack, { now: now() });
      try {
        cs.writeCheckpoint(runId, {
          step: 'analysis_done', fp, output, aiStatus: ctx.aiStatus, generatedBy: output.generatedBy, aiLane: ctx.aiLane,
          aiModel: ctx.aiModel, aiIsolated: ctx.aiIsolated, aiLatencyMs: ctx.aiLatencyMs, aiRequestId: ctx.aiRequestId, at: now(),
        }, { step: 'analysis' });
      } catch (e) { if (_codeOf(e) !== 'CHECKPOINT_TOO_LARGE') throw e; }
      try { job.setCheckpoint({ runId, step: 'analysis_done', fp }); } catch (_) {}
    }
    if (aborted()) return onAbort();

    // ── step 10: persist ──────────────────────────────────────────────────
    const t = now();
    const recommendation = { recommendedActions: output.recommendedActions || [], actionsRequiringApproval: output.actionsRequiringApproval || [] };
    const hash = _sha1(JSON.stringify(recommendation));
    const hashChanged = hash !== rec.recommendation_hash;
    if (!hashChanged) cs.appendEvent({ caseId, at: t, kind: 'recommendation', reason: 'unchanged', runId, detail: { unchanged: true } });

    let streak = rec.ai_reject_streak || 0;
    if (ctx.aiStatus === 'invalid') streak++;
    else if (ctx.aiStatus === 'ok') streak = 0;

    const f = Object.assign({}, RELEASE, {
      ai_findings_json: output,
      recommendation_json: recommendation,
      recommendation_hash: hash,
      eta_json: analysis.eta,
      blockers_json: analysis.blockers,
      responsible_party: analysis.responsibleParty,
      repair_phase: analysis.repairPhase,
      last_vendor_update_at: analysis.lastVendorUpdate ? analysis.lastVendorUpdate.at : null,
      last_vendor_update_source: analysis.lastVendorUpdate ? analysis.lastVendorUpdate.source : null,
      last_logged_update_at: analysis.lastLoggedUpdateAt,
      evidence_fp: fp,
      last_checked_at: t,
      attempts: 0,
      next_attempt_at: null,
      last_error_code: null,
      ai_reject_streak: streak,
    });
    if (cheap !== undefined) f.cheap_fp = cheap;
    let nra = nextReviewAt(output, analysis.eta, t, rand);
    if (AI_ANSWERED.has(ctx.aiStatus)) { f.ai_fp = fp; f.ai_retry_at = null; }
    else if (AI_RETRY.has(ctx.aiStatus)) {
      const retryAt = t + _jitter(Math.max(cfg.intervalMs || 0, HOUR), rand);
      f.ai_retry_at = retryAt;
      nra = Math.min(nra, retryAt);
    }
    f.next_review_at = nra;

    const approvals = recommendation.actionsRequiringApproval.length > 0;
    let to;
    if (analysis.needsReviewConflict || streak >= LIMITS.aiRejectStreak) to = S.NEEDS_REVIEW;
    else if (approvals && (hashChanged || rec.review_status === 'pending')) to = S.RECOMMENDATION_READY;
    else to = S.MONITORING;
    if (approvals && hashChanged) f.review_status = 'pending';
    f.priority = score({ reasons: rec.reasons, daysDown: rec.days_down, trigger, aiUrgency: output.urgency, aiInvestigation: aiOn, state: to });

    const reasonCode = to === S.NEEDS_REVIEW ? (analysis.needsReviewConflict ? 'authority_tie' : 'ai_rejected') : 'recommendation';
    cs.persistRun(caseId, runId, f, to, {
      reason: reasonCode,
      run: runMeta('recommendation'),
      event: { kind: ctx.aiStatus === 'ok' ? 'ai' : 'fallback', reason: ctx.aiStatus, detail: { generatedBy: output.generatedBy, warnings: warnings.slice(0, 20) } },
      now: t,
    });
    try { job.complete({ outcome: 'recommendation' }); } catch (_) {}
    log.debug && log.debug(rec.unit_id + ' run ' + ctx.aiStatus + ' -> ' + to + ' in ' + (clock() - t0) + 'ms');
    return done('recommendation', to, { warnings });
  } catch (e) {
    if (aborted() && !(e && e.code === 'ILLEGAL_TRANSITION')) {
      try { return onAbort(); } catch (_) { /* fall through to the error path */ }
    }
    return _onError(e);
  }

  function _onError(e) {
    const code = _codeOf(e);
    const t = clock();
    try { log.warn(rec.unit_id + ' run failed: ' + code); } catch (_) {}
    try {
      const cur = (cs.getCase(caseId) || {}).case || rec;
      rec = cur;
      if (code === 'STORE_BUSY') {
        cs.persistRun(caseId, runId, Object.assign({}, RELEASE, { next_attempt_at: null }), S.QUEUED, { reason: 'store_busy', run: runMeta('aborted', { errorCode: code }), now: t });
        return done('aborted', S.QUEUED, { code });
      }
      const attempts = (cur.attempts || 0) + 1;
      if (attempts >= LIMITS.maxAttempts) {
        cs.persistRun(caseId, runId, Object.assign({}, RELEASE, { attempts, last_error_code: code }), S.FAILED,
          { reason: code, run: runMeta('failed', { errorCode: code }), event: { kind: 'error', reason: code, detail: { attempts } }, now: t });
        try { job.fail(e); } catch (_) {}
        return done('failed', S.FAILED, { code });
      }
      const mins = LIMITS.retryBackoffMin[Math.min(attempts - 1, LIMITS.retryBackoffMin.length - 1)];
      cs.persistRun(caseId, runId, Object.assign({}, RELEASE, { attempts, last_error_code: code, next_attempt_at: t + _jitter(mins * MIN, rand) }), S.QUEUED,
        { reason: 'retry', run: runMeta('failed', { errorCode: code }), event: { kind: 'error', reason: code, detail: { attempts } }, now: t });
      try { job.fail(e); } catch (_) {}
      return done('failed', S.QUEUED, { code });
    } catch (e2) {
      try { cs.appendEvent({ caseId, at: t, kind: 'error', reason: _codeOf(e2), runId, detail: { first: code } }); } catch (_) {}
      try { log.error(rec.unit_id + ' run could not be persisted: ' + _codeOf(e2)); } catch (_) {}
      return { ok: false, caseId, runId, code, outcome: 'failed' };
    }
  }
}

module.exports = { runInvestigation, requiredSourceUnusable, aiBusy, nextReviewAt, LEASE_MS, AI_TIMEOUT_MS };
