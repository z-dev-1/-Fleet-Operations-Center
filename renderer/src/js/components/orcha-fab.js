/**
 * orcha-fab.js -- Orcha AI Companion (FAB + Chat Panel)
 *
 * Full AI companion that:
 *   - Knows EVERYTHING about the fleet (units, timelines, vendors, statuses)
 *   - Executes ANY action (SP push, email, sync, timeline, Slack)
 *   - Has personality — helpful, witty, professional
 *   - Proactively suggests priorities and tasks
 *   - Sends/receives Slack messages (AI-composed)
 */

import bus from '../bus.js';
import { ai, slack } from '../bridge.js';
import state from '../state.js';
import toast from '../components/toast.js';

let _panelOpen = false;
let _slackAuthed = false;
let _pollTimer = null;
let _lastDmTs = null;
let _initialized = false;
let _pendingActions = null;
let _contacts = []; // { id, name, type: 'user'|'channel' }
let _acEl = null;   // autocomplete dropdown element

// ── FEATURE (2026-07-16): Slack tab state (Chat / Slack tabs in this panel) ──
let _activeTab = 'chat';
let _activeSlackChannel = null; // { id, name, type } — currently open thread
let _slackTabRefreshTimer = null;

// ── Conversation memory ───────────────────────────────────────────────────
const MAX_HISTORY = 30;
let _chatHistory = JSON.parse(localStorage.getItem('orcha_chat_history') || '[]');

function _addHistory(role, content) {
  _chatHistory.push({ role, content, ts: Date.now() });
  if (_chatHistory.length > MAX_HISTORY) _chatHistory = _chatHistory.slice(-MAX_HISTORY);
  localStorage.setItem('orcha_chat_history', JSON.stringify(_chatHistory));
}

function _getHistoryContext() {
  if (!_chatHistory.length) return '';
  return '\nCONVERSATION HISTORY (last ' + _chatHistory.length + ' messages):\n' +
    _chatHistory.map(h => (h.role === 'user' ? 'User' : 'Orcha') + ': ' + h.content.substring(0, 300)).join('\n') + '\n';
}

async function _loadContacts() {
  try {
    const channels = await slack.getChannels();
    if (channels && Array.isArray(channels)) {
      _contacts = channels.map(ch => ({
        id: ch.id || ch.name,
        name: ch.name || ch.id,
        type: ch.is_im || ch.is_mpim ? 'user' : 'channel'
      }));
    }
  } catch(e) { /* silent — Slack may not be authed */ }
}

function _showAutocomplete(query, cursorPos) {
  const inp = document.getElementById('orcha-input');
  if (!inp || !query) { _hideAutocomplete(); return; }
  
  const filtered = _contacts.filter(c => c.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
  if (!filtered.length) { _hideAutocomplete(); return; }

  if (!_acEl) {
    _acEl = document.createElement('div');
    _acEl.className = 'oc-autocomplete';
    _acEl.id = 'oc-autocomplete';
    inp.parentElement.appendChild(_acEl);
  }

  _acEl.innerHTML = filtered.map((c, i) => 
    '<div class="oc-ac-item" data-idx="' + i + '" data-name="' + c.name + '">' +
    '<span class="oc-ac-icon">' + (c.type === 'channel' ? '#' : '@') + '</span>' +
    '<span class="oc-ac-name">' + c.name + '</span></div>'
  ).join('');
  _acEl.style.display = 'flex';

  // Click handler
  _acEl.querySelectorAll('.oc-ac-item').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const name = el.dataset.name;
      const val = inp.value;
      // Find the @ or # trigger position
      const triggerIdx = val.lastIndexOf('@', cursorPos) !== -1 ? val.lastIndexOf('@', cursorPos) : val.lastIndexOf('#', cursorPos);
      if (triggerIdx > -1) {
        inp.value = val.substring(0, triggerIdx) + (el.querySelector('.oc-ac-icon').textContent === '#' ? '#' : '@') + name + ' ' + val.substring(cursorPos);
        inp.focus();
        inp.setSelectionRange(triggerIdx + name.length + 2, triggerIdx + name.length + 2);
      }
      _hideAutocomplete();
    });
  });
}

function _hideAutocomplete() {
  if (_acEl) _acEl.style.display = 'none';
}

