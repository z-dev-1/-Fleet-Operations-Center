'use strict';
/**
 * deep-scan.js -- Orcha Deep Scan: AI Truth Layer [V-C]
 *
 * Fixes (2026-07-01):
 *   - Filter uses lifecycleState + lifecycleReason (atsState does not exist on merged rows)
 *   - existingNotes reads row.savedNotes first (catches mid-session manual edits before store)
 *   - repairStatus + primaryComponent now extracted from AI response and saved to notesStore
 *   - on-demand IPC path (payload has no uptakeCount/relayCount) handled gracefully
 *   - Per-unit 45s timeout so one hung AI call cannot stall entire batch
 *   - fullConversation raised to 3500 chars (relay data is rich)
 *   - AI response format extended: REPAIR_STATUS + PRIMARY_COMPONENT + SUMMARY + NOTE
 */

const logger = require('../utils/logger')('deep-scan');
const store  = require('../store');

const UNIT_TIMEOUT_MS = 180000;

// Post-processing: strip dollar amounts AI may have included despite instructions
function _stripCosts(text) {
  if (!text) return text;
  return text
    .replace(/\s*\$[\d,]+\.?\d*\s*/g, ' ')   // Remove $X,XXX.XX
    .replace(/\s+at\s+\.\s*/g, '. ')          // "approved at ." → "approved."
    .replace(/\s+at\s+under\s/g, ' under ')   // "approved at under" → "approved under"
    .replace(/\s{2,}/g, ' ')                   // collapse double spaces
    .replace(/ \./g, '.')                      // space before period
    .trim();
}

function _withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('unit timeout: ' + label)), ms)),
  ]);
}

/**
 * runOrchaDeepScan(mergedRows, opts)
 * @param {Array}  mergedRows - All merged unit rows (mutated in place)
 * @param {object} opts       - { pushData, pushStatus, payload, uptakeCount, relayCount }
 */
