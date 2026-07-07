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

let _panelOpen = false;
let _slackAuthed = false;
let _pollTimer = null;
let _lastDmTs = null;
let _initialized = false;
let _pendingActions = null;
let _contacts = []; // { id, name, type: 'user'|'channel' }
let _acEl = null;   // autocomplete dropdown element

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
    const auth = await slack.checkAuth();
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

// ── Timeline writing ────────────────────────────────────────────────────────
async function _addToTimeline(unitId, entry) {
  const today = new Date();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  
  const prompt = `Rewrite as a single fleet timeline entry. Format: "${mm}/${dd} - What happened." Professional fleet maintenance voice. No names, no costs. Max 1-2 sentences. Just output the line:\n\n${entry}`;
  const aiResult = await ai.chat(prompt);
  const professional = (aiResult && aiResult.text) || `${mm}/${dd} - ${entry}`;
  
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
    <div class="oc-msgs" id="orcha-msgs">
      <div class="oc-msg oc-msg--orcha">Hey \u{1F44B} I'm Orcha — your fleet brain. Click me anytime.<br><br>I know every unit, every timeline, every vendor. Ask me anything, tell me to do something, or just vent about Kenworth's ETA.</div>
    </div>
    <div class="oc-input-row">
      <input class="oc-input" id="orcha-input" placeholder="Ask, command, or vent..." autocomplete="off" spellcheck="false"/>
      <button class="oc-send" id="orcha-send">\u{27A4}</button>
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
