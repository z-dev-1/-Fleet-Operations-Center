/**
 * nexus-sidebar.js — Consolidated Intelligence Sidebar (Year 3030)
 *
 * Merges Intelligence Panel + Draft Inbox + Workflow Timeline into ONE
 * slide-in right sidebar with tabs. Keeps main content uncluttered.
 *
 * Tabs: Alerts | Actions | Drafts | Timeline | Health
 */

import bus   from '../bus.js';
import state from '../state.js';
import { ai } from '../bridge.js';

let _el     = null;
let _open   = false;
let _tab    = 'alerts';
let _lastBriefing = null;
let _draftsLoaded = false;
let _draftsList = [];

const TABS = [
  { id: 'alerts',   label: '🚨 Alerts',   badge: () => { const r = state.get('alerts'); return (Array.isArray(r) ? r.length : r?.alerts?.length) || 0; } },
  { id: 'actions',  label: '💡 Actions',  badge: () => { const r = state.get('recommendations'); return (Array.isArray(r) ? r.length : r?.recommendations?.length) || 0; } },
  { id: 'drafts',   label: '📦 Drafts',   badge: () => _drafts.filter(d => d.status === 'pending').length },
  { id: 'timeline', label: '📍 Workflow', badge: () => '' },
  { id: 'health',   label: '🏥 Health',   badge: () => '' },
];


let _drafts = [];
let _selectedUnit = null;

function _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function _render() {
  if (!_el) return;
  _el.innerHTML = `
    <div class="nx-sidebar${_open ? ' nx-sidebar--open' : ''}">
      <button class="nx-sidebar__close" id="nx-sb-close">◂</button>
      <div class="nx-sidebar__tabs">
        ${TABS.map(t => {
          const b = t.badge();
          return `<div class="nx-sidebar__tab${_tab === t.id ? ' nx-sidebar__tab--active' : ''}" data-tab="${t.id}">
            ${t.label}${b ? '<span class="nx-nav__badge">' + b + '</span>' : ''}
          </div>`;
        }).join('')}
      </div>
      <div class="nx-sidebar__content nx-stagger">
        ${_renderTab()}
      </div>
    </div>
  `;
  _wireEvents();
}

function _renderTab() {
  switch (_tab) {
    case 'alerts': return _renderAlerts();
    case 'actions': return _renderActions();
    case 'drafts': return _renderDrafts();
    case 'timeline': return _renderTimeline();
    case 'health': return _renderHealth();
    default: return '';
  }
}

function _renderAlerts() {
  const raw = state.get('alerts');
  const alerts = Array.isArray(raw) ? raw : (raw?.alerts || []);
  const briefingHtml = _lastBriefing ? '<div class="nx-card" style="margin-bottom:12px;border-left:3px solid var(--nx-accent,#f0a800);background:rgba(240,168,0,0.04)"><div style="font-size:10px;color:var(--nx-text3);margin-bottom:4px">MORNING BRIEFING</div><div style="font-size:11px;color:var(--nx-text);white-space:pre-line">' + _esc(_lastBriefing.text) + '</div></div>' : '';
  if (!Array.isArray(alerts) || alerts.length === 0) return briefingHtml + '<div class="nx-empty">No alerts — fleet is healthy</div>';
  return briefingHtml + alerts.slice(0, 20).map(a => `
    <div class="nx-card" style="margin-bottom:8px;border-left:3px solid ${a.severity === 'critical' ? 'var(--nx-red)' : a.severity === 'warning' ? 'var(--nx-orange)' : 'var(--nx-accent)'}">
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
        <span style="font-size:11px">${a.severity === 'critical' ? '🔴' : a.severity === 'warning' ? '⚠️' : 'i️'}</span>
        <span style="font-family:var(--nx-mono);font-size:11px;font-weight:700;color:var(--nx-accent)">${_esc(a.unit)}</span>
        <span style="font-size:9px;color:var(--nx-text3);margin-left:auto">${_esc(a.operator)}</span>
      </div>
      <div style="font-size:10px;color:var(--nx-text)">${_esc(a.message)}</div>
      <div style="font-size:9px;color:var(--nx-text3);font-style:italic;margin-top:2px">${_esc(a.suggestion)}</div>
    </div>
  `).join('');
}

