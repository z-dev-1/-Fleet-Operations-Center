'use strict';
/**
 * scrapers/pm_alert_reply.js — Predictive Maintenance (PM) Alert auto-reply.
 *
 * FEATURE (2026-10): when the signed-in user is @-tagged in a watched Slack
 * channel — on a top-level message OR a thread reply — and that message (or
 * its thread root) is a Predictive Maintenance Alert carrying an Asset ID,
 * the app:
 *   1. Parses the alert (Asset ID, domicile, risk score, insight/fault).
 *   2. Looks that unit up in fleetData.
 *   3. Lets the AI decide, from the unit's real status, whether the unit is
 *      ALREADY DOWN for a related issue. If so, the reply says so and cites
 *      the work order's AMZ-XXX (unit.alternativeId) + its Relay Garage link
 *      (unit.serviceUrl). Otherwise it just acknowledges.
 *   4. Posts the reply in-thread.
 *
 * This is ADDITIVE and fully separate from the existing Mentions / Occasional
 * / Just Me reply modes — gated behind a per-channel `pmAlertAutoReply` flag.
 * It only ever fires when an Asset ID is successfully parsed (so a normal
 * @-mention with no alert data is left alone).
 *
 * Field sources (verified against the live fleetData row shape produced by
 * src/scrapers/relay.js mergeRelayIntoRows):
 *   - AMZ-XXX work order number → unit.alternativeId (a.k.a. unit.altId)
 *   - Relay Garage WR link      → unit.serviceUrl
 *   - down/available            → unit.lifecycleState / lifecycleReason
 *   - issue text                → unit.issueSummary / issueDetails / cause
 */

const store = require('../store');
const logger = require('../utils/logger').createLogger('pm_alert_reply');

