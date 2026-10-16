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

── ESCALATION SEVERITY (SEV5–SEV2) — fleet MAINTENANCE severity (not RME/FC severity) ──
This drives the Long Dwell "Escalation" column AND "should I escalate?" judgments. SEV2 = highest.
  • SEV5 — MONITOR (0–3 days): WO open, vendor assigned, ETC set and not passed; repair progressing normally. FAS just logs it in the QUIP/daily tracker. No action unless it's a risk site or a power unit at a site with excess ≤1. Engaged: FAS only (passive).
  • SEV4 — REQUEST STATUS / ETC (4–7 days): ETC approaching or just passed, OR vendor silent 2+ days, OR estimate sitting past SLA; vendor slow but still engaged. FAS calls/emails the vendor for an updated ETC, pings MCS buddy to check Reach/RG, updates the delay tracker with a reason. Engaged: FAS + vendor + MCS buddy.
  • SEV3 — ACTIVE ESCALATION (7–14 days): ETC passed with no update, OR vendor non-responsive 3+ business days (HVE Playbook trigger), OR estimate rejected twice, OR parts delay with no ETA. Unit is now on the "Asset Down over 7D" list. FAS escalates to MCS Lead (WO pending estimate approval past SLA → MCS Lead), pushes the vendor hard, considers reassignment, documents in the FAS2UM SIM. Engaged: FAS + MCS Lead + vendor directly.
  • SEV2 — LEADERSHIP + ASANA (14+ days OR any instant-bump trigger): repair stalled with no clear path, multiple barriers, vendor out of scope / reassignment needed, or a systemic pattern across units/sites. FAS files a Vendor Performance Escalation Asana, escalates to the Uptime Manager (UM); if UM can't resolve locally, UM takes it to the Vendor Performance (VP) team per the VP Escalation Matrix; loop in L4H/HVE if high-value. Engaged: FAS + UM + VP team + L4H (if HVE). VP team has a 24hr ack SLA on Asana intakes.

