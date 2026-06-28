'use strict';
/**
 * deep-scan.js — Orcha Deep Scan: AI Truth Layer [V-C]
 * V-C changes vs V-B:
 *   - store required at module level (not via opts) — opts.store was always undefined
 *   - orcha_ws require path updated to src/scrapers/orcha_ws
 *   - console.log replaced with namespaced logger
 *   - pushStatus/pushData passed via opts (unchanged)
 *
 * Stage 4 Bug A fix (2026-06-28):
 *   - store was destructured from opts but all callers passed loadNotesStore/saveNotesStore
 *     callbacks instead. store was always undefined → TypeError on every scan run.
 *   - Fix: require store directly at module level. Drop opts.store entirely.
 *   - Call sites (sync/index.js, ipc/orcha.js) updated to stop passing loadNotesStore /
 *     saveNotesStore — those keys are now ignored if present (backwards-safe).
 */

const logger = require('../utils/logger')('deep-scan');
const store  = require('../store');   // Bug A fix: module-level require, not opts.store

/**
 * runOrchaDeepScan(mergedRows, opts)
 * @param {Array}  mergedRows - All merged unit rows (mutated in place)
 * @param {object} opts       - { pushData, pushStatus, payload, uptakeCount, relayCount }
 *   Note: opts.store / opts.loadNotesStore / opts.saveNotesStore are no longer used.
 *   The store module is required directly at the top of this file.
 */
