/**
 * orcha/briefing.js — Morning briefing, anomaly detection, recommendations, health scoring
 *
 * Extracted from src/app.js (Phase 4) for maintainability and testability.
 * Called by _pushData() on every fleet data push.
 *
 * The morning briefing is now an AI-written narrative (relay.ask) that
 * prioritizes what needs the coordinator's attention today, with a hard
 * fallback to a deterministic template if AI is slow/unavailable — so the
 * briefing NEVER breaks or silently shows nothing.
 */

const logger = require('../utils/logger')('briefing');
const store  = require('../store');
const crypto = require('crypto');
const { runAnomalyDetection } = require('./anomaly');
const repairHistory = require('./repair-history');

const BRIEFING_AI_TIMEOUT_MS = 45000;

// Guard state: which day the briefing last fired, and a fingerprint of the
// actionable picture so a manual/auto refresh only regenerates when something
// materially changed (or when forced).
function _todayKey() { return new Date().toISOString().split('T')[0]; }

// Fingerprint the actionable set: unavailable units (id+vendor+state+days) plus
// the alert ids. If this is unchanged, the briefing would say the same thing —
// no need to spend an AI call.
function _briefingFingerprint(rows, alerts) {
  const unavail = (rows || [])
    .filter(r => (r.lifecycleState || '').toLowerCase().includes('unavail'))
    .map(r => r.equipmentId + '|' + (r.vendor || '') + '|' + (r.lifecycleReason || '') + '|' + (r.workDuration || ''))
    .sort();
  const alertIds = (alerts || []).map(a => a.id).sort();
  return crypto.createHash('sha1')
    .update(JSON.stringify({ unavail, alertIds }))
    .digest('hex')
    .slice(0, 16);
}

// ── Deterministic template (fallback + healthy case) ────────────────────────
function _templateBriefing(alerts) {
  const critical = (alerts || []).filter(a => a.severity === 'critical');
  const warnings = (alerts || []).filter(a => a.severity === 'warning');
  if (critical.length + warnings.length === 0) {
    return '\u2600\uFE0F Morning Briefing: Fleet is healthy \u2014 no critical issues flagged.';
  }
  return '\u2600\uFE0F Morning Briefing: ' + critical.length + ' critical, ' + warnings.length + ' warnings.\n' +
    critical.slice(0, 5).map(a => '\uD83D\uDD34 ' + a.unit + ' \u2014 ' + a.message).join('\n') +
    (warnings.length ? '\n' + warnings.slice(0, 5).map(a => '\u26A0\uFE0F ' + a.unit + ' \u2014 ' + a.message).join('\n') : '');
}