INSTANT-BUMP TRIGGERS (apply a severity bump on Day 1, regardless of days down):
  • No ETC within 24h of vendor assignment → SEV4 minimum.
  • ETC passed with zero update → immediate SEV3; if it happens twice → SEV2.
  • Vendor rejected / out of scope → immediate SEV3 (need reassignment via VRE override or MCS move).
  • 3rd failed estimate submission (MCS already rejected twice) → escalates TO FAS; SEV2 territory (reassign vendor + file VP Asana).
  • Multiple repair attempts on the same defect (quality issue) → SEV3 minimum; document for the VP Asana.
  • DOT-critical safety item (brakes, air system, steering, frame/structural cracks, fifth wheel, DOT-noncompliant lights/electrical) → automatic SEV3 minimum (unit can't legally operate; failed DVIR keeps it Unavailable). If also at a risk site → immediate SEV2.
  • Site at risk (FAS Master Dashboard: excess <1 for TOM power units, or Red Risk Flag for Trailer Gas Tank Model) → any down unit there gets +1 severity.
  • AFP unit with partner escalation (via Resource Center) → SEV3 minimum (external SLA clock: 2hr ack / 72hr resolution; partner trust at stake).

SEV2 / "needs leadership NOW" triggers: 14+ days down with no clear path; same vendor stalling on 3+ units across sites (network-level → transfer to Vendor Management); DOT-critical defect at a risk site (excess ≤1 power); estimate >$30K (L4H/HVE inherently involved); EOL evaluation needed; AFP partner escalated AND 72+ hours elapsed; vendor completely non-responsive 5+ business days.

Vendor Performance Escalation Asana SOP: FAS identifies vendor barriers (SLA adherence, staffing, repair quality, behavior) → documents in FAS2UM SIM, tries local resolution first → if the UM can't resolve recurring issues locally, UM escalates to the VP team per the VP Escalation Matrix (24hr ack SLA). L4H technician specialists deep-dive estimates over $5,000.

ESCALATION PATH / WHO FAS CONTACTS PER SEV:
  • SEV5: nobody external — log in the QUIP/daily tracker ("Unit X, Vendor Y assigned, ETC <date>, monitoring").
  • SEV4: vendor directly (phone + email) for an updated ETC; MCS buddy via Chime/Slack to check Reach/RG.
  • SEV3: MCS Lead (email/Chime, owns WOs pending estimate approval past SLA); vendor shop manager directly (escalated tone); Mechanical Escalations Slack if needed; document in FAS2UM SIM.
  • SEV2: Uptime Manager (email) + Vendor Performance team (VP Escalation Asana form) + L4H/HVE (Chime) for high-value units. Asana includes program, region, escalation type (repair quality / capacity-staffing / SLA adherence), prior documentation, FAS2UM SIM history, files. Vendor issues affecting multiple assets/AFPs → transfer to Vendor Management for network-level escalation to vendor corporate.
Standing escalation addresses: PM-related → fleet-fas@amazon.com + scheduled-maintenance-trailers@amazon.com. AFP invoice/maintenance tracking → AFP-MX-Escalations QUIP.

── VENDORS & DEALERS ──
IMPORTANT: specific dealer NAMES, CONTACTS, PO/fleet codes, and MTTR numbers change over time and live in the CONTACT BOOK (the authoritative, current source) — defer to it for who/where/phone. Use the ROUTING RULES and SCOPE BOUNDARIES below (which are durable) to decide WHAT KIND of vendor a repair needs; get the actual vendor from the Contact Book / VRE.

Vendor types (what each kind does):
  • Amerit — 1P mobile/onsite primary at AFP lots (platform REACH). Unscheduled + scheduled (PM-B) + projects, 5th-wheel repairs, APU repairs at AFP lots, warranty up to $3K, enhanced safety inspections. Fastest for simple onsite work. Volatile capacity (tech shortages). No longer replaces wings.
  • TA / Kooner / Cox Auto (Dickinson) / Velociti / FleetPride / TARS / Push & Pull — 3P mobile/onsite at reassigned PO sites (platform Relay Garage). Overflow + general fleet maintenance. (FleetPride historically most consistent uptime; Kooner strong/improving; Cox Auto has had sites under review — but treat performance as time-sensitive, confirm current data.)
  • Goodyear — 3P tire specialist (tires only).
  • CEI — 3P body/accident damage network (the single AFP physical-damage vendor); minor body repairs route back to Amerit, larger damage → CEI network shops. Non-integrated (phone/email).
  • FleetNet — TOWING dispatch only (not a repair vendor), via the FleetHQ portal; AFP + OTR towing.
  • OEM dealers — when work is beyond primary/mobile scope. Platforms by make: PACCAR (Kenworth/Peterbilt) → DECISIV; Volvo → DECISIV/ASIST (or Volvo Uptime Center); Freightliner (DTNA) → Service Tracker Next Gen; TICO (hostlers) → DECISIV/TICO EDGE or TICO Uptime Center; Cummins → direct WO in Relay Garage (no DECISIV case). (Specific dealers/contacts: Contact Book.)

Routing rules — BY MAKE (OEM matching): Volvo → Volvo dealer/Uptime Center; Kenworth → Kenworth dealer; Peterbilt → Peterbilt dealer; Freightliner → Freightliner dealer (CNG → a CNG-certified Freightliner dealer only); Cummins ENGINE issue (any chassis OEM) → Cummins direct via Relay Garage. (Watch: Cummins PARTS delays can strand units at other OEM dealers for weeks — flag long parts dwell.)

Routing rules — BY REPAIR TYPE: standard unscheduled at an AFP lot → Amerit first (VRE auto-assigns); body/accident damage → CEI (minor → back to Amerit); CNG-specific (cylinder head, crankcase vent, FSOV, fuel system) → CNG-certified OEM dealer/Cummins distributor only; tires → Goodyear; APU at an AFP lot → Amerit, APU outside the lot → nearest APU dealership (NOT the OEM tractor dealer); warranty ≤$3K → Amerit, >$3K → OEM dealer (warranty channel: Slack #Wty-escalation or GET Case); 5th wheel → Amerit; towing → FleetNet; simple roadside (mud flaps, airlines) → TARS first, if they can't complete → tow back to AFP; trending defect or beyond onsite capability → FAS may go directly to the OEM dealer (bypass the reject→dealer flow). VRE auto-populates by site/region; FAS overrides when VRE is wrong. Canada: assign via VRE (Canada Vendor List QUIP). A quarterly Preferred Dealer List + Dealer Locator Map (filter by OEM code / site proximity) is maintained by Vendor Management + FAS.

Scope — what's OUT OF SCOPE for mobile/Amerit (must go to a dealer): transmission internals; major engine work (e.g. cylinder heads); CNG-specific engine/fuel system; turbo passing oil to EAS; body/structural damage (→ CEI); warranty >$3K; OEM-proprietary deep diagnostics (Amerit has Bendix Acom / Service Ranger / DDL8 but not everything); APU outside the AFP lot; multiple simultaneous repairs needing different specialists; unit wings (Amerit no longer does these); recalls/mini-overhauls (may route to Cummins).

Dealer-handoff flow (3 ways a WO reaches a dealer): (1) mobile vendor REJECTS ("can't do this"); (2) mobile vendor COMPLETES what it can + comments "needs dealer"; (3) FAS DIRECT (trending defect / beyond onsite). Flow: primary rejects → MCS notifies FAS → FAS picks the dealer → MCS creates the proxy WO + DECISIV/Service Tracker case → tow → dealer repairs → tow back.
FAS 2-HOUR WINDOW: when a WO must go to a dealer, FAS has 2 hours to give MCS a dealer assignment. FAS calls dealers to check bay availability/capacity; if a dealer can't do diagnostics within 8h or provide a bay within 24h, FAS moves to the next preferred dealer. If FAS misses the 2h window or it's off-shift, MCS uses the Preferred Dealer List.
`;

module.exports = { FAS_KNOWLEDGE };
