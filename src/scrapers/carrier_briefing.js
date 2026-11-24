'use strict';
/**
 * carrier_briefing.js — Daily Carrier Briefing.
 *
 * Once a day, for each operator that has a mapped carrier channel (Operator
 * Channels in Settings), posts a short, AI-WRITTEN snapshot + safety tip to
 * that operator's carrier Slack channel, tagging the operator owner.
 *
 * Design decisions (set by the user):
 *  - Fully settings-configurable: enable toggle, send time + timezone, which
 *    snapshot fields are included, risk threshold, safety-tip on/off. Nothing
 *    is hardcoded for a single operator.
 *  - Block Kit redesign (2026-11-17, user-approved layout): the message is a
 *    deterministic Block Kit layout (carrier_briefing_blocks.js) posted via
 *    slack_send.sendBlocksToChannel; the AI writes only the safety tip. Unit
 *    IDs are plain text (no Relay/AAP links); names, $ and URLs are stripped.
 *    (Historical: the AI used to write the WHOLE message — buildBriefingPrompt
 *    is kept exported but no longer used for sending.)
 *  - Grounding (never invent): fleet units from fleetData; domicile addresses
 *    from the Contact Book (type === 'domicile'); operator->channel/owner from
 *    operatorChannels. If an address/field isn't on file, it is omitted — never
 *    guessed.
 *  - Guardrails mirror the PM-alert carrier fan-out: Slack-friendly emojis, tag
 *    the owner, NO mention of "Z"/"Zila"/"FAS" or any internal requester.
 *  - AI call uses relay.ask (the robust full-chain path) wrapped in the same
 *    2-attempt × 30s retry the PM-alert fixes use — the carrier message MUST be
 *    AI-written; a deterministic fallback is a LAST RESORT only.
 *  - Dedup: one send per operator per calendar day (in the configured tz),
 *    keyed 'OPERATOR:YYYY-MM-DD' in carrierBriefingLog, so a restart or re-open
 *    mid-morning never double-posts.
 *
 * Field sources (verified against fleetData row shape, relay.js
 * mergeRelayIntoRows): equipmentId, operator, domicileSite, lifecycleState
 * (DOWN when it contains 'unavail'), lifecycleReason / issueDetails, riskScore.
 */

const store = require('../store');
const logger = require('../utils/logger').createLogger('carrier_briefing');
const { getOperatorChannels, resolveOperatorEntry } = require('./pm_alert_reply');
// Block Kit redesign (2026-11-17): the layout is now deterministic Block Kit
// (carrier_briefing_blocks.js); the AI writes only the safety tip.
const { buildBriefingBlocks, buildBriefingText, renderedTireActions, PM_TYPES, PM_WINDOW_DAYS } = require('./carrier_briefing_blocks');

// ── Config ───────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  enabled: false,
  sendTime: '07:00',            // HH:MM, 24h, in `timezone`
  timezone: 'America/New_York',
  includeDown: true,
  includeFlagged: true,
  includeActive: true,
  includeDomiciles: true,
  riskThreshold: 80,            // "flagged this week" = riskScore >= this
  tipEnabled: true,
};

function getConfig() {
  const cfg = store.load('carrierBriefingConfig', null);
  if (!cfg || typeof cfg !== 'object') return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...cfg };
}

function saveConfig(patch) {
  const next = { ...getConfig(), ...(patch || {}) };
  // Normalize / clamp.
  next.enabled = !!next.enabled;
  next.sendTime = _normalizeTime(next.sendTime) || DEFAULT_CONFIG.sendTime;
  next.timezone = String(next.timezone || DEFAULT_CONFIG.timezone).trim() || DEFAULT_CONFIG.timezone;
  next.includeDown = !!next.includeDown;
  next.includeFlagged = !!next.includeFlagged;
  next.includeActive = !!next.includeActive;
  next.includeDomiciles = !!next.includeDomiciles;
  next.tipEnabled = !!next.tipEnabled;
  const rt = parseInt(next.riskThreshold, 10);
  next.riskThreshold = Number.isFinite(rt) ? Math.max(0, Math.min(100, rt)) : DEFAULT_CONFIG.riskThreshold;
  store.save('carrierBriefingConfig', next);
  return next;
}

function _normalizeTime(t) {
  const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10); const mi = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}

// ── Timezone helpers ──────────────────────────────────────────────────────────
// Current wall-clock { date:'YYYY-MM-DD', hm:'HH:MM' } in a given IANA tz,
// using Intl so we never depend on the host clock's tz.
function nowInZone(timezone, when) {
  const d = when || new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
    const hour = parts.hour === '24' ? '00' : parts.hour; // Intl can emit 24 at midnight
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      hm: `${hour}:${parts.minute}`,
    };
  } catch (e) {
    // Bad tz string — fall back to host local so the feature still runs.
    const pad = (n) => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      hm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    };
  }
}

// "Tue, Nov 17" in the configured tz (briefing context line).
function _dateLabel(timezone, when) {
  const d = when || new Date();
  try { return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(d); }
  catch (_) { return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(d); }
}

// "9:46 AM" for an ISO timestamp in the tz; "" when missing/invalid.
function _timeLabel(iso, timezone) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  try { return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(t)); }
  catch (_) { return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(t)); }
}

