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

// Source-feed tidy: collapses runs of spaces/tabs, trims each line and caps
// blank-line runs, but KEEPS the line structure (unlike _stripCosts, which
// flattens newlines and so would make line-boundary trimming impossible).
export function _tidySource(text) {
  if (!text) return '';
  return String(text)
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Budgets ─────────────────────────────────────────────────────────────────
// The binding ceiling is the Claude lane (src/orcha/relay.js
// CLAUDE_PROMPT_MAX_CHARS = 60,000), which head-keeps 60k and would cut the
// trailing gold example + RAW JSON instruction; ai:ask (src/ipc/ai.js) rejects
// over 64,000. So the whole Long Dwell prompt is kept <= 59,500. The SOURCE
// DATA block gets whatever is left after the fixed text (KB + instructions),
// clamped to [6,000, 24,000].
export const LD_PROMPT_MAX = 59500;
export const LD_SOURCE_MAX = 24000;
export const LD_SOURCE_MIN = 6000;

// settings.ai.fullContext (default ON). false -> legacy source sizes (still
// newest-first). Refreshed before each fill / Fill All via
// refreshAiFillSettings(). The FLEET_AI_FULL_CONTEXT env override
// (src/orcha/source-budget.js) is main-process only: the renderer cannot read
// process env, so Long Dwell follows the setting alone.
let _fullContext = true;
export async function refreshAiFillSettings() {
  try {
    const { settings } = await import('./bridge.js');
    const all = settings && settings.getAll ? await settings.getAll() : null;
    _fullContext = !(all && all.ai && all.ai.fullContext === false);
  } catch (_) { /* best-effort — keep the last known value */ }
  return _fullContext;
}

// ── Newest-first trimming (ESM twin of src/orcha/source-budget.js) ──────────
// The renderer bundle cannot require main-process CJS, so the same algorithm,
// regexes and marker text live here too. tests/ld-source-context.test.js pins
// both copies to identical output — change them together.
const NUM_LINE_DATE_RE = /^\s*(?:\[|- )?\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?!\d)/;
const MON_DATE_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),\s+(\d{4})\b/i;
const _MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function _lineDate(line) {
  const s = String(line || '');
  let m = s.match(NUM_LINE_DATE_RE);
  if (m) {
    const mo = parseInt(m[1], 10), d = parseInt(m[2], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      let y = m[3] ? parseInt(m[3], 10) : null;
      if (y != null && y < 100) y += 2000;
      return { y, m: mo, d };
    }
  }
  m = s.match(MON_DATE_RE);
  if (m) return { y: parseInt(m[3], 10), m: _MONTHS[m[1].slice(0, 3).toLowerCase()], d: parseInt(m[2], 10) };
  return null;
}

// 'desc' when the last parseable date is older than the first, else 'asc'.
export function detectOrder(lines) {
  const arr = Array.isArray(lines) ? lines : String(lines || '').split('\n');
  let first = null, last = null;
  for (const l of arr) { const dt = _lineDate(l); if (dt) { if (!first) first = dt; last = dt; } }
  if (!first || first === last) return 'asc';
  if (first.y != null && last.y != null) {
    const a = first.y * 10000 + first.m * 100 + first.d;
    const b = last.y * 10000 + last.m * 100 + last.d;
    return b < a ? 'desc' : 'asc';
  }
  // Month/day only: a gap over ~6 months is read as a year wrap (12/20 -> 01/05).
  const diff = (last.m * 31 + last.d) - (first.m * 31 + first.d);
  const wrap = Math.abs(diff) > 6 * 31;
  const lastIsOlder = wrap ? diff > 0 : diff < 0;
  return lastIsOlder ? 'desc' : 'asc';
}

export const TRIM_MARKER_RE = /^\[… \d+ older lines trimmed to fit the AI budget …\]$/m;
const _marker = (n) => `[… ${n} older lines trimmed to fit the AI budget …]`;

