/**
 * workflow-intelligence.js — "Workflow AI" tab, repurposed (2026-10) into a
 * daily Task / Action board.
 *
 * Two sections:
 *   - AI Suggested Actions: downtime-minimizing actions generated from the live
 *     fleet (follow-ups, escalations, unassigned vendors, preventive WRs,
 *     overdue PM, undocumented repairs, close-outs). Grounded in real units.
 *     Generated each morning + on demand via the Generate button.
 *   - My Tasks: manual to-dos (text + optional due date + optional unit).
 *
 * Keeps the same mount contract as before: export init(container) building
 * #view-workflow-intel. The old recorder/library/editor is gone.
 */

import bus   from '../bus.js';
import state from '../state.js';
import { dailyTasks } from '../bridge.js';

let _el = null;
let _data = { ai: [], manual: [], lastGeneratedAt: null };

const _esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const URGENCY_ORDER = { high: 0, medium: 1, low: 2 };
const URGENCY_LABEL = { high: '🚨 High priority', medium: '⚠️ Needs attention', low: 'ℹ️ When you can' };

// -- Data ---------------------------------------------------------------------
async function _load() {
  try {
    _data = await dailyTasks.list();
  } catch (e) {
    _data = { ai: [], manual: [], lastGeneratedAt: null };
    bus.emit('ui:toast', { type: 'error', message: 'Failed to load tasks: ' + e.message });
  }
  _render();
}

// Resolve a unit id to its fleet row so we can navigate to it.
function _navigateToUnit(unitId) {
  if (!unitId) return;
  const rows = (state.slice('fleet').rows) || [];
  const row = rows.find((r) => String(r.equipmentId || '') === String(unitId));
  bus.emit('ui:view-change', { from: 'workflow-intel', to: 'fleet' });
  if (row) setTimeout(() => bus.emit('ui:unit-select', { unit: row }), 60);
}

// -- Rendering ----------------------------------------------------------------
function _render() {
  if (!_el) return;

  // AI tasks: visible = not dismissed. Sort: undone first, then urgency.
  const ai = (_data.ai || [])
    .filter((t) => !t.dismissed)
    .sort((a, b) => {
      if (!!a.done !== !!b.done) return a.done ? 1 : -1;
      return (URGENCY_ORDER[a.urgency] ?? 1) - (URGENCY_ORDER[b.urgency] ?? 1);
    });

  // Group AI by urgency for the undone ones.
  const groups = { high: [], medium: [], low: [] };
  const doneAi = [];
  for (const t of ai) {
    if (t.done) { doneAi.push(t); continue; }
    (groups[t.urgency] || groups.medium).push(t);
  }

  const aiCount = ai.filter((t) => !t.done).length;
  const lastGen = _data.lastGeneratedAt ? new Date(_data.lastGeneratedAt).toLocaleString() : 'never';

  let aiHtml = '';
  for (const u of ['high', 'medium', 'low']) {
    if (!groups[u].length) continue;
    aiHtml += `<div class="tb-group-label">${URGENCY_LABEL[u]}</div>` +
      groups[u].map((t) => _aiRow(t)).join('');
  }
  if (doneAi.length) {
    aiHtml += `<div class="tb-group-label tb-group-label--done">✓ Done today</div>` +
      doneAi.map((t) => _aiRow(t)).join('');
  }
  if (!aiHtml) {
    aiHtml = `<div class="tb-empty">No AI actions right now — everything that needs attention is clear. Click <strong>Generate</strong> to re-check.</div>`;
  }

  const manual = (_data.manual || []);
  const manualHtml = manual.length
    ? manual.map((t) => _manualRow(t)).join('')
    : `<div class="tb-empty">No personal tasks yet. Add one below.</div>`;

  _el.innerHTML = `
    <div class="tb-header">
      <h2 class="tb-title">🧠 Workflow AI</h2>
      <span class="tb-sub">${aiCount} action${aiCount === 1 ? '' : 's'} to review</span>
      <div style="flex:1"></div>
      <span class="tb-lastgen">AI last generated: ${_esc(lastGen)}</span>
      <button id="tb-generate" class="tb-btn tb-btn--primary">⟳ Generate</button>
    </div>
    <div class="tb-body">
      <section class="tb-section">
        <div class="tb-section-title">AI Suggested Actions</div>
        <div id="tb-ai-list" class="tb-list">${aiHtml}</div>
      </section>
      <section class="tb-section">
        <div class="tb-section-title">My Tasks</div>
        <div class="tb-add">
          <input id="tb-add-text" class="tb-input" type="text" placeholder="Add a task…" autocomplete="off" />
          <input id="tb-add-unit" class="tb-input tb-input--unit" type="text" placeholder="Unit # (optional)" autocomplete="off" />
          <input id="tb-add-due" class="tb-input tb-input--due" type="date" title="Due date (optional)" />
          <button id="tb-add-btn" class="tb-btn tb-btn--primary">Add</button>
        </div>
        <div id="tb-manual-list" class="tb-list">${manualHtml}</div>
      </section>
    </div>
    ${_styles()}
  `;

  _wire();
}

