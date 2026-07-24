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

// FEATURE (2026-07-22): inline "Reply" affordance directly under every
// Slack DM shown in this chat panel. Two-stage flow: type a raw draft ->
// optionally click "Rewrite professionally" (AI polishes wording only,
// never invents new facts/names/dates/dollar amounts) -> review/edit ->
// Send. A human always makes the final send decision -- same principle
// already applied elsewhere in this app: the Partner Auto-Reply engine's
// review queue, and _addToTimeline() below (AI rewrite is cosmetic only;
// if it fails, the raw text must still be usable, never blocked).
//
// Textarea auto-grows as the user types (up to a cap, then scrolls) so
// a long draft is never silently clipped/scrolled out of view while
// they're still writing/proofreading it.
let _replyBoxCounter = 0;

function _autoGrowTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 220) + 'px';
}

function _wireReplyBox(box, msg) {
  const textarea  = box.querySelector('.oc-reply-textarea');
  const rewriteBtn = box.querySelector('[data-action="rewrite"]');
  const sendBtn    = box.querySelector('[data-action="send"]');
  const cancelBtn  = box.querySelector('[data-action="cancel"]');
  const statusEl   = box.querySelector('.oc-reply-status');

  function _setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'oc-reply-status' + (kind ? ' oc-reply-status--' + kind : '');
    statusEl.style.display = text ? 'block' : 'none';
  }

  textarea.addEventListener('input', () => _autoGrowTextarea(textarea));

  rewriteBtn.addEventListener('click', async () => {
    const draft = textarea.value.trim();
    if (!draft) { textarea.focus(); return; }
    rewriteBtn.disabled = true; sendBtn.disabled = true;
    const originalLabel = rewriteBtn.textContent;
    rewriteBtn.textContent = 'Rewriting\u2026';
    _setStatus('', null);
    try {
      const prompt = 'Rewrite this as a professional, concise Slack direct message reply. ' +
        'Keep the exact same meaning and intent -- do not add new facts, names, dates, dollar ' +
        'amounts, or commitments that were not already in the original. No markdown, no greeting ' +
        'or signature -- just the message body as plain text, ready to send as-is:\n\n' + draft;
      const result = await ai.chat(prompt);
      if (result && result.text) {
        textarea.value = result.text.trim();
        _autoGrowTextarea(textarea);
        // Auto-send immediately after successful rewrite
        sendBtn.click();
      } else {
        throw new Error('empty AI response');
      }
    } catch (e) {
      // AI unavailable (e.g. token quota) -- draft is left untouched and
      // fully sendable as-is. Matches _addToTimeline()'s established rule
      // below: an AI rewrite failure must never block the human's ability
      // to send their own message.
      _setStatus('\u26A0\uFE0F Could not rewrite (' + e.message + ') -- you can still send your original text', 'warn');
    } finally {
      rewriteBtn.disabled = false; sendBtn.disabled = false;
      rewriteBtn.textContent = originalLabel;
    }
  });

  sendBtn.addEventListener('click', async () => {
    const finalText = textarea.value.trim();
    if (!finalText) { textarea.focus(); return; }
    sendBtn.disabled = true; rewriteBtn.disabled = true;
    const originalLabel = sendBtn.textContent;
    sendBtn.textContent = 'Sending\u2026';
    try {
      await slack.sendToChannel({ channelId: msg.channelId, message: finalText });
      _appendMsg('oc-msg--slack-out', finalText, '\u2705 You \u2192 ' + (msg.user || 'Slack'));
      box.remove();
    } catch (e) {
      _setStatus('\u274C Send failed: ' + e.message, 'err');
      sendBtn.disabled = false; rewriteBtn.disabled = false;
      sendBtn.textContent = originalLabel;
    }
  });

  cancelBtn.addEventListener('click', () => box.remove());
}

function _appendSlackDM(msg) {
  const msgs = document.getElementById('orcha-msgs');
  if (!msgs) return;
  const replyBoxId = 'oc-dm-reply-' + (++_replyBoxCounter);
  const hasChannel = !!msg.channelId; // defensive -- see onIncoming call site below, whose payload shape is unverified

  const wrap = document.createElement('div');
  wrap.className = 'oc-msg oc-msg--slack-in';
  wrap.innerHTML =
    '<div class="oc-msg-meta">\u{1F4E9} ' + _esc(msg.user || 'Slack') + '</div>' +
    '<div class="oc-msg-text">' + _esc(msg.text || '') + '</div>' +
    (hasChannel ? '<button class="oc-dm-reply-btn" type="button" data-reply-target="' + replyBoxId + '">Reply</button>' : '');
  msgs.appendChild(wrap);

  if (hasChannel) {
    const box = document.createElement('div');
    box.className = 'oc-reply-box';
    box.id = replyBoxId;
    box.style.display = 'none';
    box.innerHTML =
      '<textarea class="oc-reply-textarea" placeholder="Type your reply\u2026" rows="1"></textarea>' +
      '<div class="oc-reply-btn-row">' +
        '<button class="oc-reply-btn oc-reply-btn--ai" type="button" data-action="rewrite">\u2728 Rewrite professionally</button>' +
        '<button class="oc-reply-btn oc-reply-btn--send" type="button" data-action="send">Send</button>' +
        '<button class="oc-reply-btn oc-reply-btn--cancel" type="button" data-action="cancel">Cancel</button>' +
      '</div>' +
      '<div class="oc-reply-status" style="display:none"></div>';
    msgs.appendChild(box);
    _wireReplyBox(box, msg);

    const replyBtn = wrap.querySelector('.oc-dm-reply-btn');
    replyBtn.addEventListener('click', () => {
      const opening = box.style.display === 'none';
      box.style.display = opening ? 'flex' : 'none';
      if (opening) {
        box.querySelector('.oc-reply-textarea').focus();
        msgs.scrollTop = msgs.scrollHeight;
      }
    });
  }

  msgs.scrollTop = msgs.scrollHeight;
}


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
        // FEATURE (2026-07-22): _appendSlackDM adds the inline Reply
        // affordance -- msg.channelId comes straight from readDMs()
        // (src/scrapers/slack_send.js), so the reply always targets the
        // exact right DM thread.
        _appendSlackDM(msg);
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
let _dmAutoReplyTimer = null;
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

