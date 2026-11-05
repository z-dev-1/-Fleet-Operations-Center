'use strict';
// src/dbr/review-engine.js — main-process CJS port of the CURRENT renderer DBR
// review logic in renderer/src/js/views/daily-call.js (TREND_TERMS through
// _dbrNormalizeHelpText below are copied verbatim, comments included).
//
// Why a port and not a shared module: daily-call.js is a Vite-built ES module
// that imports renderer-only modules, and src/scrapers/dbr_pull.js carries an
// older drifted copy (and requires electron). tests/dbr-lookup-engine-parity
// .test.js extracts the renderer source, runs it in a sandbox and asserts this
// port is byte/value identical; a sha1 tripwire golden of the renderer blocks
// fails when the renderer changes, so this file must be updated with it.
//
// No electron / store / relay requires: pure and unit-testable.

// ── Verbatim port from renderer/src/js/views/daily-call.js ──────────────────
const TREND_TERMS = [
  ['CCV module',        /\bccv\b/i],
  ['Misfire',           /\bmisfire/i],
  ['Turbo',              /\bturbo/i],
  ['Injector',          /\binjector/i],
  ['Coolant leak',      /\bcoolant\s*leak/i],
  ['Oil leak',          /\boil\s*leak/i],
  ['Oil pan',           /\boil\s*pan/i],
  ['Transmission',      /\btransmission\b/i],
  ['Clutch',            /\bclutch\b/i],
  ['Accident',          /\baccident\b/i],
  ['5th Wheel',         /\b(5th|fifth)\s*wheel/i],
  ['Tires',             /\btires?\b/i],
  ['Brakes',            /\bbrakes?\b/i],
  ['Battery',           /\bbatter(y|ies)\b/i],
  ['Alternator',        /\balternator/i],
  ['Starter',           /\bstarter\b/i],
  ['Check engine light',/\b(check engine|\bcel\b)/i],
  ['Suspension',        /\bsuspension\b/i],
  ['Steering',          /\bsteering\b/i],
  ['Air conditioning',  /\b(air condition|\bhvac\b)/i],
  ['Air leak',          /\bair\s*leak/i],
  ['Liftgate',          /\bliftgate\b/i],
  ['Body damage',       /\bbody\s*(damage|shop)\b/i],
  ['DEF system',        /\bdef\b/i],
  ['DPF',               /\bdpf\b/i],
  ['EGR',               /\begr\b/i],
  ['Expired inspection',/\bexpired\s*inspection/i],
  ['Overdue PM',        /\boverdue\s*pm\b/i],
  ['Expired PM',        /\bexpired\s*pm\b/i],
  ['Wiring/harness',    /\b(wiring|harness)\b/i],
  ['Axle',              /\baxle\b/i],
  ['Differential',      /\bdifferential\b/i],
  ['Fuel system',       /\bfuel\s*(system|pump|line|tank)\b/i],
  ['Sensor fault',      /\bsensor\b/i],
  ['Crankcase',         /\bcrankcase\b/i],
  ['Wheel seal',        /\bwheel\s*seal/i],
  ['Alignment',         /\balignment\b/i],
  ['CNG tank',          /\bcng\s*tank/i],
  ['5th wheel parts',   /\b5th\s*wheel\s*parts/i],
];

const TREND_MIN_UNITS = 3; // per user: "must be 3 or more repairs of same for the site"

const BARRIER_TERMS = [
  ['No vendor assigned',      /^(--|unassigned)$/i, 'vendor'],   // matched against row.vendor, not text
  ['Parts delay',              /\bparts?\b.*\b(delay|backorder|sourcing|eta|pending)\b|\bsourcing_parts\b/i],
  ['Technician shortage',      /\btech(nician)?\s*shortage/i],
  ['Vendor backlog',           /\bbacklog\b/i],
  ['Estimate rejected',        /\brejected\b/i],
  ['Estimate pending approval',/\b(pending|awaiting)\s*(estimate|approval)/i],
  ['Offsite repair delay',     /\boffsite\b/i],
  ['Dealer delay',             /\bdealer\b.*\b(delay|backlog|lead time)\b/i],
  ['Expired inspection',       /\bexpired\s*inspection/i],
  ['Expired/overdue PM',       /\b(expired|overdue)\s*pm\b/i],
];

