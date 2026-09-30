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
  const t = String(text || '');
  if (!t) return null;

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

// ── Main entry: attempt a PM-alert auto-reply for one tagged message ──────────
// deps: { readThreadReplies, sendToChannel, askOrcha } — injected so this stays
// unit-testable and matches the channel-watch engine's existing modules.
// Returns { handled: bool, reply?, assetId?, matched?, reason? }.
async function handleTaggedPmAlert(ch, msg, myUserId, deps, log) {
  const doLog = log || ((m) => logger.info(m));
  const { readThreadReplies, sendToChannel, askOrcha } = deps || {};

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
  if (!alert) {
    const rootTs = (msg.threadTs && msg.threadTs !== msg.ts) ? msg.threadTs : (msg.thread_ts || null);
    if (rootTs && typeof readThreadReplies === 'function') {
      try {
        const replies = await readThreadReplies(ch.id, rootTs, 30);
        // The root message is the one whose ts === threadTs; also scan all
        // thread messages for the first one that parses as an alert.
        const root = replies.find((r) => r.ts === rootTs);
        if (root && parseAlert(root.text)) { alert = parseAlert(root.text); sourceText = root.text; }
        if (!alert) {
          for (const r of replies) {
            const a = parseAlert(r.text);
            if (a) { alert = a; sourceText = r.text; break; }
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

  // 4) Ask the AI for the reply.
  let reply = '';
  try {
    const prompt = buildPrompt(alert, unit);
    const ai = await Promise.race([
      askOrcha(prompt),
      new Promise((_, rej) => setTimeout(() => rej(new Error('ai-timeout')), 20000)),
    ]);
    reply = (ai && ai.text) ? String(ai.text).trim() : (typeof ai === 'string' ? ai.trim() : '');
  } catch (e) {
    doLog('[PMAlert] ' + ch.name + ': AI reply failed (' + e.message + ') — using fallback acknowledgment');
  }
  // Safety fallback so the thread is never left unacknowledged if the AI fails.
  if (!reply) {
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
  return { handled: true, reply, replyTs, assetId: alert.assetId, matched: !!unit };
}

module.exports = {
  parseAlert,
  looksLikeAlert,
  isTaggedIn,
  findUnit,
  buildPrompt,
  handleTaggedPmAlert,
};
