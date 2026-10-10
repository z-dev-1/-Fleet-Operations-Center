'use strict';
/**
 * scrapers/relay_reconcile.js — Relay ↔ Offsite reconcile REASONING engine.
 *
 * The point of this module is DECISION-MAKING, not plumbing. For a down unit it
 * hands the AI everything known — the Relay Garage conversation (internal
 * visibility), the current repair timeline, and the Offsite vendor's own update
 * thread (asistNotes) — and asks it to REASON like a fleet coordinator:
 *
 *   - Does Relay already reflect the newest Offsite update?
 *   - What update exists in Offsite that is MISSING from Relay (the gap to fill)?
 *   - What is the real current status, synthesized across all sources?
 *   - What is the next step?
 *   - Is this genuinely stale (no fresh update anywhere past the threshold)?
 *   - If stale: what EXACT question should we ask the dealer, grounded in what
 *     we already know (so we never ask something already answered)?
 *
 * Relay Garage is the internal visibility surface, so the goal is to keep it
 * updated from the Offsite vendors as much as possible. This module produces the
 * decision; relay_reconcile_apply.js writes the synthesized status into the app
 * timeline (always) and posts the gap-fill / dealer-ask into the real Relay WR
 * comment — immediately (MODE A) or staged for confirm (MODE B).
 *
 * Grounding rule (hard): the AI may ONLY use the data provided. It must never
 * invent a part, date, ETC, price, or status not present in the inputs.
 */

const store = require('../store');
const relay = require('../orcha/relay');
let logger; try { logger = require('../utils/logger')('relay-reconcile'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const PROMPT_CAP = 55000; // stay under the ~60k claude-code prompt cap
const RELAY_BLOB_CAP = 6000; // chars of each long blob handed to the AI
const OFFSITE_BLOB_CAP = 6000;

// ── Config ────────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  enabled: false,          // master switch (reasoning runs during sync when on)
  autoPostToRelay: false,  // MODE A when true (auto-post to Relay WR during sync);
                           // MODE B when false (stage the post for an explicit confirm).
  staleDays: 3,            // no fresh update in this many days => stale => dealer-ask
  maxUnitsPerSync: 8,      // cap AI calls per sync so a sync never stalls on this
  minConfidence: 0.5,      // below this, stage/skip the Relay post (timeline still gets it)
};

function getConfig() {
  const cfg = store.load('relayReconcileConfig', null);
  if (!cfg || typeof cfg !== 'object') return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...cfg };
}

function saveConfig(patch) {
  const next = { ...getConfig(), ...(patch || {}) };
  next.enabled = !!next.enabled;
  next.autoPostToRelay = !!next.autoPostToRelay;
  const sd = parseInt(next.staleDays, 10);
  next.staleDays = Number.isFinite(sd) ? Math.max(1, Math.min(30, sd)) : DEFAULT_CONFIG.staleDays;
  const mu = parseInt(next.maxUnitsPerSync, 10);
  next.maxUnitsPerSync = Number.isFinite(mu) ? Math.max(1, Math.min(50, mu)) : DEFAULT_CONFIG.maxUnitsPerSync;
  const mc = parseFloat(next.minConfidence);
  next.minConfidence = Number.isFinite(mc) ? Math.max(0, Math.min(1, mc)) : DEFAULT_CONFIG.minConfidence;
  store.save('relayReconcileConfig', next);
  return next;
}