// ── AI narrative prompt ─────────────────────────────────────────────────────
// Builds a compact, grounded prompt from the actionable signals. The AI writes
// a short prioritized narrative — "here's what needs you today" — NOT a wall of
// counts. Grounded strictly in the provided rows/alerts (no fabrication).
function _buildBriefingPrompt(rows, alerts, dueReminders) {
  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  })();

  const unavail = (rows || []).filter(r => (r.lifecycleState || '').toLowerCase().includes('unavail'));
  const total = (rows || []).length;

  // Compact per-unit lines for the down units (cap to keep prompt small).
  const _days = d => {
    const s = String(d || '').match(/\d+/);
    return s ? parseInt(s[0], 10) : null;
  };
  const downLines = unavail
    .slice()
    .sort((a, b) => (_days(b.workDuration) || 0) - (_days(a.workDuration) || 0))
    .slice(0, 40)
    .map(r => {
      const parts = [
        r.equipmentId,
        r.operator || r.domicileSite || '',
        'vendor=' + (r.vendor || 'UNASSIGNED'),
        'down=' + (r.workDuration || '?'),
        r.lifecycleReason ? 'status=' + r.lifecycleReason : '',
        r.etc ? 'ETC=' + r.etc : '',
        (r.riskScore ? 'risk=' + r.riskScore : ''),
      ].filter(Boolean);
      return '- ' + parts.join(', ');
    })
    .join('\n');

  const critical = (alerts || []).filter(a => a.severity === 'critical');
  const warnings = (alerts || []).filter(a => a.severity === 'warning');
  const alertLines = (alerts || [])
    .slice(0, 30)
    .map(a => '- [' + a.severity + '] ' + a.unit + ': ' + a.message)
    .join('\n');

  const reminderLines = (dueReminders || []).length
    ? (dueReminders.map(r => '- ' + r.unit + ': ' + r.note).join('\n'))
    : '(none)';

  return `You are Orcha, the AI assistant for an Amazon fleet maintenance coordinator (FAS). Write a SHORT morning briefing that tells them what needs their attention TODAY. This is the first thing they read when the app opens — make it genuinely useful, not a list of counts.

WRITE:
- Start with "${greeting}." then one sentence on overall fleet state (X of ${total} units down).
- Then 3-6 short bullet lines, most urgent first, each naming the specific unit(s) and the ONE action that would move it forward today. Group units that share the same blocker/vendor into one line when it helps.
- Prioritize: units down longest with no vendor, vendors that have gone quiet, ETCs that have passed, overdue PMs, and high Uptake risk with no work order.
- If there are due reminders, surface them near the top.
- Be concrete and specific (unit IDs, vendor names, days down). Use plain text, short lines. No markdown headers, no tables, no preamble like "Here is your briefing".
- Keep it under ~180 words. If the fleet is genuinely quiet, say so briefly instead of padding.

DO NOT invent units, vendors, ETCs, or numbers. Use ONLY what is given below. If a detail isn't provided, don't state it.

FLEET SNAPSHOT: ${total} total units, ${unavail.length} unavailable. Alerts: ${critical.length} critical, ${warnings.length} warnings.

DUE REMINDERS:
${reminderLines}

FLAGGED ALERTS:
${alertLines || '(none)'}

UNAVAILABLE UNITS (longest down first):
${downLines || '(none currently down)'}

Write the briefing now (plain text only):`;
}

// ── Async AI briefing (fire-and-forget from process()) ──────────────────────
async function _generateAndSendBriefing(rows, alerts, send, opts) {
  opts = opts || {};
  const dueReminders = opts.dueReminders || [];
  const critical = (alerts || []).filter(a => a.severity === 'critical').length;
  const warnings = (alerts || []).filter(a => a.severity === 'warning').length;

  let text = null;
  let generatedBy = 'template';
  try {
    const relay = require('./relay');
    const prompt = _buildBriefingPrompt(rows, alerts, dueReminders);
    const aiText = await Promise.race([
      relay.ask(prompt, { requestId: 'briefing' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('briefing AI timeout')), BRIEFING_AI_TIMEOUT_MS)),
    ]);
    const clean = (aiText || '').trim();
    // Sanity: a real briefing is more than a few words. If the model returned
    // something empty/garbage, fall back to the template rather than show junk.
    if (clean && clean.length > 40) { text = clean; generatedBy = 'ai'; }
  } catch (e) {
    logger.warn('[briefing] AI narrative failed (' + e.message + ') — using template fallback');
  }

  if (!text) text = _templateBriefing(alerts);

  // Prepend due-reminders line so they are never lost regardless of AI output.
  if (dueReminders.length && generatedBy === 'template') {
    text = '\u23F0 Reminders due today:\n' +
      dueReminders.map(r => '\u2022 ' + r.unit + ': ' + r.note).join('\n') + '\n\n' + text;
  }

  send('orcha:morning-briefing', {
    text,
    critical,
    warnings,
    generatedBy,
    generatedAt: new Date().toISOString(),
  });
  logger.info('[briefing] sent (' + generatedBy + ', ' + text.length + ' chars, ' + critical + ' crit / ' + warnings + ' warn)');
}