function _aiRow(t) {
  const unit = t.unitId ? `<a class="tb-unit" data-unit="${_esc(t.unitId)}">${_esc(t.unitId)}</a>` : '';
  const reason = t.reason ? `<div class="tb-reason">${_esc(t.reason)}</div>` : '';
  // "Do it" button on actionable, not-done AI tasks that reference a unit.
  const doBtn = (!t.done && t.unitId && t.action)
    ? `<button class="tb-do" data-id="${_esc(t.id)}" data-action="${_esc(t.action)}" data-unit="${_esc(t.unitId)}" title="Take this action">Do it</button>`
    : '';
  return `
    <div class="tb-task ${t.done ? 'tb-task--done' : ''} tb-task--${_esc(t.urgency || 'medium')}" data-id="${_esc(t.id)}">
      <input type="checkbox" class="tb-check" data-id="${_esc(t.id)}" ${t.done ? 'checked' : ''} />
      <div class="tb-task-main">
        <div class="tb-task-text">${t.icon ? _esc(t.icon) + ' ' : ''}${_esc(t.suggestion || t.text)} ${unit}</div>
        ${reason}
      </div>
      ${doBtn}
      <button class="tb-x" data-id="${_esc(t.id)}" title="Dismiss">✕</button>
    </div>`;
}

function _manualRow(t) {
  const unit = t.unitId ? `<a class="tb-unit" data-unit="${_esc(t.unitId)}">${_esc(t.unitId)}</a>` : '';
  const due = t.due ? `<span class="tb-due ${_isOverdue(t) ? 'tb-due--over' : ''}">📅 ${_esc(t.due)}</span>` : '';
  return `
    <div class="tb-task ${t.done ? 'tb-task--done' : ''}" data-id="${_esc(t.id)}">
      <input type="checkbox" class="tb-check" data-id="${_esc(t.id)}" ${t.done ? 'checked' : ''} />
      <div class="tb-task-main">
        <div class="tb-task-text">${_esc(t.text)} ${unit}</div>
        ${due}
      </div>
      <button class="tb-x" data-id="${_esc(t.id)}" title="Delete">✕</button>
    </div>`;
}

function _isOverdue(t) {
  if (!t.due || t.done) return false;
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return new Date(t.due + 'T00:00:00') < today;
  } catch (_) { return false; }
}

// -- Wiring -------------------------------------------------------------------
function _wire() {
  const gen = _el.querySelector('#tb-generate');
  if (gen) gen.addEventListener('click', async () => {
    gen.disabled = true; const orig = gen.textContent; gen.textContent = 'Generating…';
    try {
      _data = await dailyTasks.generate();
      _render();
      bus.emit('ui:toast', { type: 'success', message: 'AI actions refreshed' });
    } catch (e) {
      bus.emit('ui:toast', { type: 'error', message: 'Generate failed: ' + e.message });
      gen.disabled = false; gen.textContent = orig;
    }
  });

  const addBtn = _el.querySelector('#tb-add-btn');
  const addText = _el.querySelector('#tb-add-text');
  const addUnit = _el.querySelector('#tb-add-unit');
  const addDue = _el.querySelector('#tb-add-due');
  const doAdd = async () => {
    const text = (addText.value || '').trim();
    if (!text) { addText.focus(); return; }
    try {
      _data = await dailyTasks.addManual({ text, unitId: (addUnit.value || '').trim(), due: addDue.value || null });
      _render();
    } catch (e) {
      bus.emit('ui:toast', { type: 'error', message: 'Add failed: ' + e.message });
    }
  };
  if (addBtn) addBtn.addEventListener('click', doAdd);
  if (addText) addText.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });

  // Checkboxes (done toggle) for both AI + manual.
  _el.querySelectorAll('.tb-check').forEach((cb) => {
    cb.addEventListener('change', async (e) => {
      try { _data = await dailyTasks.update({ id: e.target.dataset.id, done: e.target.checked }); _render(); }
      catch (err) { bus.emit('ui:toast', { type: 'error', message: 'Update failed: ' + err.message }); }
    });
  });

  // Dismiss (AI) / delete (manual).
  _el.querySelectorAll('.tb-x').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try { _data = await dailyTasks.remove(btn.dataset.id); _render(); }
      catch (err) { bus.emit('ui:toast', { type: 'error', message: 'Remove failed: ' + err.message }); }
    });
  });

  // Unit links -> navigate to the unit in the fleet view.
  _el.querySelectorAll('.tb-unit').forEach((a) => {
    a.addEventListener('click', () => _navigateToUnit(a.dataset.unit));
  });

  // "Do it" -> MODE A deep-link (default) or MODE B one-click execute (per-action
  // toggle). Every live mutation stays behind a confirm or an existing gated flow.
  _el.querySelectorAll('.tb-do').forEach((btn) => {
    btn.addEventListener('click', () => _doAction(btn.dataset.id, btn.dataset.action, btn.dataset.unit, btn));
  });
}

