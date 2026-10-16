'use strict';
/**
 * fas-knowledge.js — FAS institutional knowledge base.
 *
 * The highest-value context for answering HARD questions (ownership, approval
 * thresholds, escalation, process) that raw fleet data can't answer. Captured
 * from the FAS (Z) directly. Injected into the AI prompt (buildFleetContext,
 * gated to internal callers) so every assistant surface — DM "just me", channel
 * replies to internal contacts, Long Dwell AI-fill — answers with the SAME
 * authoritative rules instead of guessing or mis-attributing ownership.
 *
 * This is a living document; grow it as more knowledge is captured. Kept as a
 * plain exported string so it's trivially editable and require()-able from the
 * main process. Later this can move to an editable in-app store if desired.
 */

const FAS_KNOWLEDGE = `
=== FAS KNOWLEDGE BASE (authoritative — use for ownership / approval / escalation / process questions) ===

ROLE: FAS = Fleet Asset Specialist. Owns SITE-LEVEL RISK (keeping units moving back to service), NOT the day-to-day work-order queue (that's MCS). Hours: M–F 07:00–15:30; after hours routes to MCS.

── ESTIMATE APPROVAL (FAS NEVER approves or rejects estimates — that is 100% MCS) ──
Thresholds (who approves):
  • ≤ $500: auto-approved by the system (no human). FAS does nothing.
  • $501–$29,999 POWERED: MCS L3 Associates approve. FAS follows up if past SLA; escalates to MCS Lead if stalled.
  • $501–$14,999 NON-POWERED: MCS L3 Associates approve. Same FAS tracking/pushing.
  • $30,000+ POWERED: L4H Leadership (HVE & EOL eval). FAS receives escalation on 3rd failed vendor submission; can request reassignment.
  • $15,000+ NON-POWERED: L4H Leadership. Same; FAS also evaluates EOL-worthiness.
  • EOL estimates (any amount): L4H POCs. MCS determines EOL; FAS checks if a swap is needed (AFP), tags the unit out, updates AAP (TOM DCs/YHs).
  • Urgent road calls (any amount): MCS expedited approval. FAS created the WO as urgent and follows up with the vendor directly.
  • 3rd failed submission (any amount): ESCALATED TO FAS. After 2 rejections, MCS escalates to FAS; FAS may reassign the vendor and file a Vendor Performance Asana.
Estimate variance rules FAS monitors: up to 20% above usual-and-customary allowed (hard cap 30%); claims >30% require photos + detailed explanation + documentation; max 2 rejections before it reaches FAS for possible vendor reassignment.

── WHAT FAS CAN / DOES DO ──
Work Orders & Relay Garage: create unplanned WRs (CNG leaks, down units, urgent repairs, return inspections); force-complete open RG events (direct permission, no escalation); force-close/cancel WOs; cancel + recreate a WO to upgrade urgency or fix an MCS miss; assign vendor via VRE at WO creation and OVERRIDE the VRE recommendation (e.g. route to a dealer) when VRE is stale or the area of concern is mis-coded.
Vendor management: daily vendor syncs + direction on which assets to prioritize by downtime; coach vendors on quality/turnaround/priority; push back directly on stalled repairs / missing estimates / slipping ETCs; request vendor reassignment after 3rd failed estimate; follow up with OEM dealers; file Vendor Performance Asana.
AAP status: flip to Unavailable/Damage Moderate; flip to Active/Healthy AFTER verifying WO completion in Reach/RG (non-AFP geofenced units); use the daily Reach Ready Report (~250 units flagged "WO complete but still unavailable") to catch completed repairs; set AFP rental status "Reconditioning" during returns; flip to "To Be Returned" when AFP repairs complete; tag assets out for EOL; flip to EOL and update lifecycle states.
SIMs & escalations: open/update down-unit, parts, tractor-move, and EOL SIMs; submit down-unit SIMs and REACH or ASIST/Decisiv cases for non-AAP yard returns; move EOL SIMs between folders (Swap, MCS EOL Deployment); resolve SIMs once AAP is updated (TOM DCs/YHs); FIRST point of escalation for geofenced issues.
Inspections & returns: Record360 return inspections (walk FAS/Amerit through checklist, photos, video); new-unit intake walk-arounds + verify paperwork + install DOT decals; compare return vs handoff photos to find carrier damage → create ARC report; create Record360 EOL Tractor Return Inspection WOs in Relay Garage.
PM (FAS role only): escalate expired DOT trailer inspections (email fleet-fas@amazon.com + scheduled-maintenance-trailers@amazon.com); if a PM is due within 3 calendar days, email the fleet vendor AND FAS team for immediate service; use the SM trailer Slack Escalation workflow for urgent trailer reactivation (MCS SM 30-min SLA); flag Gas Tank Model sites for PM exemption during PEAK.
Invoice/billing (FAS role only): MCS buddy gathers/sends completed Non-Amerit WO invoices weekly; FAS investigates AFP escalations via PARAGON (Resource Center); AFP partners have 14 days from invoice receipt to audit/dispute; FAS tracks escalations in the AFP-MX-Escalations QUIP and surfaces discrepancies.
EOL (FAS role only): AFP DCs — check if AFP asset is in rented status, determine swap need, move SIM to the right folder; TOM DCs/YHs — tag out of service, add to EOL Quip Tracker, comment in SIM, flip AAP to EOL, resolve SIM.

── WHAT FAS DOES NOT DO (attribute to the owner, never claim) ──
  • Never approve/reject estimates — MCS (L3 or L4H).
  • Never modify VRE rules/mappings — only Vendor Procurement (Phil Hines, Micah Einterz, Sal Mendoza).
  • Does NOT own WO-level daily management — MCS owns the day-to-day WO queue; FAS owns site-level risk.
  • Does NOT schedule PMs — MCS Scheduled Maintenance team schedules; FAS only escalates expired/overdue.
  • Does NOT resolve pricing disputes end-to-end — AFP Leadership approves credit adjustments.
  • Does NOT make the EOL determination — MCS Estimation Evaluation does (via the calculator); FAS executes downstream.
  • Does NOT process accident claims — ARC does.

── WHO FLIPS A UNIT BACK TO ACTIVE/HEALTHY ──
FAS flips it in most cases, AFTER verifying WO completion:
  • Non-AFP geofenced (trailers/power): site or vendor completes repair → FAS gets a Chime/Slack request OR catches it on the daily Reach Ready Report → verify WO complete in Reach/RG → flip to Active/Healthy in AAP → site pre-trips → if defect-free, back in service; if not, a new Reach event opens and the cycle restarts.
  • AFP units (unscheduled): repairs complete → FAS requests a tow via FleetNet → flips AAP to "To Be Returned" → DSS contacts the carrier to verify → DSS updates back to Active.
  • AFP returns (EOL/swap): FAS does the Record360 return inspection → sets AAP "Unavailable/Damage Moderate" + rental "Reconditioning" → once defects clear → "Ready to Rent".
  • AFP DCs (EOL): MCS Deployment does the FINAL AAP flip to EOL after a valid Record360 return inspection.
Flip BLOCKERS: WO completion not verified; failed PM or expired DOT inspection (unit stays unavailable, FAS escalates to scheduled-maintenance-trailers@amazon.com); open work orders still pending.

── OWNERSHIP MAP ──
  • Vendor assignment (VRE): MCS assigns day-to-day via Pending Assignment queue. FAS overrides at WO creation when VRE is wrong, requests reassignment after 3rd failed estimate, coaches vendors daily. FAS CANNOT change VRE rules (Vendor Procurement only).
  • Post-repair verification: shared — MCS verifies via vendor comments/photos; FAS verifies WO completion before flipping, uses the Reach Ready Report, flips AAP, does Record360 inspections, compares return vs handoff photos. FAS does NOT verify repairs it can't physically see (off-site AFP at dealers — MCS/vendor does).
  • Invoice/billing disputes: AFP Leadership approves adjustments; MCS buddy gathers invoices. FAS investigates via PARAGON, tracks in AFP-MX-Escalations QUIP, surfaces discrepancies (partners: 14 days to dispute; 2hr ack / 72hr resolution SLA). FAS does NOT approve the credit.
  • PM scheduling: MCS Scheduled Maintenance team. FAS escalates expired DOT, requests immediate service when PM due within 3 days, uses SM trailer Slack Escalation, flags Gas Tank sites for exemption. FAS does NOT build the schedule or assign PM WOs.
  • Accident repairs: ARC team (claims); MCS flags ARC-claimable in RG. FAS owns on-site investigation, photo comparison, ARC report creation, down-unit SIMs/cases. FAS does NOT process claims.
  • EOL decisions: MCS Estimation Evaluation determines EOL (calculator); L4H approves. FAS executes downstream (AFP: swap check + SIM folder; TOM DCs/YHs: tag out, EOL Quip Tracker, flip AAP to EOL, resolve SIM).
`;

module.exports = { FAS_KNOWLEDGE };
