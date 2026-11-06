'use strict';
/**
 * email-intel/understand/analyze.js — per-message analysis orchestration (design 3.9, 3.10; R1.3,
 * R2.6, R3.1, R4.1-R4.9, R7.6, R8.4, R8.8, NFR-9, F-16, F-17, F-26, AC-12).
 *
 *   analyzeMessage(record, ctx)        -> Analysis (stored as record.analysis by the caller)
 *   runScanAnalysis(doc, ctx, commit)  -> stats; analyzes every eligible message of a scan, commit(key, analysis) per message
 *   deterministicAnalysis(record, scan) -> the no-AI fallback (filenames never feed classification)
 *   isEligible(analysis, { laneAvailable }) / retryAnalysis(analysis) / conservativeDelete(records, opts)
 *   questionId(messageKey, text)
 *
 * Flow per message: F-26 old-block check (skipped-old, no AI) -> prescreen (skipped-cheap) -> reuse an
 * identical analyzed message of the same conversation (same contentHash and prompt version) -> windows
 * (at most MAX_WINDOWS, one isolated-lane call each, through the scan's AI queue) -> parse -> validate ->
 * merge -> determinations (ownership.js) -> per-fact effective confidence (confidence.js).
 *
 * Attempt accounting (F-16): only kind 'output' failures (unparseable / invalid JSON, or a timeout while
 * other calls in the same scan succeeded) count toward ANALYSIS_ATTEMPTS_MAX -> 'failed-permanent'.
 * Lane failures (unavailable, threw, empty, timeout while the lane fails for everyone) only bump the
 * diagnostic `laneFailures` and leave the message 'ai-unavailable'; it is re-queued automatically by the
 * first scan whose lane pre-check passes. With the lane pre-check failing, no AI call is made and
 * messages stay 'pending'. A message is retried only on a later scan (no in-scan retry loop).
 * Every failure path keeps the deterministic analysis and auto-applies nothing.
 */
const crypto = require('crypto');
const C = require('../constants');
const untrusted = require('../untrusted');
const scopeMod = require('./scope');
const { prescreen } = require('./prescreen');
const promptMod = require('./prompt');
const { validateAnalysis, norm } = require('./validate');
const conf = require('./confidence');
const own = require('./ownership');
const lane = require('./lane');
const { createQueue } = require('./ai-queue');
const vocab = require('../../scrapers/email_intel');

const DAY = 86_400_000;
const RANK = { none: 0, low: 1, medium: 2, high: 3 };
const ELIGIBLE = new Set(['pending', 'pending-reextract']);

function questionId(messageKey, text) {
  return 'pq_' + crypto.createHash('sha256').update(String(messageKey) + '|' + norm(text)).digest('hex').slice(0, 12);
}

function _prev(rec) { return (rec && rec.analysis) || {}; }
function _outputAttempts(a) { return Number.isFinite(a.outputAttempts) ? a.outputAttempts : (Number.isFinite(a.attempts) ? a.attempts : 0); }

/** Is this stored analysis due for (re)analysis in this scan? */
function isEligible(analysis, o) {
  const a = analysis || {};
  const s = String(a.status || 'pending');
  if (ELIGIBLE.has(s)) return true;
  if (s === 'ai-unavailable') return !!(o && o.laneAvailable);
  if (s === 'invalid') return _outputAttempts(a) < C.ANALYSIS_ATTEMPTS_MAX;
  return false;
}

/** "Retry analysis" (F-16): local state only, no token. Resets the output attempt count. */
function retryAnalysis(analysis) {
  return Object.assign({}, analysis || {}, { status: 'pending', outputAttempts: 0, attempts: 0, error: null });
}

/** Deterministic fallback: units from the full-body pass, no facts, classification without attachments. */
function deterministicAnalysis(rec, scan) {
  const body = String((rec && rec.body && rec.body.newContent) || '');
  const email = { subject: (rec && rec.subject) || '', bodyText: body, from: (rec && rec.from && rec.from.address) || '', attachments: [] };
  let category = 'unknown'; let intent = 'none';
  try { category = vocab.classifyCategory(email); intent = vocab.classifyIntent(email, category); } catch (_) { /* vocab only */ }
  return {
    units: ((scan && scan.all) || []).map((u) => ({ unit: u.id, scope: u.scope, mentions: (u.offsets || []).length + (u.inSubject ? 1 : 0) })),
    quotedOnly: ((scan && scan.quotedOnly) || []).map((u) => ({ unit: u.id, scope: u.scope })),
    hasQuestionMark: /\?/.test(body),
    classification: { category: vocab.isCategory(category) ? category : 'unknown', intent: vocab.isIntent(intent) ? intent : 'none' },
  };
}

