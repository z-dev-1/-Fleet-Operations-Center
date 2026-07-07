/**
 * draft-inbox.js — Partner WR Review Queue
 *
 * Shows incoming partner work requests that AI has pre-filled.
 * User approves (one-click submit) or declines.
 * Toggleable via toolbar bus event.
 */

import bus from '../bus.js';

let _el = null;
let _open = false;
let _reviewWRs = [];
let _pollTimer = null;

const _esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function _render() {
  if (!_el) return;
  const badge = document.getElementById('tb-inbox-badge');
  if (badge) {
    badge.textContent = _reviewWRs.length;
    badge.style.display = _reviewWRs.length > 0 ? 'flex' : 'none';
  }

  const list = _el.querySelector('.wr-inbox-list');
  if (!list) return;

  if (!_reviewWRs.length) {
    list.innerHTML = '<div class="wr-inbox-empty">No incoming work requests</div>';
    return;
  }

  list.innerHTML = _reviewWRs.map((wr, i) => {
    const isReady = wr.aiClassified;
    const borderCol = isReady ? '#3fb950' : '#f0a800';
    const tag = isReady
      ? '<span class="wr-inbox-tag wr-inbox-tag--ready">AI READY</span>'
      : (wr.aiError ? '<span class="wr-inbox-tag wr-inbox-tag--error">AI FAILED</span>' : '<span class="wr-inbox-tag wr-inbox-tag--pending">PENDING</span>');

    const aiDetails = isReady && wr.payload ? `
      <div class="wr-inbox-ai">
        <div><strong>Title:</strong> ${_esc(wr.payload.title)}</div>
        <div><strong>Area:</strong> ${_esc(wr.aiArea)} → ${_esc(wr.aiSubcategory)}</div>
        <div><strong>Vendor:</strong> ${_esc(wr.aiVendor || 'Auto-assign')}</div>
        <div><strong>Urgent:</strong> ${wr.payload.urgent === 'Yes' ? '⚠️ YES' : 'No'}</div>
      </div>` : '';

    return `
      <div class="wr-inbox-card" style="border-left-color:${borderCol}" data-idx="${i}">
        <div class="wr-inbox-card-header">
          <div class="wr-inbox-card-title">${_esc(wr.unit || (wr.payload && wr.payload.unit))} — ${_esc(wr.issue || (wr.payload && wr.payload.title))} ${tag}</div>
          <div class="wr-inbox-card-meta">
            ${wr.reportedBy ? '<span>From: ' + _esc(wr.reportedBy) + '</span>' : ''}
            ${wr.site ? '<span>Site: ' + _esc(wr.site) + '</span>' : ''}
            <span>${_timeSince(wr.createdAt)}</span>
          </div>
        </div>
        ${aiDetails}
        <div class="wr-inbox-card-actions">
          <button class="wr-inbox-btn wr-inbox-btn--approve" data-action="approve" data-idx="${i}">${isReady ? '⚡ Approve & Submit' : '✅ Approve'}</button>
          <button class="wr-inbox-btn wr-inbox-btn--decline" data-action="decline" data-idx="${i}">🚫 Decline</button>
        </div>
      </div>`;
  }).join('');
}

function _timeSince(dateStr) {
  if (!dateStr) return '';
  const secs = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
}

async function _loadReview() {
  console.log('[draft-inbox] _loadReview called, window.partner:', !!window.partner);
  if (!window.partner) return;
  try {
    const result = await window.partner.getReview();
    console.log('[draft-inbox] getReview result:', result);
    _reviewWRs = result || [];
    _render();
  } catch (e) {
    console.error('[draft-inbox] getReview error:', e);
  }
}