// ── Unit brief (the grounded facts the AI reasons over) ────────────────────────
// Builds a compact, labelled view of one unit's Relay + Offsite state.
function _unitBrief(row) {
  const r = row || {};
  const clip = (s, n) => String(s || '').trim().replace(/\u0000/g, '').slice(0, n);
  const relayConversation = clip(r.fullConversation, RELAY_BLOB_CAP);
  const offsiteNotes = clip(r.asistNotes, OFFSITE_BLOB_CAP);
  // ADDITIVE structured parse of the SAME blobs (blobs stay intact above). This
  // gives the AI an explicit, ordered who-said-what so it can tell who spoke
  // LAST and whether we already replied — instead of fuzzy-matching the blob.
  // Best-effort: [] when the parser can't split, and the blob is still passed
  // as fallback context. Never throws.
  let relayComments = [], offsiteComments = [];
  try {
    const cp = require('./convo_parse');
    relayComments = cp.parseConversation(relayConversation, { cap: 20 });
    offsiteComments = cp.parseConversation(offsiteNotes, { cap: 20 });
  } catch (_) { /* parser unavailable — blobs still carry the content */ }
  return {
    equipmentId: String(r.equipmentId || '').trim(),
    vendor: String(r.vendor || '').trim(),
    dealerName: String(r.dealerName || r.subVendor || '').trim(),
    lifecycleReason: String(r.lifecycleReason || '').trim(),
    serviceState: String(r.serviceState || '').trim(),
    completed: String(r.completed || '').trim(),
    workDuration: String(r.workDuration || '').trim(),
    cause: clip(r.cause, 500),
    correction: clip(r.correction, 500),
    issueSummary: clip(r.issueSummary, 500),
    // Relay internal comments (what the internal team currently sees).
    relayConversation,
    relayTimeline: clip(r.repairTimeline, 2500),
    // Offsite vendor update thread (the dealer's own notes/estimate/status).
    offsiteNotes,
    offsiteLabel: String(r.asistLabel || r.offsiteShopEvent || '').trim(),
    offsiteUrl: String(r.asistSrUrl || r.offsiteShopEventUrl || '').trim(),
    offsiteScrapedAt: String(r.asistScrapedAt || '').trim(),
    // Structured, ordered comments (additive; derived from the blobs above).
    relayComments,
    offsiteComments,
    // Keys used by the apply layer (not shown to the AI as "facts").
    _serviceUrl: String(r.serviceUrl || r.pageUrl || '').trim(),
    _workRequestId: String(r.workRequestId || '').trim(),
  };
}

// Does this unit even have anything to reconcile? (an offsite thread or a WR to
// post into). Units with no offsite data and no Relay WR are skipped entirely.
function hasReconcilableData(row) {
  const b = _unitBrief(row);
  const hasOffsite = !!(b.offsiteNotes || b.offsiteLabel || b.offsiteUrl);
  const canPost = !!(b._serviceUrl || b._workRequestId);
  return hasOffsite || canPost;
}

