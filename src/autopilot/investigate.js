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
const { planSources, decisivRef, tireRelevant, rowWithLinkedDecisiv } = require('./plan');
const evidence = require('./evidence');
const fingerprint = require('./fingerprint');
const resolution = require('./resolution');
const { analyze, trivial } = require('./analyze');
const { buildPrompt } = require('./prompt');
const { validateAiOutput, hasSourceSupport } = require('./validate');
const { deterministicRecommendation } = require('./fallback');
const { buildConflicts, needsReview } = require('./conflicts');
const { scoreV2 } = require('./priority');
const { newestLoggedUpdate, toMs } = require('./updates');
const { classifyEquipment, CLASSES: EQ } = require('./equipment');
const slices = require('./slices');
const agentAdapter = require('./agent-adapter');
const complexity = require('./complexity');
const memoryMod = require('./memory');
const recordMod = require('./record');
const timeline = require('./timeline');

let logger;
try { logger = require('../utils/logger')('autopilot'); } catch (_) { logger = { debug() {}, info() {}, warn() {}, error() {} }; }

const LEASE_MS = 10 * MIN;
const AI_TIMEOUT_MS = 60000;
const RED_UNUSABLE = new Set(['age>3x', 'superseded', 'wedged']);
const AI_ANSWERED = new Set(['ok', 'invalid', 'not_needed', 'inconclusive']);
const AI_RETRY = new Set(['timeout', 'unavailable', 'skipped_cap', 'skipped_busy', 'interrupted']);
const PAUSE_ABORTS = new Set(['master_pause', 'master_stop']);
// §6.7: ai_pending_reason by final aiStatus (ok / invalid / inconclusive / not_needed -> NULL).
const PENDING_REASON = Object.freeze({
  skipped_cap: 'cap', skipped_busy: 'busy', unavailable: 'unavailable', timeout: 'timeout', interrupted: 'interrupted', disabled: 'disabled',
});
// AgentResult stop codes that end an answered loop without a final (§7.1 table) -> 'inconclusive'.
const INCONCLUSIVE_STOPS = new Set(['maxModelTurns', 'maxToolCalls', 'maxElapsedMs', 'maxEvidenceBytes', 'no_progress', 'planner_invalid']);
// Model-step codes of a planner answer that came back but failed validation (the model answered).
const ANSWERED_INVALID_CODES = new Set(['invalid_schema', 'invalid_decision', 'invalid_final', 'unparseable', 'missing-array']);
const NOT_COUNTED_TOOL = new Set(['skipped', 'reused', 'denied', 'invalid_args']);

function _sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function _jitter(ms, rand) { return Math.round(ms * (1 + (rand() * 0.2 - 0.1))); }
function _startOfNextLocalDay(t) { const d = new Date(t); d.setHours(24, 0, 0, 0); return d.getTime(); }
function _hasFlag(it, f) { return !!(it && Array.isArray(it.flags) && it.flags.includes(f)); }

/** ai_retry_at for a deferred AI status (review finding 5), or null. Same rule on both paths. */
function retryAtFor(aiStatus, stopCode, t, rand, intervalMs) {
  if (aiStatus === 'skipped_cap') return _startOfNextLocalDay(t) + Math.round(rand() * 30 * MIN);
  if (aiStatus === 'skipped_busy') return t + _jitter(Math.max(intervalMs || 0, HOUR), rand);
  if (aiStatus === 'unavailable' || aiStatus === 'timeout' || aiStatus === 'interrupted') return t + _jitter(HOUR, rand);
  return null;
}

/** True when a model ap_step answered: status ok, or invalid with a validation code (not a timeout / relay error). */
function _modelAnswered(st) {
  return !!st && st.kind === 'model' && (st.status === 'ok' || (st.status === 'invalid' && ANSWERED_INVALID_CODES.has(st.code)));
}