async function runOrchaDeepScan(mergedRows, opts) {
  const { pushData, pushStatus, payload } = opts;
  const uptakeCount = opts.uptakeCount || 0;
  const relayCount  = opts.relayCount  || 0;

  // V-C: orcha_ws lives in src/scrapers/
  // Use relay.ask for deep-scan (reliable, proven connection)
    const relay = require('../orcha/relay');
    const askOrcha = async (prompt) => {
      try {
        const text = await relay.ask(prompt);
        return text ? { ok: true, text } : { ok: false, error: 'empty response' };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    };

  const notesStore = store.load('notesStore', {});

  // Filter: units that need attention
  // Uses lifecycleState + lifecycleReason — atsState does not exist on merged rows
  const unitsToProcess = mergedRows.filter(u => {
    const lc     = (u.lifecycleState  || '').toLowerCase();
    const reason = (u.lifecycleReason || '').toLowerCase();
    return lc.includes('unavail') || reason.includes('offsite');
  });

  logger.info('Orcha Deep Scan: processing ' + unitsToProcess.length + ' units...');
  pushStatus('\uD83E\uDDE0 Orcha analyzing ' + unitsToProcess.length + ' units...');
  let improved = 0;

  // Process in batches of 5 with per-unit timeout
  // BUG FIX (2026-07-16): loop advanced by 2 but each batch below slices 5
  // units (i, i+5) — overlapping windows caused most units to be sent to
  // the AI 2-3x each (verified live: units 124124/39309/39351/892476/39582
  // each processed 3x in a single 42-unit scan, several others 2x). No
  // dedup guard exists in _processUnit(), so every repeat run re-did the
  // full work (including a real offsite scrape + AI call) for zero
  // benefit — the later duplicate result just silently overwrote the
  // earlier one in notesStore. Advancing by 5 (matching the slice window)
  // restores the non-overlapping batching the comment above intends.
  const allResults = []; // collect all settled results across batches for post-scan detection
  for (let i = 0; i < unitsToProcess.length; i += 5) {
    const batch   = unitsToProcess.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(u => _processUnit(u, notesStore, askOrcha))
    );
    allResults.push(...results);

    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) {
        if (r.status === 'rejected') logger.warn('Deep scan unit failed: ' + (r.reason && r.reason.message));
        continue;
      }
      const val = r.value;

      // Save to notesStore
      let isChanged = false;
      const ns = notesStore[val.equipmentId] || {};

      // Apply results to the live row
      const row = mergedRows.find(x => x.equipmentId === val.equipmentId);
      if (row) {
        if (val.summary)          { row.issueSummary = val.summary; row.issue = val.summary; }
        if (val.timeline) {
          // AI regenerates the timeline purely from raw vendor/WO comments -- it has no
          // awareness of previously manually-added lines. Merge them back in so a rescan
          // never silently discards user-entered timeline entries (immutable truth).
          row.repairTimeline = _sortTimelineChronologically(_filterHiddenEntries(_mergeManualEntries(_stripCosts(val.timeline), ns.manualEntries), ns.hiddenEntries));
        }
        if (val.correctedNotes)     row.savedNotes = val.correctedNotes;
        if (val.repairStatus)       row.savedRepairStatus = val.repairStatus;
        if (val.primaryComponent)   row.savedPrimaryComponent = val.primaryComponent;
        row._orchaProcessed   = true;
        row._orchaProcessedAt = new Date().toISOString();
      }

      if (val.correctedNotes && val.correctedNotes !== 'none') {
        const prevNote    = ns.notes || '';
        const noteChanged = val.correctedNotes.toLowerCase() !== prevNote.toLowerCase();
        if (!prevNote || noteChanged) {
          ns.notes             = val.correctedNotes;
          ns._lastAiCorrection = new Date().toISOString();
          if (!prevNote) ns._autoGenerated = true;
          isChanged = true;
          improved++;
        }
      }

      // Save timeline + issueSummary to notesStore
      // Merge AI-regenerated timeline with prior manual entries so a rescan never
      // silently drops user-entered lines (immutable truth).
      if (val.timeline) { ns.timeline = _sortTimelineChronologically(_filterHiddenEntries(_mergeManualEntries(val.timeline, ns.manualEntries), ns.hiddenEntries)); isChanged = true; }

      if (val.summary) { ns.issueSummary = val.summary; isChanged = true; }

      // Only set repairStatus/primaryComponent if not already saved by user
      if (val.repairStatus && !ns.repairStatus) {
        ns.repairStatus = val.repairStatus;
        isChanged = true;
      }
      if (val.primaryComponent && !ns.primaryComponent) {
        ns.primaryComponent = val.primaryComponent;
        isChanged = true;
      }

      if (isChanged) notesStore[val.equipmentId] = ns;
    }
  }

  // Always save notesStore (timelines + issueSummary + status)
  store.save('notesStore', notesStore);

  // ── Repair-complete detection ─────────────────────────────────────────────
  // After processing timelines, check each unit's latest entries for
  // completion signals. Notify the user immediately so they can flip the unit
  // back to available. Fires once per unit per day (localStorage gate) to
  // avoid repeat notifications on subsequent scan cycles.
  const REPAIR_DONE_RE = /\b(repair[s]?\s+(complete[d]?|finished|done)|ready\s+for\s+(pickup|release|return)|road[- ]?test(ed)?|release[d]?\s+(back\s+to|to)\s+(fleet|service|active)|complete[d]?\s+and\s+(ready|released)|flip(ped|ping)?\s+(to|back)\s+(a\/h|available|active)|unit\s+(returned|released|flipped)|work\s+complete[d]?)/i;
  const _today = new Date().toISOString().slice(0, 10);
  const _repairDoneUnits = [];

  // ── Out-of-scope / needs dealer detection ─────────────────────────────────
  // Vendor says they can't do the work — unit needs re-routing. Immediate
  // action required (find another vendor or send to dealer).
  const OUT_OF_SCOPE_RE = /\b(out\s+of\s+scope|outside\s+(our|their|roadside)?\s*scope|cannot\s+(repair|complete|perform|diagnose)|unable\s+to\s+(repair|complete|perform|diagnose)|not\s+(equipped|capable|able)\s+to|beyond\s+(our|their)\s+(capability|scope)|need[s]?\s+to\s+go\s+to\s+(a\s+)?(dealer|oem|shop)|refer(red|ring)?\s+to\s+(dealer|oem)|send\s+to\s+(dealer|oem)|tow\s+to\s+(dealer|oem)|requires?\s+(dealer|oem)\s+(repair|service|diagnosis)|dealer\s+only|oem\s+only|not\s+a\s+roadside\s+(repair|service))/i;
  const _outOfScopeUnits = [];

  for (const r of allResults) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const val = r.value;
    const unitId = val.equipmentId;
    const row = mergedRows.find(x => x.equipmentId === unitId);
    if (!row) continue;

    // Check repair status field
    const status = (val.repairStatus || '').toLowerCase();
    const statusDone = /complete[d]?|finished|ready for (pickup|release|return)/i.test(status);

    // Check last 2 timeline lines for completion language
    const tl = (row.repairTimeline || '').trim();
    const lastLines = tl ? tl.split('\n').filter(Boolean).slice(-2).join(' ') : '';
    const timelineDone = REPAIR_DONE_RE.test(lastLines);

    if (statusDone || timelineDone) {
      // De-dupe: only notify once per unit per day (uses notesStore field)
      const ns2 = notesStore[unitId] || {};
      if (ns2._repairDoneNotifDate === _today) continue;
      _repairDoneUnits.push({
        id: unitId,
        vendor: row.vendor || '?',
        site: row.domicileSite || '',
        signal: statusDone ? 'status: ' + (val.repairStatus || '') : lastLines.slice(-80),
      });
      // Mark notified today
      if (!notesStore[unitId]) notesStore[unitId] = {};
      notesStore[unitId]._repairDoneNotifDate = _today;
    }

    // Out-of-scope / needs dealer — check last 3 timeline lines
    const scopeLines = tl ? tl.split('\n').filter(Boolean).slice(-3).join(' ') : '';
    const isOutOfScope = OUT_OF_SCOPE_RE.test(scopeLines);
    if (isOutOfScope) {
      const ns3 = notesStore[unitId] || {};
      if (ns3._outOfScopeNotifDate !== _today) {
        _outOfScopeUnits.push({
          id: unitId,
          vendor: row.vendor || '?',
          site: row.domicileSite || '',
          signal: scopeLines.slice(-100),
        });
        if (!notesStore[unitId]) notesStore[unitId] = {};
        notesStore[unitId]._outOfScopeNotifDate = _today;
      }
    }
  }

  // Send notifications for units detected as repair-complete
  if (_repairDoneUnits.length) {
    logger.info('Repair-complete detected: ' + _repairDoneUnits.map(u => u.id).join(', '));
    // Renderer notification
    if (pushData && typeof pushData === 'function') {
      try {
        const mainWin = require('electron').BrowserWindow.getAllWindows()[0];
        if (mainWin && !mainWin.isDestroyed()) {
          _repairDoneUnits.forEach(u => {
            mainWin.webContents.send('ui:notif-push', {
              icon: '✅',
              title: 'Repair Complete: ' + u.id,
              body: u.vendor + (u.site ? ' @ ' + u.site : '') + ' — ' + u.signal,
              time: Date.now(),
            });
          });
        }
      } catch (_) {}
    }
    // Slack self-DM (Just Me channel) — batch all into one message
    try {
      const slackSend = require('../scrapers/slack_send');
      const slackConfig = store.load('slackChannelWatchConfig', {});
      const justMeCh = (slackConfig.channels || []).find(ch => ch.mode === 'justme');
      if (justMeCh && justMeCh.id) {
        const msg = '✅ *Repair Complete — Ready to Flip*\n' +
          _repairDoneUnits.map(u => `• *${u.id}* (${u.vendor}${u.site ? ' @ ' + u.site : ''}) — ${u.signal}`).join('\n') +
          '\n\n_These units appear done based on their latest timeline. Verify and flip to Available._';
        await slackSend.sendToChannel({ channelId: justMeCh.id, message: msg }).catch(e => logger.warn('Repair-done Slack notify failed:', e.message));
      }
    } catch (_) {}
  }

  // Send notifications for units detected as out-of-scope / needs dealer
  if (_outOfScopeUnits.length) {
    logger.info('Out-of-scope/needs-dealer detected: ' + _outOfScopeUnits.map(u => u.id).join(', '));
    try {
      const mainWin = require('electron').BrowserWindow.getAllWindows()[0];
      if (mainWin && !mainWin.isDestroyed()) {
        _outOfScopeUnits.forEach(u => {
          mainWin.webContents.send('ui:notif-push', {
            icon: '⚠️',
            title: 'Out of Scope: ' + u.id,
            body: u.vendor + (u.site ? ' @ ' + u.site : '') + ' — needs re-routing to dealer/OEM',
            time: Date.now(),
          });
        });
      }
    } catch (_) {}
    // Slack self-DM
    try {
      const slackSend2 = require('../scrapers/slack_send');
      const slackConfig2 = store.load('slackChannelWatchConfig', {});
      const justMeCh2 = (slackConfig2.channels || []).find(ch => ch.mode === 'justme');
      if (justMeCh2 && justMeCh2.id) {
        const msg2 = '⚠️ *Out of Scope / Needs Dealer*\n' +
          _outOfScopeUnits.map(u => `• *${u.id}* (${u.vendor}${u.site ? ' @ ' + u.site : ''}) — ${u.signal}`).join('\n') +
          '\n\n_These units need re-routing. The current vendor cannot complete the repair — route to dealer/OEM._';
        await slackSend2.sendToChannel({ channelId: justMeCh2.id, message: msg2 }).catch(e => logger.warn('Out-of-scope Slack notify failed:', e.message));
      }
    } catch (_) {}
  }

  if (improved > 0) {
    logger.info('Orcha corrected notes on ' + improved + ' units');
  }

  payload.rows = mergedRows;
  pushData(payload);

  const t2 = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  pushStatus(
    '\u2705 Live \u00B7 ' + mergedRows.length + ' units \u00B7 ' +
    uptakeCount + ' Uptake \u00B7 ' + relayCount + ' Relay \u00B7 ' +
    '\uD83E\uDDE0 ' + unitsToProcess.length + ' AI \u00B7 ' + t2
  );
  logger.info('Deep Scan complete -- ' + unitsToProcess.length + ' summaries, ' + improved + ' notes corrected');

  return { processed: unitsToProcess.length, improved };
}

