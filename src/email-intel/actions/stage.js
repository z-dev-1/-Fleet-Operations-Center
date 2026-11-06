'use strict';
/**
 * email-intel/actions/stage.js — pipeline stage 9 (design 5, 8.2): question states, action items, notifications.
 *
 *   runActionStage(o) -> stats    after the fact stage of a scan (actionsView effective)
 *   refresh({ now })  -> { changed }   cheap re-check on emailIntel:get-actions (no AI): snoozes that ended,
 *                                      review items whose staged item was decided, overdue follow-ups
 *
 * Conversations derived by a scan: the ones touched or analyzed by the scan, every conversation with an open
 * staged item or a live review item, and on the first run with the view on, every conversation in the ledger.
 * One derivation failing skips that conversation only. The resolution pass (questions.js) makes at most ONE
 * isolated-lane call per conversation and only while the scan AI budget lasts. A failed actions store write
 * leaves the previous items intact and is reported to the scan as a store error.
 */
const stores = require('../stores');
const ledger = require('../ingest/ledger');
const Q = require('./questions');
const D = require('./derive');
const S = require('./store');
const N = require('./notify');
const { rid, errName } = require('../redact');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

function _openStaged() {
  try { return Object.values(require('../facts/staged').load().items || {}).filter((s) => s.state === 'open'); } catch (_) { return []; }
}
function _stagedState() {
  try { const items = require('../facts/staged').load().items || {}; return (id) => (items[id] ? items[id].state : null); } catch (_) { return () => null; }
}
function _applied() {
  try { return Object.values(stores.load('ledger').entries || {}).filter((e) => e.state === 'applied'); } catch (_) { return []; }
}

function _push(payload) {
  try {
    const wins = require('electron').BrowserWindow.getAllWindows();
    const main = wins.find((w) => !w.isDestroyed() && w.webContents.getURL().includes('localhost:5173'));
    if (main) main.webContents.send('emailIntel:updated', payload);
  } catch (_) { /* push only */ }
}

const _of = (ck) => (x) => (x.provenance ? x.provenance.conversationKey : x.conversationKey) === ck;

/**
 * runActionStage({ msgDoc, conversations:Set, ask(prompt), aiBudget, laneOk, signal, deadlineAt, now, osNotify, push, scanId })
 */
async function runActionStage(o) {
  const opts = o || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const msgDoc = ledger.ensureDoc(opts.msgDoc || stores.load('messages'));
  const prev = S.load();
  const staged = _openStaged();
  const applied = _applied();
  const convs = new Set(opts.conversations || []);
  for (const s of staged) if (s.provenance && s.provenance.conversationKey) convs.add(s.provenance.conversationKey);
  for (const x of Object.values(prev.items)) if (x.category === 'review' && S.LIVE.has(x.state)) convs.add(x.conversationKey);
  if (!prev.bootstrapped) for (const ck of Object.keys(msgDoc.byConv || {})) convs.add(ck);

  let budget = Math.max(0, Math.floor(Number(opts.aiBudget) || 0));
  const stats = { conversations: 0, created: 0, resolved: 0, escalated: 0, errors: 0, aiCalls: 0, notified: 0, open: 0 };
  const per = [];
  for (const ck of convs) {
    const records = ledger.conversation(msgDoc, ck);
    if (!records.length) continue;
    try {
      let qs = Q.buildQuestions(records, prev.questions, { now });
      const stopped = (opts.signal && opts.signal.aborted) || (Number.isFinite(opts.deadlineAt) && Date.now() >= opts.deadlineAt);
      if (budget > 0 && opts.laneOk && !stopped && typeof opts.ask === 'function' && Q.needsResolution(records, qs).length) {
        budget--; stats.aiCalls++;
        const rp = await Q.resolutionPass(records, qs, { ask: opts.ask, now });
        if (rp.called && rp.ok) qs = Q.buildQuestions(records, qs, { now });
      }
      const derived = D.deriveActions({ conversationKey: ck, records, questions: qs, staged: staged.filter(_of(ck)), applied: applied.filter(_of(ck)) }, { now });
      per.push({ ck, derived, qs });
    } catch (e) {
      stats.errors++;
      logger.warn('[email-intel] derive failed conv=' + rid(ck) + ' ' + errName(e));
    }
  }
  const r = S.update((doc) => {
    for (const p of per) {
      const m = S.mergeConversation(doc, p.ck, p.derived, { now, questions: p.qs });
      stats.created += m.created.length; stats.resolved += m.resolved.length; stats.escalated += m.escalated.length;
    }
    S.wake(doc, now);
    S.prune(doc, now);
    doc.bootstrapped = true;
    stats.open = S.openCount(doc);
  });
  stats.conversations = per.length;
  if (!r.ok) {
    logger.error('[email-intel] actions store write failed code=' + String(r.code || 'store'));
    return Object.assign(stats, { storeError: r.code || 'store' });
  }
  const n = N.notifyPending({ now, osNotify: opts.osNotify, push: typeof opts.push === 'function' ? opts.push : _push });
  stats.notified = n.notified;
  logger.info('[email-intel] actions id=' + String(opts.scanId || '-') + ' conversations=' + stats.conversations + ' created=' + stats.created + ' resolved=' + stats.resolved
    + ' escalated=' + stats.escalated + ' open=' + stats.open + ' notified=' + stats.notified + ' calls=' + stats.aiCalls + ' errors=' + stats.errors);
  return stats;
}

/** refresh({ now }) — no AI, writes only when something changed. */
function refresh(o) {
  const now = o && Number.isFinite(o.now) ? o.now : Date.now();
  const doc = S.load();
  const stateOf = _stagedState();
  const convs = new Set();
  for (const x of Object.values(doc.items)) {
    if (!S.LIVE.has(x.state)) continue;
    if (x.category === 'review' && (x.stagedIds || []).some((id) => stateOf(id) !== 'open')) convs.add(x.conversationKey);
  }
  const msgDoc = ledger.ensureDoc(stores.load('messages'));
  for (const rec of Object.values(msgDoc.messages)) {
    const res = rec.analysis && rec.analysis.result;
    if (res && (res.commitments || []).some((c) => c && c.dueDate)) convs.add(rec.conversationKey);
  }
  let changed = S.wake(doc, now) > 0;
  if (convs.size) {
    const staged = _openStaged();
    const applied = _applied();
    for (const ck of convs) {
      const records = ledger.conversation(msgDoc, ck);
      if (!records.length) continue;
      try {
        const qs = Q.buildQuestions(records, doc.questions, { now });
        const derived = D.deriveActions({ conversationKey: ck, records, questions: qs, staged: staged.filter(_of(ck)), applied: applied.filter(_of(ck)) }, { now });
        if (S.mergeConversation(doc, ck, derived, { now, questions: qs }).changed) changed = true;
      } catch (e) { logger.warn('[email-intel] refresh failed conv=' + rid(ck) + ' ' + errName(e)); }
    }
  }
  if (!changed) return { changed: false };
  const w = stores.save('actions', doc);
  return { changed: !!w.ok, code: w.ok ? undefined : w.code };
}

module.exports = { runActionStage, refresh };
