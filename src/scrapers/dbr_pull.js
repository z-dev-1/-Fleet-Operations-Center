'use strict';
/**
 * dbr_pull.js — Main-process DBR DATA pull (scrape + AI-parse + per-row review).
 *
 * This is the UNATTENDED, scheduler-driven equivalent of what the Daily Call
 * renderer panel does interactively (renderer/src/js/views/daily-call.js). It
 * runs ENTIRELY in the main process so the scheduler can pull DBR data with no
 * window focused and no renderer involvement:
 *
 *   1. scrape the AFP / DSP QuickSight dashboard  (scrapers/quicksight_dbr.js)
 *   2. gate on freshness — the dashboard's "Data as of (PT)" must be TODAY
 *      (Pacific), else the data isn't populated yet and the caller retries
 *   3. AI-parse the raw page text into structured rows  (relay.ask in main)
 *   4. for each row that is "mine" (matches the user's domiciles/carriers),
 *      run the deterministic + AI review that fills Trends / Barriers /
 *      Expected Flips / Actions / Help Needed
 *   5. persist the structured result to the SAME store keys the renderer's
 *      saveParsed path writes (quicksightDbr / quicksightDbrDsp) so the DBR
 *      panel shows the scheduled result with no extra wiring
 *
 * The prompt builders + deterministic review engine here are a FAITHFUL PORT
 * of the renderer versions (daily-call.js). They are plain-JS (no DOM, no
 * window.*, no localStorage), so keeping them in sync is a copy, not a
 * refactor — if the renderer prompts change, mirror them here.
 *
 * AI: window.ai.ask (renderer) routes through ipc ai:ask -> askOrcha ->
 * relay.ask. Here we call relay.ask DIRECTLY. NOTE relay.ask resolves to a
 * PLAIN STRING (the model's text), not { ok, text } — _dbrAskAi handles that.
 */

const store = require('../store');
const qs    = require('./quicksight_dbr');
let logger; try { logger = require('../utils/logger').createLogger('dbr-pull'); } catch (_) { logger = { info(){}, warn(){}, error(){} }; }

const AI_TIMEOUT_MS = 95000;

// ── AI call (main process) ────────────────────────────────────────────────
// relay.ask returns the model's raw text (a string). Extract the first {...}
// JSON blob and parse it — same contract the renderer's _dbrAskAi enforces.
async function _dbrAskAi(prompt) {
  const relay = require('../orcha/relay');
  const text = await Promise.race([
    relay.ask(prompt, {}),
    new Promise((_, rej) => setTimeout(() => rej(new Error('AI parsing timed out — the AI service may be unavailable')), AI_TIMEOUT_MS)),
  ]);
  const s = typeof text === 'string' ? text : (text && text.text) ? text.text : '';
  const match = s.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI returned no parseable data — the dashboard text may be unusable, or the AI service may be down.');
  return JSON.parse(match[0]);
}