function _renderActions() {
  const raw = state.get('recommendations');
  const recs = Array.isArray(raw) ? raw : (raw?.recommendations || []);
  if (!Array.isArray(recs) || recs.length === 0) return '<div class="nx-empty">No actions needed</div>';
  return recs.slice(0, 15).map(r => `
    <div class="nx-card" style="margin-bottom:8px;cursor:pointer" data-unit="${_esc(r.unit)}">
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:3px">
        <span style="font-size:10px;font-weight:700;color:var(--nx-purple);text-transform:uppercase">${_esc(r.action)}</span>
        <span style="margin-left:auto;font-family:var(--nx-mono);font-size:9px;color:var(--nx-green)">${r.confidence}%</span>
      </div>
      <div style="font-family:var(--nx-mono);font-size:11px;color:var(--nx-accent);font-weight:700">${_esc(r.unit)}</div>
      <div style="font-size:9px;color:var(--nx-text2);margin-top:2px">${_esc(r.reason)}</div>
    </div>
  `).join('');
}

function _renderDrafts() {
  // Pull from partner WR inbox
  if (!window.partner) return '<div class="nx-empty">Partner module not available</div>';
  
  // Use cached drafts or show loading
  if (!_draftsLoaded) {
    window.partner.getReview().then(list => {
      _draftsList = list || [];
      _draftsLoaded = true;
      _render();
    });
    return '<div class="nx-empty">Loading drafts...</div>';
  }

  if (!_draftsList.length) return '<div class="nx-empty">No pending work requests</div>';
  
  return _draftsList.map((wr, i) => {
    const isReady = wr.aiClassified;
    const borderCol = isReady ? 'var(--nx-green, #3fb950)' : 'var(--nx-orange, #f0a800)';
    return '<div class="nx-card" style="margin-bottom:8px;border-left:3px solid ' + borderCol + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
        '<span style="font-family:var(--nx-mono);font-size:11px;font-weight:700;color:var(--nx-accent)">' + _esc(wr.unit || (wr.payload && wr.payload.unit) || '?') + '</span>' +
        '<span style="font-size:8px;padding:1px 5px;border-radius:3px;background:' + (isReady ? 'rgba(63,185,80,0.12);color:#3fb950' : 'rgba(240,168,0,0.12);color:#f0a800') + '">' + (isReady ? 'AI READY' : 'PENDING') + '</span>' +
      '</div>' +
      '<div style="font-size:10px;color:var(--nx-text)">' + _esc(wr.issue || (wr.payload && wr.payload.title) || '') + '</div>' +
      (wr.reportedBy ? '<div style="font-size:9px;color:var(--nx-text3);margin-top:2px">From: ' + _esc(wr.reportedBy) + '</div>' : '') +
    '</div>';
  }).join('');
}