// Days since the offsite thread was last scraped (our best "freshness" proxy),
// falling back to workDuration (days down) when no scrape timestamp exists.
function _daysSinceOffsite(brief) {
  if (brief.offsiteScrapedAt) {
    const t = Date.parse(brief.offsiteScrapedAt);
    if (!Number.isNaN(t)) return Math.floor((Date.now() - t) / 86400000);
  }
  // Fallback: parse a leading number of days from workDuration ("12 days" / "12d").
  const m = String(brief.workDuration || '').match(/(\d+)\s*d/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

// ── Prompt ──────────────────────────────────────────────────────────────────
function buildReconcilePrompt(brief, cfg) {
  const lines = [];
  const hasOffsite = !!brief.offsiteNotes;
  lines.push('You are a fleet repair coordinator keeping an INTERNAL tracking system ("Relay Garage") up to date. ' +
    (hasOffsite
      ? 'This unit has an EXTERNAL vendor/dealer repair portal ("Offsite"). Compare what Relay already knows against the latest Offsite update, decide what is MISSING from Relay, and decide the next action.'
      : 'This unit is tracked ONLY in Relay (no external Offsite portal). Read the Relay conversation, figure out WHO sent the LAST comment (the vendor, or us/internal), and decide whether we are waiting on the vendor and should post a follow-up.') +
    ' Reason like a human coordinator — do not just summarize.');
  lines.push('');
  lines.push('Return STRICT JSON ONLY (no prose, no markdown), exactly this shape:');
  lines.push('{"relayHasLatest":true|false,"missingUpdate":"the specific NEW update present in Offsite but NOT yet in Relay — empty string if none or if no Offsite","currentStatus":"one-line real current status synthesized from ALL sources","nextStep":"the concrete next action","lastCommentBy":"vendor|us|unknown — who sent the most recent comment in the thread","lastCommentWhen":"the date of that last comment if shown, else empty","lastCommentGist":"a few words on what that last comment said","nextActionType":"reply_to_vendor|request_update|post_to_relay|none — SEE THE NEXT-ACTION RULE","awaitingReply":"when nextActionType=reply_to_vendor: the exact question the vendor asked us that still needs OUR answer — else empty","weOweReply":true|false,"threadOfRecord":"relay|offsite — which thread the live back-and-forth is happening in","isStale":true|false,"dealerAsk":"the EXACT message to post to the vendor — a chase for what we are waiting on (request_update) OR our answer to their question (reply_to_vendor) — grounded in what is already known; empty if none needed","confidence":0.0-1.0,"reasoning":"1-2 sentences","conflicts":[{"field":"status|eta|parts|location","positions":[{"source":"aap|relay|offsite","value":"what that source says"}],"resolution":"aap|relay|offsite — which source you trusted","reason":"why that source wins (e.g. fresher)"}],"statusChangeReason":"if the status appears to have CHANGED from the prior updates, the grounded reason — else empty string"}');
  lines.push('');
  lines.push('RULES:');
  lines.push('- Use ONLY the data below. NEVER invent a part, date, ETC, price, vendor, or status that is not present. If a field is blank, treat it as unknown.');
  lines.push('- WHO COMMENTED LAST: the Relay conversation is an oldest-first feed where each comment shows an author name and date. Identify the LAST (most recent) comment. lastCommentBy="vendor" if a dealer/vendor/technician wrote it (they gave an update), "us" if an internal/fleet/coordinator name wrote it (we asked or logged a note), "unknown" if you genuinely cannot tell. When unknown, do NOT guess a follow-up — lean on the staleness clock instead.');
  if (hasOffsite) {
    lines.push('- relayHasLatest=true ONLY if the Relay conversation/timeline already contains the newest substantive Offsite update. Otherwise false and put the missing content in missingUpdate.');
    lines.push('- missingUpdate = DEDUP WITH CONTEXT: a concise postable note of what Offsite has that Relay does NOT, written in past/factual tense. Do NOT repeat anything Relay already says. You MAY add a short connecting phrase for context (e.g. "Per dealer, further to the 10/08 tow: parts arrived 10/14, repair scheduled, ETC 10/16."). Empty if Relay is already current.');
  } else {
    lines.push('- No Offsite portal: set relayHasLatest=true and missingUpdate="" (there is nothing external to pull in). Focus on the follow-up decision below.');
  }
  lines.push('- isStale=true when there is no fresh substantive update within ~' + cfg.staleDays + ' days AND the unit is not completed. If the unit is completed/ready, isStale=false.');
  lines.push('- NEXT-ACTION (the most important decision): read the LAST exchange and classify what WE must do next. This is a back-and-forth, so track whether the last message was a QUESTION and whether it was already ANSWERED:');
  lines.push('    * reply_to_vendor — the vendor\'s LAST message asks US a question that we have NOT yet answered (e.g. "order normal or with freight?", "approve this estimate?"). We owe them an answer. Set weOweReply=true and put their exact open question in awaitingReply. dealerAsk = our answer ONLY if it is obvious from the data; if it is a judgment call (cost/approval), leave dealerAsk="" and just surface the question.');
  lines.push('    * request_update — WE sent the last message (we answered their question, or we asked them something), so the ball is in THEIR court and they owe US the next thing. dealerAsk = a chase for THAT specific thing. CRITICAL: do NOT re-ask or re-authorize what we already said. If we already told them "get us the freight estimate," the chase is "any update on that freight estimate / revised ETC?" — NOT "please advise whether to use freight" (we already advised). You are NEVER "awaiting our own guidance" — if we spoke last, we are waiting on them.');
  lines.push('    * post_to_relay — the only gap is that Offsite has an update Relay lacks (no open question either way); the action is to write that update into Relay internally. No vendor message needed (dealerAsk="").');
  lines.push('    * none — current/complete, or the vendor JUST updated us and nothing is owed yet.');
  lines.push('  threadOfRecord = where the live back-and-forth is (offsite if the exchange is in the Offsite portal, relay if in Relay). A reply/chase to the vendor must go to THAT thread.');
  lines.push('- dealerAsk / FOLLOW-UP: when you do produce a vendor message, make it specific — reference the known issue/vendor and the date of the relevant note — e.g. "Following up on the DEF pump repair — no update since our 10/3 note. Can you confirm current status and a revised ETC?". Do NOT ask for anything the thread already answered. If nextActionType=none set dealerAsk="".');
  lines.push('- CONFLICTS: only when two sources genuinely DISAGREE about the same fact (e.g. AAP lifecycle still says unavailable but Offsite says the repair is complete; or Relay shows an older ETC than Offsite). For each real disagreement add one conflicts[] entry listing each source\'s position, which source you trusted (resolution), and why (reason — usually "fresher"/"more specific"). If there is no genuine disagreement, return "conflicts":[]. NEVER invent a source that is not in the data below.');
  lines.push('- statusChangeReason: ONLY if the current status clearly moved from what the prior Relay/timeline updates showed (e.g. was awaiting parts, now ready). Give the grounded one-line reason. If no clear change, return "".');
  lines.push('- If the unit appears READY/COMPLETE, say so in currentStatus, set nextStep to pickup/close, isStale=false, dealerAsk="".');
  lines.push('');
  lines.push('UNIT ' + brief.equipmentId + ':');
  if (brief.vendor) lines.push('- Vendor: ' + brief.vendor + (brief.dealerName ? ' / dealer: ' + brief.dealerName : ''));
  if (brief.lifecycleReason) lines.push('- Down reason: ' + brief.lifecycleReason);
  if (brief.serviceState) lines.push('- Work order state: ' + brief.serviceState + (brief.completed ? ' (completed ' + brief.completed + ')' : ''));
  if (brief.workDuration) lines.push('- Down for: ' + brief.workDuration);
  if (brief.cause) lines.push('- Reason for repair (cause): ' + brief.cause);
  if (brief.correction) lines.push('- Work accomplished: ' + brief.correction);
  if (brief.issueSummary) lines.push('- Issue summary on file: ' + brief.issueSummary);
  const daysSince = _daysSinceOffsite(brief);
  if (daysSince !== null) lines.push('- Offsite last refreshed: ~' + daysSince + ' day(s) ago');
  // ── Structured LAST EXCHANGE (ground the who-spoke-last decision) ──────────
  // When the parser could split the thread, show the ordered recent comments
  // with explicit side (vendor/us) + date. This is the authoritative signal for
  // lastCommentBy / nextActionType — the AI should trust it over its own read of
  // the raw blob below. Shown for whichever thread(s) parsed.
  let cp = null; try { cp = require('./convo_parse'); } catch (_) {}
  const relayC = brief.relayComments || [];
  const offsiteC = brief.offsiteComments || [];
  if (cp && (relayC.length || offsiteC.length)) {
    lines.push('');
    lines.push('STRUCTURED LAST EXCHANGE (authoritative for who-spoke-last — trust this over the raw text):');
    const renderThread = (label, arr) => {
      if (!arr || !arr.length) return;
      lines.push('  ' + label + ' thread (oldest-first, last ' + Math.min(arr.length, 6) + ' shown):');
      for (const c of arr.slice(-6)) {
        lines.push('    [' + (c.side || 'unknown') + (c.date ? ' ' + c.date : '') + '] ' + String(c.text || '').slice(0, 300));
      }
      const last = cp.lastComment(arr);
      if (last) lines.push('    => LAST in ' + label + ': ' + (last.side || 'unknown') + (last.date ? ' on ' + last.date : '') + '.');
    };
    renderThread('OFFSITE', offsiteC);
    renderThread('RELAY', relayC);
    // The single most-recent comment across both threads (by position; offsite is
    // usually the live vendor exchange). Prefer offsite's last if present.
    const overallLast = cp.lastComment(offsiteC.length ? offsiteC : relayC);
    if (overallLast) {
      lines.push('  >>> MOST RECENT COMMENT OVERALL: ' + (overallLast.side || 'unknown') + (overallLast.date ? ' on ' + overallLast.date : '') + ': "' + String(overallLast.text || '').slice(0, 200) + '"');
      lines.push('  >>> If that side is "us", WE spoke last -> we are waiting on THEM; chase what we asked, do NOT re-ask. If "vendor", they spoke last -> we may owe a reply.');
    }
  }
  lines.push('');
  lines.push('RELAY (internal) — current conversation + timeline (RAW — fallback context):');
  lines.push(brief.relayConversation ? brief.relayConversation : '(no Relay comments on file)');
  if (brief.relayTimeline) { lines.push('--- Relay timeline ---'); lines.push(brief.relayTimeline); }
  lines.push('');
  lines.push('OFFSITE (vendor/dealer portal) — latest update thread' + (brief.offsiteLabel ? ' [' + brief.offsiteLabel + ']' : '') + ' (RAW — fallback context):');
  lines.push(brief.offsiteNotes ? brief.offsiteNotes : '(no Offsite update text captured)');
  return lines.join('\n');
}

function _parseJson(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) {}
  try { return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); } catch (_) {}
  return null;
}