// Cut a string to at most n UTF-16 units without splitting a surrogate pair.
function _safeCut(s, n) {
  if (n <= 0) return '';
  if (s.length <= n) return s;
  let k = n;
  const c = s.charCodeAt(k - 1);
  if (c >= 0xd800 && c <= 0xdbff) k--;
  return s.slice(0, k);
}

// keepNewest(text, budget, { anchor }) -> { text, dropped, droppedLines }
// Keeps whole lines: the newest lines that fit, plus up to `anchor` chars of
// the oldest lines, with a marker line at the gap. droppedLines are newest-first.
export function keepNewest(text, budget, { anchor = 0 } = {}) {
  const src = String(text == null ? '' : text);
  const max = Math.max(0, Math.floor(Number(budget) || 0));
  if (src.length <= max) return { text: src, dropped: 0, droppedLines: [] };
  const lines = src.split('\n');
  const order = detectOrder(lines);
  const anchorMax = Math.max(0, Math.min(Math.floor(Number(anchor) || 0), Math.floor(max / 2)));
  const markerLen = _marker(lines.length).length + 1; // worst-case digits + '\n'

  // Oldest side = head for asc, tail for desc. Newest side is the opposite.
  const oldestIdx = (i) => (order === 'asc' ? i : lines.length - 1 - i);
  const newestIdx = (i) => (order === 'asc' ? lines.length - 1 - i : i);

  let anchorCount = 0, anchorUsed = 0;
  while (anchorCount < lines.length) {
    const len = lines[oldestIdx(anchorCount)].length + 1;
    if (anchorUsed + len > anchorMax) break;
    anchorUsed += len; anchorCount++;
  }
  const room = max - anchorUsed - markerLen;
  let newestCount = 0, used = 0;
  while (newestCount + anchorCount < lines.length) {
    const len = lines[newestIdx(newestCount)].length + 1;
    if (used + len > room + 1) break; // the final line carries no trailing '\n'
    used += len; newestCount++;
  }
  let cutLine = null;
  if (newestCount === 0 && anchorCount < lines.length) {
    // The single newest line alone exceeds the room: keep its leading part.
    cutLine = _safeCut(lines[newestIdx(0)], Math.max(0, room));
    newestCount = 1;
  }

  const anchorLines = [], newestLines = [], droppedLines = [];
  for (let i = 0; i < anchorCount; i++) anchorLines.push(lines[oldestIdx(i)]);
  for (let i = 0; i < newestCount; i++) newestLines.push(i === 0 && cutLine != null ? cutLine : lines[newestIdx(i)]);
  for (let i = newestCount; i < lines.length - anchorCount; i++) droppedLines.push(lines[newestIdx(i)]);
  const dropped = droppedLines.length;

  let out;
  if (order === 'asc') {
    out = anchorLines.concat(dropped ? [_marker(dropped)] : [], newestLines.slice().reverse());
  } else {
    out = newestLines.concat(dropped ? [_marker(dropped)] : [], anchorLines.slice().reverse());
  }
  return { text: out.join('\n'), dropped, droppedLines };
}

// ── Prompt-row helpers ──────────────────────────────────────────────────────
// Fill empty row fields from the flat relay cache (relay.getUnitCache). Never
// overwrites a non-empty row value. Returns a shallow copy.
const _CACHE_BACKFILL_KEYS = ['fullConversation', 'asistNotes', 'needBy', 'created', 'serviceState', 'subState', 'vendorWorkOrderId'];
export function withRelayCacheBackfill(row, cache) {
  if (!cache) return row;
  const out = Object.assign({}, row);
  for (const k of _CACHE_BACKFILL_KEYS) {
    const cur = out[k];
    const empty = cur == null || String(cur).trim() === '';
    if (empty && typeof cache[k] === 'string' && cache[k].trim() !== '') out[k] = cache[k];
  }
  return out;
}

