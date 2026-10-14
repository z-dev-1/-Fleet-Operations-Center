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

// Pull a short "freshest update" line (the dealer's ready message) + any ASIST
// case reference from the canonical record / fleet row, for message context.
function _readyContext(rec, row) {
  const lmu = rec && rec.lastMeaningfulUpdate;
  const updateText = (lmu && lmu.text) || (row && (row.issueSummary || row.lifecycleReason)) || '';
  const blob = [updateText, row && row.asistNotes, row && row.asistLabel].filter(Boolean).join(' ');
  const caseMatch = String(blob).match(/\b(?:ASIST\s*case|case)\s*#?\s*(\d{6,12})\b/i)
    || String(blob).match(/\bestimates?\/(\d{6,12})\b/i);
  const asistCase = caseMatch ? caseMatch[1] : '';
  const dealer = (row && (row.dealerName || row.asistLabel || row.vendor)) || '';
  return { updateText: String(updateText).slice(0, 300), asistCase, dealer };
}

// Build the AI prompt. Intent: tell the carrier their unit is repair-complete /
// ready for pickup, and ask THEM to decide pickup vs tow-back.
function buildReadyPrompt(unit, ctx, ownerTag) {
  const line = (k, v) => (v ? '- ' + k + ': ' + v : '');
  const details = [
    line('Unit / Asset ID', unit.equipmentId || unit.id),
    line('Domicile / Home yard', unit.domicileSite || unit.domicile),
    line('Dealer / Service location', ctx.dealer),
    line('ASIST case', ctx.asistCase),
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
    '- State clearly that the unit is repair-complete / ready for pickup at the dealer/service location (name it if given).',
    '- Reference the ASIST case number if one is given.',
    '- ASK the carrier to decide and reply with ONE of: (a) they will PICK IT UP themselves, or (b) they want it TOWED BACK to their home yard. Make this choice explicit.',
    '- Be concise (2–4 short sentences), courteous, and partner-appropriate.',
    ownerTag ? ('- Begin by addressing the owner using EXACTLY this token so Slack tags them: ' + ownerTag) : '',
    '',
    'The message MUST NOT:',
    '- Mention "Z", "Zila", "FAS", the internal requester, or any internal-only names/roles.',
    '- Invent a date, price, work order number, or any detail not provided above.',
  ].filter(Boolean).join('\n');
}

// Deterministic fallback message if every AI attempt fails, so the carrier is
// still told rather than getting nothing.
function _fallbackMessage(unit, ctx, ownerTag) {
  const id = unit.equipmentId || unit.id || 'the unit';
  const where = ctx.dealer ? (' at ' + ctx.dealer) : '';
  const cs = ctx.asistCase ? (' (ASIST case ' + ctx.asistCase + ')') : '';
  return (ownerTag ? ownerTag + ' ' : '') +
    ':white_check_mark: Unit ' + id + ' has completed repairs and is ready for pickup' + where + cs + '. ' +
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

    try {
      await sendToChannel(entry.channelId, message); // top-level (no thread)
      doLog('[ReadyPickup] ' + equipmentId + ': notified ' + operator + ' channel ' + entry.channelId);
    } catch (e) {
      doLog('[ReadyPickup] ' + equipmentId + ': send failed (' + e.message + ')');
      out.skipped++; continue; // do NOT record dedup on a failed send
    }

    ledger[dedupKey] = { at: new Date().toISOString(), channelId: entry.channelId, unit: equipmentId, operator };
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

module.exports = {
  notifyReadyUnits,
  buildReadyPrompt,
  _isFreshReady,
  _readyContext,
  _fallbackMessage,
  LEDGER_KEY,
};