// ═══════════════════════════════════════════════════════════════════════════
// PARSE PROMPTS (ported verbatim from daily-call.js _dbrAfpPrompt/_dbrDspPrompt)
// ═══════════════════════════════════════════════════════════════════════════
function _dbrAfpPrompt(pageText) {
  return 'You are reading plain rendered text copied from an AWS QuickSight dashboard page (document.body.innerText — not HTML, so pivot tables render in a specific flattened order, NOT as neat rows of "label value value value").\n\n'
    + 'CRITICAL — HOW THESE PIVOT TABLES ACTUALLY RENDER IN THIS TEXT (read carefully, this is NOT a normal table layout):\n'
    + 'For each pivot table, the text contains, IN THIS ORDER:\n'
    + '  1. The table title (e.g. "WTD Bottom 10 Performing Domicile Sites") and a one-line description.\n'
    + '  2. A block of raw numbers — this is EVERY ROW\'s value for metric 1, then EVERY ROW\'s value for metric 2, and so on, metric-by-metric (COLUMN-MAJOR, not row-major). So if there are 10 rows, the first 10 numbers you see are all "% to Goal" (one per row, top row first), the next 10 are all "Uptime %", the next 10 are all "Uptime Goal", then 10 "CNG Asset" counts, 10 "DIESEL Asset" counts, 10 "Downed Asset" counts, etc.\n'
    + '  3. A list of metric labels in order, each prefixed with a number like "1.1", "1.2", "2.1" etc, e.g.:\n'
    + '     1.1 % to Goal / 1.2 Uptime / 1.3 Uptime Goal / 2.1 CNG Asset / 2.2 DIESEL Asset / 2.3 Downed Asset / 3.1 Active WRs / 3.2 Amerit/Kooner WRs / 3.2.1 Open>7 Days / 3.2.2 Open>30 Days / 3.3 Non-Amerit/Kooner WRs / 3.3.1 Open>7 Days / 3.3.2 Open>30 Days\n'
    + '     This list tells you how many metrics there are and in what order — use it to figure out how many numbers belong to each metric block in step 2 (count = number of rows, which equals the number of row labels found in step 4).\n'
    + '  4. LAST, the actual row labels (e.g. 10 Domicile Site codes like "OAK-W", "ABEOW01", "MKE40" — one per row, in the SAME top-to-bottom order as the numbers in step 2). For the SCAC table specifically, this label list ALTERNATES SCAC code then Domicile code then SCAC then Domicile, e.g. "OKC41, BIMT, BOS42, AVINR, ..." means row 1 = SCAC "OKC41" domicile "BIMT", row 2 = SCAC "BOS42" domicile "AVINR", etc. Pair them up correctly — do not treat every item in that list as the same type.\n\n'
    + 'TO RECONSTRUCT EACH ROW: take the Nth value from the "Uptime %" metric block (2nd block of numbers = metric 1.2) and the Nth value from the "Downed Asset" block (metric 2.3, the # units unavailable/down count) and the Nth row label from step 4 — these all correspond to the same row N (counting from the top).\n\n'
    + 'Find TWO tables in this text using this exact reconstruction method:\n'
    + '1. The DOMICILE table — titled "WTD Bottom 10 Performing Domicile Sites". NOTE: this page usually has TWO similar domicile tables, one titled "Bottom 10 Performing Domicile Sites - overall within indicated timeframe" (NO "WTD") and one titled "WTD Bottom 10 Performing Domicile Sites". Use ONLY the one whose title contains "WTD" — ignore the non-WTD one. Extract domicile code (row label), Uptime % (metric 1.2 block), and Downed Asset count (metric 2.3 block, this is "# Units Unavailable").\n'
    + '2. The SCAC table — titled "Bottom 10 Performing SCAC - overall within indicated timeframe" or similar. IMPORTANT: unlike the domicile section, there is usually only ONE SCAC table on this page and it typically does NOT have a "WTD" prefix at all — do not discard it or return an empty array just because its title lacks "WTD". If you see "SCAC" in a pivot table title near section header "C. By SCAC", that is the table to use regardless of whether "WTD" appears in its title. Extract SCAC code + its paired Domicile code (alternating row labels, see step 4 above), Uptime % (metric 1.2 block), and Downed Asset count (metric 2.3 block).\n\n'
    + 'If the count of numeric values in a metric block does not divide evenly by the count of row labels you found (e.g. 12 rows of numbers but only 11 label pairs), extract as many COMPLETE rows as you can confidently pair up (numbers + a label) and simply omit the row(s) you cannot confidently match — do NOT return an empty array just because of a partial mismatch, and do NOT guess a label for a row you cannot pair.\n\n'
    + 'Ignore any unrelated page chrome, navigation text, filter controls, or notification banners (e.g. "New data present for visual..."). Only extract real data rows with an actual uptime percentage.\n\n'
    + 'Respond ONLY with valid JSON in this exact shape (numbers as plain numbers, uptimePct WITHOUT a % sign, e.g. 82.4 not "82.4%"):\n'
    + '{"domicile":[{"domicile":"SITE_CODE","uptimePct":0,"unitsUnavailable":0}],"scac":[{"scac":"CODE","domicile":"SITE_CODE","uptimePct":0,"unitsUnavailable":0}]}\n\n'
    + 'If a table cannot be found at all after checking both exact and near-match titles, return an empty array for it rather than guessing.\n\n'
    + '--- PAGE TEXT START ---\n' + pageText.slice(0, 16000) + '\n--- PAGE TEXT END ---';
}

