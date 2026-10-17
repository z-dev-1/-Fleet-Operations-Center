/**
 * email-triage-overlay.js — OWA Inbox Triage overlay.
 *
 * A full-screen overlay that lists the AI-triaged inbox: per-email summary,
 * importance, attachments, matched fleet-unit updates (and a confirm-gated
 * "notify operator unit ready" action), plus a persistent per-email Reply
 * option (AI-drafts, you edit, confirm to send). Opened from the toolbar
 * (📨 icon → bus 'ui:email-triage-toggle'). Reads/acts entirely through
 * window.emailTriage (preload bridge). All mailbox/DM mutations are explicit.
 */

import bus from '../bus.js';

let _open = false;
let _results = { emails: [] };
let _running = false;
let _config = {};
let _cfgOpen = false;

export function init() {
  bus.on('ui:email-triage-toggle', () => { if (_open) _close(); else _open_(); });

  // Live refresh when the main process pushes updated triage results.
  if (window.emailTriage && window.emailTriage.onUpdated) {
    window.emailTriage.onUpdated((results) => {
      if (results) _results = results;
      if (_open) _render();
    });
  }
}

async function _open_() {
  _open = true;
  _injectStyle();
  const overlay = document.createElement('div');
  overlay.id = 'email-triage';
  overlay.innerHTML = `
    <div class="et-backdrop"></div>
    <div class="et-panel">
      <div class="et-head">
        <div class="et-title">📨 Inbox Triage</div>
        <div class="et-actions">
          <button class="et-btn et-run" id="et-run">Scan inbox</button>
          <button class="et-btn et-diag" id="et-diag" title="Diagnose what the reader sees in Outlook">🩺</button>
          <button class="et-x" id="et-close" title="Close">✕</button>
        </div>
      </div>
      <div class="et-meta" id="et-meta"></div>
      <div class="et-config" id="et-config"></div>
      <div class="et-body" id="et-body"><div class="et-empty">Loading…</div></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('.et-backdrop').addEventListener('click', _close);
  document.getElementById('et-close').addEventListener('click', _close);
  document.getElementById('et-run').addEventListener('click', _run);
  const diagBtn = document.getElementById('et-diag');
  if (diagBtn) diagBtn.addEventListener('click', _diagnose);
  document.getElementById('et-cfg-toggle') && null;

  // Load config for the settings strip.
  try {
    if (window.emailTriage && window.emailTriage.getConfig) {
      _config = await window.emailTriage.getConfig() || {};
    }
  } catch (_) {}
  _renderConfig();

  // Load whatever we have cached, then render.
  try {
    if (window.emailTriage && window.emailTriage.getResults) {
      _results = await window.emailTriage.getResults() || { emails: [] };
    }
  } catch (_) {}
  _render();
}

function _close() {
  _open = false;
  const el = document.getElementById('email-triage');
  if (el) el.remove();
}

async function _run() {
  if (_running) return;
  _running = true;
  const btn = document.getElementById('et-run');
  if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }
  _setMeta('Reading your inbox and triaging with AI — this can take a minute.');
  try {
    const res = await window.emailTriage.run({});
    if (res) _results = res;
  } catch (e) {
    _setMeta('Scan failed: ' + (e.message || e));
  }
  _running = false;
  if (btn) { btn.disabled = false; btn.textContent = 'Scan inbox'; }
  _render();
}

function _setMeta(text) {
  const m = document.getElementById('et-meta');
  if (m) m.textContent = text;
}

// Diagnostic: run the DOM probe against the live Outlook mailbox and dump what
// the reader actually sees, so the selectors can be fixed from real data.
async function _diagnose() {
  const body = document.getElementById('et-body');
  _setMeta('Diagnosing — opening Outlook and inspecting the inbox DOM…');
  if (body) body.innerHTML = '<div class="et-empty">Running diagnostic… (opens Outlook in the background)</div>';
  try {
    const r = await window.emailTriage.probe();
    const pretty = JSON.stringify(r, null, 2);
    if (body) {
      body.innerHTML = '<div class="et-reply-label">🩺 Diagnostic — what the reader sees in Outlook:</div>' +
        '<textarea class="et-draft" style="min-height:320px" readonly>' + _esc(pretty) + '</textarea>' +
        '<div class="et-why">Copy this and share it so the email selectors can be matched to your Outlook. If authBlocked is true, open Outlook on the web once and sign in, then try again.</div>';
    }
    _setMeta('Diagnostic complete.');
  } catch (e) {
    if (body) body.innerHTML = '<div class="et-empty">Diagnostic failed: ' + _esc(e.message || String(e)) + '</div>';
  }
}

function _renderConfig() {
  const box = document.getElementById('et-config');
  if (!box) return;
  const c = _config || {};
  const folders = Array.isArray(c.folders) ? c.folders.join(', ') : 'Inbox';
  if (!_cfgOpen) {
    box.innerHTML = '<button class="et-cfg-link" id="et-cfg-open">⚙ Folders & auto-scan</button>' +
      '<span class="et-cfg-summary">Scanning: ' + _esc(folders) + (c.autoScan ? ' · auto every ' + (c.autoScanMinutes || 60) + 'm' : ' · auto-scan off') + '</span>';
    const open = document.getElementById('et-cfg-open');
    if (open) open.addEventListener('click', () => { _cfgOpen = true; _renderConfig(); });
    return;
  }
  box.innerHTML =
    '<div class="et-cfg-row"><label>Folders to scan (comma-separated, by their Outlook name):</label>' +
    '<input id="et-cfg-folders" type="text" value="' + _esc(folders) + '" placeholder="Inbox, Relay Garage, AVP40, SAPB ABE40" /></div>' +
    '<div class="et-cfg-row et-cfg-inline">' +
      '<label><input id="et-cfg-autoscan" type="checkbox" ' + (c.autoScan ? 'checked' : '') + '/> Auto-scan every</label>' +
      '<input id="et-cfg-mins" type="number" min="15" max="1440" value="' + (c.autoScanMinutes || 60) + '" /> min' +
      '<label style="margin-left:12px"><input id="et-cfg-enabled" type="checkbox" ' + (c.enabled ? 'checked' : '') + '/> Feature enabled</label>' +
    '</div>' +
    '<div class="et-cfg-row et-cfg-inline">' +
      '<label><input id="et-cfg-apply" type="checkbox" ' + (c.autoApplyUnitUpdates !== false ? 'checked' : '') + '/> Auto-add unit updates to timeline</label>' +
    '</div>' +
    '<div class="et-cfg-btns"><button class="et-mini et-cfg-save" id="et-cfg-save">Save</button>' +
    '<button class="et-mini" id="et-cfg-cancel">Close</button></div>';

  document.getElementById('et-cfg-cancel').addEventListener('click', () => { _cfgOpen = false; _renderConfig(); });
  document.getElementById('et-cfg-save').addEventListener('click', async () => {
    const foldersRaw = (document.getElementById('et-cfg-folders').value || '').split(',').map((s) => s.trim()).filter(Boolean);
    const patch = {
      folders: foldersRaw.length ? foldersRaw : ['Inbox'],
      autoScan: document.getElementById('et-cfg-autoscan').checked,
      autoScanMinutes: parseInt(document.getElementById('et-cfg-mins').value, 10) || 60,
      enabled: document.getElementById('et-cfg-enabled').checked,
      autoApplyUnitUpdates: document.getElementById('et-cfg-apply').checked,
    };
    try {
      _config = await window.emailTriage.setConfig(patch) || _config;
      _cfgOpen = false;
      _renderConfig();
      _toast('Settings saved.');
    } catch (e) { _toast('Save failed: ' + (e.message || e)); }
  });
}

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _render() {
  const body = document.getElementById('et-body');
  if (!body) return;
  const emails = (_results && Array.isArray(_results.emails)) ? _results.emails : [];

  if (_results && _results.authBlocked) {
    _setMeta('Outlook needs a sign-in. Open Outlook on the web once, then click Scan inbox again.');
  } else if (_results && _results.ranAt) {
    const n = emails.length;
    const hi = emails.filter((e) => e.importance === 'high').length;
    const units = emails.filter((e) => (e.unitRefs || []).length).length;
    _setMeta(n + ' email' + (n === 1 ? '' : 's') + ' · ' + hi + ' important · ' + units + ' with unit updates · scanned ' + _timeAgo(_results.ranAt));
  } else {
    _setMeta('No scan yet — click Scan inbox to read and triage your latest emails.');
  }

  if (!emails.length) {
    body.innerHTML = '<div class="et-empty">Nothing triaged yet. Click <b>Scan inbox</b>.</div>';
    return;
  }

  // Sort: high importance first, then by triaged time (newest first).
  const rank = { high: 0, normal: 1, low: 2 };
  const sorted = emails.slice().sort((a, b) => {
    const r = (rank[a.importance] ?? 1) - (rank[b.importance] ?? 1);
    if (r !== 0) return r;
    return String(b.triagedAt || '').localeCompare(String(a.triagedAt || ''));
  });

  // Banner: how many are suggested for deletion (and a one-click bulk delete).
  const suggested = emails.filter((e) => e.deleteSuggested && !e.kept && !e.deleted);
  const banner = suggested.length
    ? '<div class="et-sugbanner">🗑 ' + suggested.length + ' email' + (suggested.length === 1 ? '' : 's') +
      ' look like junk / not relevant. <button class="et-mini et-delall" id="et-delall">Review & delete all</button></div>'
    : '';

  body.innerHTML = banner + sorted.map(_cardHtml).join('');
  // Wire per-card buttons.
  sorted.forEach((em) => _wireCard(em.id));
  const delAll = document.getElementById('et-delall');
  if (delAll) delAll.addEventListener('click', _deleteAllSuggested);
}

function _cardHtml(em) {
  const imp = em.importance || 'normal';
  const atts = (em.attachments || []).map((a) =>
    '<span class="et-chip et-chip--' + (a.type || 'file') + '">' + (a.type === 'image' ? '🖼' : a.type === 'document' ? '📄' : '📎') + ' ' + _esc(a.name) + '</span>'
  ).join('');
  const units = (em.unitRefs || []).map((u) => {
    const readyBtn = u.ready
      ? '<button class="et-mini et-ready" data-ready="' + _esc(u.unit) + '"' + (u.readyDmSent ? ' disabled' : '') + '>' + (u.readyDmSent ? 'Operator notified ✓' : '🔔 Notify operator — ready') + '</button>'
      : '';
    return '<div class="et-unit">🚚 <b>' + _esc(u.unit) + '</b>' + (u.operator ? ' · ' + _esc(u.operator) : '') +
      (u.update ? '<div class="et-unit-upd">' + _esc(u.update) + (em.unitUpdateApplied ? ' <span class="et-applied">added to timeline ✓</span>' : '') + '</div>' : '') +
      readyBtn + '</div>';
  }).join('');

  return '' +
    '<div class="et-card et-card--' + imp + '" data-id="' + _esc(em.id) + '">' +
      '<div class="et-card-top">' +
        '<span class="et-imp et-imp--' + imp + '">' + imp.toUpperCase() + '</span>' +
        '<span class="et-from">' + _esc(em.fromName || em.from) + '</span>' +
        (em.folder ? '<span class="et-folder">📁 ' + _esc(em.folder) + '</span>' : '') +
        (em.receivedText ? '<span class="et-time">' + _esc(em.receivedText) + '</span>' : '') +
      '</div>' +
      '<div class="et-subj">' + _esc(em.subject) + '</div>' +
      (em.summary ? '<div class="et-summary">' + _esc(em.summary) + '</div>' : '') +
      (em.importanceWhy ? '<div class="et-why">Why: ' + _esc(em.importanceWhy) + '</div>' : '') +
      (atts ? '<div class="et-atts">' + atts + '</div>' : '') +
      (units ? '<div class="et-units">' + units + '</div>' : '') +
      '<div class="et-footer">' +
        (em.deleteSuggested && !em.deleted ? '<span class="et-del">🗑 Suggested delete (noise)</span>' : '') +
        '<div class="et-footer-actions">' + _deleteButtonsHtml(em) + _replyButtonHtml(em) + '</div>' +
      '</div>' +
      _replyPanelHtml(em) +
    '</div>';
}

// Delete + Keep controls. Delete is always available (reversible — moves to
// Deleted Items). Keep only shows when the AI suggested deleting (so the user
// can teach it "not junk").
function _deleteButtonsHtml(em) {
  if (em.deleted) return '<span class="et-sent">🗑 Deleted</span>';
  let html = '<button class="et-mini et-delete" data-delete="' + _esc(em.id) + '" title="Move to Deleted Items (recoverable)">🗑 Delete</button>';
  if (em.deleteSuggested && !em.kept) {
    html += '<button class="et-mini et-keep" data-keep="' + _esc(em.id) + '" title="Not junk — keep it and teach the AI">Keep</button>';
  }
  return html;
}

// The compact Reply button that lives in the footer (right side).
function _replyButtonHtml(em) {
  const state = em.replyState || 'none';
  if (state === 'sent') return '<span class="et-sent">✉️ Reply sent</span>';
  if (state === 'drafted') return '<span class="et-draft-flag">✍️ Draft ready below ↓</span>';
  if (state === 'dismissed') return '<button class="et-mini et-reply-start" data-reply="' + _esc(em.id) + '">↩︎ Reply anyway</button>';
  const hint = em.replySuggested ? '↩︎ Draft reply' : '↩︎ Reply';
  return '<button class="et-mini et-reply-start" data-reply="' + _esc(em.id) + '">' + hint + '</button>';
}

// The FULL-WIDTH draft editor, rendered BELOW the email body (only when a draft
// exists), so it is unmistakable and roomy — not jammed into the footer corner.
function _replyPanelHtml(em) {
  if ((em.replyState || 'none') !== 'drafted') return '';
  return '<div class="et-reply-panel">' +
    '<div class="et-reply-label">✍️ Your reply draft — edit, then Send:</div>' +
    '<textarea class="et-draft" data-draft="' + _esc(em.id) + '">' + _esc(em.replyDraft || '') + '</textarea>' +
    '<div class="et-draft-btns">' +
      '<button class="et-mini et-send" data-send="' + _esc(em.id) + '">📤 Send reply</button>' +
      '<button class="et-mini et-redraft" data-redraft="' + _esc(em.id) + '">↻ Re-draft</button>' +
      '<button class="et-mini et-dismiss" data-dismiss="' + _esc(em.id) + '">Dismiss</button>' +
    '</div></div>';
}

function _wireCard(id) {
  const card = document.querySelector('.et-card[data-id="' + CSS.escape(id) + '"]');
  if (!card) return;

  const startBtn = card.querySelector('[data-reply]');
  if (startBtn) startBtn.addEventListener('click', () => _draftReply(id));

  const redraft = card.querySelector('[data-redraft]');
  if (redraft) redraft.addEventListener('click', () => _draftReply(id));

  const sendBtn = card.querySelector('[data-send]');
  if (sendBtn) sendBtn.addEventListener('click', () => _sendReply(id));

  const dismissBtn = card.querySelector('[data-dismiss]');
  if (dismissBtn) dismissBtn.addEventListener('click', () => _dismissReply(id));

  card.querySelectorAll('[data-ready]').forEach((b) => {
    b.addEventListener('click', () => _notifyReady(id, b.getAttribute('data-ready')));
  });

  const delBtn = card.querySelector('[data-delete]');
  if (delBtn) delBtn.addEventListener('click', () => _deleteEmail(id));

  const keepBtn = card.querySelector('[data-keep]');
  if (keepBtn) keepBtn.addEventListener('click', () => _keepEmail(id));
}

async function _deleteEmail(id) {
  const em = _results.emails.find((e) => e.id === id);
  const label = em ? (em.fromName || em.from || em.subject || 'this email') : 'this email';
  if (!confirm('Delete "' + (em ? em.subject : label) + '"?\nIt moves to Deleted Items in Outlook (recoverable).')) return;
  const card = document.querySelector('.et-card[data-id="' + CSS.escape(id) + '"]');
  const btn = card && card.querySelector('[data-delete]');
  if (btn) { btn.disabled = true; btn.textContent = '🗑 Deleting…'; }
  _toast('Deleting…');
  try {
    const r = await window.emailTriage.deleteEmail(id);
    if (r && r.ok) {
      if (em) em.deleted = true;
      _render();
      _toast('Deleted — moved to Deleted Items.');
    } else {
      if (btn) { btn.disabled = false; btn.textContent = '🗑 Delete'; }
      _toast('Delete failed: ' + ((r && r.error) || 'unknown'));
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '🗑 Delete'; }
    _toast('Delete failed: ' + (e.message || e));
  }
}

async function _keepEmail(id) {
  try {
    await window.emailTriage.keepEmail(id);
    const em = _results.emails.find((e) => e.id === id);
    if (em) { em.deleteSuggested = false; em.kept = true; }
    _render();
    _toast('Kept — the AI will stop suggesting deleting this kind.');
  } catch (e) { _toast('Keep failed: ' + (e.message || e)); }
}

async function _deleteAllSuggested() {
  const targets = (_results.emails || []).filter((e) => e.deleteSuggested && !e.kept && !e.deleted);
  if (!targets.length) { _toast('No suggested deletes to clear.'); return; }
  if (!confirm('Delete all ' + targets.length + ' suggested email(s)?\nThey move to Deleted Items in Outlook (recoverable).')) return;
  _toast('Deleting ' + targets.length + ' email(s)…');
  try {
    const r = await window.emailTriage.deleteSuggested();
    if (r && r.ok) {
      (r.outcomes || []).forEach((o) => { if (o.ok) { const em = _results.emails.find((e) => e.id === o.id); if (em) em.deleted = true; } });
      _render();
      _toast('Deleted ' + r.deleted + ' of ' + r.total + '.');
    } else {
      _toast('Bulk delete failed: ' + ((r && r.error) || 'unknown'));
    }
  } catch (e) { _toast('Bulk delete failed: ' + (e.message || e)); }
}

async function _draftReply(id) {
  // Immediate, visible feedback on the clicked card so it never looks dead.
  const card = document.querySelector('.et-card[data-id="' + CSS.escape(id) + '"]');
  const startBtn = card && (card.querySelector('[data-reply]') || card.querySelector('[data-redraft]'));
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = '✍️ Drafting…'; }
  _toast('Drafting reply… (the AI can take a few seconds)');
  try {
    const r = await window.emailTriage.draftReply(id, '');
    if (r && r.ok) {
      const em = _results.emails.find((e) => e.id === id);
      if (em) { em.replyDraft = r.draft; em.replyState = 'drafted'; }
      _render();
      // Scroll the new draft editor into view + focus it so it's unmistakable.
      try {
        const ta = document.querySelector('textarea[data-draft="' + CSS.escape(id) + '"]');
        if (ta) { ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); ta.focus(); }
      } catch (_) {}
      _toast(r.aiUnavailable ? 'AI was unavailable — opened an editable starter draft below.' : 'Draft ready — see the box below the email.');
    } else {
      if (startBtn) { startBtn.disabled = false; startBtn.textContent = '↩︎ Draft reply'; }
      _toast('Draft failed: ' + ((r && r.error) || 'unknown'));
    }
  } catch (e) {
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = '↩︎ Draft reply'; }
    _toast('Draft failed: ' + (e.message || e));
  }
}

async function _sendReply(id) {
  const ta = document.querySelector('textarea[data-draft="' + CSS.escape(id) + '"]');
  const body = ta ? ta.value : '';
  if (!body.trim()) { _toast('Reply is empty.'); return; }
  if (!confirm('Send this reply via Outlook?')) return;
  _toast('Sending reply…');
  try {
    const r = await window.emailTriage.sendReply(id, body);
    if (r && r.ok) {
      const em = _results.emails.find((e) => e.id === id);
      if (em) { em.replyState = 'sent'; em.replyDraft = body; }
      _render();
      _toast('Reply sent.');
    } else {
      _toast('Send failed: ' + ((r && r.error) || 'unknown'));
    }
  } catch (e) { _toast('Send failed: ' + (e.message || e)); }
}

async function _dismissReply(id) {
  try {
    await window.emailTriage.dismissReply(id);
    const em = _results.emails.find((e) => e.id === id);
    if (em) em.replyState = 'dismissed';
    _render();
  } catch (_) {}
}

async function _notifyReady(id, unit) {
  _toast('Drafting operator message…');
  let draft = '';
  try {
    const r = await window.emailTriage.draftReadyDm(id, unit);
    if (!r || !r.ok) { _toast('Could not draft: ' + ((r && r.error) || 'unknown')); return; }
    draft = r.draft;
  } catch (e) { _toast('Could not draft: ' + (e.message || e)); return; }

  const edited = prompt('Send this message to the operator for unit ' + unit + '?\n(edit if needed, Cancel to abort)', draft);
  if (edited === null) return;
  if (!edited.trim()) { _toast('Message empty — not sent.'); return; }
  _toast('Sending…');
  try {
    const r = await window.emailTriage.sendReadyDm(id, unit, edited);
    if (r && r.ok) { _toast(r.message || 'Operator notified.'); }
    else { _toast('Send failed: ' + ((r && r.error) || 'unknown')); }
  } catch (e) { _toast('Send failed: ' + (e.message || e)); }
}

function _toast(msg) {
  try { bus.emit('ui:toast', { type: 'info', message: msg, duration: 2500 }); } catch (_) {}
}

function _timeAgo(iso) {
  try {
    const d = new Date(iso); const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return d.toLocaleDateString();
  } catch (_) { return ''; }
}

function _injectStyle() {
  if (document.getElementById('email-triage-style')) return;
  const style = document.createElement('style');
  style.id = 'email-triage-style';
  style.textContent = `
    #email-triage { position:fixed; inset:0; z-index:99999; display:flex; align-items:center; justify-content:center; }
    #email-triage .et-backdrop { position:absolute; inset:0; background:rgba(1,4,9,0.72); backdrop-filter:blur(6px); }
    #email-triage .et-panel { position:relative; z-index:1; width:720px; max-width:94vw; max-height:86vh;
      display:flex; flex-direction:column; background:#0d1117; border:1px solid #30363d; border-radius:12px;
      box-shadow:0 24px 60px rgba(0,0,0,0.6); overflow:hidden; }
    #email-triage .et-head { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid #21262d; }
    #email-triage .et-title { font-size:16px; font-weight:600; color:#e6edf3; }
    #email-triage .et-actions { display:flex; align-items:center; gap:8px; }
    #email-triage .et-btn { background:#1f6feb; border:none; color:#fff; font-size:12px; font-weight:600; padding:7px 14px; border-radius:6px; cursor:pointer; }
    #email-triage .et-btn:disabled { opacity:.6; cursor:default; }
    #email-triage .et-diag { background:#30363d; padding:7px 10px; }
    #email-triage .et-x { background:transparent; border:none; color:#8b949e; font-size:16px; cursor:pointer; padding:4px 8px; }
    #email-triage .et-x:hover { color:#e6edf3; }
    #email-triage .et-meta { padding:8px 18px; font-size:11px; color:#8b949e; border-bottom:1px solid #161b22; }
    #email-triage .et-body { padding:12px 14px; overflow-y:auto; }
    #email-triage .et-empty { color:#8b949e; font-size:13px; text-align:center; padding:40px 0; }
    #email-triage .et-card { background:#161b22; border:1px solid #21262d; border-left:3px solid #30363d; border-radius:8px; padding:12px 14px; margin-bottom:10px; }
    #email-triage .et-card--high { border-left-color:#f85149; }
    #email-triage .et-card--normal { border-left-color:#388bfd; }
    #email-triage .et-card--low { border-left-color:#484f58; }
    #email-triage .et-card-top { display:flex; align-items:center; gap:8px; margin-bottom:4px; }
    #email-triage .et-imp { font-size:9px; font-weight:700; letter-spacing:.5px; padding:2px 6px; border-radius:4px; }
    #email-triage .et-imp--high { background:rgba(248,81,73,.15); color:#ff7b72; }
    #email-triage .et-imp--normal { background:rgba(56,139,253,.15); color:#79c0ff; }
    #email-triage .et-imp--low { background:rgba(139,148,158,.12); color:#8b949e; }
    #email-triage .et-from { font-size:12px; font-weight:600; color:#e6edf3; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #email-triage .et-time { font-size:10px; color:#6e7681; }
    #email-triage .et-subj { font-size:13px; color:#e6edf3; font-weight:500; margin-bottom:4px; }
    #email-triage .et-summary { font-size:12px; color:#c9d1d9; line-height:1.45; margin-bottom:4px; }
    #email-triage .et-why { font-size:10px; color:#8b949e; font-style:italic; margin-bottom:4px; }
    #email-triage .et-atts { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0; }
    #email-triage .et-chip { font-size:10px; color:#c9d1d9; background:#21262d; border:1px solid #30363d; border-radius:12px; padding:2px 8px; }
    #email-triage .et-units { margin:8px 0; }
    #email-triage .et-unit { font-size:12px; color:#c9d1d9; background:rgba(63,185,80,.06); border:1px solid rgba(63,185,80,.2); border-radius:6px; padding:7px 9px; margin-bottom:6px; }
    #email-triage .et-unit-upd { font-size:11px; color:#8b949e; margin:3px 0; }
    #email-triage .et-applied { color:#3fb950; font-size:10px; }
    #email-triage .et-footer { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:8px; flex-wrap:wrap; }
    #email-triage .et-footer-actions { display:flex; gap:6px; margin-left:auto; align-items:flex-start; }
    #email-triage .et-del { font-size:10px; color:#8b949e; }
    #email-triage .et-mini { font-size:11px; font-weight:600; padding:5px 10px; border-radius:5px; cursor:pointer; border:1px solid #30363d; background:#21262d; color:#c9d1d9; }
    #email-triage .et-mini:hover { background:#30363d; }
    #email-triage .et-mini:disabled { opacity:.6; cursor:default; }
    #email-triage .et-send { background:rgba(63,185,80,.12); border-color:rgba(63,185,80,.35); color:#3fb950; }
    #email-triage .et-ready { background:rgba(240,168,0,.12); border-color:rgba(240,168,0,.35); color:#f0a800; margin-top:4px; }
    #email-triage .et-sent { font-size:11px; color:#3fb950; }
    #email-triage .et-draft-flag { font-size:11px; font-weight:600; color:#d2a8ff; }
    #email-triage .et-reply-panel { margin-top:10px; padding:10px; background:#0b1b2b; border:1px solid rgba(88,166,255,0.3); border-radius:8px; }
    #email-triage .et-reply-label { font-size:11px; font-weight:700; color:#79c0ff; margin-bottom:6px; }
    #email-triage .et-draft { width:100%; min-height:120px; background:#0d1117; border:1px solid #30363d; border-radius:6px; color:#e6edf3; font-size:12px; padding:10px; resize:vertical; font-family:inherit; line-height:1.5; box-sizing:border-box; }
    #email-triage .et-draft-btns { display:flex; gap:6px; margin-top:8px; }
    #email-triage .et-folder { font-size:9px; color:#8b949e; background:#21262d; border:1px solid #30363d; border-radius:10px; padding:1px 7px; }
    #email-triage .et-delete { background:rgba(248,81,73,.1); border-color:rgba(248,81,73,.3); color:#ff7b72; }
    #email-triage .et-keep { background:rgba(63,185,80,.08); border-color:rgba(63,185,80,.25); color:#3fb950; }
    #email-triage .et-sugbanner { font-size:12px; color:#ff9b94; background:rgba(248,81,73,.08); border:1px solid rgba(248,81,73,.25); border-radius:8px; padding:8px 12px; margin-bottom:10px; display:flex; align-items:center; gap:10px; justify-content:space-between; }
    #email-triage .et-delall { background:rgba(248,81,73,.15); border-color:rgba(248,81,73,.4); color:#ff7b72; white-space:nowrap; }
    #email-triage .et-config { padding:6px 18px 10px; border-bottom:1px solid #161b22; font-size:11px; color:#8b949e; }
    #email-triage .et-cfg-link { background:transparent; border:none; color:#58a6ff; cursor:pointer; font-size:11px; padding:0; margin-right:8px; }
    #email-triage .et-cfg-summary { color:#6e7681; }
    #email-triage .et-cfg-row { margin:6px 0; display:flex; flex-direction:column; gap:4px; }
    #email-triage .et-cfg-row.et-cfg-inline { flex-direction:row; align-items:center; gap:6px; flex-wrap:wrap; }
    #email-triage .et-cfg-row label { color:#c9d1d9; }
    #email-triage .et-config input[type="text"] { width:100%; background:#0d1117; border:1px solid #30363d; border-radius:5px; color:#c9d1d9; font-size:12px; padding:6px 8px; }
    #email-triage .et-config input[type="number"] { width:64px; background:#0d1117; border:1px solid #30363d; border-radius:5px; color:#c9d1d9; font-size:12px; padding:4px 6px; }
    #email-triage .et-cfg-btns { display:flex; gap:6px; margin-top:6px; }
  `;
  document.head.appendChild(style);
}