// FEATURE (2026-07-23): DM Auto-Reply poll -- mirrors _startChannelWatchPoll
// above but for personal Slack DMs (see slack_dm_autoreply.js). Escalations
// merge into the same Review tab list; see _refreshReviewQueue below.
async function _startDMAutoReplyPoll() {
  if (_dmAutoReplyTimer) return;
  _dmAutoReplyTimer = setInterval(async () => {
    try {
      const result = await slack.pollDMAutoReply();
      if (result && result.escalatedCount > 0) {
        bus.emit('ui:notif-push', {
          icon: '\u{1F6A8}',
          title: 'DM AI: ' + result.escalatedCount + ' item(s) need review',
          body: (result.items[0] && result.items[0].title) || '',
          time: Date.now(),
        });
        _updateReviewBadge();
        if (_activeTab === 'review') _refreshReviewQueue();
      }
    } catch (e) { /* silent -- same pattern as channel-watch poller above */ }
  }, 30000);
}

async function _updateReviewBadge() {
  try {
    // FEATURE (2026-07-23): badge now counts both the Partner Auto-Reply
    // (channel) queue and the new DM Auto-Reply queue -- see
    // _refreshReviewQueue below for how the two lists get merged.
    const [chanItems, dmItems] = await Promise.all([
      slack.getReviewQueue().catch(() => []),
      slack.getDMReviewQueue().catch(() => []),
    ]);
    const count = (chanItems ? chanItems.length : 0) + (dmItems ? dmItems.length : 0);
    const badge = document.getElementById('oc-review-badge');
    if (!badge) return;
    if (count) {
      badge.textContent = String(count);
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
// FEATURE (2026-07-23): merges the Partner Auto-Reply (channel) queue and
// the DM Auto-Reply queue into one list, tagged with `source` so the
// Mark handled/Dismiss buttons route to the right backend
// (updateReviewItem vs updateDMReviewItem below). Sorted newest-first so
// the two engines interleave naturally instead of DM items always
// trailing after channel items.
async function _refreshReviewQueue() {
  const listEl = document.getElementById('oc-review-list');
  const emptyEl = document.getElementById('oc-review-empty');
  if (!listEl) return;
  let chanItems = [];
  let dmItems = [];
  try { chanItems = await slack.getReviewQueue(); } catch (e) { chanItems = []; }
  try { dmItems = await slack.getDMReviewQueue(); } catch (e) { dmItems = []; }

  const items = [
    ...(chanItems || []).map((it) => ({ ...it, source: 'channel' })),
    ...(dmItems || []).map((it) => ({ ...it, source: 'dm' })),
  ].sort((a, b) => parseFloat(b.ts || 0) - parseFloat(a.ts || 0));

  _updateReviewBadge();

  if (!items.length) {
    listEl.innerHTML = '<div class="oc-review-empty" id="oc-review-empty">No items need review right now.</div>';
    return;
  }

  listEl.innerHTML = items.map((item) => {
    const meta = CATEGORY_META[item.category] || CATEGORY_META.workflow;
    const when = _formatSlackTs(item.ts);
    const chanLabel = item.source === 'dm'
      ? `DM: ${_escapeHtml(item.channelName || '')}`
      : `#${_escapeHtml(item.channelName || '')}`;
    const replyLabel = item.source === 'dm' ? 'Sent as you:' : 'Sent to partner:';
    return `<div class="oc-review-item" data-id="${_escapeHtml(item.id)}" data-source="${item.source}">
      <div class="oc-review-item-head">
        <span class="oc-review-cat">${meta.icon} ${meta.label}</span>
        <span class="oc-review-chan">${chanLabel}</span>
        <span class="oc-review-time">${when}</span>
      </div>
      <div class="oc-review-question">${_escapeHtml(item.question || '')}</div>
      <div class="oc-review-reply"><span class="oc-review-reply-label">${replyLabel}</span> ${_escapeHtml(item.reply || '')}</div>
      <div class="oc-review-actions">
        <button class="oc-review-btn oc-review-btn--done" data-action="done">Mark handled</button>
        <button class="oc-review-btn oc-review-btn--dismiss" data-action="dismiss">Dismiss</button>
      </div>
    </div>`;
  }).join('');

  listEl.querySelectorAll('.oc-review-item').forEach((el) => {
    const id = el.getAttribute('data-id');
    const source = el.getAttribute('data-source');
    el.querySelectorAll('.oc-review-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-action');
        const status = action === 'done' ? 'done' : 'dismissed';
        try {
          if (source === 'dm') {
            await slack.updateDMReviewItem({ id, updates: { status } });
          } else {
            await slack.updateReviewItem({ id, updates: { status } });
          }
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
function _showEmailPicker(matches, body) {
  const existing = document.getElementById('oc-email-compose');
  if (existing) existing.remove();
  if (!_panelOpen) _togglePanel();
  if (_activeTab !== 'chat') _switchTab('chat');
  const tabChat = document.getElementById('oc-tab-chat');
  if (!tabChat) return;
  const bubble = document.createElement('div');
  bubble.id = 'oc-email-compose';
  bubble.className = 'oc-quick-compose';
  bubble.innerHTML =
    '<div class="oc-qc-header">' +
      '<span>Multiple matches — pick one:</span>' +
      '<button class="oc-qc-cancel">×</button>' +
    '</div>' +
    '<div class="oc-qc-picker">' +
      matches.map(c => '<button class="oc-qc-pick-btn" data-id="' + c.id + '">' + _esc(c.name) + ' — ' + _esc(c.email) + '</button>').join('') +
    '</div>';
  const inputRow = tabChat.querySelector('.oc-input-row');
  tabChat.insertBefore(bubble, inputRow || null);
  bubble.querySelector('.oc-qc-cancel').addEventListener('click', () => bubble.remove());
  bubble.querySelectorAll('.oc-qc-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const contact = matches.find(c => c.id === btn.dataset.id);
      if (contact) { bubble.remove(); _openEmailCompose(contact, body); }
    });
  });
}

// ── Email compose bubble (2026-07-24) ──────────────────────────────────────────
// Opened from contact 📧 Email button or "email [name]" chat shortcut.
function _openEmailCompose(contact, prefill, subjectPrefill) {
  if (!contact) return;
  const existing = document.getElementById('oc-email-compose');
  if (existing) existing.remove();
  if (!_panelOpen) _togglePanel();
  if (_activeTab !== 'chat') _switchTab('chat');
  const tabChat = document.getElementById('oc-tab-chat');
  if (!tabChat) return;

  const toDisplay = contact.email
    ? _esc(contact.name) + ' <span class="oc-qc-email-addr">' + _esc(contact.email) + '</span>'
    : _esc(contact.name);

  const bubble = document.createElement('div');
  bubble.id = 'oc-email-compose';
  bubble.className = 'oc-quick-compose';
  bubble.innerHTML =
    '<div class="oc-qc-header">' +
      '<span>📧 <strong>' + toDisplay + '</strong></span>' +
      '<button class="oc-qc-cancel" title="Cancel">×</button>' +
    '</div>' +
    (contact.email ? '' : '<div class="oc-qc-warn">⚠️ No email saved for this contact — add one in Contact Book first</div>') +
    '<input class="oc-input oc-qc-subject" id="oc-qc-subject-input" placeholder="Subject…" />' +
    '<textarea class="oc-reply-textarea oc-qc-textarea" placeholder="Type your message… (Ctrl+Enter to send)" rows="4">' +
      _esc(prefill || '') +
    '</textarea>' +
    '<div class="oc-qc-footer">' +
      '<span class="oc-reply-status oc-qc-status"></span>' +
      '<button class="oc-qc-polish oc-reply-btn oc-reply-btn--ai">✨ Polish</button>' +
      '<button class="oc-qc-send oc-send" ' + (contact.email ? '' : 'disabled') + '>Send 📧</button>' +
    '</div>';

  const inputRow = tabChat.querySelector('.oc-input-row');
  tabChat.insertBefore(bubble, inputRow || null);

  const textarea  = bubble.querySelector('.oc-qc-textarea');
  const subjectEl = bubble.querySelector('.oc-qc-subject');
  const sendBtn   = bubble.querySelector('.oc-qc-send');
  const polishBtn = bubble.querySelector('.oc-qc-polish');
  const cancelBtn = bubble.querySelector('.oc-qc-cancel');
  const statusEl  = bubble.querySelector('.oc-qc-status');

  textarea.addEventListener('input', () => _autoGrowTextarea(textarea));
  if (prefill) setTimeout(() => { _autoGrowTextarea(textarea); }, 0);
  if (subjectPrefill) subjectEl.value = subjectPrefill;
  subjectEl.focus();

  cancelBtn.addEventListener('click', () => bubble.remove());
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') bubble.remove();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendBtn.click();
  });

  async function _doSend() {
    const subject = subjectEl.value.trim();
    const msg = textarea.value.trim();
    if (!msg) { textarea.focus(); return; }
    if (!subject) { subjectEl.focus(); return; }
    sendBtn.disabled = true; polishBtn.disabled = true;
    sendBtn.textContent = 'Sending\u2026';
    statusEl.textContent = '';
    try {
      const result = await window.ai.sendEmail({ to: contact.email, subject, body: msg });
      if (result && result.ok) {
        // mailto: path opens Outlook pre-filled; smtp path sends silently
        const label = result.method === 'smtp' ? '\u2713 Sent' : '\u2713 Opening in OWA\u2026';
        statusEl.textContent = label;
        statusEl.className = 'oc-reply-status oc-qc-status oc-reply-status--ok';
        setTimeout(() => bubble.remove(), result.method === 'smtp' ? 1400 : 2200);
      } else {
        throw new Error((result && result.error) || 'Send failed');
      }
    } catch (e) {
      sendBtn.disabled = false; polishBtn.disabled = false;
      sendBtn.textContent = 'Send \U0001F4E7';
      statusEl.textContent = '\u274c ' + e.message;
      statusEl.className = 'oc-reply-status oc-qc-status oc-reply-status--err';
    }
  }

  sendBtn.addEventListener('click', _doSend);

  if (polishBtn) {
    polishBtn.addEventListener('click', async () => {
      const draft = textarea.value.trim();
      if (!draft) { textarea.focus(); return; }
      // Ensure subject has at least a placeholder so _doSend() does not bail silently.
      // The AI will replace it with a proper summary below.
      if (!subjectEl.value.trim()) subjectEl.value = 'Message';
      polishBtn.disabled = true; sendBtn.disabled = true;
      const origLabel = polishBtn.textContent;
      polishBtn.textContent = 'Polishing\u2026';
      statusEl.textContent = '';
      statusEl.className = 'oc-reply-status oc-qc-status';
      try {
        const currentSubject = subjectEl.value.trim();
        const prompt =
          'You are polishing a professional fleet operations email. ' +
          'Return ONLY a JSON object (no markdown, no extra text) with exactly two keys:\n' +
          '  "subject": a concise 5-10 word subject line summarizing what the email is about\n' +
          '  "body": the improved email body -- same meaning and intent, no new facts/names/' +
          'dates/commitments, plain text only, ready to send\n\n' +
          'Current subject: ' + currentSubject + '\n' +
          'Email body:\n' + draft;
        const result = await ai.chat(prompt);
        if (result && result.text) {
          // Parse JSON response; fall back gracefully if AI returns plain text
          let polishedBody = result.text.trim();
          let polishedSubject = null;
          try {
            const jm = result.text.match(/\{[\s\S]*\}/);
            if (jm) {
              const parsed = JSON.parse(jm[0]);
              if (parsed.body)    polishedBody    = parsed.body.trim();
              if (parsed.subject) polishedSubject = parsed.subject.trim();
            }
          } catch (_) { /* AI returned plain text -- use as body, keep existing subject */ }
          textarea.value = polishedBody;
          _autoGrowTextarea(textarea);
          if (polishedSubject) subjectEl.value = polishedSubject;
          await _doSend();
        } else { throw new Error('empty'); }
      } catch (e) {
        polishBtn.disabled = false; sendBtn.disabled = false;
        polishBtn.textContent = origLabel;
        statusEl.textContent = '\u26a0\ufe0f Could not polish - your original is still sendable';
        statusEl.className = 'oc-reply-status oc-qc-status oc-reply-status--warn';
      }
    });
  }
}

// ── Quick-compose bubble (2026-07-24) ────────────────────────────────────────
// Opened from:
//   a) Contact Book "💬 Message" button (bus 'slack:quick-compose')
//   b) Chat input intercept: "message/msg/dm [name] [optional body]"
// If the contact has no channelId (added manually, never DM'd us), warns the
// user — channelId is only known once they've messaged us first.
function _openQuickCompose(contact, prefill) {
  if (!contact) return;
  const existing = document.getElementById('oc-quick-compose');
  if (existing) existing.remove();

  // Ensure panel is open and on the Chat tab
  if (!_panelOpen) _togglePanel();
  if (_activeTab !== 'chat') _switchTab('chat');

  const tabChat = document.getElementById('oc-tab-chat');
  if (!tabChat) return;

  const bubble = document.createElement('div');
  bubble.id = 'oc-quick-compose';
  bubble.className = 'oc-quick-compose';
  bubble.innerHTML =
    '<div class="oc-qc-header">' +
      '<span>💬 <strong>' + _esc(contact.name) + '</strong></span>' +
      '<button class="oc-qc-cancel" title="Cancel">×</button>' +
    '</div>' +
    '<textarea class="oc-reply-textarea oc-qc-textarea" placeholder="Type your message… (Ctrl+Enter to send)" rows="4">' +
      _esc(prefill || '') +
    '</textarea>' +
    '<div class="oc-qc-footer">' +
      '<span class="oc-reply-status oc-qc-status"></span>' +
      '<button class="oc-qc-polish oc-reply-btn oc-reply-btn--ai">✨ Polish</button>' +
      '<button class="oc-qc-send oc-send">Send ➤</button>' +
    '</div>';

  const inputRow = tabChat.querySelector('.oc-input-row');
  tabChat.insertBefore(bubble, inputRow || null);

  const textarea  = bubble.querySelector('.oc-qc-textarea');
  const sendBtn   = bubble.querySelector('.oc-qc-send');
  const polishBtn = bubble.querySelector('.oc-qc-polish');
  const cancelBtn = bubble.querySelector('.oc-qc-cancel');
  const statusEl  = bubble.querySelector('.oc-qc-status');

  textarea.addEventListener('input', () => _autoGrowTextarea(textarea));
  if (prefill) {
    setTimeout(() => {
      _autoGrowTextarea(textarea);
      textarea.setSelectionRange(prefill.length, prefill.length);
    }, 0);
  }
  textarea.focus();

  // Extract send logic so the polish handler can await it directly.
  // sendBtn.click() is not awaitable -- that is why polish appeared to not send.
  async function _doSendMsg() {
    const msg = textarea.value.trim();
    if (!msg) { textarea.focus(); return; }
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    statusEl.textContent = '';
    try {
      if (contact.channelId) {
        // Fast path: DM channel already known (person has messaged us before)
        await slack.sendToChannel({ channelId: contact.channelId, message: msg });
      } else {
        // Slow path: no cached channel ID — resolve via email or name.
        // slack.send() handles lookupByEmail -> conversations.open -> postMessage.
        const recipient = contact.email || contact.name;
        if (!recipient) throw new Error('Contact has no email or name to look up in Slack');
        statusEl.textContent = 'Looking up Slack user…';
        await slack.send({ recipient, message: msg });
      }
      statusEl.textContent = '✓ Sent';
      statusEl.className = 'oc-reply-status oc-qc-status oc-reply-status--ok';
      setTimeout(() => bubble.remove(), 1400);
    } catch (e) {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send \u27a4';
      statusEl.textContent = '\u274c ' + e.message;
      statusEl.className = 'oc-reply-status oc-qc-status oc-reply-status--err';
    }
  }

  sendBtn.addEventListener('click', _doSendMsg);

  // Polish: AI improves wording only - never adds facts/names/dates not already in the text.
  // If the AI call fails, the draft is left untouched and fully sendable as-is.
  if (polishBtn) {
    polishBtn.addEventListener('click', async () => {
      const draft = textarea.value.trim();
      if (!draft) { textarea.focus(); return; }
      polishBtn.disabled = true; sendBtn.disabled = true;
      const origLabel = polishBtn.textContent;
      polishBtn.textContent = 'Polishing\u2026';
      statusEl.textContent = '';
      try {
        const prompt = 'Improve this Slack message for clarity and professionalism. Keep the ' +
          'exact same meaning and intent - do not add new facts, names, dates, dollar amounts, ' +
          'or commitments not already in the original. No markdown, no greeting or signature - ' +
          'just the message body as plain text, ready to send:\n\n' + draft;
        const result = await ai.chat(prompt);
        if (result && result.text) {
          textarea.value = result.text.trim();
          _autoGrowTextarea(textarea);
          // await so finally does not reset button state mid-send
          await _doSendMsg();
        } else { throw new Error('empty'); }
      } catch (e) {
        polishBtn.disabled = false; sendBtn.disabled = false;
        polishBtn.textContent = origLabel;
        statusEl.textContent = '\u26a0\ufe0f Could not polish - your original is still sendable';
        statusEl.className = 'oc-reply-status oc-qc-status oc-reply-status--warn';
      }
    });
  }

  cancelBtn.addEventListener('click', () => bubble.remove());
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') bubble.remove();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendBtn.click();
  });
}