function _dbrDspPrompt(pageText) {
  return 'You are reading plain rendered text copied from an AWS QuickSight dashboard page (not HTML — just the visible text, so table rows/columns may be irregularly spaced or line-broken).\n\n'
    + 'Find the SCAC-ranked performance table on this page. Its columns are SCAC, Downtime %, Uptime %, and Asset # (total asset count for that SCAC). The dashboard itself may be configured to show more than 10 rows (e.g. a "Bottom N" filter set to 20) — IGNORE that and only keep the WORST 10.\n\n'
    + 'STEP 1: Extract every SCAC row you can find (SCAC code, Uptime %, Downtime %, Asset #) — however many rows actually appear.\n'
    + 'STEP 2: Sort those rows by Uptime % ascending (lowest/worst uptime first).\n'
    + 'STEP 3: Keep ONLY the first 10 rows after sorting (the 10 worst-performing SCACs by uptime). Discard the rest, even if the page showed more.\n\n'
    + 'There is no direct "units unavailable" column. For each of the 10 kept rows, if you can read both the Asset # and Downtime % values, estimate unitsUnavailable = round(Asset# * Downtime% / 100) and set unitsUnavailableEstimated=true. If you cannot find Asset # or Downtime % for a row, leave unitsUnavailable null and unitsUnavailableEstimated=false.\n\n'
    + 'Ignore any unrelated page chrome, navigation text, filter controls, or notification banners. Only extract real data rows.\n\n'
    + 'Respond ONLY with valid JSON, MAXIMUM 10 ENTRIES in the "scac" array, in this exact shape (numbers as plain numbers, uptimePct WITHOUT a % sign):\n'
    + '{"scac":[{"scac":"CODE","uptimePct":0,"unitsUnavailable":0,"unitsUnavailableEstimated":true}]}\n\n'
    + 'If the table cannot be found at all, return an empty array rather than guessing.\n\n'
    + '--- PAGE TEXT START ---\n' + pageText.slice(0, 12000) + '\n--- PAGE TEXT END ---';
}

