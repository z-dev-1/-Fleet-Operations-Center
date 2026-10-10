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
import { quicksight } from '../bridge.js';

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
    make: (r.make || '').trim() || null,
  }));

  return {
    total, unavailCount: unavail.length, uptime,
    trends, barriers, flipUnits, unavailRows,
  };
}

// Call window.ai.ask with a per-call timeout AND bounded retry on
// timeout/transient failure. Returns the { ok, text } result, or throws the
// last error after exhausting retries. Each attempt is independently timed out
// (90s, matching the transport ceiling); between attempts it waits a short
// backoff. A result with ok===false or a non-JSON body is NOT retried here
// (that's a real AI answer, handled by the caller) — only timeouts/throws are.
async function _askAIWithRetry(prompt, opts) {
  const maxRetries = (opts && Number.isInteger(opts.maxRetries)) ? opts.maxRetries : 2;
  const timeoutMs  = (opts && opts.timeoutMs) || 90000;
  const label      = (opts && opts.label) || '';
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const _timeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('AI timeout after ' + Math.round(timeoutMs / 1000) + 's')), timeoutMs));
      return await Promise.race([window.ai.ask(prompt), _timeout]);
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        if (opts && opts.onStatus) opts.onStatus('retry ' + (attempt + 1) + '/' + maxRetries + (label ? ' · ' + label : ''));
        // Short backoff before retrying this same group (400ms, 800ms).
        await new Promise(r => setTimeout(r, 400 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr || new Error('AI call failed after retries');
}

// Shared by _renderGroupRow and _buildTsv so the "Copy for SharePoint"
// ── Full view HTML ───────────────────────────────────────────────────────────
function _viewHtml() {
  return `
    <style>
      #view-daily-call .dc-table { width: 100%; border-collapse: collapse; }
      #view-daily-call .dc-table th, #view-daily-call .dc-table td { border: 1px solid var(--border, #333); padding: 8px; vertical-align: top; font-size: 12px; }
      #view-daily-call .dc-input { width: 100%; box-sizing: border-box; resize: vertical; font-size: 12px; font-family: inherit; background: var(--bg2, #1a1a2e); color: var(--fg, #eee); border: 1px solid var(--border, #444); border-radius: 4px; padding: 4px 6px; }
      #view-daily-call .dc-section-title { font-size: 15px; font-weight: 600; margin: 20px 0 8px; }
      #view-daily-call .dc-scope-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
      #view-daily-call .dc-scope-label { font-size: 12px; color: var(--mut, #888); white-space: nowrap; }
      #view-daily-call .dc-scope-input { flex: 1 1 280px; min-width: 200px; min-height: 30px; max-height: 90px; box-sizing: border-box; resize: vertical; font-size: 12px; font-family: inherit; background: var(--bg2, #1a1a2e); color: var(--fg, #eee); border: 1px solid var(--border, #444); border-radius: 4px; padding: 5px 7px; }
      #view-daily-call .dc-scope-active { color: #58a6ff; font-weight: 600; }
      #view-daily-call .dc-scope-notfound { color: #f0a800; }
    </style>
    <div class="an-header">
      <div class="an-header__left">
        <span class="an-title">Daily Call</span>
        <span class="an-subtitle">DBR DATA pulls Domicile/SCAC/Uptime/Trends/Barriers from QuickSight + live fleet data. WBR below is generated from live fleet data.</span>
      </div>
      <div class="an-header__actions">
        <button id="dc-dbr-data" class="detail-panel__btn detail-panel__btn--secondary" title="AFP/DSP QuickSight — WTD Bottom 10 by Domicile/SCAC">📊 DBR DATA</button>
        <button id="dc-refresh" class="detail-panel__btn detail-panel__btn--secondary">↺ Refresh</button>
        <button id="dc-back" class="detail-panel__btn">Back to Fleet</button>
      </div>
    </div>
    <div class="an-body">
      <div class="dc-scope-row">
        <label class="dc-scope-label" for="dc-scope">Scope WBR to domicile / SCAC (blank = all):</label>
        <textarea id="dc-scope" class="dc-scope-input" rows="1" placeholder="e.g. ABE40, TUZR — each becomes its own section"></textarea>
        <button id="dc-scope-apply" class="detail-panel__btn detail-panel__btn--secondary" style="font-size:11px;">🎯 Scope</button>
        <button id="dc-scope-clear" class="detail-panel__btn detail-panel__btn--secondary" style="font-size:11px;">✕ Clear</button>
        <span id="dc-scope-note" style="font-size:11px;"></span>
      </div>

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
// SCOPE MODE: user types domicile and/or operator (SCAC) tokens (e.g.
// "ABE40, TUZR") to narrow the WBR to just those sites/carriers. Empty =
// all sites with unavailable units.
let _scopeTokens   = [];   // normalized tokens, in entered order (deduped)
let _scopeNotFound = [];   // tokens not matching any domicile or operator

function _normTok(s) { return String(s || '').trim().toUpperCase(); }

// Parse the scope box (newline / comma / space / semicolon separated) into a
// deduped, first-seen-ordered list of normalized tokens.
function _parseScope(text) {
  const seen = new Set();
  const out = [];
  for (const t of String(text || '').split(/[\s,;]+/)) {
    const tok = _normTok(t);
    if (!tok || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

function _update(rows) {
  if (!_el) return;

  if (_scopeTokens.length) {
    const domSet = new Set((rows || []).map(r => _normTok(r.domicileSite)).filter(Boolean));
    const opSet  = new Set((rows || []).map(r => _normTok(r.operator)).filter(Boolean));
    _scopeNotFound = _scopeTokens.filter(t => !domSet.has(t) && !opSet.has(t));
  } else {
    _scopeNotFound = [];
  }

  const scoped = _scopeTokens.length > 0;
  const noteEl = _el.querySelector('#dc-scope-note');
  if (noteEl) {
    if (scoped) {
      noteEl.innerHTML = '<span class="dc-scope-active">Scoped to ' + _scopeTokens.length + ' token(s)</span>' +
        (_scopeNotFound.length ? ' <span class="dc-scope-notfound">⚠ not found: ' + _safe(_scopeNotFound.join(', ')) + '</span>' : '');
    } else {
      noteEl.textContent = '';
    }
  }

  // WBR table (renders from localStorage; Generate fills it via AI)
  _renderWBR(rows);
}

// ── DBR DATA panel (AFP QuickSight — WTD Bottom 10 by Domicile/SCAC) ───────
// Per user: ONLY Domicile/SCAC, Uptime %, # Units Unavailable are auto-filled
// from the QuickSight scrape (src/scrapers/quicksight_dbr.js). FAS is filled
// in by other people during the call EXCEPT: if a row's Domicile or SCAC
// matches one of the user's own (their managed domiciles / their carriers),
// FAS is pre-filled "Z". Trends/Barriers/Expected Flips/Actions/Help
// Needed/MM-PM-BC are always left blank for manual entry — this panel is a
// reference/cross-check next to Daily Call's own computed table, not a
// replacement for it.
const _dbrEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Uptime values come back from AI parsing as plain numbers (e.g. 82.4) so
// the JSON stays strict — but the sheet (and this table) should always
// show/paste the "%" the real DBR sheet uses (e.g. "82.4%"). Idempotent:
// a value that already ends in "%" (e.g. a manually-typed edit) is left
// alone rather than getting a second "%" appended.
function _dbrPct(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (s.endsWith('%')) return s;
  return s + '%';
}
let _dbrOverlay = null;
let _dbrData = null;    // last AFP scrape/cache result: { ok, domicile, scac, scrapedAt, error }
let _dbrDspData = null; // last DSP scrape/cache result: { ok, scac, scrapedAt, error }

// "Mine" = domiciles the user manages (Contact Book type:'domicile' names)
// union with carriers/operators present in their own fleet data (the SCACs
// that actually show up on their units) — matches the "if it matches my
// domiciles or carriers" rule.
async function _loadMySitesAndCarriers() {
  const mySites = new Set();
  const myCarriers = new Set();
  try {
    const rows = state.slice('fleet').rows || [];
    rows.forEach(r => {
      const d = (r.domicileSite || r.domicile || '').trim().toUpperCase();
      if (d) mySites.add(d);
      const op = (r.operator || '').trim().toUpperCase();
      if (op) myCarriers.add(op);
    });
  } catch (e) { /* fleet state unavailable — fall through with whatever Contact Book gives us */ }
  try {
    if (window.contacts) {
      const all = await window.contacts.getAll();
      all.filter(c => c.type === 'domicile').forEach(c => {
        const n = (c.name || '').trim().toUpperCase();
        if (n) mySites.add(n);
      });
    }
  } catch (e) { /* contacts bridge unavailable — fleet-derived sets still apply */ }
  return { mySites, myCarriers };
}

// AI JSON-extraction timeout — mirrors wr-modal.js's AI Fill guard so a
// slow/stuck AI backend never leaves the Scrape button spinning forever.
const _DBR_AI_TIMEOUT_MS = 95000;

async function _dbrAskAi(prompt) {
  const result = await Promise.race([
    window.ai.ask(prompt),
    new Promise((_, rej) => setTimeout(() => rej(new Error('AI parsing timed out — the AI service may be unavailable')), _DBR_AI_TIMEOUT_MS)),
  ]);
  const text = (result && result.text) ? result.text : (result || '');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI returned no parseable data — the dashboard text may be unusable, or the AI service may be down.');
  return JSON.parse(match[0]);
}

// Builds the AI prompt that turns raw QuickSight page text into the AFP
// JSON shape _dbrRenderTables() expects: { domicile:[{domicile,uptimePct,
// unitsUnavailable}], scac:[{scac,domicile,uptimePct,unitsUnavailable}] }.
function _dbrAfpPrompt(pageText) {
  return 'You are reading plain rendered text copied from an AWS QuickSight dashboard page (document.body.innerText — not HTML, so pivot tables render in a specific flattened order, NOT as neat rows of "label value value value").\n\n'
    + 'CRITICAL — HOW THESE PIVOT TABLES ACTUALLY RENDER IN THIS TEXT (read carefully, this is NOT a normal table layout):\n'
    + 'For each pivot table, the text contains, IN THIS ORDER:\n'
    + '  1. The table title (e.g. "WTD Bottom 10 Performing Domicile Sites") and a one-line description.\n'
    + '  2. A block of raw numbers — this is EVERY ROW\'s value for metric 1, then EVERY ROW\'s value for metric 2, then metric 3, and so on, metric-by-metric (COLUMN-MAJOR, not row-major). So if there are 10 rows, the first 10 numbers you see are all "% to Goal" (one per row, top row first), the next 10 are all "Uptime %", the next 10 are all "Uptime Goal", then 10 "CNG Asset" counts, 10 "DIESEL Asset" counts, 10 "Downed Asset" counts, 10 "Active WRs", etc.\n'
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

// DSP prompt: SCAC-ranked table (Downtime %, Uptime %, Asset #). Per user:
// only SCAC/Uptime%/#UnitsUnavailable are needed. There is no direct
// "# Units Unavailable" column on this dashboard — ask the AI to derive it
// from Asset # x Downtime % if (and only if) it can find both columns, and
// flag it as estimated so the UI shows it's not a literal dashboard value.
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

// Safety net on top of the DSP prompt instruction: the DSP dashboard's own
// "Bottom N" filter can be set higher than 10 (seen set to 20 live), so even
// though the prompt tells the AI to sort+keep only the worst 10, this
// re-sorts by uptime ascending and hard-slices to 10 in code so a prompt
// miss can never leak extra rows into the sheet.
function _dbrClampToBottom10(rows) {
  if (!Array.isArray(rows)) return [];
  const withUptime = rows.filter(r => r && typeof r.uptimePct === 'number');
  const withoutUptime = rows.filter(r => !(r && typeof r.uptimePct === 'number'));
  withUptime.sort((a, b) => a.uptimePct - b.uptimePct);
  return [...withUptime, ...withoutUptime].slice(0, 10);
}

// ── Per-row AI review (Trends/Barriers/Expected Flips/Actions/Help Needed) ──
// Per user: ONLY run the full mechanical+AI review for a DBR row when it's
// "mine" (its Domicile is in mySites, or its SCAC is in myCarriers — same
// check that drives the FAS="Z" auto-fill). Rows that aren't mine are left
// blank for whoever owns that part of the call to fill in by hand.
//
// Reuses the exact deterministic engine (_computeGroup, TREND_TERMS,
// BARRIER_TERMS, FLIP_SIGNAL, STATUS_BARRIER_MAP) and AI-verification pass
// (_buildAIPrompt-style prompt + _validateAIResult anti-fabrication gate)
// that the old whole-fleet Daily Call table used — just scoped down to the
// units matched to ONE DBR row (one domicile, or one SCAC) instead of every
// domicile/SCAC in the fleet.
let _dbrReview = {}; // key: `${sectionKind}::${rowKey}` -> { trendsText, barriersText, flipsText, actionsText, helpText, error? }
function _dbrReviewKey(sectionKind, rowKey) { return sectionKind + '::' + rowKey; }

// Match fleet rows to a DBR row: AFP domicile rows match on domicileSite;
// SCAC rows (AFP or DSP) match on operator. Always filtered to unavailable
// units only — matches "Bottom 10" semantics (nothing to report otherwise).
function _dbrMatchUnits(sectionKind, rowKey) {
  const rows = state.slice('fleet').rows || [];
  const key = (rowKey || '').trim().toUpperCase();
  if (!key) return [];
  const matched = sectionKind === 'domicile'
    ? rows.filter(r => (r.domicileSite || r.domicile || '').trim().toUpperCase() === key)
    : rows.filter(r => (r.operator || '').trim().toUpperCase() === key);
  return matched.filter(_isUnavail);
}

// Builds the AI-review prompt for one DBR row's matched units. Lighter than
// the old whole-group prompt (one row, not a whole fleet pass) but keeps the
// same anti-fabrication contract and output voice/style guidance.
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

// Runs the full mechanical + AI review for one DBR row and caches the
// result keyed by section+row so re-rendering doesn't re-call AI. Only
// called for rows where mine===true.
// Safety net on top of the prompt instruction: if the model still leaks its
// reasoning instead of just saying "No trends" (e.g. "No single system
// reaches 3+ units... No trends meeting threshold"), collapse any response
// that CONTAINS a "no trend(s)" verdict but is longer than a short line down
// to the plain "No trends" — the sheet cell should never show the model's
// work. A response that's short to begin with, or that doesn't contain a
// "no trend" phrase at all (i.e. it found a real trend), passes through
// unchanged.
function _dbrNormalizeTrendsText(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (!text) return '';
  const looksLikeNoTrend = /\bno\s+trends?\b/i.test(text);
  if (looksLikeNoTrend && text.length > 20) return 'No trends';
  return text.substring(0, 400);
}

// Same safety net as _dbrNormalizeTrendsText, for Help Needed: the default
// (~95% of rows) is "No help needed" and the cell should never show the
// model's reasoning for why none of the 5 escalation checks matched.
function _dbrNormalizeHelpText(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (!text) return '';
  const looksLikeNoHelp = /\bno\s+help\s+needed\b/i.test(text);
  if (looksLikeNoHelp && text.length > 20) return 'No help needed';
  return text.substring(0, 300);
}

async function _dbrReviewRow(sectionKind, rowKey, label) {
  const cacheKey = _dbrReviewKey(sectionKind, rowKey);
  const units = _dbrMatchUnits(sectionKind, rowKey);
  if (!units.length) {
    _dbrReview[cacheKey] = { trendsText: '', barriersText: '', flipsText: '', actionsText: '', helpText: '', error: 'No matching units found in fleet data' };
    return _dbrReview[cacheKey];
  }
  const computed = _computeGroup(units, units);
  // Deterministic drafts (always available even if AI fails).
  const mechTrendsText = computed.trends.length
    ? computed.trends.map(t => `${t.count} ${t.label}${t.daysRange ? ' — ' + t.daysRange : ''}`).join('\n')
    : 'No trends';
  const mechBarriersText = computed.barriers.length ? computed.barriers.join('; ') : 'no barriers';
  const mechFlipsText = computed.flipUnits.length ? `~${computed.flipUnits.length} (${computed.flipUnits.slice(0, 6).join(', ')})` : '0';

  try {
    const prompt = _dbrBuildReviewPrompt(label, computed);
    const parsed = await _dbrAskAi(prompt);
    const result = {
      trendsText: _dbrNormalizeTrendsText(parsed.trends) || mechTrendsText,
      barriersText: typeof parsed.barriers === 'string' && parsed.barriers.trim() ? parsed.barriers.trim().substring(0, 400) : mechBarriersText,
      flipsText: typeof parsed.expectedFlips === 'string' && parsed.expectedFlips.trim() ? parsed.expectedFlips.trim().substring(0, 200) : mechFlipsText,
      actionsText: typeof parsed.actions === 'string' ? parsed.actions.trim().substring(0, 400) : '',
      helpText: _dbrNormalizeHelpText(parsed.helpNeeded),
    };
    _dbrReview[cacheKey] = result;
    return result;
  } catch (e) {
    // AI failed — fall back to the deterministic mechanical drafts rather
    // than leaving the row blank; flag the AI miss via console only (the
    // row itself still gets useful mechanical content).
    console.warn('[DBR] AI review failed for', label, e.message);
    const result = { trendsText: mechTrendsText, barriersText: mechBarriersText, flipsText: mechFlipsText, actionsText: '', helpText: '', aiError: e.message };
    _dbrReview[cacheKey] = result;
    return result;
  }
}

// ── Call Runner / Sheet Creator header fields (persisted, panel-level) ──────
function _dbrHeaderGet(field) {
  try { return localStorage.getItem('dbr__header__' + field) || ''; } catch (e) { return ''; }
}
function _dbrHeaderSet(field, val) {
  try { localStorage.setItem('dbr__header__' + field, val); } catch (e) {}
}

function _dbrPanelHtml() {
  return `
  <style>
    /* DBR overlay is appended directly to document.body (not inside
       #view-daily-call), so it needs its own unscoped rules for the
       dc-* classes shared with the main Daily Call view's table CSS. */
    #dbr-overlay .dc-table { width: 100%; border-collapse: collapse; }
    #dbr-overlay .dc-table th, #dbr-overlay .dc-table td { border: 1px solid var(--border, #333); padding: 6px; vertical-align: top; font-size: 11px; }
    #dbr-overlay .dc-input { width: 100%; box-sizing: border-box; resize: vertical; font-size: 11px; font-family: inherit; background: var(--bg2, #1a1a2e); color: var(--fg, #eee); border: 1px solid var(--border, #444); border-radius: 4px; padding: 4px 6px; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
    #dbr-overlay .dc-input.dbr-cell--autogrow { resize: none; overflow: hidden; min-height: 36px; }
    #dbr-overlay td { max-width: 260px; }
    #dbr-overlay .dc-section-title { font-size: 20px; font-weight: 700; margin: 18px 0 2px; }
    #dbr-overlay .dc-section-subtitle { font-size: 13px; font-weight: 600; margin: 4px 0 8px; text-transform: uppercase; }
    #dbr-overlay .dc-empty { padding: 10px; font-size: 11px; color: var(--mut, #888); }
  </style>
  <div id="dbr-overlay" class="wr-modal-overlay">
    <div class="wr-modal" id="dbr-modal-box" role="dialog" aria-modal="true" style="max-width:1300px;width:97vw;">
      <div class="wr-modal__header">
        <div class="wr-modal__title-row">
          <span class="wr-modal__title">📊 DBR DATA (QuickSight)</span>
        </div>
        <button id="dbr-close" class="wr-modal__close" aria-label="Close">×</button>
      </div>
      <div class="wr-modal__body">
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px;flex-wrap:wrap;">
          <label style="font-size:11px;display:flex;align-items:center;gap:6px;">CALL RUNNER:
            <input type="text" id="dbr-call-runner" class="dc-input" style="width:160px;display:inline-block;" value="${_dbrEsc(_dbrHeaderGet('callRunner'))}" />
          </label>
          <label style="font-size:11px;display:flex;align-items:center;gap:6px;">SHEET CREATOR:
            <input type="text" id="dbr-sheet-creator" class="dc-input" style="width:160px;display:inline-block;" value="${_dbrEsc(_dbrHeaderGet('sheetCreator'))}" />
          </label>
          <button id="dbr-copy-all-single" class="detail-panel__btn" title="Copies the WHOLE sheet (Call Runner/Sheet Creator through the end of DSP) as one block, including every banner/title/header row in between (reproduced verbatim) — paste once at A1 and everything lands correctly.">📋 Copy All — paste at cell A1</button>
        </div>
        <div style="font-size:10px;color:var(--mut);margin-bottom:10px;">
          "Copy All" copies the WHOLE sheet in one block (A1:K49) — Call Runner/Sheet Creator, every banner/title/header row, and all 3 data sections. The banners/titles/headers are reproduced exactly as they already appear on the sheet, so pasting over them changes nothing. Or use each section's own Copy button below if you'd rather paste one at a time.
        </div>

        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <button id="dbr-scrape" class="detail-panel__btn">↺ Scrape QuickSight (AFP)</button>
          <span id="dbr-status" style="font-size:11px;color:var(--mut);"></span>
        </div>
        <div style="font-size:10px;color:var(--mut);margin-bottom:10px;">
          Domicile/SCAC, Uptime %, and # Units Unavailable come from the AFP QuickSight dashboard (WTD Bottom 10), read via AI.
          FAS is pre-filled <strong>Z</strong> and Trends/Barriers/Expected Flips/Actions/Help Needed are AI-reviewed automatically for rows that match your own domiciles/carriers — everything else is left blank for whoever owns that row.
        </div>
        <div class="dc-section-title">AFP</div>
        <div class="dc-section-subtitle" style="display:flex;align-items:center;gap:10px;">BOTTOM 10 BY DOMICILE
          <button id="dbr-copy-domicile" class="detail-panel__btn detail-panel__btn--secondary" style="font-size:10px;text-transform:none;">📋 Copy block — paste at cell A8</button>
        </div>
        <div id="dbr-site-table"></div>
        <div class="dc-section-subtitle" style="margin-top:16px;display:flex;align-items:center;gap:10px;">BOTTOM 10 BY SCAC
          <button id="dbr-copy-scac" class="detail-panel__btn detail-panel__btn--secondary" style="font-size:10px;text-transform:none;">📋 Copy block — paste at cell A20</button>
        </div>
        <div id="dbr-scac-table"></div>

        <div style="display:flex;align-items:center;gap:10px;margin:20px 0 10px;">
          <button id="dbr-scrape-dsp" class="detail-panel__btn">↺ Scrape QuickSight (DSP)</button>
          <span id="dbr-status-dsp" style="font-size:11px;color:var(--mut);"></span>
        </div>
        <div style="font-size:10px;color:var(--mut);margin-bottom:10px;">
          The DSP dashboard has no direct "# Units Unavailable" column — it's <strong>estimated</strong> from Asset # × Downtime % (rounded), flagged with a ~ prefix.
        </div>
        <div class="dc-section-title">DSP</div>
        <div class="dc-section-subtitle" style="display:flex;align-items:center;gap:10px;">BOTTOM 10 BY SCAC
          <button id="dbr-copy-dsp" class="detail-panel__btn detail-panel__btn--secondary" style="font-size:10px;text-transform:none;">📋 Copy block — paste at cell A40</button>
        </div>
        <div id="dbr-dsp-table"></div>
      </div>
    </div>
  </div>`;
}

// Builds one <table> for a DBR section. rows: array of {domicile|scac,
// domicile(optional for scac sections), uptimePct, unitsUnavailable}.
// sectionKind: 'domicile' | 'scac' — drives which fleet field rows are
// matched against for the AI review. idLabel: display header ('Domicile'
// or 'SCAC'). showDomicileCol: AFP's SCAC table has an extra Domicile
// column; DSP's SCAC table does not.
// Real SharePoint sheet layout (confirmed via live grid dump, Friday 10-9
// sheet, Excel gutter row numbers): AFP Domicile section is A8:J17 (10 data
// rows, no SCAC column). AFP SCAC section is A20:K33 (14 data rows, column
// order is DOMICILE THEN SCAC — not SCAC then Domicile). DSP SCAC section
// is A40:J49 (10 data rows, no Domicile column). These exact row counts
// drive how many blank padding rows Copy-Section adds so a paste at the
// template's top-left data cell always fills (and never overshoots) the
// bordered/formatted block.
const DBR_SHEET_ROWS = { domicile: 10, scac: 14, dsp: 10 };

function _dbrBuildTable(rowsData, sectionKind, idLabel, showDomicileCol, mySites, myCarriers) {
  // Column order matches the real sheet exactly: AFP SCAC section shows
  // DOMICILE before SCAC (sectionKind 'scac' + showDomicileCol true is only
  // ever the AFP SCAC table — DSP's SCAC table has showDomicileCol false).
  const idHeaderCells = showDomicileCol ? '<th>Domicile</th><th>SCAC</th>' : `<th>${idLabel}</th>`;
  const headerRow = `<tr><th>FAS</th>${idHeaderCells}<th>Uptime %</th><th># Units Unavailable</th><th>Trends (SITE/SCAC)</th><th>Barriers (SITE/SCAC)</th><th>Expected Flips to A/H Today</th><th>Actions</th><th>Help Needed</th><th>MM/PM/BC</th><th>Copy</th></tr>`;
  if (!rowsData.length) {
    return `<table class="dc-table"><thead>${headerRow}</thead><tbody><tr><td colspan="${showDomicileCol ? 12 : 11}" class="dc-empty">No rows returned.</td></tr></tbody></table>`;
  }
  const bodyRows = rowsData.map((r, idx) => {
    const idVal = sectionKind === 'domicile' ? r.domicile : r.scac;
    const idKey = (idVal || '').trim().toUpperCase();
    const domicileKey = (r.domicile || '').trim().toUpperCase();
    const mine = sectionKind === 'domicile'
      ? mySites.has(idKey)
      : (myCarriers.has(idKey) || (domicileKey && mySites.has(domicileKey)));
    const unavailDisplay = r.unitsUnavailableEstimated ? ('~' + r.unitsUnavailable) : (r.unitsUnavailable != null ? r.unitsUnavailable : '');
    const rowDomId = 'dbr-row-' + sectionKind + '-' + idx;
    const review = mine ? _dbrReview[_dbrReviewKey(sectionKind, idVal)] : null;
    const cell = (field) => {
      const val = review ? (review[field] || '') : '';
      return `<textarea class="dc-input dbr-cell dbr-cell--autogrow" data-dbr-field="${field}" rows="1" placeholder="${mine ? '' : 'Fill in during call'}">${_dbrEsc(val)}</textarea>`;
    };
    const idCells = showDomicileCol ? `<td>${_dbrEsc(r.domicile)}</td><td>${_dbrEsc(r.scac)}</td>` : `<td>${_dbrEsc(idVal)}</td>`;
    return `<tr id="${rowDomId}" data-dbr-section="${sectionKind}" data-dbr-key="${_dbrEsc(idVal)}" data-dbr-mine="${mine ? '1' : '0'}" data-dbr-has-domicile-col="${showDomicileCol ? '1' : '0'}">
      <td>${mine ? '<strong style="color:#58a6ff">Z</strong>' : ''}</td>
      ${idCells}
      <td>${_dbrEsc(_dbrPct(r.uptimePct))}</td>
      <td>${_dbrEsc(unavailDisplay)}</td>
      <td>${cell('trendsText')}</td>
      <td>${cell('barriersText')}</td>
      <td>${cell('flipsText')}</td>
      <td>${cell('actionsText')}</td>
      <td>${cell('helpText')}</td>
      <td><textarea class="dc-input dbr-cell dbr-cell--autogrow" data-dbr-field="mmpmbc" rows="1"></textarea></td>
      <td><button class="detail-panel__btn detail-panel__btn--secondary dbr-copy-row" style="font-size:10px;white-space:nowrap;">📋 Row</button></td>
    </tr>`;
  }).join('');
  return `<table class="dc-table"><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>`;
}

// Collects one row's cells (in REAL sheet column order) as an array of
// strings, reading live textarea values so unsaved edits are included.
// showDomicileCol=true means Domicile THEN SCAC (AFP SCAC section's real
// column order) — matches the id-cell order _dbrBuildTable renders.
function _dbrRowToCells(trEl, sectionKind, showDomicileCol) {
  const fas = trEl.querySelector('td:nth-child(1)').textContent.trim();
  let col = 2;
  const idCells = [];
  if (showDomicileCol) {
    idCells.push(trEl.querySelector(`td:nth-child(${col++})`).textContent.trim()); // Domicile
    idCells.push(trEl.querySelector(`td:nth-child(${col++})`).textContent.trim()); // SCAC
  } else {
    idCells.push(trEl.querySelector(`td:nth-child(${col++})`).textContent.trim()); // Domicile or SCAC
  }
  const uptime = trEl.querySelector(`td:nth-child(${col++})`).textContent.trim();
  const unavail = trEl.querySelector(`td:nth-child(${col++})`).textContent.trim();
  const get = (field) => { const ta = trEl.querySelector(`textarea[data-dbr-field="${field}"]`); return ta ? ta.value : ''; };
  return [fas, ...idCells, uptime, unavail, get('trendsText'), get('barriersText'), get('flipsText'), get('actionsText'), get('helpText'), get('mmpmbc')];
}

function _dbrCopyRow(trEl, sectionKind, showDomicileCol) {
  const cells = _dbrRowToCells(trEl, sectionKind, showDomicileCol);
  _copyToClipboard(cells.map(_tsvCell).join('\t'));
}

// Copies ONE section's data rows ONLY — no headers, no section titles, no
// CALL RUNNER line, since those already exist on the real SharePoint sheet
// at fixed positions. Padded/trimmed to the real sheet's exact row count
// (DBR_SHEET_ROWS) so a paste at the template's top-left data cell (A8 for
// Domicile, A20 for SCAC, A40 for DSP, Excel gutter numbering) always lands cleanly inside that
// section's bordered block — never overshooting into the next section's
// title row, never leaving stray leftover rows from a previous paste.
function _dbrCopySection(hostSelector, sectionKind, showDomicileCol, targetRowCount) {
  const colCount = showDomicileCol ? 11 : 10;
  const trs = Array.from(document.querySelectorAll(hostSelector + ' tbody tr[data-dbr-section]'));
  const lines = trs.map(tr => _dbrRowToCells(tr, sectionKind, showDomicileCol).map(_tsvCell).join('\t'));
  // Pad with fully-blank rows if we have fewer than the sheet expects;
  // trim if (unexpectedly) more, so the paste never spills past the block.
  const blankRow = new Array(colCount).fill('').join('\t');
  while (lines.length < targetRowCount) lines.push(blankRow);
  const trimmed = lines.slice(0, targetRowCount);
  _copyToClipboard(trimmed.join('\n'));
  return trimmed.length;
}

// Copies the ENTIRE sheet — CALL RUNNER/SHEET CREATOR through the end of
// DSP — as ONE paste-ready block, meant to be pasted starting at cell A1
// (Excel gutter numbering) covering through row 49. This works because
// every row that already has content on the real sheet (banners, section
// titles, header rows) is reproduced VERBATIM — same text, same row
// position — so pasting over them is a no-op (identical text replacing
// identical text), not a destructive overwrite. The only row with REAL
// (non-static) content is row 1, which uses the live Call Runner/Sheet
// Creator input values rather than copying old text. Column width is
// padded to 11 (the widest section, AFP SCAC) for every row so the whole
// block pastes as one rectangular range; narrower rows (Domicile/DSP, which
// only use 10 cols) just leave column K blank, matching what's already there.
function _dbrCopyAllSingle() {
  const WIDTH = 11;
  const pad = (cells) => { const c = cells.slice(); while (c.length < WIDTH) c.push(''); return c.slice(0, WIDTH); };
  const blankRow = () => pad([]);
  const lines = [];

  // Row 1: CALL RUNNER / SHEET CREATOR — real values from the input fields,
  // not a copy of existing sheet text (this row IS user-entered data).
  const callRunnerInput = document.getElementById('dbr-call-runner');
  const sheetCreatorInput = document.getElementById('dbr-sheet-creator');
  const callRunner = callRunnerInput ? callRunnerInput.value.trim() : '';
  const sheetCreator = sheetCreatorInput ? sheetCreatorInput.value.trim() : '';
  lines.push(pad([
    callRunner ? 'CALL RUNNER: ' + callRunner : '', '',
    sheetCreator ? 'SHEET CREATOR: ' + sheetCreator : '',
  ]));
  // Row 2: "AFP" banner (verbatim)
  lines.push(pad(['AFP']));
  // Rows 3-5: blank spacing under the AFP banner (verbatim)
  lines.push(blankRow(), blankRow(), blankRow());
  // Row 6: "BOTTOM 10 BY DOMICILE" section title (verbatim)
  lines.push(pad(['BOTTOM 10 BY DOMICILE']));
  // Row 7: Domicile section header row (verbatim)
  lines.push(pad(['FAS', 'DOMICILE', 'Uptime %', '# Units Unavailable', 'Trends (SITE/SCAC)', 'Barriers (SITE/SCAC)', 'Expected Flips to A/H Today', 'Actions', 'Help Nedded', 'MMPM/BC']));

  // Rows 8-17: AFP Domicile data (10 cols used, padded to 11)
  const domTrs = Array.from(document.querySelectorAll('#dbr-site-table tbody tr[data-dbr-section]'));
  const domRows = domTrs.map(tr => pad(_dbrRowToCells(tr, 'domicile', false)));
  while (domRows.length < DBR_SHEET_ROWS.domicile) domRows.push(blankRow());
  lines.push(...domRows.slice(0, DBR_SHEET_ROWS.domicile));

  // Row 18: "BOTTOM 10 BY SCAC" section title (verbatim from the real sheet)
  lines.push(pad(['BOTTOM 10 BY SCAC']));
  // Row 19: SCAC section header row (verbatim)
  lines.push(pad(['FAS', 'DOMICILE', 'SCAC', 'Uptime %', '# Units Unavailable', 'Trends (SITE/SCAC)', 'Barriers (SITE/SCAC)', 'Expected Flips to A/H Today', 'Actions', 'Help Nedded', 'MMPM/BC']));

  // Rows 20-33: AFP SCAC data (11 cols, full width)
  const scacTrs = Array.from(document.querySelectorAll('#dbr-scac-table tbody tr[data-dbr-section]'));
  const scacRows = scacTrs.map(tr => pad(_dbrRowToCells(tr, 'scac', true)));
  while (scacRows.length < DBR_SHEET_ROWS.scac) scacRows.push(blankRow());
  lines.push(...scacRows.slice(0, DBR_SHEET_ROWS.scac));

  // Row 34: "DSP" banner (verbatim)
  lines.push(pad(['DSP']));
  // Rows 35-37: blank (verbatim)
  lines.push(blankRow(), blankRow(), blankRow());
  // Row 38: "BOTTOM 10 BY SCAC" (DSP) section title (verbatim)
  lines.push(pad(['BOTTOM 10 BY SCAC']));
  // Row 39: DSP section header row (verbatim)
  lines.push(pad(['FAS', 'SCAC', 'Uptime %', '# Units Unavailable', 'Trends (SITE/SCAC)', 'Barriers (SITE/SCAC)', 'Expected Flips to A/H Today', 'Actions', 'Help Nedded', 'MMPM/BC']));

  // Rows 40-49: DSP data (10 cols used, padded to 11, hard-capped to the
  // worst 10 by uptime via _dbrClampToBottom10 at scrape time)
  const dspTrs = Array.from(document.querySelectorAll('#dbr-dsp-table tbody tr[data-dbr-section]'));
  const dspRows = dspTrs.map(tr => pad(_dbrRowToCells(tr, 'scac', false)));
  while (dspRows.length < DBR_SHEET_ROWS.dsp) dspRows.push(blankRow());
  lines.push(...dspRows.slice(0, DBR_SHEET_ROWS.dsp));

  const tsv = lines.map(cells => cells.map(_tsvCell).join('\t')).join('\n');
  _copyToClipboard(tsv);
  return lines.length;
}

// Wires auto-save-on-edit + per-row copy buttons for a freshly-rendered
// table host. Shared by all three sections.
function _dbrWireTable(hostEl) {
  if (!hostEl) return;
  hostEl.querySelectorAll('.dbr-copy-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const tr = btn.closest('tr');
      const sectionKind = tr.dataset.dbrSection;
      const showDomicileCol = tr.dataset.dbrHasDomicileCol === '1';
      _dbrCopyRow(tr, sectionKind, showDomicileCol);
      const orig = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = orig; }, 1200);
    });
  });

  // Auto-grow the Trends/Barriers/Flips/Actions/Help/MM-PM-BC textareas so
  // long AI output (or long manual notes) is fully visible without having
  // to drag-resize or scroll inside a tiny 2-row box. Grows on input, and
  // sized once up front for whatever's already filled in (AI results).
  hostEl.querySelectorAll('.dbr-cell--autogrow').forEach(ta => {
    _dbrAutoGrow(ta);
    ta.addEventListener('input', () => _dbrAutoGrow(ta));
  });
}

