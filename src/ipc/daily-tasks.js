'use strict';
/**
 * ipc/daily-tasks.js — Daily Task / Action Board.
 *
 * Replaces the former Workflow Intelligence recorder/library (Phase 8). The
 * "Workflow AI" tab is now a daily task board that blends:
 *   - AI-SUGGESTED actions, generated from the live fleet to minimize downtime
 *     (follow-ups, escalations, unassigned vendors, preventive WRs, overdue PM,
 *     stale/undocumented repairs, close-outs). Grounded in real unit data via
 *     src/orcha/recommend.js runRecommendations() — never invents a unit.
 *   - MANUAL tasks the user adds (text + optional due date + optional unit).
 *
 * Rules (set by the user):
 *   - AI tasks regenerate each morning (scheduler) and on demand (Generate btn).
 *   - A generation run NEVER removes or alters manual tasks.
 *   - AI tasks PERSIST across runs (dedupe by unit+action), keep their done/
 *     dismissed state, and AUTO-CLEAR when the underlying issue no longer
 *     qualifies (the unit dropped out of the recommendations).
 *
 * Store: 'dailyTasks' = { ai: [task], manual: [task], lastGeneratedDay,
 *   lastGeneratedAt }. task = { id, source, text, unitId?, action?, urgency?,
 *   due?, done, dismissed, createdAt, resolvedAt?, dedupeKey }.
 */

const store = require('../store');
const logger = require('../utils/logger')('daily-tasks');
const { handle, requireString, requireObject } = require('./_safe');
const { ConfigError } = require('../utils/errors');

const DEFAULT_TZ = 'America/New_York';
const MANUAL_MAX = 500;
const AI_MAX = 300;

// ── Store helpers ─────────────────────────────────────────────────────────────
function _load() {
  const s = store.load('dailyTasks', null);
  if (s && typeof s === 'object') {
    return {
      ai: Array.isArray(s.ai) ? s.ai : [],
      manual: Array.isArray(s.manual) ? s.manual : [],
      lastGeneratedDay: s.lastGeneratedDay || null,
      lastGeneratedAt: s.lastGeneratedAt || null,
    };
  }
  return { ai: [], manual: [], lastGeneratedDay: null, lastGeneratedAt: null };
}
function _save(s) { store.save('dailyTasks', s); }