const FLIP_SIGNAL = /\b(repair complete|repairs? completed|road[- ]?test(ed)?|ready for (pickup|release)|returning to service|release(d)? back to fleet|flip(ping)? (to|back) (a\/h|available)|complete[d]? (today|this morning))\b/i;

const STATUS_BARRIER_MAP = {
  'waiting for vendor':   'Waiting for vendor response',
  'awaiting estimate':    'Awaiting estimate approval',
  'parts backordered':    'Parts backordered',
  'under diagnosis':      'Diagnosis unresolved',
};

function _unitText(r) {
  return [r.issueDetails || '', r.issueSummary || '', r.savedNotes || '', r.savedRepairStatus || '', r.repairTimeline || ''].join(' ');
}

function _parseDaysOpen(r) {
  if (r.workDuration) {
    const m = r.workDuration.match(/^(\d+)d/);
    if (m) return parseInt(m[1], 10);
  }
  if (r.created) {
    const dm = r.created.match(/\((\d+)\s+days?\s+ago\)/i);
    if (dm) return parseInt(dm[1], 10);
    if (/a month ago/i.test(r.created)) return 30;
    const mm = r.created.match(/(\d+)\s+months?\s+ago/i);
    if (mm) return parseInt(mm[1], 10) * 30;
  }
  return null;
}

function _isUnavail(r) {
  return (r.lifecycleState || '').toLowerCase().includes('unavail');
}