// Resizes a textarea's height to fit its content (classic auto-grow:
// collapse to 0 first so scrollHeight reflects only the content, then set
// height to that). A small min-height keeps empty cells from looking
// collapsed/cramped next to the FAS/Uptime/Unavailable number columns.
function _dbrAutoGrow(ta) {
  ta.style.height = 'auto';
  const minPx = 36;
  ta.style.height = Math.max(minPx, ta.scrollHeight) + 'px';
}

// Kicks off AI review (async, in the background) for every "mine" row in a
// freshly-scraped section, then re-renders that section's table once each
// row's review resolves — so the panel doesn't block on N AI calls serially.
async function _dbrRunReviewsForSection(rowsData, sectionKind, mySites, myCarriers, rerender) {
  const mineRows = rowsData.filter(r => {
    const idVal = sectionKind === 'domicile' ? r.domicile : r.scac;
    const idKey = (idVal || '').trim().toUpperCase();
    const domicileKey = (r.domicile || '').trim().toUpperCase();
    return sectionKind === 'domicile' ? mySites.has(idKey) : (myCarriers.has(idKey) || (domicileKey && mySites.has(domicileKey)));
  });
  if (!mineRows.length) return;
  for (const r of mineRows) {
    const idVal = sectionKind === 'domicile' ? r.domicile : r.scac;
    const label = sectionKind === 'domicile' ? ('domicile ' + idVal) : ('SCAC ' + idVal);
    await _dbrReviewRow(sectionKind, idVal, label);
    rerender();
  }
}