// Month-based season label (northern hemisphere) to steer the safety tip.
function _seasonFor(dateStr) {
  const m = parseInt(String(dateStr).slice(5, 7), 10);
  if (m === 12 || m === 1 || m === 2) return 'winter';
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  return 'fall';
}

// ── Fact gathering (grounded; never invents) ─────────────────────────────────
function _rows() {
  try {
    const fd = store.load('fleetData', {}) || {};
    return Array.isArray(fd.rows) ? fd.rows : [];
  } catch (_) { return []; }
}

function _domicileAddressMap() {
  // site code (UPPER) -> "City, ST" from the Contact Book domiciles.
  const map = {};
  try {
    const contacts = store.load('contacts', []) || [];
    for (const c of contacts) {
      if (!c || c.type !== 'domicile') continue;
      const code = String(c.name || '').trim().toUpperCase();
      if (!code) continue;
      const city = String(c.city || '').trim();
      const st = String(c.state || '').trim();
      const loc = [city, st].filter(Boolean).join(', ');
      if (loc) map[code] = loc;
    }
  } catch (_) { /* no contacts — codes shown without city */ }
  return map;
}

const _isDown = (r) => String(r.lifecycleState || '').toLowerCase().includes('unavail');

// gatherOperatorFacts(operator, cfg) -> grounded facts for one operator, or
// null if the operator has no units in fleetData.
function gatherOperatorFacts(operator, cfg) {
  const op = String(operator || '').trim();
  if (!op) return null;
  const opLower = op.toLowerCase();
  const rows = _rows().filter((r) => String(r.operator || '').trim().toLowerCase() === opLower);
  if (!rows.length) return null;

  const threshold = cfg.riskThreshold;
  const addrMap = _domicileAddressMap();
  const domicileCode = (r) => String(r.domicileSite || '').trim().toUpperCase();

  // Canonical state accessor — the single reconciled truth per unit. Required
  // lazily so this module stays testable without the orcha stack.
  let _canon; try { _canon = require('../orcha/canonical_state'); } catch (_) { _canon = null; }

  // Carrier-facing redaction: strip personal names + dollar amounts from every
  // field that reaches the carrier (this briefing posts to the carrier Slack).
  // Keeps vendor/company names, dealer locations, case numbers, parts, dates.
  // The stored row fields are NOT mutated — only the briefing facts are scrubbed
  // — so the AI/reasoning layer still sees everything.
  let _redact; try { _redact = require('../orcha/redact_sharing').redactForSharing; } catch (_) { _redact = (x) => x; }

  // Block Kit fields also go through _carrierText (module scope, below): URL strip + the same redaction.
  const todayIso = nowInZone(cfg.timezone).date;
  const nowMs = Date.now();

  const down = rows.filter(_isDown).map((r) => {
    const code = domicileCode(r);
    const loc = addrMap[code] || '';
    const reason = _redact(String(r.lifecycleReason || r.issueDetails || '').trim());
    const latestUpdate = _redact(_latestTimelineLine(r));
    // Canonical record (reconciled status/situation/next-step/stale). null for
    // units not yet reconciled — the raw reason/timeline below then stand alone.
    const canon = _canon ? _canon.getCanonical(r) : null;
    const issueSummary = _redact(_issueSummary(r, reason, latestUpdate));
    const canonNextStep = canon ? String(canon.nextStep || '').trim() : '';
    const canonStatusKey = canon ? String(canon.status || '').trim() : '';
    const daysDown = _daysDown(r, nowMs);
    const actionSrc = [canonNextStep, reason, issueSummary, latestUpdate].map(_carrierText).find((t) => t && PARTNER_ACTION_RE.test(t)) || '';
    return {
      unit: String(r.equipmentId || '').trim(),
      reason,
      // Quick issue summary — a short "what's actually wrong" line. Prefers the
      // AI-written issue summary, then the raw relay Issue Details. De-duped so
      // it is NOT just a copy of the short lifecycle reason or the latest
      // timeline update already shown. "" when nothing distinct is on file.
      issueSummary,
      // Latest repair-timeline entry (the day-by-day narrative; last line is
      // the most recent update). Falls back to the saved issue summary when no
      // timeline exists yet. "" when neither is on file (never guessed).
      latestUpdate,
      domicile: code,
      location: loc, // "" when no Contact Book address on file (never guessed)
      // Canonical state fields — "" / false when no record yet (never guessed).
      canonStatus: canon ? (_canon.statusLabel(canon.status)) : '',
      canonNextStep,
      canonStale: !!(canon && canon.stale),
      canonWaitingOn: canon ? String(canon.waitingOn || '').trim() : '',
      // Block Kit row fields (all carrier-redacted; "" / null when not on file).
      canonStatusKey,
      daysDown,
      vendor: _carrierText(r.subVendor || r.vendor),
      issue: _clip(_carrierText(issueSummary || reason || latestUpdate), 140),
      estimateLabel: _estimateLabel(r),
      etcIso: _toIsoDate(r.repairEtc),
      etcState: String((r._factEtc && r._factEtc.state) || ''),
      nextStep: _clip(_carrierText(canonNextStep), 140),
      severity: _severity(r, daysDown, canonStatusKey, reason, threshold),
      needsAction: !!actionSrc,
      actionText: _clip(actionSrc, 160),
    };
  }).filter((d) => d.unit);

  // PM / DOT due (PM-B, DOT, PM-X, Quarterly Lift) across ALL operator rows,
  // from the asset-API fields pmDueFields already put on the rows. Rows with no
  // PM data are skipped.
  const pmDue = rows.map((r) => ({ unit: String(r.equipmentId || '').trim(), items: _pmItems(r, todayIso) }))
    .filter((u) => u.unit && u.items.length);

  // Flagged (elevated-risk) units — now a LIST (unit + score + why), not just a
  // count, so the briefing can name which units and the risk reason.
  const flagged = rows
    .filter((r) => !_isDown(r) && Number(r.riskScore || 0) >= threshold)
    .map((r) => ({
      unit: String(r.equipmentId || '').trim(),
      score: Number(r.riskScore || 0),
      reason: _redact(_riskReason(r)),
      domicile: domicileCode(r),
    }))
    .filter((f) => f.unit)
    .sort((a, b) => b.score - a.score);
  const flaggedCount = flagged.length;
  const activeCount = rows.filter((r) => !_isDown(r)).length;

  const domicileSet = new Map(); // code -> loc
  for (const r of rows) {
    const code = domicileCode(r);
    if (code && !domicileSet.has(code)) domicileSet.set(code, addrMap[code] || '');
  }
  const domiciles = Array.from(domicileSet.entries())
    .map(([code, loc]) => ({ code, location: loc }))
    .sort((a, b) => a.code.localeCompare(b.code));

  return {
    operator: op,
    totalUnits: rows.length,
    down,
    downCount: down.length,
    flagged,
    flaggedCount,
    activeCount,
    domiciles,
    riskThreshold: threshold,
    pmDue,
    syncedAt: _syncedAt(),
  };
}

