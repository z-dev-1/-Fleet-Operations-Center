'use strict';
/**
 * scrapers/relay_reconcile_apply.js — the ACTING layer for Relay ↔ Offsite reconcile.
 *
 * relay_reconcile.js only REASONS (produces a decision). This module acts on a
 * decision:
 *
 *   1. ALWAYS writes the synthesized current-status + next-step into the app's
 *      internal unit timeline (safe, local, reversible-by-edit). This keeps the
 *      in-app record current regardless of mode.
 *
 *   2. The Relay WR comment posts — the gap-fill (an Offsite update Relay is
 *      missing) and the dealer-ask (a stale-unit request) — are LIVE writes to
 *      AAP that colleagues will see, so they are gated:
 *        - MODE A (cfg.autoPostToRelay=true): post immediately via
 *          addConversationNote during sync. Hands-off.
 *        - MODE B (default): stage the post into relayReconcilePending for an
 *          explicit confirm in the UI before anything hits AAP.
 *
 * Dedup (relayReconcileLog): the same gap-fill / dealer-ask text is never
 * re-staged or re-posted on the next 5-min rescan — keyed per equipmentId by a
 * normalized text signature.
 *
 * Low-confidence guard: when the AI's confidence is below cfg.minConfidence, the
 * timeline still gets the status, but the Relay post is skipped/stays staged —
 * we never auto-post a shaky decision to a shared AAP record.
 */

