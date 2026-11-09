// tests/helpers/aki-style-replies.js — Aki-style AI replies for the tolerant
// JSON extractor tests (tests/ai-json.test.js, tests/ai-json-call-sites.test.js).
// Aki's stream-json text often wraps the requested JSON in leading "thinking"
// prose (with stray braces), a ```json fence, and trailing commentary.

const LD_BULLETS = [
  '\u2022 Initial Issue Reported: Driver side front tire, headlight, and bumper damage (8/25); driver note said "{see photos}".',
  '\u2022 Primary Vendor Rejection: Body damage repairs -- out of scope for mobile service (8/26); vendor wrote "N/A {body}" in the WO.',
  '\u2022 Primary Barrier: Chassis fairing on back order from PDC, originally expected ~9/24; parts delay SIM submitted 9/17 for assistance.',
  '\u2022 Actions Taken: Reached out for projected ETC (9/3); reached out for dealer update (9/9, 9/16); input parts delay SIM (9/17); escalated estimate v2 for approval (9/21), approved 9/22.',
  '\u2022 Repair Status: At the dealer -- hood/bumper completed, transport arranged; estimate v2 approved 9/22 covering CEL road test, oil leak, door check, mirror monitor, camera mount, and washer pump.',
  '\u2022 ETC: No ETC -- road test still needed to confirm CEL/oil leak resolution before return [pending].',
  '\u2022 Follow-up date: 9/24/2026 -- request road-test results and firm ETC from the dealer.',
];
export const LD_SUMMARY = LD_BULLETS.join('\n');
export const LD_EXPECTED = { delayReason: 'Parts Delay', escalationLevel: 'SEV3', summary: LD_SUMMARY };

const LD_LEAD =
  "I'll review unit B13014 and the work-order thread before answering. The template mentions {unitId} and " +
  'a {placeholder} pair, so I will ignore those. Looking at the timeline { the dealer has the unit, and the ' +
  'fairing is the long pole. Parts are on back order from PDC and the SIM was submitted on 9/17, so the delay ' +
  'reason is clearly a parts delay rather than a vendor or estimate issue. The unit has been down well past the ' +
  'SEV4 window but there is no safety or customer-impact angle that would push it to SEV2, so SEV3 fits the ' +
  'rubric. I will summarise the seven bullets the report expects, keeping costs out of the text.\n\n' +
  'Here is the JSON for the Long Dwell report:\n\n';
const LD_TAIL =
  '\n\nNotes: I left costs out of the summary as requested } and kept every bullet grounded in the thread. ' +
  'If the dealer posts the road-test result before 9/24 the follow-up can move up. Let me know if you want ' +
  'the escalation reconsidered once the ETC is firm.\n\nOK via aki';

function _ldJson(rawNewlines) {
  const summaryJson = JSON.stringify(LD_SUMMARY);
  const s = rawNewlines ? summaryJson.replace(/\\n/g, '\n') : summaryJson;
  return '{\n  "delayReason": "Parts Delay",\n  "escalationLevel": "SEV3",\n  "summary": ' + s + '\n}';
}
function _pad(reply) {
  // Pad the leading prose so the reply is ~3000 chars (Aki replies run 2000-3500).
  const filler = 'Checking the remaining comments for anything that changes the call. ';
  let lead = LD_LEAD;
  while ((lead.length + reply.length) < 3000) lead = filler + lead;
  return lead + reply;
}
export const AKI_LONGDWELL_REPLY = _pad('```json\n' + _ldJson(false) + '\n```' + LD_TAIL);
export const AKI_LONGDWELL_REPLY_RAW_NL = _pad('```json\n' + _ldJson(true) + '\n```' + LD_TAIL);