function _genId(prefix) {
  return (prefix || 't') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Current date 'YYYY-MM-DD' in a tz (Intl so it's independent of host clock).
function _todayInZone(tz) {
  try {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz || DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
    return `${p.year}-${p.month}-${p.day}`;
  } catch (_) {
    const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
}

// ── Fleet rows (grounding source) ─────────────────────────────────────────────
function _fleetRows() {
  try {
    const fd = store.load('fleetData', {}) || {};
    return Array.isArray(fd.rows) ? fd.rows : [];
  } catch (_) { return []; }
}

// ── AI generation ─────────────────────────────────────────────────────────────
// Runs the recommendation engine over the live fleet and MERGES the result into
// the persisted AI task list:
//   - dedupeKey = unitId + ':' + action  (one task per unit+action)
//   - existing task with the same key keeps its done/dismissed/createdAt
//   - a task whose key is no longer recommended AND isn't done is auto-cleared
//     (issue resolved); done ones are kept briefly so the user sees it as done.
// Manual tasks are never touched here.
function _generate() {
  const rows = _fleetRows();
  let recs = [];
  try {
    const { runRecommendations } = require('../orcha/recommend');
    const out = runRecommendations(rows);
    recs = (out && out.recommendations) || [];
  } catch (e) {
    logger.warn('[tasks] recommendation engine failed: ' + e.message);
    recs = [];
  }

  const s = _load();
  const prevByKey = new Map(s.ai.map((t) => [t.dedupeKey, t]));
  const now = new Date().toISOString();
  const nextAi = [];
  const seen = new Set();

  for (const r of recs) {
    const unitId = r.unit || (r.payload && r.payload.unitId) || '';
    const action = r.action || 'action';
    const key = unitId + ':' + action;
    if (seen.has(key)) continue; // one task per unit+action
    seen.add(key);
    const meta = r.meta || {};
    const text = (meta.label ? meta.label + ': ' : '') +
      (r.suggestion || r.reason || action) +
      (unitId ? ' (' + unitId + ')' : '');
    const prev = prevByKey.get(key);
    nextAi.push({
      id: prev ? prev.id : _genId('ai'),
      source: 'ai',
      text,
      unitId,
      action,
      urgency: meta.urgency || 'medium',
      reason: r.reason || '',
      suggestion: r.suggestion || '',
      icon: meta.icon || '',
      due: prev ? prev.due || null : null,
      done: prev ? !!prev.done : false,
      dismissed: prev ? !!prev.dismissed : false,
      createdAt: prev ? prev.createdAt : now,
      updatedAt: now,
      dedupeKey: key,
    });
  }

  // Keep recently-done AI tasks that fell out of the recommendations so the
  // user still sees them ticked off today; drop undone ones that resolved.
  for (const t of s.ai) {
    if (seen.has(t.dedupeKey)) continue;
    if (t.done && !t.dismissed) {
      // resolved + done — keep but mark resolved; prune on next generation if stale.
      if (!t.resolvedAt) t.resolvedAt = now;
      // Drop if it was resolved more than ~2 days ago (keeps the list clean).
      const ageMs = Date.now() - Date.parse(t.resolvedAt || now);
      if (ageMs < 2 * 24 * 60 * 60 * 1000) nextAi.push(t);
    }
    // undone + no longer recommended -> auto-cleared (issue resolved): drop it.
  }

  if (nextAi.length > AI_MAX) nextAi.length = AI_MAX;
  s.ai = nextAi;
  s.lastGeneratedAt = now;
  _save(s);
  logger.info('[tasks] AI generation: ' + nextAi.length + ' task(s) from ' + recs.length + ' recommendation(s)');
  return s;
}

// ── IPC ───────────────────────────────────────────────────────────────────────
function registerDailyTasksIPC(ctx) {
  handle('tasks:list', async () => {
    return _load();
  });

  // Add a manual task: { text, due?, unitId? }
  handle('tasks:add-manual', async (_e, data) => {
    requireObject(data, 'data');
    const text = String(data.text || '').trim();
    if (!text) throw new ConfigError('Task text is required', 'text');
    const s = _load();
    const now = new Date().toISOString();
    s.manual.unshift({
      id: _genId('man'),
      source: 'manual',
      text,
      unitId: data.unitId ? String(data.unitId).trim() : '',
      due: data.due ? String(data.due) : null,
      done: false,
      dismissed: false,
      createdAt: now,
      updatedAt: now,
    });
    if (s.manual.length > MANUAL_MAX) s.manual.length = MANUAL_MAX;
    _save(s);
    return s;
  });

  // Update any task (ai or manual): { id, done?, text?, due? }
  handle('tasks:update', async (_e, data) => {
    requireObject(data, 'data');
    const id = String(data.id || '');
    if (!id) throw new ConfigError('Task id is required', 'id');
    const s = _load();
    const now = new Date().toISOString();
    const apply = (t) => {
      if (!t) return false;
      if (data.done !== undefined) { t.done = !!data.done; t.resolvedAt = t.done ? now : null; }
      if (data.text !== undefined && t.source === 'manual') t.text = String(data.text).trim() || t.text;
      if (data.due !== undefined) t.due = data.due ? String(data.due) : null;
      t.updatedAt = now;
      return true;
    };
    let hit = apply(s.manual.find((t) => t.id === id)) || apply(s.ai.find((t) => t.id === id));
    if (!hit) throw new ConfigError('Task not found: ' + id, 'id');
    _save(s);
    return s;
  });

  // Delete a manual task, or dismiss an AI task (AI tasks regenerate, so a hard
  // delete would just come back — dismiss keeps it suppressed this cycle).
  handle('tasks:delete', async (_e, id) => {
    requireString(id, 'id');
    const s = _load();
    const before = s.manual.length;
    s.manual = s.manual.filter((t) => t.id !== id);
    if (s.manual.length === before) {
      const ai = s.ai.find((t) => t.id === id);
      if (ai) { ai.dismissed = true; ai.updatedAt = new Date().toISOString(); }
    }
    _save(s);
    return s;
  });

  // Generate AI tasks now (manual "Generate" button). Never touches manual.
  handle('tasks:generate', async () => {
    const s = _generate();
    // Mark today's generation done so the morning scheduler won't re-run.
    const tz = DEFAULT_TZ;
    s.lastGeneratedDay = _todayInZone(tz);
    _save(s);
    return s;
  });

  // Start the once-a-morning scheduler (mirrors FAS / carrier-briefing: 60s
  // tick, unref'd, fires once per day). Generates in the morning window if it
  // hasn't already run today. Dedup via lastGeneratedDay so a restart/re-open
  // never double-generates.
  _startScheduler();

  logger.info('Daily Tasks IPC handlers registered');
}

// ── Scheduler ───────────────────────────────────────────────────────────────
let _timer = null;
const MORNING_HOUR = 7; // local (DEFAULT_TZ) hour to generate the day's tasks

function _hourInZone(tz) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz || DEFAULT_TZ, hour: '2-digit', hour12: false })
      .formatToParts(new Date()).find((x) => x.type === 'hour');
    const h = p ? parseInt(p.value, 10) : new Date().getHours();
    return h === 24 ? 0 : h;
  } catch (_) { return new Date().getHours(); }
}

function _tick() {
  try {
    const s = _load();
    const today = _todayInZone(DEFAULT_TZ);
    if (s.lastGeneratedDay === today) return;        // already generated today
    if (_hourInZone(DEFAULT_TZ) < MORNING_HOUR) return; // wait until morning
    logger.info('[tasks] morning auto-generation for ' + today);
    const ns = _generate();
    ns.lastGeneratedDay = today;
    _save(ns);
  } catch (e) {
    logger.warn('[tasks] scheduler tick failed: ' + e.message);
  }
}

function _startScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _timer = setInterval(_tick, 60 * 1000);
  if (_timer.unref) _timer.unref();
  // Run one tick shortly after start so a late-morning launch still generates.
  setTimeout(() => { try { _tick(); } catch (_) {} }, 8000);
  logger.info('[tasks] morning scheduler started (generates ~' + MORNING_HOUR + ':00 ' + DEFAULT_TZ + ')');
}

module.exports = { registerDailyTasksIPC };
