'use strict';
/**
 * email-intel/understand/calibration.js — shared, pure helpers for the confidence calibration set
 * (design 3.7; R7.2, F-15). Used by tests/email-intel-calibration.test.js and by the manual
 * scripts/email-intel-record-calibration.js. No I/O, no AI calls here.
 *
 *   loadSet(json)                    -> { now, me, index, cases }
 *   recordFromCase(c, set)           -> a real MessageRecord (ledger.buildRecord, deterministic item id)
 *   casePrompt(c, set, nonce)        -> { prompt, ref, record }   window 1, exactly as analyze.js builds it
 *   evaluateRecording(c, rec, set)   -> { valid, autoApplied, wrong, invalidAutoApplied, clean, cleanReached, buckets }
 *
 * Synthetic cases only (PII-free, @example.test); they mirror real fleet mail patterns. "Auto-applied"
 * here means: validated, unit in scope, effective confidence >= the frozen threshold. Phase C adds
 * freshness / canonical checks on top, which can only stage more, never apply more.
 */
const ledger = require('../ingest/ledger');
const identity = require('../ingest/identity');
const scopeMod = require('./scope');
const promptMod = require('./prompt');
const { validateAnalysis } = require('./validate');
const conf = require('./confidence');
const own = require('./ownership');
const analyze = require('./analyze');

function loadSet(json) {
  const now = Date.parse(json.now);
  const index = scopeMod.buildScopeIndex({ now, fleetData: json.fleet });
  return { now, me: json.me, index, cases: json.cases || [] };
}

function recordFromCase(c, set) {
  const convId = 'cal-conv-' + c.id;
  const cap = {
    itemId: 'cal-' + c.id, conversationKey: identity.conversationKey(convId), convIdRaw: convId, convIdSource: 'owa', legacySeed: convId,
    folder: 'Inbox', from: c.from, to: c.to || [], cc: c.cc || [], toCount: (c.to || []).length, ccCount: (c.cc || []).length, recipientsKnown: true,
    subject: c.subject, receivedAt: c.receivedAt || new Date(set.now - 3_600_000).toISOString(), receivedAtQuality: 'exact', receivedAtPrecision: 'minute',
    receivedAtRaw: '', bodyText: c.body, textLen: c.body.length, bodyStatus: 'complete', bodySource: 'pane', attachments: [], flags: { unread: true },
  };
  return ledger.buildRecord(cap, ledger.emptyDoc(), { me: set.me, now: set.now, scanId: 'calibration' }).record;
}

function casePrompt(c, set, nonce) {
  const record = recordFromCase(c, set);
  const scan = scopeMod.scanMessage(record, set.index);
  const wins = promptMod.buildWindows(record.body.newContent, scan.body);
  const ref = promptMod.messageRef(record.messageKey, 0);
  const prompt = promptMod.buildPrompt(record, { index: 0, total: wins.windows.length, text: wins.windows[0].text, coverage: wins.coverage }, {
    messageRef: ref, recipientRole: own.recipientRole(record, set.me), me: set.me, candidates: scan.all, priorQuestions: [], now: set.now,
  }, nonce);
  return { prompt, ref, record, scan, windowText: wins.windows[0].text };
}

const BUCKETS = [[0, 0.5], [0.5, 0.75], [0.75, 0.9], [0.9, 1.0001]];

function _matches(f, unit, label) {
  return label.unit === unit && label.kind === f.kind && label.state === f.state && (!label.date || label.date === f.date);
}

function evaluateRecording(c, recording, set) {
  const { ref, record, scan, windowText } = casePrompt(c, set, '0000000000000000');
  let parsed = null;
  try { parsed = require('../../orcha/reason').parseJson(recording.rawText); } catch (_) { parsed = null; }
  const v = parsed ? validateAnalysis(parsed, {
    expectedRef: ref, candidateUnits: scan.all.map((u) => u.id), scopeOf: set.index.scopeOf, priorQuestionIds: [],
    text: 'Subject: ' + record.subject + '\n\n' + windowText, receivedAt: record.receivedAt, now: set.now, me: set.me, oneToOne: own.isOneToOne(record, set.me),
  }) : null;
  const labels = (c.labels && c.labels.facts) || [];
  const out = { valid: !!(v && v.ok), autoApplied: [], wrong: [], invalidAutoApplied: [], staged: 0, clean: labels.filter((l) => l.clean).length, cleanReached: 0, buckets: BUCKETS.map((b) => ({ range: b, n: 0, correct: 0 })) };
  if (!out.valid) return out;
  const merged = analyze.mergeWindows([{ analysis: v.analysis, counts: v.counts, window: 0 }]).result;
  const mctx = conf.messageCtx(record, merged);
  const reached = new Set();
  for (const u of merged.units) {
    const dropped = (u.dropped || 0) > (u.proposed || 0) / 2;
    for (const f of u.facts) {
      const e = conf.effectiveConfidence(f, Object.assign({}, mctx, { unitDroppedMoreThanHalf: dropped })).value;
      const label = labels.find((l) => _matches(f, u.unit, l));
      const correct = !!label && label.apply !== false;
      const b = out.buckets.find((x) => e >= x.range[0] && e < x.range[1]);
      if (b) { b.n++; if (correct) b.correct++; }
      const applies = u.scope === 'in' && conf.meetsThreshold(e);
      if (!applies) { out.staged++; continue; }
      const item = { unit: u.unit, kind: f.kind, state: f.state, effective: e };
      out.autoApplied.push(item);
      if (!correct) out.wrong.push(item);
      if (f.confidenceValid !== true || merged.overallValid !== true) out.invalidAutoApplied.push(item);
      if (label && label.clean) reached.add(labels.indexOf(label));
    }
  }
  out.cleanReached = reached.size;
  return out;
}

module.exports = { loadSet, recordFromCase, casePrompt, evaluateRecording, BUCKETS };