function _computeGroup(groupRows, allRowsInGroup) {
  const total    = allRowsInGroup.length;
  const unavail  = groupRows; // already filtered to unavailable
  const uptime   = total ? Math.round(((total - unavail.length) / total) * 1000) / 10 : 100;

  // Trends — tally specific term -> Set(unitId)
  const trendMap = {};
  for (const r of unavail) {
    const text = _unitText(r);
    const daysOpen = _parseDaysOpen(r);
    const op = (r.operator || '').toUpperCase().trim();
    for (const [label, re] of TREND_TERMS) {
      if (re.test(text)) {
        if (!trendMap[label]) trendMap[label] = { ids: new Set(), days: [], operators: new Set() };
        trendMap[label].ids.add(r.equipmentId || r.id || '?');
        if (daysOpen !== null) trendMap[label].days.push(daysOpen);
        if (op) trendMap[label].operators.add(op);
      }
    }
  }
  const trends = Object.entries(trendMap)
    .filter(([, v]) => v.ids.size >= TREND_MIN_UNITS)
    .map(([label, v]) => {
      const count = v.ids.size;
      const units = Array.from(v.ids);
      const minDays = v.days.length ? Math.min(...v.days) : null;
      const maxDays = v.days.length ? Math.max(...v.days) : null;
      const avgDays = v.days.length ? Math.round(v.days.reduce((s, d) => s + d, 0) / v.days.length) : null;
      // Persisting: same issue open 7+ days across units; Emerging: all < 3d; else Recurring
      const direction = maxDays === null ? 'Recurring' : maxDays >= 7 ? 'Persisting' : maxDays < 3 ? 'Emerging' : 'Recurring';
      // daysRange: "Xd" if uniform, "X–Yd" if spread; shown in output as duration window
      const daysRange = minDays !== null ? (minDays === maxDays ? `${minDays}d` : `${minDays}–${maxDays}d`) : null;
      const scacs = Array.from(v.operators);
      return { label, count, units, direction, avgDays, daysRange, scacs };
    })
    .sort((a, b) => b.count - a.count);

  // Barriers (draft) — tally candidate signal -> count
  const barrierMap = {};
  let noVendorCount = 0;
  for (const r of unavail) {
    const v = (r.vendor || '--').trim();
    if (!v || v === '--' || v.toLowerCase() === 'unassigned') noVendorCount++;
    const text = _unitText(r);
    for (const [label, re] of BARRIER_TERMS) {
      if (label === 'No vendor assigned') continue; // handled above via vendor field
      if (re.test(text)) {
        if (!barrierMap[label]) barrierMap[label] = { count: 0, days: [] };
        barrierMap[label].count++;
        const bd = _parseDaysOpen(r);
        if (bd !== null) barrierMap[label].days.push(bd);
      }
    }
    // Structured signal straight from the scraped repair-status field --
    // catches real vendor/parts/estimate barriers that don't happen to
    // contain any of the BARRIER_TERMS keywords (e.g. "Waiting for vendor"
    // status with terse notes text like "PM B failed").
    const statusLabel = STATUS_BARRIER_MAP[(r.savedRepairStatus || '').trim().toLowerCase()];
    if (statusLabel) {
      if (!barrierMap[statusLabel]) barrierMap[statusLabel] = { count: 0, days: [] };
      barrierMap[statusLabel].count++;
      const sd = _parseDaysOpen(r);
      if (sd !== null) barrierMap[statusLabel].days.push(sd);
    }
  }
  if (noVendorCount > 0) {
    if (!barrierMap['No vendor assigned']) barrierMap['No vendor assigned'] = { count: 0, days: [] };
    barrierMap['No vendor assigned'].count += noVendorCount;
  }
  const barriers = Object.entries(barrierMap)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([label, v]) => {
      const avgDays = v.days.length ? Math.round(v.days.reduce((s, d) => s + d, 0) / v.days.length) : null;
      return `${label} (${v.count} units${avgDays ? ', avg ' + avgDays + 'd' : ''})`;
    });

  // Expected flips (draft)
  const flipUnits = unavail.filter(r => FLIP_SIGNAL.test(_unitText(r))).map(r => r.equipmentId || r.id || '?');

  // FEATURE (2026-07-17): raw per-unit text kept on the group object so the
  // AI verification pass (see _buildAIPrompt/_validateAIResult below) can
  // cross-check against the ACTUAL source text and cite real unit IDs --
  // never let AI "verify" against a summary of a summary.
  const unavailRows = unavail.map(r => ({
    id: r.equipmentId || r.id || '?',
    // 300 -> 900: _unitText now includes repairTimeline (the day-by-day
    // narrative where actual barrier language lives -- "pending ETC",
    // "awaiting technician assignment", etc). 300 chars truncated most
    // timelines to nothing useful. This cap just bounds what's kept in
    // memory/cache -- _buildAIPrompt (below) does its own budget-aware
    // re-truncation per unit based on how many rows actually go in the
    // prompt, so this doesn't need to worry about MAX_PROMPT_LEN itself.
    text: _unitText(r).trim().substring(0, 900),
    daysOpen: _parseDaysOpen(r),
    vendor: (r.vendor && r.vendor !== '--') ? r.vendor : null,
    repairStatus: r.savedRepairStatus || null,
    operator: (r.operator || '').toUpperCase().trim() || null,
    make: (r.make || '').trim() || null,
    // DBR Trends header ("10 OOS; 9 CNG, 1 Diesel") + reason grouping ("OSR; ...").
    fuelType: (r.fuelType || '').trim() || null,
    lifecycleReason: (r.lifecycleReason || '').trim() || null,
  }));

  return {
    total, unavailCount: unavail.length, uptime,
    trends, barriers, flipUnits, unavailRows,
  };
}

