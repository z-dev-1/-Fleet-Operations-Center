// ============================================================================
// longdwell-ai.js � SHARED Long Dwell AI-fill prompt + helpers.
//
// Single source of truth for the AI-fill prompt that drafts delayReason /
// escalationLevel / 7-field summary for a Long Dwell unit. Used by BOTH the
// computed Long Dwell table (views/analytics.js) and the imported-CSV table
// (views/longdwell-csv.js) so the two never drift. Moved here verbatim from
// analytics.js (2026) when the imported-CSV table gained AI-fill.
// ============================================================================

// Fixed enums the AI must choose from (also enforced server-side).
export const DELAY_REASONS = [
  'Primary Vendor', 'Parts Delay', 'Offsite Shop', 'Estimate Process',
  'Payment', 'Speciality Vendor', 'Out of Scope for FAS',
  'End of Life Review', 'PMR', 'MCS SW Miss', 'Weather', 'Towing',
  'Reconditioning', 'Repaired',
];
export const ESCALATION_LEVELS = ['SEV5', 'SEV4', 'SEV3', 'SEV2'];

// ── FAS knowledge base (SINGLE SOURCE OF TRUTH, fetched from main) ───────────
// The SEV rubric + escalation + ownership rules live in src/orcha/fas-knowledge.js
// (main process). We fetch it once via the ai.getKnowledge() bridge and cache
// it, then inject it into the AI-fill prompt — so the Long Dwell escalation
// judgments use the SAME authoritative rules as the Slack assistant, never a
// duplicated/drifting embedded rubric.
let _kbCache = '';
export async function loadKnowledge() {
  try {
    const { ai } = await import('./bridge.js');
    const res = ai && ai.getKnowledge ? await ai.getKnowledge() : null;
    if (res && res.ok && res.text) _kbCache = res.text;
  } catch (_) { /* best-effort — prompt still works without it */ }
  return _kbCache;
}
export function knowledgeText() { return _kbCache; }

