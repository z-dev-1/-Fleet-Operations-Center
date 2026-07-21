/**
 * workflow-intelligence.js -- Workflow Intelligence: Library + Editor view [Phase 8, Phase 1]
 *
 * See docs/PHASE8_WORKFLOW_INTELLIGENCE_PLAN.md for the full design.
 *
 * Scope of this file (Phase 1 UI):
 *   - Library: search / category filter / favorites-only / tag chips / import
 *   - Card actions: favorite toggle, edit, export, delete
 *   - Editor: rename/describe/tag, reorder steps (up/down), delete steps,
 *     add a delay step. "Add condition" / "Add loop" / "Variables" are
 *     present as discoverable buttons but intentionally show a "coming
 *     soon" toast rather than silently doing nothing -- full branching/loop
 *     editing is a larger follow-up piece, not faked here.
 *
 * NOT in scope here (later chunks, per the design doc's phased rollout):
 *   - Visual flowchart/branch-line canvas (still a flat reorderable list for now)
 *   - Run/Execute (Phase 4 -- orchestrator RUN_WORKFLOW intent doesn't exist yet)
 *   - Execution History tab (reads workflowExecutionLog, which is empty until Phase 4)
 */

import bus   from '../bus.js';
import { workflowIntel } from '../bridge.js';

let _el = null;
let _library = [];
let _filter = { search: '', category: '', favoriteOnly: false };
let _editing = null; // full WorkflowRecording object while the editor overlay is open

const _esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STEP_ICON = {
  app_open: '\u{1F5A5}', click: '\u{1F5B1}', type: '\u2328', select: '\u25BE', wait: '\u23F3',
  search: '\u{1F50D}', create_wr: '\u{1F4CB}', update_notes: '\u{1F4DD}', send_email: '\u{1F4E7}',
  send_slack: '\u{1F4AC}', copy: '\u{1F4CB}', paste: '\u{1F4CE}', navigate: '\u2794',
  condition: '\u2753', loop: '\u{1F501}', delay: '\u23F1',
};

// -- Data -----------------------------------------------------------------------

async function _refresh() {
  try {
    _library = await workflowIntel.list(_filter);
  } catch (e) {
    _library = [];
    bus.emit('ui:toast', { type: 'error', message: 'Failed to load workflow library: ' + e.message });
  }
  _renderLibrary();
}

// -- Library rendering ------------------------------------------------------------

function _categories() {
  const set = new Set(_library.map(w => w.category).filter(Boolean));
  return Array.from(set).sort();
}