function _determine(result, rec, scan, ctx) {
  return own.determine(result, rec, { me: ctx.me, mentions: scan.all, scopeOf: ctx.index.scopeOf, answered: ctx.answered, now: ctx.now });
}

function _base(rec, prev, extra) {
  return Object.assign({
    status: 'pending', attempts: _outputAttempts(prev), outputAttempts: _outputAttempts(prev), laneFailures: prev.laneFailures || 0,
    promptVersion: C.PROMPT_VERSION, analyzedAt: null, contentHash: rec.contentHash || null, result: null, validation: null,
    coverage: null, unprocessedUnits: [], reusedFrom: null, error: null,
  }, extra || {});
}

/** Attach stable question ids and per-fact effective confidence (caps listed for audit / review UI). */
function _decorate(result, rec) {
  for (const list of [result.questions, result.requests]) for (const q of list || []) q.id = questionId(rec.messageKey, q.text);
  const mctx = conf.messageCtx(rec, result);
  for (const u of result.units || []) {
    const dropped = (u.dropped || 0) > (u.proposed || 0) / 2;
    for (const f of u.facts || []) {
      const e = conf.effectiveConfidence(f, Object.assign({}, mctx, { unitDroppedMoreThanHalf: dropped }));
      f.effectiveConfidence = e.value;
      f.caps = e.caps.map((c) => c.reason);
    }
  }
  return result;
}

function _factKey(f) { return [f.kind, norm(f.item || ''), f.state, f.date || '', norm(f.value)].join('|'); }

function _sumCounts(a, b) {
  if (!a) return JSON.parse(JSON.stringify(b));
  for (const k of Object.keys(b)) {
    if (k === 'dropped') { for (const d of Object.keys(b.dropped)) a.dropped[d] = (a.dropped[d] || 0) + b.dropped[d]; } else if (typeof b[k] === 'number') a[k] = (a[k] || 0) + b[k];
  }
  return a;
}

/** Merge validated window results: facts by interim fact key, questions by normalized text. */
function mergeWindows(results) {
  const out = { schemaVersion: C.SCHEMA_VERSION, relevance: null, units: [], questions: [], requests: [], answers: [], commitments: [], classification: null, suggestDelete: null, overallConfidence: null, overallValid: true };
  const byUnit = new Map();
  const seen = { q: new Set(), r: new Set(), a: new Set(), c: new Set() };
  let counts = null;
  for (const { analysis: a, counts: cnt, window } of results) {
    counts = _sumCounts(counts, cnt);
    if (!out.relevance || RANK[a.relevance.level] > RANK[out.relevance.level]) out.relevance = a.relevance;
    if (!out.classification) out.classification = a.classification;
    if (!out.suggestDelete) out.suggestDelete = a.suggestDelete;
    if (!a.overallValid) out.overallValid = false;
    else if (out.overallConfidence == null || a.overallConfidence < out.overallConfidence) out.overallConfidence = a.overallConfidence;
    for (const u of a.units) {
      let e = byUnit.get(u.unit);
      if (!e) { e = { unit: u.unit, scope: u.scope, scopeUnknown: u.scopeUnknown, gist: u.gist, facts: [], proposed: 0, dropped: 0, keys: new Set() }; byUnit.set(u.unit, e); out.units.push(e); }
      if (!e.gist && u.gist) e.gist = u.gist;
      e.proposed += u.proposed; e.dropped += u.dropped;
      for (const f of u.facts) { const k = _factKey(f); if (e.keys.has(k)) continue; e.keys.add(k); e.facts.push(Object.assign({ window }, f)); }
    }
    for (const q of a.questions) { const k = norm(q.text); if (!seen.q.has(k)) { seen.q.add(k); out.questions.push(q); } }
    for (const q of a.requests) { const k = norm(q.text); if (!seen.r.has(k)) { seen.r.add(k); out.requests.push(q); } }
    for (const x of a.answers) { if (!seen.a.has(x.pqid)) { seen.a.add(x.pqid); out.answers.push(x); } }
    for (const x of a.commitments) { const k = norm(x.text); if (!seen.c.has(k)) { seen.c.add(k); out.commitments.push(x); } }
  }
  for (const u of out.units) delete u.keys;
  if (!out.overallValid) out.overallConfidence = null;
  return { result: out, counts };
}