/**
 * _processUnit -- runs AI on a single unit, returns structured result
 */
async function _processUnit(u, notesStore, askOrcha) {
  const ns               = notesStore[u.equipmentId] || {};
  // Read existingNotes from the row first (reflects mid-session manual edits)
  // then fall back to what's in the store
  const existingNotes    = u.savedNotes || ns.notes || '';
  const repairStatus     = u.savedRepairStatus     || ns.repairStatus     || '';
  const primaryComponent = u.savedPrimaryComponent || ns.primaryComponent || '';
  // Strip page header — only send the Conversation section (comments) to AI
  let fullConv = u.fullConversation || u.lastConversation || u.conversation || '';
  const convoStart = fullConv.indexOf('Conversation');
  if (convoStart > 0) fullConv = fullConv.substring(convoStart);

  // Second (Planned) work order: PM Failed / Expired Inspection units can have
  // an open Unplanned WR (above, primary) AND an open Planned WR at the same
  // time (relay.js second-pass scrape -> u._plannedWRData). Both are active
  // repair threads with their own vendor conversations -- if we only ever feed
  // the AI the primary conversation, the Planned WR's updates never make it
  // into the timeline even though that work order is genuinely in progress.
  let plannedConv = '';
  if (u._plannedWRData && u._plannedWRData.fullConversation) {
    plannedConv = u._plannedWRData.fullConversation;
    const pStart = plannedConv.indexOf('Conversation');
    if (pStart > 0) plannedConv = plannedConv.substring(pStart);
    plannedConv = plannedConv.substring(0, 3500);
  }

  // Secondary work orders (multi-WR pass -> u._secondaryWRs): a unit can have
  // MORE than two open WRs (e.g. unit 39263: primary CBRE + secondary
  // "Volvo (ASIST)"). Each secondary WR is its own active repair thread with
  // its own vendor conversation. FIX (2026-08-17): these were never fed to the
  // timeline builder, so their notes/comments were silently dropped. Collect
  // each secondary WR's conversation so the AI sees ALL work orders' activity.
  const secondaryConvs = [];
  if (Array.isArray(u._secondaryWRs) && u._secondaryWRs.length) {
    u._secondaryWRs.forEach(function (w, idx) {
      let sConv = (w && w.fullConversation) || '';
      if (!sConv) return;
      const sStart = sConv.indexOf('Conversation');
      if (sStart > 0) sConv = sConv.substring(sStart);
      sConv = sConv.substring(0, 3500);
      if (sConv.trim()) {
        secondaryConvs.push({
          label:  (w._wrType === 'planned' ? 'Planned #' : 'Unplanned #') + (idx + 2), // #2, #3... (primary=#1)
          vendor: w.vendor || 'vendor unknown',
          conv:   sConv,
        });
      }
    });
  }
  const hasSecondary = secondaryConvs.length > 0;

  // Offsite enrichment: if unit has a Decisiv URL, scrape vendor notes
  let offsiteText = '';
  const offsiteUrl = u.offsiteShopEventUrl || u.asistSrUrl || '';
  if (offsiteUrl && /decisiv\.net/i.test(offsiteUrl)) {
    try {
      const { enrichVolvoAsist } = require('../scrapers/asist_enrich');
      const enrichResult = await enrichVolvoAsist(offsiteUrl);
      if (enrichResult && enrichResult.ok && enrichResult.offsiteText) {
        offsiteText = enrichResult.offsiteText.substring(0, 3000);
        u.asistScrapedAt = enrichResult.scrapedAt;
        u.asistSource = enrichResult.source;
        u.asistLabel = enrichResult.bestLabel;
        u.asistSrUrl = enrichResult.bestUrl || offsiteUrl;
        logger.info('[DS] Offsite enriched for ' + u.equipmentId + ' | ' + enrichResult.source + ' | ' + offsiteText.length + 'ch');
      }
    } catch (e) {
      logger.warn('[DS] Offsite enrich failed for ' + u.equipmentId + ': ' + e.message);
    }
  }
  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' });

  const prompt =
    'You are Orcha, the AI brain for Fleet Operations. Generate the OFFICIAL repair timeline for unit ' + u.equipmentId + '.\n\n' +
    'PURPOSE:\n' +
    'This timeline is the official repair status report sent directly to business partners and management. Every line must be a professional coordinator update — NOT a message transcript.\n\n' +
    'VOICE:\n' +
    'Write as a fleet maintenance coordinator providing status updates to partners. Professional, concise, actionable. Each entry answers: what is the current repair state and what happens next.\n\n' +
    'CRITICAL RULES:\n' +
    '1. TRANSFORM raw messages into professional updates:\n' +
    '   "@TA Please update on repairs and provide ETC" → "Requested vendor repair progress and estimated completion. Pending vendor response."\n' +
    '   "NEED APPROVAL TO ORDER PARTS BETSY TA" → "Vendor requesting parts approval to proceed."\n' +
    '   "est approved $13,977.68" → "Estimate approved. Vendor authorized to proceed with repairs."\n' +
    '   "Called TA spoken with Christina said parts on order" → "Contacted vendor; parts remain on order. ETA pending."\n' +
    '   "UNIT IS IN BAY ALL PARTS ARE HERE SHOULD BE COMPLETED BY 07 01" → "All parts received. Unit in bay. Vendor estimates completion 07/01."\n' +
    '   "circling back for a quick new update" → "Follow-up requested from vendor. Pending response."\n' +
    '   "has this been completed TA" → "Requested completion confirmation from vendor. Pending response."\n' +
    '   "Dealer previously incorrectly labeled unit as ready for pick up. NOT ready." → "Dealer corrected prior ready-for-pickup status. Unit NOT ready. Awaiting further update."\n' +
    '   "unit is now ready for the pick up, Due to the holiday unit is closed. Needs to be picked up on 7/6" → "Unit confirmed ready for pickup. Scheduled pickup 07/06 (dealer closed for holiday)."\n' +
    '   "WE ARE CURRENTLY WAITING ON THE HOOD SHOCKS IN ADDITION TO THE REAR AIRBAGS" → "Vendor awaiting parts: hood shocks, rear airbags, rear shocks. Parts ETA 06/29."\n' +
    '   "SOURCING VENDOR FOR PAINTING OF HOOD" → "Vendor sourcing subcontractor for hood painting."\n' +
    '   "Failed AC Expansion Valve - Pending a parts eta from Peterbilt" → "Diagnosis: failed AC expansion valve. Parts ETA pending from dealer."\n' +
    '   "Parts now on hand" → "All parts received. Repairs to proceed."\n' +
    '   "Repair Order Completed by Technician" → "Repairs completed by technician."\n' +
    '   "Approved V2 $12,751.47. R360 reconditioning — hood, step fairing, camera, CEL diag" → "Revised estimate approved. Scope: hood, step fairing, camera, CEL diagnostic."\n\n' +
    '2. PROHIBITED — ZERO TOLERANCE (including ANY of these invalidates the entire output):\n' +
    '   - Dollar amounts ($), costs, prices, totals, invoice amounts\n' +
    '   - Personal names (first or last), usernames, login IDs\n' +
    '   - Phone numbers, email addresses\n' +
    '   - VINs, license plates, street addresses\n' +
    '   - Gate codes, POC contact info\n' +
    '   - Raw vendor signatures (e.g., "BETSY TA", "CHRISTINA", "MARK L TA")\n\n' +
    '3. ALLOWED in output:\n' +
    '   - Vendor company names: Amerit, Volvo, TA, Kooner, Freightliner, Kenworth, DCLI, Goodyear, Cox\n' +
    '   - Dealer location names: Bergey s Pennsauken, M&K Dunmore, Gabrielli Bloomsbury\n' +
    '   - Case/reference numbers: ASIST case, Salesforce case, estimate record IDs\n' +
    '   - Part names and repair actions\n' +
    '   - Domicile codes (ABE40, PHL40, etc.)\n' +
    '   - Dates and ETAs\n\n' +
    '4. SKIP entirely (do NOT create a timeline entry for):\n' +
    '   - "SM/NRA", "W/NRA", "NRA" (internal shorthand)\n' +
    '   - "afp pilot est", "afp pilot pv" (internal process codes)\n' +
    '   - "One-click Connect Number: ..." (system auto-generated)\n' +
    '   - "RelayGarage" alone or "Yard Location Update" (system artifacts)\n' +
    '   - "Added by [username]" (system metadata)\n' +
    '   - URL-only comments with no context (ASIST/Decisiv links)\n' +
    '   - "VRE OVERRIDE" entries (internal system action)\n' +
    '   - Repeated follow-ups on the same day with no new info (combine into one)\n\n' +
    '5. GAP DAYS:\n' +
    '   - Consolidate consecutive days with no activity into ONE range: "06/13-06/17 - [no update logged]"\n' +
    '   - Only show gap ranges between actual events\n' +
    '   - NEVER list individual "[no update logged]" days separately\n\n' +
    '6. SAME-DAY entries:\n' +
    '   - Multiple comments on the same day that relate to the same action → combine into ONE line\n' +
    '   - Different actions on the same day → separate lines with same date\n\n' +
    '7. ACCURACY:\n' +
    '   - NEVER invent or fabricate. Only write what is supported by actual comment text.\n' +
    '   - If a comment is unclear, extract only what is factually stated.\n' +
    '   - Include the MOST RECENT comments — they are the most important for current status.\n\n' +
    '7b. NO VENDOR COMMENTS YET (important):\n' +
    '   - If the conversation feed is empty or has no substantive comments, DO NOT output "[no activity logged]".\n' +
    '   - Instead build a baseline timeline from the known work-order facts provided above\n' +
    '     (WO Created date, current State/Status, vendor, and the work type/issue). Example:\n' +
    '       "MM/DD - Work order created with [vendor] for [work type]. [Current state]."\n' +
    '     then a gap-range line up to today if the created date is older, e.g. "MM/DD-MM/DD - Awaiting vendor update."\n' +
    '   - Use ONLY the WO facts given — do not invent comments or repair steps that were never stated.\n' +
    '   - Only fall back to "[no activity logged]" when there is NO WO created date AND no status at all.\n\n' +
    ((plannedConv || hasSecondary) ?
      '8. MULTIPLE ACTIVE WORK ORDERS:\n' +
      '   This unit has MORE THAN ONE open work order (the primary Unplanned WR conversation above' +
      (plannedConv ? ', an open Planned WR' : '') +
      (hasSecondary ? ', and ' + secondaryConvs.length + ' additional work order(s)' : '') +
      ' -- each with its own conversation below). Produce timeline entries for EVERY work order -- ' +
      'do not drop any. Prefix every entry with which WR it belongs to, e.g. "07/15 - [Unplanned] ' +
      'Requested vendor repair update." or "07/10 - [Planned] PM B service scheduled." Merge entries ' +
      'from ALL work orders into ONE chronological timeline sorted by date.\n\n' : '') +
    'ALSO PROVIDE:\n' +
    'REPAIR_STATUS: [current stage: Waiting for vendor | Appointment scheduled | Vehicle arrived | Under diagnosis | Diagnosis completed | Awaiting estimate | Awaiting approval | Parts ordered | Parts backordered | Parts received | Repair in progress | Road test | Quality inspection | Ready for pickup | Repair completed | Work order closed]\n' +
    'PRIMARY_COMPONENT: [exactly one: ENGINE/MOTOR SYSTEMS | CHASSIS | ELECTRICAL | CAB/CLIMATE CONTROL/INSTRUMENTATION | ACCESSORIES]\n' +
    'ISSUE: [One short sentence max 120 chars: the mechanical failure/complaint. NOT the repair status.]\n\n' +
    'SOURCE DATA:\n' +
    'Unit: ' + u.equipmentId + ' | Vendor: ' + (u.vendor || 'unassigned') + ' | Domicile: ' + (u.domicileSite || '--') + '\n' +
    'Lifecycle: ' + (u.lifecycleState || '--') + ' / ' + (u.lifecycleReason || '--') + '\n' +
    'Current Status: ' + (repairStatus || 'unknown') + ' | Component: ' + (primaryComponent || 'unknown') + '\n' +
    'WO Created: ' + (u.created || '--') + '\n' +
    (u.serviceState ? 'WO State: ' + u.serviceState + '\n' : '') +
    (u.issueDetails ? 'Issue: ' + u.issueDetails.substring(0, 300) + '\n' : '') +
    '\nRELAY GARAGE CONVERSATION (Unplanned WR):\n' +
    (fullConv || '(no conversation)') + '\n\n' +
    (plannedConv ? 'RELAY GARAGE CONVERSATION (Planned WR -- ' + (u._plannedWRData.vendor || 'vendor unknown') + '):\n' + plannedConv + '\n\n' : '') +
    (hasSecondary ? secondaryConvs.map(function (s) {
      return 'RELAY GARAGE CONVERSATION (' + s.label + ' WR -- ' + s.vendor + '):\n' + s.conv + '\n\n';
    }).join('') : '') +
    (offsiteText ? 'OFFSITE/VENDOR NOTES (Decisiv/ASIST):\n' + offsiteText + '\n\n' : '') +
    'RESPOND IN EXACTLY THIS FORMAT (no markdown, no backticks):\n' +
    'REPAIR_STATUS: [stage]\n' +
    'PRIMARY_COMPONENT: [component]\n' +
    'ISSUE: [description]\n' +
    'TIMELINE:\n' +
    'MM/DD - [professional update]\n' +
    'MM/DD - [professional update]\n' +
    '...\n';

  const res = await askOrcha(prompt);
  if (!res || !res.ok || !res.text) return null;

  const text = res.text;
  logger.info('[DS] Unit ' + u.equipmentId + ' | resp ' + text.length + 'ch | has TIMELINE: ' + text.includes('TIMELINE:') + ' | first100: ' + text.substring(0, 100).replace(/\n/g, '|'));

  const repairStatusMatch     = text.match(/REPAIR_STATUS:\s*(.+?)(?=\n|$)/i);
  const primaryComponentMatch = text.match(/PRIMARY_COMPONENT:\s*(.+?)(?=\n|$)/i);
  const summaryMatch          = text.match(/ISSUE:\s*([^\n]+)/i);
  const timelineMatch         = text.match(/TIMELINE:\s*([\s\S]+?)(?=\nNOTE:|$)/i);
  const noteMatch             = text.match(/NOTE:\s*([\s\S]+)/i);

  const stripMd = s => s ? s.replace(/^\*{1,2}\s*/, '').replace(/\s*\*{1,2}$/, '').trim() : s;

  let parsedRepairStatus     = stripMd(repairStatusMatch    ? repairStatusMatch[1].trim()    : null);
  let parsedPrimaryComponent = stripMd(primaryComponentMatch ? primaryComponentMatch[1].trim() : null);
  let summary                = stripMd(summaryMatch         ? summaryMatch[1].trim()         : null);
  // Issue summary must be SHORT (1-2 sentences, max 200 chars) - it's the quick description, not the timeline
  if (summary && summary.length > 150) summary = summary.substring(0, 150).replace(/\s\S*$/, '').trim();
  let timeline               = timelineMatch ? timelineMatch[1].trim() : null;
  let correctedNotes         = stripMd(noteMatch            ? noteMatch[1].trim()            : null);

  // Validate PRIMARY_COMPONENT against known list
  const VALID_PC = ['ENGINE/MOTOR SYSTEMS', 'CHASSIS', 'ELECTRICAL', 'CAB/CLIMATE CONTROL/INSTRUMENTATION', 'ACCESSORIES'];
  if (parsedPrimaryComponent) {
    const up = parsedPrimaryComponent.toUpperCase();
    parsedPrimaryComponent = VALID_PC.includes(up) ? up : null;
  }

  // Enforce note length cap
  // If no explicit NOTE but we have SUMMARY, generate note from it
  if (!correctedNotes && summary) {
    const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' });
    correctedNotes = today + ' - ' + summary;
  }
  if (correctedNotes && correctedNotes.length > 300) correctedNotes = correctedNotes.substring(0, 300).trim();

    // Cap the timeline length, but keep the MOST RECENT entries. The old code
    // did `substring(0, 2000)` which kept the OLDEST 2000 chars and silently
    // dropped the newest — so a long multi-week / multi-WR repair (e.g. 321950,
    // whose conversation runs to the current week) had its latest activity
    // chopped off, making the stored timeline look stale even though the scan
    // ran. Raised the cap to 6000 (a full multi-WO repair needs the room) and,
    // when trimming is still needed, drop whole OLD lines from the top and keep
    // the recent tail, with a marker so it's clear earlier history was trimmed.
    const TIMELINE_MAX = 6000;
    if (timeline && timeline.length > TIMELINE_MAX) {
      const _lines = timeline.split('\n');
      while (_lines.length > 1 && _lines.join('\n').length > TIMELINE_MAX - 40) {
        _lines.shift(); // drop oldest line first (timeline is chronological)
      }
      timeline = '(earlier history trimmed)\n' + _lines.join('\n');
    }

  return {
    equipmentId:      u.equipmentId,
    summary,
    correctedNotes,
    timeline,
    repairStatus:     parsedRepairStatus,
    primaryComponent: parsedPrimaryComponent,
    existingNotes,
  };
}

