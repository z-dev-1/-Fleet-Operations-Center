'use strict';
/**
 * autopilot/harness.js — the in-app shadow acceptance harness (§B17, plan R5, R14).
 *
 * run(opts) -> Promise<{ ok:true, reportPath, summary } | { ok:false, code }>
 *
 * opts (injected by index.js; this file requires neither ./investigate nor ./controller, R5):
 *   runs               20..30 (default 24)
 *   runInvestigation   investigate.runInvestigation
 *   controller         { withMutex, isRunning, ensureSchema, ports(), limiter, owner }
 *   caseStore, config (effective), now(), rand(), reason, supervisorEnabled()
 *
 * Rules:
 *   - DISABLED / SUPERVISOR_DISABLED / NOT_RUNNING are answered before any ap_* SQL.
 *   - The shared mutex is held for the whole run (BUSY while a tick runs).
 *   - At most once per local day (ap_meta 'harness:<date>' -> HARNESS_ALREADY_RAN).
 *   - Runs the real open cases round-robin with trigger 'harness' and normal transitions,
 *     over a stratified sample (V2 §12.4: (domicile, operator) groups, stratifiedSample()); the
 *     report adds byDomicile / byOperator run counts and the latest coverage pass.
 *     PAUSED and NEEDS_REVIEW cases are not re-run.
 *   - The run's AbortController is the controller's in-flight one (beginExternalRun), so PAUSE,
 *     STOP, master OFF and shutdown abort the current run and stop the loop; settings are
 *     re-read before every run (master OFF / runState / liveReads take effect at the next run). Harness runs are neither limited by nor charged to the
 *     automatic 30-min / 6-per-day limits.
 *   - AI calls count against dailyCap inside runInvestigation (reserveAiCallAndMarkPending);
 *     once the cap is reached the remaining runs use the deterministic fallback.
 *   - Every per-source bucket and every gate applies; the whole harness counts as one tick
 *     for the per-tick live-call cap (limiter.beginTick() once).
 *   - Reads the outbound stores before and after (relay writes, FAS approvals, email-intel
 *     sends, Slack DM replies) and records heap / RSS before and after.
 *   - Writes exactly one file: autopilot-harness-<ISO>.json directly under paths.dataDir.
 *     It never enables writes and never sends anything.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('../config/paths');
const { STATES: S, localDate, normUnit } = require('./constants');
const { buildScope, unitsNotInFleet } = require('./scope');

const RUNS = Object.freeze({ min: 20, max: 30, dflt: 24 });
const REPORT_PREFIX = 'autopilot-harness-';

// Outbound queues and send logs (file names of the store REGISTRY entries). Read only.
const OUTBOUND_FILES = Object.freeze({
  relayWritesPending: 'relay_writes_pending.json',
  fasApprovalQueue: 'fas_approval_queue.json',
  emailIntelSends: 'email_intel_sends.json',
  slackDMReplies: 'slack_dm_replies.json',
});

// Not re-run by the harness: terminal, paused by the user / scope / feature, in flight, or
// waiting for a human accept (NEEDS_REVIEW leaves only through review()).
const SKIP_STATES = new Set([S.RESOLVED, S.PAUSED, S.INVESTIGATING, S.ANALYZING, S.NEEDS_REVIEW]);
const DOC_KEYS = Object.freeze(['fleetData', 'canonicalState', 'longDwellStore', 'longDwellCsv', 'relayReconcileConfig', 'decisivCaseCache', 'emailEvidence', 'fasCases']);

function _mb(n) { return Math.round((n / 1048576) * 10) / 10; }
function _staleDays(doc) {
  const n = Number(doc && doc.staleDays);
  return Number.isFinite(n) ? Math.min(30, Math.max(1, Math.round(n))) : 3;
}

/** { key: { bytes, sha1 } | null } for every outbound store file under dir (read only). */
function snapshotOutbound(dir) {
  const base = dir || paths.getDataDir();
  const out = {};
  for (const k of Object.keys(OUTBOUND_FILES)) {
    let buf = null;
    try { buf = fs.readFileSync(path.join(base, OUTBOUND_FILES[k])); } catch (_) { buf = null; }
    out[k] = buf ? { bytes: buf.length, sha1: crypto.createHash('sha1').update(buf).digest('hex') } : null;
  }
  return out;
}

