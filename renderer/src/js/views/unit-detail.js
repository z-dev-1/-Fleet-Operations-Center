/**
 * unit-detail.js -- Unit detail panel / drawer
 *
 * Slides in from the right when a unit is selected (ui:unit-select).
 * Slides out on close or ui:unit-deselect.
 *
 * Shows: all unit fields | notes editor | quick actions (AAP, WR, lifecycle)
 */

import bus           from '../bus.js';
import state         from '../state.js';
import { notes, ai, aap } from '../bridge.js';
import toast         from '../components/toast.js';

let _panel    = null;
let _unit     = null;
let _notesVal = '';

const FIELDS = [
  ['Equipment ID',       'equipmentId'],
  ['Asset Type',         'assetType'],
  ['Lifecycle State',    'lifecycleState'],
  ['Lifecycle Reason',   'lifecycleReason'],
  ['Domicile',           'domicileSite'],
  ['Operator',           'operator'],
  ['Manufacturer',       'manufacturer'],
  ['Body Type',          'bodyType'],
  ['Engine Manufacturer','engineManufacturer'],
  ['Fuel Type',          'fuelType'],
  ['Due Date',           'dueDate'],
  ['Open Unplanned WRs', 'openUnplanned'],
  ['Open Planned WRs',   'openPlanned'],
  ['Last Geofence',      'geofence'],
  ['Lat/Long',           'latLong'],
];

function _esc(s) {
  return String(s || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _renderUnit(unit) {
  _unit = unit;
  if (!_panel) return;

  const rows = FIELDS
    .filter(([, key]) => unit[key])
    .map(([label, key]) =>
      '<tr><th>' + label + '</th><td>' + _esc(unit[key]) + '</td></tr>'
    ).join('');

  _panel.innerHTML = `
    <div class="detail-panel__header">
      <h2 class="detail-panel__title">${_esc(unit.equipmentId)}</h2>
      <button id="dp-close" class="detail-panel__close" aria-label="Close">&times;</button>
    </div>
    <div class="detail-panel__body">
      <table class="detail-panel__table"><tbody>${rows}</tbody></table>

      <div class="detail-panel__section">
        <h3>Notes</h3>
        <textarea id="dp-notes" class="detail-panel__notes" placeholder="Add notes for this unit..."></textarea>
        <button id="dp-save-notes" class="detail-panel__btn">Save Notes</button>
      </div>

      <div class="detail-panel__section">
        <h3>Quick Actions</h3>
        <div class="detail-panel__actions">
          <button id="dp-aap-open"  class="detail-panel__btn">Open in AAP</button>
          <button id="dp-ai-suggest" class="detail-panel__btn">AI Suggest</button>
          <button id="dp-create-wr" class="detail-panel__btn">Create WR</button>
        </div>
      </div>

      <div id="dp-ai-result" class="detail-panel__ai-result" style="display:none"></div>
    </div>
  `;

  document.getElementById('dp-close').addEventListener('click', close);

  // Load existing notes
  notes.getUnit(unit.equipmentId).then((n) => {
    const ta = document.getElementById('dp-notes');
    if (ta && n && n.content) { ta.value = n.content; _notesVal = n.content; }
  }).catch(() => {});

  // Save notes
  document.getElementById('dp-save-notes').addEventListener('click', async () => {
    const ta = document.getElementById('dp-notes');
    if (!ta) return;
    try {
      await notes.saveUnit({ unitId: unit.equipmentId, content: ta.value });
      toast.show('success', 'Notes saved');
    } catch (e) {
      toast.show('error', 'Failed to save notes: ' + e.message);
    }
  });

  // Open in AAP
  document.getElementById('dp-aap-open').addEventListener('click', () => {
    if (unit.assetUrl) {
      aap.openUrl(unit.assetUrl);
    } else {
      toast.show('warn', 'No AAP URL for this unit', 3000);
    }
  });

  // AI suggest
  document.getElementById('dp-ai-suggest').addEventListener('click', async () => {
    const resultEl = document.getElementById('dp-ai-result');
    if (!resultEl) return;
    resultEl.style.display = 'block';
    resultEl.textContent = 'Asking Orcha...';
    try {
      const suggestion = await ai.suggest(unit);
      resultEl.textContent = suggestion && suggestion.text
        ? suggestion.text
        : JSON.stringify(suggestion, null, 2);
    } catch (e) {
      resultEl.textContent = 'Error: ' + e.message;
    }
  });

  // Create WR
  document.getElementById('dp-create-wr').addEventListener('click', () => {
    toast.show('info', 'WR creation flow not yet wired in renderer', 4000);
  });
}

function close() {
  if (_panel) {
    _panel.classList.remove('detail-panel--open');
    setTimeout(() => {
      if (_panel) _panel.innerHTML = '';
      _unit = null;
    }, 300);
  }
  bus.emit('ui:unit-deselect');
}

export function init(container) {
  _panel = document.createElement('div');
  _panel.id = 'detail-panel';
  _panel.className = 'detail-panel';
  container.appendChild(_panel);

  bus.on('ui:unit-select', ({ unit }) => {
    _renderUnit(unit);
    requestAnimationFrame(() => _panel.classList.add('detail-panel--open'));
  });

  bus.on('ui:unit-deselect', () => {
    if (_panel) _panel.classList.remove('detail-panel--open');
  });
}
