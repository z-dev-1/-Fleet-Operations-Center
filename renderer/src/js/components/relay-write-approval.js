/**
 * relay-write-approval.js — user approval for Relay writes (src/writes/write-gate.js).
 *
 * Nothing is written to Relay (WR comment / work-request create) without an
 * explicit click here:
 *   - 'relayWrites:approval-request' { id, kind, preview, aiDrafted } opens a
 *     modal with the exact content that will be sent. "Approve & send" ->
 *     respond(id, true). Cancel, the ✕, the backdrop and Escape -> respond(id, false).
 *   - Queued writes (non-interactive callers) are counted on the toolbar button
 *     #tb-relay-writes; clicking it ('ui:relay-writes-open') lists them with
 *     Approve / Reject per item.
 */

import modal from './modal.js';
import bus from '../bus.js';

const _queue = [];
let _active = null;

export function init() {
  const rw = window.relayWrites;
  if (!rw) return;
  if (typeof rw.onRequest === 'function') rw.onRequest((req) => _enqueue(req));
  if (typeof rw.onUpdated === 'function') rw.onUpdated((p) => _setBadge(p));
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
  const req = _queue.shift();
  if (req) showRequest(req);
}

// Exported for tests.
export function showRequest(req) {
  _active = req;
  let answered = false;
  const answer = (approved) => {
    if (answered) return;
    answered = true;
    try { window.relayWrites.respond(req.id, approved === true); } catch (_) {}
  };
  modal.show({
    title: _title(req.kind),
    width: 640,
    body: '<p style="margin:0 0 8px;">Nothing is sent to Relay unless you click <b>Approve &amp; send</b>. This is exactly what will be sent:</p>' +
      _previewHtml(req),
    actions: [
      { label: 'Cancel', cls: '', onClick: () => { answer(false); modal.close(); } },
      { label: 'Approve & send', cls: 'primary', onClick: () => { answer(true); modal.close(); } },
    ],
    // Any other close (✕, backdrop, Escape) counts as Cancel.
    onClose: () => { answer(false); _next(); },
  });
}

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