/**
 * _mergeManualEntries -- merges user/manually-confirmed timeline lines back into
 * an AI-regenerated timeline. The deep-scan AI prompt only sees raw vendor/WO
 * comments, so it has zero awareness of previously manually-added lines --
 * without this merge, every rescan would silently discard them.
 *
 * A manual entry is skipped only if its text (date prefix stripped) already
 * appears verbatim in the freshly generated AI timeline; otherwise it is
 * appended as-is (never reworded, never removed).
 */
function _mergeManualEntries(aiTimeline, manualEntries) {
  if (!Array.isArray(manualEntries) || !manualEntries.length) return aiTimeline;
  const aiLower = (aiTimeline || '').toLowerCase();
  const missing = manualEntries.filter(function (e) {
    const textPart = String(e || '').replace(/^\d{2}\/\d{2}\s*[-\u2013]\s*/, '').trim().toLowerCase();
    return textPart.length > 0 && !aiLower.includes(textPart);
  });
  if (!missing.length) return aiTimeline;
  return (aiTimeline ? aiTimeline.trim() + '\n' : '') + missing.join('\n');
}

/**
 * _sortTimelineChronologically -- deterministic MM/DD sort of a timeline block.
 *
 * The AI is instructed to merge all work orders into one chronological
 * timeline, but that is only an instruction -- with 2-3 interleaved work
 * orders (and manual entries appended at the end by _mergeManualEntries) the
 * actual order can drift. This enforces true chronological order regardless of
 * what the model or the manual-merge produced.
 *
 * Rules:
 *  - Each line is expected to start with "MM/DD" (optionally a range
 *    "MM/DD-MM/DD"). Sort by the FIRST date on the line, oldest -> newest.
 *  - Year-agnostic: the data spans one rolling year, so a month far in the
 *    future relative to "now" is treated as the PRIOR year (e.g. in Jan, a
 *    "12/28" entry sorts before "01/03"). This keeps a Dec->Jan wrap correct.
 *  - Lines with no parseable date (headers, wrapped continuation lines) keep
 *    their position relative to the dated line above them (stable attach).
 *  - Stable within the same date (preserves same-day ordering from the AI).
 */