/**
 * process(rows, send, opts)
 * @param {Array} rows - Fleet data rows from the current sync push
 * @param {Function} send - IPC send helper: send(channel, payload)
 * @param {object} [opts] - { force: bypass once-per-day + fingerprint guards }
 */
function process(rows, send, opts) {
  if (!rows || !rows.length) return;
  opts = opts || {};

  const result = runAnomalyDetection(rows);
  const alerts = (result && result.alerts) || [];

  // Always push alerts (even empty) so the UI reflects a healthy fleet too.
  send('orcha:alerts', result || { alerts: [], counts: { critical: 0, warning: 0, info: 0 } });

  // ── Morning briefing: fire once per calendar day OR when the actionable
  // picture changed OR when explicitly forced (manual refresh). Unlike the old
  // code, this ALSO fires on a healthy fleet (short "all clear" briefing).
  const dayKey = _todayKey();
  const fp = _briefingFingerprint(rows, alerts);
  const dayChanged = global._briefingDay !== dayKey;
  const fpChanged  = global._briefingFp !== fp;

  if (opts.force || dayChanged || fpChanged) {
    global._briefingDay = dayKey;
    global._briefingFp  = fp;

    // Due reminders (surfaced in the briefing, then cleared).
    const reminderStore = store.load('reminders', []);
    const dueReminders = reminderStore.filter(r => r.when <= dayKey);
    if (dueReminders.length) {
      const remaining = reminderStore.filter(r => r.when > dayKey);
      store.save('reminders', remaining);
    }

    // Fire-and-forget so a slow AI call never blocks the data push.
    _generateAndSendBriefing(rows, alerts, send, { dueReminders })
      .catch(e => logger.warn('[briefing] generate failed: ' + e.message));
  }

  // Generate action recommendations from alerts
  const recs = alerts.filter(a => a.suggestion).map(a => ({
    unit: a.unit,
    type: a.type,
    action: a.suggestion,
    severity: a.severity,
    message: a.message,
  }));
  if (recs.length) send('orcha:recommendations', { recommendations: recs });

  // Detect repair completions (unavail -> available transitions)
  try { repairHistory.detectTransitions(rows, global._prevRows || []); } catch (e) {}
  global._prevRows = rows;

  // System health score
  send('orcha:health', {
    overallScore: Math.max(0, 100 - (recs.filter(a => a.severity === 'critical').length * 5)),
    lastSync: new Date().toISOString(),
    totalUnits: rows.length,
    unavailCount: recs.length,
    integrations: {
      relay: { status: 'green', label: 'Relay' },
      ai:    { status: 'green', label: 'AI' },
      sp:    { status: 'green', label: 'SharePoint' },
      slack: { status: 'green', label: 'Slack' },
    },
  });

  // Proactive AI alerts — check for stalled units and risk jumps
  try {
    const { runProactiveAlerts } = require('./proactive-alerts');
    runProactiveAlerts(rows, { send });
  } catch (e) { /* non-fatal */ }
}

/**
 * refresh(send) — manual regeneration (bypasses the once-per-day + fingerprint
 * guards). Reads the latest fleet rows from the store and regenerates now.
 */
function refresh(send) {
  const fd = store.load('fleetData', {});
  const rows = (fd && fd.rows) || [];
  if (!rows.length) {
    send('orcha:morning-briefing', {
      text: '\u2600\uFE0F No fleet data loaded yet — run a sync first.',
      critical: 0, warnings: 0, generatedBy: 'template', generatedAt: new Date().toISOString(),
    });
    return;
  }
  const result = runAnomalyDetection(rows);
  const alerts = (result && result.alerts) || [];
  const dayKey = _todayKey();
  const reminderStore = store.load('reminders', []);
  const dueReminders = reminderStore.filter(r => r.when <= dayKey);
  // Update guards so the next auto push doesn't immediately regenerate again.
  global._briefingDay = dayKey;
  global._briefingFp  = _briefingFingerprint(rows, alerts);
  return _generateAndSendBriefing(rows, alerts, send, { dueReminders });
}

module.exports = { process, refresh };
