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
    const isDealerWR = wr.status === 'dealer-wr-needed';
    const isReady = wr.aiClassified && !isDealerWR;
    const borderCol = isDealerWR ? '#4493f8' : (isReady ? '#3fb950' : '#f0a800');
    const tag = isDealerWR
      ? '<span class="wr-inbox-tag wr-inbox-tag--dealer">DEALER WR NEEDED</span>'
      : (isReady
        ? '<span class="wr-inbox-tag wr-inbox-tag--ready">AI READY</span>'
        : (wr.aiError ? '<span class="wr-inbox-tag wr-inbox-tag--error">AI FAILED</span>' : '<span class="wr-inbox-tag wr-inbox-tag--pending">PENDING</span>'));

    const aiDetails = wr.payload ? `
      <div class="wr-inbox-ai">
        <div><strong>Title:</strong> ${_esc(wr.payload.title)}</div>
        <div><strong>Area:</strong> ${_esc(wr.aiArea || (wr.payload.areaPairs && wr.payload.areaPairs[0] && wr.payload.areaPairs[0].area))} → ${_esc(wr.aiSubcategory || (wr.payload.areaPairs && wr.payload.areaPairs[0] && wr.payload.areaPairs[0].subcategory))}</div>
        <div><strong>Vendor:</strong> ${_esc(wr.aiVendor || wr.payload.vendor || 'Auto-assign')}</div>
        ${isDealerWR ? '<div style="color:#4493f8;font-weight:600">⚠ Create this WR manually via the dealer portal, then Mark Done.</div>' : ''}
        <div><strong>Urgent:</strong> ${wr.payload.urgent === 'Yes' ? '\u26a0\ufe0f YES' : 'No'}</div>
      </div>` : '';

    const actions = isDealerWR
      ? `<button class="wr-inbox-btn wr-inbox-btn--approve" data-action="decline" data-idx="${i}">✅ Mark Done</button>
         <button class="wr-inbox-btn wr-inbox-btn--decline" data-action="decline" data-idx="${i}">🚫 Dismiss</button>`
      : `<button class="wr-inbox-btn wr-inbox-btn--approve" data-action="approve" data-idx="${i}">${isReady ? '⚡ Approve & Submit' : '✅ Approve'}</button>
         <button class="wr-inbox-btn wr-inbox-btn--decline" data-action="decline" data-idx="${i}">🚫 Decline</button>`;

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
          ${actions}
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

// FIX: this previously only ever pushed to 'ui:notif-push' -- which just
// bumps a badge count on the bell icon (notif-dropdown.js) that the user has
// to separately open to see. Clicking Approve gave literally zero on-screen
// feedback either on success OR failure, which is the confirmed root cause
// of "I approve an Incoming Work Request and nothing happens" -- it wasn't
// that approve was silently failing every time (sometimes it was, per the
// partner-wr.js backend fix above), it's that even a SUCCESSFUL submit was
// invisible unless you happened to open the notification bell. Now also
// fires a visible toast (renderer/src/js/components/toast.js, bottom-left,
// same mechanism every other action in this app already uses) and disables
// the button + shows "Submitting..." while the request is in flight, since
// approve can now take a few seconds (classify-on-demand + real AAP submit).
async function _approve(idx) {
  if (!window.partner) return;
  const wr = _reviewWRs[idx];
  if (!wr) return;

  const card = _el.querySelector(`.wr-inbox-card[data-idx="${idx}"]`);
  const btn  = card ? card.querySelector('[data-action="approve"]') : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }

  try {
    const result = await window.partner.approve(idx);
    if (result && result.ok) {
      const label = (wr.payload && wr.payload.unit) || wr.unit || 'unit';
      const title = (wr.payload && wr.payload.title) || wr.issue || '';
      if (result.dealerWRNeeded) {
        // Relay WR created -- now remind user to also create dealer WR
        bus.emit('ui:toast', { type: 'success', message: `Relay WR created for ${label}${result.workRequestId ? ' (' + result.workRequestId + ')' : ''} \u2014 dealer WR still needed via ${result.vendor}`, duration: 8000 });
        bus.emit('ui:notif-push', { icon: '\uD83C\uDFE2', title: 'Dealer WR Needed', body: label + ' \u2014 relay WR done, create dealer WR via ' + result.vendor, time: Date.now() });
        await _loadReview(); // re-render with DEALER WR NEEDED badge (card stays)
        return;
      }
      bus.emit('ui:toast', { type: 'success', message: `WR submitted for ${label}${result.workRequestId ? ' (' + result.workRequestId + ')' : ''} \u2014 ${title}`, duration: 5000 });
      bus.emit('ui:notif-push', { icon: '\u2705', title: 'WR Created', body: label + ' \u2014 ' + title, time: Date.now() });
      _reviewWRs.splice(idx, 1);
      _render();
    } else {
      bus.emit('ui:toast', { type: 'error', message: 'Approve failed: ' + (result && result.error || 'Unknown error'), duration: 6000 });
      bus.emit('ui:notif-push', { icon: '\u274c', title: 'Submit Failed', body: (result && result.error) || 'Unknown error', time: Date.now() });
      await _loadReview(); // refresh from backend (aiError/status may have changed) -- re-renders with correct button label/state
    }
  } catch (e) {
    bus.emit('ui:toast', { type: 'error', message: 'Approve error: ' + e.message, duration: 6000 });
    bus.emit('ui:notif-push', { icon: '\u274c', title: 'Error', body: e.message, time: Date.now() });
    if (btn) { btn.disabled = false; }
    _render();
  }
}

async function _decline(idx) {
  if (!window.partner) return;
  const wr = _reviewWRs[idx];
  await window.partner.decline(idx);
  bus.emit('ui:toast', { type: 'info', message: 'Declined' + (wr ? ' \u2014 ' + (wr.unit || (wr.payload && wr.payload.unit) || '') : ''), duration: 3000 });
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