// Row object the shared prompt expects for an imported-CSV Long Dwell row:
// the CSV columns, enriched from the (freshened) live fleet row. Moved here
// from views/longdwell-csv.js _promptRowFor so it can be unit-tested.
const _CSV_LIVE_KEYS = ['repairTimeline', 'savedNotes', 'notes', 'fullConversation',
  'lastConversation', 'conversation', 'issueDetails', 'issueSummary',
  'canonicalStatus', 'canonicalStale', 'canonicalWaitingOn',
  'canonicalSituation', 'canonicalNextStep', 'vendor',
  'domicileSite', 'operator', 'lifecycleReason',
  // Extra facts for the UNIT FACTS / CANONICAL / feed sections.
  'asistNotes', 'needBy', 'created', 'serviceState', 'subState', 'vendorWorkOrderId',
  'pmB', 'pmX', 'dot', 'canonicalPhase', 'canonicalLocation',
  'canonicalStatusChangeReason', 'canonicalUpdatedAt', '_secondaryWRs', '_plannedWRData'];
export function buildCsvPromptRow(csv, live) {
  const c = csv || {};
  const assetId = String(c['Asset ID'] || '').trim();
  // Start from the imported CSV columns (always present).
  const base = {
    equipmentId:     assetId,
    vendor:          c['RG Vendor Assigned'] || '',
    domicileSite:    c['Site'] || '',
    operator:        c['SCAC'] || '',
    lifecycleReason: c['Lifecycle State Reason'] || '',
    issueDetails:    [c['Level 1'], c['Level 2']].filter(Boolean).join(' / '),
    issueSummary:    c['Vendor Delay Reason'] || '',
    // CSV-only facts, kept even when the live row overwrites issueSummary.
    csvDaysDown:          c['Days Down'] || '',
    csvExpectedEtc:       c['Expected ETC'] || '',
    csvVendorDelayReason: c['Vendor Delay Reason'] || '',
  };
  // Enrich from the live fleet row for timeline / notes / conversation /
  // canonical state — the fields that make the summary rich.
  if (live) {
    for (const k of _CSV_LIVE_KEYS) {
      const v = live[k];
      if (v == null) continue;
      if (typeof v === 'object') {
        if (Array.isArray(v) ? v.length : true) base[k] = v; // by reference
      } else if (String(v).trim() !== '') {
        base[k] = v;
      }
    }
  }
  return base;
}

// ── SOURCE DATA assembly ────────────────────────────────────────────────────
const _CANON_HEADER = 'CANONICAL STATE (reconciled summary — if a NEWER dated line below conflicts with it, the newer line wins):';
const _KEY_HEADER = 'KEY LINES FROM TRIMMED HISTORY (newest first):';
const _KEY_LINE_RE = /\$\s?\d|estimate|\bETC\b|\bETA\b|\bparts?\b|back ?order|\bSIM\b|diag|root cause|\bcause\b|approv|reject/i;
const _FEED_SHARES = { conversation: 0.45, timeline: 0.30, offsite: 0.15, secondary: 0.10 };
const _FEED_ORDER = ['conversation', 'timeline', 'offsite', 'secondary'];

function _factVal(v) {
  const s = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
  return s && s !== '--' ? s : '';
}
function _fromConversation(text) {
  let c = String(text || '');
  const i = c.indexOf('Conversation');
  if (i > 0) c = c.substring(i);
  return c;
}
// All lines of a feed, newest first (used when a feed gets no room at all).
// Each undated continuation line carries its parent entry's date (see _datedLines).
function _linesNewestFirst(body) {
  const lines = _datedLines(String(body || '').split('\n'));
  return detectOrder(String(body || '').split('\n')) === 'asc' ? lines.reverse() : lines;
}

