/**
 * ready_pickup_notify.js — notify a unit's carrier/operator when it becomes
 * READY FOR PICKUP, and ask them to decide: pick it up themselves, or request a
 * tow back to their yard.
 *
 * Trigger: the canonical state pass (src/sync/index.js _runCanonicalPass) runs
 * each sync and computes a per-unit record with status + temporal diff fields
 * (previousStatus, statusChangedAt). When a unit TRANSITIONS to
 * 'ready_for_pickup' this cycle (e.g. "Dealer reports repairs complete and the
 * unit ready for pickup. ASIST case … set to Asset Ready."), we post ONCE to
 * that unit's operator Slack channel.
 *
 * Reuses the existing plumbing — nothing new invented:
 *   - operator → Slack channel mapping: pm_alert_reply.resolveOperatorEntry
 *   - Slack post: slack_send.sendToChannel  (injected as deps.sendToChannel)
 *   - AI message: relay.ask                 (injected as deps.askOrcha)
 *   - dedupe ledger: store key 'readyPickupNotices' (mirrors pmAlertFanout),
 *     keyed by equipmentId + the status-change timestamp so a unit that cycles
 *     down → ready AGAIN later gets a fresh notice, but a single ready event is
 *     never messaged twice.
 *
 * Guardrails match the carrier fan-out: never mention Z / Zila / FAS / the
 * internal requester, never invent data, always tag the owner.
 */

const store = require('../store');
let logger; try { logger = require('../utils/logger').createLogger('ready-pickup'); }
catch (_) { try { logger = require('../utils/logger')('ready-pickup'); } catch (_2) { logger = { info(){}, warn(){}, error(){} }; } }

const LEDGER_KEY = 'readyPickupNotices';
const LEDGER_CAP = 2000;
const AI_ATTEMPTS = 2;
const AI_ATTEMPT_MS = 30000;
// Per-unit cooldown. The upstream status can FLAP (ready_for_pickup -> down ->
// ready_for_pickup) across adjacent sync cycles (observed ~80 min apart), which
// the pure statusChangedAt dedup treats as a brand-new ready event every time
// and re-messages the carrier. Suppress a repeat notice for the SAME unit
// within this window regardless of statusChangedAt churn. 24h cleanly separates
// flapping (minutes/hours apart) from a genuine re-ready (a unit picked up then
// later back in for repair is days out, well beyond this window).
const NOTIFY_COOLDOWN_MS = 24 * 3600 * 1000;  // 24 hours

// Live fleet row for a unit (dealer/asist/domicile context for the message).
function _fleetRow(equipmentId) {
  try {
    const fd = store.load('fleetData', {}) || {};
    const rows = Array.isArray(fd.rows) ? fd.rows : [];
    const want = String(equipmentId || '').trim().toLowerCase();
    return rows.find((r) => String(r.equipmentId || '').trim().toLowerCase() === want) || null;
  } catch (_) { return null; }
}

// Is this canonical record a FRESH transition into ready_for_pickup this cycle?
// previousStatus is only set by diffAgainstPrior when the status actually
// changed, so (status===ready && previousStatus && previousStatus!==ready) is a
// real transition, not a unit that has merely been sitting ready for days.
function _isFreshReady(rec) {
  return !!(rec
    && rec.status === 'ready_for_pickup'
    && rec.previousStatus
    && rec.previousStatus !== 'ready_for_pickup');
}

// Derive the DEALER/VENDOR the unit is physically AT (its current location),
// so the carrier knows where to pick it up / where it's being towed from.
// Priority: dealerName field → subVendor field → the dealer name embedded in
// the asistNotes comment header ("<Advisor> - <Dealer Name - Location> (Make)
// (Role) to …") → vendor. 'asistLabel' is intentionally NOT used as a location
// because it is just "Fleet Estimate | <case#>", not a place.
function _deriveDealerLocation(row) {
  if (!row) return '';
  const direct = String(row.dealerName || '').trim();
  if (direct) return direct;
  const sub = String(row.subVendor || '').trim();
  // Only trust subVendor if it isn't an obviously truncated stub.
  if (sub && !/\.\.\.$/.test(sub) && sub.length >= 4) return sub;
  // Extract from the asistNotes comment header: the first "<name> - <Dealer -
  // Location> (Company) (Role) to" line. Capture the segment between the first
  // " - " and the " (…) to" that follows.
  const notes = String(row.asistNotes || '');
  const m = notes.match(/[A-Za-z][\w.'-]*(?:\s+[A-Za-z][\w.'-]*)*\s+-\s+([A-Z][^\n(]*?)\s*\([^)]*\)\s*(?:\([^)]*\)\s*)?to\b/);
  if (m && m[1]) return m[1].trim();
  // Fall back to the truncated subVendor (better than nothing) then vendor.
  if (sub) return sub.replace(/\.\.\.$/, '').trim();
  return String(row.vendor || '').trim();
}