function _showContactPicker(matches, body) {
  const existing = document.getElementById('oc-quick-compose');
  if (existing) existing.remove();

  if (!_panelOpen) _togglePanel();
  if (_activeTab !== 'chat') _switchTab('chat');

  const tabChat = document.getElementById('oc-tab-chat');
  if (!tabChat) return;

  const bubble = document.createElement('div');
  bubble.id = 'oc-quick-compose';
  bubble.className = 'oc-quick-compose';
  bubble.innerHTML =
    '<div class="oc-qc-header">' +
      '<span>Multiple matches — pick one:</span>' +
      '<button class="oc-qc-cancel">×</button>' +
    '</div>' +
    '<div class="oc-qc-picker">' +
      matches.map(c => '<button class="oc-qc-pick-btn" data-id="' + c.id + '">' + _esc(c.name) + '</button>').join('') +
    '</div>';

  const inputRow = tabChat.querySelector('.oc-input-row');
  tabChat.insertBefore(bubble, inputRow || null);

  bubble.querySelector('.oc-qc-cancel').addEventListener('click', () => bubble.remove());
  bubble.querySelectorAll('.oc-qc-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const contact = matches.find(c => c.id === btn.dataset.id);
      if (contact) { bubble.remove(); _openQuickCompose(contact, body); }
    });
  });
}