const store = require('../store');
let logger; try { logger = require('../utils/logger')('relay-reconcile'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

function _today() {
  const d = new Date();
  return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
}

function _sig(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 160);
}

// ── Dedup ledger ────────────────────────────────────────────────────────────
function _loadLog() {
  const l = store.load('relayReconcileLog', null);
  return (l && typeof l === 'object') ? l : {};
}
function _saveLog(l) { store.save('relayReconcileLog', l); }

// Minimum gap between repeated dealer follow-ups (ms). A gap-fill is deduped on
// exact text; a dealer-ask (follow-up) is allowed to re-fire after this window
// even if the text is similar — chasing an update is supposed to repeat, with
// escalating wording — but never same-day.
function _reAskWindowMs(cfg) {
  const days = (cfg && cfg.staleDays) ? cfg.staleDays : 3;
  return Math.max(1, days) * 86400000;
}

// Already handled this gap/ask for this unit? gap-fill = exact-text dedup;
// dealer-ask = time-window dedup (don't re-chase within the re-ask window).
function _alreadyHandled(equipmentId, kind, text, cfg) {
  const l = _loadLog();
  const rec = l[equipmentId];
  if (!rec) return false;
  if (kind === 'gap-fill' || kind === 'dealer-ask') {
    if (kind === 'gap-fill') {
      const sig = _sig(text);
      if (!sig) return true;
      return rec.lastGapSig === sig;
    }
    // dealer-ask / follow-up: block only within the re-ask window.
    if (!rec.lastAskAt) return false;
    const age = Date.now() - Date.parse(rec.lastAskAt);
    return Number.isFinite(age) && age < _reAskWindowMs(cfg);
  }
  return false;
}

// Returns the escalating follow-up count for this unit's next dealer-ask
// (1 on the first ask, 2 on the next, ...). gap-fills don't escalate.
function _nextFollowUpCount(equipmentId) {
  const l = _loadLog();
  const rec = l[equipmentId];
  return ((rec && rec.followUpCount) || 0) + 1;
}

function _markHandled(equipmentId, kind, text, followUpCount) {
  const l = _loadLog();
  const rec = l[equipmentId] || {};
  if (kind === 'gap-fill') rec.lastGapSig = _sig(text);
  if (kind === 'dealer-ask') {
    rec.lastAskSig = _sig(text);
    rec.lastAskAt = new Date().toISOString();
    if (followUpCount) rec.followUpCount = followUpCount;
  }
  rec.lastAt = new Date().toISOString();
  l[equipmentId] = rec;
  _saveLog(l);
}

// Prefix a dealer-ask with an escalation marker once we're past the first ask,
// so repeated chases read like a human following up, not a bot repeating itself.
function _escalate(text, count) {
  const t = String(text || '').trim();
  if (!t) return t;
  if (count <= 1) return t;
  const ord = count === 2 ? '2nd' : count === 3 ? '3rd' : (count + 'th');
  return 'Follow-up #' + count + ' (' + ord + ' request) — ' + t;
}

// ── Pending staging queue (MODE B) ──────────────────────────────────────────
function loadPending() {
  const p = store.load('relayReconcilePending', null);
  return (p && Array.isArray(p.items)) ? p : { items: [] };
}
function _savePending(p) { store.save('relayReconcilePending', p); }

function _stage(decision, kind, text) {
  const p = loadPending();
  const item = {
    id: 'rr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    equipmentId: decision.equipmentId,
    serviceUrl: decision._serviceUrl || '',
    workRequestId: decision._workRequestId || '',
    kind, // 'gap-fill' | 'dealer-ask'
    text,
    vendor: decision.vendor || '',
    dealerName: decision.dealerName || '',
    offsiteUrl: decision.offsiteUrl || '',
    reasoning: decision.reasoning || '',
    confidence: decision.confidence,
    stagedAt: new Date().toISOString(),
    state: 'pending',
  };
  // Replace any existing pending item of the same kind for this unit (keep newest).
  p.items = p.items.filter((it) => !(it.equipmentId === item.equipmentId && it.kind === item.kind && it.state === 'pending'));
  p.items.unshift(item);
  if (p.items.length > 200) p.items = p.items.slice(0, 200);
  _savePending(p);
  _notifyRenderer(p);
  return item;
}

function _notifyRenderer(p) {
  try {
    const wins = require('electron').BrowserWindow.getAllWindows();
    const main = wins.find((w) => !w.isDestroyed() && w.webContents.getURL().includes('localhost:5173'));
    if (main) main.webContents.send('relayReconcile:updated', p || loadPending());
  } catch (_) {}
}

// ── Actual Relay WR comment post ────────────────────────────────────────────
async function _postToRelay(decision, text) {
  const target = decision._serviceUrl || decision._workRequestId;
  if (!target) return { ok: false, error: 'no Relay work-request target (serviceUrl/workRequestId) for ' + decision.equipmentId };
  try {
    const { addConversationNote } = require('./aap_create_wr');
    const r = await addConversationNote(target, text);
    return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'addComment failed' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Timeline write (always) ─────────────────────────────────────────────────
function _writeTimeline(decision) {
  const parts = [];
  if (decision.currentStatus) parts.push(decision.currentStatus);
  if (decision.nextStep) parts.push('Next: ' + decision.nextStep);
  const body = parts.join(' ').trim();
  if (!body) return;
  const line = _today() + ' - ' + body;
  try {
    require('./email_actions').applyUnitTimelineUpdate(decision.equipmentId, line);
  } catch (e) {
    logger.warn('[relay-reconcile] timeline write failed for ' + decision.equipmentId + ': ' + e.message);
  }
}

/**
 * applyReconcile(decision, opts) -> Promise<result>
 * opts: { cfg }
 * Always writes the synthesized status to the timeline. Then handles the two
 * possible Relay posts (gap-fill, dealer-ask) per MODE A/B + dedup + confidence.
 * Returns { equipmentId, timeline:true, posts:[{kind, action:'posted'|'staged'|'skipped'|'duplicate', error?}] }.
 */
async function applyReconcile(decision, opts) {
  opts = opts || {};
  const cfg = opts.cfg || require('./relay_reconcile').getConfig();
  const out = { equipmentId: decision && decision.equipmentId, timeline: false, posts: [] };
  if (!decision || !decision.equipmentId) return out;

  // 1) Always update the internal timeline.
  _writeTimeline(decision);
  out.timeline = true;

  // 2) Build the candidate Relay posts, routed by the next-action INTENT.
  //    - post_to_relay / gap-fill: an Offsite update Relay lacks -> internal note.
  //    - request_update: WE are waiting on the vendor -> a chase (escalating).
  //    - reply_to_vendor: the vendor asked US a question -> OUR answer; this is a
  //      judgment call, so it is ALWAYS confirm-gated (never auto-posted, even in
  //      MODE A). We only stage it when we actually have answer text.
  const intent = decision.nextActionType || '';
  const candidates = [];
  // The Relay-posted gap-fill is an INTERNAL note, so prefer the factual
  // relayNote (third-person status log) over the raw missingUpdate gap text, and
  // NEVER the vendor-facing dealerAsk. Post it when Relay lacks the latest OR
  // when we have a relayNote worth logging.
  const relayPostText = decision.relayNote || decision.missingUpdate;
  if (relayPostText && (!decision.relayHasLatest || decision.relayNote)) {
    candidates.push({ kind: 'gap-fill', text: relayPostText });
  }
  if (intent === 'reply_to_vendor') {
    // Only post a reply when we have concrete answer text; otherwise the open
    // question is surfaced in canonical state / Split View for a human to answer.
    if (decision.dealerAsk) {
      candidates.push({ kind: 'reply-to-vendor', text: decision.dealerAsk, forceStage: true });
    }
  } else {
    // request_update (or stale) -> escalating dealer chase.
    const wantFollowUp = (decision.followUpNeeded || decision.isStale) && decision.dealerAsk;
    if (wantFollowUp) {
      const count = _nextFollowUpCount(decision.equipmentId);
      candidates.push({ kind: 'dealer-ask', text: _escalate(decision.dealerAsk, count), followUpCount: count });
    }
  }

  const lowConfidence = Number(decision.confidence) < Number(cfg.minConfidence);

  for (const c of candidates) {
    // Dedup: gap-fill = exact text; dealer-ask/reply = re-ask window.
    const dedupKind = (c.kind === 'reply-to-vendor') ? 'dealer-ask' : c.kind;
    if (_alreadyHandled(decision.equipmentId, dedupKind, c.text, cfg)) {
      out.posts.push({ kind: c.kind, action: 'duplicate' });
      continue;
    }
    // A reply to a vendor question is a judgment call -> ALWAYS stage, never
    // auto-post, regardless of MODE A. Low-confidence decisions also never
    // auto-post (staged for review even in MODE A; timeline already has status).
    if (cfg.autoPostToRelay && !lowConfidence && !c.forceStage) {
      const r = await _postToRelay(decision, c.text);
      if (r.ok) {
        _markHandled(decision.equipmentId, dedupKind, c.text, c.followUpCount);
        out.posts.push({ kind: c.kind, action: 'posted' });
        logger.info('[relay-reconcile] MODE A posted ' + c.kind + ' to Relay for ' + decision.equipmentId);
      } else {
        out.posts.push({ kind: c.kind, action: 'skipped', error: r.error });
        logger.warn('[relay-reconcile] MODE A post failed for ' + decision.equipmentId + ': ' + r.error);
      }
    } else {
      // MODE B (or low-confidence, or a reply-to-vendor): stage for explicit confirm.
      _stage(decision, c.kind, c.text);
      _markHandled(decision.equipmentId, dedupKind, c.text, c.followUpCount);
      out.posts.push({ kind: c.kind, action: 'staged', reason: c.forceStage ? 'reply-needs-confirm' : undefined });
      logger.info('[relay-reconcile] staged ' + c.kind + ' for ' + decision.equipmentId + ' (confirm to post)');
    }
  }
  return out;
}

// ── Confirm / dismiss a staged post (MODE B) ────────────────────────────────
async function confirmPending(id) {
  const p = loadPending();
  const item = p.items.find((it) => it.id === id);
  if (!item) return { ok: false, error: 'pending item not found' };
  if (item.state !== 'pending') return { ok: false, error: 'item already ' + item.state };
  const r = await _postToRelay({ _serviceUrl: item.serviceUrl, _workRequestId: item.workRequestId, equipmentId: item.equipmentId }, item.text);
  if (r.ok) {
    item.state = 'posted';
    item.postedAt = new Date().toISOString();
    _savePending(p);
    _notifyRenderer(p);
    return { ok: true, message: 'Posted to Relay for ' + item.equipmentId };
  }
  return { ok: false, error: r.error };
}

function dismissPending(id) {
  const p = loadPending();
  const item = p.items.find((it) => it.id === id);
  if (!item) return { ok: false, error: 'pending item not found' };
  item.state = 'dismissed';
  item.dismissedAt = new Date().toISOString();
  _savePending(p);
  _notifyRenderer(p);
  return { ok: true };
}

module.exports = {
  applyReconcile,
  loadPending,
  confirmPending,
  dismissPending,
  // exported for tests / reuse
  _writeTimeline,
  _postToRelay,
  _alreadyHandled,
  _markHandled,
  _nextFollowUpCount,
  _escalate,
  _stage,
  _sig,
};