// ── Block Kit fact helpers ────────────────────────────────────────────────────
const _URL_RE = /<?\bhttps?:\/\/[^\s>]+>?/gi;

// Partner-held blockers (impound/storage fees, confirm accident vendor, …).
const PARTNER_ACTION_RE = /impound|storage fee|release fee|tow(?:ing)? (?:yard )?fee|accident vendor|confirm (?:the )?(?:accident|insurance|vendor|tow)|(?:carrier|dsp|partner|operator|owner) (?:to|needs? to|must) (?:confirm|approve|pay|provide|pick|release|authori[sz]e)|awaiting (?:carrier|dsp|partner|operator)/i;

function _clip(s, n) {
  const t = String(s || '').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

// Carrier-facing text: drop any URL (no internal Relay/AAP links reach the
// carrier), then strip personal names + dollar amounts (redactForSharing).
function _carrierText(s) {
  let _redact; try { _redact = require('../orcha/redact_sharing').redactForSharing; } catch (_) { _redact = (x) => x; }
  return _redact(String(s || '').replace(_URL_RE, ' ')).replace(/\s{2,}/g, ' ').trim();
}

// Approved Aperia underinflation items for this operator (src/aperia/share-store.js),
// carrier-redacted, for the "Needs your action" section. [] unless the share
// toggle is ON. Pending (unapproved) items never appear.
function _aperiaTireActions(operator) {
  try {
    if (!require('../aperia/share-pref').load().enabled) return [];
    return require('../aperia/share-store').approvedFor(operator)
      .map((it) => ({ unit: String(it.unit || '').trim(), actionText: _clip(_carrierText(it.text), 300), id: it.id }))
      .filter((x) => x.unit && x.actionText);
  } catch (_) { return []; }
}

function _syncedAt() {
  try { const fd = store.load('fleetData', {}) || {}; return fd.syncedAt || ''; } catch (_) { return ''; }
}

// Whole days down from the WR/down start (`created`), else "Nd …" workDuration.
function _daysDown(r, nowMs) {
  const t = Date.parse(r.created || '');
  if (Number.isFinite(t) && t <= nowMs) return Math.floor((nowMs - t) / 864e5);
  const m = String(r.workDuration || '').match(/^(\d+)d/);
  return m ? parseInt(m[1], 10) : null;
}

// Estimate STATUS only — never the dollar figure.
function _estimateLabel(r) {
  const st = String(r.estimateStatus || '').toLowerCase();
  if (st === 'approved') return 'Estimate approved';
  if (st === 'submitted') return 'Estimate pending approval';
  if (st === 'rejected' || st === 'temp-reject') return 'Estimate under revision';
  if (String(r.estimatePendingCost || '').trim()) return 'Estimate pending approval';
  if (String(r.totalCost || '').trim()) return 'Estimate approved';
  return '';
}

function _toIsoDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// 🔴 red: >14d down, urgent, or risk >= threshold; 🟡 yellow: parts wait; ⚪ white.
function _severity(r, daysDown, canonStatusKey, reason, threshold) {
  const risk = (r.riskScore === undefined || r.riskScore === null || r.riskScore === '') ? NaN : Number(r.riskScore);
  if ((daysDown != null && daysDown > 14) || /^yes$/i.test(String(r.urgent || '').trim()) ||
      (Number.isFinite(risk) && risk >= threshold)) return 'red';
  if (canonStatusKey === 'awaiting_parts' || /wait|order|back ?order|ship|eta/i.test(String(r.partsStatus || '')) ||
      /\bparts?\b/i.test(String(reason || ''))) return 'yellow';
  return 'white';
}

const _PM_RAW_KEYS = { PM_B: 'pmBDue', DOT: 'dotDue', PM_X: 'pmXDue', QUARTERLY_LIFT: 'quarterlyLiftDue' };
const _MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const _MON_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _pad2 = (n) => String(n).padStart(2, '0');
function _lastDayIso(y, mo) { return y + '-' + _pad2(mo + 1) + '-' + _pad2(new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()); }

// "Mon D, YYYY" -> that date; "Mon YYYY" (month-only) -> last day of month.
function _pmRawToIso(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/);
  if (m && _MON[m[1].toLowerCase()] != null) return { iso: m[3] + '-' + _pad2(_MON[m[1].toLowerCase()] + 1) + '-' + _pad2(Number(m[2])), monthOnly: false };
  m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{4})$/);
  if (m && _MON[m[1].toLowerCase()] != null) return { iso: _lastDayIso(Number(m[2]), _MON[m[1].toLowerCase()]), monthOnly: true };
  return null;
}

