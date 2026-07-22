'use strict';
/**
 * orcha/aap_wizard_knowledge.js — Relay Garage / AAP Work Request wizard
 * ground-truth SOP, provided directly by the user (2026-07-22) to replace
 * the AI agent's previous generic/guessed wizard-step knowledge in
 * aap_adaptive_agent.js's buildPrompt().
 *
 * SCOPE NOTE: this covers ONLY what happens inside the AAP "Create Work
 * Request" wizard itself -- the six screens the adaptive agent actually
 * fills out. Deliberately EXCLUDED (out of scope for a DOM-filling agent):
 *   - FleetNet Portal (fleethq.com) tow dispatch -- a separate external
 *     system, not part of this wizard
 *   - ARC / Ryder / Penske / Briggs phone numbers -- human phone calls
 *   - YMS red/yellow tagging, DVIR/VTI, post-repair A/H flip -- separate
 *     human workflows outside the wizard
 *   - ITR / RTP / MCS-ITR Slack + Quip workflow -- post-submission human
 *     process, happens after and outside this wizard entirely
 *   - DECISIV / Service Tracker Next Gen case creation for AFP dealer
 *     repairs -- a separate system
 * Including any of the above in the agent's prompt would only add noise
 * to a task that is purely "fill this one web form correctly."
 *
 * ACCURACY NOTE: the user explicitly flagged that an earlier version of
 * the Urgency rule they provided was inaccurate. This file uses their
 * SECOND, more detailed correction (OTR / power-unit / hostler-availability
 * / VRID triggers). If this also turns out inaccurate, it is isolated to
 * the URGENCY_RULE constant below for a fast, single-place fix.
 */

const WIZARD_KNOWLEDGE = `
RELAY GARAGE / AAP WORK REQUEST WIZARD -- GROUND TRUTH (POWER UNITS: TRACTOR, HOSTLER, BOX TRUCK)
This is real internal SOP, not a guess -- follow it exactly over any generic assumption.

SCREEN 1 -- SELECT EQUIPMENT (same for all scenarios)
- Enter the Power Unit Asset ID (Equipment ID).
- The page will auto-populate Asset Type (Tractor/Hostler/Box Truck), VIN, Owner, Make, Model Year, Lifecycle State, Program once the ID is accepted -- READ these back from the page snapshot to know which asset type you're dealing with for the rules below.
- Verify Owner/Program shown (Amazon-owned, Rental, or AFP) -- this affects vendor assignment later.

SCREEN 2 -- LOCATION (three options, pick the one matching where the unit physically is)
- On Site (Yard) -- Geofence: unit is at a TOM/Amazon yard. Select from the geofence dropdown.
- Off Site (Address): unit is at a 3P yard, truck stop, vendor shop, shipper/receiver. Enter Street, City, State, Zip.
- Roadside: unit broke down OTR (highway/shoulder/rest area). Enter street address or mile marker + highway.
- For a TOW request: this is the tow PICK-UP point (where the unit currently is), not the destination.
- CRITICAL: location cannot be changed after submission. Get this right the first time.

SCREEN 3 -- WORK REQUEST DETAILS
- Title: Why-What-Where format. Standard example: "Engine misfire - Tractor 521011 - In-yard DFW7". Tow example: "TOW - No start, dead battery - I-40 MM 215 eastbound". A tow title must clearly contain "TOW" plus the reason.
- Asset Condition (radio): "Safe to Move" or "Unsafe to Move" -- for tow scenarios this is typically "Unsafe to Move" (non-drivable) unless it's an in-yard-only tow.
- Urgency: mark URGENT if ANY of the following apply -- asset is OTR, asset is a power unit (all power units are treated as urgent per policy), hostler is at a site with under 80% hostler availability, or the unit has an active VRID (load assignment) attached. If urgent, a reason + comment explaining why is required, and Need By Date should be set ~4 hours out. If non-urgent, Need By Date ~24 hours out. Most tow scenarios are urgent.
- Loaded status: for Tractors, if a loaded trailer is still attached, mark Loaded = Yes (this may require a transload for tow scenarios). For Hostlers/Box Trucks this is typically not applicable (No).
- ARC Claim Number: MANDATORY if this is an accident/collision. Leave blank otherwise.
- Tractor Down SIM: MANDATORY for Tractor and Box Truck work requests -- paste the SIM ID into the field if the payload provides one. Optional/not required for Hostlers.

SCREEN 4 -- ISSUE DETAILS
- Description: explain WHY the WR is being created. Include whatever specifics are in the payload -- fault codes, PSI/tire readings, sensor data, symptoms, driver observations.
- Work Area (Area of Concern) dropdown -- common categories: Engine, Brakes, Electrical, Tires, Transmission, HVAC, Suspension, Fifth Wheel, Body/Cab, Coupling, Steering, Tow, Fluid Levels. Select the Sub Area that matches the specific component from the payload.
- TOW-SPECIFIC: select "Tow" as the Work Area itself. The Sub Area should be the reason the tow is needed (e.g., Engine failure, Transmission failure, Brake failure, Electrical/no start, Tire, Accident/collision, Other). A "Towing Destination" dropdown and a "Transload Required" Yes/No field will typically appear once Tow is selected -- fill both from the payload if present.
- Multiple defects: click "+" to add additional Work Area/Sub Area pairs if the payload has more than one areaPair. If one of the pairs is Tires and another is non-tire, note this is normally supposed to be two SEPARATE work requests (one per vendor) -- but only split them if explicitly instructed to; otherwise proceed with what the payload actually contains.
- Tire-specific (CONFIRMED LIVE, 2026-07-22 -- verified against real AAP screenshots): selecting "Tires" as the Work Area reveals TWO additional dropdowns in that same row, not one. (1) "Select Tire Position" -- fill this from the payload's matching areaPair.subcategory (e.g. "Drive Left Front Inside", "Steer Right", etc.). (2) "Tire Size" -- always select whatever appears as the FIRST/default option in this dropdown's list (it will be 295/75R22.5). Do not try to type a custom size or compute one from the payload -- the correct behavior here is simply picking the first option every time.

SCREEN 5 -- COMMENTS
- Add the payload's comments text. Mark comments as "External"/"Shared with Vendor" if the payload indicates the vendor should see them (this is the normal case unless told otherwise).
- For a TOW: comments should carry whatever location/access/safety detail the payload provides (exact location, drivable/non-drivable, trailer attached, access instructions) -- don't fabricate detail that isn't in the payload.

SCREEN 6 -- REVIEW & SUBMIT
- Vendor Assignment guidance if the payload doesn't already specify a vendor: tire-only repair -> Goodyear; standard non-tire mechanical -> TA (or per VRE/Preferred Vendor List if shown on page); TOW request -> FleetNet; AFP dealer/warranty -> the OEM (Freightliner/Kenworth/Peterbilt/Volvo); rental unit -> return to the rental provider (not a repair vendor).
- Confirm all fields entered so far match the payload before submitting, then click Submit Request.
`.trim();

module.exports = { WIZARD_KNOWLEDGE };