function _sortTimelineChronologically(timelineText) {
  if (!timelineText || typeof timelineText !== 'string') return timelineText;
  const rawLines = timelineText.split('\n');
  const now = new Date();
  const curMonth = now.getMonth() + 1; // 1-12

  // Group each dated line with any following non-dated continuation lines.
  const dateRe = /^\s*(\d{1,2})\/(\d{1,2})/;
  const groups = [];
  let cur = null;
  for (const line of rawLines) {
    const m = line.match(dateRe);
    if (m) {
      cur = { mm: parseInt(m[1], 10), dd: parseInt(m[2], 10), lines: [line], idx: groups.length };
      groups.push(cur);
    } else if (cur) {
      cur.lines.push(line); // continuation of the previous dated entry
    } else {
      // Leading non-dated line (rare) -- keep as its own group, sorts first.
      groups.push({ mm: -1, dd: -1, lines: [line], idx: groups.length });
    }
  }
  if (groups.length <= 1) return timelineText;

  const sortKey = (g) => {
    if (g.mm < 1) return -Infinity; // undated leading lines first
    // Future month relative to now => previous year (Dec->Jan wrap).
    const yearOffset = g.mm > curMonth + 1 ? -1 : 0;
    return (now.getFullYear() + yearOffset) * 10000 + g.mm * 100 + g.dd;
  };

  const sorted = groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => {
      const ka = sortKey(a.g), kb = sortKey(b.g);
      if (ka !== kb) return ka - kb;
      return a.i - b.i; // stable: preserve original order for same date
    })
    .map(x => x.g.lines.join('\n'));

  return sorted.join('\n');
}