// Date text of a line that STARTS a dated entry ("10/13/2026 ...", "[10/13] ...",
// "- 10/13 ...", "Oct 13, 2026 ..."), copied from the line itself; else ''.
function _entryDate(line) {
  const s = String(line || '');
  const m = s.match(NUM_LINE_DATE_RE);
  if (m) {
    const mo = parseInt(m[1], 10), d = parseInt(m[2], 10);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return m[1] + '/' + m[2] + (m[3] ? '/' + m[3] : '');
  }
  const n = s.match(MON_DATE_RE);
  if (n && n.index <= 2) return n[0];
  return '';
}

// Physical-order lines -> same lines, where an undated continuation line of a
// multi-line entry is prefixed "[from <parent date>] " (the date text is copied
// from the nearest dated line above it). Dated / pre-first-date lines unchanged.
function _datedLines(lines) {
  let cur = '';
  return lines.map((l) => {
    const d = _entryDate(l);
    if (d) { cur = d; return l; }
    return cur && String(l).trim() ? '[from ' + cur + '] ' + String(l).trim() : l;
  });
}

// keepNewest's droppedLines (newest first) with continuation lines dated as in
// _datedLines. The dropped lines are one contiguous physical block; its start
// is found from the kept anchor size. Falls back to the plain lines if the
// block cannot be located exactly.
function _datedDropped(body, k) {
  if (!k.dropped) return k.droppedLines;
  const lines = String(body).split('\n');
  const out = k.text.split('\n');
  const mi = out.indexOf(_marker(k.dropped));
  if (mi < 0) return k.droppedLines;
  const asc = detectOrder(lines) === 'asc';
  const anchorCount = asc ? mi : out.length - mi - 1;
  const start = asc ? anchorCount : lines.length - anchorCount - k.dropped;
  const idxOf = (j) => (asc ? start + k.dropped - 1 - j : start + j);
  for (let j = 0; j < k.dropped; j++) if (lines[idxOf(j)] !== k.droppedLines[j]) return k.droppedLines;
  const dated = _datedLines(lines);
  return k.droppedLines.map((_, j) => dated[idxOf(j)]);
}

// Render one plain feed into at most `alloc` chars (header + '\n' + body + the
// '\n\n' separator). Returns { text, dropped, droppedLines }.
function _renderFeed(f, alloc) {
  const room = alloc - f.header.length - 3;
  if (room < 1) {
    const all = _linesNewestFirst(f.body);
    return { text: '', dropped: all.length, droppedLines: all };
  }
  const k = keepNewest(f.body, room, { anchor: f.anchor });
  return { text: f.header + '\n' + k.text, dropped: k.dropped, droppedLines: _datedDropped(f.body, k) };
}

// Render the "Other work orders" feed: each WO gets an equal share of what is
// left, so a short WO's unused room flows to the next one.
function _renderSecondary(f, alloc) {
  let remaining = alloc - f.header.length - 3;
  const out = [], droppedLines = [];
  let dropped = 0;
  f.items.forEach((it, i) => {
    const sep = out.length ? 2 : 0;
    const share = Math.floor(remaining / (f.items.length - i));
    const room = share - it.label.length - 1 - sep;
    if (room < 1) {
      const all = _linesNewestFirst(it.body);
      dropped += all.length; droppedLines.push(...all);
      return;
    }
    const k = keepNewest(it.body, room);
    const t = it.label + '\n' + k.text;
    out.push(t);
    remaining -= t.length + sep;
    dropped += k.dropped; droppedLines.push(..._datedDropped(it.body, k));
  });
  return { text: out.length ? f.header + '\n' + out.join('\n\n') : '', dropped, droppedLines };
}