// Resolve a unit row object (needed by the WR modal / dealer-WO flows).
function _unitRow(unitId) {
  const rows = (state.slice('fleet').rows) || [];
  return rows.find((r) => String(r.equipmentId || '') === String(unitId)) || null;
}

async function _doAction(taskId, action, unitId, btn) {
  action = String(action || '').toLowerCase();
  // Check the per-action MODE A/B config.
  let auto = false;
  try {
    const cfg = await dailyTasks.getActionConfig();
    auto = !!(cfg && cfg.autoExecute && cfg.autoExecute[action]);
  } catch (_) {}

  // MODE B — one-click execute behind a single YES confirm.
  if (auto) {
    if (!window.confirm('Execute "' + action.replace(/_/g, ' ') + '" for ' + unitId + ' now?\nThis performs the action (live). Relay/WR writes are still confirm/stage-gated downstream.')) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    try {
      const r = await dailyTasks.executeAction(taskId);
      if (r && r.ok) {
        bus.emit('ui:toast', { type: 'success', message: r.message || 'Done', duration: 3500 });
        _data = await dailyTasks.list(); _render();
      } else {
        bus.emit('ui:toast', { type: 'warning', message: (r && r.error) || 'Could not execute — opening the in-app flow instead.', duration: 4000 });
        _deepLink(action, unitId); // fall back to MODE A if no executor
        if (btn) { btn.disabled = false; btn.textContent = 'Do it'; }
      }
    } catch (e) {
      bus.emit('ui:toast', { type: 'error', message: 'Execute failed: ' + (e.message || e), duration: 4000 });
      if (btn) { btn.disabled = false; btn.textContent = 'Do it'; }
    }
    return;
  }

  // MODE A — deep-link into the existing confirm-gated flow.
  _deepLink(action, unitId);
}

// Route an action slug to the right EXISTING in-app flow (all confirm-gated).
async function _deepLink(action, unitId) {
  const row = _unitRow(unitId);
  if (['create_wr', 'preventive_wr'].includes(action)) {
    if (!row) { bus.emit('ui:toast', { type: 'warning', message: unitId + ' not in fleet data — sync first', duration: 3000 }); return; }
    try {
      const mod = await import('./wr-modal.js');
      (mod.open || mod.openWRModal)(row);
    } catch (e) { bus.emit('ui:toast', { type: 'error', message: 'Could not open WR form: ' + e.message }); }
    return;
  }
  if (action === 'assign_vendor') {
    bus.emit('ui:view-change', { from: 'workflow-intel', to: 'fleet' });
    if (row) setTimeout(() => { bus.emit('ui:unit-select', { unit: row }); bus.emit('ui:dealer-wo-request', { unit: row }); }, 80);
    return;
  }
  if (['follow_up', 'escalate', 'chase_offsite', 'update_status'].includes(action)) {
    // Stage a Relay↔Offsite reconcile update for this unit, then open the 🔁
    // review overlay so the user can confirm the post.
    try {
      bus.emit('ui:toast', { type: 'info', message: 'Reasoning over ' + unitId + '…', duration: 2000 });
      if (window.relayReconcile && window.relayReconcile.runUnit) await window.relayReconcile.runUnit(unitId);
      bus.emit('ui:relay-reconcile-toggle');
    } catch (e) { bus.emit('ui:toast', { type: 'error', message: 'Reconcile failed: ' + e.message }); }
    return;
  }
  // schedule_pm / anything else -> just open the unit so the user can act.
  _navigateToUnit(unitId);
}