// Pull a short "freshest update" line (the dealer's ready message), the ASIST
// case reference, the dealer/vendor LOCATION, and the offsite estimate URL from
// the canonical record / fleet row, for message context.
function _readyContext(rec, row) {
  const lmu = rec && rec.lastMeaningfulUpdate;
  const updateText = (lmu && lmu.text) || (row && (row.issueSummary || row.lifecycleReason)) || '';
  const blob = [updateText, row && row.asistNotes, row && row.asistLabel].filter(Boolean).join(' ');
  const caseMatch = String(blob).match(/\b(?:ASIST\s*case|case)\s*#?\s*(\d{6,12})\b/i)
    || String(blob).match(/\bestimates?\/(\d{6,12})\b/i)
    || String((row && row.offsiteShopEvent) || '').match(/\b(\d{6,12})\b/);
  const asistCase = caseMatch ? caseMatch[1] : '';
  const dealerLocation = _deriveDealerLocation(row);
  const offsiteUrl = (row && (row.offsiteShopEventUrl || row.asistSrUrl || row.savedOffsiteUrl)) || '';
  return {
    updateText: String(updateText).slice(0, 300),
    asistCase,
    // Keep `dealer` for backward compat; `dealerLocation` is the preferred field.
    dealer: dealerLocation,
    dealerLocation,
    offsiteUrl,
  };
}

// Build the AI prompt. Intent: tell the carrier their unit is repair-complete /
// ready for pickup, and ask THEM to decide pickup vs tow-back.
function buildReadyPrompt(unit, ctx, ownerTag) {
  const line = (k, v) => (v ? '- ' + k + ': ' + v : '');
  const details = [
    line('Unit / Asset ID', unit.equipmentId || unit.id),
    line('Home yard (domicile)', unit.domicileSite || unit.domicile),
    line('CURRENT LOCATION — vendor/dealer the unit is AT', ctx.dealerLocation || ctx.dealer),
    line('ASIST case', ctx.asistCase),
    line('Estimate / case link', ctx.offsiteUrl),
    line('Latest dealer update', ctx.updateText),
    line('Make', unit.make),
  ].filter(Boolean).join('\n');

  return [
    'Write a SHORT, professional Slack message to a carrier/operator partner channel letting them know one of their units has finished repairs and is READY FOR PICKUP. Use a few tasteful Slack-friendly emojis (e.g. :white_check_mark:, :truck:, :round_pushpin:). Output ONLY the message text — no preamble, no JSON, no markdown headers.',
    '',
    'DETAILS (use only what is given; never invent anything):',
    details,
    '',
    'The message MUST:',
    '- State clearly that the unit is repair-complete / ready for pickup.',
    '- Tell them WHERE the unit currently is — name the vendor/dealer location it is sitting at (the "CURRENT LOCATION" above). This is required so they know where to go or where it will be towed from.',
    '- Reference the ASIST case number and include the estimate/case link if given.',
    '- ASK the carrier to decide and reply with ONE of: (a) they will PICK IT UP themselves, or (b) they want it TOWED BACK to their home yard. Make this choice explicit.',
    '- Be concise (2–4 short sentences), courteous, and partner-appropriate.',
    ownerTag ? ('- Begin by addressing the owner using EXACTLY this token so Slack tags them: ' + ownerTag) : '',
    '',
    'The message MUST NOT:',
    '- Mention "Z", "Zila", "FAS", the internal requester, or any internal-only names/roles.',
    '- Invent a date, price, work order number, location, or any detail not provided above.',
  ].filter(Boolean).join('\n');
}

// Deterministic fallback message if every AI attempt fails, so the carrier is
// still told rather than getting nothing.
function _fallbackMessage(unit, ctx, ownerTag) {
  const id = unit.equipmentId || unit.id || 'the unit';
  const loc = ctx.dealerLocation || ctx.dealer;
  const where = loc ? (' It is currently at ' + loc + '.') : '';
  const cs = ctx.asistCase ? (' (ASIST case ' + ctx.asistCase + ')') : '';
  const link = ctx.offsiteUrl ? (' ' + ctx.offsiteUrl) : '';
  return (ownerTag ? ownerTag + ' ' : '') +
    ':white_check_mark: Unit ' + id + ' has completed repairs and is ready for pickup' + cs + '.' + where + ' :round_pushpin:' + link + ' ' +
    ':truck: Please let us know whether you will pick it up, or if you would like it towed back to your home yard.';
}

async function _writeMessage(askOrcha, unit, ctx, ownerTag, doLog) {
  const prompt = buildReadyPrompt(unit, ctx, ownerTag);
  let message = '';
  for (let attempt = 1; attempt <= AI_ATTEMPTS && !message; attempt++) {
    try {
      const ai = await Promise.race([
        askOrcha(prompt),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ai-timeout')), AI_ATTEMPT_MS)),
      ]);
      message = (ai && ai.text) ? String(ai.text).trim() : (typeof ai === 'string' ? ai.trim() : '');
    } catch (e) {
      doLog('[ReadyPickup] AI attempt ' + attempt + '/' + AI_ATTEMPTS + ' failed (' + e.message + ')');
    }
    if (!message && attempt < AI_ATTEMPTS) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!message) {
    doLog('[ReadyPickup] all AI attempts failed — using deterministic fallback');
    message = _fallbackMessage(unit, ctx, ownerTag);
  }
  // Safety net: ensure the owner is actually tagged even if the AI omitted it.
  if (ownerTag && message.indexOf(ownerTag) === -1) message = ownerTag + ' ' + message;
  return message;
}

/**
 * notifyReadyUnits(units, deps, log)
 *   units: canonical records map { equipmentId -> record } (from buildAll)
 *   deps:  { sendToChannel, askOrcha, resolveOperatorEntry }
 * Posts one message per FRESH ready transition to the unit's operator channel,
 * deduped so a single ready event is only sent once. Non-throwing: returns a
 * summary { considered, notified, skipped }.
 */
async function notifyReadyUnits(units, deps, log) {
  const doLog = log || ((m) => logger.info(m));
  const { sendToChannel, askOrcha, resolveOperatorEntry } = deps || {};
  // Fleet-row lookup is injectable for testing; defaults to the store-backed one.
  const fleetRow = (deps && typeof deps.fleetRow === 'function') ? deps.fleetRow : _fleetRow;
  // Ledger access is injectable too (store is file-backed in prod).
  const loadLedger = (deps && typeof deps.loadLedger === 'function')
    ? deps.loadLedger : () => { try { return store.load(LEDGER_KEY, {}) || {}; } catch (_) { return {}; } };
  const saveLedger = (deps && typeof deps.saveLedger === 'function')
    ? deps.saveLedger : (l) => { try { store.save(LEDGER_KEY, l); } catch (_) {} };
  // Persist the carrierNotifiedAt flag back into the canonicalState store so it
  // survives to the next sync cycle (the primary, flap-proof dedup). Injectable
  // for tests; defaults to a store-backed read-modify-write on canonicalState.
  const markCarrierNotified = (deps && typeof deps.markCarrierNotified === 'function')
    ? deps.markCarrierNotified
    : (equipmentId, at) => {
        try {
          const cs = store.load('canonicalState', {}) || {};
          const u = cs.units || {};
          const key = Object.keys(u).find((k) => String(k).toLowerCase() === String(equipmentId).toLowerCase());
          if (key && u[key]) {
            u[key].carrierNotifiedAt = at;
            cs.units = u;
            store.save('canonicalState', cs);
          }
        } catch (_) {}
      };
  if (deps && typeof deps.markCarrierNotified !== 'function') deps.markCarrierNotified = markCarrierNotified;
  const out = { considered: 0, notified: 0, skipped: 0 };
  if (!units || typeof units !== 'object') return out;
  if (typeof sendToChannel !== 'function' || typeof askOrcha !== 'function' || typeof resolveOperatorEntry !== 'function') {
    doLog('[ReadyPickup] missing deps — skipping');
    return out;
  }

  const fresh = Object.values(units).filter(_isFreshReady);
  if (!fresh.length) return out;
  out.considered = fresh.length;

  const ledger = loadLedger() || {};

  for (const rec of fresh) {
    const equipmentId = rec.equipmentId;
    // Dedup key includes the transition time so a NEW ready event (after the
    // unit went back down and became ready again) notifies again, but the same
    // event never twice.
    const dedupKey = String(equipmentId).toLowerCase() + ':' + (rec.statusChangedAt || '');
    if (ledger[dedupKey]) { out.skipped++; continue; }

    // CANONICAL FLAG (primary, flap-proof dedup): once we've notified the
    // carrier for this ready episode, the canonical record carries
    // carrierNotifiedAt forward across cycles — even while the raw status flaps
    // ready->down->ready. If it's already set, we've handled this episode.
    if (rec.carrierNotifiedAt) {
      doLog('[ReadyPickup] ' + equipmentId + ': canonical carrierNotifiedAt already set (' + rec.carrierNotifiedAt + ') — skipping');
      out.skipped++; continue;
    }

    // COOLDOWN GUARD (fixes status-flapping re-sends): if we already notified
    // this SAME unit for a ready EVENT whose status-change time is within the
    // cooldown window of this one, do not message again. We compare EVENT times
    // (statusChangedAt), not wall-clock, so flapping (ready→down→ready ~minutes
    // apart → statusChangedAt bumps a little) is suppressed, while a genuine
    // re-ready days later (a real repair cycle) still fires. One ready event per
    // unit per window, not one per statusChangedAt value.
    const unitKey = String(equipmentId).toLowerCase();
    const thisEventMs = rec.statusChangedAt ? Date.parse(rec.statusChangedAt) : NaN;
    const recentlyNotified = Object.values(ledger).some((e) => {
      if (!e || String(e.unit || '').toLowerCase() !== unitKey) return false;
      // Prefer the stored event time; fall back to the wall-clock 'at'.
      const prevEventMs = e.statusChangedAt ? Date.parse(e.statusChangedAt)
                        : (e.at ? Date.parse(e.at) : NaN);
      if (!Number.isFinite(prevEventMs)) return false;
      if (!Number.isFinite(thisEventMs)) return true; // no event time now → treat any prior notice as a dup
      return Math.abs(thisEventMs - prevEventMs) < NOTIFY_COOLDOWN_MS;
    });
    if (recentlyNotified) {
      doLog('[ReadyPickup] ' + equipmentId + ': already notified within cooldown (status likely flapped) — skipping');
      out.skipped++; continue;
    }

    const row = fleetRow(equipmentId) || {};
    const operator = row.operator || (rec && rec.operator) || '';
    if (!operator) { doLog('[ReadyPickup] ' + equipmentId + ': no operator — skipping'); out.skipped++; continue; }

    const entry = resolveOperatorEntry(operator);
    if (!entry || !entry.channelId) {
      doLog('[ReadyPickup] ' + equipmentId + ': operator "' + operator + '" has no mapped carrier channel — skipping');
      out.skipped++; continue;
    }

    const ownerTag = entry.ownerId ? '<@' + entry.ownerId + '>' : '';
    const unit = Object.assign({ equipmentId }, row);
    const ctx = _readyContext(rec, row);

    let message;
    try { message = await _writeMessage(askOrcha, unit, ctx, ownerTag, doLog); }
    catch (e) { doLog('[ReadyPickup] ' + equipmentId + ': message build failed (' + e.message + ')'); out.skipped++; continue; }

    let postedTs = null;
    try {
      const res = await sendToChannel(entry.channelId, message); // top-level (no thread)
      postedTs = (res && res.ts) || null;
      doLog('[ReadyPickup] ' + equipmentId + ': notified ' + operator + ' channel ' + entry.channelId + (postedTs ? ' (ts ' + postedTs + ')' : ''));
    } catch (e) {
      doLog('[ReadyPickup] ' + equipmentId + ': send failed (' + e.message + ')');
      out.skipped++; continue; // do NOT record dedup on a failed send
    }

    // Record the posted message ts + channel so the inbound reply handler can
    // correlate the carrier's reply (thread_ts === ts) back to this unit, and
    // 'awaitingReply' so it only answers until a reply is handled.
    // Stamp the canonical record (primary, flap-proof dedup) and persist it so
    // the flag survives to the next cycle. Mutate the in-memory record too so a
    // duplicate in THIS same pass is also guarded.
    const notifiedAt = new Date().toISOString();
    rec.carrierNotifiedAt = notifiedAt;
    try { if (typeof deps.markCarrierNotified === 'function') deps.markCarrierNotified(equipmentId, notifiedAt); }
    catch (e) { doLog('[ReadyPickup] ' + equipmentId + ': canonical flag persist failed (' + e.message + ')'); }

    ledger[dedupKey] = {
      at: notifiedAt,
      statusChangedAt: rec.statusChangedAt || null,  // event time, for cooldown dedup across flapping
      channelId: entry.channelId,
      ts: postedTs,
      unit: equipmentId,
      operator,
      dealerLocation: ctx.dealerLocation || ctx.dealer || '',
      awaitingReply: !!postedTs,   // can only track a reply if we know the ts
      answeredReplyTs: null,
    };
    out.notified++;
  }

  // Persist ledger (capped).
  try {
    const keys = Object.keys(ledger);
    if (keys.length > LEDGER_CAP) keys.slice(0, keys.length - LEDGER_CAP).forEach((k) => delete ledger[k]);
    saveLedger(ledger);
  } catch (_) {}

  if (out.notified) doLog('[ReadyPickup] cycle: ' + out.notified + ' notified, ' + out.skipped + ' skipped, ' + out.considered + ' fresh-ready');
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// INBOUND: the carrier replies in the ready-pickup thread (pickup vs tow-back).
// Modeled on the PM-alert auto-reply (slack_channel_watch _pollPmAlertChannel +
// pm_alert_reply.handleTaggedPmAlert): read the thread, let the AI interpret the
// carrier's decision, post an acknowledgment in-thread. The carrier reply does
// NOT tag us — we correlate by thread_ts === the ready message's ts (stored in
// the ledger), so we only look at threads under messages we posted.
// ═══════════════════════════════════════════════════════════════════════════

// Prompt: given our ready-pickup message context + the carrier's reply text,
// classify intent (pickup | tow-back | unclear) and write a short, professional
// acknowledgment. Same guardrails: no Z/Zila/FAS, never invent.
function buildReplyPrompt(entry, carrierReplyText, ownerTag) {
  return [
    'You are replying IN A SLACK THREAD to a carrier/operator partner who was told their unit finished repairs and is ready for pickup, and was asked to choose: they PICK IT UP themselves, or they want it TOWED BACK to their home yard. Read their reply and respond. Write ONLY the reply text — no preamble, no JSON, no markdown headers. Keep it 1–2 short sentences, professional, with at most one tasteful emoji.',
    '',
    'CONTEXT (use only what is given; never invent anything):',
    '- Unit / Asset ID: ' + (entry.unit || ''),
    entry.dealerLocation ? ('- Current location (vendor/dealer the unit is at): ' + entry.dealerLocation) : '',
    '',
    'THE CARRIER\'S REPLY:',
    '"' + String(carrierReplyText || '').slice(0, 500) + '"',
    '',
    'DECIDE and reply:',
    '- If they said they will PICK IT UP themselves: confirm, thank them, and (if a location is known) remind them it is at that location.',
    '- If they want it TOWED BACK to their yard: confirm that a tow back to their home yard will be arranged.',
    '- If their reply is UNCLEAR or asks something else: briefly ask them to confirm which they prefer — pickup themselves, or a tow back.',
    ownerTag ? ('- You may address them with this token if natural: ' + ownerTag) : '',
    '',
    'MUST NOT: mention "Z", "Zila", "FAS", the internal requester, or invent a date/price/ETA/location not given above.',
  ].filter(Boolean).join('\n');
}

async function _writeReply(askOrcha, entry, carrierReplyText, ownerTag, doLog) {
  const prompt = buildReplyPrompt(entry, carrierReplyText, ownerTag);
  let reply = '';
  for (let attempt = 1; attempt <= AI_ATTEMPTS && !reply; attempt++) {
    try {
      const ai = await Promise.race([
        askOrcha(prompt),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ai-timeout')), AI_ATTEMPT_MS)),
      ]);
      reply = (ai && ai.text) ? String(ai.text).trim() : (typeof ai === 'string' ? ai.trim() : '');
    } catch (e) {
      doLog('[ReadyPickup] reply AI attempt ' + attempt + '/' + AI_ATTEMPTS + ' failed (' + e.message + ')');
    }
    if (!reply && attempt < AI_ATTEMPTS) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!reply) reply = 'Thanks for the update — got it. Please confirm whether you will pick the unit up or would like it towed back to your yard, and we will take it from there.';
  return reply;
}

// Does a thread reply look like it's FROM the carrier (not our own bot post)?
// Our posts tag the owner and come from the authed user; a carrier reply is a
// different user and is not our ready message itself.
function _isCarrierReply(m, readyTs, myUserId) {
  if (!m || !m.ts) return false;
  if (m.ts === readyTs) return false;                 // the ready message itself
  if (myUserId && String(m.userId || m.user || '') === String(myUserId)) return false; // our own reply
  const t = String(m.text || '').trim();
  if (!t) return false;
  return true;
}

/**
 * handleReadyReplies(ch, deps, log)
 *   ch:   { id, name }
 *   deps: { readThreadReplies, sendToChannel, askOrcha, myUserId,
 *           resolveOperatorEntry?, loadLedger?, saveLedger? }
 * For each ready-pickup notice on THIS channel still awaiting a reply, read the
 * thread under its stored ts, and if the carrier has replied, AI-interpret
 * pickup-vs-tow and post one acknowledgment in-thread. Marks the notice answered
 * so we never reply twice. Non-throwing; returns { checked, answered }.
 */
async function handleReadyReplies(ch, deps, log) {
  const doLog = log || ((m) => logger.info(m));
  const { readThreadReplies, sendToChannel, askOrcha, myUserId } = deps || {};
  const out = { checked: 0, answered: 0 };
  if (!ch || !ch.id) return out;
  if (typeof readThreadReplies !== 'function' || typeof sendToChannel !== 'function' || typeof askOrcha !== 'function') return out;

  const loadLedger = (deps && typeof deps.loadLedger === 'function')
    ? deps.loadLedger : () => { try { return store.load(LEDGER_KEY, {}) || {}; } catch (_) { return {}; } };
  const saveLedger = (deps && typeof deps.saveLedger === 'function')
    ? deps.saveLedger : (l) => { try { store.save(LEDGER_KEY, l); } catch (_) {} };
  const resolveOperatorEntry = deps && deps.resolveOperatorEntry;

  const ledger = loadLedger() || {};
  // Only entries for THIS channel that are still awaiting a reply + have a ts.
  const pending = Object.entries(ledger).filter(([, e]) =>
    e && e.channelId === ch.id && e.ts && e.awaitingReply && !e.answeredReplyTs);
  if (!pending.length) return out;

  let changed = false;
  for (const [key, entry] of pending) {
    out.checked++;
    let replies;
    try { replies = await readThreadReplies(ch.id, entry.ts, 30); }
    catch (e) { doLog('[ReadyPickup] ' + (entry.unit || '') + ': thread read failed (' + e.message + ')'); continue; }
    if (!Array.isArray(replies) || !replies.length) continue;

    // First carrier reply (chronological) that isn't ours / isn't the root.
    const carrierReply = replies
      .filter((m) => _isCarrierReply(m, entry.ts, myUserId))
      .sort((a, b) => Number(a.ts) - Number(b.ts))[0];
    if (!carrierReply) continue;

    let ownerTag = '';
    try {
      if (typeof resolveOperatorEntry === 'function') {
        const op = resolveOperatorEntry(entry.operator);
        if (op && op.ownerId) ownerTag = '<@' + op.ownerId + '>';
      }
    } catch (_) {}

    let reply;
    try { reply = await _writeReply(askOrcha, entry, carrierReply.text, ownerTag, doLog); }
    catch (e) { doLog('[ReadyPickup] ' + (entry.unit || '') + ': reply build failed (' + e.message + ')'); continue; }

    try {
      await sendToChannel(ch.id, reply, entry.ts); // in-thread
      doLog('[ReadyPickup] ' + (entry.unit || '') + ': answered carrier reply in-thread (' + ch.id + ')');
    } catch (e) {
      doLog('[ReadyPickup] ' + (entry.unit || '') + ': reply send failed (' + e.message + ')');
      continue; // retry next poll — do NOT mark answered
    }

    entry.answeredReplyTs = carrierReply.ts;
    entry.awaitingReply = false;
    entry.answeredAt = new Date().toISOString();
    changed = true;
    out.answered++;
  }

  if (changed) { try { saveLedger(ledger); } catch (_) {} }
  return out;
}

module.exports = {
  notifyReadyUnits,
  buildReadyPrompt,
  handleReadyReplies,
  buildReplyPrompt,
  _isFreshReady,
  _isCarrierReply,
  _readyContext,
  _deriveDealerLocation,
  _fallbackMessage,
  LEDGER_KEY,
};