// Tidies text (collapses runs of whitespace) before it reaches the AI prompt
// or the saved summary.
//
// DOLLAR AMOUNTS (2026): for LONG DWELL summaries specifically, estimate dollar
// figures ARE wanted (e.g. "estimate v4 ($22,706.78) escalated to HVE") -- they
// are part of the gold-standard status format the team uses. So this no longer
// strips "$" amounts. (Kept the function + name so the 6 Long-Dwell call sites
// and the source-context feed stay unchanged; it now only normalizes
// whitespace.) The general "no cost figures" rule still lives in deep-scan.js
// for other, broader-audience outputs -- this override is scoped to Long Dwell.
export function _stripCosts(text) {
  if (!text) return text;
  return String(text)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Compact context block for the AI prompt -- same source fields deep-scan.js
// already reads off a merged row (repairTimeline / issueSummary / savedNotes
// / fullConversation), truncated so a single unit's prompt stays reasonable.
export function _sourceContextForRow(row) {
  const parts = [];
  // CANONICAL STATE (the single reconciled truth, mirrored onto the row). When
  // present, lead with it so the AI anchors on the reconciled status / next
  // step / who-we're-waiting-on rather than re-deriving from raw notes. The raw
  // fields below remain as supporting detail / fallback.
  if (row.canonicalStatus) {
    const cs = [];
    cs.push('Canonical status: ' + String(row.canonicalStatus).replace(/_/g, ' ') + (row.canonicalStale ? ' (STALE — no recent update)' : ''));
    if (row.canonicalWaitingOn) cs.push('waiting on: ' + row.canonicalWaitingOn);
    if (row.canonicalSituation) cs.push('situation: ' + _stripCosts(String(row.canonicalSituation)).slice(0, 300));
    if (row.canonicalNextStep)  cs.push('reconciled next step: ' + _stripCosts(String(row.canonicalNextStep)).slice(0, 300));
    parts.push('CANONICAL STATE (reconciled truth — trust over raw notes):\n' + cs.join('\n'));
  }
  if (row.issueDetails)   parts.push('Issue: ' + _stripCosts(String(row.issueDetails)).slice(0, 300));
  if (row.issueSummary)   parts.push('Summary so far: ' + _stripCosts(String(row.issueSummary)).slice(0, 300));
  if (row.repairTimeline) parts.push('Repair timeline:\n' + _stripCosts(String(row.repairTimeline)).slice(0, 1200));
  else if (row.savedNotes) parts.push('Notes: ' + _stripCosts(String(row.savedNotes)).slice(0, 500));
  let conv = row.fullConversation || row.lastConversation || row.conversation || '';
  if (conv) {
    const cs = conv.indexOf('Conversation');
    if (cs > 0) conv = conv.substring(cs);
    parts.push('Vendor/WO conversation:\n' + _stripCosts(String(conv)).slice(0, 1500));
  }
  return parts.length ? parts.join('\n\n') : '(no repair notes or conversation on file)';
}

// Builds the AI-fill prompt for one Long Dwell row. Requests strict JSON so
// parsing is a simple regex + JSON.parse (same defensive pattern
// daily-call.js's _runAI already uses for its own AI calls) rather than the
// looser REPAIR_STATUS:/ISSUE: line-regex format deep-scan.js uses -- JSON
// is a better fit here since there are three independent fields to fill.
export function _buildAIFillPrompt(row, dd) {
  const id     = row.equipmentId || '';
  const vendor = row.vendor || 'unassigned';
  const dom    = row.domicileSite || row.domicile || 'unknown';
  const op     = row.operator || 'unknown';
  const reason = row.lifecycleReason || 'unknown';
  // Inject TODAY so the AI can compute a real, concrete follow-up date (it has
  // no inherent sense of "now"). Format: "Wed 9/24/2026".
  const _now   = new Date();
  const _dow   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][_now.getDay()];
  const todayStr = _dow + ' ' + (_now.getMonth() + 1) + '/' + _now.getDate() + '/' + _now.getFullYear();
  return (
    // FAS KNOWLEDGE BASE (single source of truth for SEV/escalation/ownership).
    // Fetched from main via loadKnowledge(); empty string until loaded (the
    // prompt still works, the SEV section just won't be present that one time).
    (_kbCache ? (_kbCache + '\n\n') : '') +
    'You are Orcha, the AI brain for Fleet Operations. This unit is a LONG DWELL unit -- ' +
    'down and unavailable for an extended period -- and needs a leadership-facing status ' +
    'entry filled in for the Long Dwell Units report.\n\n' +
    'TODAY IS: ' + todayStr + '. Use this to compute a concrete follow-up date.\n\n' +
    'UNIT: ' + id + ' | Vendor: ' + vendor + ' | Domicile: ' + dom + ' | Operator: ' + op + ' | Down ' + dd + ' days | Lifecycle reason: ' + reason + '\n\n' +
    'SOURCE DATA:\n' + _sourceContextForRow(row) + '\n\n' +
    'MY ROLE (FAS) -- OWNERSHIP RULES (critical: attribute actions to the correct team):\n' +
    '   - I am a FAS. I do NOT approve or reject estimates -- ESTIMATE APPROVAL IS OWNED BY MCS\n' +
    '     (MCS L3 for power-unit estimates up to $30K; MCS L4H / HVE leadership for $30K+ power units\n' +
    '     and $15K+ non-power). So NEVER write that I approved/rejected an estimate. When the source\n' +
    '     shows an estimate was approved, phrase it as the estimate BEING approved (e.g. "estimate v3\n' +
    '     ($21,235.33) approved 9/16") or "approved by MCS" -- MY action is to ESCALATE it (to MCS Lead\n' +
    '     when it dwells past SLA, or to HVE for high-value), or to INVESTIGATE/REASSIGN on a 3rd vendor\n' +
    '     rejection. Use "escalated ... to MCS/HVE", never "I approved".\n' +
    '   - Things I CAN own as actions: choosing/reassigning the vendor or dealer, creating a work order,\n' +
    '     force-completing/force-closing a Relay Garage WO (when I independently confirmed the work),\n' +
    '     opening/inputting SIMs (parts-delay, tractor-down), grounding assets flagged by predictive\n' +
    '     maintenance, determining if a swap is needed and routing the SIM, and following up with vendors/\n' +
    '     dealers for status/ETC.\n' +
    '   - NOT my actions (attribute to the owning team, do not claim them): estimate approval (MCS),\n' +
    '     vendor assignment via VRE (MCS), post-repair verification / flip to Active-Healthy (MCS),\n' +
    '     invoice audit / billing / credits (MCS Buddy / AFP), pricing disputes (MCS), PM scheduling\n' +
    '     (dedicated PM POCs / OEM), accident repair management (CEI + Amazon Claims/ARC -- I only track\n' +
    '     the SIM), and the EOL decision itself (MCS Estimation + TEP).\n' +
    '   - Do NOT overclaim. If an action was taken by another team, say so plainly; only put MY real\n' +
    '     actions under "Actions Taken".\n\n' +
    'TASK -- return exactly three fields:\n\n' +
    '1. delayReason -- pick EXACTLY ONE of this fixed list (verbatim, no variation):\n' +
    '   Primary Vendor, Parts Delay, Offsite Shop, Estimate Process, Payment, Speciality Vendor, ' +
    'Out of Scope for FAS, End of Life Review, PMR, MCS SW Miss, Weather, Towing, Reconditioning, Repaired\n\n' +
    '2. escalationLevel -- pick EXACTLY ONE of: SEV5, SEV4, SEV3, SEV2 (SEV2 is the HIGHEST severity, SEV5 the lowest).\n' +
    '   Decide the SEV STRICTLY from the "ESCALATION SEVERITY (SEV5-SEV2)" section of the FAS KNOWLEDGE\n' +
    '   BASE included above — use its day ranges, its INSTANT-BUMP TRIGGERS (no ETC, passed ETC, out of\n' +
    '   scope, 3rd failed estimate, repeat repairs, DOT-critical, risk site, AFP partner escalation), and\n' +
    '   its SEV2/leadership criteria. That KB is the single source of truth for severity.\n\n' +
    '3. summary -- a STRUCTURED status block in EXACTLY this 7-field format, in this order,\n' +
    '   one field per line, each line starting with "\\u2022 " (bullet + space) then the label\n' +
    '   and a colon. Use a literal \\n between lines. This EXACT format is required for EVERY\n' +
    '   unit -- accidents, EOL, and rentals included (they still fill every field; see below).\n\n' +
    '   The 7 fields (verbatim labels, in this order). Match the STYLE of the GOLD-STANDARD\n' +
    '   EXAMPLES at the bottom -- dense, specific, date-stamped, with estimate versions + dollar\n' +
    '   figures, SR/case numbers, part names, and vendor/dealer names:\n' +
    '   \\u2022 Initial Issue Reported: <the original reported symptoms; list multiple symptoms separated\n' +
    '        by semicolons; include the report date in parens when known, e.g. "active CEL (8/10)".>\n' +
    '   \\u2022 Primary Vendor Rejection: <this field applies ONLY when the unit STARTED at a primary/mobile\n' +
    '        vendor (e.g. Amerit, TA) that then could NOT perform the work because it was OUT OF SCOPE, so\n' +
    '        it had to be ROUTED TO A DEALER. State: which primary vendor, the technical reason it was out\n' +
    '        of scope, and that it was sent to the dealer -- with date if known. E.g. "Amerit rejected --\n' +
    '        transmission clutch failure requires Volvo dealer tools; routed to Shealy Duncan (9/10)" or\n' +
    '        "TA out of scope -- body damage requires dealer body shop (8/26)". If the unit was NOT first at\n' +
    '        a primary/mobile vendor (i.e. it went straight to a dealer), or the primary vendor is handling\n' +
    '        it in scope, write "N/A". Do NOT put estimate rejections or general delays here -- ONLY the\n' +
    '        mobile-vendor-out-of-scope -> dealer handoff.>\n' +
    '   \\u2022 Primary Barrier: <the single biggest thing blocking completion RIGHT NOW, with specifics:\n' +
    '        estimate version + dollar figure + who it is escalated to + date (e.g. "Estimate v4\n' +
    '        ($22,706.78) escalated to HVE 9/22"), OR the exact part on backorder + source + parts-delay\n' +
    '        SIM reference, OR the pending diagnosis. Include the delayReason category word where it fits.>\n' +
    '   \\u2022 Actions Taken: <a FIRST-PERSON, dated chronology of what I (the FAS) did -- outreach and\n' +
    '        milestones with dates, semicolon-separated, e.g. "Reached out for diag findings/ETC (9/9,\n' +
    '        9/21); estimate v3 ($21,235.33) approved 9/16; escalated estimate v4 to HVE 9/22." Note the\n' +
    '        estimate approval is stated passively (MCS approved it) -- MY action is escalating it. Lead\n' +
    '        with ownership verbs I actually own (Reached out, Diagnosed, Chose/Reassigned vendor, Created\n' +
    '        WO, Force-completed, Opened/Input SIM, Escalated, Grounded, Rerouted, Confirmed). Do NOT write\n' +
    '        "I approved the estimate" -- I never approve estimates (see MY ROLE rules above).\n' +
    '        Professional and proactive so it reflects well on me. Base it ONLY on what the source\n' +
    '        shows actually happened -- do NOT invent actions, vendor calls, or follow-ups that are not in\n' +
    '        the source; frame the REAL actions in the strongest, most ownership-forward professional light.>\n' +
    '   \\u2022 Repair Status: <vendor/dealer LOCATION + what is physically done + what was uncovered +\n' +
    '        what is pending, dated where known. E.g. "At Bergeys Newcastle -- steer brakes/windshield\n' +
    '        replaced 9/18; front drive shock repair uncovered additional bracket/crossmember damage;\n' +
    '        parts on order." or "OSR -- pending diag. Cummins pulling head for root cause. EOL pending.">\n' +
    '   \\u2022 ETC: <estimated completion date if known. If an ETC exists but has PASSED, note it and the\n' +
    '        days past due, e.g. "9/16/2026 (past due -- 6 days). No updated ETC." If none exists, "No ETC\n' +
    '        -- <reason>" or "Not provided -- pending estimate approval".>\n' +
    '   \\u2022 Follow-up date: <a CONCRETE calendar date in M/D/YYYY when we should next follow up, FOLLOWED\n' +
    '        BY the specific action to take that day -- e.g. "9/23/2026 -- request updated ETC" or\n' +
    '        "9/22/2026 (today) -- escalate updated estimate in RG to MCS for approval; request ETC from\n' +
    '        Shealy Duncan upon approval." ALWAYS an actual date computed from TODAY, never "Follow-up\n' +
    '        required" or a bare owner. The DATE + ACTION are both required.>\n\n' +
    '   FOLLOW-UP DATE RULE (this field must ALWAYS be a real M/D/YYYY date computed from TODAY + the action):\n' +
    '   - Pick the date based on urgency, write it as M/D/YYYY, then " -- <action>":\n' +
    '       * Vendor unresponsive / no update logged / DOT-critical / SEV2-SEV3 -> follow up in 1-2 days from today.\n' +
    '       * Estimate pending approval or awaiting vendor resubmission -> follow up in 2-3 days from today.\n' +
    '       * Parts backordered / long lead time -> follow up in ~7 days from today (or the day AFTER the stated\n' +
    '         parts ETA if one exists in the source).\n' +
    '       * A firm ETC exists -> follow up the day AFTER that ETC.\n' +
    '   - Compute the date from TODAY (given above) and output the resulting M/D. Do NOT output words like\n' +
    '     "Follow-up required", "TBD", "Pending", or an owner with no date -- this field is never allowed to be dateless.\n' +
    '   - EXCEPTION UNITS (accident / EOL / rental) are the ONLY case where Follow-up date may be "N/A".\n\n' +
    '   FILL RULES (apply to every field):\n' +
    '   - Ground EVERY field ONLY in the SOURCE DATA above. NEVER invent a part, link, owner,\n' +
    '     vendor, or rejection that is not supported by the source. (The Follow-up date is the ONE\n' +
    '     allowed computed value -- it is derived from today + urgency, per the rule above.)\n' +
    '   - If a field genuinely does not apply, write "N/A" (e.g. no vendor rejection -> "Primary Vendor Rejection: N/A").\n' +
    '   - If a field applies but the value is unknown from the source, write "Pending \\u2014 <short reason>"\n' +
    '     (never leave a field blank after the colon). This does NOT apply to Follow-up date, which is always a date.\n' +
    '   - If a Parts SIM/ticket link appears in the source, include the actual link in "Primary Barrier"\n' +
    '     or "Actions Taken" (whichever fits). Never fabricate a link.\n' +
    '   - Keep each field to one concise line. Be specific: vendor names, part names, dates, days down.\n' +
    '   - EXCEPTION UNITS (accident / EOL / rental): still use all 7 fields, but they are not within FAS\n' +
    '     control, so ETC and Follow-up date may be "N/A" and Primary Barrier states the situation\n' +
    '     (e.g. "Primary Barrier: Accident \\u2014 CEI managing", "ETC: N/A", "Follow-up date: N/A"). For ALL\n' +
    '     other (FAS-controlled) units, Follow-up date MUST be a concrete M/D date per the rule above.\n' +
    '   - Estimate DOLLAR AMOUNTS ARE WANTED here (e.g. "estimate v4 ($22,706.78)") -- include them\n' +
    '     when present in the source. Still NEVER include personal names, phone numbers, emails, or VINs.\n' +
    '   - Allowed: vendor/dealer names + locations, case/SR/SIM numbers, part names/PNs, SIM links,\n' +
    '     estimate versions + dollar figures, dates, ETAs.\n\n' +
    '   GOLD-STANDARD EXAMPLES (match this density, dating, and voice; note the literal \\n between lines):\n' +
    '   EXAMPLE 1:\n' +
    '   "\\u2022 Initial Issue Reported: Passenger mirror loose/excessive shake; VADA ECU fault -- communication failure; transmission clutch slip accelerating gears 11-12.\\n' +
    '\\u2022 Primary Vendor Rejection: Amerit rejected -- transmission clutch failure and VADA ECU faults require Volvo dealer diagnostic tools and transmission repair capability.\\n' +
    '\\u2022 Primary Barrier: Estimate Process -- transmission repair completed, but road test 9/22 revealed VECU data mismatch codes and unit pulling right. Updated estimate submitted for alignment and code diagnostics, pending approval.\\n' +
    '\\u2022 Actions Taken: Towed to Shealy Duncan 9/10. Transmission pulled, clutch/actuator/valve replaced. Exhaust flex pipe replaced. Estimate $7,697.91 approved 9/21. Road test 9/22 identified new codes. Updated estimate submitted to MCS for approval.\\n' +
    '\\u2022 Repair Status: Transmission repair complete. Pending approval for alignment and VECU code diagnostics.\\n' +
    '\\u2022 ETC: Not provided -- pending estimate approval.\\n' +
    '\\u2022 Follow-up date: 9/22/2026 (today) -- escalate updated estimate in RG to MCS for approval. Request ETC from Shealy Duncan upon approval."\n\n' +
    '   EXAMPLE 2:\n' +
    '   "\\u2022 Initial Issue Reported: Driver side front tire, headlight, and bumper damage (8/25).\\n' +
    '\\u2022 Primary Vendor Rejection: Body damage repairs -- out of scope for mobile service (8/26).\\n' +
    '\\u2022 Primary Barrier: Chassis fairing on back order from PDC, originally expected ~9/24; parts delay SIM submitted 9/17 for assistance.\\n' +
    '\\u2022 Actions Taken: Reached out for projected ETC (9/3); reached out for dealer update (9/9, 9/16); input parts delay SIM (9/17); escalated estimate v2 ($21,616.71) for approval (9/21), approved 9/22.\\n' +
    '\\u2022 Repair Status: At Gabrielli Kenworth Bristol -- hood/bumper completed, transport arranged; estimate v2 approved 9/22 covering CEL road test, oil leak, door check, mirror monitor, camera mount, and washer pump.\\n' +
    '\\u2022 ETC: No ETC -- road test still needed to confirm CEL/oil leak resolution before return.\\n' +
    '\\u2022 Follow-up date: 9/24/2026 -- request road-test results and firm ETC from Gabrielli Kenworth Bristol."\n\n' +
    'RESPOND WITH RAW JSON ONLY -- no markdown, no code fences, no explanation, exactly this shape\n' +
    '(the summary value is a single JSON string containing the 7 bulleted lines separated by \\n):\n' +
    '{"delayReason": "...", "escalationLevel": "...", "summary": "..."}'
  );
}
