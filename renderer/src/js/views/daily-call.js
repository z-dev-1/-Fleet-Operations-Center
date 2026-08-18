/**
 * daily-call.js — Daily Call sheet auto-fill (FEATURE 2026-07-16)
 *
 * Replicates the manual "Bottom 10 by Domicile" / "Bottom 10 by SCAC" daily
 * call sheet (AFP-FAS SharePoint, "DAILY CALL WEEK NN.xlsx") the user fills
 * out every morning by hand. Auto-computes what's computable from live
 * fleet data, drafts the rest, and leaves genuinely-manual fields (Actions,
 * Help Needed) as editable text the user fills in themselves.
 *
 * Pure client-side computation from state.slice('fleet').rows, same
 * pattern as analytics.js — no new IPC needed for the read side.
 *
 * Column-by-column source of truth (per user's explicit ask 2026-07-16):
 *   - Uptime % / # Units Unavailable  -- fully computed from lifecycleState
 *   - Trends                          -- fully computed, FROM ISSUE DETAILS
 *                                        TEXT (per user correction — not from
 *                                        the 5-category savedPrimaryComponent
 *                                        field, which is too coarse). Keyword
 *                                        match against issueDetails/issueSummary/
 *                                        savedNotes, tracking the SPECIFIC term
 *                                        matched (e.g. "CCV module") rather than
 *                                        a broad category. Only surfaced when
 *                                        3+ units at that site/SCAC share it —
 *                                        matches the real sheet's own threshold.
 *   - Barriers                        -- DRAFT ONLY. Auto-detected candidate
 *                                        signals (no vendor, parts delay, tech
 *                                        shortage, etc.) pre-filled as a
 *                                        starting point; editable, NOT locked.
 *   - Expected Flips to A/H Today     -- DRAFT ONLY. Units showing completion-
 *                                        type language in notes/status; a
 *                                        starting count+list, editable.
 *   - Actions / Help Needed           -- DRAFT via AI Review (added
 *                                        2026-07-17, per user request). The
 *                                        mechanical engine has no basis to
 *                                        guess these on its own; running
 *                                        "AI Review" asks Orcha to suggest
 *                                        concrete next steps and cross-team
 *                                        help needs from the actual issue
 *                                        text, pre-filling the textarea as
 *                                        an editable starting point -- same
 *                                        draft/override pattern as
 *                                        Barriers/Flips. Still fully manual
 *                                        if AI Review is never run.
 *
 * AI VERIFICATION PASS ("AI Review" button, added 2026-07-17): runs each
 * visible group's raw issue text through Orcha to (1) sanity-check the
 * mechanical trends, (2) surface additional 3+-unit trends the keyword list
 * missed, (3) flag barriers (no vendor, diagnosis blocked, incomplete
 * records, etc.) even for a single unit, (4) suggest concrete actions, and
 * (5) assess cross-team help needs. Every trend/barrier claim must cite
 * real unit IDs from that group or it's dropped during validation — see
 * _validateAIResult. Results are cached per group+day in localStorage.
 *
 * FAS (call runner name) and MMPM/BC (program manager names) columns are
 * intentionally NOT generated — that data doesn't exist anywhere in the
 * fleet dataset. The "Copy for SharePoint" export starts at the
 * Domicile/SCAC column; paste into the sheet starting at that column and
 * fill in the name columns by hand as before.
 *
 * Actions/Help Needed text is persisted to localStorage, keyed per
 * group+date, so it survives app restarts within the same day but starts
 * fresh each morning (matches the "fill out every morning" workflow).
 */

import bus   from '../bus.js';
import state from '../state.js';

let _el = null;

// ── Helpers ────────────────────────────────────────────────────────────────
const _safe = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const _pct  = (n, t) => t ? Math.round((n / t) * 100) : 0;
const _todayKey = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

function _lsKey(kind, groupKey, field) {
  return `dailyCall__${kind}__${groupKey}__${field}__${_todayKey()}`;
}
function _lsGet(kind, groupKey, field) {
  try { return localStorage.getItem(_lsKey(kind, groupKey, field)) || ''; } catch (e) { return ''; }
}
function _lsSet(kind, groupKey, field, val) {
  try { localStorage.setItem(_lsKey(kind, groupKey, field), val); } catch (e) { /* ignore quota errors */ }
}

// ── Trend keyword taxonomy ──────────────────────────────────────────────────
// Word-boundary regex per specific term (NOT the broad 5-category classifier)
// so trend lines read like the real sheet: "CCV module — 4 units", not
// "Engine/Motor Systems — 4 units". Extend this list as new recurring terms
// show up in practice.
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

// Barrier candidate signals — DRAFT ONLY, always editable
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

// Expected-flip completion signals — DRAFT ONLY, always editable
const FLIP_SIGNAL = /\b(repair complete|repairs? completed|road[- ]?test(ed)?|ready for (pickup|release)|returning to service|release(d)? back to fleet|flip(ping)? (to|back) (a\/h|available)|complete[d]? (today|this morning))\b/i;

// Structured barrier signal, straight from the scraped Relay repair-status
// field (see savedRepairStatus in src/scrapers/relay.js) rather than a
// keyword guess against free text. This is a much cleaner signal than the
// BARRIER_TERMS regexes above -- e.g. "Waiting for vendor" was found on 23
// of 41 unavailable units in a live check, none of which necessarily
// contain the literal words the BARRIER_TERMS regexes look for. Statuses
// NOT listed here (Repair in progress, Repair completed, Road test,
// Diagnosis completed, Vehicle arrived, Work order closed) are active/done
// states, not barriers, and are intentionally excluded.
const STATUS_BARRIER_MAP = {
  'waiting for vendor':   'Waiting for vendor response',
  'awaiting estimate':    'Awaiting estimate approval',
  'parts backordered':    'Parts backordered',
  'under diagnosis':      'Diagnosis unresolved',
};

function _unitText(r) {
  return [r.issueDetails || '', r.issueSummary || '', r.savedNotes || '', r.savedRepairStatus || '', r.repairTimeline || ''].join(' ');
}

// Parse how long a unit has been open, in whole days, from structured fields.
// Returns an integer or null if no duration data is available.
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

// ── Per-group computation ───────────────────────────────────────────────────
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
  }));

  return {
    total, unavailCount: unavail.length, uptime,
    trends, barriers, flipUnits, unavailRows,
  };
}

function _buildGroups(rows, keyFn, labelFn) {
  const byKey = {};
  for (const r of rows) {
    const key = keyFn(r);
    if (!key) continue;
    if (!byKey[key]) byKey[key] = [];
    byKey[key].push(r);
  }
  const groups = [];
  for (const key of Object.keys(byKey)) {
    const allInGroup = byKey[key];
    const unavailInGroup = allInGroup.filter(_isUnavail);
    if (unavailInGroup.length === 0) continue; // matches "bottom" semantics — nothing to report
    const computed = _computeGroup(unavailInGroup, allInGroup);
    groups.push({ key, label: labelFn(key), ...computed });
  }
  groups.sort((a, b) => a.uptime - b.uptime); // worst uptime first, matches "Bottom 10"
  return groups;
}