// sourceContextWithMeta(row, { budget, fullContext }) -> { text, meta }
// Builds the SOURCE DATA block. Fixed fact sections come first; then the long
// feeds (conversation / timeline / offsite notes / other WOs), whole when they
// fit, otherwise trimmed newest-first at line boundaries with a visible marker
// and a KEY LINES extract of estimate/ETC/parts lines from the trimmed part.
// Every emitted line is a header/label or text copied from a row field.
export function sourceContextWithMeta(row, opts = {}) {
  const r = row || {};
  const budget = opts.budget != null ? opts.budget : LD_SOURCE_MAX;
  const full = opts.fullContext != null ? !!opts.fullContext : _fullContext;
  const lim = full ? 600 : 300;
  const trimmed = { conversation: 0, timeline: 0, offsite: 0, secondary: 0 };
  const fixed = [];

  // (1) UNIT FACTS — short factual fields (CSV + WO + PM/DOT).
  const facts = [
    ['Days Down', r.csvDaysDown], ['Expected ETC', r.csvExpectedEtc],
    ['Vendor delay reason', r.csvVendorDelayReason], ['WO created', r.created],
    ['Need by', r.needBy], ['Service state', r.serviceState], ['Sub-state', r.subState],
    ['Vendor WO #', r.vendorWorkOrderId], ['PM-B', r.pmB], ['PM-X', r.pmX], ['DOT', r.dot],
  ].map(([k, v]) => { const s = _factVal(v); return s ? k + ': ' + s : ''; }).filter(Boolean);
  if (facts.length) fixed.push(_safeCut('UNIT FACTS: ' + facts.join(' | '), 800));

  // (2) CANONICAL STATE (the reconciled summary, mirrored onto the row). It can
  // be stale or empty, so newer dated source lines win over it.
  if (r.canonicalStatus) {
    const cs = [];
    cs.push('Canonical status: ' + String(r.canonicalStatus).replace(/_/g, ' ') + (r.canonicalStale ? ' (STALE — no recent update)' : ''));
    if (r.canonicalWaitingOn) cs.push('waiting on: ' + r.canonicalWaitingOn);
    if (r.canonicalSituation) cs.push('situation: ' + _stripCosts(String(r.canonicalSituation)).slice(0, lim));
    if (r.canonicalNextStep)  cs.push('reconciled next step: ' + _stripCosts(String(r.canonicalNextStep)).slice(0, lim));
    if (full) {
      if (r.canonicalStatusChangeReason) cs.push('status change reason: ' + _stripCosts(String(r.canonicalStatusChangeReason)).slice(0, 400));
      if (r.canonicalPhase)     cs.push('phase: ' + _stripCosts(String(r.canonicalPhase)).slice(0, 100));
      if (r.canonicalLocation)  cs.push('location: ' + _stripCosts(String(r.canonicalLocation)).slice(0, 200));
      if (r.canonicalUpdatedAt) cs.push('updated: ' + _stripCosts(String(r.canonicalUpdatedAt)).slice(0, 60));
    }
    fixed.push(_CANON_HEADER + '\n' + cs.join('\n'));
  }

  // (3) Issue / summary so far.
  if (r.issueDetails) fixed.push('Issue: ' + _stripCosts(String(r.issueDetails)).slice(0, lim));
  if (r.issueSummary) fixed.push('Summary so far: ' + _stripCosts(String(r.issueSummary)).slice(0, lim));

  // (4) Saved notes: always with full context; legacy = only without a timeline.
  if (r.savedNotes) {
    if (full) fixed.push('Notes: ' + _stripCosts(String(r.savedNotes)).slice(0, 1000));
    else if (!r.repairTimeline) fixed.push('Notes: ' + _stripCosts(String(r.savedNotes)).slice(0, 500));
  }

  // (5) Feeds.
  const conv = _tidySource(_fromConversation(r.fullConversation || r.lastConversation || r.conversation || ''));
  const timeline = _tidySource(r.repairTimeline);
  const feedTexts = [];
  let keyText = '';

  if (!full) {
    // Legacy sizes, newest-first.
    if (conv) {
      const k = keepNewest(conv, 1500, { anchor: 300 });
      feedTexts.push('Vendor/WO conversation:\n' + k.text); trimmed.conversation = k.dropped;
    }
    if (timeline) {
      const k = keepNewest(timeline, 1200);
      feedTexts.push('Repair timeline:\n' + k.text); trimmed.timeline = k.dropped;
    }
  } else {
    const feeds = [];
    if (conv) feeds.push({ key: 'conversation', header: 'Vendor/WO conversation:', body: conv, anchor: 600 });
    if (timeline) feeds.push({ key: 'timeline', header: 'Repair timeline:', body: timeline, anchor: 0 });
    const offsite = _tidySource(r.asistNotes);
    if (offsite) feeds.push({ key: 'offsite', header: 'Offsite/dealer notes:', body: offsite, anchor: 0 });
    const wos = [];
    if (r._plannedWRData && typeof r._plannedWRData === 'object') wos.push(r._plannedWRData);
    if (Array.isArray(r._secondaryWRs)) wos.push(...r._secondaryWRs);
    const items = [];
    for (const w of wos) {
      if (items.length >= 3) break;
      const body = w && _tidySource(_fromConversation(w.fullConversation));
      if (!body) continue;
      items.push({ label: '[WO #' + (items.length + 1) + ' ' + (_factVal(w.vendor) || 'vendor unknown') + ']', body });
    }
    if (items.length) {
      const f = { key: 'secondary', header: 'Other work orders:', items, body: '' };
      f.need = f.header.length + 1 + items.reduce((n, it) => n + it.label.length + 1 + it.body.length, 0) + 2 * (items.length - 1) + 2;
      feeds.push(f);
    }
    for (const f of feeds) if (f.need == null) f.need = f.header.length + 1 + f.body.length + 2;

    const fixedLen = fixed.length ? fixed.join('\n\n').length + 2 : 0;
    const R = Math.max(0, budget - fixedLen);
    const totalNeed = feeds.reduce((n, f) => n + f.need, 0);
    let keyBudget = 0;
    const alloc = {};
    if (totalNeed <= R) {
      for (const f of feeds) alloc[f.key] = f.need;
    } else {
      keyBudget = Math.min(2500, Math.floor(0.12 * R));
      const R2 = R - keyBudget;
      let left = R2;
      for (const f of feeds) { alloc[f.key] = Math.min(f.need, Math.floor(_FEED_SHARES[f.key] * R2)); left -= alloc[f.key]; }
      for (const key of _FEED_ORDER) {
        const f = feeds.find((x) => x.key === key);
        if (!f || left <= 0) continue;
        const add = Math.min(f.need - alloc[key], left);
        alloc[key] += add; left -= add;
      }
    }

    const dropped = [];
    for (const key of _FEED_ORDER) {
      const f = feeds.find((x) => x.key === key);
      if (!f) continue;
      const out = key === 'secondary' ? _renderSecondary(f, alloc[key]) : _renderFeed(f, alloc[key]);
      if (out.text) feedTexts.push(out.text);
      trimmed[key] = out.dropped;
      dropped.push(...out.droppedLines);
    }

    // KEY LINES: estimate / $ / ETC / parts / SIM / diag / cause lines from the
    // trimmed part, so a dropped estimate or ETC still reaches the model.
    if (keyBudget > 0 && dropped.length) {
      let room = keyBudget - _KEY_HEADER.length - 3;
      const seen = new Set(), keep = [];
      for (const raw of dropped) {
        const line = String(raw || '').trim();
        if (!line || seen.has(line) || !_KEY_LINE_RE.test(line)) continue;
        const l = _safeCut(line, 400);
        if (l.length + 1 > room) continue;
        seen.add(line); keep.push(l); room -= l.length + 1;
      }
      if (keep.length) keyText = _KEY_HEADER + '\n' + keep.join('\n');
    }
  }

  const parts = fixed.concat(keyText ? [keyText] : [], feedTexts);
  const text = parts.length ? parts.join('\n\n') : '(no repair notes or conversation on file)';
  const totalTrimmed = trimmed.conversation + trimmed.timeline + trimmed.offsite + trimmed.secondary;
  return { text, meta: { budget, length: text.length, trimmed, totalTrimmed } };
}