/**
 * _timelineEntrySignature -- normalizes a timeline line to its comparable
 * "text body" form: date prefix stripped, trimmed, lowercased. This is the
 * exact same normalization _mergeManualEntries() already uses for its
 * duplicate check, extracted here so hide/edit can share one definition of
 * "same entry" instead of drifting out of sync with two regexes.
 */
function _timelineEntrySignature(line) {
  return String(line || '').replace(/^\d{2}\/\d{2}\s*[-\u2013]\s*/, '').trim().toLowerCase();
}

/**
 * _filterHiddenEntries -- strips any timeline line whose text-body signature
 * (date-stripped, case-insensitive) matches a signature in hiddenEntries.
 * This is the counterpart to _mergeManualEntries(): where that function
 * guarantees a manual line ALWAYS survives regeneration, this one guarantees
 * a hidden line NEVER resurfaces after regeneration -- covering both a
 * user-hidden AI-generated line (which the AI could regenerate verbatim or
 * near-verbatim from the same underlying vendor comment next sync) and a
 * user-hidden manual line.
 *
 * Must be applied to the FINAL merged timeline (i.e. after
 * _mergeManualEntries), not just the raw AI output, so a hidden entry that
 * also happens to be in manualEntries[] is correctly suppressed too.
 */
function _filterHiddenEntries(timelineText, hiddenEntries) {
  if (!Array.isArray(hiddenEntries) || !hiddenEntries.length) return timelineText;
  if (!timelineText) return timelineText;
  const hiddenSigs = new Set(hiddenEntries.map(_timelineEntrySignature).filter(Boolean));
  if (!hiddenSigs.size) return timelineText;
  const lines = timelineText.split('\n').filter(function (line) {
    return !hiddenSigs.has(_timelineEntrySignature(line));
  });
  return lines.join('\n');
}

module.exports = { runOrchaDeepScan, _mergeManualEntries, _filterHiddenEntries, _timelineEntrySignature };