function _handleInputForMentions(e) {
  const inp = e.target;
  const val = inp.value;
  const pos = inp.selectionStart;
  
  // Check if we're in a mention context (after @ or #)
  const beforeCursor = val.substring(0, pos);
  const atMatch = beforeCursor.match(/[@#]([\w.-]*)$/);
  
  if (atMatch) {
    _showAutocomplete(atMatch[1], pos);
  } else {
    _hideAutocomplete();
  }
}

function _togglePanel() {
  _panelOpen = !_panelOpen;
  const panel = document.getElementById('orcha-panel');
  const fab   = document.getElementById('orcha-fab');
  const rd    = document.getElementById('detail-panel');
  if (!panel || !fab) return;
  panel.classList.toggle('open', _panelOpen);
  fab.classList.toggle('open', _panelOpen);
  const offset = (rd && rd.classList.contains('open')) ? '424px' : '24px';
  panel.style.right = offset;
  fab.style.right   = offset;
  if (_panelOpen && !_initialized) { _initialized = true; _onFirstOpen(); }
  // Always start Slack poll (background DM check)
  if (!_pollTimer) _startSlackPoll();
  // FEATURE (2026-07-16): stop the Slack-tab-specific refresh timer when the
  // whole panel closes, so it doesn't keep polling in the background when
  // the user can't even see it (separate from the always-on DM poll above).
  if (!_panelOpen) _stopSlackTabRefresh();
  else if (_activeTab === 'slack') _startSlackTabRefresh();
}

function _appendMsg(cls, text, meta) {
  const msgs = document.getElementById('orcha-msgs');
  if (!msgs) return;
  const d = document.createElement('div');
  d.className = 'oc-msg ' + cls;
  if (meta) {
    d.innerHTML = '<div class="oc-msg-meta">' + meta + '</div><div class="oc-msg-text">' + _esc(text) + '</div>';
  } else if (text.includes('\n')) {
    d.innerHTML = '<div class="oc-msg-text">' + _esc(text).replace(/\n/g, '<br>') + '</div>';
  } else {
    d.textContent = text;
  }
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
}

const _esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Fleet knowledge builder ─────────────────────────────────────────────────
function _buildFullContext() {
  const fleet = state.slice('fleet');
  const rows = fleet.rows || [];
  const unavail = rows.filter(r => r.lifecycleState && r.lifecycleState.toLowerCase().includes('unavail'));
  
  let context = `You are Orcha — an AI fleet operations companion. You're helpful, sharp, occasionally funny (when asked), and always professional about fleet work. You know EVERYTHING about the user's fleet.

CURRENT FLEET (${new Date().toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric'})} @ ${new Date().toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'})}):
- Total units: ${rows.length}
- Available: ${rows.length - unavail.length}
- Unavailable: ${unavail.length}

UNAVAILABLE UNITS:\n`;

  unavail.forEach(u => {
    const ns = (fleet.notesStore && fleet.notesStore[u.equipmentId]) || {};
    context += `${u.equipmentId} | ${u.vendor || 'no vendor'} | ${u.savedRepairStatus || 'unknown status'} | ${u.savedPrimaryComponent || ''} | ${u.domicileSite || ''} | Down: ${u.duration || '?'} | Issue: ${ns.issueSummary || u.issueSummary || 'unknown'}\n`;
  });

  context += `\nYou can execute actions: push sharepoint, send email, sync fleet, add timeline entries, send slack messages. When the user asks you to DO something, confirm you did it. When they ask questions, be concise and data-driven. If they ask you to be funny, BE FUNNY.`;
  
  return context;
}

function _findUnit(id) {
  const fleet = state.slice('fleet');
  const rows = fleet.rows || [];
  const unit = rows.find(r => r.equipmentId === id || r.equipmentId === id.toUpperCase() || r.equipmentId === id.replace(/^0+/, ''));
  if (!unit) return null;
  const ns = (fleet.notesStore && fleet.notesStore[unit.equipmentId]) || {};
  return { ...unit, timeline: ns.timeline || unit.repairTimeline || '', issueSummary: ns.issueSummary || unit.issueSummary || '', savedNotes: ns.notes || unit.savedNotes || '' };
}

function _extractUnitId(text) {
  const m = text.match(/\b([BS]?\d{5,8})\b/i);
  return m ? m[1].toUpperCase() : null;
}

// ── Proactive briefing on first open ────────────────────────────────────────
async function _onFirstOpen() {
  const fleet = state.slice('fleet');
  const rows = fleet.rows || [];
  const unavail = rows.filter(r => r.lifecycleState && r.lifecycleState.toLowerCase().includes('unavail'));
  
  if (unavail.length === 0) {
    _appendMsg('oc-msg--orcha', "All units in service. Nothing on fire. You're welcome. ☕");
    return;
  }

  // Build priority suggestions
  const stale = unavail.filter(u => {
    const d = u.duration || '';
    const days = parseInt((d.match(/(\d+)\s*day/) || [])[1] || '0');
    return days >= 7;
  });

  let briefing = `📊 Quick briefing: ${unavail.length} units down right now.`;
  if (stale.length > 0) {
    briefing += `\n\n🚨 ${stale.length} unit${stale.length > 1 ? 's' : ''} down 7+ days — need attention:`;
    stale.slice(0, 5).forEach(u => {
      briefing += `\n• ${u.equipmentId} (${u.vendor || 'no vendor'}) — ${u.duration || '?'}`;
    });
  }

  briefing += '\n\n💡 Suggested actions:';
  briefing += '\n• "Push SharePoint" to update trackers';
  briefing += '\n• "Send email" to fire the EOS report';
  if (stale.length > 0) briefing += `\n• "Slack #fleet-ops: escalation needed for ${stale[0].equipmentId}"`;

  _appendMsg('oc-msg--orcha', briefing);
}

// ── Slack polling ───────────────────────────────────────────────────────────
async function _startSlackPoll() {
  try {
    // FEATURE (2026-07-16): use checkLiveAuth() for consistency with the
    // rest of the reliability fix -- confirms the token still actually
    // works rather than just checking a file exists on disk.
    const auth = await slack.checkLiveAuth();
    _slackAuthed = auth && auth.authenticated;
  } catch(e) { _slackAuthed = false; }
  if (!_slackAuthed) return;

  _pollTimer = setInterval(async () => {
    try {
      const dms = await slack.readDMs();
      if (!dms || !dms.length) return;
      dms.forEach(msg => {
        if (_lastDmTs && msg.ts <= _lastDmTs) return;
        _lastDmTs = msg.ts;
        _appendMsg('oc-msg--slack-in', msg.text, '\u{1F4E9} ' + (msg.user || 'Slack'));
        bus.emit('ui:notif-push', { icon: '\u{1F4E9}', title: 'Slack DM', body: msg.text, time: Date.now() });
      });
    } catch(e) { /* silent */ }
  }, 30000);
}

// ── Partner Auto-Reply engine (2026-07-21) — see src/scrapers/slack_channel_watch.js
// for the full design/safety writeup. Mirrors _startSlackPoll() above:
// same "confirm live auth first, then interval" structure, separate timer
// so a failure/slowdown in one poller never affects the other.
let _channelWatchTimer = null;
const CATEGORY_META = {
  alert:    { icon: '\u{1F6A8}', label: 'Alerts' },
  action:   { icon: '\u{1F4A1}', label: 'Actions' },
  workflow: { icon: '\u{1F4CD}', label: 'Workflow' },
};

async function _startChannelWatchPoll() {
  if (_channelWatchTimer) return;
  _channelWatchTimer = setInterval(async () => {
    try {
      const result = await slack.pollChannelWatch();
      if (result && result.escalatedCount > 0) {
        bus.emit('ui:notif-push', {
          icon: '\u{1F6A8}',
          title: 'Partner AI: ' + result.escalatedCount + ' item(s) need review',
          body: (result.items[0] && result.items[0].title) || '',
          time: Date.now(),
        });
        _updateReviewBadge();
        if (_activeTab === 'review') _refreshReviewQueue();
      }
    } catch (e) { /* silent -- same pattern as DM poller above */ }
  }, 30000);
}

async function _updateReviewBadge() {
  try {
    const items = await slack.getReviewQueue();
    const badge = document.getElementById('oc-review-badge');
    if (!badge) return;
    if (items && items.length) {
      badge.textContent = String(items.length);
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  } catch (e) { /* silent */ }
}

// FEATURE (2026-07-21): renders the 🚨 Alerts / 💡 Actions / 📍 Workflow
// review queue -- items the Partner Auto-Reply AI could not confidently
// answer on its own. A professional holding reply was already sent to the
// partner in-channel; this view is purely for follow-up/oversight, not a
// pending-approval gate (the reply already went out).
async function _refreshReviewQueue() {
  const listEl = document.getElementById('oc-review-list');
  const emptyEl = document.getElementById('oc-review-empty');
  if (!listEl) return;
  let items = [];
  try { items = await slack.getReviewQueue(); } catch (e) { items = []; }

  _updateReviewBadge();

  if (!items.length) {
    listEl.innerHTML = '<div class="oc-review-empty" id="oc-review-empty">No items need review right now.</div>';
    return;
  }

  listEl.innerHTML = items.map((item) => {
    const meta = CATEGORY_META[item.category] || CATEGORY_META.workflow;
    const when = _formatSlackTs(item.ts);
    return `<div class="oc-review-item" data-id="${_escapeHtml(item.id)}">
      <div class="oc-review-item-head">
        <span class="oc-review-cat">${meta.icon} ${meta.label}</span>
        <span class="oc-review-chan">#${_escapeHtml(item.channelName || '')}</span>
        <span class="oc-review-time">${when}</span>
      </div>
      <div class="oc-review-question">${_escapeHtml(item.question || '')}</div>
      <div class="oc-review-reply"><span class="oc-review-reply-label">Sent to partner:</span> ${_escapeHtml(item.reply || '')}</div>
      <div class="oc-review-actions">
        <button class="oc-review-btn oc-review-btn--done" data-action="done">Mark handled</button>
        <button class="oc-review-btn oc-review-btn--dismiss" data-action="dismiss">Dismiss</button>
      </div>
    </div>`;
  }).join('');

  listEl.querySelectorAll('.oc-review-item').forEach((el) => {
    const id = el.getAttribute('data-id');
    el.querySelectorAll('.oc-review-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-action');
        const status = action === 'done' ? 'done' : 'dismissed';
        try {
          await slack.updateReviewItem({ id, updates: { status } });
          toast.show('success', action === 'done' ? 'Marked handled' : 'Dismissed', 2000);
          _refreshReviewQueue();
        } catch (e) {
          toast.show('error', 'Failed to update: ' + e.message, 3000);
        }
      });
    });
  });
}