async function _send() {
  const inp = document.getElementById('orcha-input');
  const val = (inp.value || '').trim();
  if (!val) return;

  // ── Direct data-send interceptor ────────────────────────────────────────────
  // Catches "send/email/message [name] [update/data/notes] for [site]" BEFORE
  // reaching Claude. Shows a one-tap disambiguation — "Send my data" vs "Ask for data"
  // — so intent is never guessed. Claude never touches these requests.
  const _isSendData = /\b(send|message|email|dm|slack)\b/i.test(val) &&
    /\b(update|data|report|notes|status|info|detail|include)/i.test(val);
  if (_isSendData && window.contacts && window.ai && window.ai.buildReport) {
    try {
      const allC    = await window.contacts.getAll();
      const _valLow = val.toLowerCase();
      const _nonDomC = allC.filter(c => c.type !== 'domicile');
      // Match contact by ANY word in their name or email prefix (handles "zila" → "zilasant@...").
      const _match  = _nonDomC.find(c => c.name && (
        c.name.toLowerCase().split(/\s+/).some(w => w.length > 2 && _valLow.includes(w)) ||
        (c.email && _valLow.includes(c.email.split('@')[0].toLowerCase()))
      )) || null;

      // Renders the actual "send my data" vs "ask them for data" prompt for a
      // resolved contact. Shared by both the direct-match path and the
      // pick-a-contact path below so neither one re-guesses intent.
      const _renderDisambig = (target) => {
        inp.value = ''; inp.style.height = 'auto';
        const isEmail = /\bemail\b/i.test(val) ||
          (!target.slackId && !target.channelId && !!target.email);

        const existingDis = document.getElementById('oc-disambig');
        if (existingDis) existingDis.remove();
        const disambig = document.createElement('div');
        disambig.id = 'oc-disambig';
        disambig.className = 'oc-quick-compose';
        disambig.innerHTML =
          '<div style="font-size:12px;color:var(--txt2)">Are you <strong>sending data TO ' + _esc(target.name) + '</strong>, or <strong>asking THEM for data</strong>?</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="oc-reply-btn oc-reply-btn--ai oc-dis-send">📤 Send my fleet data</button>' +
            '<button class="oc-reply-btn oc-dis-ask">❓ Ask them for data</button>' +
            '<button class="oc-qc-cancel oc-dis-cancel">✕</button>' +
          '</div>';
        const tabChatEl  = document.getElementById('oc-tab-chat');
        const inputRowEl  = tabChatEl && tabChatEl.querySelector('.oc-input-row');
        if (tabChatEl) tabChatEl.insertBefore(disambig, inputRowEl || null);

        disambig.querySelector('.oc-dis-cancel').addEventListener('click', () => disambig.remove());

        // ── Ask path: let AI generate a question as normal
        disambig.querySelector('.oc-dis-ask').addEventListener('click', async () => {
          disambig.remove();
          const st = document.getElementById('orcha-status');
          if (st) st.textContent = '\u25CF Thinking...';
          try {
            const r2 = await window.ai.orchaAction(val);
            _appendMsg('oc-msg--orcha', (r2 && r2.text) || 'Done');
            _addHistory('assistant', (r2 && r2.text) || '');
          } catch(e2) { _appendMsg('oc-msg--orcha', '\u274c ' + e2.message); }
          if (st) st.textContent = '\u25CF Ready';
        });

        // ── Send path: build real fleet report, skip AI entirely
        disambig.querySelector('.oc-dis-send').addEventListener('click', async () => {
          disambig.remove();
          const st = document.getElementById('orcha-status');
          if (st) st.textContent = '\u25CF Building report...';
          try {
            const rr = await window.ai.buildReport({ query: val });
            if (st) st.textContent = '\u25CF Ready';
            if (rr && rr.ok) {
              const subject = 'Fleet Report \u2014 ' + rr.label + ' \u2014 ' +
                new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
              if (isEmail) {
                _openEmailCompose(target, rr.report, subject);
              } else {
                _openQuickCompose(target, rr.report);
              }
              _appendMsg('oc-msg--orcha', '\u2705 ' + rr.label + ' report ready for ' + _esc(target.name) + ' — review and click Send ➤');
            } else {
              _appendMsg('oc-msg--orcha', '\u26a0\ufe0f ' + (rr && rr.error || 'Could not build report — sync fleet data first.'));
            }
          } catch(e3) {
            if (st) st.textContent = '\u25CF Ready';
            _appendMsg('oc-msg--orcha', '\u274c ' + e3.message);
          }
        });
      };

      if (_match) {
        _appendMsg('oc-msg--user', val);
        _addHistory('user', val);
        _renderDisambig(_match);
        return;
      }

      // No name/email mentioned in the message. Rather than silently doing
      // nothing (the original bug — "send all data for avp40" matched no one
      // and fell through to Claude unnoticed), ask which saved contact this
      // is about. Skipped only when there's genuinely nobody to pick from.
      if (_nonDomC.length >= 1) {
        inp.value = ''; inp.style.height = 'auto';
        _appendMsg('oc-msg--user', val);
        _addHistory('user', val);

        const existingDis = document.getElementById('oc-disambig');
        if (existingDis) existingDis.remove();
        const picker = document.createElement('div');
        picker.id = 'oc-disambig';
        picker.className = 'oc-quick-compose';
        picker.innerHTML =
          '<div style="font-size:12px;color:var(--txt2)">Who is this about?</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            _nonDomC.map((c, i) =>
              '<button class="oc-reply-btn oc-pick-contact" data-idx="' + i + '">' + _esc(c.name) + '</button>'
            ).join('') +
            '<button class="oc-qc-cancel oc-dis-cancel">✕</button>' +
          '</div>';
        const tabChatEl  = document.getElementById('oc-tab-chat');
        const inputRowEl  = tabChatEl && tabChatEl.querySelector('.oc-input-row');
        if (tabChatEl) tabChatEl.insertBefore(picker, inputRowEl || null);

        picker.querySelector('.oc-dis-cancel').addEventListener('click', () => picker.remove());
        picker.querySelectorAll('.oc-pick-contact').forEach(btn => {
          btn.addEventListener('click', () => {
            picker.remove();
            _renderDisambig(_nonDomC[Number(btn.dataset.idx)]);
          });
        });
        return;
      }
    } catch (_sendErr) { /* fall through to AI */ }
  }

  // ── Email intercept: "email/mail [name] [optional body]" ────────────────────
  const _emailMatch = val.match(/^(?:email|mail|send\s+email\s+to)\s+(.+)/i);
  if (_emailMatch && window.contacts) {
    const rest = _emailMatch[1].trim();
    const words = rest.split(/\s+/);
    try {
      const allContacts = await window.contacts.getAll();
      const emailCandidates = allContacts.filter(c => c.email);
      let matches = [], body = '';
      for (let n = Math.min(words.length, 3); n >= 1; n--) {
        const q = words.slice(0, n).join(' ').toLowerCase();
        const found = emailCandidates.filter(c => c.name.toLowerCase().includes(q));
        if (found.length) { matches = found; body = words.slice(n).join(' '); break; }
      }
      if (matches.length === 1) { inp.value = ''; inp.style.height = 'auto'; _openEmailCompose(matches[0], body); return; }
      if (matches.length > 1)  { inp.value = ''; inp.style.height = 'auto'; _showEmailPicker(matches, body); return; }
      // 0 matches
      const _eNameGuess = words.slice(0, Math.min(words.length, 2)).join(' ');
      inp.value = ''; inp.style.height = 'auto';
      _appendMsg('oc-msg--user', val);
      _appendMsg('oc-msg--orcha',
        '📧 No contact with an email address named “' + _eNameGuess + '” found.\n\n' +
        'Add their email in Contact Book (📇 toolbar), then try again.');
      return;
    } catch (_) { /* fall through */ }
  }

  // ── Quick-message intercept: "message/msg/dm [name] [optional body]" ────────
  // Tries to match the name against contacts with type:'slack'.
  // 1 match → open compose bubble immediately.
  // 2+ matches → show disambiguation picker.
  // 0 matches → fall through to AI (it can still handle it naturally).
  const _msgMatch = val.match(/^(?:message|msg|dm)\s+(.+)/i);
  if (_msgMatch && window.contacts) {
    const rest = _msgMatch[1].trim();
    const words = rest.split(/\s+/);
    try {
      const allContacts = await window.contacts.getAll();
      const slackContacts = allContacts.filter(c => c.type === 'slack');
      let matches = [], body = '';
      for (let n = Math.min(words.length, 3); n >= 1; n--) {
        const q = words.slice(0, n).join(' ').toLowerCase();
        const found = slackContacts.filter(c => c.name.toLowerCase().includes(q));
        if (found.length) { matches = found; body = words.slice(n).join(' '); break; }
      }
      if (matches.length === 1) { inp.value = ''; inp.style.height = 'auto'; _openQuickCompose(matches[0], body); return; }
      if (matches.length > 1)  { inp.value = ''; inp.style.height = 'auto'; _showContactPicker(matches, body); return; }
      // 0 matches — tell the user instead of silently handing it to AI
      const _nameGuess = words.slice(0, Math.min(words.length, 2)).join(' ');
      inp.value = '';
      _appendMsg('oc-msg--user', val);
      _appendMsg('oc-msg--orcha',
        '💬 No Slack contact named “' + _nameGuess + '” found.\n\n' +
        'To message them: open the Contact Book (📇 toolbar), add them via the + Add Slack Contact form, ' +
        'then try again.\n\nIf you just restarted the app, DM contacts auto-save on the next poll cycle (30s).');
      return;
    } catch (_) { /* fall through to AI if contact lookup errors */ }
  }


  inp.value = ''; inp.style.height = 'auto';
  _appendMsg('oc-msg--user', val);
  _addHistory('user', val);

  const status = document.getElementById('orcha-status');
  if (status) status.textContent = '\u{25CF} Thinking...';

  try {
    // Route everything through smart AI action handler
    const result = await window.ai.orchaAction(val);
    const text = (result && result.text) || '';

    // Show the AI's reply text if there is one
    if (text) { _appendMsg('oc-msg--orcha', text); _addHistory('assistant', text); }

    // If the AI identified a SLACK or EMAIL send, show a confirm prompt.
    // Nothing is ever sent automatically — regardless of phrasing, every
    // ai:orcha-action SLACK/EMAIL result lands here and waits for a click.
    const pending = result && result.pendingConfirm;
    if (pending && pending.length > 0) {
      for (const item of pending) {
        const existingDis = document.getElementById('oc-disambig');
        if (existingDis) existingDis.remove();
        const confirmEl = document.createElement('div');
        confirmEl.id = 'oc-disambig';
        confirmEl.className = 'oc-quick-compose';
        const icon = item.channel === 'slack' ? '\uD83D\uDCAC' : '\uD83D\uDCE7';
        const verb = item.channel === 'slack' ? 'Slack' : 'Email';
        const dataNote = item.isRealData ? ' <span style="font-size:10px;color:#3fb950">(real fleet report)</span>' : '';
        confirmEl.innerHTML =
          '<div style="font-size:12px;color:var(--txt2)">Ready to ' + verb + ' <strong>' + _esc(item.recipientName) + '</strong>' + dataNote + '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="oc-reply-btn oc-reply-btn--ai oc-confirm-send">' + icon + '\u00A0Send</button>' +
            '<button class="oc-qc-cancel oc-confirm-cancel">\u2715 Cancel</button>' +
          '</div>';
        const tabChatEl = document.getElementById('oc-tab-chat');
        const inputRowEl = tabChatEl && tabChatEl.querySelector('.oc-input-row');
        if (tabChatEl) tabChatEl.insertBefore(confirmEl, inputRowEl || null);
        confirmEl.querySelector('.oc-confirm-cancel').addEventListener('click', () => confirmEl.remove());
        confirmEl.querySelector('.oc-confirm-send').addEventListener('click', async () => {
          confirmEl.remove();
          const st = document.getElementById('orcha-status');
          if (st) st.textContent = '\u25CF Sending...';
          try {
            const r3 = await window.ai.confirmSend(item);
            if (r3 && r3.ok) {
              _appendMsg('oc-msg--orcha', '\u2705 ' + (r3.message || 'Sent to ' + item.recipientName));
            } else {
              _appendMsg('oc-msg--orcha', '\u26a0\ufe0f ' + (r3 && r3.error || 'Send failed'));
            }
          } catch(e2) { _appendMsg('oc-msg--orcha', '\u274c ' + e2.message); }
          if (st) st.textContent = '\u25CF Ready';
        });
      }
    } else if (!text) {
      _appendMsg('oc-msg--orcha', 'Done');
    }
  } catch(e) {
    _appendMsg('oc-msg--orcha', '\u274c ' + e.message);
  }
  if (status) status.textContent = '\u25CF Ready';
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
        <textarea class="oc-input oc-chat-input" id="orcha-input" placeholder="Ask, command, or vent... (Shift+Enter for newline)" autocomplete="off" spellcheck="false" rows="1"></textarea>
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
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _hideAutocomplete(); _send(); }
    if (e.key === 'Escape') _hideAutocomplete();
  });
  // Auto-grow the chat textarea as the user types
  document.getElementById('orcha-input').addEventListener('input', (e) => {
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  });

  document.getElementById('orcha-input').addEventListener('input', _handleInputForMentions);
  document.getElementById('orcha-input').addEventListener('blur', () => setTimeout(_hideAutocomplete, 200));
  _loadContacts();
  _wireSlackTab();

  // Shift panel when right drawer opens/closes
  // Open compose bubble when Contact Book emits 'slack:quick-compose'
  bus.on('slack:quick-compose', (contact) => _openQuickCompose(contact));
  bus.on('contacts:quick-email', (contact) => _openEmailCompose(contact));

  // AI action EMAIL fallback: main process fires this when SMTP is unavailable.
  // Opens the compose bubble pre-filled with the real fleet report + subject.
  bus.on('email:compose', async (data) => {
    if (!data || !data.to) return;
    // Find contact by email; create a synthetic one if not in book
    let contact = null;
    try {
      const all = await window.contacts.getAll();
      contact = all.find(c => c.email && c.email.toLowerCase() === data.to.toLowerCase());
    } catch (_) {}
    if (!contact) contact = { name: data.to, email: data.to };
    _openEmailCompose(contact, data.body || '', data.subject || '');
  });

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
  // NOTE (2026-07-22): confirmed via full-codebase search that nothing in
  // the backend actually ever sends the 'slack:incoming' IPC event this
  // listens for -- this handler is currently unreachable/dead code (the
  // real, working Slack DM path is the readDMs() poller above). Wired to
  // _appendSlackDM() anyway for forward-compatibility (if this is ever
  // hooked up to a real push source), with a defensive channelId lookup
  // since this payload's exact shape has never been verified live --
  // _appendSlackDM() already fails safe and simply omits the Reply button
  // if channelId ends up missing, rather than erroring.
  if (window.slack && window.slack.onIncoming) {
    window.slack.onIncoming((msg) => {
      _appendSlackDM({
        text: msg.text || msg.message || '',
        user: msg.user || msg.channel || 'Slack',
        channelId: msg.channelId || msg.channel || null,
      });
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
    _startDMAutoReplyPoll();
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