function _renderLibrary() {
  if (!_el) return;
  const listEl = _el.querySelector('#wi-lib-list');
  const countEl = _el.querySelector('#wi-lib-count');
  if (countEl) countEl.textContent = _library.length + ' workflow' + (_library.length === 1 ? '' : 's');
  if (!listEl) return;

  if (!_library.length) {
    listEl.innerHTML = `
      <div class="wi-empty">
        No workflows recorded yet. Click the <strong>&#9210; Record</strong> button next to the Orcha
        assistant to capture your first one.
      </div>`;
    return;
  }

  listEl.innerHTML = _library.map(w => `
    <div class="wi-card" data-id="${_esc(w.id)}">
      <div class="wi-card-top">
        <button class="wi-fav-btn" data-action="fav" title="${w.favorite ? 'Unfavorite' : 'Favorite'}">${w.favorite ? '\u2605' : '\u2606'}</button>
        <span class="wi-card-name">${_esc(w.name)}</span>
        <span class="wi-card-badge">${_esc(w.category || 'Uncategorized')}</span>
      </div>
      ${w.description ? `<div class="wi-card-desc">${_esc(w.description)}</div>` : ''}
      <div class="wi-card-tags">${(w.tags || []).map(t => `<span class="wi-tag">${_esc(t)}</span>`).join('')}</div>
      <div class="wi-card-meta">
        <span>${(w.steps || []).length} steps</span>
        <span>&middot;</span>
        <span>${_esc(w.source || 'recorded')}</span>
        <span>&middot;</span>
        <span>${new Date(w.updatedAt).toLocaleDateString()}</span>
      </div>
      <div class="wi-card-actions">
        <button data-action="edit">Edit</button>
        <button data-action="export">Export</button>
        <button data-action="delete" class="wi-danger">Delete</button>
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('.wi-card').forEach(card => {
    const id = card.dataset.id;
    card.querySelector('[data-action="fav"]').addEventListener('click', () => _toggleFavorite(id));
    card.querySelector('[data-action="edit"]').addEventListener('click', () => _openEditor(id));
    card.querySelector('[data-action="export"]').addEventListener('click', () => _exportWorkflow(id));
    card.querySelector('[data-action="delete"]').addEventListener('click', () => _deleteWorkflow(id));
  });

  // Category filter options (rebuild each render to reflect current data)
  const catSel = _el.querySelector('#wi-lib-category');
  if (catSel) {
    const current = _filter.category;
    catSel.innerHTML = '<option value="">All Categories</option>' +
      _categories().map(c => `<option value="${_esc(c)}"${c === current ? ' selected' : ''}>${_esc(c)}</option>`).join('');
  }
}

async function _toggleFavorite(id) {
  try {
    await workflowIntel.toggleFavorite(id);
    await _refresh();
  } catch (e) {
    bus.emit('ui:toast', { type: 'error', message: 'Failed: ' + e.message });
  }
}

async function _deleteWorkflow(id) {
  const rec = _library.find(w => w.id === id);
  if (!window.confirm(`Delete "${rec ? rec.name : id}"? This cannot be undone.`)) return;
  try {
    await workflowIntel.delete(id);
    bus.emit('ui:toast', { type: 'success', message: 'Deleted.' });
    await _refresh();
  } catch (e) {
    bus.emit('ui:toast', { type: 'error', message: 'Delete failed: ' + e.message });
  }
}

async function _exportWorkflow(id) {
  try {
    const rec = await workflowIntel.exportWorkflow(id);
    const blob = new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (rec.name || 'workflow').replace(/[^a-z0-9_\-]+/gi, '_') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    bus.emit('ui:toast', { type: 'error', message: 'Export failed: ' + e.message });
  }
}

async function _importFromFile(file) {
  try {
    const text = await file.text();
    const bundle = JSON.parse(text);
    const imported = await workflowIntel.importWorkflow(bundle);
    bus.emit('ui:toast', { type: 'success', message: `Imported "${imported.name}"` });
    await _refresh();
  } catch (e) {
    bus.emit('ui:toast', { type: 'error', message: 'Import failed: ' + e.message });
  }
}

// -- Editor -----------------------------------------------------------------------

async function _openEditor(id) {
  try {
    const rec = await workflowIntel.get(id);
    if (!rec) { bus.emit('ui:toast', { type: 'error', message: 'Workflow not found' }); return; }
    _editing = JSON.parse(JSON.stringify(rec)); // deep copy -- edits are local until Save
    _renderEditor();
  } catch (e) {
    bus.emit('ui:toast', { type: 'error', message: 'Could not open editor: ' + e.message });
  }
}

function _closeEditor() {
  _editing = null;
  const overlay = document.getElementById('wi-editor-overlay');
  if (overlay) overlay.remove();
}

function _stepRowHtml(step, idx, total) {
  const icon = STEP_ICON[step.type] || '\u2022';
  const valuePreview = step.sensitive ? '[REDACTED]' : (step.value !== undefined ? String(step.value).slice(0, 60) : '');
  return `
    <div class="wi-step-row" data-idx="${idx}">
      <span class="wi-step-icon">${icon}</span>
      <span class="wi-step-type">${_esc(step.type)}</span>
      <span class="wi-step-selector" title="${_esc(step.selector || '')}">${_esc(step.label || step.selector || '')}</span>
      ${valuePreview ? `<span class="wi-step-value">${_esc(valuePreview)}</span>` : ''}
      ${step.type === 'delay' ? `<input type="number" class="wi-step-delay" data-idx="${idx}" value="${step.delayMs || 1000}" min="0" step="500" style="width:70px" /> ms` : ''}
      <span class="wi-step-controls">
        <button data-step-action="up" data-idx="${idx}" ${idx === 0 ? 'disabled' : ''} title="Move up">&#9650;</button>
        <button data-step-action="down" data-idx="${idx}" ${idx === total - 1 ? 'disabled' : ''} title="Move down">&#9660;</button>
        <button data-step-action="delete" data-idx="${idx}" class="wi-danger" title="Delete step">&#10005;</button>
      </span>
    </div>`;
}

function _renderEditor() {
  _closeEditor(); // idempotent -- ensures no duplicate overlays
  if (!_editing) return;

  const overlay = document.createElement('div');
  overlay.id = 'wi-editor-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9800;background:rgba(0,0,0,.7);' +
    'backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;';

  overlay.innerHTML = `
    <div class="wi-editor-panel" style="background:#161b22;border:1px solid rgba(240,246,252,.1);border-radius:14px;
         width:min(720px,92vw);max-height:86vh;display:flex;flex-direction:column;box-shadow:0 12px 48px rgba(0,0,0,.5);">
      <div style="display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid rgba(240,246,252,.08);">
        <input id="wi-ed-name" type="text" value="${_esc(_editing.name)}" placeholder="Workflow name"
          style="flex:1;background:rgba(255,255,255,.06);border:1px solid rgba(240,246,252,.12);border-radius:6px;
                 color:#e6edf3;font-size:14px;font-weight:600;padding:8px 10px;outline:none" />
        <button id="wi-ed-close" style="background:transparent;border:none;color:#8b949e;font-size:16px;cursor:pointer">&#10005;</button>
      </div>
      <div style="display:flex;gap:10px;padding:12px 20px;flex-wrap:wrap;">
        <input id="wi-ed-category" type="text" value="${_esc(_editing.category || '')}" placeholder="Category"
          style="flex:1;min-width:140px;background:rgba(255,255,255,.06);border:1px solid rgba(240,246,252,.12);
                 border-radius:6px;color:#e6edf3;font-size:12px;padding:6px 8px;outline:none" />
        <input id="wi-ed-tags" type="text" value="${_esc((_editing.tags || []).join(', '))}" placeholder="tags, comma, separated"
          style="flex:2;min-width:200px;background:rgba(255,255,255,.06);border:1px solid rgba(240,246,252,.12);
                 border-radius:6px;color:#e6edf3;font-size:12px;padding:6px 8px;outline:none" />
      </div>
      <textarea id="wi-ed-desc" placeholder="Description..."
        style="margin:0 20px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(240,246,252,.12);
               border-radius:6px;color:#e6edf3;font-size:12px;padding:8px 10px;outline:none;resize:vertical;
               min-height:44px">${_esc(_editing.description || '')}</textarea>
      <div style="display:flex;gap:8px;padding:0 20px 12px;">
        <button id="wi-ed-add-delay" class="wi-editor-toolbtn">+ Delay</button>
        <button id="wi-ed-add-condition" class="wi-editor-toolbtn">+ Condition</button>
        <button id="wi-ed-add-loop" class="wi-editor-toolbtn">+ Loop</button>
        <button id="wi-ed-add-variable" class="wi-editor-toolbtn">+ Variable</button>
      </div>
      <div id="wi-ed-steps" style="flex:1;overflow-y:auto;padding:0 20px 12px;display:flex;flex-direction:column;gap:6px;"></div>
      <div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:1px solid rgba(240,246,252,.08);">
        <button id="wi-ed-cancel" style="background:transparent;border:1px solid rgba(240,246,252,.15);color:#8b949e;
                border-radius:6px;padding:8px 16px;cursor:pointer;font-size:13px;">Cancel</button>
        <button id="wi-ed-save" style="background:#3fb950;border:none;color:#0d1117;border-radius:6px;
                padding:8px 20px;cursor:pointer;font-size:13px;font-weight:600;">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  _renderEditorSteps();

  overlay.querySelector('#wi-ed-close').addEventListener('click', _closeEditor);
  overlay.querySelector('#wi-ed-cancel').addEventListener('click', _closeEditor);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _closeEditor(); });

  overlay.querySelector('#wi-ed-add-delay').addEventListener('click', () => {
    _editing.steps.push({ id: 'step_' + Date.now(), type: 'delay', app: 'internal', delayMs: 1000, label: 'Delay' });
    _renderEditorSteps();
  });
  ['condition', 'loop', 'variable'].forEach(kind => {
    overlay.querySelector('#wi-ed-add-' + kind).addEventListener('click', () => {
      bus.emit('ui:toast', { type: 'info', message: `${kind[0].toUpperCase() + kind.slice(1)} editing is coming in a future update.` });
    });
  });

  overlay.querySelector('#wi-ed-save').addEventListener('click', async () => {
    _editing.name = overlay.querySelector('#wi-ed-name').value.trim() || _editing.name;
    _editing.category = overlay.querySelector('#wi-ed-category').value.trim() || 'Uncategorized';
    _editing.tags = overlay.querySelector('#wi-ed-tags').value.split(',').map(t => t.trim()).filter(Boolean);
    _editing.description = overlay.querySelector('#wi-ed-desc').value.trim();
    try {
      await workflowIntel.save(_editing);
      bus.emit('ui:toast', { type: 'success', message: `Saved "${_editing.name}"` });
      _closeEditor();
      await _refresh();
    } catch (e) {
      bus.emit('ui:toast', { type: 'error', message: 'Save failed: ' + e.message });
    }
  });
}