/**
 * analyzeMessage(record, ctx)
 * ctx: { index, conv (records of the conversation, oldest first), queue, trigger, signal, me, now, cfg, canonicalFor,
 *        lookbackDays, latestKey, laneAvailable, scanState:{successes}, answered:Set, windowOpts }
 */
async function analyzeMessage(rec, ctx) {
  const c = ctx || {};
  const now = Number.isFinite(c.now) ? c.now : Date.now();
  const prev = _prev(rec);
  const scan = scopeMod.scanMessage(rec, c.index);
  const det = deterministicAnalysis(rec, scan);
  const cctx = Object.assign({}, c, { now });
  const conv = Array.isArray(c.conv) ? c.conv : [rec];
  // Units that occur only past the stored body cap (the text was not kept): always reported, never lost.
  const beyond = [];
  for (const k of (rec.body && rec.body.unitsBeyondCap) || []) {
    const dd = c.index.detail(k);
    if (dd.scope === 'in' || dd.scope === 'unknown') beyond.push({ unit: dd.unit, scope: dd.scope, reason: 'unprocessed-window' });
  }
  if (beyond.length) det.beyondCap = beyond.map((u) => ({ unit: u.unit, scope: u.scope }));
  const fin = (status, extra) => _base(rec, prev, Object.assign({ status, analyzedAt: new Date(now).toISOString(), deterministic: det, unprocessedUnits: beyond.slice() }, extra || {}));

  // F-26: blocks older than the lookback horizon are thread context only; unknown time only for the latest block.
  const t = Date.parse(rec.receivedAt || '');
  const horizon = now - (Number.isFinite(c.lookbackDays) ? c.lookbackDays : C.LOOKBACK_DAYS_DEFAULT) * DAY;
  if ((Number.isFinite(t) && t < horizon) || (!Number.isFinite(t) && c.latestKey && rec.messageKey !== c.latestKey)) {
    return fin('skipped-old', { determinations: _determine(null, rec, scan, cctx) });
  }

  const idx = conv.indexOf(rec);
  const earlier = idx > 0 ? conv.slice(0, idx) : conv.filter((r) => r !== rec && (Date.parse(r.receivedAt || '') || 0) <= (t || 0));
  const convOpen = earlier.some((r) => {
    const d = r.analysis && r.analysis.determinations;
    return !!d && d.actionOwnership.items.some((x) => x.state === 'open' && (x.owner === 'me' || x.owner === 'shared') && x.inScope);
  });
  const pre = prescreen(rec, scan, { openOnMyUnits: convOpen }, { me: c.me });
  const preInfo = { reason: pre.reason, priority: pre.priority, triggers: pre.triggers };
  if (!pre.aiNeeded) {
    return fin('skipped-cheap', { prescreen: preInfo, deterministic: Object.assign({}, det, { relevance: pre.deterministic.relevance, outOfScope: pre.deterministic.outOfScope, classification: Object.assign({}, det.classification, { category: pre.deterministic.category === 'noise' ? 'noise' : det.classification.category }) }), determinations: _determine(null, rec, scan, cctx) });
  }

  // Reuse: identical content already analyzed in this conversation (recipient-dependent fields recomputed).
  const twin = conv.find((r) => r !== rec && r.contentHash && r.contentHash === rec.contentHash && r.analysis && r.analysis.status === 'ok' && r.analysis.promptVersion === C.PROMPT_VERSION && r.analysis.result);
  if (twin) {
    const result = _decorate(JSON.parse(JSON.stringify(twin.analysis.result)), rec);
    return fin('ok', { prescreen: preInfo, result, validation: twin.analysis.validation, coverage: twin.analysis.coverage, unprocessedUnits: twin.analysis.unprocessedUnits || [], reusedFrom: twin.messageKey, determinations: _determine(result, rec, scan, cctx) });
  }

  if (!c.laneAvailable || !c.queue) return Object.assign(_base(rec, prev), { status: ELIGIBLE.has(prev.status) ? prev.status : 'pending', prescreen: preInfo, deterministic: det });

  // Windows over the stored new content (forwarded segments included); the subject goes with every window.
  const wins = promptMod.buildWindows(String((rec.body && rec.body.newContent) || ''), scan.body, c.windowOpts);
  const priorQuestions = [];
  for (const r of earlier) {
    const res = r.analysis && r.analysis.result;
    if (!res) continue;
    for (const q of res.questions || []) if (q.id && !(c.answered && c.answered.has(q.id))) priorQuestions.push({ pqid: q.id, text: q.text, addresseeKind: q.addressee && q.addressee.kind, askedAt: r.receivedAt || null });
  }
  const prior = priorQuestions.slice(-8);
  const lastEarlier = earlier[earlier.length - 1];
  const role = own.recipientRole(rec, c.me);
  const oneToOne = own.isOneToOne(rec, c.me);
  const ok = []; let outputFails = 0; let laneFails = 0; let dropped = 0;
  const failedWindows = new Set();
  for (const wi of wins.sent) {
    const w = wins.windows[wi];
    const ref = promptMod.messageRef(rec.messageKey, wi);
    const nonce = untrusted.newNonce();
    const prompt = promptMod.buildPrompt(rec, { index: wi, total: wins.windows.length, text: w.text, coverage: wins.coverage }, {
      messageRef: ref, recipientRole: role, me: c.me, candidates: scan.all, canonicalFor: c.canonicalFor, priorQuestions: prior,
      quotedHistory: lastEarlier && lastEarlier.body ? lastEarlier.body.newContent : '', now,
    }, nonce);
    const q = await c.queue.run(() => lane.askIsolated(prompt, { trigger: c.trigger, signal: c.signal }), { priority: pre.priority });
    if (!q.ok) { dropped++; failedWindows.add(wi); continue; }
    const r = q.value || { ok: false, kind: 'lane', error: 'threw' };
    if (!r.ok) {
      failedWindows.add(wi);
      const asOutput = r.error === 'timeout' && c.scanState && c.scanState.successes > 0;
      if (asOutput) outputFails++; else { laneFails++; lane.recordLaneFailure(now); }
      continue;
    }
    let parsed = null;
    try { parsed = require('../../orcha/reason').parseJson(r.text); } catch (_) { parsed = null; }
    const v = parsed ? validateAnalysis(parsed, {
      expectedRef: ref, candidateUnits: scan.all.map((u) => u.id), scopeOf: c.index.scopeOf, priorQuestionIds: prior.map((p) => p.pqid),
      text: 'Subject: ' + String(rec.subject || '') + '\n\n' + w.text, receivedAt: rec.receivedAt, now, me: c.me, oneToOne,
    }) : null;
    lane.recordSuccess(now);
    if (c.scanState) c.scanState.successes = (c.scanState.successes || 0) + 1;
    if (!v || !v.ok) { outputFails++; failedWindows.add(wi); continue; }
    ok.push({ analysis: v.analysis, counts: v.counts, window: wi });
  }

  const processed = ok.length + outputFails + laneFails;
  // Units whose every occurrence lies in a window that was not sent or not analyzed (AC-F marker).
  const okSet = new Set(ok.map((x) => x.window));
  const unprocessedUnits = scan.body.filter((u) => (u.scope === 'in' || u.scope === 'unknown') && u.offsets.length
    && u.offsets.every((o) => !wins.windows.some((w) => okSet.has(w.index) && o >= w.start && o < w.end)))
    .map((u) => ({ unit: u.id, scope: u.scope, reason: 'unprocessed-window' }));
  for (const b of beyond) if (!unprocessedUnits.some((u) => u.unit === b.unit)) unprocessedUnits.push(b);
  const fullChars = Math.max(wins.coverage.charsTotal, Number(rec.body && rec.body.newChars) || 0);
  const coverage = Object.assign({}, wins.coverage, { charsTotal: fullChars, storedTruncated: fullChars > wins.coverage.charsTotal, windowsAnalyzed: ok.length, windowsFailed: failedWindows.size });

  if (!processed) {
    // Every call was dropped by the queue (budget, deadline, abort, degraded lane): stays pending.
    return Object.assign(_base(rec, prev), { status: ELIGIBLE.has(prev.status) ? prev.status : 'pending', prescreen: preInfo, deterministic: det, error: 'not-run' });
  }
  if (!ok.length) {
    const outputAttempts = _outputAttempts(prev) + (outputFails ? 1 : 0);
    const status = outputFails ? (outputAttempts >= C.ANALYSIS_ATTEMPTS_MAX ? 'failed-permanent' : 'invalid') : 'ai-unavailable';
    return fin(status, { attempts: outputAttempts, outputAttempts, laneFailures: (prev.laneFailures || 0) + laneFails, prescreen: preInfo, coverage, unprocessedUnits, error: outputFails ? 'invalid-output' : 'lane', determinations: _determine(null, rec, scan, cctx) });
  }
  const merged = mergeWindows(ok);
  const result = _decorate(merged.result, rec);
  return fin('ok', {
    attempts: _outputAttempts(prev), outputAttempts: _outputAttempts(prev), laneFailures: (prev.laneFailures || 0) + laneFails,
    prescreen: preInfo, result, validation: merged.counts, coverage, unprocessedUnits, determinations: _determine(result, rec, scan, cctx),
  });
}