function _formatSlackTs(ts) {
  try {
    const d = new Date(parseFloat(ts) * 1000);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch (e) { return ''; }
}

function _escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── FEATURE (2026-07-16): Slack tab — Chat/Slack tab switching ──────────────
function _switchTab(tab) {
  if (tab === _activeTab) return;
  _activeTab = tab;
  const chatBtn  = document.getElementById('oc-tab-btn-chat');
  const slackBtn = document.getElementById('oc-tab-btn-slack');
  const reviewBtn = document.getElementById('oc-tab-btn-review');
  const chatPane = document.getElementById('oc-tab-chat');
  const slackPane = document.getElementById('oc-tab-slack');
  const reviewPane = document.getElementById('oc-tab-review');
  if (chatBtn)  chatBtn.classList.toggle('oc-tab--active', tab === 'chat');
  if (slackBtn) slackBtn.classList.toggle('oc-tab--active', tab === 'slack');
  if (reviewBtn) reviewBtn.classList.toggle('oc-tab--active', tab === 'review');
  if (chatPane)  chatPane.style.display  = tab === 'chat'  ? '' : 'none';
  if (slackPane) slackPane.style.display = tab === 'slack' ? '' : 'none';
  if (reviewPane) reviewPane.style.display = tab === 'review' ? '' : 'none';

  if (tab === 'slack') {
    _refreshSlackTabState();
    _startSlackTabRefresh();
  } else if (tab === 'review') {
    _stopSlackTabRefresh();
    _refreshReviewQueue();
  } else {
    _stopSlackTabRefresh();
  }
}

// Only one of these three views is visible at a time within the Slack tab.
function _showSlackView(view) {
  const signin = document.getElementById('oc-slack-signin');
  const search = document.getElementById('oc-slack-search');
  const thread = document.getElementById('oc-slack-thread');
  if (signin) signin.style.display = view === 'signin' ? '' : 'none';
  if (search) search.style.display = view === 'search' ? '' : 'none';
  if (thread) thread.style.display = view === 'thread' ? '' : 'none';
}

// FEATURE (2026-07-16): uses checkLiveAuth() (confirms the token still
// actually works via Slack's auth.test) rather than just checking a token
// file exists on disk -- see slack_send.js for the full rationale. This is
// what makes sign-in status "reliable" instead of potentially showing
// connected forever after a session goes stale.
async function _refreshSlackTabState() {
  const statusEl = document.getElementById('oc-slack-status');
  if (statusEl) statusEl.textContent = 'Checking connection\u2026';
  _showSlackView('signin');
  try {
    const res = await slack.checkLiveAuth();
    if (res && res.authenticated) {
      _slackAuthed = true;
      _showSlackView('search');
      _renderSlackList([]); // shows the empty "type to search" prompt
    } else {
      _slackAuthed = false;
      if (statusEl) {
        const reason = res && res.reason;
        statusEl.textContent = (reason && reason !== 'not_configured')
          ? 'Not connected (' + reason + ')'
          : 'Not connected to Slack';
      }
    }
  } catch (e) {
    _slackAuthed = false;
    if (statusEl) statusEl.textContent = 'Connection check failed: ' + e.message;
  }
}

// FEATURE (2026-07-16): searchDirectory() replaces the old channel/DM
// browse list. Amazon's Enterprise Grid Slack workspace blocks bulk
// conversation listing (conversations.list / users.conversations both
// return "enterprise_is_restricted" -- verified live against the real
// API), so browsing "everything" can never work here. Individual
// search.modules lookups (people AND channels) are NOT restricted and do
// work, so this searches by name instead of listing.
let _slackSearchDebounce = null;

function _renderSlackList(items) {
  const listEl = document.getElementById('oc-slack-list');
  if (!listEl) return;
  if (!items.length) {
    listEl.innerHTML = '<div class="oc-slack-loading">Type a name or #channel to search</div>';
    return;
  }
  listEl.innerHTML = items.map((c) => {
    const icon = c.type === 'channel' ? '#' : '@';
    return '<div class="oc-slack-item" data-id="' + _esc(c.id) + '" data-name="' + _esc(c.name) + '" data-type="' + _esc(c.type) + '">' +
      '<span class="oc-slack-item-icon">' + icon + '</span>' +
      '<span class="oc-slack-item-name">' + _esc(c.name) + '</span>' +
    '</div>';
  }).join('');
  listEl.querySelectorAll('.oc-slack-item').forEach((el) => {
    el.addEventListener('click', () => {
      _openSlackThread({ id: el.dataset.id, name: el.dataset.name, type: el.dataset.type });
    });
  });
}

async function _runSlackSearch(query) {
  const listEl = document.getElementById('oc-slack-list');
  if (!query || !query.trim()) { _renderSlackList([]); return; }
  if (listEl) listEl.innerHTML = '<div class="oc-slack-loading">Searching\u2026</div>';
  try {
    const results = await slack.searchDirectory({ query: query.trim(), limit: 8 });
    _renderSlackList(Array.isArray(results) ? results : []);
  } catch (e) {
    if (listEl) listEl.innerHTML = '<div class="oc-slack-loading">Search failed: ' + _esc(e.message) + '</div>';
  }
}

// FEATURE (2026-07-16): resolves a search result (person or channel) to an
// actual open conversation via slack:open-conversation, then loads its
// history. Channels resolve instantly (ID passthrough); people require an
// conversations.open call to get/create the DM -- both verified working
// live even though bulk listing is restricted.
async function _openSlackThread(entry) {
  const titleEl = document.getElementById('oc-slack-thread-title');
  if (titleEl) titleEl.textContent = (entry.type === 'channel' ? '#' : '@') + entry.name;
  const msgsEl = document.getElementById('oc-slack-msgs');
  if (msgsEl) msgsEl.innerHTML = '<div class="oc-slack-loading">Opening conversation\u2026</div>';
  _showSlackView('thread');
  try {
    const opened = await slack.openConversation(entry);
    _activeSlackChannel = { id: opened.channelId, name: entry.name, type: entry.type };
    await _refreshSlackThreadMessages();
  } catch (e) {
    if (msgsEl) msgsEl.innerHTML = '<div class="oc-slack-loading">Failed to open: ' + _esc(e.message) + '</div>';
  }
}

async function _refreshSlackThreadMessages() {
  if (!_activeSlackChannel) return;
  const msgsEl = document.getElementById('oc-slack-msgs');
  try {
    const messages = await slack.read({ channelId: _activeSlackChannel.id, limit: 30 });
    _renderSlackThreadMessages(Array.isArray(messages) ? messages : []);
  } catch (e) {
    if (msgsEl) msgsEl.innerHTML = '<div class="oc-slack-loading">Failed to load: ' + _esc(e.message) + '</div>';
  }
}

function _renderSlackThreadMessages(messages) {
  const msgsEl = document.getElementById('oc-slack-msgs');
  if (!msgsEl) return;
  if (!messages.length) {
    msgsEl.innerHTML = '<div class="oc-slack-loading">No messages yet</div>';
    return;
  }
  // Slack returns newest-first; display oldest-first like a normal thread.
  const ordered = messages.slice().reverse();
  msgsEl.innerHTML = ordered.map((m) =>
    '<div class="oc-msg oc-msg--slack-in">' + _esc(m.text || '') + '</div>'
  ).join('');
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

async function _sendSlackReply() {
  const inp = document.getElementById('oc-slack-reply-input');
  const val = (inp && inp.value || '').trim();
  if (!val || !_activeSlackChannel) return;
  inp.value = '';
  const msgsEl = document.getElementById('oc-slack-msgs');
  if (msgsEl) {
    const d = document.createElement('div');
    d.className = 'oc-msg oc-msg--user';
    d.textContent = val;
    msgsEl.appendChild(d);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  try {
    await slack.sendToChannel({ channelId: _activeSlackChannel.id, message: val });
  } catch (e) {
    if (msgsEl) {
      const d = document.createElement('div');
      d.className = 'oc-msg oc-msg--orcha';
      d.textContent = '\u274C Failed to send: ' + e.message;
      msgsEl.appendChild(d);
    }
  }
}

// Light periodic refresh while the Slack tab is actually visible — catches
// a session going stale mid-view, and keeps an open thread reasonably live.
// Deliberately separate from _startSlackPoll() (the always-on 30s DM->chat
// notification poll) so this only runs while the user is looking at it.
function _startSlackTabRefresh() {
  if (_slackTabRefreshTimer) return;
  _slackTabRefreshTimer = setInterval(() => {
    if (_activeSlackChannel && document.getElementById('oc-slack-thread').style.display !== 'none') {
      _refreshSlackThreadMessages();
    }
  }, 15000);
}
function _stopSlackTabRefresh() {
  if (_slackTabRefreshTimer) { clearInterval(_slackTabRefreshTimer); _slackTabRefreshTimer = null; }
}

async function _slackLogin() {
  const btn = document.getElementById('oc-slack-login-btn');
  const statusEl = document.getElementById('oc-slack-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in\u2026'; }
  if (statusEl) statusEl.textContent = 'Complete sign-in in the popup window\u2026';
  try {
    const result = await slack.login();
    if (result && result.ok) {
      await _refreshSlackTabState();
    } else {
      if (statusEl) statusEl.textContent = (result && result.error) || 'Sign-in was not completed';
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Sign-in failed: ' + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sign in to Slack'; }
  }
}

function _wireSlackTab() {
  const chatBtn  = document.getElementById('oc-tab-btn-chat');
  const slackBtn = document.getElementById('oc-tab-btn-slack');
  const reviewBtn = document.getElementById('oc-tab-btn-review');
  if (chatBtn)  chatBtn.addEventListener('click', () => _switchTab('chat'));
  if (slackBtn) slackBtn.addEventListener('click', () => _switchTab('slack'));
  if (reviewBtn) reviewBtn.addEventListener('click', () => _switchTab('review'));

  const loginBtn = document.getElementById('oc-slack-login-btn');
  if (loginBtn) loginBtn.addEventListener('click', _slackLogin);

  const backBtn = document.getElementById('oc-slack-back');
  if (backBtn) backBtn.addEventListener('click', () => { _activeSlackChannel = null; _showSlackView('search'); });

  // FEATURE (2026-07-16): debounced search-as-you-type (300ms), replacing
  // the old browse-list click handler that's no longer possible here.
  const searchInput = document.getElementById('oc-slack-search-input');
  if (searchInput) searchInput.addEventListener('input', (e) => {
    clearTimeout(_slackSearchDebounce);
    const q = e.target.value;
    _slackSearchDebounce = setTimeout(() => _runSlackSearch(q), 300);
  });

  const replySend = document.getElementById('oc-slack-reply-send');
  if (replySend) replySend.addEventListener('click', _sendSlackReply);
  const replyInput = document.getElementById('oc-slack-reply-input');
  if (replyInput) replyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') _sendSlackReply(); });
}

// ── Timeline writing ────────────────────────────────────────────────────────
async function _addToTimeline(unitId, entry) {
  const today = new Date();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');

  // The AI rewrite is cosmetic only (professionalize wording). If it fails —
  // e.g. Orcha token quota exhausted — the raw entry must still be saved.
  // A user asking Orcha to add a timeline note is manual intent and must
  // never be blocked by an AI call failure.
  let professional = `${mm}/${dd} - ${entry}`;
  try {
    const prompt = `Rewrite as a single fleet timeline entry. Format: "${mm}/${dd} - What happened." Professional fleet maintenance voice. No names, no costs. Max 1-2 sentences. Just output the line:\n\n${entry}`;
    const aiResult = await ai.chat(prompt);
    if (aiResult && aiResult.text) professional = aiResult.text;
  } catch (e) {
    // AI unavailable (e.g. out of tokens) — fall back to the raw entry above.
  }

  const result = await window.ai.appendTimeline({ unitId, entry: professional });
  return { ok: result && result.ok, entry: professional };
}

// ── Main send handler ───────────────────────────────────────────────────────
async function _send() {
  const inp = document.getElementById('orcha-input');
  const val = (inp.value || '').trim();
  if (!val) return;
  inp.value = '';
  _appendMsg('oc-msg--user', val);
  _addHistory('user', val);

  const status = document.getElementById('orcha-status');
  if (status) status.textContent = '\u{25CF} Thinking...';

  try {
    // Route everything through smart AI action handler
    const result = await window.ai.orchaAction(val);
    const text = (result && result.text) || 'No response';
    
    // Check if there are pending SLACK or EMAIL actions that need confirmation
    if (text.includes('Slack sent to') || text.includes('Email composed to')) {
      _appendMsg('oc-msg--orcha', text);
      _addHistory('assistant', text);
    } else if (text.includes('\nSending to ') || text.includes('\nEmailing ')) {
      // Show confirmation prompt
      _appendMsg('oc-msg--orcha', text + '\n\n✅ Sent successfully.');
      _addHistory('assistant', text);
    } else {
      _appendMsg('oc-msg--orcha', text);
      _addHistory('assistant', text);
    }
  } catch(e) {
    _appendMsg('oc-msg--orcha', '❌ ' + e.message);
  }
  if (status) status.textContent = '\u{25CF} Ready';
}

// ── Init ────────────────────────────────────────────────────────────────────
export function init() {
  const fab = document.createElement('button');
  fab.id        = 'orcha-fab';
  fab.className = 'orcha-fab';
  fab.title     = 'Orcha AI';
  fab.innerHTML = '\u{2728}';
  fab.addEventListener('click', _togglePanel);
  document.body.appendChild(fab);

  const panel = document.createElement('div');
  panel.id        = 'orcha-panel';
  panel.className = 'orcha-panel';
  panel.innerHTML = `
    <div class="orcha-panel-header" id="orcha-panel-header">
      <div class="orcha-avatar">\u{2728}</div>
      <span class="orcha-title">Orcha</span>
      <span class="orcha-status" id="orcha-status">\u{25CF} Ready</span>
      <button class="orcha-close" id="orcha-close">\u{25BC}</button>
    </div>
    <div class="oc-tabs" id="oc-tabs">
      <button class="oc-tab oc-tab--active" id="oc-tab-btn-chat" data-tab="chat">Chat</button>
      <button class="oc-tab" id="oc-tab-btn-slack" data-tab="slack">Slack</button>
      <button class="oc-tab" id="oc-tab-btn-review" data-tab="review">Review<span class="oc-review-badge" id="oc-review-badge" style="display:none">0</span></button>
    </div>
    <div class="oc-tab-content" id="oc-tab-chat">
      <div class="oc-msgs" id="orcha-msgs">
        <div class="oc-msg oc-msg--orcha">Hey \u{1F44B} I'm Orcha — your fleet brain. Click me anytime.<br><br>I know every unit, every timeline, every vendor. Ask me anything, tell me to do something, or just vent about Kenworth's ETA.</div>
      </div>
      <div class="oc-input-row">
        <input class="oc-input" id="orcha-input" placeholder="Ask, command, or vent..." autocomplete="off" spellcheck="false"/>
        <button class="oc-send" id="orcha-send">\u{27A4}</button>
      </div>
    </div>
    <div class="oc-tab-content" id="oc-tab-slack" style="display:none">
      <div class="oc-slack-signin" id="oc-slack-signin">
        <div class="oc-slack-status" id="oc-slack-status">Checking connection\u{2026}</div>
        <button class="oc-send oc-slack-login-btn" id="oc-slack-login-btn">Sign in to Slack</button>
      </div>
      <div class="oc-slack-search" id="oc-slack-search" style="display:none">
        <div class="oc-input-row">
          <input class="oc-input" id="oc-slack-search-input" placeholder="Search people or #channels..." autocomplete="off" spellcheck="false"/>
        </div>
        <div class="oc-slack-list" id="oc-slack-list"></div>
      </div>
      <div class="oc-slack-thread" id="oc-slack-thread" style="display:none">
        <div class="oc-slack-thread-header" id="oc-slack-thread-header">
          <button class="oc-slack-back" id="oc-slack-back">\u{2190}</button>
          <span class="oc-slack-thread-title" id="oc-slack-thread-title"></span>
        </div>
        <div class="oc-slack-msgs" id="oc-slack-msgs"></div>
        <div class="oc-input-row">
          <input class="oc-input" id="oc-slack-reply-input" placeholder="Message..." autocomplete="off" spellcheck="false"/>
          <button class="oc-send" id="oc-slack-reply-send">\u{27A4}</button>
        </div>
      </div>
    </div>
    <div class="oc-tab-content" id="oc-tab-review" style="display:none">
      <div class="oc-review-list" id="oc-review-list">
        <div class="oc-review-empty" id="oc-review-empty">No items need review right now.</div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  document.getElementById('orcha-close').addEventListener('click', _togglePanel);
  document.getElementById('orcha-panel-header').addEventListener('click', (e) => {
    if (!e.target.closest('#orcha-close')) _togglePanel();
  });
  document.getElementById('orcha-send').addEventListener('click', _send);
  document.getElementById('orcha-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { _hideAutocomplete(); _send(); }
    if (e.key === 'Escape') _hideAutocomplete();
  });

  document.getElementById('orcha-input').addEventListener('input', _handleInputForMentions);
  document.getElementById('orcha-input').addEventListener('blur', () => setTimeout(_hideAutocomplete, 200));
  _loadContacts();
  _wireSlackTab();

  // Shift panel when right drawer opens/closes
  bus.on('ui:unit-select', () => {
    if (_panelOpen) {
      const p = document.getElementById('orcha-panel');
      const f = document.getElementById('orcha-fab');
      if (p) p.style.right = '424px';
      if (f) f.style.right = '424px';
    }
  });
  bus.on('ui:unit-deselect', () => {
    const p = document.getElementById('orcha-panel');
    const f = document.getElementById('orcha-fab');
    if (p) p.style.right = '24px';
    if (f) f.style.right = '24px';
  });

  // Incoming Slack
  if (window.slack && window.slack.onIncoming) {
    window.slack.onIncoming((msg) => {
      _appendMsg('oc-msg--slack-in', msg.text || msg.message || '', '\u{1F4E9} ' + (msg.user || msg.channel || 'Slack'));
      bus.emit('ui:notif-push', { icon: '\u{1F4E9}', title: 'Slack: ' + (msg.user || ''), body: msg.text || '', time: Date.now() });
    });
  }

  bus.on('orcha:progress', (p) => {
    const status = document.getElementById('orcha-status');
    if (status) status.textContent = '\u{25CF} ' + (p.message || 'Working...');
  });

  // Start Slack DM polling on boot (background)
  setTimeout(() => _startSlackPoll(), 3000);

  // Start Partner Auto-Reply channel watch polling on boot (background),
  // and show the review-queue badge count immediately without waiting for
  // the user to open the Review tab.
  // BUG FIX (2026-07-22): run the one-time duplicate-entry cleanup FIRST,
  // before starting the poller or reading the badge count, so any bad
  // data from before today's re-entrancy-lock fix is already cleaned up
  // by the time the user opens the Review tab. See dedupeReplyLog() in
  // slack_channel_watch.js for the full rationale.
  setTimeout(async () => {
    try { await slack.dedupeReplies(); } catch (e) { /* non-fatal, poller still starts */ }
    _startChannelWatchPoll();
    _updateReviewBadge();
  }, 4000);

  // Morning briefing
  if (window.fleet && window.fleet.onBriefing) {
    window.fleet.onBriefing((data) => {
      if (data && data.text) {
        _appendMsg('oc-msg--system', data.text);
        _addHistory('assistant', data.text);
      }
    });
  }
}