// Normalize + sanity-bound a raw AI verdict into a trusted decision object.
function _normalizeDecision(brief, raw, cfg) {
  const v = raw || {};
  const str = (s, n) => String(s == null ? '' : s).trim().slice(0, n || 500);
  let conf = parseFloat(v.confidence);
  if (!Number.isFinite(conf)) conf = 0.5;
  conf = Math.max(0, Math.min(1, conf));
  const daysSince = _daysSinceOffsite(brief);
  // Deterministic staleness guard: trust the AI, but also never mark a
  // completed unit stale, and surface our own staleness signal to the apply layer.
  const completed = /complete|closed|ready|done|cancel/i.test(brief.serviceState + ' ' + brief.completed);
  let isStale = !!v.isStale && !completed;
  if (daysSince !== null && daysSince < cfg.staleDays) isStale = false;
  const missingUpdate = str(v.missingUpdate, 1500);
  let lastCommentBy = ['vendor', 'us', 'unknown'].includes(String(v.lastCommentBy)) ? v.lastCommentBy : 'unknown';
  // GROUND who-spoke-last in the structured parse when available: the parser's
  // ordered last comment is more reliable than the AI's read of a flat blob. If
  // the parser gave a definite side (vendor/us), trust it over the AI's guess.
  try {
    const cp = require('./convo_parse');
    const arr = (brief.offsiteComments && brief.offsiteComments.length) ? brief.offsiteComments : brief.relayComments;
    const last = cp.lastComment(arr || []);
    if (last && (last.side === 'vendor' || last.side === 'us')) lastCommentBy = last.side;
  } catch (_) { /* parser unavailable — keep the AI's value */ }

  // ── Next-action INTENT ──────────────────────────────────────────────────────
  // Classify what WE must do next, derived from the last exchange. Trust the
  // AI's call, but sanity-reconcile it with the deterministic signals so a
  // malformed verdict can't produce a nonsensical action.
  const ALLOWED_INTENTS = ['reply_to_vendor', 'request_update', 'post_to_relay', 'none'];
  let nextActionType = ALLOWED_INTENTS.includes(String(v.nextActionType)) ? v.nextActionType : '';
  const weOweReply = (nextActionType === 'reply_to_vendor') ? true : !!v.weOweReply;
  const awaitingReply = weOweReply ? str(v.awaitingReply, 600) : '';
  const threadOfRecord = (String(v.threadOfRecord) === 'offsite') ? 'offsite'
    : (String(v.threadOfRecord) === 'relay') ? 'relay'
    : (brief.offsiteNotes ? 'offsite' : 'relay'); // default to where a thread exists
  // Fall back / reconcile when the AI didn't give a usable intent:
  if (!nextActionType) {
    if (completed) nextActionType = 'none';
    else if (weOweReply) nextActionType = 'reply_to_vendor';
    else if (missingUpdate) nextActionType = 'post_to_relay';
    else if (isStale || lastCommentBy === 'us') nextActionType = 'request_update';
    else nextActionType = 'none';
  }
  // Completed units never carry an open action.
  if (completed) nextActionType = 'none';

  // followUpNeeded == do we owe the VENDOR a message? True for a reply we owe
  // them OR a chase we should send. post_to_relay/none are not vendor messages.
  const followUpNeeded = !completed && (nextActionType === 'reply_to_vendor' || nextActionType === 'request_update');
  // dealerAsk is the vendor-facing message (reply or chase). Empty for
  // post_to_relay/none. For reply_to_vendor it may legitimately be empty when the
  // answer is a judgment call — the open question is surfaced via awaitingReply.
  const dealerAsk = followUpNeeded ? str(v.dealerAsk, 1000) : '';
  return {
    equipmentId: brief.equipmentId,
    relayHasLatest: !!v.relayHasLatest,
    missingUpdate,
    currentStatus: str(v.currentStatus, 400),
    nextStep: str(v.nextStep, 400),
    lastCommentBy,
    lastCommentWhen: str(v.lastCommentWhen, 60),
    lastCommentGist: str(v.lastCommentGist, 200),
    nextActionType,
    awaitingReply,
    weOweReply,
    threadOfRecord,
    isStale,
    followUpNeeded,
    dealerAsk,
    confidence: conf,
    reasoning: str(v.reasoning, 500),
    // Audit fields for canonical state (optional; sanitized downstream by
    // canonical_state._normalizeConflicts). Pass the raw array/string through —
    // never throw if the AI omitted or malformed them.
    conflicts: Array.isArray(v.conflicts) ? v.conflicts : [],
    statusChangeReason: str(v.statusChangeReason, 300),
    daysSinceOffsite: daysSince,
    completed,
    decidedAt: new Date().toISOString(),
  };
}

