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
// ── AI-authored generation (reasons over the FULL fleet) ─────────────────────
// Compress every unit to ONE dense line of only decision-relevant signals, so
// the whole fleet fits in the prompt and the AI has full-fleet awareness
// without the 2,000-field dump. Returns an array of lines.
const _DOWN = (r) => String(r.lifecycleState || '').toLowerCase().includes('unavail');

function _parseDaysDown(r) {
  const s = String(r.workDuration || r.duration || '').toLowerCase().trim();
  if (!s || s === '--') return null;
  let d = 0;
  const dm = s.match(/(\d+)\s*d/); if (dm) d += parseInt(dm[1], 10);
  const hm = s.match(/(\d+)\s*h/); if (hm) d += parseInt(hm[1], 10) / 24;
  if (!dm && !hm) { const n = parseFloat(s); if (!isNaN(n)) d = n; }
  return d ? Math.round(d) : null;
}

function _unitSignalLine(r) {
  const id = String(r.equipmentId || '').trim();
  if (!id) return null;
  const down = _DOWN(r);
  const parts = [id, down ? 'DOWN' : 'up'];
  if (down) {
    const days = _parseDaysDown(r);
    if (days != null) parts.push(days + 'd');
    const reason = String(r.lifecycleReason || r.issueSummary || r.issueDetails || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (reason) parts.push('"' + reason + '"');
    const vendor = String(r.vendor || '').trim();
    parts.push(vendor && vendor !== '--' ? 'vendor=' + vendor : 'NO-VENDOR');
  }
  const risk = parseInt(r.riskScore, 10);
  if (Number.isFinite(risk) && risk > 0) parts.push('risk=' + risk);
  const dom = String(r.domicileSite || '').trim();
  if (dom) parts.push('@' + dom);
  const due = String(r.dueDate || '').toLowerCase();
  if (due.includes('overdue') || due.includes('past due')) parts.push('PM-OVERDUE');
  // Offsite + how stale the last enrichment is.
  const offsite = r.offsiteShopEvent || r.asistSrUrl || r.offsiteShopEventUrl;
  if (offsite) {
    let age = '';
    if (r.asistScrapedAt) {
      const ageDays = Math.floor((Date.now() - new Date(r.asistScrapedAt).getTime()) / 86400000);
      if (Number.isFinite(ageDays)) age = ';last-update=' + ageDays + 'd-ago';
    } else { age = ';no-update-logged'; }
    parts.push('OFFSITE' + age);
  }
  return parts.join(' ');
}

// Build the fleet snapshot lines (ALL units). Returns array of lines.
function _fleetSnapshotLines() {
  const rows = _fleetRows();
  const lines = [];
  for (const r of rows) { const l = _unitSignalLine(r); if (l) lines.push(l); }
  return lines;
}

const _AI_ATTEMPTS = 2;
const _AI_ATTEMPT_MS = 30000;
const _PROMPT_CHAR_BUDGET = 14000; // per batch of unit lines

function _buildPrompt(lines) {
  return [
    'You are the fleet operations coordinator\'s assistant. Review the ENTIRE fleet snapshot below and produce a PRIORITIZED daily action list that minimizes vehicle downtime.',
    '',
    'Each unit is one line of signals:',
    '  <id> <up|DOWN> [<days>d] ["reason"] [vendor=X|NO-VENDOR] [risk=N] [@domicile] [PM-OVERDUE] [OFFSITE;last-update=Nd-ago|;no-update-logged]',
    '',
    'FLEET SNAPSHOT (every unit; use ONLY this data — never invent a unit, number, vendor, or date):',
    lines.join('\n'),
    '',
    'Decide which units genuinely need action and write as many actions as the priorities warrant (do not pad; do not cap artificially). Favor actions that reduce downtime: assign a vendor to a DOWN unit with NO-VENDOR; follow up / escalate units down many days or stale OFFSITE with no recent update; chase overdue PM; preventive attention on high risk.',
    '',
    'Respond with ONLY a JSON array (no prose, no code fences). Each item:',
    '{"unitId":"<id>","action":"<short_slug e.g. assign_vendor|follow_up|escalate|schedule_pm|preventive_wr|chase_offsite|update_status>","urgency":"high|medium|low","text":"<one concise action sentence a coordinator would do today>","reason":"<the grounding fact from the snapshot>"}',
    'Order the array by priority (highest first). If nothing needs action, return [].',
  ].join('\n');
}

function _parseAiActions(raw) {
  if (!raw) return [];
  let txt = String(raw).trim();
  // Strip code fences if present.
  txt = txt.replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  // Extract the first JSON array if there's surrounding prose.
  const start = txt.indexOf('[');
  const end = txt.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(txt.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && (x.unitId || x.text))
      .map((x) => ({
        unitId: String(x.unitId || '').trim(),
        action: String(x.action || 'action').trim().toLowerCase().replace(/\s+/g, '_').slice(0, 40),
        urgency: ['high', 'medium', 'low'].includes(String(x.urgency || '').toLowerCase()) ? String(x.urgency).toLowerCase() : 'medium',
        text: String(x.text || '').trim().slice(0, 300),
        reason: String(x.reason || '').trim().slice(0, 300),
      }))
      .filter((x) => x.text || x.unitId);
  } catch (_) { return []; }
}