// ── Alert parsing ────────────────────────────────────────────────────────────
// The MCS "Predictive Maintenance Alert" messages look like:
//   :rotating_light: Predictive Maintenance Alert
//   Asset ID: 521203  |  Domicile: ABE40  |  Risk Score: 88.0
//   Insights:
//     1. EGR Mass Air Flow | Fault Code(s): 2659 | Engine - Emissions | ...
//   :bust_in_silhouette: FAS: @zilasant — please review ...
// We parse defensively from free text — every field optional except assetId,
// which is the gate. Asset IDs in this fleet are alphanumeric (e.g. 521203,
// B62060), so we anchor on the "Asset ID:" label first, then fall back to a
// loose scan.
function parseAlert(text) {
  let t = String(text || '');
  if (!t) return null;

  // Slack renders these alerts with markdown: labels are bold (*Asset ID:*),
  // values follow after the closing '*'. Strip Slack markdown decorations
  // (*bold*, _italic_, `code`, ~strike~) so labels/values parse cleanly. Also
  // unwrap <url|text> / <url> link syntax to its text. This is the fix for
  // parseAlert returning NONE on real alerts (confirmed live: "*Asset ID:* 622008").
  t = t
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')   // <url|label> -> label
    .replace(/<([^>]+)>/g, '$1')             // <url> -> url
    .replace(/[*_~`]/g, '');                 // drop bold/italic/strike/code marks

  // Asset ID — required. Prefer the explicit label; be tolerant of spacing/case.
  let assetId = '';
  let m = t.match(/Asset\s*ID\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9-]{2,})/i);
  if (m) assetId = m[1];
  if (!assetId) return null;
  // Strip any trailing punctuation Slack markup might leave on.
  assetId = assetId.replace(/[^A-Za-z0-9-]+$/, '').trim();
  if (!assetId) return null;

  const domicile   = (t.match(/Domicile\s*[:#]?\s*([A-Za-z0-9]{3,10})/i) || [])[1] || '';
  const riskScore  = (t.match(/Risk\s*Score\s*[:#]?\s*([\d.]+)/i) || [])[1] || '';

  // Insight / fault line(s): grab the first substantive insight line for
  // context (component, fault codes, subsystem). Best-effort.
  let insight = '';
  const insMatch = t.match(/Insights?\s*[:#]?\s*\n?\s*(?:\d+\.\s*)?([^\n]{4,200})/i);
  if (insMatch) insight = insMatch[1].trim();
  const faultCodes = (t.match(/Fault\s*Code\(?s?\)?\s*[:#]?\s*([0-9,\s]+)/i) || [])[1] || '';
  const repairWindow = (t.match(/Repair\s*Window\s*[:#]?\s*([^\n|]+)/i) || [])[1] || '';

  return {
    assetId: assetId,
    domicile: domicile.trim(),
    riskScore: riskScore.trim(),
    insight: insight.trim(),
    faultCodes: faultCodes.replace(/\s+/g, ' ').trim(),
    repairWindow: repairWindow.trim(),
    raw: t.slice(0, 1200),
  };
}

// Does this text look like a PM alert at all (has an Asset ID we can act on)?
function looksLikeAlert(text) {
  return !!parseAlert(text);
}

// STRICT tag check: is the given Slack user id literally @-mentioned in THIS
// message text? Slack renders mentions as "<@U0123>" or "<@U0123|display>".
// Match the exact user id in either form and nothing else — no display-name
// matching, no thread inference. This is the single source of truth for "am I
// actually tagged," used both by the handler and the channel-watch wiring so
// they cannot disagree.
function isTaggedIn(text, myUserId) {
  if (!text || !myUserId) return false;
  // Escape id for regex safety, then match <@ID> or <@ID|anything>
  const id = String(myUserId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('<@' + id + '(\\|[^>]*)?>');
  return re.test(text);
}

// ── Operator Channels config (operator -> carrier channel + owner) ────────────
// Shape: { operators: [ { operator, channelId, ownerId, ownerName } ] }
function getOperatorChannels() {
  const cfg = store.load('operatorChannels', null);
  if (cfg && Array.isArray(cfg.operators)) return cfg;
  const seeded = { operators: [] };
  return seeded;
}
function saveOperatorChannels(cfg) {
  if (!cfg || !Array.isArray(cfg.operators)) throw new Error('operatorChannels.operators must be an array');
  // Normalize: trim operator codes, keep only entries with an operator name.
  const operators = cfg.operators
    .map((o) => ({
      operator: String(o.operator || '').trim(),
      channelId: String(o.channelId || '').trim(),
      ownerId: String(o.ownerId || '').trim(),
      ownerName: String(o.ownerName || '').trim(),
    }))
    .filter((o) => o.operator);
  store.save('operatorChannels', { operators });
  return { ok: true };
}

// Distinct operator codes present in fleetData (for the "Populate from fleet"
// button). Case-preserving, de-duplicated, sorted.
function listFleetOperators() {
  try {
    const fd = store.load('fleetData', {}) || {};
    const rows = Array.isArray(fd.rows) ? fd.rows : [];
    const seen = new Map(); // lower -> original
    for (const r of rows) {
      const op = String(r.operator || '').trim();
      if (op && !seen.has(op.toLowerCase())) seen.set(op.toLowerCase(), op);
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  } catch (e) {
    logger.warn('[PMAlert] listFleetOperators error: ' + e.message);
    return [];
  }
}

// Resolve a unit's operator to its mapped carrier entry (case-insensitive).
function resolveOperatorEntry(operator) {
  const op = String(operator || '').trim().toLowerCase();
  if (!op) return null;
  const cfg = getOperatorChannels();
  return cfg.operators.find((o) => String(o.operator || '').trim().toLowerCase() === op) || null;
}

// ── Fleet-data lookup ─────────────────────────────────────────────────────────
// Match on equipmentId, case-insensitive (alert may print "B62060" vs a stored
// "b62060"). Returns the matched row or null.
function findUnit(assetId) {
  if (!assetId) return null;
  try {
    const fd = store.load('fleetData', {}) || {};
    const rows = Array.isArray(fd.rows) ? fd.rows : [];
    const want = String(assetId).trim().toLowerCase();
    return rows.find((r) => String(r.equipmentId || '').trim().toLowerCase() === want) || null;
  } catch (e) {
    logger.warn('[PMAlert] findUnit error: ' + e.message);
    return null;
  }
}

// ── AI reply prompt ───────────────────────────────────────────────────────────
// The AI is the decision-maker (per the user): given the alert + the unit's
// REAL current status, decide whether the unit is already down for a related
// issue and reply accordingly. We give it only real, looked-up data and tell
// it never to invent a work order number or link.
function buildPrompt(alert, unit) {
  const amz  = (unit && (unit.alternativeId || unit.altId)) || '';
  const link = (unit && unit.serviceUrl) || '';
  const unitBlock = unit
    ? [
        'MATCHED FLEET UNIT (real data — do NOT invent anything):',
        '- Equipment ID: ' + (unit.equipmentId || ''),
        '- Lifecycle State: ' + (unit.lifecycleState || '(unknown)'),
        '- Lifecycle Reason: ' + (unit.lifecycleReason || ''),
        '- Work Order State: ' + (unit.serviceState || '') + (unit.completed ? ' (completed ' + unit.completed + ')' : ''),
        '- Issue Summary: ' + (unit.issueSummary || ''),
        '- Issue Details: ' + (unit.issueDetails || ''),
        '- Reason for Repair: ' + (unit.cause || ''),
        '- Vendor: ' + (unit.vendor || ''),
        '- AMZ Work Order # (alternativeId): ' + (amz || '(none)'),
        '- Relay Garage link (serviceUrl): ' + (link || '(none)'),
      ].join('\n')
    : 'NO MATCHING UNIT was found in fleet data for Asset ID ' + alert.assetId + '.';

  return [
    'You are Zila\'s fleet assistant replying IN A SLACK THREAD to a Predictive Maintenance (PM) alert where Zila was tagged. Write ONLY the reply text — no preamble, no JSON, no markdown headers. Keep it 1–3 short sentences, professional fleet tone.',
    '',
    'PM ALERT:',
    '- Asset ID: ' + alert.assetId,
    '- Domicile: ' + (alert.domicile || '(n/a)'),
    '- Risk Score: ' + (alert.riskScore || '(n/a)'),
    '- Insight/Component: ' + (alert.insight || '(n/a)'),
    '- Fault Code(s): ' + (alert.faultCodes || '(n/a)'),
    '',
    unitBlock,
    '',
    'DECIDE and reply:',
    '1) If the matched unit is ALREADY DOWN / has an OPEN work order for an issue RELATED to this alert (use your judgment — e.g. a check-engine-light / CEL work order covers an emissions/EGR/sensor fault alert; a "misfire" WO covers a misfire alert; broadly related engine faults count), then reply that the unit is already down for that issue and INCLUDE the exact AMZ work order number and the Relay Garage link EXACTLY as given above. Do NOT fabricate a number or link — only use the ones provided; if either is "(none)", omit it.',
    '2) If there is NO matching unit, or the unit is available / not down for anything related, then simply ACKNOWLEDGE the alert briefly (e.g. that it has been received and will be reviewed/aligned with the partner). Do not claim an existing work order you were not given.',
    '',
    'Never invent an AMZ number, a link, a status, or a repair. Use only the data above.',
  ].join('\n');
}

// ── Carrier fan-out: AI message + doc to the operator's channel ───────────────
// Prompt for the message posted to the CARRIER's channel. Intent: notify the
// carrier their unit has a predictive maintenance alert and ask THEM to
// schedule a repair date + time in their email (they also receive an email
// notification). Professional, Slack-friendly emojis. MUST NOT mention Z / the
// requester, and must never invent data.
function buildCarrierPrompt(alert, unit, ownerTag) {
  const line = (k, v) => (v ? '- ' + k + ': ' + v : '');
  const details = [
    line('Asset ID', alert.assetId),
    line('Domicile', alert.domicile || (unit && unit.domicileSite)),
    line('Risk Score', alert.riskScore),
    line('Component/Insight', alert.insight),
    line('Fault Code(s)', alert.faultCodes),
    line('Repair Window', alert.repairWindow),
    line('Make', unit && unit.make),
  ].filter(Boolean).join('\n');

  return [
    'Write a SHORT, professional Slack message to a carrier/operator partner channel notifying them of a Predictive Maintenance alert on one of their units. Use a few tasteful, Slack-friendly emojis (e.g. :rotating_light:, :calendar:, :email:, :wrench:). Output ONLY the message text — no preamble, no JSON, no markdown headers.',
    '',
    'ALERT DETAILS (use only what is given; never invent anything):',
    details,
    '',
    'The message MUST:',
    '- Clearly state the unit/asset and the maintenance concern (component/fault) and the repair window if given.',
    '- ASK the carrier to schedule a repair date and time in their email (they have also received an email notification about this).',
    '- Be concise (2–4 short sentences), courteous, and partner-appropriate.',
    ownerTag ? ('- Begin by addressing the owner using EXACTLY this token so Slack tags them: ' + ownerTag) : '',
    '',
    'The message MUST NOT:',
    '- Mention "Z", "Zila", "FAS", the internal requester, or any internal-only names/roles.',
    '- Invent a work order number, date, price, or any detail not provided above.',
    '- Instruct them on a specific grounding date/time — only ASK them to schedule the repair date/time in their email.',
  ].filter(Boolean).join('\n');
}

// Fan out to the carrier channel. deps: { sendToChannel, uploadFileToChannel,
// downloadFileBuffer, askOrcha }. `alertFiles` = the Slack message's files[]
// (the attached document, if any). Returns { sent, channelId?, withDoc?, reason? }.
async function fanOutToCarrier(alert, unit, alertFiles, deps, log) {
  const doLog = log || ((m) => logger.info(m));
  const { sendToChannel, uploadFileToChannel, downloadFileBuffer, askOrcha } = deps || {};

  const operator = unit && unit.operator;
  if (!operator) { doLog('[PMAlert] fan-out: unit has no operator — skipping'); return { sent: false, reason: 'no-operator' }; }

  const entry = resolveOperatorEntry(operator);
  if (!entry || !entry.channelId) {
    doLog('[PMAlert] fan-out: operator "' + operator + '" has no mapped carrier channel — skipping');
    return { sent: false, reason: 'no-channel' };
  }

  // Dedup: same asset -> same carrier channel, only once.
  const dedupKey = entry.channelId + ':' + String(alert.assetId).toLowerCase();
  try {
    const ledger = store.load('pmAlertFanout', {}) || {};
    if (ledger[dedupKey]) {
      doLog('[PMAlert] fan-out: already sent for ' + dedupKey + ' — skipping');
      return { sent: false, reason: 'dedup' };
    }
  } catch (_) {}

  const ownerTag = entry.ownerId ? '<@' + entry.ownerId + '>' : '';

  // Generate the carrier message — the carrier message MUST be AI-written.
  // The Orcha backend is sometimes slow (observed 20s+), so a single 20s race
  // would fall back to deterministic text too eagerly. RETRY up to 3 times with
  // a longer per-attempt budget (35s) and a short pause between tries. The
  // deterministic fallback is a LAST RESORT only if all attempts fail — not the
  // first timeout. (This runs in the PM handler which is already outside the
  // tight gate path, so the longer budget is fine.)
  const prompt = buildCarrierPrompt(alert, unit, ownerTag);
  let message = '';
  // Bounded so the whole handler stays under the poll's 90s deadline (the
  // handler is awaited inside _pollLock): 2 attempts × 30s + 1.5s pause ≈ 62s.
  const AI_ATTEMPTS = 2;
  const AI_ATTEMPT_MS = 30000;
  for (let attempt = 1; attempt <= AI_ATTEMPTS && !message; attempt++) {
    try {
      const ai = await Promise.race([
        askOrcha(prompt),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ai-timeout')), AI_ATTEMPT_MS)),
      ]);
      message = (ai && ai.text) ? String(ai.text).trim() : (typeof ai === 'string' ? ai.trim() : '');
      if (message) {
        doLog('[PMAlert] fan-out: AI message generated (attempt ' + attempt + ')');
      } else {
        doLog('[PMAlert] fan-out: AI returned empty (attempt ' + attempt + '/' + AI_ATTEMPTS + ')');
      }
    } catch (e) {
      doLog('[PMAlert] fan-out: AI attempt ' + attempt + '/' + AI_ATTEMPTS + ' failed (' + e.message + ')');
    }
    if (!message && attempt < AI_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1500)); // brief pause before retry
    }
  }
  if (!message) {
    // LAST-RESORT deterministic fallback (all AI attempts failed) so the
    // carrier is still notified rather than getting nothing.
    doLog('[PMAlert] fan-out: all ' + AI_ATTEMPTS + ' AI attempts failed — using deterministic fallback');
    message = (ownerTag ? ownerTag + ' ' : '') +
      ':rotating_light: Predictive Maintenance alert for unit ' + alert.assetId +
      (alert.insight ? ' — ' + alert.insight : '') +
      (alert.repairWindow ? ' (repair window: ' + alert.repairWindow + ')' : '') +
      '. :calendar: Please schedule a repair date and time in your email — a notification has also been sent there. :email:';
  }
  // Safety net: make sure the owner is actually tagged even if the AI omitted it.
  if (ownerTag && message.indexOf(ownerTag) === -1) message = ownerTag + ' ' + message;

  // Try to attach the alert document (first attachable file). Best-effort:
  // on any failure, fall back to a text-only post so the carrier is still told.
  let withDoc = false;
  const file = Array.isArray(alertFiles) ? alertFiles.find((f) => f && f.url_private) : null;
  if (file && typeof downloadFileBuffer === 'function' && typeof uploadFileToChannel === 'function') {
    try {
      const dl = await downloadFileBuffer(file);
      if (dl && dl.buffer && dl.buffer.length) {
        await uploadFileToChannel(entry.channelId, {
          buffer: dl.buffer,
          filename: dl.name || 'alert-document',
          title: 'PM Alert – ' + alert.assetId,
          initialComment: message,
        });
        withDoc = true;
        doLog('[PMAlert] fan-out: posted to ' + entry.channelId + ' WITH document for ' + alert.assetId);
      }
    } catch (e) {
      doLog('[PMAlert] fan-out: file upload failed (' + e.message + ') — falling back to text-only');
    }
  }

  // Text-only post (either no doc, or upload failed).
  if (!withDoc) {
    try {
      await sendToChannel(entry.channelId, message); // top-level (no thread_ts)
      doLog('[PMAlert] fan-out: posted TEXT to ' + entry.channelId + ' for ' + alert.assetId);
    } catch (e) {
      doLog('[PMAlert] fan-out: text post FAILED: ' + e.message);
      return { sent: false, reason: 'send-failed' };
    }
  }

  // Record dedup.
  try {
    const ledger = store.load('pmAlertFanout', {}) || {};
    ledger[dedupKey] = { at: new Date().toISOString(), channelId: entry.channelId, asset: alert.assetId, withDoc };
    // Cap the ledger so it doesn't grow unbounded.
    const keys = Object.keys(ledger);
    if (keys.length > 2000) { keys.slice(0, keys.length - 2000).forEach((k) => delete ledger[k]); }
    store.save('pmAlertFanout', ledger);
  } catch (_) {}

  return { sent: true, channelId: entry.channelId, withDoc };
}

// ── Main entry: attempt a PM-alert auto-reply for one tagged message ──────────
// deps: { readThreadReplies, sendToChannel, askOrcha } — injected so this stays
// unit-testable and matches the channel-watch engine's existing modules.
// Returns { handled: bool, reply?, assetId?, matched?, reason? }.
async function handleTaggedPmAlert(ch, msg, myUserId, deps, log) {
  const doLog = log || ((m) => logger.info(m));
  const { readThreadReplies, sendToChannel, askOrcha, uploadFileToChannel, downloadFileBuffer } = deps || {};

  // 1) STRICT: the user must be LITERALLY @-tagged in THIS exact message.
  //    Slack renders a mention as "<@U0123>" or "<@U0123|display>" — match
  //    either form for the user's own id, and NOTHING else (no thread-membership
  //    inference, no "directed at me" guessing). This is the guard against the
  //    earlier bug where replies landed in threads that weren't the user's.
  if (!isTaggedIn(msg.text, myUserId)) {
    return { handled: false, reason: 'not-tagged' };
  }

  // 2) Parse the alert from the tagged message; if not found, fall back to the
  //    thread ROOT message (user is often tagged in a reply while the alert is
  //    the parent message).
  let alert = parseAlert(msg.text);
  let sourceText = msg.text;
  // The document to attach to the carrier lives on the message that CARRIES the
  // alert (the tagged msg, or — when tagged in a reply — the thread message that
  // actually is the alert). Track its files[] so the fan-out can re-upload it.
  let alertFiles = Array.isArray(msg.files) ? msg.files : [];
  if (!alert) {
    const rootTs = (msg.threadTs && msg.threadTs !== msg.ts) ? msg.threadTs : (msg.thread_ts || null);
    if (rootTs && typeof readThreadReplies === 'function') {
      try {
        const replies = await readThreadReplies(ch.id, rootTs, 30);
        // The root message is the one whose ts === threadTs; also scan all
        // thread messages for the first one that parses as an alert.
        const root = replies.find((r) => r.ts === rootTs);
        if (root && parseAlert(root.text)) { alert = parseAlert(root.text); sourceText = root.text; alertFiles = Array.isArray(root.files) ? root.files : []; }
        if (!alert) {
          for (const r of replies) {
            const a = parseAlert(r.text);
            if (a) { alert = a; sourceText = r.text; alertFiles = Array.isArray(r.files) ? r.files : []; break; }
          }
        }
      } catch (e) {
        doLog('[PMAlert] ' + ch.name + ': thread-root fetch failed: ' + e.message);
      }
    }
  }

  if (!alert) return { handled: false, reason: 'no-asset-id' };

  // 3) Look up the unit in fleet data.
  const unit = findUnit(alert.assetId);
  doLog('[PMAlert] ' + ch.name + ': tagged on alert for ' + alert.assetId +
    (unit ? (' — matched unit (' + (unit.lifecycleState || '?') + ')') : ' — no fleet match'));

  // 4) Ask the AI for the reply. The reply MUST be AI-written — the Orcha
  // backend is sometimes slow (observed 20s+), so RETRY (2 attempts × 30s with
  // a short pause) rather than falling back to the canned acknowledgment on the
  // first 20s timeout. Bounded to stay under the poll's 90s deadline (this is
  // awaited inside _pollLock): 2 × 30s + 1.5s pause ≈ 62s. The canned
  // acknowledgment is a LAST RESORT only if every attempt fails.
  const prompt = buildPrompt(alert, unit);
  let reply = '';
  const REPLY_ATTEMPTS = 2;
  const REPLY_ATTEMPT_MS = 30000;
  for (let attempt = 1; attempt <= REPLY_ATTEMPTS && !reply; attempt++) {
    try {
      const ai = await Promise.race([
        askOrcha(prompt),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ai-timeout')), REPLY_ATTEMPT_MS)),
      ]);
      reply = (ai && ai.text) ? String(ai.text).trim() : (typeof ai === 'string' ? ai.trim() : '');
      if (reply) {
        doLog('[PMAlert] ' + ch.name + ': AI reply generated (attempt ' + attempt + ')');
      } else {
        doLog('[PMAlert] ' + ch.name + ': AI reply empty (attempt ' + attempt + '/' + REPLY_ATTEMPTS + ')');
      }
    } catch (e) {
      doLog('[PMAlert] ' + ch.name + ': AI reply attempt ' + attempt + '/' + REPLY_ATTEMPTS + ' failed (' + e.message + ')');
    }
    if (!reply && attempt < REPLY_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1500)); // brief pause before retry
    }
  }
  // LAST-RESORT acknowledgment so the thread is never left unanswered if every
  // AI attempt fails.
  if (!reply) {
    doLog('[PMAlert] ' + ch.name + ': all ' + REPLY_ATTEMPTS + ' AI reply attempts failed — using fallback acknowledgment');
    reply = 'Received — reviewing ' + alert.assetId + ' and will align accordingly.';
  }

  // 5) Post in-thread (reply under the tagged message's thread).
  const threadTs = (msg.threadTs && msg.threadTs !== msg.ts) ? msg.threadTs : msg.ts;
  let replyTs = null;
  try {
    const res = await sendToChannel(ch.id, reply, threadTs);
    replyTs = res && res.ts;
  } catch (e) {
    doLog('[PMAlert] ' + ch.name + ': reply send FAILED: ' + e.message);
    return { handled: false, reason: 'send-failed', reply, assetId: alert.assetId };
  }

  doLog('[PMAlert] ' + ch.name + ': replied in-thread for ' + alert.assetId + (unit ? ' (matched)' : ' (ack only)'));

  // 6) CARRIER FAN-OUT (part 2): also post a top-level, AI-generated message to
  //    the unit's operator/carrier channel (tagging the operator owner) with
  //    the alert document attached. Best-effort and independent of the reply
  //    above — a fan-out failure never fails the in-thread acknowledgment.
  let fanout = { sent: false, reason: 'not-attempted' };
  try {
    fanout = await fanOutToCarrier(
      alert, unit, alertFiles,
      { sendToChannel, uploadFileToChannel, downloadFileBuffer, askOrcha },
      doLog
    );
  } catch (e) {
    doLog('[PMAlert] ' + ch.name + ': carrier fan-out error: ' + e.message);
  }

  return { handled: true, reply, replyTs, assetId: alert.assetId, matched: !!unit, fanout };
}

module.exports = {
  parseAlert,
  looksLikeAlert,
  isTaggedIn,
  findUnit,
  buildPrompt,
  handleTaggedPmAlert,
  buildCarrierPrompt,
  fanOutToCarrier,
  // Operator Channels config
  getOperatorChannels,
  saveOperatorChannels,
  listFleetOperators,
  resolveOperatorEntry,
};
