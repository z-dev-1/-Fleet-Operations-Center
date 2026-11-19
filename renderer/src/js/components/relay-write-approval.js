/**
 * relay-write-approval.js — user approval for Relay writes (src/writes/write-gate.js).
 *
 * Nothing is written to Relay (WR comment / work-request create) without an
 * explicit click here:
 *   - 'relayWrites:approval-request' { id, kind, preview, aiDrafted } opens a
 *     modal with the exact content that will be sent. "Approve & send" ->
 *     respond(id, true). Cancel, the ✕, the backdrop and Escape -> respond(id, false).
 *     The prompt waits while another modal is open and goes back to the front
 *     of the queue if another modal replaces it (checked by a hidden marker in
 *     its body, since modal.js drops the replaced onClose). When the main process stops
 *     waiting (timeout, or answered from the list) the stale prompt closes and
 *     the user is told nothing was sent; a refused respond() is shown too.
 *   - Queued writes (non-interactive callers) are counted on the toolbar button
 *     #tb-relay-writes; clicking it ('ui:relay-writes-open') lists them with
 *     Approve / Reject per item.
 */

import modal from './modal.js';
import bus from '../bus.js';

const _queue = [];
let _active = null;
let _closeActive = null;   // closes the active prompt without answering it
let _waitTimer = null;
const WAIT_POLL_MS = 500;

export function init() {
  const rw = window.relayWrites;
  if (!rw) return;
  if (typeof rw.onRequest === 'function') rw.onRequest((req) => _enqueue(req));
  if (typeof rw.onUpdated === 'function') rw.onUpdated((p) => { _setBadge(p); _dropStale(p); });
  bus.on('ui:relay-writes-open', () => { openList(); });
  if (typeof rw.list === 'function') {
    Promise.resolve(rw.list()).then(_setBadge).catch(() => {});
  }
}

export function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _title(kind) {
  if (kind === 'updateEscalations') return 'Approve Relay escalation';
  if (kind === 'setLifecycle') return 'Approve AAP lifecycle change';
  return kind === 'createWorkOrder' ? 'Approve Relay work request' : 'Approve Relay comment';
}

function _previewHtml(item) {
  return (item.aiDrafted
    ? '<div class="rwa-ai" style="display:inline-block;margin-bottom:8px;padding:2px 8px;border-radius:4px;background:rgba(240,168,0,.15);color:#f0a800;font-weight:700;font-size:11px;">AI-drafted — review the exact text</div>'
    : '') +
    '<pre class="rwa-preview" style="white-space:pre-wrap;word-break:break-word;margin:0;padding:10px 12px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#e6edf3;font-size:12px;line-height:1.5;max-height:50vh;overflow:auto;">' +
    _esc(item.preview) + '</pre>';
}

function _enqueue(req) {
  if (!req || !req.id) return;
  _queue.push(req);
  if (!_active) _next();
}

function _next() {
  _active = null;
  _closeActive = null;
  if (!_queue.length) return;
  // Never displace another open modal (its onClose would be lost); wait for it.
  if (modal.isOpen()) {
    if (!_waitTimer) _waitTimer = setTimeout(() => { _waitTimer = null; if (!_active) _next(); }, WAIT_POLL_MS);
    return;
  }
  showRequest(_queue.shift());
}

// The main process stopped waiting for a request (timed out -> 'not-approved',
// or answered from the list): drop it from the queue, close it if on screen.
function _dropStale(p) {
  const items = (p && Array.isArray(p.items)) ? p.items : [];
  const settled = (id) => {
    const it = items.find((x) => x && x.id === id);
    return !!(it && it.state !== 'pending' && it.state !== 'sending');
  };
  for (let i = _queue.length - 1; i >= 0; i--) if (settled(_queue[i].id)) _queue.splice(i, 1);
  if (_active && _closeActive && settled(_active.id)) {
    const it = items.find((x) => x && x.id === _active.id);
    _closeActive();
    if (it && it.state === 'not-approved') _toast('Approval request timed out; nothing was sent to Relay.');
  }
}