function _renderEditorSteps() {
  const stepsEl = document.getElementById('wi-ed-steps');
  if (!stepsEl || !_editing) return;
  const steps = _editing.steps || [];
  if (!steps.length) {
    stepsEl.innerHTML = '<div class="wi-empty" style="padding:20px 0">No steps in this workflow.</div>';
    return;
  }
  stepsEl.innerHTML = steps.map((s, i) => _stepRowHtml(s, i, steps.length)).join('');

  stepsEl.querySelectorAll('[data-step-action]').forEach(btn => {
    const idx = parseInt(btn.dataset.idx, 10);
    const action = btn.dataset.stepAction;
    btn.addEventListener('click', () => {
      if (action === 'up' && idx > 0) {
        [_editing.steps[idx - 1], _editing.steps[idx]] = [_editing.steps[idx], _editing.steps[idx - 1]];
      } else if (action === 'down' && idx < _editing.steps.length - 1) {
        [_editing.steps[idx + 1], _editing.steps[idx]] = [_editing.steps[idx], _editing.steps[idx + 1]];
      } else if (action === 'delete') {
        _editing.steps.splice(idx, 1);
      }
      _renderEditorSteps();
    });
  });

  stepsEl.querySelectorAll('.wi-step-delay').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      _editing.steps[idx].delayMs = parseInt(e.target.value, 10) || 0;
    });
  });
}