/** Add the merged conflict groups an output does not already disclose (AC-37). Returns a new output. */
function _discloseConflicts(output, groups) {
  const out = Object.assign({}, output);
  const list = Array.isArray(out.conflicts) ? out.conflicts.slice() : [];
  const cited = new Set();
  for (const c of list) for (const id of (c && Array.isArray(c.evidenceIds) ? c.evidenceIds : [])) cited.add(id);
  for (const g of groups || []) {
    const ids = (g.positions || []).map((p) => p.evidenceId).filter(Boolean);
    if (!ids.length || ids.some((id) => cited.has(id)) || list.length >= 20) continue;
    list.push({
      field: String((g.fields || []).join('/') || g.group).slice(0, 40),
      note: String((g.positions || []).map((p) => p.source + '=' + String(p.value == null ? '' : p.value).slice(0, 40)).join('; ')
        + (g.authorityWinner ? '' : ' (no authority winner)')).slice(0, 300),
      evidenceIds: ids,
    });
  }
  out.conflicts = list;
  return out;
}
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
  // A cap-deferred NEEDS_REVIEW case requeued by ai_capacity returns to NEEDS_REVIEW (it still waits for a human).
  const heldReview = (() => { try { return typeof cs.heldReviewCode === 'function' ? cs.heldReviewCode(caseId) : null; } catch (_) { return null; } })();

  // ── step 1: lease, open ─────────────────────────────────────────────────
  // One lease owner per run (V2 §7.1, FR-12.1): every in-run case / step write checks it in its own
  // transaction. Exceptions: openRun and closing the own run in _onLeaseLost.
  const leaseOwner = owner + '#' + crypto.randomBytes(4).toString('hex');
  if (!cs.leaseRun(caseId, leaseOwner, t0 + LEASE_MS, { now: t0 })) return { ok: false, code: 'LEASED', caseId };
  cs.transition(caseId, S.INVESTIGATING, { reason: trigger, now: t0, leaseOwner });
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
      { reason: why, pauseReason: pause ? why : undefined, run: runMeta('aborted'), event: { kind: 'control', reason: 'aborted:' + why }, now, leaseOwner });
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
    const LM = { leaseOwner };
    const cpExtra = (x) => Object.assign({ leaseOwner, leaseUntil: now() + LEASE_MS, now: now() }, x || {});

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

    // ── step 3: scope and equipment re-check, plan, auth snapshot ─────────
    if (row && !inScopeExisting(row, buildScope(cfg))) {
      cs.persistRun(caseId, runId, RELEASE, S.PAUSED, { reason: 'out_of_scope', pauseReason: 'out_of_scope', run: runMeta('paused'), now: now(), leaseOwner });
      try { job.complete({ outcome: 'paused' }); } catch (_) {}
      return done('paused', S.PAUSED);
    }
    if (row) {
      const eq = classifyEquipment(row);
      if (eq.cls !== EQ.POWER_ELIGIBLE) {
        const why = eq.cls === EQ.TYPE_UNKNOWN || eq.cls === EQ.TYPE_CONFLICT || eq.cls === EQ.INVALID_ROW ? 'type_unverified' : 'not_power_unit';
        cs.persistRun(caseId, runId, RELEASE, S.PAUSED, { reason: why, pauseReason: why, run: runMeta('paused'), event: { kind: 'equipment', reason: eq.code }, now: now(), leaseOwner });
        try { job.complete({ outcome: 'paused' }); } catch (_) {}
        return done('paused', S.PAUSED);
      }
    }
    let auth = {};
    try { auth = ports.authState() || {}; } catch (_) { auth = {}; }

    let pack;
    let fp;
    let aperiaRead;   // the Aperia cache as read for the plan (undefined when not read)
    let resumeToolItems = [];
    if (resumeStep) {
      // The base pack = findings without the 'tool' flag; tool items (copied loop steps) seed the adapter.
      const all = cs.findingsForRun(runId);
      const items = all.filter((it) => !_hasFlag(it, 'tool'));
      resumeToolItems = all.filter((it) => _hasFlag(it, 'tool'));
      pack = { items, conflicts: buildConflicts(items, { isDown: down }), sourceStatus: (cp && cp.sourceStatus) || {}, sourceCalls: [], flags: (cp && cp.flags) || [], events: [] };
      fp = cp.fp || fingerprint.fp(pack);
    } else {
      // Plan (written now, R10).
      const unit = rec.unit_id;
      const dealerCases = rec.dealer_cases !== undefined ? rec.dealer_cases : rec.dealer_cases_json;
      const planRow = rowWithLinkedDecisiv(row || { equipmentId: unit }, dealerCases);
      const ref = decisivRef(planRow);
      const decDoc = doc('decisivCaseCache');
      const decEntry = ref.estimateId && decDoc && typeof decDoc === 'object' ? decDoc[ref.estimateId] : null;
      let dtnaCount = 0;
      try { const l = ports.dtnaCasesForUnit(unit); dtnaCount = Array.isArray(l) ? l.length : 0; } catch (_) { dtnaCount = 0; }
      const email = doc('emailEvidence');
      const fas = doc('fasCases');
      let aperiaCache = null;
      if (row && tireRelevant(row)) { try { aperiaCache = ports.aperiaCachedIssues(); } catch (_) { aperiaCache = null; } aperiaRead = aperiaCache; }
      const lim = d.limiter || null;
      const budgetOf = (s) => !!(lim && lim.tokensLeft(s) > 0 && lim.tickLeft() > 0);
      const plan = planSources({
        row: planRow,
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
        dealerCases,
      });
      ctx.plan = plan.sources;
      cs.writeCheckpoint(runId, null, cpExtra({ plan: plan.sources }));
      cs.appendEvent({ caseId, at: now(), kind: 'plan', reason: 'planned', runId, detail: { sources: plan.sources.map((s) => s.source + ':' + s.status) } }, LM);

      // ── step 4: evidence ────────────────────────────────────────────────
      pack = await evidence.collect(plan, ports, lim, signal, {
        row: planRow, now: t0, syncedAt: fleetDoc.syncedAt, buildAtMs, staleDays, isDown: down,
        docs: d.docs,
      });
      if (aborted()) return onAbort();
      cs.writeFindings(caseId, runId, pack.items, LM);
      fp = fingerprint.fp(pack);
      ctx.sourceCalls = _sourceCallsSummary(pack);
      cs.writeCheckpoint(runId, { step: 'evidence_done', fp, at: now(), sourceStatus: pack.sourceStatus, flags: pack.flags }, cpExtra({ sourceCalls: ctx.sourceCalls, step: 'evidence' }));
      try { job.setCheckpoint({ runId, step: 'evidence_done', fp }); } catch (_) {}
      const kinds = {};
      for (const e of pack.events || []) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
      for (const k of Object.keys(kinds)) cs.appendEvent({ caseId, at: now(), kind: 'evidence', reason: k, runId, detail: { count: kinds[k] } }, LM);

      const unusable = requiredSourceUnusable(row, ff, fleetDoc.syncedAt, now());
      if (unusable) {
        const to = AUTH_DOWN.has(auth.midway) ? S.AUTH_REQUIRED : S.WAITING_FOR_DATA;
        const outcome = to === S.AUTH_REQUIRED ? 'auth_required' : 'waiting_for_data';
        const t = now();
        const f = Object.assign({}, RELEASE, { next_attempt_at: t + _jitter(HOUR, rand), last_checked_at: t, last_error_code: unusable, evidence_fp: fp });
        if (typeof d.cheapFpOf === 'function') { try { f.cheap_fp = d.cheapFpOf(rec, row); } catch (_) {} }
        if (heldReview) {
          // A held review case still waits for a human: back to NEEDS_REVIEW with its code; the
          // ai_capacity retry waits an hour instead of re-firing on the next tick.
          f.ai_retry_at = t + _jitter(HOUR, rand);
          cs.persistRun(caseId, runId, f, S.NEEDS_REVIEW, { reason: heldReview, run: runMeta(outcome), event: { kind: 'evidence', reason: 'source_unusable:' + unusable }, now: t, leaseOwner });
          try { job.complete({ outcome }); } catch (_) {}
          return done(outcome, S.NEEDS_REVIEW);
        }
        cs.persistRun(caseId, runId, f, to, { reason: unusable, run: runMeta(outcome), now: t, leaseOwner });
        try { job.complete({ outcome }); } catch (_) {}
        return done(outcome, to);
      }
    }

    // ── step 5: resolution ────────────────────────────────────────────────
    if (row && !down) {
      const r = resolution.verifyResolution(rec, row, { source: fleetDoc.source, syncedAt: fleetDoc.syncedAt, buildAtMs, isDown: isDownFn }, now());
      if (r && r.token) {
        cs.persistRun(caseId, runId, RELEASE, S.RESOLVED, { reason: 'resolved', resolution: r.token, run: runMeta('resolved'), event: { kind: 'resolution', reason: 'aap_active', detail: resolution.payloadOf(r.token) }, now: now(), leaseOwner });
        try { job.complete({ outcome: 'resolved' }); } catch (_) {}
        return done('resolved', S.RESOLVED);
      }
    }

    const cheap = (() => { if (typeof d.cheapFpOf !== 'function') return undefined; try { return d.cheapFpOf(rec, row); } catch (_) { return undefined; } })();
    // Slice fingerprints (§9.1, review finding 7): the same slices.forCase the controller uses.
    const sliceFps = (() => {
      try { return slices.forCase({ row: row || { equipmentId: rec.unit_id }, unit: rec.unit_id, docs: doc, ports, now: t0, aperiaIssues: aperiaRead }); } catch (_) { return null; }
    })();
    const aiOn = features.aiInvestigation === true;
    const deep = rec.deep_requested_at != null;
    const prioOf = (to, urgency, unchanged) => scoreV2({
      reasons: rec.reasons, safety: rec.safety, daysDown: rec.days_down, recurrenceOf: rec.recurrence_of, recurrenceCount: rec.recurrence_count,
      neverInvestigated: rec.last_checked_at == null, aiUrgency: urgency, aiInvestigation: aiOn, state: to, unchanged: !!unchanged,
    });

    // ── step 6: unchanged ─────────────────────────────────────────────────
    if (resumeStep !== 'ai_pending' && resumeStep !== 'analysis_done' && resumeStep !== 'loop' && !deep && fp === rec.evidence_fp && rec.recommendation_json
      && (rec.ai_fp === fp || !aiOn || (rec.ai_retry_at != null && rec.ai_retry_at > now()))) {
      const t = now();
      const prev = rec.ai_findings || {};
      let nra = nextReviewAt(prev, rec.eta, t, rand);
      if (rec.ai_retry_at != null) nra = Math.min(nra, rec.ai_retry_at);
      // An authority tie or the AI-rejected streak still holds: stay in NEEDS_REVIEW (leaving it needs
      // a human accept). A review the user already accepted with the same code is not re-requested.
      const tie = needsReview(pack.conflicts && pack.conflicts.groups);
      let reviewCode = tie ? 'authority_tie' : ((rec.ai_reject_streak || 0) >= LIMITS.aiRejectStreak ? 'ai_rejected' : null);
      let keepReview = reviewCode != null && !(rec.review_status === 'accepted' && rec.review_accepted_code === reviewCode);
      if (!keepReview && heldReview) { keepReview = true; reviewCode = heldReview; }
      const to = keepReview ? S.NEEDS_REVIEW : (rec.review_status === 'pending' ? S.RECOMMENDATION_READY : S.MONITORING);
      const f = Object.assign({}, RELEASE, {
        last_checked_at: t, next_review_at: nra, attempts: 0, next_attempt_at: null, last_error_code: null,
        priority: prioOf(to, prev.urgency, true),
      });
      if (cheap !== undefined) f.cheap_fp = cheap;
      if (sliceFps) f.slice_fps_json = sliceFps;
      cs.persistRun(caseId, runId, f, to, { reason: keepReview ? reviewCode : 'unchanged', run: runMeta('unchanged'), event: { kind: 'unchanged', reason: 'evidence_unchanged' }, now: t, leaseOwner });
      try { job.complete({ outcome: 'unchanged' }); } catch (_) {}
      return done('unchanged', to);
    }

    // ── step 7: analysis ──────────────────────────────────────────────────
    if (aborted()) return onAbort();
    cs.transition(caseId, S.ANALYZING, { reason: resumeStep ? 'resumed:' + resumeStep : 'analyze', runId, now: now(), leaseOwner });
    let canonical = null;
    if (row) { try { canonical = ports.canonical(row); } catch (_) { canonical = null; } }
    const analysis = analyze(pack, rec, { row, syncedAt: fleetDoc.syncedAt, canonical, now: now() });
    const priorCases = (() => {
      try {
        return cs.listCases({ q: rec.unit_id, includeResolved: true, limit: 20 }).items
          .filter((c) => c.case_id !== caseId && c.unit_id === rec.unit_id).slice(0, 5)
          .map((c) => Object.assign({}, c, { record: typeof cs.getRecord === 'function' ? cs.getRecord(c.case_id) : null }));
      } catch (_) { return []; }
    })();

    // ── step 8: AI decision ───────────────────────────────────────────────
    // A deep request runs the AI even on a trivial case or unchanged evidence (AC-40).
    const aiNeeded = aiOn && (deep || (fp !== rec.ai_fp && !trivial(analysis)));
    const intervalMs = cfg.intervalMs || 300000;
    let output = null;
    let warnings = [];
    let agent = null;       // AgentResult of an adapter run in this run
    let agentInfo = null;   // { status, stopCode, tier, turns, toolCalls } (also restored from analysis_done)
    const deferBusy = () => {
      ctx.aiStatus = 'skipped_busy';
      const t = now();
      cs.persistRun(caseId, runId, Object.assign({}, RELEASE, { ai_defer_count: (rec.ai_defer_count || 0) + 1, next_attempt_at: t + intervalMs }),
        S.QUEUED, { reason: 'ai_deferred', run: runMeta('deferred'), event: { kind: 'ai', reason: 'deferred_busy' }, now: t, leaseOwner });
      try { job.complete({ outcome: 'deferred' }); } catch (_) {}
      return done('deferred', S.QUEUED);
    };
    if (resumeStep === 'analysis_done' && cp && cp.output) {
      output = cp.output;
      ctx.aiStatus = cp.aiStatus || null;
      ctx.aiLane = cp.aiLane || null;
      ctx.aiModel = cp.aiModel || null;
      ctx.aiIsolated = cp.aiIsolated == null ? null : cp.aiIsolated;
      ctx.aiLatencyMs = cp.aiLatencyMs == null ? null : cp.aiLatencyMs;
      ctx.aiRequestId = cp.aiRequestId || null;
      agentInfo = cp.agent || null;
    } else {
      let v = null;
      let laneOk = false;
      try { laneOk = ports.isolatedLaneAvailable() === true; } catch (_) { laneOk = false; }
      if (resumeStep === 'ai_pending') ctx.aiStatus = 'interrupted';
      else if (!aiOn) ctx.aiStatus = 'disabled';
      else if (!aiNeeded) ctx.aiStatus = 'not_needed';
      else if (laneOk && (features.multiTurn === true || resumeStep === 'loop')) {
        // ── multi-turn adapter on the isolated lane (§6.3) ───────────────
        const sc = ctx.sourceCalls || {};
        const liveDone = [...new Set([].concat(
          resumeStep === 'loop' && cp && Array.isArray(cp.liveDone) ? cp.liveDone : [],
          Object.keys(sc).filter((k) => sc[k] && Number(sc[k].live) > 0),
          (pack.sourceCalls || []).filter((c) => c && Number(c.attempts) > 0).map((c) => c.source),
        ))];
        let resume = null;
        if (resumeStep === 'loop') {
          const steps = cs.stepsForRun(runId);
          resume = {
            steps, toolItems: resumeToolItems,
            turnsUsed: steps.filter((s) => s.kind === 'model').length,
            toolsUsed: steps.filter((s) => s.kind === 'tool' && s.turn > 0 && !NOT_COUNTED_TOOL.has(s.status)).length,
            bytesUsed: steps.reduce((n, s) => n + (Number(s.result_bytes) || 0), 0),
            elapsedUsedMs: steps.reduce((n, s) => n + (Number(s.ms) || 0), 0),
            liveDone,
          };
        }
        cs.writeCheckpoint(runId, { step: 'loop', fp, at: now(), sourceStatus: pack.sourceStatus, flags: pack.flags, liveDone }, cpExtra({ step: 'loop' }));
        try { job.setCheckpoint({ runId, step: 'loop', fp }); } catch (_) {}
        agent = await agentAdapter.runAgentInvestigation({
          caseId, runId, rec, row: row || { equipmentId: rec.unit_id }, basePack: pack, analysis, cfg, ports, limiter: d.limiter || null,
          signal, now, leaseOwner, leaseUntilFn: () => now() + LEASE_MS, caseStore: cs, reason: reasonFn, aiBusy, resume, deep,
          changedSlices: Array.isArray(d.changedSlices) ? d.changedSlices : slices.changedSlices(rec.slice_fps, sliceFps),
          docs: d.docs || {}, priorCases, syncedAt: fleetDoc.syncedAt, buildAtMs, staleDays, isDown: down, logger: log,
        });
        if (aborted() || agent.stopCode === 'aborted') return onAbort();
        const answered = cs.stepsForRun(runId).filter(_modelAnswered).length;
        ctx.aiCalled = agent.aiCalls > 0;
        ctx.aiLane = 'isolated';
        ctx.aiIsolated = true;
        ctx.aiModel = agent.model || null;
        ctx.aiLatencyMs = agent.aiCalls > 0 ? agent.aiLatencyMs.reduce((n, x) => n + (Number(x) || 0), 0) : null;
        ctx.aiRequestId = agent.aiCalls > 0 ? 'ap-' + runId : null;
        agentInfo = { status: agent.status, stopCode: agent.stopCode || null, tier: agent.tier, turns: agent.turns, toolCalls: agent.toolCalls };
        warnings = agent.warnings || [];
        if (agent.status === 'concluded') { ctx.aiStatus = 'ok'; v = { ok: true, output: agent.output }; }
        else if (agent.status === 'invalid') ctx.aiStatus = 'invalid';
        else if (INCONCLUSIVE_STOPS.has(agent.stopCode)) ctx.aiStatus = answered > 0 ? 'inconclusive' : 'unavailable';
        else if (agent.stopCode === 'ai_cap') ctx.aiStatus = 'skipped_cap';
        else if (agent.stopCode === 'ai_busy') {
          if (agent.aiCalls === 0 && (rec.ai_defer_count || 0) < LIMITS.aiDeferMax) return deferBusy();
          ctx.aiStatus = 'skipped_busy';
        } else if (agent.stopCode === 'ai_timeout') ctx.aiStatus = 'timeout';
        else ctx.aiStatus = 'unavailable';   // ai_unavailable, lane_unavailable, planner-error, other stops
      } else {
        // ── V1 single call (multiTurn off, or the isolated lane is unavailable) ──
        if (features.multiTurn === true || resumeStep === 'loop') {
          ctx.aiLane = 'gateway';
          cs.appendEvent({ caseId, at: now(), kind: 'ai', reason: 'multiturn_lane_unavailable', runId }, LM);
        }
        let q = null;
        try { q = ports.aiQueue(); } catch (_) { q = null; }
        if (aiBusy(agentAdapter.adjustQueueForOwn(q, agentAdapter.aiInFlight()))) {
          if ((rec.ai_defer_count || 0) < LIMITS.aiDeferMax) return deferBusy();
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
            const r = await agentAdapter.trackAiCall(() => reasonFn({
              prompt: pr.prompt, source: 'autopilot', label: 'autopilot', timeoutMs: AI_TIMEOUT_MS,
              isolated: pr.isolated, signal: signal || undefined, requestId: ctx.aiRequestId,
            }));
            ctx.aiLatencyMs = now() - t1;
            if (aborted()) return onAbort();
            if (r && r.ok) {
              v = validateAiOutput(r.data, pack);
              // Same rule as the multi-turn final: a final citing only derived items is not accepted.
              const supported = v.ok && hasSourceSupport(v.output, pack);
              ctx.aiStatus = supported ? 'ok' : 'invalid';
              warnings = (v.warnings || []).concat(v.ok && !supported ? ['circular_only'] : []);
            } else if (r && r.error === 'reason-timeout') ctx.aiStatus = 'timeout';
            else if (r && (r.error === 'unparseable' || r.error === 'missing-array')) ctx.aiStatus = 'invalid';
            else ctx.aiStatus = 'unavailable';
          }
        }
      }
      // ── step 9: merge ───────────────────────────────────────────────────
      const merged0 = _mergeItems(pack.items, resumeToolItems, agent ? agent.evidenceItems : []);
      const hasTools = merged0.length > (pack.items || []).length;
      const mc = hasTools ? buildConflicts(merged0.filter(_nonDerived), { isDown: down }) : pack.conflicts;
      const fbAnalysis = hasTools ? Object.assign({}, analysis, { conflictGroups: mc.groups }) : analysis;
      const fbPack = hasTools ? { items: merged0, conflicts: mc } : pack;
      output = (ctx.aiStatus === 'ok' && v && v.ok) ? v.output : deterministicRecommendation(fbAnalysis, fbPack, { now: now() });
      if (ctx.aiStatus === 'inconclusive' && agent && agent.memory) {
        const mi = Array.isArray(output.missingInfo) ? output.missingInfo.slice() : [];
        for (const q of (Array.isArray(agent.memory.openQuestions) ? agent.memory.openQuestions : []).slice(0, 8)) {
          if (q && q.question && mi.length < 20) mi.push({ item: String(q.question).slice(0, 200), whyNeeded: 'Open question from the investigation.', likelySource: q.likelySource || 'unknown' });
        }
        output = Object.assign({}, output, { missingInfo: mi });
      }
      const cg = hasTools ? mc : pack.conflicts;
      if (cg && Array.isArray(cg.groups) && cg.groups.length) output = _discloseConflicts(output, cg.groups);
      try {
        cs.writeCheckpoint(runId, {
          step: 'analysis_done', fp, output, aiStatus: ctx.aiStatus, generatedBy: output.generatedBy, aiLane: ctx.aiLane,
          aiModel: ctx.aiModel, aiIsolated: ctx.aiIsolated, aiLatencyMs: ctx.aiLatencyMs, aiRequestId: ctx.aiRequestId, at: now(),
          agent: agentInfo,
        }, cpExtra({ step: 'analysis' }));
      } catch (e) { if (_codeOf(e) !== 'CHECKPOINT_TOO_LARGE') throw e; }
      try { job.setCheckpoint({ runId, step: 'analysis_done', fp }); } catch (_) {}
    }
    if (aborted()) return onAbort();

    // ── step 10: persist ──────────────────────────────────────────────────
    const t = now();
    const merged = _mergeItems(pack.items, resumeToolItems, agent ? agent.evidenceItems : []);
    const mergedConflicts = merged.length > (pack.items || []).length ? buildConflicts(merged.filter(_nonDerived), { isDown: down }) : pack.conflicts;
    const recommendation = { recommendedActions: output.recommendedActions || [], actionsRequiringApproval: output.actionsRequiringApproval || [] };
    const hash = _sha1(JSON.stringify(recommendation));
    const hashChanged = hash !== rec.recommendation_hash;
    if (!hashChanged) cs.appendEvent({ caseId, at: t, kind: 'recommendation', reason: 'unchanged', runId, detail: { unchanged: true } }, LM);

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
      const retryAt = retryAtFor(ctx.aiStatus, agentInfo && agentInfo.stopCode, t, rand, cfg.intervalMs);
      f.ai_retry_at = retryAt;
      nra = Math.min(nra, retryAt);
    }
    f.next_review_at = nra;

    // §6.7 + review finding 4: ai_investigated_at whenever an AI call of this run answered, whatever the stop.
    const stepsAnswered = (agent || resumeStep === 'loop' || resumeStep === 'analysis_done') && cs.stepsForRun(runId).some(_modelAnswered);
    if (ctx.aiStatus === 'ok' || ctx.aiStatus === 'invalid' || ctx.aiStatus === 'inconclusive' || stepsAnswered) f.ai_investigated_at = t;
    f.ai_pending_reason = PENDING_REASON[ctx.aiStatus] || null;
    f.complexity = agentInfo && agentInfo.tier ? agentInfo.tier
      : (deep ? 'complex' : complexity.classify({ rec, row, analysis, basePack: pack, priorCases, now: t }).tier);
    f.deep_requested_at = null;
    if (sliceFps) f.slice_fps_json = sliceFps;
    f.awaiting_sources = agent && agent.blockedSources && agent.blockedSources.length ? agent.blockedSources.slice(0, 20).join(',') : null;

    const approvals = recommendation.actionsRequiringApproval.length > 0;
    let to;
    if (analysis.needsReviewConflict || streak >= LIMITS.aiRejectStreak || heldReview) to = S.NEEDS_REVIEW;
    else if (approvals && (hashChanged || rec.review_status === 'pending')) to = S.RECOMMENDATION_READY;
    else to = S.MONITORING;
    if (approvals && hashChanged) f.review_status = 'pending';
    f.priority = prioOf(to, output.urgency, false);

    const evIndex = new Map(merged.filter((it) => it && it.evidenceId).map((it) => [it.evidenceId, it]));
    const memBase = (agent && agent.memory) || memoryMod.load(rec.memory_json) || memoryMod.init(rec, row);
    const mem = memoryMod.trim(memoryMod.conclude(memBase, {
      output, analysis, agent: agentInfo, runId, at: t, blockedSources: agent ? agent.blockedSources : [], recommendationHash: hash,
      nextReviewAt: nra, evidenceIndex: evIndex, sourceStatus: pack.sourceStatus,
    }));
    f.memory_json = mem;
    let proposals = null;
    if (features.timelineProposals === true) {
      const idx = timeline.publishedIndex(doc('notesStore'), (row && row.equipmentId) || rec.unit_id);
      proposals = timeline.buildProposals({ rec, items: merged, output, published: idx.published, hiddenSigs: idx.hiddenSigs, runId, now: t });
    }
    const record = recordMod.buildRecord({
      rec, row, analysis, output, agent: agentInfo, memory: mem, proposals, pack: { items: merged, conflicts: mergedConflicts },
      conflicts: mergedConflicts, sourceStatus: pack.sourceStatus, aiStatus: ctx.aiStatus, now: t,
    });

    const reasonCode = to === S.NEEDS_REVIEW
      ? (analysis.needsReviewConflict ? 'authority_tie' : (streak >= LIMITS.aiRejectStreak ? 'ai_rejected' : heldReview))
      : 'recommendation';
    cs.persistRun(caseId, runId, f, to, {
      reason: reasonCode,
      run: runMeta('recommendation'),
      event: {
        kind: ctx.aiStatus === 'ok' ? 'ai' : 'fallback', reason: ctx.aiStatus,
        detail: { generatedBy: output.generatedBy, warnings: warnings.slice(0, 20), conflicts: ((mergedConflicts && mergedConflicts.groups) || []).length, agent: agentInfo },
      },
      now: t, leaseOwner, record, proposals,
    });
    try { job.complete({ outcome: 'recommendation' }); } catch (_) {}
    log.debug && log.debug(rec.unit_id + ' run ' + ctx.aiStatus + ' -> ' + to + ' in ' + (clock() - t0) + 'ms');
    return done('recommendation', to, { warnings });
  } catch (e) {
    if (_isLeaseLost(e)) return _onLeaseLost(e);
    if (aborted() && !(e && e.code === 'ILLEGAL_TRANSITION')) {
      try { return onAbort(); } catch (e2) { if (_isLeaseLost(e2)) return _onLeaseLost(e2); /* else fall through to the error path */ }
    }
    return _onError(e);
  }

  // A takeover (or a step-key clash) ends the run without touching the case: close our own run only.
  function _onLeaseLost(e) {
    const code = _codeOf(e);
    try { cs.closeRun(runId, runMeta('lease_lost', { errorCode: code }), { now: clock() }); } catch (_) {}
    try { job.cancel('lease_lost'); } catch (_) {}
    try { log.warn(rec.unit_id + ' run lease lost: ' + code); } catch (_) {}
    return { ok: false, caseId, runId, code, outcome: 'lease_lost' };
  }

  function _onError(e) {
    const code = _codeOf(e);
    const t = clock();
    try { log.warn(rec.unit_id + ' run failed: ' + code); } catch (_) {}
    try {
      const cur = (cs.getCase(caseId) || {}).case || rec;
      rec = cur;
      if (code === 'STORE_BUSY') {
        cs.persistRun(caseId, runId, Object.assign({}, RELEASE, { next_attempt_at: null }), S.QUEUED, { reason: 'store_busy', run: runMeta('aborted', { errorCode: code }), now: t, leaseOwner });
        return done('aborted', S.QUEUED, { code });
      }
      const attempts = (cur.attempts || 0) + 1;
      if (attempts >= LIMITS.maxAttempts && heldReview) {
        // A held review case is not failed out of the review queue: back to NEEDS_REVIEW with its code.
        cs.persistRun(caseId, runId, Object.assign({}, RELEASE, { attempts, last_error_code: code, ai_retry_at: t + _jitter(HOUR, rand) }), S.NEEDS_REVIEW,
          { reason: heldReview, run: runMeta('failed', { errorCode: code }), event: { kind: 'error', reason: code, detail: { attempts } }, now: t, leaseOwner });
        try { job.fail(e); } catch (_) {}
        return done('failed', S.NEEDS_REVIEW, { code });
      }
      if (attempts >= LIMITS.maxAttempts) {
        cs.persistRun(caseId, runId, Object.assign({}, RELEASE, { attempts, last_error_code: code }), S.FAILED,
          { reason: code, run: runMeta('failed', { errorCode: code }), event: { kind: 'error', reason: code, detail: { attempts } }, now: t, leaseOwner });
        try { job.fail(e); } catch (_) {}
        return done('failed', S.FAILED, { code });
      }
      const mins = LIMITS.retryBackoffMin[Math.min(attempts - 1, LIMITS.retryBackoffMin.length - 1)];
      cs.persistRun(caseId, runId, Object.assign({}, RELEASE, { attempts, last_error_code: code, next_attempt_at: t + _jitter(mins * MIN, rand) }), S.QUEUED,
        { reason: 'retry', run: runMeta('failed', { errorCode: code }), event: { kind: 'error', reason: code, detail: { attempts } }, now: t, leaseOwner });
      try { job.fail(e); } catch (_) {}
      return done('failed', S.QUEUED, { code });
    } catch (e2) {
      if (_isLeaseLost(e2)) return _onLeaseLost(e2);
      try { cs.appendEvent({ caseId, at: t, kind: 'error', reason: _codeOf(e2), runId, detail: { first: code } }); } catch (_) {}
      try { log.error(rec.unit_id + ' run could not be persisted: ' + _codeOf(e2)); } catch (_) {}
      return { ok: false, caseId, runId, code, outcome: 'failed' };
    }
  }
}

function _isLeaseLost(e) { const c = e && e.code; return c === 'LEASE_LOST' || c === 'STEP_EXISTS'; }
function _nonDerived(it) { return !!it && it.trust !== 'derived_ai' && it.trust !== 'prior_conclusion'; }
/** Base items, then tool items not already present (by evidenceId). */
function _mergeItems(base, ...lists) {
  const out = (base || []).slice();
  const ids = new Set(out.map((it) => it && it.evidenceId).filter(Boolean));
  for (const list of lists) {
    for (const it of list || []) {
      if (!it || (it.evidenceId && ids.has(it.evidenceId))) continue;
      if (it.evidenceId) ids.add(it.evidenceId);
      out.push(it);
    }
  }
  return out;
}

module.exports = { runInvestigation, requiredSourceUnusable, aiBusy, nextReviewAt, retryAtFor, LEASE_MS, AI_TIMEOUT_MS };