// ── AI verification pass (FEATURE 2026-07-17) ───────────────────────────────
// User's ask: "can AI be a supporting source to my daily call data to
// ensure its correct and if anything missed? and be the source of truth if
// it finds additional data?"
//
// Design, to honor that WITHOUT risking fabricated content reaching a sheet
// that goes out to business partners/management:
//   - The mechanical keyword computation (_computeGroup above) remains the
//     base of record ALWAYS -- AI never silently overwrites it.
//   - AI is given the group's RAW per-unit issue/notes text (not a summary)
//     and asked to (1) sanity-check the mechanical trends, (2) find any
//     additional 3+-unit pattern the keyword list missed, (3) flag barriers
//     evident in the text. This is where AI becomes the source of truth for
//     genuinely NEW findings -- but only additively, and only when verified.
//   - Every AI claim MUST cite the specific unit IDs it applies to. Any
//     claim citing a unit ID not actually in that group, or citing fewer
//     than 3 units for a "trend", is silently dropped during validation --
//     this is the anti-fabrication gate. AI output that can't be traced
//     back to real units in the group never reaches the UI.
//   - Results are visually distinct (🤖 badge) from mechanical findings so
//     the user can tell at a glance what's deterministic vs. AI-found, and
//     are cached per group+day so a page refresh doesn't burn another AI
//     call for data that hasn't changed.

let _aiReview = {}; // key: `${kind}::${groupKey}` -> { additionalTrends, barrierNotes, trendIssues, reviewedAt }

function _aiKey(kind, groupKey) { return `${kind}::${groupKey}`; }
function _aiLsKey(kind, groupKey) { return `dailyCall__ai__${kind}__${groupKey}__${_todayKey()}`; }