// -- View shell ---------------------------------------------------------------------

function _viewHtml() {
  return `
    <div class="wi-header" style="display:flex;align-items:center;gap:10px;padding:16px 20px;flex-wrap:wrap;">
      <h2 style="margin:0;font-size:16px;color:#e6edf3;">Workflow Intelligence</h2>
      <span id="wi-lib-count" style="font-size:12px;color:#8b949e;"></span>
      <div style="flex:1"></div>
      <input id="wi-lib-search" type="search" placeholder="Search workflows..." autocomplete="off"
        style="background:rgba(255,255,255,.06);border:1px solid rgba(240,246,252,.12);border-radius:6px;
               color:#e6edf3;font-size:12px;padding:6px 10px;width:200px;outline:none" />
      <select id="wi-lib-category" style="background:rgba(255,255,255,.06);border:1px solid rgba(240,246,252,.12);
              border-radius:6px;color:#e6edf3;font-size:12px;padding:6px 8px;outline:none">
        <option value="">All Categories</option>
      </select>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#8b949e;cursor:pointer;">
        <input id="wi-lib-fav" type="checkbox" /> Favorites only
      </label>
      <button id="wi-lib-import-btn" style="background:rgba(88,166,255,.15);border:1px solid rgba(88,166,255,.3);
              color:#58a6ff;border-radius:6px;padding:7px 14px;font-size:12px;cursor:pointer;">Import</button>
      <input id="wi-lib-import-file" type="file" accept=".json" style="display:none" />
    </div>
    <div id="wi-lib-list" class="wi-lib-list" style="flex:1;overflow-y:auto;padding:0 20px 20px;
         display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;align-content:start;"></div>
    <style>
      .wi-card { background:rgba(255,255,255,.03); border:1px solid rgba(240,246,252,.08); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:6px; }
      .wi-card-top { display:flex; align-items:center; gap:8px; }
      .wi-fav-btn { background:transparent; border:none; color:#f0a800; font-size:14px; cursor:pointer; padding:0; }
      .wi-card-name { font-size:13px; font-weight:600; color:#e6edf3; flex:1; }
      .wi-card-badge { font-size:10px; color:#8b949e; background:rgba(255,255,255,.06); border-radius:10px; padding:2px 8px; }
      .wi-card-desc { font-size:11px; color:#8b949e; }
      .wi-card-tags { display:flex; gap:4px; flex-wrap:wrap; }
      .wi-tag { font-size:10px; color:#79c0ff; background:rgba(88,166,255,.1); border-radius:8px; padding:1px 7px; }
      .wi-card-meta { font-size:11px; color:#8b949e; display:flex; gap:6px; }
      .wi-card-actions { display:flex; gap:6px; margin-top:4px; }
      .wi-card-actions button { flex:1; background:rgba(255,255,255,.05); border:1px solid rgba(240,246,252,.1);
        color:#e6edf3; border-radius:6px; padding:5px 0; font-size:11px; cursor:pointer; }
      .wi-card-actions button.wi-danger { color:#f85149; }
      .wi-empty { color:#8b949e; font-size:13px; padding:40px 20px; text-align:center; grid-column:1/-1; }
      .wi-step-row { display:flex; align-items:center; gap:8px; background:rgba(255,255,255,.03);
        border:1px solid rgba(240,246,252,.06); border-radius:8px; padding:6px 10px; font-size:12px; color:#e6edf3; }
      .wi-step-icon { font-size:13px; }
      .wi-step-type { color:#79c0ff; text-transform:uppercase; font-size:10px; font-weight:700; }
      .wi-step-selector { flex:1; color:#8b949e; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .wi-step-value { color:#8b949e; font-family:monospace; font-size:10px; }
      .wi-step-controls { display:flex; gap:4px; }
      .wi-step-controls button { background:transparent; border:none; color:#8b949e; cursor:pointer; font-size:11px; }
      .wi-step-controls button.wi-danger { color:#f85149; }
      .wi-editor-toolbtn { background:rgba(255,255,255,.05); border:1px solid rgba(240,246,252,.1); color:#e6edf3;
        border-radius:6px; padding:5px 12px; font-size:11px; cursor:pointer; }
    </style>
  `;
}