async function _askAIOnce(prompt) {
  const relay = require('../orcha/relay');
  const raw = await Promise.race([
    relay.ask(prompt),
    new Promise((_, rej) => setTimeout(() => rej(new Error('ai-timeout')), _AI_ATTEMPT_MS)),
  ]);
  return (typeof raw === 'string') ? raw : (raw && raw.text ? String(raw.text) : '');
}

// Reasons over the full fleet. Batches the snapshot if it exceeds the prompt
// budget (every unit is still covered). 2 attempts x 30s per batch. Returns the
// merged action-candidate array, or null if AI produced nothing usable.
async function _generateViaAI() {
  const lines = _fleetSnapshotLines();
  if (!lines.length) return null;

  // Split into batches that fit the budget (full-fleet coverage preserved).
  const batches = [];
  let cur = [], curLen = 0;
  for (const l of lines) {
    if (curLen + l.length + 1 > _PROMPT_CHAR_BUDGET && cur.length) { batches.push(cur); cur = []; curLen = 0; }
    cur.push(l); curLen += l.length + 1;
  }
  if (cur.length) batches.push(cur);

  const all = [];
  let anySuccess = false;
  for (let b = 0; b < batches.length; b++) {
    const prompt = _buildPrompt(batches[b]);
    let got = null;
    for (let attempt = 1; attempt <= _AI_ATTEMPTS && got === null; attempt++) {
      try {
        const txt = await _askAIOnce(prompt);
        const actions = _parseAiActions(txt);
        got = actions; // parsed (possibly empty) = this batch succeeded
        anySuccess = true;
        logger.info('[tasks] AI batch ' + (b + 1) + '/' + batches.length + ': ' + actions.length + ' action(s) from ' + batches[b].length + ' units (attempt ' + attempt + ')');
      } catch (e) {
        logger.warn('[tasks] AI batch ' + (b + 1) + '/' + batches.length + ' attempt ' + attempt + '/' + _AI_ATTEMPTS + ' failed (' + e.message + ')');
        if (attempt < _AI_ATTEMPTS) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (got) all.push(...got);
  }

  // If every batch failed (none parsed), signal failure so the caller falls
  // back to rules. If at least one batch succeeded we accept the result (even
  // if some batches returned []).
  if (!anySuccess) return null;
  return all;
}

// Merge a list of candidate actions into the persisted AI task list. A
// candidate = { unitId, action, urgency, text, reason, icon? }. This is the
// source-agnostic part: dedupe by unit+action, preserve prior done/dismissed/
// createdAt, auto-clear undone resolved tasks (keep done ones <2 days). Manual
// tasks are never touched. `source` tags where the candidates came from.
function _mergeCandidates(candidates, sourceTag) {
  const s = _load();
  const prevByKey = new Map(s.ai.map((t) => [t.dedupeKey, t]));
  const now = new Date().toISOString();
  const nextAi = [];
  const seen = new Set();

  for (const c of candidates) {
    const unitId = String(c.unitId || '').trim();
    const action = String(c.action || 'action').trim();
    const key = unitId + ':' + action;
    if (seen.has(key)) continue;
    seen.add(key);
    const prev = prevByKey.get(key);
    nextAi.push({
      id: prev ? prev.id : _genId('ai'),
      source: 'ai',
      text: c.text || (c.reason || action) + (unitId ? ' (' + unitId + ')' : ''),
      unitId,
      action,
      urgency: c.urgency || 'medium',
      reason: c.reason || '',
      suggestion: c.suggestion || c.text || '',
      icon: c.icon || '',
      due: prev ? prev.due || null : null,
      done: prev ? !!prev.done : false,
      dismissed: prev ? !!prev.dismissed : false,
      createdAt: prev ? prev.createdAt : now,
      updatedAt: now,
      dedupeKey: key,
    });
  }

  // Keep recently-done tasks that fell out so the user still sees them ticked
  // off today; drop undone ones that resolved (auto-clear).
  for (const t of s.ai) {
    if (seen.has(t.dedupeKey)) continue;
    if (t.done && !t.dismissed) {
      if (!t.resolvedAt) t.resolvedAt = now;
      const ageMs = Date.now() - Date.parse(t.resolvedAt || now);
      if (ageMs < 2 * 24 * 60 * 60 * 1000) nextAi.push(t);
    }
  }

  if (nextAi.length > AI_MAX) nextAi.length = AI_MAX;
  s.ai = nextAi;
  s.lastGeneratedAt = now;
  s.lastGenSource = sourceTag;
  _save(s);
  return s;
}

// Rule-based candidates (the fallback when AI is unavailable/slow). Maps
// runRecommendations output to the candidate shape.
function _ruleCandidates() {
  try {
    const { runRecommendations } = require('../orcha/recommend');
    const out = runRecommendations(_fleetRows());
    return (out && out.recommendations || []).map((r) => {
      const unitId = r.unit || (r.payload && r.payload.unitId) || '';
      const meta = r.meta || {};
      return {
        unitId,
        action: r.action || 'action',
        urgency: meta.urgency || 'medium',
        icon: meta.icon || '',
        text: (meta.label ? meta.label + ': ' : '') + (r.suggestion || r.reason || r.action) + (unitId ? ' (' + unitId + ')' : ''),
        reason: r.reason || '',
        suggestion: r.suggestion || '',
      };
    });
  } catch (e) {
    logger.warn('[tasks] rule engine failed: ' + e.message);
    return [];
  }
}

// Main generation: AI-authored over the FULL fleet, with a rule-based fallback.
async function _generate() {
  let aiCandidates = null;
  try {
    aiCandidates = await _generateViaAI();
  } catch (e) {
    logger.warn('[tasks] AI generation threw: ' + e.message);
    aiCandidates = null;
  }

  if (aiCandidates && aiCandidates.length) {
    const s = _mergeCandidates(aiCandidates, 'ai');
    logger.info('[tasks] AI generation: ' + s.ai.filter((t) => !t.done && !t.dismissed).length + ' active task(s) (AI-authored)');
    return s;
  }

  // AI unavailable/empty/timed out -> rule-based fallback so the board is never
  // empty. The next scheduled/manual run retries AI.
  const s = _mergeCandidates(_ruleCandidates(), 'fallback');
  logger.info('[tasks] AI unavailable — used rule-based fallback (' + s.ai.filter((t) => !t.done && !t.dismissed).length + ' active); will retry AI next run');
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
    const s = await _generate();
    // Mark today's generation done so the morning scheduler won't re-run —
    // but ONLY if the AI path actually produced the list; if we fell back to
    // rules, leave the day unmarked so the morning tick retries AI.
    if (s.lastGenSource === 'ai') {
      s.lastGeneratedDay = _todayInZone(DEFAULT_TZ);
      _save(s);
    }
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

let _tickRunning = false;
async function _tick() {
  if (_tickRunning) return; // AI generation can take a while — never overlap
  try {
    const s = _load();
    const today = _todayInZone(DEFAULT_TZ);
    if (s.lastGeneratedDay === today) return;        // already generated today
    if (_hourInZone(DEFAULT_TZ) < MORNING_HOUR) return; // wait until morning
    _tickRunning = true;
    logger.info('[tasks] morning auto-generation for ' + today);
    const ns = await _generate();
    // Only mark the day done if AI actually authored the list; a rule-based
    // fallback leaves the day open so the next tick retries AI.
    if (ns.lastGenSource === 'ai') {
      ns.lastGeneratedDay = today;
      _save(ns);
    }
  } catch (e) {
    logger.warn('[tasks] scheduler tick failed: ' + e.message);
  } finally {
    _tickRunning = false;
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