function _loadCachedAIReview(kind, groupKey) {
  try {
    const raw = localStorage.getItem(_aiLsKey(kind, groupKey));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function _saveAIReview(kind, groupKey, data) {
  try { localStorage.setItem(_aiLsKey(kind, groupKey), JSON.stringify(data)); } catch (e) { /* ignore quota errors */ }
}

function _buildAIPrompt(kind, g) {
  const label = kind === 'site' ? 'Domicile' : 'SCAC';
  const rows = g.unavailRows.slice(0, 60); // keep prompt size sane; matches MAX_PROMPT_LEN headroom in src/ipc/ai.js
  // Budget-aware per-unit truncation: ~20000 chars total for unit text,
  // split evenly across however many rows actually made the cut, clamped
  // between 350 (always keep at least the issue line + a bit of timeline)
  // and 900 (matches the cap _computeGroup stored). Prevents a large group
  // (many rows × long repairTimeline) from silently blowing past
  // MAX_PROMPT_LEN and having the whole AI Review fail with a validation
  // error instead of gracefully trimming.
  const perUnitBudget = Math.max(350, Math.min(900, Math.floor(20000 / Math.max(rows.length, 1))));
  const trendsList = g.trends.length
    ? g.trends.map(t => `- ${t.count} ${t.label}${t.daysRange ? ' — ' + t.daysRange : ''} [${t.direction || 'Recurring'}]${t.scacs && t.scacs.length ? ' (' + t.scacs.join(', ') + ')' : ''}: units ${t.units.join(', ')}`).join('\n')
    : '(none detected)';
  const unitLines = rows.map(u => {
    const meta = [
      u.operator ? `SCAC: ${u.operator}` : '',
      u.vendor ? `Vendor: ${u.vendor}` : 'Vendor: unassigned',
      (u.daysOpen !== null && u.daysOpen !== undefined) ? `Open: ${u.daysOpen}d` : '',
      u.repairStatus ? `Status: ${u.repairStatus}` : '',
    ].filter(Boolean).join(' | ');
    return `[${u.id}]${meta ? ' ' + meta : ''}\n${(u.text || '(no issue text)').substring(0, perUnitBudget)}`;
  }).join('\n\n');

  return `You are Orcha, cross-checking a fleet operations "Daily Call" report for accuracy. You are a SUPPORTING / VERIFICATION source only -- never invent information.

GROUP: ${g.label} (${label})
${rows.length} unavailable units. Raw issue/notes text for each unit below.

MECHANICAL TRENDS ALREADY DETECTED (keyword-matched against issue text, confirm or flag if wrong):
${trendsList}

RAW UNIT TEXT:
${unitLines}

YOUR TASK:
1. Check whether the mechanical trends above are actually supported by the raw text. Flag anything that looks wrong.
2. TRENDS -- look for any ADDITIONAL pattern shared by 3 or more units that was NOT already detected above: a repair type, component, or root cause explicitly mentioned in 3+ units' text. This is about WHAT is broken, repeated across multiple units.
3. BARRIERS -- separately, note anything blocking progress or making a unit's record hard to act on: no vendor engaged, diagnosis blocked (e.g. waiting on a diagnostic tool, dealer, or parts), root cause unresolved after repeated attempts, incomplete/truncated records, unit sitting with no activity, etc. This is about WHY progress is stuck, and can apply to even a SINGLE unit -- it does not need to repeat across 3+ units like a trend does. Do NOT put barrier-type findings into additionalTrends -- they belong in barrierNotes even if you found several of them.
4. ACTIONS -- suggest concrete next steps the fleet coordinator (the user) could personally take to move things forward, e.g. "Request updated ETC from Amerit for unit X", "Escalate diagnosis delay at dealer for unit Y". Be specific and cite the relevant unit ID(s) when the action is unit-specific; citation is optional for a genuinely group-wide action (e.g. "Request consolidated status update from Amerit for all open WOs at this site").
5. HELP NEEDED -- assess whether cross-team help is needed (e.g. SM team lifecycle correction, FAS/AFP coordination, Last Mile escalation) and from whom. If no help is needed, do not invent a need -- simply return an empty array for this field.

TRENDS RULE: Identify recurring patterns in why units are down at this site/SCAC. A trend exists when 3+ units share the same failure category or situation. "No trends" is valid when nothing clusters.

TRENDS STYLE EXAMPLES (match this voice):
- "No trends"
- "No trends. Only four units down"
- "4 no starts"
- "5 Expired PMs"
- "5 transmission"
- "7 Reconditioning units"
- "3 OOS\nNo trends"
- "8 Engine issues\n4 Cab/Climate Control issues\n3 Accessories"
- "13 OOS\n4 Expired Inspection\n3 OSR\n2 EOL"
- "Engine/Motor Systems (3) — 59340, 122309, 520079."
- "Chassis (4) — 321357, 520065, 520089, 321571.\nEngine/Motor Systems (5) — 321579, 322442, 521296, 569073, 876609."
- "Predictive maintenance — 12 active (6 within the last 2 days)\nKenworth Brockton congestion persists — 9 units assigned there; recurring 'waiting on next tech' across multiple units"
- "Amerit parts sourcing failures — 4 occurrences in 13 days (322285 2x incorrect throttle body, 321548 sensors past EDD, 320210 no ETA post-approval).\nOffsite dealer extended dwell — 4 units (521073 KW 27d, 9010434 KW 14d, 321414 Cummins 13d).\nSame-day downed spike — 5 units downed DoD."
- "Live snapshot 8/11: 73.4% uptime (80/109 tractors active). Movement is offsite/OEM-driven — Amerit on-site queue is fresh and clearing."

Format: category name + count + each unit ID with its SPECIFIC issue (not just the category repeated). Examples:
- "Electrical (3) — B62179 ignition switch vandalism, B62196 liftgate switch ripped from dash, 39263 wiring harness short to ground"
- "Engine/Motor Systems (4) — 321950 cylinders 5&6 misfire/turbo oil carryover, 122148 oil leak at dealer event, 59090 engine fueling predictive alert, 922516 engine oil pressure alert"
- "Transmission (3) — 520079 shift solenoid failure, 321254 MTM internal damage pending Eaton direction, 39110 communication fault harness delay"
- "PM Backlog (5) — B12257 PM-B 7d, B12263 PM-B 8d, B62049 PM-B 8d, 9010381 PM-B pending tech, B62020 PM-B blocked by CNG diag"

Each unit gets its own brief description of WHAT specifically is wrong — not just the unit ID alone. This gives leadership instant visibility into whether the trend is one root cause or diverse failures in the same category. Use direction labels [Persisting/Emerging] only when a trend is worsening or new.
BARRIERS RULE: List what's BLOCKING progress on downed units. Be specific when you can, brief when the situation is simple. "No barriers" is a valid answer if nothing is genuinely blocking.

BARRIERS STYLE EXAMPLES (match this voice):
- "no barriers"
- "Dealer backlog"
- "KTR has limited techs around the area and FM stated it will take a week to get oil out there to complete PMs"
- "Weekend backlog"
- "Expired Inspections; Amerit was not able to complete all the PMs over the weekend due to weekend repairs per AFM"
- "Parts Delay: 322285 — throttle body 2x incorrect, 13 days, no ETA. 321548 — HALO sensors 4 days past EDD (8/7)."
- "Offsite Shop: 321414 at Cummins — estimate stalled waiting on Volvo for harness PN (13d). 521073 at KW — ETR 8/13."
- "Estimate approval bottlenecks (5 units) — 622106 escalated; 520062 pending approval for fuel testing; 59161 EGR estimate pending."
- "Uptick in rejections from COX last week - 7 units OSR"
- "Physical access barriers — 324130 (15d) both vehicle doors will not open; dealer cannot get inside to begin diagnostics."
- "parts delay ETA 8/21 for back doors, dealer delays due to backlog and being short handed, 2 units in bay WIP pending ETC"
- "Extended off-site repair aging is the primary driver of downtime. Parts sourcing and back-order delays. Vendor WO cancellations and dealer referrals."
- "SWAP Delays for EOL units, Extended repairs for CEI. Barriers account for about 50% downtime"

Format: direct, concise. Can be a single phrase or multiple barriers separated by semicolons/periods/newlines. Include unit IDs, vendor names, and days when relevant. Group by blocker category when multiple units share the same barrier. Say "no barriers" if nothing is genuinely blocking.
ACTIONS RULE: Every barrier MUST have a matching action — no orphan barriers. Use specific action verbs: Escalated, Requested, Confirmed, Scheduled, Created WO, Sent correspondence, Pushed for, Contacted, Reached out to, Spoke with, Submitted, Coordinating. Always state WHO you contacted, WHAT you specifically requested, and WHEN you expect resolution. NEVER use "following up" alone — say what you're following up ON and with WHOM.

ACTIONS STYLE EXAMPLES (match this voice):
- "Contacted Cox FM, tech to finish lift gate PMs today and getting started on PM-Bs"
- "Reached out to Kenworth dealer for progress updates on 521073 (27 days, estimate approved 8/10)"
- "Escalated pending estimates (2) to HVE team in AAP"
- "Confirming tows to site for units completing offsite repair"
- "Submitted vendor coaching for Amerit on unit 59008 due to SLA breach; Asana task created"
- "Spoke with Amerit techs and FM to prioritize repairs as parts arrive for OOS units"
- "Follow up with Valley Peterbilt for ETC; expedite 520079 estimate approval; set up tow for 520072"
- "Reached out to kooner management for update on units with solid and accurate updates"
- "Sending two units to Volvo for expedited PMs"
- "5 units downed DoD all pending Amerit diagnostics — spoke with techs to prioritize"
- "Escalate dealer estimate approvals; return tow scheduled for 9010380"

Format: direct, 1st person, action-oriented. Can be a single line per action or multiple actions separated by semicolons/newlines. Reference specific unit IDs when the action is unit-specific.

STRICT RULES -- violating these invalidates your response:
- Every TREND or BARRIER claim MUST cite the exact unit IDs (from the bracketed list above) where you found it. No unit IDs = do not include the claim.
- Do NOT invent, guess, or extrapolate beyond what is explicitly stated in the raw text.
- Minimum 3 units required for any "additional trend" claim -- same threshold as the mechanical detection. Barriers have NO minimum -- a single unit's blocker is still worth flagging.
- If you find nothing beyond what's already detected for trends or barriers, say so plainly -- do not fabricate filler content to seem useful.
- Actions and help-needed are recommendations, not factual claims -- they don't require the same unit-citation rigor, but should still be grounded in what you actually see in the text, not generic boilerplate.

RESPOND WITH JSON ONLY, no markdown, no explanation outside the JSON:
{"trendsAccurate": true, "trendIssues": "", "additionalTrends": [{"label": "failure category name", "direction": "Persisting|Emerging|Recurring", "timeframe": "e.g. 12-day window or 3rd consecutive week", "units": ["id1","id2","id3"], "quote": "short supporting phrase from the text", "scacs": ["SCAC1","SCAC2"]}], "barrierNotes": [{"category": "Parts Delay|Offsite Shop|Vendor Capacity|Estimate Approval|No Weekend Coverage|Other", "note": "unit-specific description e.g. throttle body incorrect 2x, no correct PN sourced", "vendor": "vendor or dealer name", "days": 12, "critical": true, "units": ["id1"]}], "suggestedActions": [{"action": "Escalated/Requested/Confirmed/etc + who + what + ETA", "owner": "Z or team name", "deadline": "e.g. EOD Wed", "refersTo": "barrier category this resolves", "units": ["id1"]}], "suggestedHelp": [{"note": "short description of help needed and from whom", "units": ["id1"]}]}`;
}

// Anti-fabrication gate — drop any AI claim that isn't traceable to real
// unit IDs actually present in this group. This is the enforcement point;
// nothing from here downstream is "trust the AI" without a cited, checkable
// source.
function _validateAIResult(parsed, g) {
  const knownIds = new Set(g.unavailRows.map(u => u.id));
  const out = { trendsAccurate: true, trendIssues: '', additionalTrends: [], barrierNotes: [], suggestedActions: [], suggestedHelp: [] };
  if (!parsed || typeof parsed !== 'object') return out;

  out.trendsAccurate = parsed.trendsAccurate !== false;
  out.trendIssues = typeof parsed.trendIssues === 'string' ? parsed.trendIssues.trim().substring(0, 300) : '';

  if (Array.isArray(parsed.additionalTrends)) {
    for (const t of parsed.additionalTrends) {
      if (!t || typeof t.label !== 'string' || !t.label.trim()) continue;
      const units = Array.isArray(t.units) ? t.units.filter(u => knownIds.has(u)) : [];
      if (units.length < TREND_MIN_UNITS) continue; // fewer verified units than claimed, or below threshold — drop
      out.additionalTrends.push({
        label: t.label.trim().substring(0, 60),
        direction: (typeof t.direction === 'string' && ['Persisting','Emerging','Recurring'].includes(t.direction)) ? t.direction : 'Recurring',
        timeframe: typeof t.timeframe === 'string' ? t.timeframe.trim().substring(0, 80) : '',
        scacs: Array.isArray(t.scacs) ? t.scacs.filter(s => typeof s === 'string').map(s => s.trim()).filter(Boolean).slice(0, 8) : [],
        units,
        quote: (typeof t.quote === 'string' ? t.quote.trim().substring(0, 150) : ''),
      });
    }
  }

  if (Array.isArray(parsed.barrierNotes)) {
    for (const b of parsed.barrierNotes) {
      if (!b || typeof b.note !== 'string' || !b.note.trim()) continue;
      const units = Array.isArray(b.units) ? b.units.filter(u => knownIds.has(u)) : [];
      if (units.length === 0) continue; // uncited barrier note — drop
      const bDays = typeof b.days === 'number' && b.days >= 0 ? b.days : null;
      out.barrierNotes.push({
        category: typeof b.category === 'string' ? b.category.trim().substring(0, 50) : 'Other',
        note: b.note.trim().substring(0, 200),
        vendor: typeof b.vendor === 'string' ? b.vendor.trim().substring(0, 60) : '',
        days: bDays,
        critical: bDays !== null ? bDays > 7 : Boolean(b.critical),
        blockedBy: typeof b.blockedBy === 'string' ? b.blockedBy.trim().substring(0, 40) : '',
        duration: typeof b.duration === 'string' ? b.duration.trim().substring(0, 30) : '',
        units,
      });
    }
  }

  // Actions/help are recommendations, not factual claims about the data --
  // held to a lighter validation bar than trends/barriers (which must cite
  // real units or get dropped entirely). Units are still filtered to known
  // IDs when present, but an empty/absent unit list is allowed since a
  // suggestion can legitimately be group-wide (e.g. "request a consolidated
  // status update from the vendor for this site").
  if (Array.isArray(parsed.suggestedActions)) {
    for (const a of parsed.suggestedActions) {
      if (!a || typeof a.action !== 'string' || !a.action.trim()) continue;
      const units = Array.isArray(a.units) ? a.units.filter(u => knownIds.has(u)) : [];
      out.suggestedActions.push({
        action: a.action.trim().substring(0, 200),
        owner: typeof a.owner === 'string' ? a.owner.trim().substring(0, 40) : '',
        deadline: typeof a.deadline === 'string' ? a.deadline.trim().substring(0, 40) : '',
        refersTo: typeof a.refersTo === 'string' ? a.refersTo.trim().substring(0, 60) : '',
        units,
      });
    }
  }

  if (Array.isArray(parsed.suggestedHelp)) {
    for (const h of parsed.suggestedHelp) {
      if (!h || typeof h.note !== 'string' || !h.note.trim()) continue;
      const units = Array.isArray(h.units) ? h.units.filter(u => knownIds.has(u)) : [];
      out.suggestedHelp.push({ note: h.note.trim().substring(0, 150), units });
    }
  }

  return out;
}

async function _runAIReviewForGroup(kind, g) {
  // BUG FIX (during initial build, 2026-07-17): every early-return error
  // path used to just `return { error }` without writing to _aiReview, so
  // a failed review (AI bridge down, bad JSON, etc.) was silently dropped
  // -- the button would finish and nothing would visibly change, with no
  // indication anything went wrong. Route every exit through one place
  // that always records the result (success OR error) so _renderGroupRow's
  // `if (aiData.error)` branch actually has something to show.
  const fail = (msg) => {
    const withMeta = { error: msg, reviewedAt: Date.now() };
    _aiReview[_aiKey(kind, g.key)] = withMeta;
    _saveAIReview(kind, g.key, withMeta);
    return withMeta;
  };

  if (!window.ai || !window.ai.ask) return fail('AI bridge not available');
  if (!g.unavailRows.length) return fail('No units to review');
  try {
    const prompt = _buildAIPrompt(kind, g);
    // Timeout guard: window.ai.ask() can hang indefinitely if the AI layer is
    // busy or unreachable -- freezing the whole Daily Call view.
    // FIX (2026-08-17): raised 25s -> 90s. The 25s cap was shorter than the AI
    // layer's real response time (50-90s via the fleet-brain/WS transport), so
    // "AI Review" timed out every time and showed "AI review failed". 90s
    // matches the transport's own ORCHA_TIMEOUT_MS ceiling. The button shows a
    // spinner while running, so the view isn't frozen — just waiting.
    const _aiTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('AI timeout after 90s')), 90000));
    const result = await Promise.race([window.ai.ask(prompt), _aiTimeout]);
    if (!result || result.ok === false) return fail((result && result.error) || 'AI call failed');
    const text = result.text || '';
    const jm = text.match(/\{[\s\S]*\}/);
    if (!jm) return fail('AI response was not JSON');
    let parsed;
    try { parsed = JSON.parse(jm[0]); } catch (e) { return fail('Could not parse AI JSON: ' + e.message); }
    const validated = _validateAIResult(parsed, g);
    const withMeta = { ...validated, reviewedAt: Date.now() };
    _aiReview[_aiKey(kind, g.key)] = withMeta;
    _saveAIReview(kind, g.key, withMeta);
    return withMeta;
  } catch (e) {
    return fail(e.message);
  }
}