function _dbrBuildReviewPrompt(label, computed) {
  const rows = computed.unavailRows.slice(0, 60);
  const perUnitBudget = Math.max(350, Math.min(900, Math.floor(16000 / Math.max(rows.length, 1))));
  const unitLines = rows.map(u => {
    const meta = [
      u.operator ? `SCAC: ${u.operator}` : '',
      u.make ? `Make: ${u.make}` : '',
      u.fuelType ? `Fuel: ${u.fuelType}` : '',
      u.lifecycleReason ? `Reason: ${u.lifecycleReason}` : '',
      u.vendor ? `Vendor: ${u.vendor}` : 'Vendor: unassigned',
      (u.daysOpen !== null && u.daysOpen !== undefined) ? `Days down: ${u.daysOpen}` : '',
      u.repairStatus ? `Repair status: ${u.repairStatus}` : '',
    ].filter(Boolean).join(' | ');
    return `[${u.id}]${meta ? ' ' + meta : ''}\n${(u.text || '(no issue text)').substring(0, perUnitBudget)}`;
  }).join('\n\n');

  return `You are filling in a fleet operations DBR (Daily Business Review) call sheet row for ${label}. You are a SUPPORTING / VERIFICATION source only — never invent information not present in the unit data below.

${rows.length} unavailable (OOS) unit(s) at this ${label}. Per-unit data below (SCAC, Make, Fuel, lifecycle Reason, Vendor, Days down, Repair status, and raw issue/notes text).

UNIT DATA:
${unitLines}

Fill FIVE fields using the EXACT logic below. Follow each step in order — this is not a style guide, it's the actual procedure to run.

══════════════════════════════════════
TRENDS — "What patterns do I see?"
══════════════════════════════════════
Work through this ANALYSIS SILENTLY (do not print your reasoning, counts-that-didn't-qualify, or "no single system reaches 3+" explanations into the output — the output is ONLY the final verdict, nothing else):
1. Count the OOS units (shown above) and split them by Fuel (e.g. CNG, Diesel, Electric). Units with no Fuel shown are left out of the split.
2. Group units by SYSTEM (the broad component area the issue text points to). Use these UPPERCASE names: ENGINE/MOTOR SYSTEMS, CHASSIS, ELECTRICAL, TRANSMISSION/DRIVETRAIN, BRAKES, HVAC, BODY/CAB, TIRES/WHEELS, SUSPENSION/STEERING, DEF/EMISSIONS, FUEL SYSTEM, PM/INSPECTION.
3. Group units by VENDOR. Within a vendor, count each blocker type (Parts, Estimate, Diag, Tech/Bay) and the units whose vendor ETC is TODAY.
4. Group units by lifecycle Reason. Abbreviate: Offsite Shop Repair = OSR, Onsite Repair = Onsite, Parts Delay = Parts, Expired Inspection = Insp, PM Failed = PM Fail; other reasons keep their name.
5. THE 3+ RULE: a group is a trend ONLY if 3 OR MORE units share it (same system, same vendor, same reason+system, or same specific issue like "misfire"). 2 units is NOT a trend.
6. If NO group reaches 3+ units, the ENTIRE output must be exactly the two words "No trends" — nothing else. Do not explain why, do not list what you checked, do not print the OOS/fuel line.

OUTPUT FORMAT (only when at least one 3+ trend exists). Plain text, one item per line, in this order. Include a line ONLY if it qualifies; never print a line for a group under 3 units:
Line 1 — header (always first when there is any trend): "<N> OOS; <count> <fuel>, <count> <fuel>"   e.g. "10 OOS; 9 CNG, 1 Diesel"
Vendor lines — for each VENDOR with 3+ OOS units: "<Vendor>; <count> <blocker type>; <count> ETC today; <unit IDs with ETC today>"   e.g. "Amerit; 4 Parts; 2 ETC today; 221019, 521054". Only list the blocker types/ETC parts that apply; drop a part if its count is 0.
Reason lines — for each lifecycle Reason where 3+ units share the same system: "<Reason abbr>; <count> <System> Related"   e.g. "OSR; 3 Engine Related"
System lines — for each SYSTEM with 3+ units: "<SYSTEM>: <count> units", then ONE line per unit in that system, indented with "  - ", giving the unit ID and a quick 3-8 word reason taken from that unit's issue text:
  ENGINE/MOTOR SYSTEMS: 5 units
    - 521054: misfire cyl 3, injector replaced
    - 221019: coolant leak at water pump
List systems largest first. Every unit ID must be a real ID from UNIT DATA, and every reason must come from that unit's own text (never invented).

- NEVER include your work, your rejected candidates, or a sentence explaining the absence of a trend. The field is either "No trends" or the lines above — nothing in between.

══════════════════════════════════════
BARRIERS — "What's blocking each unit?"
══════════════════════════════════════
1. Sort units by days down, LONGEST first.
2. For each unit, classify its #1 blocker into exactly ONE of these 5 categories (pick the closest match from the actual text — do not invent a 6th category):
   - PARTS DELAY (a part number and/or ETA is mentioned, part on backorder/sourcing)
   - ESTIMATE DELAY (estimate pending/awaiting approval)
   - VENDOR DELAY (awaiting technician assignment or bay availability, vendor backlog)
   - ACCIDENT/CEI (legal hold, insurance claim, accident investigation)
   - DIAGNOSTIC (awaiting diagnostic results, root cause not yet determined)
   If a unit genuinely has no blocker evident in the text (e.g. actively being worked, or data too thin to classify), do not force one of the 5 categories — just omit that unit from the barriers list.
3. Write ONE line per unit, longest-dwell first, in this exact form: "Unit ID (Xd): Blocker + ETA" — e.g. "521073 (27d): Parts delay — harness PN, ETA 8/13". If NO unit has a classifiable blocker, write "no barriers".

══════════════════════════════════════
ACTIONS — "What am I doing today?"
══════════════════════════════════════
For EACH unit that has a barrier from above, write ONE action line using this exact mapping from its repair status / situation to a template (fill in the brackets with real values, do not leave them literal):
   - Parts backordered/ordered           → "Follow up with [vendor] on parts ETA for [unit]"
   - Appointment scheduled                → "Confirm vendor arrival for [unit], await inspection results"
   - Pending estimate                     → "Push/escalate estimate for [unit] in RG"
   - Estimate approved                    → "Confirm repair start and ETC for [unit]"
   - In bay / in progress                 → "Follow up with [vendor] on completion ETC for [unit]"
   - Pending tow                          → "Coordinate tow for [unit] to [destination]"
   - If days down > 14, ADD an extra line: "Escalate long-dwell [unit] (Xd)"
Pick the template row that best matches what the unit's repair status / issue text actually says. Every barrier identified above should have a matching action line. If no units need action, return empty string.

══════════════════════════════════════
EXPECTED FLIPS — "Can anything flip today?"
══════════════════════════════════════
Count units where ANY of these is true in the text: parts ETA is TODAY and it's a quick install, OR repair status is "pending road test"/"pending QC", OR vendor has confirmed an ETC of TODAY. If none qualify, the value is "0". Otherwise give the count + unit IDs, e.g. "2 (520079, 39110)".

══════════════════════════════════════
HELP NEEDED — decision logic
══════════════════════════════════════
The DEFAULT answer is "No help needed" — you (the FAS) only escalate when a blocker is genuinely OUTSIDE your authority to resolve yourself. Core rule: if YOU can still take an action today (call vendor, escalate estimate, coordinate tow, push for ETC) → "No help needed". Only if the blocker requires someone ABOVE you (MMPM/BC) to intervene with authority you don't have, state what you need.

Check each unit against these, IN ORDER, and stop at the first one that matches:
1. STUCK ESTIMATE — estimate has been escalated to HVE TWICE and is still not approved (especially high-dollar, e.g. >$50K) → "Help with getting estimate pushed through for [unit]"
2. CEI / LEGAL HOLD — accident unit pending Element, legal review, or salvage/liquidation decision (FAS has no authority to move it) → "Help with CEI/Element action on [unit]"
3. VENDOR MANAGEMENT ISSUE — chronic vendor non-responsiveness, tech shortages, or systemic delays persisting after daily follow-ups → "Help escalating vendor performance with [vendor] at [site]"
4. PARTS SOURCING BEYOND FAS — part is backordered network-wide, no alternate source, needs VP/procurement intervention → "Help sourcing Part #[X] for [unit]"
5. BAY/RESOURCE CONSTRAINT — OEM or vendor has no capacity and alternate routing has already been exhausted → "Help with bay availability at [dealer]"
6. NONE OF THE ABOVE (the normal case, ~95% of the time) — output EXACTLY "No help needed" and nothing more.

Only match checks 1-5 if the unit data text ACTUALLY supports it (e.g. only call it a "stuck estimate" if the text shows it was escalated twice, not just "pending"). Do not invent a need that isn't evidenced in the text — when in doubt, the answer is "No help needed".

STRICT RULES:
- Every claim must cite real unit IDs from the UNIT DATA above. No unit IDs = do not include the claim.
- Do not invent, guess, or extrapolate beyond what the unit data actually states.
- Follow the step-by-step logic exactly — do not skip steps or substitute your own judgment for the stated thresholds (3+ units for any trend claim, 14 days for escalation, HVE escalated twice for stuck estimates, etc).

RESPOND WITH JSON ONLY, no markdown, no explanation outside the JSON. Multi-line values (like the trends block) must use \\n for line breaks inside the JSON string:
{"trends":"","barriers":"","expectedFlips":"","actions":"","helpNeeded":""}`;
}