// -- Styles -------------------------------------------------------------------
function _styles() {
  return `<style>
    .view--workflow-intel { background:#0d1117; }
    .tb-header { display:flex; align-items:center; gap:12px; padding:16px 20px; border-bottom:1px solid rgba(240,246,252,.08); flex-wrap:wrap; }
    .tb-title { margin:0; font-size:16px; color:#e6edf3; }
    .tb-sub { font-size:12px; color:#8b949e; }
    .tb-lastgen { font-size:11px; color:#6e7681; }
    .tb-btn { border:none; border-radius:6px; padding:7px 14px; font-size:12px; cursor:pointer; }
    .tb-btn--primary { background:rgba(88,166,255,.15); border:1px solid rgba(88,166,255,.35); color:#58a6ff; }
    .tb-btn--primary:hover { background:rgba(88,166,255,.25); }
    .tb-btn:disabled { opacity:.5; cursor:default; }
    .tb-body { flex:1; overflow-y:auto; padding:16px 20px 28px; display:flex; flex-direction:column; gap:22px; }
    .tb-section-title { font-size:12px; font-weight:700; letter-spacing:.5px; text-transform:uppercase; color:#8b949e; margin-bottom:10px; }
    .tb-list { display:flex; flex-direction:column; gap:7px; }
    .tb-group-label { font-size:11px; color:#8b949e; margin:10px 0 2px; }
    .tb-group-label--done { color:#3fb950; }
    .tb-empty { color:#8b949e; font-size:13px; padding:18px; text-align:center; background:rgba(255,255,255,.02); border:1px dashed rgba(240,246,252,.1); border-radius:8px; }
    .tb-task { display:flex; align-items:flex-start; gap:10px; background:rgba(255,255,255,.03); border:1px solid rgba(240,246,252,.08); border-radius:8px; padding:9px 11px; }
    .tb-task--high { border-left:3px solid #f85149; }
    .tb-task--medium { border-left:3px solid #f0a800; }
    .tb-task--low { border-left:3px solid #3fb950; }
    .tb-task--done { opacity:.5; }
    .tb-task--done .tb-task-text { text-decoration:line-through; }
    .tb-check { margin-top:2px; width:15px; height:15px; cursor:pointer; flex:none; }
    .tb-task-main { flex:1; min-width:0; }
    .tb-task-text { font-size:13px; color:#e6edf3; line-height:1.4; }
    .tb-reason { font-size:11px; color:#8b949e; margin-top:3px; }
    .tb-due { font-size:11px; color:#8b949e; margin-top:3px; display:inline-block; }
    .tb-due--over { color:#f85149; }
    .tb-unit { color:#58a6ff; cursor:pointer; text-decoration:none; font-weight:600; }
    .tb-unit:hover { text-decoration:underline; }
    .tb-x { background:transparent; border:none; color:#6e7681; font-size:13px; cursor:pointer; flex:none; padding:0 2px; }
    .tb-x:hover { color:#f85149; }
    .tb-do { background:rgba(88,166,255,.14); border:1px solid rgba(88,166,255,.4); color:#58a6ff; font-size:11px; font-weight:600; border-radius:6px; padding:5px 12px; cursor:pointer; flex:none; white-space:nowrap; }
    .tb-do:hover { background:rgba(88,166,255,.24); }
    .tb-do:disabled { opacity:.6; cursor:default; }
    .tb-add { display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
    .tb-input { background:rgba(255,255,255,.06); border:1px solid rgba(240,246,252,.12); border-radius:6px; color:#e6edf3; font-size:12px; padding:7px 10px; outline:none; }
    #tb-add-text { flex:1; min-width:180px; }
    .tb-input--unit { width:130px; }
    .tb-input--due { width:150px; color-scheme:dark; }
  </style>`;
}

// -- Mount --------------------------------------------------------------------
export function init(container) {
  _el = document.createElement('div');
  _el.id = 'view-workflow-intel';
  _el.className = 'view view--workflow-intel';
  _el.style.cssText = 'display:none; flex-direction:column; height:100%; overflow:hidden;';
  container.appendChild(_el);

  // Load whenever this view is opened (consistent with other views).
  bus.on('ui:view-change', ({ to }) => { if (to === 'workflow-intel') _load(); });

  // Initial empty render so the shell exists before first open.
  _render();
}