async function _approve(idx) {
  if (!window.partner) return;
  const wr = _reviewWRs[idx];
  if (!wr) return;
  try {
    const result = await window.partner.approve(idx);
    if (result && result.ok) {
      bus.emit('ui:notif-push', { icon: '✅', title: 'WR Created', body: (wr.payload && wr.payload.unit) + ' — ' + (wr.payload && wr.payload.title), time: Date.now() });
      _reviewWRs.splice(idx, 1);
      _render();
    } else {
      bus.emit('ui:notif-push', { icon: '❌', title: 'Submit Failed', body: result.error || 'Unknown error', time: Date.now() });
    }
  } catch (e) {
    bus.emit('ui:notif-push', { icon: '❌', title: 'Error', body: e.message, time: Date.now() });
  }
}

async function _decline(idx) {
  if (!window.partner) return;
  await window.partner.decline(idx);
  _reviewWRs.splice(idx, 1);
  _render();
}

function _toggle() {
  _open = !_open;
  console.log('[draft-inbox] toggle → open:', _open, '_el:', !!_el);
  if (_el) _el.classList.toggle('open', _open);
  if (_open) _loadReview();
}

let _formsPollTimer = null;

function _startAutoFormsPoll() {
  // Read config from localStorage
  const cfg = JSON.parse(localStorage.getItem('fleet_forms_config') || '{}');
  if (!cfg.sheetId) return; // Not configured yet

  const interval = (cfg.pollInterval || 60) * 1000;

  // Poll immediately on boot
  _pollForms(cfg.sheetId);

  // Then on interval
  _formsPollTimer = setInterval(() => _pollForms(cfg.sheetId), interval);
}

async function _pollForms(rawId) {
  if (!window.partner) return;
  try {
    // Extract gid and clean sheet ID
    let gid = '0';
    const gidMatch = rawId.match(/gid=(\d+)/);
    if (gidMatch) gid = gidMatch[1];
    let sheetId = rawId.replace(/\/edit.*$/, '').replace(/[?#].*$/, '').replace(/\/+$/, '').trim();
    if (sheetId.includes('spreadsheets/d/')) sheetId = sheetId.split('spreadsheets/d/')[1].split('/')[0];
    if (sheetId.includes('/')) sheetId = sheetId.split('/')[0];

    const csvUrl = "https://docs.google.com/spreadsheets/d/" + sheetId + "/export?format=tsv";

    const resp = await fetch(csvUrl);
    if (!resp.ok) return;
    const csv = await resp.text();

    const result = await window.partner.pollForms({ csvText: csv });
    if (result && result.newCount > 0) {
      _loadReview();
      bus.emit('ui:notif-push', { icon: '📩', title: 'Partner Request', body: result.newCount + ' new work request(s)', time: Date.now() });
    }
  } catch (e) {
    console.warn('[draft-inbox] auto-poll error:', e.message);
  }
}

export function init() {
  _el = document.createElement('div');
  _el.className = 'wr-inbox';
  _el.innerHTML = `
    <div class="wr-inbox-header">
      <span class="wr-inbox-header-title">📋 Incoming Work Requests</span>
      <button class="wr-inbox-close" id="wr-inbox-close">▼</button>
    </div>
    <div class="wr-inbox-list"></div>
  `;
  document.body.appendChild(_el);

  _el.querySelector('#wr-inbox-close').addEventListener('click', _toggle);

  // Delegated click handler
  _el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const idx = parseInt(btn.dataset.idx, 10);
    if (action === 'approve') _approve(idx);
    else if (action === 'decline') _decline(idx);
  });

  // Bus events
  bus.on('ui:inbox-toggle', _toggle);

  // Listen for new requests from main
  if (window.partner && window.partner.onNewRequests) {
    window.partner.onNewRequests((data) => {
      _loadReview();
      bus.emit('ui:notif-push', { icon: '📩', title: 'New Partner Request', body: data.count + ' new work request(s)', time: Date.now() });
    });
  }

  // Poll every 60s — refresh inbox UI
  _pollTimer = setInterval(_loadReview, 60000);
  _loadReview();

  // Auto-poll forms for new submissions
  _startAutoFormsPoll();

  // Re-start polling when config changes (user saves in settings)
  bus.on('config:forms-changed', () => {
    if (_formsPollTimer) clearInterval(_formsPollTimer);
    _startAutoFormsPoll();
  });
}