function _dbrNormalizeTrendsText(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (!text) return '';
  const looksLikeNoTrend = /\bno\s+trends?\b/i.test(text);
  if (looksLikeNoTrend && text.length > 20) return 'No trends';
  // Multi-line trend block (header + vendor/reason/system lines + per-unit
  // reasons) — keep line breaks, drop markdown bullets/bold the model may add.
  return text.replace(/\*\*/g, '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').substring(0, 2000);
}

function _dbrNormalizeHelpText(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (!text) return '';
  const looksLikeNoHelp = /\bno\s+help\s+needed\b/i.test(text);
  if (looksLikeNoHelp && text.length > 20) return 'No help needed';
  return text.substring(0, 300);
}

// ── Helpers mirroring the body of the renderer's _dbrAskAi / _dbrReviewRow ──

// Same messages as the renderer's _dbrAskAi (the timeout one is used by the
// renderer only; main callers pass their own timeoutMessage to askWithTimeout).
const AI_TIMEOUT_MESSAGE = 'AI parsing timed out — the AI service may be unavailable';
const AI_NO_DATA_MESSAGE = 'AI returned no parseable data — the dashboard text may be unusable, or the AI service may be down.';

// Deterministic drafts (always available even if AI fails) — the exact three
// strings _dbrReviewRow builds before calling the AI.
function mechanicalDrafts(computed) {
  const trendsText = computed.trends.length
    ? computed.trends.map(t => `${t.count} ${t.label}${t.daysRange ? ' — ' + t.daysRange : ''}`).join('\n')
    : 'No trends';
  const barriersText = computed.barriers.length ? computed.barriers.join('; ') : 'no barriers';
  const flipsText = computed.flipUnits.length ? `~${computed.flipUnits.length} (${computed.flipUnits.slice(0, 6).join(', ')})` : '0';
  return { trendsText, barriersText, flipsText };
}

