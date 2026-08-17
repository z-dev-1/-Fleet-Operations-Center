/**
 * smart-search.js — Deep search across ALL fleet data
 *
 * Searches: unit IDs, vendor names, timelines, notes, issue descriptions,
 * domicile sites, operators, body types, lifecycle reasons, alt IDs,
 * offsite events, salesforce cases — everything.
 *
 * Shows results in a dropdown below the search box with highlighted matches.
 * Clicking a result navigates to that unit's detail panel.
 */

import bus   from '../bus.js';
import state from '../state.js';

let _dropdown = null;
let _debounce = null;
let _lastQuery = '';

export function initSmartSearch() {
  const searchEl = document.getElementById('tb-search');
  if (!searchEl) return;

  // Create dropdown
  _dropdown = document.createElement('div');
  _dropdown.id = 'smart-search-dropdown';
  _dropdown.style.cssText = 'position:absolute;top:100%;left:0;right:0;background:var(--panel);border:1px solid var(--bdr);border-radius:0 0 8px 8px;max-height:360px;overflow-y:auto;z-index:500;display:none;box-shadow:0 8px 24px rgba(0,0,0,.4);';
  searchEl.parentElement.style.position = 'relative';
  searchEl.parentElement.appendChild(_dropdown);

  // Listen for input
  searchEl.addEventListener('input', () => {
    const q = (searchEl.value || '').trim();
    if (q.length < 2) { _hide(); return; }
    clearTimeout(_debounce);
    _debounce = setTimeout(() => _search(q), 200);
  });

  // Hide on blur (with delay so click registers)
  searchEl.addEventListener('blur', () => setTimeout(_hide, 200));

  // Show on focus if there's a query
  searchEl.addEventListener('focus', () => {
    if (searchEl.value.trim().length >= 2 && _lastQuery) _show();
  });

  // Keyboard nav in dropdown
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { _hide(); searchEl.blur(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = _dropdown.querySelectorAll('.ss-item');
      if (!items.length) return;
      const active = _dropdown.querySelector('.ss-item.active');
      let idx = active ? Array.from(items).indexOf(active) : -1;
      if (active) active.classList.remove('active');
      idx = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
      items[idx].classList.add('active');
      items[idx].scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter') {
      const active = _dropdown.querySelector('.ss-item.active');
      if (active) { active.click(); e.preventDefault(); }
    }
  });
}

function _search(query) {
  _lastQuery = query;
  const fleet = state.slice('fleet');
  const rows  = fleet.rows || [];
  const notesStore = {}; // We don't have direct store access in renderer — search row fields only

  const q = query.toLowerCase();
  const results = [];
  const MAX = 15;

  for (const row of rows) {
    if (results.length >= MAX) break;

    // Search across all meaningful fields
    const fields = [
      { key: 'equipmentId', label: 'Unit ID' },
      { key: 'vendor', label: 'Vendor' },
      { key: 'manufacturer', label: 'Make' },
      { key: 'bodyType', label: 'Body Type' },
      { key: 'operator', label: 'Operator' },
      { key: 'domicileSite', label: 'Site' },
      { key: 'lifecycleState', label: 'Status' },
      { key: 'lifecycleReason', label: 'Relay Status' },
      { key: 'issueDetails', label: 'Issue' },
      { key: 'issueSummary', label: 'Issue Summary' },
      { key: 'alternativeId', label: 'Alt ID' },
      { key: 'offsiteShopEvent', label: 'Offsite Event' },
      { key: 'salesforceCase', label: 'SF Case' },
      { key: 'dealerName', label: 'Dealer' },
      { key: 'savedNotes', label: 'Notes' },
      { key: 'savedRepairStatus', label: 'Repair Status' },
      { key: 'savedPrimaryComponent', label: 'Component' },
      { key: 'repairTimeline', label: 'Timeline' },
      { key: 'geofence', label: 'Location' },
      { key: 'workDuration', label: 'Duration' },
    ];

    for (const f of fields) {
      const val = String(row[f.key] || '');
      if (!val) continue;
      const idx = val.toLowerCase().indexOf(q);
      if (idx === -1) continue;

      // Found a match
      const snippet = val.length > 80
        ? '...' + val.substring(Math.max(0, idx - 20), idx + query.length + 40) + '...'
        : val;

      results.push({
        unitId: row.equipmentId,
        field: f.label,
        snippet,
        matchIdx: idx,
        row,
      });
      break; // One result per unit (don't show same unit multiple times)
    }
  }

  _renderResults(results, query);
}

function _renderResults(results, query) {
  if (!results.length) {
    _dropdown.innerHTML = '<div style="padding:12px 14px;font-size:11px;color:var(--mut);">No results for "' + _esc(query) + '"</div>';
    _show();
    return;
  }

  let html = '';
  results.forEach((r, i) => {
    const highlighted = _highlight(r.snippet, query);
    html += '<div class="ss-item' + (i === 0 ? ' active' : '') + '" data-unit-id="' + _esc(r.unitId) + '" style="padding:8px 14px;cursor:pointer;border-bottom:1px solid var(--bdr);transition:background .1s;">';
    html += '<div style="display:flex;align-items:center;gap:8px;">';
    html += '<span style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--acc2);">' + _esc(r.unitId) + '</span>';
    html += '<span style="font-size:9px;color:var(--mut);background:var(--el);padding:1px 6px;border-radius:3px;">' + r.field + '</span>';
    html += '</div>';
    html += '<div style="font-size:10px;color:var(--txt2);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + highlighted + '</div>';
    html += '</div>';
  });

  _dropdown.innerHTML = html;

  // Wire clicks
  _dropdown.querySelectorAll('.ss-item').forEach(el => {
    el.addEventListener('mouseenter', () => {
      _dropdown.querySelectorAll('.ss-item').forEach(i => i.classList.remove('active'));
      el.classList.add('active');
    });
    el.addEventListener('click', () => {
      const unitId = el.dataset.unitId;
      const fleet = state.slice('fleet');
      const unit = (fleet.rows || []).find(r => r.equipmentId === unitId);
      if (unit) bus.emit('ui:unit-select', { unit });
      _hide();
    });
  });

  _show();
}

function _highlight(text, query) {
  const escaped = _esc(text);
  const q = _esc(query);
  const regex = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
  return escaped.replace(regex, '<mark style="background:rgba(88,166,255,.25);color:var(--acc2);border-radius:2px;padding:0 1px;">$1</mark>');
}

function _show() { if (_dropdown) _dropdown.style.display = ''; }
function _hide() { if (_dropdown) _dropdown.style.display = 'none'; }
function _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