/** Question ids answered anywhere in the conversation. */
function answeredIn(records) {
  const s = new Set();
  for (const r of records || []) for (const a of ((r.analysis && r.analysis.result && r.analysis.result.answers) || [])) s.add(a.pqid);
  return s;
}

/**
 * runScanAnalysis(doc, ctx, commit) — analyze every eligible message, conversation by conversation in
 * priority order (messages oldest first so later replies see earlier questions). `commit(key, analysis)`
 * persists each result immediately (restart keeps finished work). Returns counts only.
 * ctx: { index, me, cfg, trigger, signal, deadlineAt, now, canonicalFor, lookbackDays, windowOpts, conversations? }
 */
async function runScanAnalysis(doc, ctx, commit) {
  const c = ctx || {};
  const now = Number.isFinite(c.now) ? c.now : Date.now();
  const convKeys = Array.isArray(c.conversations) ? c.conversations : Object.keys((doc && doc.byConv) || {});
  const stats = { eligible: 0, analyzed: 0, ok: 0, skippedCheap: 0, skippedOld: 0, aiUnavailable: 0, invalid: 0, failedPermanent: 0, pending: 0, reused: 0, aiCalls: 0, laneAvailable: null, laneState: lane.state().state, dropped: {} };
  const plan = [];
  let laneAvailable = null;
  for (const ck of convKeys) {
    const recs = ((doc.byConv && doc.byConv[ck]) || []).map((k) => doc.messages[k]).filter(Boolean);
    if (!recs.length) continue;
    const anyAi = recs.some((r) => String((r.analysis || {}).status) === 'ai-unavailable');
    if (anyAi && laneAvailable === null) laneAvailable = lane.beginScan({ now });
    const due = recs.filter((r) => isEligible(r.analysis, { laneAvailable: laneAvailable === true }));
    if (!due.length) continue;
    const latest = recs[recs.length - 1];
    let pri = 0;
    for (const r of due) pri = Math.max(pri, prescreen(r, scopeMod.scanMessage(r, c.index), {}, { me: c.me }).priority);
    plan.push({ ck, recs, due: new Set(due.map((r) => r.messageKey)), pri, t: Date.parse(latest.receivedAt || '') || Date.parse(latest.ingestedAt || '') || 0, latestKey: latest.messageKey });
  }
  if (!plan.length) { stats.laneState = lane.state().state; return stats; }                // NFR-9: nothing new, no AI call
  if (laneAvailable === null) laneAvailable = lane.beginScan({ now });
  stats.laneAvailable = laneAvailable;
  plan.sort((a, b) => (b.pri - a.pri) || (b.t - a.t));
  const cfg = c.cfg || {};
  const queue = createQueue({ concurrency: cfg.aiConcurrency, budget: cfg.caps && cfg.caps.aiCalls, signal: c.signal, deadlineAt: c.deadlineAt, laneState: () => lane.state().state, now: c.clock });
  const scanState = { successes: 0 };
  for (const p of plan) {
    if (c.signal && c.signal.aborted) break;
    for (const rec of p.recs) {
      if (!p.due.has(rec.messageKey)) continue;
      if (c.signal && c.signal.aborted) break;
      stats.eligible++;
      const a = await analyzeMessage(rec, Object.assign({}, c, { conv: p.recs, queue, laneAvailable, scanState, latestKey: p.latestKey, answered: answeredIn(p.recs), now }));
      rec.analysis = a;
      if (typeof commit === 'function') commit(rec.messageKey, a);
      if (a.status === 'pending' || a.status === 'pending-reextract') { stats.pending++; continue; }
      stats.analyzed++;
      if (a.reusedFrom) stats.reused++;
      const key = { ok: 'ok', 'skipped-cheap': 'skippedCheap', 'skipped-old': 'skippedOld', 'ai-unavailable': 'aiUnavailable', invalid: 'invalid', 'failed-permanent': 'failedPermanent' }[a.status];
      if (key) stats[key]++;
    }
    // Later answers close earlier questions: refresh the earlier determinations (no AI call).
    const answered = answeredIn(p.recs);
    if (answered.size) {
      for (const rec of p.recs) {
        const a = rec.analysis;
        if (!a || !a.result || !a.determinations) continue;
        const ids = [].concat(a.result.questions || [], a.result.requests || []).map((q) => q.id);
        if (!ids.some((id) => answered.has(id))) continue;
        const scan = scopeMod.scanMessage(rec, c.index);
        const upd = Object.assign({}, a, { determinations: _determine(a.result, rec, scan, Object.assign({}, c, { answered, now })) });
        rec.analysis = upd;
        if (typeof commit === 'function') commit(rec.messageKey, upd);
      }
    }
  }
  const qs = queue.stats();
  stats.aiCalls = qs.started; stats.dropped = qs.droppedBy; stats.laneState = lane.state().state;
  return stats;
}