async function _dbrRenderTables() {
  const siteHost = document.getElementById('dbr-site-table');
  const scacHost = document.getElementById('dbr-scac-table');
  const dspHost = document.getElementById('dbr-dsp-table');
  if (!siteHost || !scacHost) return;

  const { mySites, myCarriers } = await _loadMySitesAndCarriers();
  const data = _dbrData;

  if (!data || !data.ok) {
    const msg = data && data.error ? _dbrEsc(data.error) : 'No data yet — click "Scrape QuickSight (AFP)" above.';
    siteHost.innerHTML = `<div class="dc-empty">${msg}</div>`;
    scacHost.innerHTML = '';
  } else {
    siteHost.innerHTML = _dbrBuildTable(data.domicile || [], 'domicile', 'DOMICILE', false, mySites, myCarriers);
    scacHost.innerHTML = _dbrBuildTable(data.scac || [], 'scac', 'SCAC', true, mySites, myCarriers);
    _dbrWireTable(siteHost);
    _dbrWireTable(scacHost);
  }

  if (dspHost) {
    const dspData = _dbrDspData;
    if (!dspData || !dspData.ok) {
      const dspMsg = dspData && dspData.error ? _dbrEsc(dspData.error) : 'No data yet — click "Scrape QuickSight (DSP)" above.';
      dspHost.innerHTML = `<div class="dc-empty">${dspMsg}</div>`;
    } else {
      dspHost.innerHTML = _dbrBuildTable(dspData.scac || [], 'scac', 'SCAC', false, mySites, myCarriers);
      _dbrWireTable(dspHost);
    }
  }
}