// Exported for tests.
export function showRequest(req) {
  _active = req;
  let answered = false;
  const answer = (approved) => {
    if (answered) return;
    answered = true;
    let r;
    try { r = window.relayWrites.respond(req.id, approved === true); } catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
    // A refused respond (the main process already stopped waiting) means nothing was sent.
    Promise.resolve(r).then((res) => {
      if (res && res.ok === false) _toast('Not sent to Relay: ' + (res.error || 'this approval request is no longer waiting') + '.');
    }).catch(() => {});
  };
  // Close the prompt without answering (the main process is no longer waiting).
  _closeActive = () => { answered = true; modal.close(); };
  // modal.js is a singleton: another show() replaces this prompt and drops its
  // onClose. The hidden marker disappears when that happens; the watchdog then
  // puts the unanswered request back at the front, and it shows again once the
  // other modal closes.
  const marker = 'data-rwa-prompt="' + _safeId(req.id) + '"';
  let watch = null;
  const stopWatch = () => { if (watch) { clearInterval(watch); watch = null; } };
  watch = setInterval(() => {
    if (answered) { stopWatch(); return; }
    if (_onScreen(req.id)) return;
    stopWatch();
    if (_active === req) { _queue.unshift(req); _next(); }
  }, WAIT_POLL_MS);
  modal.show({
    title: _title(req.kind),
    width: 640,
    body: '<span ' + marker + ' hidden></span>' +
      '<p style="margin:0 0 8px;">Nothing is sent to Relay unless you click <b>Approve &amp; send</b>. This is exactly what will be sent:</p>' +
      _previewHtml(req),
    actions: [
      { label: 'Cancel', cls: '', onClick: () => { answer(false); modal.close(); } },
      { label: 'Approve & send', cls: 'primary', onClick: () => { answer(true); modal.close(); } },
    ],
    // Any other close (✕, backdrop, Escape) counts as Cancel.
    onClose: () => { stopWatch(); answer(false); _next(); },
  });
}

// Is the prompt for this request id still the content of the shared modal?
function _onScreen(id) {
  const d = globalThis.document;
  if (!d || typeof d.querySelector !== 'function') return true;
  return !!d.querySelector('[data-rwa-prompt="' + _safeId(id) + '"]');
}

function _safeId(id) { return String(id == null ? '' : id).replace(/[^\w-]/g, ''); }

function _setBadge(p) {
  const items = (p && Array.isArray(p.items)) ? p.items : [];
  const n = items.filter((i) => i && i.state === 'pending').length;
  const badge = document.getElementById('tb-relay-writes-badge');
  if (!badge) return;
  badge.textContent = String(n);
  badge.style.display = n ? '' : 'none';
}

function _toast(msg) { try { bus.emit('ui:toast', { type: 'info', message: msg, duration: 3000 }); } catch (_) {} }

// Exported for tests.
export async function openList() {
  const rw = window.relayWrites;
  if (!rw || typeof rw.list !== 'function') return;
  if (_active) { _toast('Answer the open Relay approval first.'); return; }
  let p = { items: [] };
  try { p = (await rw.list()) || { items: [] }; } catch (_) {}
  _setBadge(p);
  const items = (Array.isArray(p.items) ? p.items : []).filter((i) => i && i.state === 'pending');
  const body = items.length
    ? items.map((it) =>
      '<div class="rwa-item" data-id="' + _esc(it.id) + '" style="margin-bottom:12px;">' +
        '<div style="font-size:11px;margin-bottom:4px;">' + _esc(_title(it.kind)) + ' · ' + _esc(it.unit || '-') + ' · from ' + _esc(it.origin || 'unknown') + ' · queued ' + _esc(it.createdAt || '') + '</div>' +
        _previewHtml(it) +
        '<div style="display:flex;gap:6px;margin-top:6px;">' +
          '<button class="btn primary" data-rw-approve="' + _esc(it.id) + '">Approve &amp; send</button>' +
          '<button class="btn" data-rw-reject="' + _esc(it.id) + '">Reject</button>' +
        '</div>' +
      '</div>').join('')
    : '<p>No Relay writes are waiting for approval.</p>';
  modal.show({
    title: 'Relay writes awaiting your approval',
    width: 680,
    body,
    actions: [{ label: 'Close', cls: '', onClick: () => modal.close() }],
    onMount: (el) => {
      el.querySelectorAll('[data-rw-approve]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.getAttribute('data-rw-approve');
        try {
          const r = await rw.approve(id);
          _toast(r && r.ok ? 'Sent to Relay.' : 'Not sent: ' + ((r && r.error) || (r && r.outcome) || 'unknown'));
        } catch (e) { _toast('Not sent: ' + (e.message || e)); }
        openList();
      }));
      el.querySelectorAll('[data-rw-reject]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.getAttribute('data-rw-reject');
        try { await rw.reject(id); _toast('Rejected; nothing was sent.'); } catch (_) {}
        openList();
      }));
    },
  });
}
