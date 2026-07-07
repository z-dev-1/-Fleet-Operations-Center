/**
 * workflow-timeline.js — Visual Workflow Timeline (Year 3030 UI)
 *
 * Renders a horizontal timeline showing a unit's journey through repair stages.
 * Integrates into unit-detail panel when a unit is selected.
 *
 * Stages: Detected → Assigned → Diagnosed → Quoted → Approved → Parts → Repair → QC → Pickup → Active
 *
 * Visual features:
 *  - Glowing progress line (cyan → purple gradient)
 *  - Pulsing dot on current stage
 *  - Done stages light up
 *  - Time-in-stage label below current
 *  - Hover reveals stage details
 */

import bus   from '../bus.js';
import state from '../state.js';

const STAGES = ['detected','assigned','diagnosed','quoted','approved','parts','repair','qc','pickup','active'];
const LABELS = { detected:'Detect', assigned:'Assign', diagnosed:'Diagnose', quoted:'Quote', approved:'Approve', parts:'Parts', repair:'Repair', qc:'QC', pickup:'Pickup', active:'Active' };
const ICONS  = { detected:'🔍', assigned:'📋', diagnosed:'🔬', quoted:'💰', approved:'✅', parts:'📦', repair:'🔧', qc:'✔️', pickup:'🚛', active:'🟢' };

let _mountEl = null;
let _currentUnit = null;

function _getUnitTracker(unitId) {
  const tracker = state.get('tracker');
  if (!tracker || !tracker.tracked) return null;
  return tracker.tracked.find(t => t.equipmentId === unitId);
}

function render(unitId) {
  if (!_mountEl) return;
  _currentUnit = unitId;

  const info = _getUnitTracker(unitId);
  if (!info) {
    _mountEl.innerHTML = '<div class="wt-empty">No workflow data for this unit</div>';
    return;
  }

  const currentIdx = STAGES.indexOf(info.currentStage);
  const progressPct = currentIdx >= 0 ? Math.round((currentIdx / (STAGES.length - 1)) * 100) : 0;

  _mountEl.innerHTML = `
    <div class="wt-container nx-animate-in">
      <div class="wt-header">
        <span class="wt-header__title">Workflow Progress</span>
        <span class="wt-header__pct">${progressPct}%</span>
        ${info.isStuck ? '<span class="wt-header__stuck">⚠ STUCK</span>' : ''}
      </div>
      <div class="nx-timeline">
        <div class="nx-timeline__track"></div>
        <div class="nx-timeline__progress" style="width: ${progressPct}%"></div>
        ${STAGES.map((stage, i) => {
          const isDone = i < currentIdx;
          const isCurrent = i === currentIdx;
          const isFuture = i > currentIdx;
          const dotCls = isDone ? 'nx-timeline__dot--done' : isCurrent ? 'nx-timeline__dot--current' : 'nx-timeline__dot--future';
          const labelCls = (isDone || isCurrent) ? 'nx-timeline__label--active' : '';
          return `
            <div class="nx-timeline__stage" title="${LABELS[stage]}${isCurrent ? ' (' + info.timeInStageHours + 'h)' : ''}">
              <div class="nx-timeline__dot ${dotCls}">${isCurrent ? '' : ''}</div>
              <span class="nx-timeline__label ${labelCls}">${ICONS[stage]}</span>
              ${isCurrent ? '<span class="nx-timeline__time">' + info.timeInStageHours + 'h</span>' : ''}
            </div>
          `;
        }).join('')}
      </div>
      <div class="wt-meta">
        <span class="wt-meta__stage">Stage: <strong>${LABELS[info.currentStage] || info.currentStage}</strong></span>
        <span class="wt-meta__time">In stage: <strong>${info.timeInStageHours}h</strong> / ${info.expectedHours}h expected</span>
        ${info.vendor ? '<span class="wt-meta__vendor">Vendor: <strong>' + info.vendor + '</strong></span>' : ''}
      </div>
    </div>
  `;
}

export function init() {
  // Create mount point — will be inserted into unit-detail when it renders
  _mountEl = document.createElement('div');
  _mountEl.id = 'workflow-timeline-mount';
  _mountEl.className = 'wt-mount';

  // Listen for unit selection
  bus.on('ui:unit-select', ({ unit }) => {
    if (unit && unit.equipmentId) {
      _insertIntoDetail();
      render(unit.equipmentId);
    }
  });

  // Listen for tracker updates
  bus.on('orcha:tracker', () => {
    if (_currentUnit) render(_currentUnit);
  });
}

function _insertIntoDetail() {
  // Insert into unit detail panel if not already there
  if (_mountEl.parentNode) return;
  const detailPanel = document.getElementById('detail-panel') || document.querySelector('.detail-panel');
  if (detailPanel) {
    // Insert after the header section
    const firstSection = detailPanel.querySelector('.detail-panel__section, .dp-section');
    if (firstSection) {
      firstSection.parentNode.insertBefore(_mountEl, firstSection);
    } else {
      detailPanel.prepend(_mountEl);
    }
  }
}

export { render as renderTimeline };
