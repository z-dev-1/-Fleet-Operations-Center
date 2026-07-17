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

function _unitText(r) {
  return [r.issueDetails || '', r.issueSummary || '', r.savedNotes || '', r.savedRepairStatus || ''].join(' ');
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
    for (const [label, re] of TREND_TERMS) {
      if (re.test(text)) {
        if (!trendMap[label]) trendMap[label] = new Set();
        trendMap[label].add(r.equipmentId || r.id || '?');
      }
    }
  }
  const trends = Object.entries(trendMap)
    .filter(([, ids]) => ids.size >= TREND_MIN_UNITS)
    .map(([label, ids]) => ({ label, count: ids.size, units: Array.from(ids) }))
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
      if (re.test(text)) barrierMap[label] = (barrierMap[label] || 0) + 1;
    }
  }
  if (noVendorCount > 0) barrierMap['No vendor assigned'] = noVendorCount;
  const barriers = Object.entries(barrierMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([label, count]) => `${label} (${count})`);

  // Expected flips (draft)
  const flipUnits = unavail.filter(r => FLIP_SIGNAL.test(_unitText(r))).map(r => r.equipmentId || r.id || '?');

  // FEATURE (2026-07-17): raw per-unit text kept on the group object so the
  // AI verification pass (see _buildAIPrompt/_validateAIResult below) can
  // cross-check against the ACTUAL source text and cite real unit IDs --
  // never let AI "verify" against a summary of a summary.
  const unavailRows = unavail.map(r => ({
    id: r.equipmentId || r.id || '?',
    text: _unitText(r).trim().substring(0, 300),
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
  const trendsList = g.trends.length
    ? g.trends.map(t => `- "${t.label}": ${t.count} units (${t.units.join(', ')})`).join('\n')
    : '(none detected)';
  const unitLines = rows.map(u => `[${u.id}] ${u.text || '(no issue text)'}`).join('\n');

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

STRICT RULES -- violating these invalidates your response:
- Every TREND or BARRIER claim MUST cite the exact unit IDs (from the bracketed list above) where you found it. No unit IDs = do not include the claim.
- Do NOT invent, guess, or extrapolate beyond what is explicitly stated in the raw text.
- Minimum 3 units required for any "additional trend" claim -- same threshold as the mechanical detection. Barriers have NO minimum -- a single unit's blocker is still worth flagging.
- If you find nothing beyond what's already detected for trends or barriers, say so plainly -- do not fabricate filler content to seem useful.
- Actions and help-needed are recommendations, not factual claims -- they don't require the same unit-citation rigor, but should still be grounded in what you actually see in the text, not generic boilerplate.

RESPOND WITH JSON ONLY, no markdown, no explanation outside the JSON:
{"trendsAccurate": true, "trendIssues": "", "additionalTrends": [{"label": "short name", "units": ["id1","id2","id3"], "quote": "short supporting phrase from the text"}], "barrierNotes": [{"note": "short barrier description", "units": ["id1","id2"]}], "suggestedActions": [{"action": "short concrete next step", "units": ["id1"]}], "suggestedHelp": [{"note": "short description of help needed and from whom", "units": ["id1"]}]}`;
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
      out.barrierNotes.push({ note: b.note.trim().substring(0, 150), units });
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
      out.suggestedActions.push({ action: a.action.trim().substring(0, 150), units });
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
    const result = await window.ai.ask(prompt);
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
  const actionsDraft = (aiData.suggestedActions || []).map(a => a.action + (a.units.length ? ` (${a.units.join(', ')})` : '')).join('; ');
  const helpDraft = (aiData.suggestedHelp || []).map(h => h.note + (h.units.length ? ` (${h.units.join(', ')})` : '')).join('; ');
  return { actionsDraft, helpDraft };
}

// ── Row render (editable) ───────────────────────────────────────────────────
function _renderGroupRow(kind, g) {
  const trendsHtml = g.trends.length
    ? g.trends.map(t => `<div class="dc-trend-line">${_safe(t.label)} — ${t.count} units <span class="dc-unit-list">(${t.units.slice(0, 8).map(_safe).join(', ')})</span></div>`).join('')
    : '<span class="an-empty">No trends</span>';

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
        ? additionalTrends.map(t => `<div class="dc-trend-line dc-trend-line--ai">🤖 ${_safe(t.label)} — ${t.units.length} units <span class="dc-unit-list">(${t.units.map(_safe).join(', ')})</span>${t.quote ? `<div class="dc-ai-quote">"${_safe(t.quote)}"</div>` : ''}</div>`).join('')
        : '';
      const issueHtml = (!aiData.trendsAccurate && aiData.trendIssues)
        ? `<div class="dc-ai-note dc-ai-note--warn">⚠ AI flagged: ${_safe(aiData.trendIssues)}</div>` : '';
      const nothingInTrends = !addTrendsHtml && !issueHtml;
      aiTrendsHtml = `<div class="dc-ai-block">${addTrendsHtml}${issueHtml}${nothingInTrends ? '<div class="dc-ai-note dc-ai-note--ok">🤖 Reviewed — no additional trends found</div>' : ''}<div class="dc-ai-timestamp">Reviewed ${reviewedStr}</div></div>`;

      // Barriers column: everything blocking progress, single-unit OK
      aiBarriersHtml = barrierNotes.length
        ? `<div class="dc-ai-block">${barrierNotes.map(b => `<div class="dc-ai-note">🤖 ${_safe(b.note)} <span class="dc-unit-list">(${b.units.map(_safe).join(', ')})</span></div>`).join('')}</div>`
        : '';

      // Actions column: AI-suggested next steps — also used as the default
      // draft text for the textarea (Actions had no deterministic draft
      // before; this is what the user explicitly asked for).
      if (suggestedActions.length) {
        aiActionsHtml = `<div class="dc-ai-block">${suggestedActions.map(a => `<div class="dc-ai-note">🤖 ${_safe(a.action)}${a.units.length ? ` <span class="dc-unit-list">(${a.units.map(_safe).join(', ')})</span>` : ''}</div>`).join('')}</div>`;
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
    const trendsTxt = g.trends.length ? g.trends.map(t => `${t.label} — ${t.count} units`).join('\n') : 'No Trends';
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

  _update(state.slice('fleet').rows || []);
}