// Deterministic fallback decision when the AI is unavailable (no fabrication —
// just flags staleness from the clock and leaves gap-fill to a human).
function _fallbackDecision(brief, cfg) {
  const daysSince = _daysSinceOffsite(brief);
  const completed = /complete|closed|ready|done|cancel/i.test(brief.serviceState + ' ' + brief.completed);
  const isStale = !completed && daysSince !== null && daysSince >= cfg.staleDays;
  return {
    equipmentId: brief.equipmentId,
    relayHasLatest: null,
    missingUpdate: '',
    currentStatus: '(AI unavailable) ' + (brief.serviceState || brief.lifecycleReason || 'status unknown'),
    nextStep: isStale ? 'Request an update from the dealer.' : '',
    lastCommentBy: 'unknown',
    lastCommentWhen: '',
    lastCommentGist: '',
    // No AI: we can only infer from the staleness clock. If stale, chase for an
    // update; otherwise do nothing. We can't detect an unanswered question
    // without the AI, so never guess reply_to_vendor here.
    nextActionType: isStale && !completed ? 'request_update' : 'none',
    awaitingReply: '',
    weOweReply: false,
    threadOfRecord: brief.offsiteNotes ? 'offsite' : 'relay',
    isStale,
    followUpNeeded: isStale,
    dealerAsk: isStale ? ('No recent update on ' + (brief.equipmentId) + (brief.vendor ? ' at ' + brief.vendor : '') + ' — can you confirm current repair status and ETC?') : '',
    confidence: 0,
    reasoning: 'AI unavailable; staleness inferred from last-refresh clock only.',
    conflicts: [],
    statusChangeReason: '',
    daysSinceOffsite: daysSince,
    completed,
    aiUnavailable: true,
    decidedAt: new Date().toISOString(),
  };
}