function _isoDayDiff(a, b) {
  const p = (x) => { const m = String(x).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
  return Math.round((p(a) - p(b)) / 864e5);
}

function _pmItems(r, todayIso) {
  const found = {};
  if (Array.isArray(r.pmSchedule)) {
    for (const e of r.pmSchedule) {
      const type = String((e && e.type) || '').toUpperCase();
      if (!PM_TYPES.includes(type) || found[type]) continue;
      const m = String(e.nextDueIso || '').match(/^(\d{4})-(\d{2})-\d{2}/);
      if (!m) continue;
      const monthOnly = String(e.displayFormat || '').toUpperCase() === 'MONTH_AND_YEAR';
      found[type] = { iso: monthOnly ? _lastDayIso(+m[1], +m[2] - 1) : e.nextDueIso.slice(0, 10), monthOnly };
    }
  }
  for (const type of PM_TYPES) {
    if (!found[type]) { const p = _pmRawToIso(r[_PM_RAW_KEYS[type]]); if (p) found[type] = p; }
  }
  const items = [];
  for (const type of PM_TYPES) {
    const f = found[type];
    if (!f) continue;
    const days = _isoDayDiff(f.iso, todayIso);
    if (!Number.isFinite(days) || days > PM_WINDOW_DAYS) continue;
    const mo = Number(f.iso.slice(5, 7)) - 1;
    items.push({ type, dueIso: f.iso, dueLabel: f.monthOnly ? _MON_NAMES[mo] + ' ' + f.iso.slice(0, 4) : _MON_NAMES[mo] + ' ' + Number(f.iso.slice(8, 10)), days });
  }
  return items;
}

// Most recent repair-timeline line for a unit (timeline is appended oldest ->
// newest, so the LAST non-empty line is the latest update). Falls back to the
// saved issue summary, then empty string. Trimmed to a Slack-friendly length.
function _latestTimelineLine(r) {
  const tl = String(r.repairTimeline || '').trim();
  if (tl) {
    const lines = tl.split('\n').map((s) => s.trim()).filter(Boolean);
    if (lines.length) return lines[lines.length - 1].slice(0, 180);
  }
  const summary = String(r.issueSummary || r.savedNotes || '').trim();
  return summary ? summary.slice(0, 180) : '';
}

// Quick "what's wrong" summary for a down unit. Prefers the AI-written issue
// summary, then the raw relay Issue Details. Returns "" when the only text
// available is already being shown as the short lifecycle reason or the latest
// timeline update (so we don't print the same sentence twice). Trimmed to a
// Slack-friendly length. Never invents — only uses fields present on the row.
function _issueSummary(r, reason, latestUpdate) {
  const raw = String(r.issueSummary || r.issueDetails || '').trim();
  if (!raw) return '';
  const summary = raw.slice(0, 220);
  const norm = (s) => String(s || '').trim().toLowerCase();
  const s = norm(summary);
  // Skip if it's effectively the same text we already surface elsewhere.
  if (s && (s === norm(reason) || s === norm(latestUpdate))) return '';
  return summary;
}

// Human-readable "why flagged" for a risk unit: prefer the top Uptake insight
// (title / subsystem), then the risk label, then a generic phrasing. Never
// invents — only uses fields actually present on the row.
function _riskReason(r) {
  const insights = Array.isArray(r.insightsList) ? r.insightsList : [];
  const active = insights.find((i) => i && (i.stillActive === undefined || i.stillActive)) || insights[0];
  if (active) {
    const title = String(active.title || '').trim();
    const sub = String(active.subsystem || '').trim();
    if (title && sub) return title + ' (' + sub + ')';
    if (title) return title;
    if (sub) return sub + ' alert';
  }
  const label = String(r.riskLabel || '').trim();
  if (label) return label + ' risk';
  return 'elevated predictive risk';
}

// ── Prompt (AI writes the whole message) ──────────────────────────────────────
function buildBriefingPrompt(facts, cfg, ownerTag, dateStr) {
  const season = _seasonFor(dateStr);
  const lines = [];
  lines.push('You are composing ONE short daily Slack message to a trucking carrier/operator partner channel. Write the ENTIRE message yourself — greeting, snapshot, and (if asked) a safety tip. Keep it warm, professional, and concise.');
  lines.push('');
  lines.push('TODAY: ' + dateStr + ' (' + season + ').');
  lines.push('OPERATOR: ' + facts.operator + '.');
  lines.push('');
  lines.push('GROUNDED FACTS — use ONLY these; never invent a unit, number, location, date, or reason:');
  lines.push('PRIVACY: these facts are already sanitized for the carrier. Do NOT add or infer any personal names or dollar amounts. Keep vendor/company names, dealer locations, case numbers, parts, and dates. If a fact reads oddly after sanitization, phrase around it — never reconstruct a removed name or price.');

  if (cfg.includeDown) {
    if (facts.downCount) {
      lines.push('- Units currently DOWN (' + facts.downCount + '). For EACH, show the unit, its reason for being down, the domicile, a quick issue summary (when given), AND the latest update (light cleanup only — keep its meaning; do not add names or prices):');
      facts.down.forEach((d) => {
        const where = d.location ? (d.domicile + ' (' + d.location + ')') : d.domicile;
        let line = '    • ' + d.unit + (d.reason ? ' — ' + d.reason : '') + (where ? ' · ' + where : '');
        // Canonical state — the reconciled status + next step for this unit.
        // When present it is the authoritative "where it stands"; show it so the
        // partner sees one consistent status (never contradicting the raw lines).
        if (d.canonStatus) line += '\n        Status: ' + d.canonStatus + (d.canonStale ? ' (no recent update)' : '');
        if (d.canonNextStep) line += '\n        Next step: ' + d.canonNextStep;
        if (d.issueSummary) line += '\n        Issue: ' + d.issueSummary;
        if (d.latestUpdate) line += '\n        Latest update: ' + d.latestUpdate;
        lines.push(line);
      });
    } else {
      lines.push('- Units currently DOWN: none (all units are running).');
    }
  }
  if (cfg.includeFlagged) {
    if (facts.flaggedCount) {
      lines.push('- Units flagged this week with elevated risk (risk score >= ' + facts.riskThreshold + '). List EACH flagged unit with its risk score and the reason, then remind the partner to ensure a pre-trip inspection before dispatch:');
      facts.flagged.forEach((f) => {
        const where = f.domicile ? ' · ' + f.domicile : '';
        lines.push('    • ' + f.unit + ' (risk ' + f.score + ')' + (f.reason ? ' — ' + f.reason : '') + where);
      });
    } else {
      lines.push('- Units flagged this week (risk score >= ' + facts.riskThreshold + '): none.');
    }
  }
  if (cfg.includeActive) {
    lines.push('- Active units: ' + facts.activeCount + ' (of ' + facts.totalUnits + ' total).');
  }
  if (cfg.includeDomiciles && facts.domiciles.length) {
    const dl = facts.domiciles.map((d) => d.location ? (d.code + ' (' + d.location + ')') : d.code).join(', ');
    lines.push('- Domiciles: ' + dl + '.');
  }

  lines.push('');
  lines.push('REQUIREMENTS:');
  if (ownerTag) lines.push('- Address the owner by starting with EXACTLY this token so Slack tags them: ' + ownerTag);
  lines.push('- Use Slack-friendly emojis tastefully (e.g. :sunny: :red_circle: :large_yellow_circle: :green_circle: :round_pushpin: :bulb: :truck:).');
  lines.push('- Present the snapshot clearly (short lines or bullets). Only include the facts given above.');
  if (cfg.tipEnabled) {
    lines.push('- Finish with ONE concrete, specific "safety tip of the day" relevant to ' + season + ' driving/fleet operations. Make it practical and specific (not generic). Vary it day to day.');
  }
  lines.push('');
  lines.push('MUST NOT:');
  lines.push('- Mention "Z", "Zila", "FAS", the internal requester, or any internal-only names/roles.');
  lines.push('- Include ANY personal name (dealer advisors, our staff, anyone) or ANY dollar amount / price / cost. These are intentionally excluded from the carrier message.');
  lines.push('- Invent any unit, count, address, date, price, or reason not listed above.');
  lines.push('- Drop or summarize-away the per-unit detail — every down unit must show its reason, its quick issue summary (when one is given), AND its latest update; every flagged unit must show its score + reason. Length is fine; completeness matters more than brevity here.');

  if (cfg.tipEnabled) {
    const recent = _recentTips();
    if (recent.length) {
      lines.push('');
      lines.push('Do NOT repeat any of these recent safety tips (choose a different topic):');
      recent.forEach((t) => lines.push('    - ' + t));
    }
  }
  return lines.join('\n');
}

// ── AI call (relay.ask + 2×30s retry; AI-written is required) ─────────────────
async function _askAI(prompt, log) {
  const relay = require('../orcha/relay');
  const ATTEMPTS = 2;
  const ATTEMPT_MS = 30000;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const raw = await relay.askWithTimeout(prompt, {
        source: 'carrier_briefing', timeoutMs: ATTEMPT_MS, timeoutMessage: 'ai-timeout',
      });
      const text = (typeof raw === 'string') ? raw.trim() : (raw && raw.text ? String(raw.text).trim() : '');
      if (text) { log('[CarrierBriefing] AI message generated (attempt ' + attempt + ')'); return text; }
      log('[CarrierBriefing] AI returned empty (attempt ' + attempt + '/' + ATTEMPTS + ')');
    } catch (e) {
      log('[CarrierBriefing] AI attempt ' + attempt + '/' + ATTEMPTS + ' failed (' + e.message + ')');
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 1500));
  }
  return '';
}