function _clampToBottom10(rows) {
  if (!Array.isArray(rows)) return [];
  const withUptime = rows.filter(r => r && typeof r.uptimePct === 'number');
  const withoutUptime = rows.filter(r => !(r && typeof r.uptimePct === 'number'));
  withUptime.sort((a, b) => a.uptimePct - b.uptimePct);
  return [...withUptime, ...withoutUptime].slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════════════════
// DETERMINISTIC REVIEW ENGINE (ported verbatim from daily-call.js)
// ═══════════════════════════════════════════════════════════════════════════
const TREND_TERMS = [
  ['CCV module',        /\bccv\b/i],
  ['Misfire',           /\bmisfire/i],
  ['Turbo',             /\bturbo/i],
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

const TREND_MIN_UNITS = 3;

const BARRIER_TERMS = [
  ['No vendor assigned',       /^(--|unassigned)$/i, 'vendor'],
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
  const total   = allRowsInGroup.length;
  const unavail = groupRows;
  const uptime  = total ? Math.round(((total - unavail.length) / total) * 1000) / 10 : 100;

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
      const direction = maxDays === null ? 'Recurring' : maxDays >= 7 ? 'Persisting' : maxDays < 3 ? 'Emerging' : 'Recurring';
      const daysRange = minDays !== null ? (minDays === maxDays ? `${minDays}d` : `${minDays}–${maxDays}d`) : null;
      const scacs = Array.from(v.operators);
      return { label, count, units, direction, avgDays, daysRange, scacs };
    })
    .sort((a, b) => b.count - a.count);

  const barrierMap = {};
  let noVendorCount = 0;
  for (const r of unavail) {
    const v = (r.vendor || '--').trim();
    if (!v || v === '--' || v.toLowerCase() === 'unassigned') noVendorCount++;
    const text = _unitText(r);
    for (const [label, re] of BARRIER_TERMS) {
      if (label === 'No vendor assigned') continue;
      if (re.test(text)) {
        if (!barrierMap[label]) barrierMap[label] = { count: 0, days: [] };
        barrierMap[label].count++;
        const bd = _parseDaysOpen(r);
        if (bd !== null) barrierMap[label].days.push(bd);
      }
    }
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

  const flipUnits = unavail.filter(r => FLIP_SIGNAL.test(_unitText(r))).map(r => r.equipmentId || r.id || '?');

  const unavailRows = unavail.map(r => ({
    id: r.equipmentId || r.id || '?',
    text: _unitText(r).trim().substring(0, 900),
    daysOpen: _parseDaysOpen(r),
    vendor: (r.vendor && r.vendor !== '--') ? r.vendor : null,
    repairStatus: r.savedRepairStatus || null,
    operator: (r.operator || '').toUpperCase().trim() || null,
    make: (r.make || '').trim() || null,
  }));

  return { total, unavailCount: unavail.length, uptime, trends, barriers, flipUnits, unavailRows };
}

function _dbrBuildReviewPrompt(label, computed) {
  const rows = computed.unavailRows.slice(0, 60);
  const perUnitBudget = Math.max(350, Math.min(900, Math.floor(16000 / Math.max(rows.length, 1))));
  const unitLines = rows.map(u => {
    const meta = [
      u.operator ? `SCAC: ${u.operator}` : '',
      u.make ? `Make: ${u.make}` : '',
      u.vendor ? `Vendor: ${u.vendor}` : 'Vendor: unassigned',
      (u.daysOpen !== null && u.daysOpen !== undefined) ? `Days down: ${u.daysOpen}` : '',
      u.repairStatus ? `Repair status: ${u.repairStatus}` : '',
    ].filter(Boolean).join(' | ');
    return `[${u.id}]${meta ? ' ' + meta : ''}\n${(u.text || '(no issue text)').substring(0, perUnitBudget)}`;
  }).join('\n\n');

  return `You are filling in a fleet operations DBR (Daily Business Review) call sheet row for ${label}. You are a SUPPORTING / VERIFICATION source only — never invent information not present in the unit data below.

${rows.length} unavailable (OOS) unit(s) at this ${label}. Per-unit data below (SCAC, Make, Vendor, Days down, Repair status, and raw issue/notes text).

UNIT DATA:
${unitLines}

Fill FIVE fields using the EXACT logic below. Follow each step in order — this is not a style guide, it's the actual procedure to run.

══════════════════════════════════════
TRENDS — "What patterns do I see?"
══════════════════════════════════════
Work through this ANALYSIS SILENTLY (do not print your reasoning, counts-that-didn't-qualify, or "no single system reaches 3+" explanations into the output — the output is ONLY the final verdict, nothing else):
1. Count the OOS units (shown above).
2. Group units by SYSTEM (the broad component area the issue text points to — e.g. CHASSIS, ELECTRICAL, ENGINE, TRANSMISSION, BRAKES, HVAC, BODY/CAB, TIRES, SUSPENSION, DEF/EMISSIONS, PM/INSPECTION).
3. Group by ISSUE TYPE within the data (the specific failure, e.g. "misfire", "no start", "oil leak"). Flag it as a trend ONLY if 3 OR MORE units share the SAME specific issue type. 2 units sharing an issue is NOT a trend.
4. Group by MAKE (the OEM/manufacturer). Flag it ONLY if ONE make accounts for the clear majority AND has 3 or more units.
5. If NONE of system/issue-type/make reaches 3+ units sharing the same thing, the ENTIRE output must be exactly the two words "No trends" — nothing else. Do not explain why, do not list the systems you checked, do not mention counts that fell short.

OUTPUT RULES — this field gets typed directly into a spreadsheet cell, so it must be SHORT:
- If no trend qualifies: output EXACTLY "No trends" and nothing more.
- If a trend DOES qualify (3+ units, same system/issue/make): output ONLY that trend, in this terse style: "3 misfire (59080, 9010424, 39582)" or "CHASSIS (3) — 59080, 9010424, 39582". One line per qualifying trend. Still cite real unit IDs.
- NEVER include your work, your rejected candidates, or a sentence explaining the absence of a trend. The field is either "No trends" or a short list of qualifying trends — nothing in between.

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

RESPOND WITH JSON ONLY, no markdown, no explanation outside the JSON:
{"trends":"","barriers":"","expectedFlips":"","actions":"","helpNeeded":""}`;
}

function _normalizeTrendsText(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (!text) return '';
  if (/\bno\s+trends?\b/i.test(text) && text.length > 20) return 'No trends';
  return text.substring(0, 400);
}
function _normalizeHelpText(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (!text) return '';
  if (/\bno\s+help\s+needed\b/i.test(text) && text.length > 20) return 'No help needed';
  return text.substring(0, 300);
}

// ═══════════════════════════════════════════════════════════════════════════
// "MINE" matching + per-row review (main-process, store-backed)
// ═══════════════════════════════════════════════════════════════════════════

// Union of the user's managed domiciles + carriers, from the SAME sources the
// renderer's _loadMySitesAndCarriers used — but read from the store directly
// (fleetData rows + contacts.json type:'domicile') instead of window.contacts.
function _loadMySitesAndCarriers() {
  const mySites = new Set();
  const myCarriers = new Set();
  try {
    const fd = store.load('fleetData', {}) || {};
    (Array.isArray(fd.rows) ? fd.rows : []).forEach(r => {
      const d = (r.domicileSite || r.domicile || '').trim().toUpperCase();
      if (d) mySites.add(d);
      const op = (r.operator || '').trim().toUpperCase();
      if (op) myCarriers.add(op);
    });
  } catch (_) {}
  try {
    const contacts = store.load('contacts', {}) || {};
    const all = Array.isArray(contacts) ? contacts : (Array.isArray(contacts.contacts) ? contacts.contacts : []);
    all.filter(c => c && c.type === 'domicile').forEach(c => {
      const n = (c.name || '').trim().toUpperCase();
      if (n) mySites.add(n);
    });
  } catch (_) {}
  return { mySites, myCarriers };
}

// Fleet units matched to one DBR row (domicile rows match domicileSite; SCAC
// rows match operator), filtered to unavailable only.
function _matchUnits(sectionKind, rowKey) {
  const fd = store.load('fleetData', {}) || {};
  const rows = Array.isArray(fd.rows) ? fd.rows : [];
  const key = (rowKey || '').trim().toUpperCase();
  if (!key) return [];
  const matched = sectionKind === 'domicile'
    ? rows.filter(r => (r.domicileSite || r.domicile || '').trim().toUpperCase() === key)
    : rows.filter(r => (r.operator || '').trim().toUpperCase() === key);
  return matched.filter(_isUnavail);
}

// Review one "mine" row -> { trendsText, barriersText, flipsText, actionsText, helpText }.
async function _reviewRow(sectionKind, rowKey, label) {
  const units = _matchUnits(sectionKind, rowKey);
  if (!units.length) {
    return { trendsText: '', barriersText: '', flipsText: '', actionsText: '', helpText: '', error: 'No matching units found in fleet data' };
  }
  const computed = _computeGroup(units, units);
  const mechTrendsText = computed.trends.length
    ? computed.trends.map(t => `${t.count} ${t.label}${t.daysRange ? ' — ' + t.daysRange : ''}`).join('\n')
    : 'No trends';
  const mechBarriersText = computed.barriers.length ? computed.barriers.join('; ') : 'no barriers';
  const mechFlipsText = computed.flipUnits.length ? `~${computed.flipUnits.length} (${computed.flipUnits.slice(0, 6).join(', ')})` : '0';
  try {
    const parsed = await _dbrAskAi(_dbrBuildReviewPrompt(label, computed));
    return {
      trendsText: _normalizeTrendsText(parsed.trends) || mechTrendsText,
      barriersText: typeof parsed.barriers === 'string' && parsed.barriers.trim() ? parsed.barriers.trim().substring(0, 400) : mechBarriersText,
      flipsText: typeof parsed.expectedFlips === 'string' && parsed.expectedFlips.trim() ? parsed.expectedFlips.trim().substring(0, 200) : mechFlipsText,
      actionsText: typeof parsed.actions === 'string' ? parsed.actions.trim().substring(0, 400) : '',
      helpText: _normalizeHelpText(parsed.helpNeeded),
    };
  } catch (e) {
    logger.warn('[DBR] review AI failed for ' + label + ': ' + e.message);
    return { trendsText: mechTrendsText, barriersText: mechBarriersText, flipsText: mechFlipsText, actionsText: '', helpText: '', aiError: e.message };
  }
}

// Decide if a row is "mine" (same rule as the renderer FAS='Z' auto-fill).
function _rowIsMine(sectionKind, row, mySites, myCarriers) {
  const idVal = sectionKind === 'domicile' ? row.domicile : row.scac;
  const idKey = (idVal || '').trim().toUpperCase();
  const domicileKey = (row.domicile || '').trim().toUpperCase();
  return sectionKind === 'domicile'
    ? mySites.has(idKey)
    : (myCarriers.has(idKey) || (domicileKey && mySites.has(domicileKey)));
}

// Attach review fields to each "mine" row in-place (non-mine rows untouched).
async function _reviewMineRows(rowsData, sectionKind, mySites, myCarriers) {
  for (const row of rowsData) {
    if (!_rowIsMine(sectionKind, row, mySites, myCarriers)) continue;
    const idVal = sectionKind === 'domicile' ? row.domicile : row.scac;
    const label = sectionKind === 'domicile' ? ('domicile ' + idVal) : ('SCAC ' + idVal);
    const review = await _reviewRow(sectionKind, idVal, label);
    Object.assign(row, review); // trendsText/barriersText/flipsText/actionsText/helpText
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC: pull one source end-to-end (scrape -> freshness -> parse -> review -> save)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * pullAfp() / pullDsp() — scrape, freshness-gate (data must be TODAY in PT),
 * AI-parse, review "mine" rows, and persist to the store.
 *
 * Returns one of:
 *   { ok:true, fresh:true, rowCount, data }                  -> saved, done
 *   { ok:false, stale:true, dataAsOf }                       -> NOT today -> caller retries
 *   { ok:false, error }                                      -> scrape/parse failed -> caller retries
 */
async function pullAfp() {
  const cap = await qs.captureAfpText();
  if (!cap || !cap.ok) return { ok: false, error: (cap && cap.error) || 'AFP capture failed' };
  if (!cap.freshToday) {
    logger.info('[DBR] AFP data is NOT today (PT) — dataAsOf=' + (cap.dataAsOf || 'unknown') + ' -> stale, will retry');
    return { ok: false, stale: true, dataAsOf: cap.dataAsOf || null };
  }
  const parsed = await _dbrAskAi(_dbrAfpPrompt(cap.text));
  const data = {
    ok: true,
    domicile: Array.isArray(parsed.domicile) ? parsed.domicile : [],
    scac: Array.isArray(parsed.scac) ? parsed.scac : [],
    scrapedAt: cap.scrapedAt || new Date().toISOString(),
    dataAsOf: cap.dataAsOf || null,
  };
  const { mySites, myCarriers } = _loadMySitesAndCarriers();
  await _reviewMineRows(data.domicile, 'domicile', mySites, myCarriers);
  await _reviewMineRows(data.scac, 'scac', mySites, myCarriers);
  store.save('quicksightDbr', data);
  const rowCount = data.domicile.length + data.scac.length;
  logger.info('[DBR] AFP pull complete — ' + data.domicile.length + ' domicile + ' + data.scac.length + ' SCAC rows (data as of ' + data.dataAsOf + ')');
  return { ok: true, fresh: true, rowCount, data };
}

async function pullDsp() {
  const cap = await qs.captureDspText();
  if (!cap || !cap.ok) return { ok: false, error: (cap && cap.error) || 'DSP capture failed' };
  if (!cap.freshToday) {
    logger.info('[DBR] DSP data is NOT today (PT) — dataAsOf=' + (cap.dataAsOf || 'unknown') + ' -> stale, will retry');
    return { ok: false, stale: true, dataAsOf: cap.dataAsOf || null };
  }
  const parsed = await _dbrAskAi(_dbrDspPrompt(cap.text));
  const data = {
    ok: true,
    scac: _clampToBottom10(Array.isArray(parsed.scac) ? parsed.scac : []),
    scrapedAt: cap.scrapedAt || new Date().toISOString(),
    dataAsOf: cap.dataAsOf || null,
  };
  const { mySites, myCarriers } = _loadMySitesAndCarriers();
  await _reviewMineRows(data.scac, 'scac', mySites, myCarriers);
  store.save('quicksightDbrDsp', data);
  logger.info('[DBR] DSP pull complete — ' + data.scac.length + ' SCAC rows (data as of ' + data.dataAsOf + ')');
  return { ok: true, fresh: true, rowCount: data.scac.length, data };
}

module.exports = {
  pullAfp, pullDsp,
  // exported for tests / reuse
  _computeGroup, _matchUnits, _loadMySitesAndCarriers, _rowIsMine,
  _dbrAfpPrompt, _dbrDspPrompt, _dbrBuildReviewPrompt, _clampToBottom10,
  _normalizeTrendsText, _normalizeHelpText,
};