function _renderTimeline() {
  const tracker = state.get('tracker');
  if (!tracker || !tracker.summary) return '<div class="nx-empty">Waiting for tracker data...</div>';

  const STAGES = ['detected','assigned','diagnosed','quoted','approved','parts','repair','qc','pickup','active'];
  const counts = tracker.summary.stageCounts || {};

  return `
    <div class="nx-stat" style="margin-bottom:16px">
      <span class="nx-stat__value">${tracker.summary.total}</span>
      <span class="nx-stat__label">Total units tracked</span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
      <div class="nx-card"><span class="nx-stat__value" style="font-size:20px">${tracker.summary.stuck || 0}</span><span class="nx-stat__label">Stuck</span></div>
      <div class="nx-card"><span class="nx-stat__value" style="font-size:20px">${tracker.summary.avgProgress || 0}%</span><span class="nx-stat__label">Avg Progress</span></div>
    </div>
    <div style="font-size:9px;font-weight:700;color:var(--nx-text2);text-transform:uppercase;margin-bottom:8px">Stage Distribution</div>
    ${STAGES.map(s => {
      const c = counts[s] || 0;
      const pct = tracker.summary.total > 0 ? Math.round((c / tracker.summary.total) * 100) : 0;
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span style="font-size:9px;width:60px;color:var(--nx-text3)">${s}</span>
        <div style="flex:1;height:6px;border-radius:3px;background:var(--nx-border);overflow:hidden">
          <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--nx-accent),var(--nx-purple));border-radius:3px;transition:width .6s var(--nx-ease)"></div>
        </div>
        <span style="font-family:var(--nx-mono);font-size:9px;color:var(--nx-text2);width:24px;text-align:right">${c}</span>
      </div>`;
    }).join('')}
  `;
}

function _renderHealth() {
  const health = state.get('health');
  if (!health) return '<div class="nx-empty">Waiting for health check...</div>';

  const statusIcon = { green: '🟢', yellow: '🟡', red: '🔴' };
  return `
    <div class="nx-stat" style="margin-bottom:16px">
      <span class="nx-stat__value">${health.overallScore || 0}%</span>
      <span class="nx-stat__label">System Health</span>
    </div>
    ${Object.entries(health.integrations || {}).map(([key, info]) => `
      <div class="nx-card" style="margin-bottom:6px;display:flex;align-items:center;gap:8px">
        <span>${statusIcon[info.status] || '⚪'}</span>
        <div style="flex:1">
          <div style="font-size:11px;font-weight:600;color:var(--nx-text)">${_esc(info.label)}</div>
          <div style="font-size:9px;color:var(--nx-text3)">${_esc(info.detail)}</div>
        </div>
      </div>
    `).join('')}
  `;
}

function _wireEvents() {
  // Close
  const closeBtn = document.getElementById('nx-sb-close');
  if (closeBtn) closeBtn.addEventListener('click', () => { _open = false; _render(); });

  // Tabs
  _el.querySelectorAll('.nx-sidebar__tab').forEach(tab => {
    tab.addEventListener('click', () => { _tab = tab.dataset.tab; _render(); });
  });

  // Approve drafts
  _el.querySelectorAll('.nx-sb-approve').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pending = _drafts.filter(d => d.status === 'pending');
      const draft = pending[parseInt(btn.dataset.idx, 10)];
      if (!draft) return;
      draft.status = 'approved';
      bus.emit('ui:toast', { type: 'success', message: 'Draft approved', duration: 2000 });
      _render();
    });
  });

  // Dismiss drafts
  _el.querySelectorAll('.nx-sb-dismiss').forEach(btn => {
    btn.addEventListener('click', () => {
      const pending = _drafts.filter(d => d.status === 'pending');
      const draft = pending[parseInt(btn.dataset.idx, 10)];
      if (draft) draft.status = 'dismissed';
      _render();
    });
  });
}

export function init() {
  _el = document.createElement('div');
  _el.id = 'nexus-sidebar-mount';
  document.body.appendChild(_el);

  _render();

  // Toggle sidebar
  bus.on('orcha:morning-briefing', (data) => { if (data && data.text) _lastBriefing = data; });
  bus.on('ui:toggle-intelligence', () => { _open = !_open; _render(); });
  bus.on('nexus:open-sidebar', (tab) => { _open = true; if (tab) _tab = tab; _render(); });
  bus.on('nexus:close-sidebar', () => { _open = false; _render(); });

  // Data updates
  bus.on('orcha:alerts', () => _render());
  bus.on('orcha:recommendations', () => _render());
  bus.on('orcha:tracker', () => _render());
  bus.on('orcha:drafts', (data) => {
    if (data && data.drafts) {
      for (const d of data.drafts) {
        const key = d.type + ':' + (d.unit || '') + ':' + (d.slot || '');
        if (!_drafts.find(x => x._key === key && x.status === 'pending')) {
          d._key = key;
          _drafts.push(d);
        }
      }
    }
    _render();
  });
}