// Long Dwell summary format fixtures (fix/longdwell-aki-format). Verbatim from
// .agents/tasks/fleet-version-c-fix-longdwell-aki-format-2026-11-09/fixtures.md.
// A: the real Aki B13014 summary (one prose paragraph, WRONG format).
export const LD_AKI_B13014_PROSE =
  "B13014 (box truck, DSP carrier AUVTE, domicile ROC5) has been down 60 days in Accident status with front-end damage (driver-side hood detached). No repair vendor is assigned and there is no estimate or ETC. The carrier owns vendor selection for DSP-managed accident repairs. The insurance claim is filed, but the adjuster is still waiting on the accident report to settle with the other party's insurer. The unit was towed to ROC5 on 10/18. The timeline shows long gaps with no updates. Severity is SEV2 because the unit is past 14 days down and has no clear path. FAS cannot flip or repair this unit, and ARC/insurance owns the claim. Next step: wait for the carrier/FAS update due 11/11. If nothing arrives by then, ask the carrier which local repair vendor was assigned and request the drop-off date, estimate and ETC. If there is still no answer, escalate to the Uptime Manager and document it in the FAS2UM SIM. Follow-up date: Wed 11/11/2026. Watch the upcoming DOT inspection due 12/05 and PM-B due 12/07.";
// B: the user's gold 7-bullet version for B13014.
export const LD_GOLD_B13014 = [
  '\u2022 Initial Issue Reported: Front-end accident damage; driver-side hood of box truck detached (9/13).',
  '\u2022 Primary Vendor Rejection: N/A \u2014 unit went directly to DSP carrier-managed accident repair process; no primary mobile vendor assigned.',
  "\u2022 Primary Barrier: Payment \u2014 insurance adjuster working to obtain accident report to settle payment with other party's insurer; no repair vendor assigned and no estimate submitted; 60 days down with no ETC.",
  '\u2022 Actions Taken: Re-escalated to DSP carrier for status update (9/27, 10/11); coordinated relocation tow from AUVTE01 to ROC5 via FleetNet (tow order 00176990/amz-dr67qazvrtau54, FNA ticket amz-7cvf6f2rds7r3w, 10/13); confirmed relocation to ROC5 complete (10/18); carrier reported insurance claim filed and adjuster engaged (10/20\u201310/21); monitoring for 11/11 carrier/FAS update.',
  '\u2022 Repair Status: Unit at ROC5 in Accident status \u2014 no repair vendor assigned, no estimate, no body shop drop-off date confirmed; insurance adjuster actively working claim.',
  '\u2022 ETC: No ETC \u2014 pending insurance settlement and carrier selection of repair vendor.',
  '\u2022 Follow-up date: 11/11/2026 \u2014 confirm whether carrier has assigned a repair vendor and provided a body shop drop-off date and ETC; if no update received, escalate to FAS/MCS Accidents team.',
].join('\n');
// C / D: the two gold EXAMPLES embedded in renderer/src/js/longdwell-ai.js (de-escaped).
export const LD_GOLD_EXAMPLE_1 = [
  '\u2022 Initial Issue Reported: Passenger mirror loose/excessive shake; VADA ECU fault -- communication failure; transmission clutch slip accelerating gears 11-12.',
  '\u2022 Primary Vendor Rejection: Amerit rejected -- transmission clutch failure and VADA ECU faults require Volvo dealer diagnostic tools and transmission repair capability.',
  '\u2022 Primary Barrier: Estimate Process -- transmission repair completed, but road test 9/22 revealed VECU data mismatch codes and unit pulling right. Updated estimate submitted for alignment and code diagnostics, pending approval.',
  '\u2022 Actions Taken: Towed to Shealy Duncan 9/10. Transmission pulled, clutch/actuator/valve replaced. Exhaust flex pipe replaced. Estimate $7,697.91 approved 9/21. Road test 9/22 identified new codes. Updated estimate submitted to MCS for approval.',
  '\u2022 Repair Status: Transmission repair complete. Pending approval for alignment and VECU code diagnostics.',
  '\u2022 ETC: Not provided -- pending estimate approval.',
  '\u2022 Follow-up date: 9/22/2026 (today) -- escalate updated estimate in RG to MCS for approval. Request ETC from Shealy Duncan upon approval.',
].join('\n');
export const LD_GOLD_EXAMPLE_2 = [
  '\u2022 Initial Issue Reported: Driver side front tire, headlight, and bumper damage (8/25).',
  '\u2022 Primary Vendor Rejection: Body damage repairs -- out of scope for mobile service (8/26).',
  '\u2022 Primary Barrier: Chassis fairing on back order from PDC, originally expected ~9/24; parts delay SIM submitted 9/17 for assistance.',
  '\u2022 Actions Taken: Reached out for projected ETC (9/3); reached out for dealer update (9/9, 9/16); input parts delay SIM (9/17); escalated estimate v2 ($21,616.71) for approval (9/21), approved 9/22.',
  '\u2022 Repair Status: At Gabrielli Kenworth Bristol -- hood/bumper completed, transport arranged; estimate v2 approved 9/22 covering CEL road test, oil leak, door check, mirror monitor, camera mount, and washer pump.',
  '\u2022 ETC: No ETC -- road test still needed to confirm CEL/oil leak resolution before return.',
  '\u2022 Follow-up date: 9/24/2026 -- request road-test results and firm ETC from Gabrielli Kenworth Bristol.',
].join('\n');
// Aki-wrapped reply whose summary is the prose paragraph (A).
export const LD_PROSE_EXPECTED = { delayReason: 'Payment', escalationLevel: 'SEV2', summary: LD_AKI_B13014_PROSE };
export const AKI_LONGDWELL_PROSE_REPLY = _pad('```json\n' + JSON.stringify(LD_PROSE_EXPECTED, null, 2) + '\n```' + LD_TAIL);