async function runOrchaDeepScan(mergedRows, opts) {
  const { pushData, pushStatus, payload, uptakeCount, relayCount } = opts;

  // V-C: orcha_ws now lives in src/scrapers/
  const { askOrcha } = require('../scrapers/orcha_ws');

  const notesStore     = store.load('notesStore', {});
  const unitsToProcess = mergedRows.filter(u => {
    const lc    = (u.lifecycleState || '').toLowerCase();
    const ats   = (u.atsState       || '').toLowerCase();
    const relay = (u.relayStatus    || '').toLowerCase();
    return lc.includes('unavail') || ats.includes('unavail') || relay.includes('offsite');
  });

  logger.info(`⚡ Orcha Deep Scan: processing ${unitsToProcess.length} units...`);
  pushStatus(`🧠 Orcha analyzing ${unitsToProcess.length} units...`);
  let improved = 0;

  // Process in batches of 5
  for (let i = 0; i < unitsToProcess.length; i += 5) {
    const batch   = unitsToProcess.slice(i, i + 5);
    const results = await Promise.allSettled(batch.map(async u => {
      const ns             = notesStore[u.equipmentId] || {};
      const existingNotes  = ns.notes            || '';
      const repairStatus   = ns.repairStatus     || '';
      const component      = ns.primaryComponent || '';
      const fullConv       = u.fullConversation || u.lastConversation || u.conversation || '';
      const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' });

      const prompt = `You are an experienced Fleet Asset Specialist generating a work order note for unit ${u.equipmentId}.

INSTRUCTIONS:
Before writing ANY note, analyze the COMPLETE work order history and determine the TRUE current repair status.
Scan and analyze EVERY available source: work order comments, vendor comments, previous notes, timeline history, repair status, ETA updates, parts history, diagnostic history.

TIMELINE PROCESSING:
Internally build a complete chronological timeline. Sort every event oldest to newest.
For every update determine: Is this new info? Does it replace an older update? Does it change repair status? Is it duplicate?
Only meaningful events should influence the final note.

CURRENT STATUS — Determine the current repair stage:
Waiting for vendor | Appointment scheduled | Vehicle arrived | Under diagnosis | Diagnosis completed | Awaiting estimate | Awaiting approval | Parts ordered | Parts backordered | Parts received | Repair in progress | Waiting on vendor | Road test | Quality inspection | Ready for pickup | Repair completed | Work order closed
Always report the LATEST valid stage.

PRIVACY RULES — NEVER include:
Personal names, employee names, driver names, phone numbers, email addresses, dollar amounts, cost info, invoice numbers, VIN numbers, license plates, street addresses.
ALLOWED: Vendor names, domicile locations, repair status, vehicle status, ETA, repair progress, next action.

DUPLICATE DETECTION:
Before writing, compare against the most recent existing note. If nothing meaningful has changed, output ONLY:
${today} - No new repair updates. Pending vendor follow-up.
Only generate a new note when there is meaningful new information.

MEANINGFUL UPDATE TRIGGERS — Only create a new note if one or more changed:
Repair status, vendor update, ETA, appointment, parts status, diagnostic findings, repair completion, delay reason, vendor response, vehicle released, vehicle returned, repair paused, new issue discovered.
Otherwise leave the previous note unchanged.

SMART CONTEXT:
Include enough history for someone reading today to immediately understand where repairs stand.
Do not retell the entire repair history. Keep only the important context.

FOLLOW-UP INTELLIGENCE:
After building timeline, detect opportunities requiring attention:
- Vendor promised ETA but never provided one
- No repair progress for multiple days
- Work order appears stalled
- Parts on order without updates
- Scheduled appointment passed without progress
- Diagnosis complete but repairs not started
- Vendor comments contradict work order status
If appropriate, naturally include ONE short sentence like:
"No updated ETA has been provided." or "Continued vendor follow-up is recommended." or "Awaiting vendor confirmation."
Never exaggerate or speculate. Only state what is supported by available information.

INTELLIGENT DECISION MAKING:
If multiple updates exist: always trust the newest verified information.
If conflicting info: prefer the latest vendor update unless another verified source supersedes it.
If uncertain: state "Pending vendor confirmation." Never guess.

WRITING STYLE:
Professional, objective, chronological, concise, neutral. No opinions, no assumptions, no filler.
Rewrite into professional fleet terminology. Correct grammar, spelling, punctuation.
The note should read as though written by an experienced Fleet Asset Specialist.

NOTE FORMAT:
${today} - Professional repair summary.
Date format: MM/DD. No timestamps. No bullet points. No paragraphs.
Single sentence whenever possible. Target: 18-40 words. Maximum: 60 words.

SOURCE DATA:
Unit: ${u.equipmentId} | Alt: ${u.alternativeId || '—'}
Vendor: ${u.vendor || 'unassigned'}
Current Status: ${repairStatus || u.lifecycleReason || 'unknown'}
Component: ${component || 'unknown'}
Created: ${u.created || '—'}
${u.issueDetails ? 'Issue: ' + u.issueDetails.substring(0, 400) + '\n' : ''}
FULL WORK ORDER CONVERSATION:
${fullConv.substring(0, 2500) || '(no conversation available)'}

MOST RECENT EXISTING NOTE:
${existingNotes || '(no previous note — create initial note)'}

RESPOND IN EXACTLY THIS FORMAT:
SUMMARY: [1-2 sentences: current repair stage + what's next. Professional fleet language.]
NOTE: [Single line: "MM/DD - Professional repair summary." 18-60 words max.]`;

      const res = await askOrcha(prompt);
      if (!res || !res.ok || !res.text) return null;

      const text         = res.text;
      const summaryMatch = text.match(/SUMMARY:\s*(.+?)(?=\nNOTE:|$)/is);
      const noteMatch    = text.match(/NOTE:\s*([\s\S]+)/i);

      let summary        = summaryMatch ? summaryMatch[1].trim() : null;
      let correctedNotes = noteMatch    ? noteMatch[1].trim()    : null;

      // Strip markdown formatting (BUG-002 fix carried forward)
      if (summary)        summary        = summary.replace(/^\*{1,2}\s*/, '').replace(/\s*\*{1,2}$/, '');
      if (correctedNotes) correctedNotes = correctedNotes.replace(/^\*{1,2}\s*/, '').replace(/\s*\*{1,2}$/, '');
      if (correctedNotes && correctedNotes.length > 300) correctedNotes = correctedNotes.substring(0, 300).trim();

      return { equipmentId: u.equipmentId, summary, correctedNotes, existingNotes };
    }));

    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const val = r.value;

      if (val.summary || val.correctedNotes) {
        const row = mergedRows.find(x => x.equipmentId === val.equipmentId);
        if (row) {
          if (val.summary)        { row.issueSummary = val.summary; row.issue = val.summary; }
          if (val.correctedNotes)   row.repairTimeline = val.correctedNotes;
          row._orchaProcessed   = true;
          row._orchaProcessedAt = new Date().toISOString();
        }
      }

      if (val.correctedNotes && val.correctedNotes !== 'none') {
        const isNew     = !val.existingNotes;
        const isChanged = val.existingNotes &&
          val.correctedNotes.toLowerCase() !== val.existingNotes.toLowerCase();
        if (isNew || isChanged) {
          const ns = notesStore[val.equipmentId] || {};
          ns.notes             = val.correctedNotes;
          ns._lastAiCorrection = new Date().toISOString();
          if (isNew) ns._autoGenerated = true;
          notesStore[val.equipmentId] = ns;
          improved++;
        }
      }
    }
  }

  if (improved > 0) {
    store.save('notesStore', notesStore);
    logger.info(`⚡ Orcha corrected notes on ${improved} units`);
  }

  payload.rows = mergedRows;
  pushData(payload);
  const t2 = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  pushStatus(
    `✅ Live · ${mergedRows.length} units · ${uptakeCount} Uptake · ` +
    `${relayCount} Relay · 🧠 ${unitsToProcess.length} AI · ${t2}`
  );
  logger.info(
    `⚡ Deep Scan complete — ${unitsToProcess.length} summaries, ${improved} notes corrected`
  );

  return { processed: unitsToProcess.length, improved };
}

module.exports = { runOrchaDeepScan };