export function init(container) {
  _el = document.createElement('div');
  _el.id = 'view-workflow-intel';
  _el.className = 'view view--workflow-intel';
  // Inline layout rules -- avoids the exact ".view--X missing flex-direction:column"
  // bug documented in docs/STAGE28_COMPLETION.md's Daily Call fix.
  _el.style.cssText = 'display:none; flex-direction:column; height:100%; overflow:hidden;';
  _el.innerHTML = _viewHtml();
  container.appendChild(_el);

  _el.querySelector('#wi-lib-search').addEventListener('input', (e) => {
    _filter.search = e.target.value.trim();
    _refresh();
  });
  _el.querySelector('#wi-lib-category').addEventListener('change', (e) => {
    _filter.category = e.target.value;
    _refresh();
  });
  _el.querySelector('#wi-lib-fav').addEventListener('change', (e) => {
    _filter.favoriteOnly = e.target.checked;
    _refresh();
  });
  _el.querySelector('#wi-lib-import-btn').addEventListener('click', () => {
    _el.querySelector('#wi-lib-import-file').click();
  });
  _el.querySelector('#wi-lib-import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) _importFromFile(file);
    e.target.value = '';
  });

  // Refresh whenever a recording is saved elsewhere in the app (HUD stop button)
  bus.on('wi:recording-stopped', () => { if (_el.style.display !== 'none') _refresh(); });

  // Load on first activation of this view (view-change), not on app boot --
  // consistent with other views (e.g. vendors.js) that recompute on entry.
  bus.on('ui:view-change', ({ to }) => { if (to === 'workflow-intel') _refresh(); });
}