// RCA autofill (src/rca/autofill.js) — object keyed by propertyName.
export const RCA_VALUES = {
  complaint: 'Driver reported air leak at the rear axle {DVIR}.',
  cause: 'Ruptured brake chamber diaphragm.',
  correction: 'Replaced the left rear brake chamber and tested for leaks.',
  controllable: 'Amazon Controllable',
  driverDescription: 'Yes',
  systemCodes: ['013 - Brakes'],
};
export const AKI_RCA_REPLY =
  'Sure { here is the RCA draft based on the work-order thread.\n\n```json\n' +
  JSON.stringify(RCA_VALUES, null, 2) + '\n```\n\nI omitted the cost fields } since they are not in the evidence.';

// WR modal AI Assist (renderer/src/js/views/wr-modal.js).
export const WR_VALUES = { title: 'Air leak rear axle - send to dealer', issue: 'Driver reports an audible air leak near the rear axle.', vendor: 'Rush Truck Center' };
export const AKI_WR_REPLY =
  'Based on the notes, this looks like a brake chamber issue {probably}.\n```\n' +
  JSON.stringify(WR_VALUES) + '\n```\nThat should cover the request.';

// Daily Call WBR (renderer/src/js/views/daily-call.js _parseWbrJson).
export const WBR_VALUES = { bridge: 'Down units up 3 WoW driven by {parts} delays.', actions: 'Escalate 2 SIMs; follow up with dealer.' };
export const AKI_WBR_REPLY =
  'Here is the WBR bridge and actions:\n\n```json\n' + JSON.stringify(WBR_VALUES, null, 2) + '\n```\n\nOK via aki';

// Heartbeat RCA inference (src/orcha/heartbeat.js _autoInferRCA).
export const HB_VALUES = {
  primaryComponent: '013-001', technicianFailureCode: 'LEAK', primaryCauseCode: 'WORN',
  workAccomplishedCode: 'REPLACE', maintenanceCode: 'UM', controllable: 'N',
};
export const AKI_HB_REPLY =
  'Let me infer the codes { based on the issue text.\n```json\n' + JSON.stringify(HB_VALUES) + '\n```\nDone }.';