// Safety tip (the only AI-written part of the Block Kit briefing). Short,
// plain text, no names/prices/internal names, no repeats of recent tips.
function buildTipPrompt(season, recentTips) {
  const lines = [];
  lines.push('Write ONE practical, specific safety tip of the day for a trucking carrier partner, relevant to ' + season + ' driving/fleet operations.');
  lines.push('Rules: at most 160 characters, plain text, one line, no greeting, no emojis, no quotes.');
  lines.push('MUST NOT mention "Z", "Zila", "FAS", any personal name, or any price/dollar amount.');
  const recent = Array.isArray(recentTips) ? recentTips.filter(Boolean) : [];
  if (recent.length) {
    lines.push('Do NOT repeat any of these recent tips (choose a different topic):');
    recent.forEach((t) => lines.push('    - ' + t));
  }
  return lines.join('\n');
}

// Deterministic tip when the AI is unavailable: 4 per season, by day of month.
const _SEASON_TIPS = {
  winter: [
    'Check tire pressure before every cold-morning departure; it drops about 1 PSI per 10°F.',
    'Clear all snow and ice from the trailer roof before leaving the yard.',
    'Double your following distance on bridges and overpasses; they freeze first.',
    'Keep fuel above half a tank in freezing weather to prevent gel-up and condensation.',
  ],
  spring: [
    'Watch for potholes after the thaw and report any steering pull right away.',
    'Slow down in heavy spring rain; hydroplaning can start around 35 mph on worn tires.',
    'Walk around the unit before each trip and check lights, mud flaps, and tire tread.',
    'Expect more road work this season; slow down early and give crews extra room.',
  ],
  summer: [
    'Check coolant level and hoses on pre-trip; summer heat is hard on cooling systems.',
    'Check tire pressure cold, before the run; hot tires read high.',
    'Stay hydrated on long runs; fatigue from heat slows reaction time.',
    'Give extra room around tourist and RV traffic on summer highways.',
  ],
  fall: [
    'Wet leaves can be as slick as ice; brake early on leaf-covered roads.',
    'Low sun at dawn and dusk causes glare; keep the windshield clean inside and out.',
    'Watch for deer at dawn and dusk; brake firmly and do not swerve.',
    'Test heaters, defrosters, and wipers now, before the first cold snap.',
  ],
};
function _seasonalTip(dateStr) {
  const list = _SEASON_TIPS[_seasonFor(dateStr)] || _SEASON_TIPS.fall;
  const day = parseInt(String(dateStr).slice(8, 10), 10) || 0;
  return list[day % list.length];
}