// SOURCE DATA block as a string (fillFingerprint calls this with one arg).
export function _sourceContextForRow(row, opts = {}) {
  return sourceContextWithMeta(row, opts).text;
}

// Builds the AI-fill prompt for one Long Dwell row. Requests strict JSON so
// parsing is a simple regex + JSON.parse (same defensive pattern
// daily-call.js's _runAI already uses for its own AI calls) rather than the
// looser REPAIR_STATUS:/ISSUE: line-regex format deep-scan.js uses -- JSON
// is a better fit here since there are three independent fields to fill.
//
// buildAIFillPromptWithMeta(row, dd, { knowledge, fullContext }) -> { prompt, meta }
// The SOURCE DATA budget is sized to the real ceiling: the prompt is capped at
// LD_PROMPT_MAX (59,500; under the Claude lane's 60,000 head trim and the
// ai:ask 64,000 reject), and the source gets 59,500 - fixedLen clamped to
// [6,000, 24,000] (~19.8k with the ~27k KB).
// NOTE: if the KB grows past ~40k, the 6k floor can push the prompt over
// 60,000, and the Claude lane would then cut its tail; past ~45k ai:ask
// rejects it. Keep KB growth in check against these two caps.
export function _buildAIFillPrompt(row, dd, opts = {}) {
  return buildAIFillPromptWithMeta(row, dd, opts).prompt;
}

