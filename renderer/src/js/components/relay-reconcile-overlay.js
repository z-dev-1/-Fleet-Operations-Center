/**
 * relay-reconcile-overlay.js — review queue for staged Relay WR posts (MODE B).
 *
 * Lists the AI's proposed Relay Garage comments — gap-fills (an Offsite update
 * Relay is missing) and dealer-asks (a stale-unit update request) — each with
 * the AI's reasoning, so the user can Confirm (post it to the real AAP work
 * request) or Dismiss. Also exposes the config incl. the MODE A/B toggle.
 * Opened from the toolbar (🔁 → bus 'ui:relay-reconcile-toggle').
 */

import bus from '../bus.js';

let _open = false;
let _pending = { items: [] };
let _config = {};
let _cfgOpen = false;

export function init() {
  bus.on('ui:relay-reconcile-toggle', () => { if (_open) _close(); else _open_(); });
  if (window.relayReconcile && window.relayReconcile.onUpdated) {
    window.relayReconcile.onUpdated((p) => { if (p) _pending = p; if (_open) _render(); });
  }
}

async function _open_() {
  _open = true;
  _injectStyle();
  const overlay = document.createElement('div');
  overlay.id = 'relay-reconcile';
  overlay.innerHTML = `
    <div class="rr-backdrop"></div>
    <div class="rr-panel">
      <div class="rr-head">
        <div class="rr-title">🔁 Relay ↔ Offsite — proposed updates</div>
        <div class="rr-actions">
          <button class="rr-btn" id="rr-cfg">⚙</button>
          <button class="rr-x" id="rr-close" title="Close">✕</button>
        </div>
      </div>
      <div class="rr-meta" id="rr-meta"></div>
      <div class="rr-config" id="rr-config"></div>
      <div class="rr-body" id="rr-body"><div class="rr-empty">Loading…</div></div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('.rr-backdrop').addEventListener('click', _close);
  document.getElementById('rr-close').addEventListener('click', _close);
  document.getElementById('rr-cfg').addEventListener('click', () => { _cfgOpen = !_cfgOpen; _renderConfig(); });

  try {
    if (window.relayReconcile) {
      _pending = await window.relayReconcile.getPending() || { items: [] };
      _config = await window.relayReconcile.getConfig() || {};
    }
  } catch (_) {}
  _render();
  _renderConfig();
}

function _close() {
  _open = false;
  const el = document.getElementById('relay-reconcile');
  if (el) el.remove();
}

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _render() {
  const body = document.getElementById('rr-body');
  if (!body) return;
  const items = (_pending && Array.isArray(_pending.items) ? _pending.items : []).filter((i) => i.state === 'pending');
  const meta = document.getElementById('rr-meta');
  if (meta) {
    const mode = _config.autoPostToRelay ? 'A (auto-post)' : 'B (confirm-to-post)';
    meta.textContent = items.length + ' proposed update' + (items.length === 1 ? '' : 's') + ' awaiting review · mode ' + mode +
      (_config.enabled ? '' : ' · engine OFF');
  }
  if (!items.length) {
    body.innerHTML = '<div class="rr-empty">Nothing to review. Proposed Relay updates from the next sync will appear here.</div>';
    return;
  }
  body.innerHTML = items.map(_cardHtml).join('');
  items.forEach((it) => {
    const card = document.querySelector('.rr-card[data-id="' + CSS.escape(it.id) + '"]');
    if (!card) return;
    const c = card.querySelector('[data-confirm]'); if (c) c.addEventListener('click', () => _confirm(it.id));
    const d = card.querySelector('[data-dismiss]'); if (d) d.addEventListener('click', () => _dismiss(it.id));
  });
}

function _cardHtml(it) {
  const kindLabel = it.kind === 'dealer-ask' ? '📨 Request update from dealer' : '📝 Fill Relay with Offsite update';
  const conf = (typeof it.confidence === 'number') ? Math.round(it.confidence * 100) + '%' : '';
  return '' +
    '<div class="rr-card" data-id="' + _esc(it.id) + '">' +
      '<div class="rr-card-top">' +
        '<span class="rr-kind rr-kind--' + (it.kind === 'dealer-ask' ? 'ask' : 'gap') + '">' + kindLabel + '</span>' +
        '<span class="rr-unit">🚚 ' + _esc(it.equipmentId) + (it.vendor ? ' · ' + _esc(it.vendor) : '') + '</span>' +
        (conf ? '<span class="rr-conf">AI ' + conf + '</span>' : '') +
      '</div>' +
      '<div class="rr-text">' + _esc(it.text) + '</div>' +
      (it.reasoning ? '<div class="rr-why">Why: ' + _esc(it.reasoning) + '</div>' : '') +
      '<div class="rr-card-btns">' +
        '<button class="rr-mini rr-confirm" data-confirm="' + _esc(it.id) + '">Post to Relay</button>' +
        '<button class="rr-mini rr-dismiss" data-dismiss="' + _esc(it.id) + '">Dismiss</button>' +
        (it.offsiteUrl ? '<a class="rr-link" href="#" data-url="' + _esc(it.offsiteUrl) + '">Offsite ↗</a>' : '') +
      '</div>' +
    '</div>';
}

async function _confirm(id) {
  const it = _pending.items.find((x) => x.id === id);
  if (!confirm('Post this comment to the Relay work request for ' + (it ? it.equipmentId : '') + '?\nThis is visible to the team in AAP.')) return;
  _toast('Posting to Relay…');
  try {
    const r = await window.relayReconcile.confirm(id);
    if (r && r.ok) {
      if (it) it.state = 'posted';
      _render();
      _toast(r.message || 'Posted to Relay.');
    } else {
      _toast('Post failed: ' + ((r && r.error) || 'unknown'));
    }
  } catch (e) { _toast('Post failed: ' + (e.message || e)); }
}

async function _dismiss(id) {
  try {
    await window.relayReconcile.dismiss(id);
    const it = _pending.items.find((x) => x.id === id);
    if (it) it.state = 'dismissed';
    _render();
  } catch (_) {}
}

function _renderConfig() {
  const box = document.getElementById('rr-config');
  if (!box) return;
  if (!_cfgOpen) { box.innerHTML = ''; box.style.display = 'none'; return; }
  box.style.display = 'block';
  const c = _config || {};
  box.innerHTML =
    '<div class="rr-cfg-row"><label><input id="rr-enabled" type="checkbox" ' + (c.enabled ? 'checked' : '') + '/> Engine enabled (runs during sync)</label></div>' +
    '<div class="rr-cfg-row"><label><input id="rr-auto" type="checkbox" ' + (c.autoPostToRelay ? 'checked' : '') + '/> Auto-post to Relay (MODE A) — off = stage for confirm (MODE B)</label></div>' +
    '<div class="rr-cfg-row rr-cfg-inline">' +
      '<label>Stale after <input id="rr-stale" type="number" min="1" max="30" value="' + (c.staleDays || 3) + '"> day(s)</label>' +
      '<label style="margin-left:12px">Max units/sync <input id="rr-max" type="number" min="1" max="50" value="' + (c.maxUnitsPerSync || 8) + '"></label>' +
    '</div>' +
    '<div class="rr-cfg-btns"><button class="rr-mini rr-cfg-save" id="rr-cfg-save">Save</button></div>';
  document.getElementById('rr-cfg-save').addEventListener('click', async () => {
    const patch = {
      enabled: document.getElementById('rr-enabled').checked,
      autoPostToRelay: document.getElementById('rr-auto').checked,
      staleDays: parseInt(document.getElementById('rr-stale').value, 10) || 3,
      maxUnitsPerSync: parseInt(document.getElementById('rr-max').value, 10) || 8,
    };
    try { _config = await window.relayReconcile.setConfig(patch) || _config; _cfgOpen = false; _renderConfig(); _render(); _toast('Settings saved.'); }
    catch (e) { _toast('Save failed: ' + (e.message || e)); }
  });
}

function _toast(msg) { try { bus.emit('ui:toast', { type: 'info', message: msg, duration: 2500 }); } catch (_) {} }

function _injectStyle() {
  if (document.getElementById('relay-reconcile-style')) return;
  const style = document.createElement('style');
  style.id = 'relay-reconcile-style';
  style.textContent = `
    #relay-reconcile { position:fixed; inset:0; z-index:99999; display:flex; align-items:center; justify-content:center; }
    #relay-reconcile .rr-backdrop { position:absolute; inset:0; background:rgba(1,4,9,0.72); backdrop-filter:blur(6px); }
    #relay-reconcile .rr-panel { position:relative; z-index:1; width:680px; max-width:94vw; max-height:86vh; display:flex; flex-direction:column; background:#0d1117; border:1px solid #30363d; border-radius:12px; box-shadow:0 24px 60px rgba(0,0,0,0.6); overflow:hidden; }
    #relay-reconcile .rr-head { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid #21262d; }
    #relay-reconcile .rr-title { font-size:15px; font-weight:600; color:#e6edf3; }
    #relay-reconcile .rr-actions { display:flex; gap:8px; align-items:center; }
    #relay-reconcile .rr-btn { background:#30363d; border:none; color:#c9d1d9; font-size:13px; padding:6px 10px; border-radius:6px; cursor:pointer; }
    #relay-reconcile .rr-x { background:transparent; border:none; color:#8b949e; font-size:16px; cursor:pointer; padding:4px 8px; }
    #relay-reconcile .rr-meta { padding:8px 18px; font-size:11px; color:#8b949e; border-bottom:1px solid #161b22; }
    #relay-reconcile .rr-config { padding:8px 18px; border-bottom:1px solid #161b22; font-size:12px; color:#c9d1d9; display:none; }
    #relay-reconcile .rr-cfg-row { margin:6px 0; }
    #relay-reconcile .rr-cfg-inline label { display:inline-block; }
    #relay-reconcile .rr-config input[type="number"] { width:56px; background:#0d1117; border:1px solid #30363d; border-radius:4px; color:#c9d1d9; padding:3px 6px; }
    #relay-reconcile .rr-cfg-btns { margin-top:6px; }
    #relay-reconcile .rr-body { padding:12px 14px; overflow-y:auto; }
    #relay-reconcile .rr-empty { color:#8b949e; font-size:13px; text-align:center; padding:36px 0; }
    #relay-reconcile .rr-card { background:#161b22; border:1px solid #21262d; border-left:3px solid #388bfd; border-radius:8px; padding:12px 14px; margin-bottom:10px; }
    #relay-reconcile .rr-card-top { display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap; }
    #relay-reconcile .rr-kind { font-size:11px; font-weight:700; padding:2px 8px; border-radius:4px; }
    #relay-reconcile .rr-kind--gap { background:rgba(56,139,253,.15); color:#79c0ff; }
    #relay-reconcile .rr-kind--ask { background:rgba(240,168,0,.15); color:#f0a800; }
    #relay-reconcile .rr-unit { font-size:12px; font-weight:600; color:#e6edf3; }
    #relay-reconcile .rr-conf { font-size:10px; color:#8b949e; margin-left:auto; }
    #relay-reconcile .rr-text { font-size:13px; color:#e6edf3; line-height:1.5; background:#0d1117; border:1px solid #30363d; border-radius:6px; padding:8px 10px; white-space:pre-wrap; }
    #relay-reconcile .rr-why { font-size:11px; color:#8b949e; font-style:italic; margin-top:5px; }
    #relay-reconcile .rr-card-btns { display:flex; gap:6px; margin-top:8px; align-items:center; }
    #relay-reconcile .rr-mini { font-size:11px; font-weight:600; padding:5px 12px; border-radius:5px; cursor:pointer; border:1px solid #30363d; background:#21262d; color:#c9d1d9; }
    #relay-reconcile .rr-confirm { background:rgba(63,185,80,.12); border-color:rgba(63,185,80,.35); color:#3fb950; }
    #relay-reconcile .rr-link { font-size:11px; color:#58a6ff; margin-left:auto; text-decoration:none; }
  `;
  document.head.appendChild(style);
}