// Shared by _renderGroupRow and _buildTsv so the "Copy for SharePoint"
// export always matches what's actually shown on screen — including the
// AI-suggested draft text for Actions/Help Needed when the user hasn't
// typed their own text yet.
function _getAIDrafts(kind, g) {
  const aiData = _aiReview[_aiKey(kind, g.key)];
  if (!aiData || aiData.error) return { actionsDraft: '', helpDraft: '' };
  const actionsDraft = (aiData.suggestedActions || []).map(a => {
    const who = a.owner ? `[${a.owner}]` : '';
    const when = a.deadline ? ` by ${a.deadline}` : '';
    const unitStr = a.units && a.units.length ? ` (${a.units.join(', ')})` : '';
    return `${who}${who ? ' ' : ''}${a.action}${when}${unitStr}`.trim();
  }).join('\n');
  const helpDraft = (aiData.suggestedHelp || []).map(h => h.note + (h.units.length ? ` (${h.units.join(', ')})` : '')).join('; ');
  return { actionsDraft, helpDraft };
}

// ── Row render (editable) ───────────────────────────────────────────────────
function _renderGroupRow(kind, g) {
  const trendsHtml = g.trends.length
    ? g.trends.map(t => {
        const dir = t.direction || 'Recurring';
        const badge = `<span class="dc-trend-badge dc-trend--${dir.toLowerCase()}">${_safe(dir)}</span>`;
        const durStr = t.daysRange ? ` — ${t.daysRange}` : '';
        const scacStr = t.scacs && t.scacs.length ? ` <span class="dc-unit-list">(${t.scacs.map(_safe).join(', ')})</span>` : '';
        return `<div class="dc-trend-line">${badge}${t.count} ${_safe(t.label)}${durStr}${scacStr}</div>`;
      }).join('')
    : '<span class="an-empty">No trends — no single issue category has 3+ units affected</span>';

  // AI verification results (if this group has been reviewed) — visually
  // distinct from mechanical findings so it's always clear what's
  // deterministic vs. AI-supplied. See _runAIReviewForGroup / _validateAIResult.
  //
  // BUG FIX (2026-07-17, user-reported via screenshot): every AI finding
  // used to get dumped into ONE block appended only to the Trends cell --
  // so barrier-type findings ("no vendor engaged", "diagnosis blocked",
  // "record truncated") showed up under Trends instead of Barriers, making
  // Barriers look empty while Trends got overloaded. Now split by type and
  // routed to the column it actually belongs in: additionalTrends -> Trends
  // cell, barrierNotes -> Barriers cell, suggestedActions -> Actions cell
  // (also feeds the default draft text), suggestedHelp -> Help Needed cell
  // (also feeds the default draft text).
  const aiData = _aiReview[_aiKey(kind, g.key)];
  let aiTrendsHtml = '';
  let aiBarriersHtml = '';
  let aiActionsHtml = '';
  let aiHelpHtml = '';
  const { actionsDraft: aiActionsDraft, helpDraft: aiHelpDraft } = _getAIDrafts(kind, g);

  if (aiData) {
    const reviewedStr = aiData.reviewedAt ? new Date(aiData.reviewedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
    if (aiData.error) {
      aiTrendsHtml = `<div class="dc-ai-block dc-ai-block--error">🤖 AI review failed: ${_safe(aiData.error)}</div>`;
    } else {
      // Defensive fallbacks: a review cached earlier today (before this
      // column-routing fix shipped) won't have suggestedActions/
      // suggestedHelp keys at all — accessing .length on undefined would
      // throw and break the whole row's render. `|| []` on every array
      // here guards against any stale-cache shape, old or new.
      const additionalTrends = aiData.additionalTrends || [];
      const barrierNotes = aiData.barrierNotes || [];
      const suggestedActions = aiData.suggestedActions || [];
      const suggestedHelp = aiData.suggestedHelp || [];

      // Trends column: only genuine 3+-unit additional trends + accuracy flag
      const addTrendsHtml = additionalTrends.length
        ? additionalTrends.map(t => { const aiScacStr = t.scacs && t.scacs.length ? ` <span class="dc-unit-list">(${t.scacs.map(_safe).join(', ')})</span>` : ''; return `<div class="dc-trend-line dc-trend-line--ai">🤖 ${t.units.length} ${_safe(t.label)}${t.timeframe ? ' — ' + _safe(t.timeframe) : ''}${aiScacStr}${t.quote ? `<div class="dc-ai-quote">"${_safe(t.quote)}"</div>` : ''}</div>`; }).join('')
        : '';
      const issueHtml = (!aiData.trendsAccurate && aiData.trendIssues)
        ? `<div class="dc-ai-note dc-ai-note--warn">⚠ AI flagged: ${_safe(aiData.trendIssues)}</div>` : '';
      const nothingInTrends = !addTrendsHtml && !issueHtml;
      aiTrendsHtml = `<div class="dc-ai-block">${addTrendsHtml}${issueHtml}${nothingInTrends ? '<div class="dc-ai-note dc-ai-note--ok">🤖 Reviewed — no additional trends found</div>' : ''}<div class="dc-ai-timestamp">Reviewed ${reviewedStr}</div></div>`;

      // Barriers column: grouped by category, unit-specific with vendor + days
      if (barrierNotes.length) {
        const byCat = {};
        for (const b of barrierNotes) {
          const cat = b.category || 'Other';
          if (!byCat[cat]) byCat[cat] = [];
          byCat[cat].push(b);
        }
        const bHtml = Object.entries(byCat).map(([cat, entries]) => {
          const entriesHtml = entries.map(b => {
            const vendorStr = b.vendor ? ` at ${_safe(b.vendor)}` : '';
            const daysStr = b.days !== null && b.days !== undefined ? ` (${b.days}d)` : '';
            const critFlag = b.critical ? ' <span class="dc-barrier-critical">⚠ CRITICAL</span>' : '';
            const unitTag = b.units.length ? `<span class="dc-unit-list">[${b.units.map(_safe).join(', ')}]</span> ` : '';
            return `<div class="dc-ai-note">🤖 ${unitTag}${_safe(b.note)}${vendorStr}${daysStr}${critFlag}</div>`;
          }).join('');
          return `<div class="dc-barrier-group"><span class="dc-barrier-cat">${_safe(cat)}:</span>${entriesHtml}</div>`;
        }).join('');
        aiBarriersHtml = `<div class="dc-ai-block">${bHtml}</div>`;
      }

      // Actions column: AI-suggested next steps — also used as the default
      // draft text for the textarea (Actions had no deterministic draft
      // before; this is what the user explicitly asked for).
      if (suggestedActions.length) {
        aiActionsHtml = `<div class="dc-ai-block">${suggestedActions.map(a => {
          const ownerDeadline = (a.owner || a.deadline) ? `<span class="dc-ai-owner">${[a.owner, a.deadline ? 'by ' + a.deadline : ''].filter(Boolean).join(' · ')}</span>` : '';
          return `<div class="dc-ai-note">🤖 ${_safe(a.action)}${ownerDeadline}${a.units && a.units.length ? ` <span class="dc-unit-list">(${a.units.map(_safe).join(', ')})</span>` : ''}</div>`;
        }).join('')}</div>`;
      }

      // Help Needed column: AI assessment of cross-team help — same
      // draft-prefill pattern as Actions.
      if (suggestedHelp.length) {
        aiHelpHtml = `<div class="dc-ai-block">${suggestedHelp.map(h => `<div class="dc-ai-note">🤖 ${_safe(h.note)}${h.units.length ? ` <span class="dc-unit-list">(${h.units.map(_safe).join(', ')})</span>` : ''}</div>`).join('')}</div>`;
      }
    }
  }

  const barriersDraft = g.barriers.length ? g.barriers.join('; ') : '';
  const flipCount = g.flipUnits.length;
  const flipDraft = flipCount > 0 ? `~${flipCount} (${g.flipUnits.slice(0, 6).map(_safe).join(', ')})` : '0';

  const barriersVal = _lsGet(kind, g.key, 'barriers') || barriersDraft;
  const flipsVal     = _lsGet(kind, g.key, 'flips')     || flipDraft;
  const actionsVal   = _lsGet(kind, g.key, 'actions') || aiActionsDraft;
  const helpVal      = _lsGet(kind, g.key, 'help') || aiHelpDraft;

  const uptimeCls = g.uptime < 65 ? 'dc-cell--danger' : g.uptime < 75 ? 'dc-cell--warn' : '';

  return `
    <tr data-group-key="${_safe(g.key)}">
      <td class="dc-col-label"><b>${_safe(g.label)}</b></td>
      <td class="dc-col-num ${uptimeCls}">${g.uptime}%</td>
      <td class="dc-col-num ${g.unavailCount > 0 ? 'dc-cell--warn' : ''}">${g.unavailCount}</td>
      <td class="dc-col-trends">${trendsHtml}${aiTrendsHtml}</td>
      <td class="dc-col-editable">${aiBarriersHtml}<textarea class="dc-input dc-input--barriers" data-field="barriers" rows="2" placeholder="Draft — edit as needed">${_safe(barriersVal)}</textarea></td>
      <td class="dc-col-editable"><textarea class="dc-input dc-input--flips" data-field="flips" rows="2" placeholder="Draft — edit as needed">${_safe(flipsVal)}</textarea></td>
      <td class="dc-col-editable">${aiActionsHtml}<textarea class="dc-input dc-input--actions" data-field="actions" rows="2" placeholder="What are you doing about it?">${_safe(actionsVal)}</textarea></td>
      <td class="dc-col-editable">${aiHelpHtml}<textarea class="dc-input dc-input--help" data-field="help" rows="2" placeholder="No help needed">${_safe(helpVal)}</textarea></td>
    </tr>`;
}

function _renderTable(kind, groups, showBottom10) {
  const visible = showBottom10 ? groups.slice(0, 10) : groups;
  if (!visible.length) return '<div class="an-empty" style="padding:16px">No unavailable units — nothing to report 🎉</div>';
  return `
    <table class="an-table dc-table">
      <thead>
        <tr>
          <th>${kind === 'site' ? 'DOMICILE' : 'SCAC'}</th>
          <th class="an-tbl--r">Uptime %</th>
          <th class="an-tbl--r"># Unavailable</th>
          <th>Trends (3+ units, same issue)</th>
          <th>Barriers <span class="dc-draft-badge">draft</span></th>
          <th>Expected Flips Today <span class="dc-draft-badge">draft</span></th>
          <th>Actions</th>
          <th>Help Needed</th>
        </tr>
      </thead>
      <tbody>${visible.map(g => _renderGroupRow(kind, g)).join('')}</tbody>
    </table>`;
}

// ── Copy-for-SharePoint export ───────────────────────────────────────────────
function _buildTsv(groups, kind, showBottom10) {
  const visible = showBottom10 ? groups.slice(0, 10) : groups;
  const header = [kind === 'site' ? 'DOMICILE' : 'SCAC', 'Uptime %', '# Units Unavailable', 'Trends (SITE/SCAC)', 'Barriers (SITE/SCAC)', 'Expected Flips to A/H Today', 'Actions', 'Help Needed'];
  const lines = [header.join('\t')];
  for (const g of visible) {
    const trendsTxt = g.trends.length ? g.trends.map(t => `${t.count} ${t.label}${t.daysRange ? ' — ' + t.daysRange : ''}${t.scacs && t.scacs.length ? ' (' + t.scacs.join(', ') + ')' : ''}`).join('\n') : 'No trends — no single issue category has 3+ units affected';
    const barriersTxt = _lsGet(kind, g.key, 'barriers') || (g.barriers.join('; ') || '');
    const flipsTxt = _lsGet(kind, g.key, 'flips') || (g.flipUnits.length ? `~${g.flipUnits.length}` : '0');
    const { actionsDraft, helpDraft } = _getAIDrafts(kind, g);
    const actionsTxt = _lsGet(kind, g.key, 'actions') || actionsDraft || '';
    const helpTxt = _lsGet(kind, g.key, 'help') || helpDraft || 'No help needed';
    lines.push([g.label, g.uptime + '%', g.unavailCount, trendsTxt, barriersTxt, flipsTxt, actionsTxt, helpTxt].join('\t'));
  }
  return lines.join('\n');
}

// ── Full view HTML ───────────────────────────────────────────────────────────
function _viewHtml() {
  return `
    <style>
      #view-daily-call .dc-table { width: 100%; border-collapse: collapse; }
      #view-daily-call .dc-table th, #view-daily-call .dc-table td { border: 1px solid var(--border, #333); padding: 8px; vertical-align: top; font-size: 12px; }
      #view-daily-call .dc-col-label { min-width: 90px; }
      #view-daily-call .dc-col-num { text-align: right; min-width: 60px; }
      #view-daily-call .dc-col-trends { min-width: 220px; }
      #view-daily-call .dc-col-editable { min-width: 160px; }
      #view-daily-call .dc-input { width: 100%; box-sizing: border-box; resize: vertical; font-size: 12px; font-family: inherit; background: var(--bg2, #1a1a2e); color: var(--fg, #eee); border: 1px solid var(--border, #444); border-radius: 4px; padding: 4px 6px; }
      #view-daily-call .dc-trend-line { margin-bottom: 4px; }
      #view-daily-call .dc-unit-list { opacity: .65; font-size: 11px; }
      #view-daily-call .dc-draft-badge { font-size: 9px; opacity: .6; font-weight: normal; text-transform: uppercase; margin-left: 4px; }
      #view-daily-call .dc-cell--warn   { color: #d97706; font-weight: 600; }
      #view-daily-call .dc-cell--danger { color: #dc2626; font-weight: 600; }
      #view-daily-call .dc-section-title { font-size: 15px; font-weight: 600; margin: 20px 0 8px; }
      #view-daily-call .dc-toggle-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; }
      #view-daily-call .dc-trend-line--ai { color: #8b5cf6; }
      #view-daily-call .dc-ai-block { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--border, #444); }
      #view-daily-call .dc-ai-block--error { color: #dc2626; font-size: 11px; }
      #view-daily-call .dc-trend-badge { display:inline-block; font-size:9px; font-weight:700; text-transform:uppercase; padding:1px 5px; border-radius:3px; margin-right:4px; vertical-align:middle; }
      #view-daily-call .dc-trend--persisting { background:#7f1d1d; color:#fca5a5; }
      #view-daily-call .dc-trend--emerging   { background:#1e3a5f; color:#93c5fd; }
      #view-daily-call .dc-trend--recurring  { background:#3b2a00; color:#fcd34d; }
      #view-daily-call .dc-ai-owner { font-size:10px; color:#6366f1; margin-left:4px; }
      #view-daily-call .dc-barrier-group { margin-bottom: 6px; }
      #view-daily-call .dc-barrier-cat { font-size:10px; font-weight:700; text-transform:uppercase; color:#d97706; margin-right:4px; }
      #view-daily-call .dc-barrier-critical { font-size:9px; font-weight:700; color:#dc2626; background:#450a0a; padding:1px 4px; border-radius:3px; margin-left:4px; }
      #view-daily-call .dc-ai-note { font-size: 11px; color: #8b5cf6; margin-bottom: 3px; }
      #view-daily-call .dc-ai-note--warn { color: #d97706; }
      #view-daily-call .dc-ai-note--ok { color: var(--mut, #888); opacity: .8; }
      #view-daily-call .dc-ai-quote { font-size: 10px; opacity: .7; font-style: italic; margin: 2px 0 4px 18px; }
      #view-daily-call .dc-ai-timestamp { font-size: 9px; opacity: .5; margin-top: 4px; }
      #view-daily-call #dc-ai-review[disabled] { opacity: .6; cursor: wait; }
    </style>
    <div class="an-header">
      <div class="an-header__left">
        <span class="an-title">Daily Call</span>
        <span class="an-subtitle">Auto-drafted from live fleet data — Trends computed, Barriers/Flips drafted; run AI Review for Actions/Help suggestions + a second pass on Trends/Barriers</span>
      </div>
      <div class="an-header__actions">
        <button id="dc-copy-site" class="detail-panel__btn detail-panel__btn--secondary">📋 Copy Domicile table</button>
        <button id="dc-copy-scac" class="detail-panel__btn detail-panel__btn--secondary">📋 Copy SCAC table</button>
        <button id="dc-ai-review" class="detail-panel__btn detail-panel__btn--secondary">🤖 AI Review</button>
        <button id="dc-refresh" class="detail-panel__btn detail-panel__btn--secondary">↺ Refresh</button>
        <button id="dc-back" class="detail-panel__btn">Back to Fleet</button>
      </div>
    </div>
    <div class="an-body">
      <div class="dc-toggle-row">
        <label><input type="checkbox" id="dc-bottom10-toggle" /> Show bottom 10 only (default: show all sites/SCACs with unavailable units)</label>
      </div>

      <div class="dc-section-title">Bottom by Domicile</div>
      <div id="dc-site-table"></div>

      <div class="dc-section-title">Bottom by SCAC</div>
      <div id="dc-scac-table"></div>

      <div class="dc-section-title" style="margin-top:20px;">WBR — Weekly Bridge Report</div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        <button id="dc-wbr-generate" class="detail-panel__btn detail-panel__btn--secondary" style="font-size:11px;">🤖 Generate WBR</button>
        <button id="dc-wbr-copy" class="detail-panel__btn detail-panel__btn--secondary" style="font-size:11px;">📋 Copy for SharePoint</button>
        <span id="dc-wbr-status" style="font-size:10px;color:var(--mut);"></span>
      </div>
      <div id="dc-wbr-table"></div>
    </div>`;
}

// ── State + update ───────────────────────────────────────────────────────────
let _siteGroups = [];
let _scacGroups = [];
let _showBottom10 = false;

function _update(rows) {
  if (!_el) return;
  _siteGroups = _buildGroups(rows, r => r.domicileSite || '', k => k);
  _scacGroups = _buildGroups(rows, r => (r.operator || '').toUpperCase(), k => k);

  // Restore any AI reviews already run today for these groups (avoids
  // burning another AI call on every refresh for unchanged data).
  for (const g of _siteGroups) {
    const cached = _loadCachedAIReview('site', g.key);
    if (cached) _aiReview[_aiKey('site', g.key)] = cached;
  }
  for (const g of _scacGroups) {
    const cached = _loadCachedAIReview('scac', g.key);
    if (cached) _aiReview[_aiKey('scac', g.key)] = cached;
  }

  const siteEl = _el.querySelector('#dc-site-table');
  const scacEl = _el.querySelector('#dc-scac-table');
  if (siteEl) siteEl.innerHTML = _renderTable('site', _siteGroups, _showBottom10);
  if (scacEl) scacEl.innerHTML = _renderTable('scac', _scacGroups, _showBottom10);

  _wireEditableFields(siteEl, 'site');
  _wireEditableFields(scacEl, 'scac');

  // WBR table (renders from localStorage; Generate fills it via AI)
  _renderWBR(rows);
}

function _wireEditableFields(tableEl, kind) {
  if (!tableEl) return;
  tableEl.querySelectorAll('tr[data-group-key]').forEach(tr => {
    const key = tr.dataset.groupKey;
    tr.querySelectorAll('.dc-input').forEach(input => {
      input.addEventListener('input', () => {
        _lsSet(kind, key, input.dataset.field, input.value);
      });
    });
  });
}

async function _copyTable(kind) {
  const groups = kind === 'site' ? _siteGroups : _scacGroups;
  const tsv = _buildTsv(groups, kind, _showBottom10);
  try {
    await navigator.clipboard.writeText(tsv);
    return true;
  } catch (e) {
    // Fallback for environments without clipboard permission
    const ta = document.createElement('textarea');
    ta.value = tsv;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
    document.body.removeChild(ta);
    return true;
  }
}

async function _runAIReviewAll(progressCb) {
  const siteVisible = _showBottom10 ? _siteGroups.slice(0, 10) : _siteGroups;
  const scacVisible = _showBottom10 ? _scacGroups.slice(0, 10) : _scacGroups;
  const jobs = [...siteVisible.map(g => ({ kind: 'site', g })), ...scacVisible.map(g => ({ kind: 'scac', g }))];
  let done = 0;
  for (const { kind, g } of jobs) {
    if (progressCb) progressCb(done, jobs.length);
    await _runAIReviewForGroup(kind, g);
    done++;
  }
  if (progressCb) progressCb(done, jobs.length);
}

// ── Init ───────────────────────────────────────────────────────────────────
export function init(container) {
  _el = document.createElement('div');
  _el.id = 'view-daily-call';
  _el.className = 'view view--daily-call';
  _el.style.display = 'none';
  _el.innerHTML = _viewHtml();
  container.appendChild(_el);

  _el.querySelector('#dc-back').addEventListener('click', () => {
    bus.emit('ui:view-change', { from: 'daily-call', to: 'fleet' });
  });

  _el.querySelector('#dc-refresh').addEventListener('click', () => {
    _update(state.slice('fleet').rows || []);
  });

  _el.querySelector('#dc-ai-review').addEventListener('click', async (e) => {
    const btn = e.target;
    const orig = btn.textContent;
    btn.disabled = true;
    await _runAIReviewAll((done, total) => {
      btn.textContent = total > 0 ? `🤖 Reviewing ${done}/${total}...` : '🤖 Reviewing...';
    });
    btn.disabled = false;
    btn.textContent = orig;
    _update(state.slice('fleet').rows || []); // re-render with AI findings merged in
  });

  _el.querySelector('#dc-bottom10-toggle').addEventListener('change', (e) => {
    _showBottom10 = !!e.target.checked;
    _update(state.slice('fleet').rows || []);
  });

  _el.querySelector('#dc-copy-site').addEventListener('click', async (e) => {
    const btn = e.target;
    const orig = btn.textContent;
    await _copyTable('site');
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });

  _el.querySelector('#dc-copy-scac').addEventListener('click', async (e) => {
    const btn = e.target;
    const orig = btn.textContent;
    await _copyTable('scac');
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });

  bus.on('fleet:data', (data) => {
    _update((data && data.rows) ? data.rows : []);
  });

  bus.on('ui:view-change', ({ to }) => {
    _el.style.display = to === 'daily-call' ? 'flex' : 'none';
    if (to === 'daily-call') _update(state.slice('fleet').rows || []);
  });

  // WBR buttons
  _el.querySelector('#dc-wbr-generate').addEventListener('click', async (e) => {
    const btn = e.target;
    const orig = btn.textContent;
    btn.disabled = true;
    const statusEl = _el.querySelector('#dc-wbr-status');
    const rows = state.slice('fleet').rows || [];
    await _generateWBR(rows, (done, total) => {
      btn.textContent = `🤖 Generating ${done}/${total}...`;
      if (statusEl) statusEl.textContent = '';
    });
    btn.disabled = false;
    btn.textContent = orig;
    if (statusEl) statusEl.textContent = '✓ Generated';
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
    _renderWBR(rows);
  });

  _el.querySelector('#dc-wbr-copy').addEventListener('click', async (e) => {
    const btn = e.target;
    const orig = btn.textContent;
    _copyWBR();
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });

  _update(state.slice('fleet').rows || []);
}

// ── WBR (Weekly Bridge Report) ──────────────────────────────────────────────
// One row per site with unavailable units. AI generates Field Level Bridge
// and FAS Field Actions per site using the same fleet context (units, vendors,
// timelines, conversations) that processOrchaAction uses. Editable after
// generation, persisted to localStorage keyed by site+week.

function _wbrWeekKey() {
  // Key by ISO week so content refreshes weekly
  const d = new Date();
  const oneJan = new Date(d.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((d - oneJan) / 86400000 + oneJan.getDay() + 1) / 7);
  return d.getFullYear() + '-W' + String(weekNum).padStart(2, '0');
}

function _wbrLsKey(siteKey, field) {
  return `wbr__${siteKey}__${field}__${_wbrWeekKey()}`;
}

function _wbrGet(siteKey, field) {
  try { return localStorage.getItem(_wbrLsKey(siteKey, field)) || ''; } catch (e) { return ''; }
}

function _wbrSet(siteKey, field, val) {
  try { localStorage.setItem(_wbrLsKey(siteKey, field), val); } catch (e) {}
}

function _getWBRSites(rows) {
  const siteMap = {};
  rows.forEach(r => {
    if (!(r.lifecycleState || '').toLowerCase().includes('unavail')) return;
    const op = (r.operator || '').toUpperCase();
    const site = (r.domicileSite || '').toUpperCase();
    const key = op && site ? op + '/' + site : site || op || 'Unknown';
    if (!siteMap[key]) siteMap[key] = [];
    siteMap[key].push(r);
  });
  return Object.entries(siteMap)
    .map(([key, units]) => ({ key, units }))
    .sort((a, b) => b.units.length - a.units.length);
}

function _renderWBR(rows) {
  const el = _el ? _el.querySelector('#dc-wbr-table') : null;
  if (!el) return;
  const sites = _getWBRSites(rows);
  if (!sites.length) {
    el.innerHTML = '<div style="font-size:11px;color:var(--grn);padding:12px;">All units available — nothing to bridge 🎉</div>';
    return;
  }

  let html = `<table class="dc-table" style="font-size:11px;">
    <thead><tr>
      <th style="min-width:100px;white-space:nowrap;">Site</th>
      <th style="min-width:250px;">Field Level Bridge</th>
      <th style="min-width:250px;">FAS Field Actions</th>
    </tr></thead><tbody>`;

  sites.forEach(s => {
    const bridge = _wbrGet(s.key, 'bridge');
    const actions = _wbrGet(s.key, 'actions');
    html += `<tr>
      <td style="font-weight:700;font-size:10px;white-space:nowrap;vertical-align:top;">${_safe(s.key)}<br><span style="font-weight:400;color:var(--mut);font-size:9px;">${s.units.length} down</span></td>
      <td><textarea class="dc-wbr-cell" data-wbr-site="${_safe(s.key)}" data-wbr-field="bridge" rows="4" style="width:100%;font-size:10px;background:var(--el);border:1px solid var(--bdr);border-radius:4px;padding:6px;color:var(--txt);resize:vertical;font-family:inherit;">${_safe(bridge)}</textarea></td>
      <td><textarea class="dc-wbr-cell" data-wbr-site="${_safe(s.key)}" data-wbr-field="actions" rows="4" style="width:100%;font-size:10px;background:var(--el);border:1px solid var(--bdr);border-radius:4px;padding:6px;color:var(--txt);resize:vertical;font-family:inherit;">${_safe(actions)}</textarea></td>
    </tr>`;
  });

  html += '</tbody></table>';
  el.innerHTML = html;

  // Auto-save on edit
  el.querySelectorAll('.dc-wbr-cell').forEach(ta => {
    ta.addEventListener('input', () => {
      _wbrSet(ta.dataset.wbrSite, ta.dataset.wbrField, ta.value);
    });
  });
}

async function _generateWBR(rows, progressCb) {
  const sites = _getWBRSites(rows);
  let done = 0;
  for (const s of sites) {
    if (progressCb) progressCb(done, sites.length);
    try {
      const unitLines = s.units.map(u => {
        const days = u.workDuration || '?';
        const tl = (u.repairTimeline || '').split('\n').filter(Boolean).slice(-2).join(' | ');
        return `${u.equipmentId}: vendor=${u.vendor || 'none'}, down=${days}, reason=${u.lifecycleReason || '?'}, issue=${(u.issueDetails || u.issueSummary || '').slice(0, 100)}, recent timeline: ${tl || 'none'}`;
      }).join('\n');

      const prompt = `You are a fleet operations FAS writing a Weekly Bridge Report (WBR) for site ${s.key}.
Write TWO fields — a Field Level Bridge (situation summary) and FAS Field Actions (what you're doing about it).

RULES:
- Be specific: include unit IDs, vendor names, days down, key blockers, ETAs.
- Bridge: status overview (how many down out of total fleet at this site, % uptime, why they're down, what stage each is at, key delays/blockers). Group by theme when possible.
- Actions: what SPECIFIC actions you took or are taking TODAY. Write like you're reporting to leadership what you personally did this morning.
  * Name who you contacted (dealer name, vendor FM name, carrier, tech)
  * Say what you specifically asked for or did
  * Reference unit IDs when unit-specific
  * Include outcomes if you have them ("estimate approved", "ETC confirmed", "parts arriving today")
  * Use action verbs: Contacted, Escalated, Reached out to, Spoke with, Confirmed, Submitted, Created WO, Scheduled tow, Pushed for, Coordinating

  GOOD ACTION EXAMPLES:
  - "Contacted Cox FM, tech to finish lift gate PMs today and getting started on PM-Bs"
  - "Reached out to Kenworth dealer for progress updates on 521073 (27 days, estimate approved 8/10)"
  - "Escalated pending estimates (2) to HVE team in AAP"
  - "Confirming tows to site for units completing offsite repair"
  - "Submitted vendor coaching for Amerit on unit 59008 due to SLA breach; Asana task created"
  - "Follow up with Valley Peterbilt for ETC; expedite 520079 estimate approval; set up tow for 520072"
  - "5 units downed DoD all pending Amerit diagnostics — spoke with techs to prioritize"

- Write like a professional fleet manager in 1st person. Direct and concise.
- Do NOT invent information. Only use what's in the unit data below.

SITE: ${s.key} (${s.units.length} units currently down)
UNIT DATA:
${unitLines}

RESPOND WITH JSON ONLY:
{"bridge": "your field level bridge text", "actions": "your FAS field actions text"}`;

      // Retry once on failure (first call after boot often fails while Orcha warms up)
      let raw = null;
      for (let attempt = 0; attempt < 2 && !raw; attempt++) {
        try {
          const _timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('WBR AI timeout')), 90000));
          raw = await Promise.race([window.ai.ask(prompt), _timeout]);
        } catch (retryErr) {
          if (attempt === 0) {
            console.warn('[WBR] Attempt 1 failed for', s.key, '— retrying:', retryErr.message);
            await new Promise(r => setTimeout(r, 2000)); // brief pause before retry
          }
        }
      }
      const jm = (raw || '').match(/\{[\s\S]*\}/);
      if (jm) {
        const parsed = JSON.parse(jm[0]);
        if (parsed.bridge) _wbrSet(s.key, 'bridge', parsed.bridge);
        if (parsed.actions) _wbrSet(s.key, 'actions', parsed.actions);
      }
    } catch (e) {
      // AI failed for this site after retry — leave empty, user can fill manually
      console.warn('[WBR] AI generation failed for', s.key, e.message);
    }
    done++;
  }
  if (progressCb) progressCb(done, sites.length);
}

function _copyWBR() {
  const rows = state.slice('fleet').rows || [];
  const sites = _getWBRSites(rows);
  const tsv = sites.map(s => {
    const bridge = _wbrGet(s.key, 'bridge').replace(/\t/g, ' ').replace(/\n/g, ' ');
    const actions = _wbrGet(s.key, 'actions').replace(/\t/g, ' ').replace(/\n/g, ' ');
    return s.key + '\t' + bridge + '\t' + actions;
  }).join('\n');
  const header = 'Site\tField Level Bridge\tFAS Field Actions\n';
  try { navigator.clipboard.writeText(header + tsv); } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = header + tsv;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}