// The parse half of _dbrAskAi: accepts { text } or a raw string.
function parseAiJson(result) {
  const text = (result && result.text) ? result.text : (result || '');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(AI_NO_DATA_MESSAGE);
  return JSON.parse(match[0]);
}

// Same result shape, caps and catch-fallback as the renderer's _dbrReviewRow,
// for an already-matched list of unavailable units. askAi(prompt) is injected
// and must resolve to the parsed JSON object (see parseAiJson).
async function reviewRow(units, label, askAi) {
  if (!units.length) {
    return { trendsText: '', barriersText: '', flipsText: '', actionsText: '', helpText: '', error: 'No matching units found in fleet data' };
  }
  const computed = _computeGroup(units, units);
  const mech = mechanicalDrafts(computed);
  try {
    const prompt = _dbrBuildReviewPrompt(label, computed);
    const parsed = await askAi(prompt);
    return {
      trendsText: _dbrNormalizeTrendsText(parsed.trends) || mech.trendsText,
      barriersText: typeof parsed.barriers === 'string' && parsed.barriers.trim() ? parsed.barriers.trim().substring(0, 400) : mech.barriersText,
      flipsText: typeof parsed.expectedFlips === 'string' && parsed.expectedFlips.trim() ? parsed.expectedFlips.trim().substring(0, 200) : mech.flipsText,
      actionsText: typeof parsed.actions === 'string' ? parsed.actions.trim().substring(0, 400) : '',
      helpText: _dbrNormalizeHelpText(parsed.helpNeeded),
    };
  } catch (e) {
    return { trendsText: mech.trendsText, barriersText: mech.barriersText, flipsText: mech.flipsText, actionsText: '', helpText: '', aiError: e && e.message };
  }
}

module.exports = {
  TREND_TERMS, TREND_MIN_UNITS, BARRIER_TERMS, FLIP_SIGNAL, STATUS_BARRIER_MAP,
  AI_TIMEOUT_MESSAGE, AI_NO_DATA_MESSAGE,
  unitText: _unitText,
  parseDaysOpen: _parseDaysOpen,
  isUnavail: _isUnavail,
  computeGroup: _computeGroup,
  buildReviewPrompt: _dbrBuildReviewPrompt,
  normalizeTrendsText: _dbrNormalizeTrendsText,
  normalizeHelpText: _dbrNormalizeHelpText,
  mechanicalDrafts, parseAiJson, reviewRow,
};