async function _openDbrPanel() {
  if (_dbrOverlay) return;
  _dbrOverlay = document.createElement('div');
  _dbrOverlay.innerHTML = _dbrPanelHtml();
  document.body.appendChild(_dbrOverlay);

  const close = () => {
    if (_dbrOverlay && _dbrOverlay.parentNode) _dbrOverlay.parentNode.removeChild(_dbrOverlay);
    _dbrOverlay = null;
  };
  document.getElementById('dbr-close').addEventListener('click', close);
  document.getElementById('dbr-overlay').addEventListener('click', (e) => { if (e.target.id === 'dbr-overlay') close(); });

  const callRunnerInput = document.getElementById('dbr-call-runner');
  const sheetCreatorInput = document.getElementById('dbr-sheet-creator');
  if (callRunnerInput) callRunnerInput.addEventListener('input', () => _dbrHeaderSet('callRunner', callRunnerInput.value));
  if (sheetCreatorInput) sheetCreatorInput.addEventListener('input', () => _dbrHeaderSet('sheetCreator', sheetCreatorInput.value));

  // Per-section copy buttons — each copies ONLY that section's data rows
  // (no headers), padded/trimmed to the real sheet's exact row count, ready
  // to paste directly at that section's top-left data cell.
  const wireCopySection = (btnId, hostSelector, sectionKind, showDomicileCol, targetRowCount) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      _dbrCopySection(hostSelector, sectionKind, showDomicileCol, targetRowCount);
      const orig = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
  };
  wireCopySection('dbr-copy-domicile', '#dbr-site-table', 'domicile', false, DBR_SHEET_ROWS.domicile);
  wireCopySection('dbr-copy-scac', '#dbr-scac-table', 'scac', true, DBR_SHEET_ROWS.scac);
  wireCopySection('dbr-copy-dsp', '#dbr-dsp-table', 'scac', false, DBR_SHEET_ROWS.dsp);

  const copyAllSingleBtn = document.getElementById('dbr-copy-all-single');
  if (copyAllSingleBtn) copyAllSingleBtn.addEventListener('click', () => {
    _dbrCopyAllSingle();
    const orig = copyAllSingleBtn.textContent;
    copyAllSingleBtn.textContent = '✓ Copied! Paste at A1';
    setTimeout(() => { copyAllSingleBtn.textContent = orig; }, 2000);
  });

  const statusEl = document.getElementById('dbr-status');
  const scrapeBtn = document.getElementById('dbr-scrape');

  // Load whatever was last cached (if anything) so re-opening the panel
  // doesn't start blank while a fresh scrape runs.
  try {
    _dbrData = await quicksight.getCache();
    if (_dbrData && _dbrData.scrapedAt) {
      if (statusEl) statusEl.textContent = 'Last scraped ' + new Date(_dbrData.scrapedAt).toLocaleString();
    }
  } catch (e) { /* no cache yet — fine */ }
  try { _dbrDspData = await quicksight.getCacheDsp(); } catch (e) { /* no cache yet — fine */ }
  await _dbrRenderTables();

  const dspScrapeBtn = document.getElementById('dbr-scrape-dsp');
  const dspStatusEl = document.getElementById('dbr-status-dsp');
  if (dspScrapeBtn) dspScrapeBtn.addEventListener('click', async () => {
    dspScrapeBtn.disabled = true;
    const dspOrig = dspScrapeBtn.textContent;
    dspScrapeBtn.textContent = '⏳ Opening DSP…';
    if (dspStatusEl) dspStatusEl.textContent = 'Opening DSP dashboard — this can take up to a minute…';
    try {
      const captured = await quicksight.captureDsp();
      if (!captured || !captured.ok) {
        throw new Error((captured && captured.error) || 'Could not load the DSP dashboard — see logs.');
      }
      dspScrapeBtn.textContent = '⏳ Reading table with AI…';
      if (dspStatusEl) dspStatusEl.textContent = 'Page loaded — asking AI to read the SCAC table…';
      const parsed = await _dbrAskAi(_dbrDspPrompt(captured.text));
      _dbrDspData = { ok: true, scac: _dbrClampToBottom10(Array.isArray(parsed.scac) ? parsed.scac : []), scrapedAt: captured.scrapedAt || new Date().toISOString() };
      if (dspStatusEl) dspStatusEl.textContent = 'Scraped ' + new Date(_dbrDspData.scrapedAt).toLocaleString() + ' — ' + _dbrDspData.scac.length + ' SCAC rows.';
      try { await quicksight.saveParsed({ kind: 'dsp', data: _dbrDspData }); } catch (e) { /* cache save failure is non-fatal */ }
    } catch (e) {
      if (dspStatusEl) dspStatusEl.textContent = 'Scrape failed: ' + e.message;
      _dbrDspData = { ok: false, error: e.message, scac: [] };
    } finally {
      await _dbrRenderTables();
      dspScrapeBtn.disabled = false;
      dspScrapeBtn.textContent = dspOrig;
      // AI-review "mine" DSP rows in the background, re-rendering as each resolves.
      if (_dbrDspData && _dbrDspData.ok) {
        const { mySites, myCarriers } = await _loadMySitesAndCarriers();
        if (dspStatusEl) dspStatusEl.textContent += ' — reviewing your rows…';
        await _dbrRunReviewsForSection(_dbrDspData.scac || [], 'scac', mySites, myCarriers, () => _dbrRenderTables());
        if (dspStatusEl) dspStatusEl.textContent = dspStatusEl.textContent.replace(' — reviewing your rows…', ' — review complete.');
      }
    }
  });

  scrapeBtn.addEventListener('click', async () => {
    scrapeBtn.disabled = true;
    const orig = scrapeBtn.textContent;
    scrapeBtn.textContent = '⏳ Opening AFP…';
    if (statusEl) statusEl.textContent = 'Opening AFP dashboard — this can take up to a minute…';
    try {
      const captured = await quicksight.captureAfp();
      if (!captured || !captured.ok) {
        throw new Error((captured && captured.error) || 'Could not load the AFP dashboard — see logs.');
      }
      scrapeBtn.textContent = '⏳ Reading tables with AI…';
      if (statusEl) statusEl.textContent = 'Page loaded — asking AI to read the Domicile/SCAC tables…';
      const parsed = await _dbrAskAi(_dbrAfpPrompt(captured.text));
      _dbrData = {
        ok: true,
        domicile: Array.isArray(parsed.domicile) ? parsed.domicile : [],
        scac: Array.isArray(parsed.scac) ? parsed.scac : [],
        scrapedAt: captured.scrapedAt || new Date().toISOString(),
      };
      if (statusEl) statusEl.textContent = 'Scraped ' + new Date(_dbrData.scrapedAt).toLocaleString() +
        ' — ' + _dbrData.domicile.length + ' domicile rows, ' + _dbrData.scac.length + ' SCAC rows.';
      try { await quicksight.saveParsed({ data: _dbrData }); } catch (e) { /* cache save failure is non-fatal */ }
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Scrape failed: ' + e.message;
      _dbrData = { ok: false, error: e.message, domicile: [], scac: [] };
    } finally {
      await _dbrRenderTables();
      scrapeBtn.disabled = false;
      scrapeBtn.textContent = orig;
      // AI-review "mine" AFP rows (both Domicile and SCAC sections) in the
      // background, re-rendering as each resolves.
      if (_dbrData && _dbrData.ok) {
        const { mySites, myCarriers } = await _loadMySitesAndCarriers();
        if (statusEl) statusEl.textContent += ' — reviewing your rows…';
        await _dbrRunReviewsForSection(_dbrData.domicile || [], 'domicile', mySites, myCarriers, () => _dbrRenderTables());
        await _dbrRunReviewsForSection(_dbrData.scac || [], 'scac', mySites, myCarriers, () => _dbrRenderTables());
        if (statusEl) statusEl.textContent = statusEl.textContent.replace(' — reviewing your rows…', ' — review complete.');
      }
    }
  });
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

  // Scope controls: type domicile and/or operator tokens; each becomes its own
  // scoped group. "Scope" applies, "Clear" returns to the full view.
  const scopeInput = _el.querySelector('#dc-scope');
  const applyScope = () => {
    const toks = _parseScope(scopeInput ? scopeInput.value : '');
    _scopeTokens = toks;
    _update(state.slice('fleet').rows || []);
    if (toks.length) {
      const found = toks.length - _scopeNotFound.length;
      bus.emit('ui:toast', { type: _scopeNotFound.length ? 'warning' : 'success',
        message: 'Scoped to ' + found + '/' + toks.length + ' token(s)' +
          (_scopeNotFound.length ? ' — not found: ' + _scopeNotFound.join(', ') : ''), duration: 3000 });
    }
  };
  if (scopeInput) scopeInput.addEventListener('keydown', (ev) => {
    // Ctrl/Cmd+Enter applies (plain Enter inserts a newline in the textarea).
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); applyScope(); }
  });
  const scopeApplyBtn = _el.querySelector('#dc-scope-apply');
  if (scopeApplyBtn) scopeApplyBtn.addEventListener('click', applyScope);
  const scopeClearBtn = _el.querySelector('#dc-scope-clear');
  if (scopeClearBtn) scopeClearBtn.addEventListener('click', () => {
    _scopeTokens = [];
    _scopeNotFound = [];
    if (scopeInput) scopeInput.value = '';
    _update(state.slice('fleet').rows || []);
  });

  _el.querySelector('#dc-dbr-data').addEventListener('click', () => { _openDbrPanel(); });

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