function _sourceStatus(sourceCalls) {
  const out = {};
  const sc = sourceCalls && typeof sourceCalls === 'object' ? sourceCalls : {};
  for (const k of Object.keys(sc)) out[k] = sc[k] && sc[k].status != null ? sc[k].status : null;
  return out;
}

function _codes(reasons) { return (Array.isArray(reasons) ? reasons : []).map((r) => (r && typeof r === 'object' ? r.code : r)).filter(Boolean); }

function _byPriority(a, b) {
  return ((b.priority || 0) - (a.priority || 0)) || ((a.created_at || 0) - (b.created_at || 0)) || (a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : 0);
}
function _groupKey(c) { return (c.domicile || '(none)') + '|' + (c.operator || '(none)'); }

/**
 * stratifiedSample(cases, runs) -> [case] (V2 §12.4): up to `runs` distinct cases, round-robin over
 * the (domicile, operator) groups sorted by size desc (then key), at most ceil(runs / groups) per
 * group and by priority inside a group; the remaining slots are filled by priority.
 */
function stratifiedSample(cases, runs) {
  const list = Array.isArray(cases) ? cases.filter((c) => c && c.case_id) : [];
  const n = Math.min(list.length, Math.max(0, runs | 0));
  if (!n) return [];
  const groups = new Map();
  for (const c of list) {
    const k = _groupKey(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const ordered = [...groups.entries()].sort((a, b) => (b[1].length - a[1].length) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e[1].sort(_byPriority));
  const perGroup = Math.ceil(runs / ordered.length);
  const out = [];
  const taken = new Set();
  for (let round = 0; round < perGroup && out.length < n; round++) {
    for (const g of ordered) {
      if (out.length >= n) break;
      if (round < g.length) { out.push(g[round]); taken.add(g[round].case_id); }
    }
  }
  for (const c of list.slice().sort(_byPriority)) {
    if (out.length >= n) break;
    if (!taken.has(c.case_id)) { out.push(c); taken.add(c.case_id); }
  }
  return out;
}
function _countBy(entries, key) {
  const out = {};
  for (const e of entries) { const k = e[key] || '(none)'; out[k] = (out[k] || 0) + 1; }
  return out;
}

async function run(opts) {
  const o = opts || {};
  const cfg = o.config || {};
  if (!cfg.enabled) return { ok: false, code: 'DISABLED' };
  if (typeof o.supervisorEnabled === 'function' && !o.supervisorEnabled()) return { ok: false, code: 'SUPERVISOR_DISABLED' };
  if (cfg.runState !== 'running') return { ok: false, code: 'NOT_RUNNING' };
  const runs = o.runs === undefined ? RUNS.dflt : o.runs;
  if (!Number.isInteger(runs) || runs < RUNS.min || runs > RUNS.max) return { ok: false, code: 'INVALID_INPUT', field: 'runs' };
  const ctl = o.controller;
  const cs = o.caseStore;
  const runInvestigation = o.runInvestigation;
  if (!ctl || typeof ctl.withMutex !== 'function' || !cs || typeof runInvestigation !== 'function') return { ok: false, code: 'UNAVAILABLE' };
  const clock = typeof o.now === 'function' ? o.now : Date.now;

  return ctl.withMutex(async () => {
    if (!ctl.ensureSchema()) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
    const t0 = clock();
    const date = localDate(t0);
    if (cs.getMeta('harness:' + date)) return { ok: false, code: 'HARNESS_ALREADY_RAN' };
    const startedAt = new Date(t0).toISOString();
    cs.setMeta('harness:' + date, startedAt);

    const ports = ctl.ports();
    const limiter = ctl.limiter || null;
    const docs = {};
    for (const k of DOC_KEYS) { try { docs[k] = ports.readStore(k); } catch (_) { docs[k] = null; } }
    const fleet = docs.fleetData && typeof docs.fleetData === 'object' ? docs.fleetData : {};
    const rows = Array.isArray(fleet.rows) ? fleet.rows : [];
    const ff = ports.fleetFreshness(t0);
    const staleDays = _staleDays(docs.relayReconcileConfig);
    if (limiter && typeof limiter.beginTick === 'function') limiter.beginTick();

    const outboundBefore = snapshotOutbound();
    const mem0 = process.memoryUsage();
    const aiKey = 'ai_calls:' + date;
    const aiBefore = parseInt(cs.getMeta(aiKey) || '0', 10) || 0;
    cs.appendEvent({ caseId: null, at: t0, kind: 'harness', actor: 'user', reason: 'harness_start', detail: { runs } });

    // The controller's in-flight AbortController: PAUSE / STOP / master OFF / shutdown abort the
    // harness like a tick. Settings are re-read before every run (also refreshes the liveReads gate).
    const ext = typeof ctl.beginExternalRun === 'function' ? ctl.beginExternalRun() : null;
    const signal = ext ? ext.signal : new AbortController().signal;
    const reload = () => {
      if (ext) return ext.refreshConfig();
      return typeof o.loadConfig === 'function' ? o.loadConfig() : cfg;
    };
    const entries = [];
    const perCase = new Map();
    let skipped = 0;
    let stoppedBy = null;
    let k = 0;
    // Stratified sample of distinct open cases (§12.4), re-run round-robin until `runs` runs are done.
    const sample = stratifiedSample(cs.listOpen().filter((c) => !SKIP_STATES.has(c.state)), runs);
    const caseMeta = new Map(sample.map((c) => [c.case_id, { domicile: c.domicile || null, operator: c.operator || null }]));
    try {
      for (let i = 0; i < runs; i++) {
        if (signal.aborted) { stoppedBy = 'aborted:' + (typeof signal.reason === 'string' ? signal.reason : 'shutdown'); break; }
        const runCfg = reload() || cfg;
        if (!runCfg.enabled) { stoppedBy = 'disabled'; break; }
        if (runCfg.runState !== 'running') { stoppedBy = 'run_state:' + runCfg.runState; break; }
        const eligibleNow = new Map(cs.listOpen().filter((x) => !SKIP_STATES.has(x.state)).map((x) => [x.case_id, x]));
        let c = null;
        for (let j = 0; j < sample.length && !c; j++) {
          const s = sample[(k + j) % sample.length];
          if (eligibleNow.has(s.case_id)) { c = eligibleNow.get(s.case_id); k = k + j + 1; }
        }
        if (!c) break;
        const now = clock();
        if (c.state !== S.QUEUED && !cs.requeueCases({ caseIds: [c.case_id], trigger: 'harness', actor: 'user', now }).length) { skipped++; continue; }
        const cpu0 = process.cpuUsage();
        let r;
        try {
          r = await runInvestigation(c.case_id, {
            ports, limiter, cfg: runCfg, signal, trigger: 'harness', owner: ctl.owner, now: clock, rand: o.rand,
            caseStore: cs, reason: o.reason, fleet: { doc: fleet, ff }, docs, staleDays,
          });
        } catch (e) {
          r = { ok: false, caseId: c.case_id, code: (e && e.code) || 'INTERNAL' };
        }
        const cpu = process.cpuUsage(cpu0);
        const runRow = r && r.runId && typeof cs.getRun === 'function' ? cs.getRun(r.runId) : null;
        const meta = caseMeta.get(c.case_id) || {};
        entries.push({
          caseId: c.case_id,
          unit: c.unit_id,
          domicile: meta.domicile || null,
          operator: meta.operator || null,
          reasons: _codes(c.reasons),
          plan: runRow && Array.isArray(runRow.plan) ? runRow.plan.map((p) => ({ source: p.source, status: p.status, why: p.why })) : null,
          sourceStatus: _sourceStatus(runRow ? runRow.source_calls : null),
          state: (r && r.state) || null,
          outcome: (r && r.outcome) || null,
          code: r && r.ok === false ? r.code || null : null,
          aiStatus: (r && r.aiStatus) || null,
          isolated: r && r.isolated != null ? !!r.isolated : null,
          validationWarnings: r && Array.isArray(r.warnings) ? r.warnings.slice(0, 20) : [],
          latencyMs: runRow && Number.isFinite(runRow.duration_ms) ? runRow.duration_ms : clock() - now,
          cpuMs: runRow && Number.isFinite(runRow.cpu_ms) ? runRow.cpu_ms : Math.round((cpu.user + cpu.system) / 1000),
        });
        const pc = perCase.get(c.case_id) || { caseId: c.case_id, unit: c.unit_id, runs: 0 };
        pc.runs++;
        perCase.set(c.case_id, pc);
        if (r && r.outcome === 'aborted') { stoppedBy = 'aborted:' + (r.abortReason || 'shutdown'); break; }
      }
    } finally {
      if (ext) ext.end();
    }

    const outboundAfter = snapshotOutbound();
    const mem1 = process.memoryUsage();
    const aiAfter = parseInt(cs.getMeta(aiKey) || '0', 10) || 0;
    const cap = Number.isFinite(cfg.dailyCap) ? cfg.dailyCap : null;
    const outboundUnchanged = JSON.stringify(outboundBefore) === JSON.stringify(outboundAfter);
    const notInFleet = unitsNotInFleet(buildScope(cfg), rows);
    const t1 = clock();
    const iso = new Date(t1).toISOString();
    const report = {
      kind: 'autopilot-harness',
      version: 1,
      mode: 'in-app',
      note: 'Shadow mode: real open cases were re-run with trigger harness and normal state transitions. Nothing was sent or written outside Autopilot.',
      startedAt, endedAt: iso, date,
      runsRequested: runs, runsDone: entries.length, skipped, stoppedBy,
      cases: [...perCase.values()],
      runs: entries,
      outboundBefore, outboundAfter, outboundUnchanged,
      heapUsedMbBefore: _mb(mem0.heapUsed), heapUsedMbAfter: _mb(mem1.heapUsed),
      rssMbBefore: _mb(mem0.rss), rssMbAfter: _mb(mem1.rss),
      heapDeltaMb: _mb(mem1.heapUsed - mem0.heapUsed),
      aiCallsUsed: aiAfter - aiBefore, aiCallsToday: aiAfter, aiCap: cap,
      capReached: entries.some((e) => e.aiStatus === 'skipped_cap') || (cap != null && aiAfter >= cap),
      unitsNotInFleet: notInFleet.map(normUnit),
      sampleSize: sample.length,
      byDomicile: _countBy(entries, 'domicile'),
      byOperator: _countBy(entries, 'operator'),
      coverage: (() => {
        if (typeof cs.coverage !== 'function') return null;
        try { const cv = cs.coverage(t1); return { pass: cv.pass, reconcileOk: cv.reconcileOk }; } catch (_) { return null; }
      })(),
    };
    const reportPath = path.join(paths.getDataDir(), REPORT_PREFIX + iso.replace(/[:.]/g, '-') + '.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    cs.appendEvent({ caseId: null, at: t1, kind: 'harness', actor: 'user', reason: 'harness_done', detail: { runs: entries.length, outboundUnchanged } });

    const byState = {};
    const byAiStatus = {};
    for (const e of entries) {
      byState[e.state || 'none'] = (byState[e.state || 'none'] || 0) + 1;
      byAiStatus[e.aiStatus || 'none'] = (byAiStatus[e.aiStatus || 'none'] || 0) + 1;
    }
    return {
      ok: true,
      reportPath,
      summary: {
        runsDone: report.runsDone, cases: report.cases.length, stoppedBy, byState, byAiStatus, outboundUnchanged,
        aiCallsUsed: report.aiCallsUsed, capReached: report.capReached, heapDeltaMb: report.heapDeltaMb,
        unitsNotInFleet: report.unitsNotInFleet,
      },
    };
  });
}

module.exports = { run, snapshotOutbound, stratifiedSample, OUTBOUND_FILES, REPORT_PREFIX, RUNS };