export function buildAIFillPromptWithMeta(row, dd, opts = {}) {
  row = row || {};
  const kb     = opts.knowledge != null ? opts.knowledge : _kbCache;
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
  const head = (
    // FAS KNOWLEDGE BASE (single source of truth for SEV/escalation/ownership).
    // Fetched from main via loadKnowledge(); empty string until loaded (the
    // prompt still works, the SEV section just won't be present that one time).
    // The output contract + 7-bullet summary contract stay up front so they
    // lead the prompt ahead of the ~27k-char KB. (The Aki lane now receives
    // the whole prompt via stdin; it no longer head-keeps ~32k chars.)
    'OUTPUT CONTRACT: return ONLY one raw JSON object {"delayReason": "...", "escalationLevel": "...", "summary": "..."} -- no markdown, no code fences, no commentary before or after it.\n' +
    'The summary value MUST be EXACTLY 7 lines separated by \\n. Each line starts with "\\u2022 " (bullet + space) ' +
    'followed by one of these exact labels, in this exact order: Initial Issue Reported:, Primary Vendor Rejection:, ' +
    'Primary Barrier:, Actions Taken:, Repair Status:, ETC:, Follow-up date:. No preamble, no paragraph, no headings, ' +
    'no blank or extra lines. If a field has no information still emit its line: "N/A" for Primary Vendor Rejection, ' +
    'otherwise "not documented \\u2014 verify". The full field spec and gold examples follow below.\n\n' +
    (kb ? (kb + '\n\n') : '') +
    'You are Orcha, the AI brain for Fleet Operations. This unit is a LONG DWELL unit -- ' +
    'down and unavailable for an extended period -- and needs a leadership-facing status ' +
    'entry filled in for the Long Dwell Units report.\n\n' +
    'TODAY IS: ' + todayStr + '. Use this to compute a concrete follow-up date.\n\n' +
    'UNIT: ' + id + ' | Vendor: ' + vendor + ' | Domicile: ' + dom + ' | Operator: ' + op + ' | Down ' + dd + ' days | Lifecycle reason: ' + reason + '\n\n' +
    'SOURCE DATA:\n'
  );
  const tail = (
    '\n\n' +
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
  const fixedLen = head.length + tail.length;
  const budget = Math.max(LD_SOURCE_MIN, Math.min(LD_SOURCE_MAX, LD_PROMPT_MAX - fixedLen));
  const s = sourceContextWithMeta(row, { budget, fullContext: opts.fullContext });
  return { prompt: head + s.text + tail, meta: s.meta };
}