// Apply the active scope to a row set: when scope tokens are set, keep only
// rows whose domicile OR operator matches a token. Same scope box drives both
// the Daily Call tables and the WBR, so "ABE40, TUZR" narrows the WBR to rows
// in ABE40 or operated by TUZR. No scope -> all rows.
function _scopeRows(rows) {
  if (!_scopeTokens.length) return rows || [];
  const set = new Set(_scopeTokens);
  return (rows || []).filter(r => set.has(_normTok(r.domicileSite)) || set.has(_normTok(r.operator)));
}

// Classify a vendor as an OEM/dealer (unit physically AT a dealer) vs an
// onsite/mobile vendor (repaired at the Amazon site). Best-effort from the
// vendor name; the AI can refine from the timeline, and the user validates.
const _OEM_VENDOR_RE = /volvo|kenworth|peterbilt|paccar|freightliner|daimler|international|mack|cei|dealer|asist/i;
const _ONSITE_VENDOR_RE = /amerit|\bta\b|travel\s*centers|cox|velociti|fleetnet|mobile|onsite|road\s*ready/i;
function _wbrLocationClass(vendor) {
  const v = String(vendor || '').trim();
  if (!v || v === '--' || /unassigned/i.test(v)) return 'unassigned';
  if (_OEM_VENDOR_RE.test(v)) return 'oem';
  if (_ONSITE_VENDOR_RE.test(v)) return 'onsite';
  return 'other';
}

