/**
 * unit-compare.js — Side-by-side unit comparison panel
 *
 * Select 2-3 units from the fleet table (checkbox multi-select) then
 * click "Compare" to see them side-by-side: timelines, vendors, duration,
 * risk scores, PM dates, issues, notes.
 *
 * Triggered via bus event 'ui:compare-units' with { units: [...] }
 * or via the bulk action bar that appears when multiple checkboxes are selected.
 */

import bus   from '../bus.js';
import state from '../state.js';

let _overlay = null;

export function initUnitCompare() {
  bus.on('ui:compare-units', ({ unitIds }) => {
    if (!unitIds || unitIds.length < 2) {
      bus.emit('ui:toast', { type: 'warn', message: 'Select 2-3 units to compare', duration: 2500 });
      return;
    }
    const fleet = state.slice('fleet');
    const units = unitIds.slice(0, 3).map(id => (fleet.rows || []).find(r => r.equipmentId === id)).filter(Boolean);
    if (units.length < 2) {
      bus.emit('ui:toast', { type: 'warn', message: 'Could not find selected units', duration: 2500 });
      return;
    }
    _showCompare(units);
  });
}

function _showCompare(units) {
  if (_overlay) _overlay.remove();

  _overlay = document.createElement('div');
  _overlay.id = 'unit-compare-overlay';
  _overlay.style.cssText = 'position:fixed;inset:0;background:rgba(13,17,23,.8);backdrop-filter:blur(6px);z-index:800;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .25s;';

  const panel = document.createElement('div');
  panel.style.cssText = 'background:var(--panel);border:1px solid var(--bdrs);border-radius:14px;width:90vw;max-width:1200px;max-height:85vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.6);';

  // Header
  let html = '<div style="padding:16px 22px;border-bottom:1px solid var(--bdr);display:flex;align-items:center;justify-content:space-between;">';
  html += '<div style="font-size:14px;font-weight:700;color:var(--txt);">Unit Comparison</div>';
  html += '<button id="uc-close" style="width:26px;height:26px;border-radius:6px;border:1px solid var(--bdr);background:var(--el);color:var(--txt2);cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;">✕</button>';
  html += '</div>';

  // Comparison table
  html += '<div style="flex:1;overflow-y:auto;padding:16px 22px;">';
  html += '<table style="width:100%;border-collapse:collapse;font-size:11px;">';

  // Header row (unit IDs)
  html += '<tr><th style="padding:8px;text-align:left;color:var(--mut);font-size:9px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--bdr);">Field</th>';
  units.forEach(u => {
    html += '<th style="padding:8px;text-align:left;border-bottom:1px solid var(--bdr);"><span style="font-family:var(--mono);font-size:13px;font-weight:800;color:var(--acc2);">' + _esc(u.equipmentId) + '</span></th>';
  });
  html += '</tr>';

  // Comparison rows
  const fields = [
    { label: 'Status', key: 'lifecycleState' },
    { label: 'Relay Status', key: 'lifecycleReason' },
    { label: 'Vendor', key: 'vendor' },
    { label: 'Dealer', key: 'dealerName' },
    { label: 'Make', key: 'manufacturer' },
    { label: 'Body Type', key: 'bodyType' },
    { label: 'Site', key: 'domicileSite' },
    { label: 'Operator', key: 'operator' },
    { label: 'Days Down', key: 'workDuration' },
    { label: 'Risk Score', key: 'riskScore', render: (v) => v ? _riskBadge(v) : '--' },
    { label: 'Alt ID', key: 'alternativeId' },
    { label: 'Offsite Event', key: 'offsiteShopEvent' },
    { label: 'SF Case', key: 'salesforceCase' },
    { label: 'Repair Status', key: 'savedRepairStatus' },
    { label: 'Primary Component', key: 'savedPrimaryComponent' },
    { label: 'PM-B Due', key: 'pmB' },
    { label: 'PM-X Due', key: 'pmX' },
    { label: 'DOT Due', key: 'dot' },
    { label: 'Issue', key: 'issueDetails', long: true },
    { label: 'Notes', key: 'savedNotes', long: true },
    { label: 'Timeline', key: 'repairTimeline', long: true },
  ];

  fields.forEach((f, i) => {
    const bg = i % 2 === 0 ? 'transparent' : 'var(--el)';
    html += '<tr style="background:' + bg + ';">';
    html += '<td style="padding:8px;font-weight:600;color:var(--mut);font-size:9px;text-transform:uppercase;letter-spacing:.5px;vertical-align:top;width:120px;white-space:nowrap;">' + f.label + '</td>';
    units.forEach(u => {
      let val = u[f.key] || '--';
      if (f.render) val = f.render(val);
      else val = _esc(String(val));
      // Long fields: show first 200 chars
      if (f.long && val.length > 200) val = val.slice(0, 200) + '...';
      // Highlight differences
      const allSame = units.every(x => String(x[f.key] || '') === String(units[0][f.key] || ''));
      const diffStyle = allSame ? '' : 'color:var(--acc2);font-weight:600;';
      const cellStyle = f.long ? 'white-space:pre-wrap;max-width:300px;font-size:10px;line-height:1.5;' : '';
      html += '<td style="padding:8px;color:var(--txt2);vertical-align:top;' + diffStyle + cellStyle + '">' + (f.long ? '<div style="max-height:120px;overflow-y:auto;">' + val.replace(/\n/g, '<br>') + '</div>' : val) + '</td>';
    });
    html += '</tr>';
  });

  html += '</table></div>';

  panel.innerHTML = html;
  _overlay.appendChild(panel);
  document.body.appendChild(_overlay);

  // Animate in
  requestAnimationFrame(() => { _overlay.style.opacity = '1'; });

  // Close handlers
  _overlay.addEventListener('click', (e) => { if (e.target === _overlay) _close(); });
  document.getElementById('uc-close').addEventListener('click', _close);
  document.addEventListener('keydown', _escHandler);
}

function _close() {
  if (_overlay) {
    _overlay.style.opacity = '0';
    setTimeout(() => { if (_overlay) { _overlay.remove(); _overlay = null; } }, 250);
  }
  document.removeEventListener('keydown', _escHandler);
}

function _escHandler(e) { if (e.key === 'Escape') _close(); }

function _riskBadge(score) {
  const n = parseInt(score, 10) || 0;
  const color = n >= 70 ? 'var(--red)' : n >= 40 ? 'var(--org)' : n > 0 ? 'var(--grn)' : 'var(--mut)';
  return '<span style="font-family:var(--mono);font-weight:800;color:' + color + ';">' + n + '</span>';
}

function _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