// Ask the AI for the tip (same 2×30 s retry). Returns { tip, aiWritten }.
async function _getTip(dateStr, log) {
  let _redact; try { _redact = require('../orcha/redact_sharing').redactForSharing; } catch (_) { _redact = (x) => x; }
  const raw = await _askAI(buildTipPrompt(_seasonFor(dateStr), _recentTips()), log);
  const first = String(raw || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  const tip = _clip(_redact(first.replace(_URL_RE, ' ').replace(/^["'“”*\-•\s]+|["'“”*\s]+$/g, '')).trim(), 200);
  if (tip) return { tip, aiWritten: true };
  return { tip: _seasonalTip(dateStr), aiWritten: false };
}

// ── Safety-tip no-repeat history ──────────────────────────────────────────────
function _log() {
  const l = store.load('carrierBriefingLog', null);
  if (l && typeof l === 'object') return { sent: l.sent || {}, lastRunAt: l.lastRunAt || null, recentTips: Array.isArray(l.recentTips) ? l.recentTips : [] };
  return { sent: {}, lastRunAt: null, recentTips: [] };
}
function _saveLog(l) { store.save('carrierBriefingLog', l); }
function _recentTips() { return _log().recentTips.slice(-10); }

// Best-effort: remember the final line (the tip) to discourage repeats.
function _rememberTip(message) {
  try {
    const l = _log();
    const lines = String(message || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const tip = lines.length ? lines[lines.length - 1] : '';
    if (tip && tip.length > 12) {
      l.recentTips.push(tip);
      if (l.recentTips.length > 10) l.recentTips = l.recentTips.slice(-10);
      _saveLog(l);
    }
  } catch (_) { /* non-fatal */ }
}

// Blocks sender for a deps object. deps.sendBlocksToChannel wins. Callers that
// can't add it (src/ipc/ai.js is off-limits under the email-intel NFR-8 guard)
// but pass the REAL slack_send.sendToChannel get the real
// slack_send.sendBlocksToChannel. Anything else (mocks, custom senders) gets
// null, so the briefing goes out text-only through deps.sendToChannel.
function _blocksSender(deps) {
  if (typeof deps.sendBlocksToChannel === 'function') return deps.sendBlocksToChannel;
  try {
    const ss = require('./slack_send');
    if (deps.sendToChannel && deps.sendToChannel === ss.sendToChannel && typeof ss.sendBlocksToChannel === 'function') return ss.sendBlocksToChannel;
  } catch (_) { /* slack_send unavailable — text-only */ }
  return null;
}

// ── Send one operator's briefing ──────────────────────────────────────────────
// deps: { sendToChannel, openConversation, checkLiveAuth }
// opts: { testToSelf?: boolean, force?: boolean } — testToSelf posts to the
// user's own DM and bypasses dedup; force bypasses dedup but still posts to the
// carrier channel.
async function sendOperatorBriefing(operator, deps, opts, log) {
  const doLog = log || ((m) => logger.info(m));
  deps = deps || {};
  opts = opts || {};
  const { sendToChannel, openConversation, checkLiveAuth } = deps;
  const sendBlocksToChannel = _blocksSender(deps);
  const cfg = getConfig();

  const entry = resolveOperatorEntry(operator);
  if (!entry || !entry.channelId) {
    doLog('[CarrierBriefing] ' + operator + ': no mapped carrier channel — skipping');
    return { sent: false, reason: 'no-channel' };
  }

  const facts = gatherOperatorFacts(operator, cfg);
  if (!facts) {
    doLog('[CarrierBriefing] ' + operator + ': no units in fleet data — skipping');
    return { sent: false, reason: 'no-units' };
  }
  const _tire = _aperiaTireActions(operator);
  if (_tire.length) facts.tireActions = _tire;

  const tz = cfg.timezone;
  const today = nowInZone(tz).date;
  const dedupKey = operator.toUpperCase() + ':' + today;

  // Dedup — one send per operator per calendar day (skipped for test/force).
  if (!opts.testToSelf && !opts.force) {
    const l = _log();
    if (l.sent && l.sent[dedupKey]) {
      doLog('[CarrierBriefing] ' + operator + ': already sent today (' + today + ') — skipping');
      return { sent: false, reason: 'already-sent' };
    }
  }

  // Resolve the destination channel.
  let destChannel = entry.channelId;
  if (opts.testToSelf) {
    try {
      const auth = await checkLiveAuth();
      if (!auth || !auth.authenticated || !auth.userId) throw new Error('no slack userId');
      destChannel = await openConversation({ id: auth.userId, type: 'user' });
      if (!destChannel) throw new Error('could not open self-DM');
    } catch (e) {
      doLog('[CarrierBriefing] test: could not open self-DM (' + e.message + ')');
      return { sent: false, reason: 'self-dm-failed' };
    }
  }

  const ownerTag = entry.ownerId ? '<@' + entry.ownerId + '>' : '';

  // Safety tip: the only AI-written part (deterministic seasonal tip if the AI fails).
  let tip = '';
  let aiWritten = false;
  if (cfg.tipEnabled) {
    const t = await _getTip(today, doLog);
    tip = t.tip;
    aiWritten = t.aiWritten;
    if (!aiWritten) doLog('[CarrierBriefing] ' + operator + ': AI tip unavailable — using seasonal tip');
  }

  // "Questions? Message Z" URL button (Slack profile/DM link). Omitted when the
  // Slack user id can't be read.
  let contactUrl = '';
  try {
    const auth = typeof checkLiveAuth === 'function' ? await checkLiveAuth() : null;
    if (auth && auth.userId && /^[A-Z0-9]+$/i.test(String(auth.userId))) {
      contactUrl = 'https://amazon.enterprise.slack.com/team/' + auth.userId;
    }
  } catch (_) { contactUrl = ''; }

  const ctx = {
    todayIso: today,
    dateLabel: _dateLabel(tz),
    updatedLabel: _timeLabel(facts.syncedAt, tz),
    ownerTag,
    tip,
    contactUrl,
    testPreviewChannelId: opts.testToSelf ? entry.channelId : '',
    includeDown: cfg.includeDown,
    includeDomiciles: cfg.includeDomiciles,
  };
  const blocks = buildBriefingBlocks(facts, ctx);
  const message = buildBriefingText(facts, ctx);

  try {
    // top-level (no thread_ts); text-only fallback for callers without the blocks helper.
    if (typeof sendBlocksToChannel === 'function') await sendBlocksToChannel(destChannel, blocks, message, { unfurl: false });
    else await sendToChannel(destChannel, message);
  } catch (e) {
    doLog('[CarrierBriefing] ' + operator + ': send failed (' + e.message + ')');
    return { sent: false, reason: 'send-failed', error: e.message };
  }

  // Record dedup + tip history for real (non-test) sends.
  if (!opts.testToSelf) {
    const l = _log();
    l.sent = l.sent || {};
    l.sent[dedupKey] = new Date().toISOString();
    // Prune old dedup keys (keep ~400 most recent) so the file never grows forever.
    const keys = Object.keys(l.sent);
    if (keys.length > 400) {
      keys.sort((a, b) => String(l.sent[a]).localeCompare(String(l.sent[b])));
      keys.slice(0, keys.length - 400).forEach((k) => delete l.sent[k]);
    }
    l.lastRunAt = new Date().toISOString();
    _saveLog(l);
    if (aiWritten) _rememberTip(tip);
    // Only the tire items that were actually rendered are marked sent; the rest
    // (includeDown off, or cut by the Needs-your-action cap) stay approved.
    if (_tire.length) {
      try {
        const _shown = renderedTireActions(facts, ctx).map((t) => t.id).filter(Boolean);
        if (_shown.length) require('../aperia/share-store').markItemsSent(_shown);
      } catch (_) {}
    }
  }

  doLog('[CarrierBriefing] ' + operator + ': ' + (opts.testToSelf ? 'TEST ' : '') + 'posted to ' +
    (opts.testToSelf ? 'self-DM' : entry.channelId) + ' (' + blocks.length + ' blocks, tip ' + (aiWritten ? 'AI' : 'fallback') + ')');
  return { sent: true, operator, channelId: entry.channelId, aiWritten, testToSelf: !!opts.testToSelf };
}

// ── Run all operators (the daily job) ─────────────────────────────────────────
// Iterates every operator that has a mapped carrier channel; dedup makes it
// safe to call repeatedly. deps as above. opts.force bypasses dedup.
async function runDailyBriefing(deps, opts, log) {
  const doLog = log || ((m) => logger.info(m));
  const cfg = getConfig();
  if (!cfg.enabled && !(opts && opts.force)) {
    doLog('[CarrierBriefing] disabled — skipping run');
    return { ran: false, reason: 'disabled' };
  }
  const channels = getOperatorChannels();
  const operators = (channels.operators || []).filter((o) => o && o.operator && o.channelId);
  if (!operators.length) {
    doLog('[CarrierBriefing] no operators with a mapped channel — nothing to send');
    return { ran: true, results: [] };
  }
  const results = [];
  for (const o of operators) {
    try {
      const r = await sendOperatorBriefing(o.operator, deps, { force: opts && opts.force }, doLog);
      results.push({ operator: o.operator, ...r });
    } catch (e) {
      doLog('[CarrierBriefing] ' + o.operator + ': run error (' + e.message + ')');
      results.push({ operator: o.operator, sent: false, reason: 'error', error: e.message });
    }
  }
  const sent = results.filter((r) => r.sent).length;
  doLog('[CarrierBriefing] run complete — ' + sent + '/' + operators.length + ' sent');
  return { ran: true, results };
}

// ── Scheduler (daily tick) ────────────────────────────────────────────────────
// Mirrors src/orcha/fas/scheduler.js: an idempotent setInterval that unref()s
// so it never keeps the process alive. Ticks every minute; when the current
// wall-clock minute in the configured timezone equals the configured sendTime
// AND today's run hasn't happened, it fires runDailyBriefing. Dedup inside
// sendOperatorBriefing guarantees one send per operator per day even if the
// minute is observed more than once or the app restarts.
let _timer = null;
let _firingFor = null; // guards against overlapping runs within the same minute

function _slackDeps() {
  const { sendToChannel, sendBlocksToChannel, openConversation, checkLiveAuth } = require('./slack_send');
  return { sendToChannel, sendBlocksToChannel, openConversation, checkLiveAuth };
}

async function _tick() {
  let cfg;
  try { cfg = getConfig(); } catch (_) { return; }
  if (!cfg.enabled) return;
  const now = nowInZone(cfg.timezone);
  if (now.hm !== cfg.sendTime) return;
  // Only fire once per calendar day. The per-operator dedup is the hard
  // guarantee; this day-guard just avoids re-entering runDailyBriefing every
  // minute during the matching minute window / across the day.
  const dayKey = now.date;
  const l = _log();
  if (l.lastRunDay === dayKey) return;
  if (_firingFor === dayKey) return; // a run for today is already in flight
  _firingFor = dayKey;
  try {
    logger.info('[CarrierBriefing] scheduled run for ' + dayKey + ' at ' + cfg.sendTime + ' ' + cfg.timezone);
    await runDailyBriefing(_slackDeps(), {}, (m) => logger.info(m));
    const after = _log();
    after.lastRunDay = dayKey;
    after.lastRunAt = new Date().toISOString();
    _saveLog(after);
  } catch (e) {
    logger.warn('[CarrierBriefing] scheduled run failed: ' + e.message);
  } finally {
    _firingFor = null;
  }
}

// ── Worker supervisor ownership (Phase 5, 2026-10-30) ──
// Flag on (workers.supervised.carrierBriefing): the supervisor runs _tick
// every 60 s and the legacy setInterval is NOT armed. Flag off (default): the
// legacy setInterval runs unchanged. backoff:false keeps the exact-minute grid
// (backoff is inert for this worker). The day-guard and per-operator dedup
// stay inside _tick, so a restart in the matching minute never double-sends.
let _owned = false;

function startScheduler() {
  stopScheduler();
  let owned = false;
  try {
    owned = require('../workers/supervisor').claim({
      name: 'carrierBriefing', group: 'comms', tick: _tick, intervalMs: 60 * 1000,
      timeoutMs: 30 * 60 * 1000, maxFailures: 10, cooldownMs: 10 * 60 * 1000, backoff: false,
      dependsOn: [], idempotent: true, label: 'Daily carrier briefing',
    });
  } catch (_) { owned = false; }
  if (owned) {
    _owned = true;
    logger.info('[CarrierBriefing] scheduler started (ticks every 60s)');
    return stopScheduler;
  }
  _timer = setInterval(() => { _tick().catch(() => {}); }, 60 * 1000);
  if (_timer.unref) _timer.unref();
  logger.info('[CarrierBriefing] scheduler started (ticks every 60s)');
  return stopScheduler;
}

function stopScheduler() {
  if (_owned) { try { require('../workers/supervisor').stop('carrierBriefing'); } catch (_) {} _owned = false; }
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  DEFAULT_CONFIG,
  getConfig,
  saveConfig,
  nowInZone,
  gatherOperatorFacts,
  buildBriefingPrompt,
  buildTipPrompt,
  buildBriefingBlocks,
  buildBriefingText,
  PARTNER_ACTION_RE,
  sendOperatorBriefing,
  runDailyBriefing,
  startScheduler,
  stopScheduler,
  __test__: { legacyArmed: () => !!_timer, owned: () => _owned },
};