// Deterministic hard numbers for a site's down units — the "red" required
// metrics. Computed in CODE (not guessed by AI) so counts are accurate; the AI
// then writes the narrative around these verified numbers and the user
// validates. Returns a compact text block to inject into the bridge prompt.
function _wbrStats(units) {
  const down = units.length;
  const byFuel = {};
  const byVendor = {};
  let onsite = 0, oem = 0, unassigned = 0, otherLoc = 0;
  const pmUnits = [];
  for (const u of units) {
    const fuel = (u.fuelType || 'Unknown').trim() || 'Unknown';
    byFuel[fuel] = (byFuel[fuel] || 0) + 1;
    const v = (u.vendor && u.vendor.trim() && u.vendor !== '--') ? u.vendor.trim() : 'Unassigned';
    byVendor[v] = (byVendor[v] || 0) + 1;
    const loc = _wbrLocationClass(u.vendor);
    if (loc === 'oem') oem++;
    else if (loc === 'onsite') onsite++;
    else if (loc === 'unassigned') unassigned++;
    else otherLoc++;
    if (/\bpm\b|prevent? ?maintenance|inspection|pm-?[abx]/i.test((u.lifecycleReason || '') + ' ' + (u.issueDetails || ''))) {
      pmUnits.push(u.equipmentId);
    }
  }
  const fuelStr = Object.entries(byFuel).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ');
  const vendorStr = Object.entries(byVendor).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join(', ');
  return [
    `VERIFIED COUNTS (use these EXACT numbers — do not recount):`,
    `- Assets down: ${down}`,
    `- Down by fuel type: ${fuelStr || 'n/a'}`,
    `- Location split (best-effort by vendor): onsite/mobile ${onsite}, at OEM/dealer ${oem}` +
      (unassigned ? `, unassigned ${unassigned}` : '') + (otherLoc ? `, other/unknown ${otherLoc}` : ''),
    `- Units per vendor/OEM: ${vendorStr || 'n/a'}`,
    `- Units flagged PM/inspection-related: ${pmUnits.length}${pmUnits.length ? ' (' + pmUnits.slice(0, 20).join(', ') + ')' : ''}`,
  ].join('\n');
}