/**
 * conservativeDelete(records, { openActions, cfg }) -> { suggested, reason } (R7.6)
 * Only when the AI suggested it with valid confidence at the threshold AND the conversation has no
 * in-scope or unknown-scope unit, no open action, no question / request / decision for me, a real
 * conversation id, and at most one message without a message-level id.
 */
function conservativeDelete(records, opts) {
  const o = opts || {};
  const recs = Array.isArray(records) ? records : [];
  const latest = recs[recs.length - 1];
  const no = (reason) => ({ suggested: false, reason });
  if (!latest || !latest.analysis || latest.analysis.status !== 'ok' || !latest.analysis.result) return no('not-analyzed');
  const sd = latest.analysis.result.suggestDelete || {};
  if (!sd.suggested || sd.confidenceValid !== true || !conf.meetsThreshold(sd.confidence, o.cfg)) return no('not-suggested');
  if (latest.convIdSource === 'derived' || !latest.convIdRaw) return no('no-conversation-id');
  if ((o.openActions || 0) > 0) return no('open-action');
  for (const r of recs) {
    const a = r.analysis || {};
    const units = (a.deterministic && a.deterministic.units) || [];
    if (units.some((u) => u.scope === 'in' || u.scope === 'unknown')) return no('fleet-relevant');
    if (a.result && (a.result.units || []).length) return no('fleet-relevant');
    const d = a.determinations;
    if (d && (d.replyRequirement.value !== 'none' || d.decisionRequirement.value !== 'none' || d.actionOwnership.items.some((x) => x.state === 'open' && (x.owner === 'me' || x.owner === 'shared' || x.owner === 'unknown')))) return no('question-to-me');
  }
  if (recs.filter((r) => r.messageIdSource !== 'owa-item').length > 1) return no('multi-message-without-ids');
  return { suggested: true, reason: 'ai-suggested' };
}

module.exports = { analyzeMessage, runScanAnalysis, deterministicAnalysis, isEligible, retryAnalysis, conservativeDelete, questionId, answeredIn, mergeWindows };