/**
 * reconcileUnit(row, opts) -> Promise<decision>
 * Pure reasoning for ONE unit. Does NOT write anything. opts: { signal, requestId, cfg }.
 */
async function reconcileUnit(row, opts) {
  opts = opts || {};
  const cfg = opts.cfg || getConfig();
  const brief = _unitBrief(row);
  if (!brief.equipmentId) return null;
  const prompt = buildReconcilePrompt(brief, cfg);
  if (prompt.length > PROMPT_CAP) { /* already clipped per-field; proceed */ }
  // Shared reasoning core: one AI call + robust JSON parse + timeout, never
  // throws. ok:false (AI down/unparseable) -> deterministic fallback, same as
  // the previous inline try/catch.
  const { reason } = require('../orcha/reason');
  const r = await reason({ prompt, signal: opts.signal, requestId: opts.requestId, label: 'relay-reconcile' });
  const decision = r.ok ? _normalizeDecision(brief, r.data, cfg) : _fallbackDecision(brief, cfg);
  // Attach the keys the apply layer needs to post into the right Relay WR.
  decision._serviceUrl = brief._serviceUrl;
  decision._workRequestId = brief._workRequestId;
  decision.vendor = brief.vendor;
  decision.dealerName = brief.dealerName;
  decision.offsiteUrl = brief.offsiteUrl;
  return decision;
}

module.exports = {
  DEFAULT_CONFIG,
  getConfig,
  saveConfig,
  buildReconcilePrompt,
  reconcileUnit,
  hasReconcilableData,
  // exported for tests / reuse
  _unitBrief,
  _daysSinceOffsite,
  _normalizeDecision,
  _fallbackDecision,
  _parseJson,
};