function _getWBRSites(rows) {
  const siteMap = {};
  _scopeRows(rows).forEach(r => {
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
      <th style="min-width:70px;white-space:nowrap;">Copy</th>
    </tr></thead><tbody>`;

  sites.forEach(s => {
    const bridge = _wbrGet(s.key, 'bridge');
    const actions = _wbrGet(s.key, 'actions');
    html += `<tr>
      <td style="font-weight:700;font-size:10px;white-space:nowrap;vertical-align:top;">${_safe(s.key)}<br><span style="font-weight:400;color:var(--mut);font-size:9px;">${s.units.length} down</span></td>
      <td><textarea class="dc-wbr-cell" data-wbr-site="${_safe(s.key)}" data-wbr-field="bridge" rows="4" style="width:100%;font-size:10px;background:var(--el);border:1px solid var(--bdr);border-radius:4px;padding:6px;color:var(--txt);resize:vertical;font-family:inherit;">${_safe(bridge)}</textarea></td>
      <td><textarea class="dc-wbr-cell" data-wbr-site="${_safe(s.key)}" data-wbr-field="actions" rows="4" style="width:100%;font-size:10px;background:var(--el);border:1px solid var(--bdr);border-radius:4px;padding:6px;color:var(--txt);resize:vertical;font-family:inherit;">${_safe(actions)}</textarea></td>
      <td style="vertical-align:top;"><button class="dc-wbr-copy-site detail-panel__btn detail-panel__btn--secondary" data-wbr-site="${_safe(s.key)}" title="Copy this site's Bridge + Actions — pastes into both columns" style="font-size:10px;white-space:nowrap;">📋 Copy row</button></td>
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

  // Per-site copy: Bridge + Actions as two tab-separated cells for pasting.
  el.querySelectorAll('.dc-wbr-copy-site').forEach(btn => {
    btn.addEventListener('click', () => {
      _copyWBRSite(btn.dataset.wbrSite);
      const orig = btn.textContent;
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.textContent = orig; }, 1500);
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
        const tl = (u.repairTimeline || '').split('\n').filter(Boolean).slice(-3).join(' | ');
        const loc = _wbrLocationClass(u.vendor);
        const locLabel = loc === 'oem' ? 'AT-OEM/DEALER' : loc === 'onsite' ? 'ONSITE/MOBILE' : loc === 'unassigned' ? 'UNASSIGNED' : 'LOC-UNKNOWN';
        return `${u.equipmentId}: fuel=${u.fuelType || '?'}, vendor=${u.vendor || 'none'} [${locLabel}], down=${days}, reason=${u.lifecycleReason || '?'}, issue=${(u.issueDetails || u.issueSummary || '').slice(0, 120)}, recent timeline: ${tl || 'none'}`;
      }).join('\n');

      const stats = _wbrStats(s.units);

      const prompt = `You are a fleet operations FAS writing a Weekly Bridge Report (WBR) for site ${s.key}.
Write TWO fields — a Field Level Bridge (situation summary) and FAS Field Actions (what you're doing about it).

${stats}

The Field Level Bridge MUST be formatted as bullet points — ONE bullet per required item below, in THIS EXACT order, each starting with "• " and the bold label shown. Use the VERIFIED COUNTS above for every number — do NOT recount or estimate. This bullet layout is required so it copy-pastes cleanly.

FORMAT THE BRIDGE EXACTLY LIKE THIS (fill in the values):
• Assets Down: <verified total>
• Down by Fuel Type: <e.g. 21 CNG, 13 Diesel>
• Onsite/Mobile vs OEM/Dealer: <onsite count> onsite/mobile, <oem count> at OEM/dealer
• Units per OEM/Vendor: <Volvo: X, Kenworth: Y, Peterbilt: Z, ...>
• Estimate Delays (Amazon vs Vendor): <for units stuck on estimates, state whether AMAZON or the VENDOR is causing it — infer ONLY from timeline; if not stated write "cause not documented — verify">
• OOS Units & ETC: <list each OOS unit with ETC; if no ETC in timeline write "unit ####: no ETC — pending">
• Overdue PMs: <how many, how many days past due if timeline states it, and whether AMAZON or the PARTNER is root cause; if not in data write "days/root cause not documented — verify">
• Prior-Week / T6W: Prior-week / T6W comparison not available from tool data — enter manually.

Keep each bullet on its own line. Put multiple units within a bullet on the same line separated by "; " (do not add sub-bullets).

RULES:
- Ground EVERY number in the VERIFIED COUNTS block. The narrative (who caused a delay, ETCs, PM days-past-due) comes ONLY from the per-unit timelines below.
- Do NOT invent or infer beyond what the timelines say. Where the data is missing, explicitly flag it as "not documented — verify" rather than guessing. The FAS will validate before submitting.
- HISTORICAL NOTE: this tool has only current-week data — it does NOT store prior-week or T6W snapshots. NEVER fabricate last-week or T6W numbers; use the fixed Prior-Week / T6W bullet text shown above.
- Be specific: include unit IDs, vendor names, days down, key blockers, ETCs.
- Actions: what SPECIFIC actions you took or are taking TODAY. Write like you're reporting to leadership what you personally did this morning.
  * Name who you contacted (dealer name, vendor FM name, carrier, tech)
  * Say what you specifically asked for or did; reference unit IDs when unit-specific
  * Include outcomes if you have them ("estimate approved", "ETC confirmed", "parts arriving today")
  * Use action verbs: Contacted, Escalated, Reached out to, Spoke with, Confirmed, Submitted, Created WO, Scheduled tow, Pushed for, Coordinating

  GOOD ACTION EXAMPLES:
  - "Contacted Cox FM, tech to finish lift gate PMs today and getting started on PM-Bs"
  - "Reached out to Kenworth dealer for progress updates on 521073 (27 days, estimate approved 8/10)"
  - "Escalated pending estimates (2) to HVE team in AAP"
  - "Submitted vendor coaching for Amerit on unit 59008 due to SLA breach; Asana task created"

- Write like a professional fleet manager in 1st person. Direct and concise.

SITE: ${s.key} (${s.units.length} units currently down)
UNIT DATA:
${unitLines}

RESPOND WITH JSON ONLY:
{"bridge": "the bulleted field level bridge, each required item on its own • line in the exact order shown", "actions": "your FAS field actions text"}`;

      // Retry on timeout/transient failure for THIS site (shared helper: 2
      // retries, short backoff), so one flaky site recovers without redoing all.
      let res = null;
      try {
        res = await _askAIWithRetry(prompt, {
          label: s.key,
          onStatus: (msg) => { if (progressCb) progressCb(done, sites.length, msg); },
        });
      } catch (retryErr) {
        console.warn('[WBR] AI failed for', s.key, 'after retries:', retryErr.message);
      }
      const raw = res && res.text ? res.text : (typeof res === 'string' ? res : '');
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

// Quote a value for a spreadsheet TSV cell. A cell containing a newline, tab,
// or double-quote MUST be wrapped in double-quotes (and inner quotes doubled)
// or Excel/Sheets will split it across rows/columns and misalign everything.
// This is what makes a multi-line Bridge/Actions paste land in ONE cell.
function _tsvCell(v) {
  const s = String(v == null ? '' : v);
  if (/[\t\n"\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Copy to clipboard with a textarea fallback.
function _copyToClipboard(text) {
  try { navigator.clipboard.writeText(text); return; } catch (e) { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (_) {}
  document.body.removeChild(ta);
}

// Read a site's CURRENT Bridge/Actions from the live textareas if present
// (so unsaved edits are copied too), falling back to the saved store.
function _wbrLive(siteKey, field) {
  if (_el) {
    const ta = _el.querySelector('.dc-wbr-cell[data-wbr-site="' + (window.CSS && CSS.escape ? CSS.escape(siteKey) : siteKey) + '"][data-wbr-field="' + field + '"]');
    if (ta) return ta.value;
  }
  return _wbrGet(siteKey, field);
}

// Copy ONE site's Bridge + Actions as two tab-separated, spreadsheet-safe
// cells (Bridge<TAB>Actions). Paste drops them straight into the two columns
// for that site's row, preserving the multi-line text within each cell.
function _copyWBRSite(siteKey) {
  const bridge  = _wbrLive(siteKey, 'bridge');
  const actions = _wbrLive(siteKey, 'actions');
  _copyToClipboard(_tsvCell(bridge) + '\t' + _tsvCell(actions));
}

function _copyWBR() {
  const rows = state.slice('fleet').rows || [];
  const sites = _getWBRSites(rows);
  // Multi-line cells are now properly QUOTED (not collapsed to spaces) so each
  // Bridge/Actions block pastes into a single cell in the correct column.
  const lines = sites.map(s =>
    [_tsvCell(s.key), _tsvCell(_wbrLive(s.key, 'bridge')), _tsvCell(_wbrLive(s.key, 'actions'))].join('\t'));
  const header = ['Site', 'Field Level Bridge', 'FAS Field Actions'].join('\t');
  _copyToClipboard(header + '\n' + lines.join('\n'));
}
