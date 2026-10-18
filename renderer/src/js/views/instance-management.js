/**
 * instance-management.js — Instance Management dashboard (Stage 7, dual-instance).
 *
 * Shows the live active/standby cluster status and exposes the operator
 * controls from the spec (§9). EVERYTHING here reads/acts through the backend
 * cluster IPC (window.ai.cluster*) — the backend enforces leadership and
 * authorization, so a UI action can NEVER bypass those rules (e.g. "Hand off"
 * only works if THIS instance is actually the leader; the button just asks, the
 * backend decides).
 *
 * Read:    window.ai.clusterGetDashboard()
 * Control: clusterSetAutoFailover(on) / clusterHandoff() / clusterSetMode(m) /
 *          clusterReconcile()
 *
 * When the cluster feature is OFF (legacy single-host), this panel shows a
 * simple "single-instance mode" notice and no controls — nothing to manage.
 */

let _el = null;
let _timer = null;
let _busy = false;

const _safe = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function _q(id) { return _el ? _el.querySelector('#' + id) : null; }
function _fmtDT(d) {
  if (!d) return '—';
  const dt = new Date(d); if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
    dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function _ago(d) {
  if (!d) return '—';
  const ms = Date.now() - new Date(d).getTime();
  if (isNaN(ms)) return '—';
  if (ms < 0) return 'now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); return h + 'h ago';
}
function _dot(color) { return '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + color + ';margin-right:6px;vertical-align:middle"></span>'; }

async function _load() {
  if (!window.ai || !window.ai.clusterGetDashboard) return null;
  try { return await window.ai.clusterGetDashboard(); } catch (_) { return null; }
}

function _render(d) {
  if (!_el) return;
  if (!d || d.unavailable) { _el.innerHTML = '<div style="padding:24px;color:#8b949e">Instance Management unavailable.</div>'; return; }

  if (!d.enabled) {
    _el.innerHTML =
      '<div style="padding:24px;max-width:720px">' +
      '<h2 style="margin:0 0 8px;font-size:16px">Instance Management</h2>' +
      '<div style="font-size:13px;color:#8b949e;line-height:1.6">' +
      _dot('#6e7681') + 'Running in <strong>single-instance mode</strong> (dual-instance cluster disabled). ' +
      'This machine owns all production work. Enable the cluster in configuration to run a synchronized standby with automatic failover.' +
      '</div></div>';
    return;
  }

  const self = d.self || {};
  const leader = d.leader || null;
  const iAmLeader = !!self.isLeader;
  const roleColor = iAmLeader ? '#22c55e' : (self.role === 'DEVELOPMENT' ? '#a855f7' : '#f0a800');

  const caps = self.capabilities || {};
  const capBadges = Object.keys(caps).map(k =>
    '<span style="font-size:10px;padding:2px 7px;border-radius:10px;border:1px solid var(--bdr,#30363d);margin-right:4px;color:' +
    (caps[k] ? '#22c55e' : '#8b949e') + '">' + _safe(k) + ': ' + (caps[k] ? 'yes' : 'no') + '</span>').join('');

  const hist = (d.failoverHistory || []).map(h =>
    '<div style="font-size:11px;color:#8b949e;padding:2px 0">' +
    _fmtDT(h.at) + ' — <strong style="color:' + (h.type === 'promoted' ? '#22c55e' : '#f0a800') + '">' + _safe(h.type) + '</strong>' +
    (h.token != null ? ' (token ' + _safe(h.token) + ')' : '') + (h.reason ? ' · ' + _safe(h.reason) : '') + '</div>'
  ).join('') || '<div style="font-size:11px;color:#6e7681">No failover events yet.</div>';

  _el.innerHTML =
    '<div style="padding:20px;max-width:860px">' +
    '<h2 style="margin:0 0 14px;font-size:16px">Instance Management</h2>' +

    // ── Two-instance status cards ──
    '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">' +
      // This instance
      '<div style="flex:1;min-width:300px;border:1px solid var(--bdr,#30363d);border-radius:8px;padding:14px">' +
        '<div style="font-size:9px;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">This instance</div>' +
        '<div style="font-size:14px;margin-bottom:6px">' + _dot(roleColor) + '<strong>' + _safe(self.role) + '</strong>' +
          (iAmLeader ? ' · <span style="color:#22c55e">LEADER</span>' : ' · standby') + '</div>' +
        '<div style="font-size:11px;color:#8b949e;font-family:monospace;margin-bottom:4px">' + _safe(self.instanceId || '—') + '</div>' +
        '<div style="font-size:11px;color:#8b949e">token: ' + (self.fencingToken == null ? '—' : _safe(self.fencingToken)) +
          ' · app v' + _safe(self.appVersion || '?') + '</div>' +
        '<div style="font-size:11px;color:#8b949e;margin:4px 0">last heartbeat: ' + _ago(self.lastHeartbeatAt) + '</div>' +
        '<div style="margin-top:6px">' + capBadges + '</div>' +
      '</div>' +
      // Current leader (shared record — may be the other instance)
      '<div style="flex:1;min-width:300px;border:1px solid var(--bdr,#30363d);border-radius:8px;padding:14px">' +
        '<div style="font-size:9px;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Production leader</div>' +
        (leader ?
          ('<div style="font-size:14px;margin-bottom:6px">' + _dot(leader.live ? '#22c55e' : '#ef4444') +
            '<strong>' + (leader.isSelf ? 'This instance' : 'Peer instance') + '</strong>' +
            (leader.live ? '' : ' <span style="color:#ef4444">(lease expired)</span>') + '</div>' +
           '<div style="font-size:11px;color:#8b949e;font-family:monospace;margin-bottom:4px">' + _safe(leader.instanceId || '—') + '</div>' +
           '<div style="font-size:11px;color:#8b949e">mode: ' + _safe(leader.mode || '—') + ' · token: ' + _safe(leader.fencingToken) + '</div>' +
           '<div style="font-size:11px;color:#8b949e;margin:4px 0">acquired: ' + _fmtDT(leader.acquiredAt) + '</div>' +
           '<div style="font-size:11px;color:#8b949e">lease heartbeat: ' + _ago(leader.heartbeatAt) + '</div>')
          : '<div style="font-size:12px;color:#ef4444">' + _dot('#ef4444') + 'No leader currently holds the lease.</div>') +
      '</div>' +
    '</div>' +

    // ── Sync + failover toggle row ──
    '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">' +
      '<div style="flex:1;min-width:240px;border:1px solid var(--bdr,#30363d);border-radius:8px;padding:12px">' +
        '<div style="font-size:11px;color:#8b949e">Sync cursor (events applied)</div>' +
        '<div style="font-size:18px;font-weight:600">' + _safe(d.sync ? d.sync.lastSyncSeq : 0) + '</div>' +
        '<div style="font-size:10px;color:#6e7681">' + _safe(d.sync ? d.sync.sharedKeyCount : 0) + ' shared keys tracked</div>' +
      '</div>' +
      '<div style="flex:1;min-width:240px;border:1px solid var(--bdr,#30363d);border-radius:8px;padding:12px">' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">' +
          '<input type="checkbox" id="im-autofailover"' + (d.autoFailover ? ' checked' : '') + '> Automatic failover' +
        '</label>' +
        '<div style="font-size:10px;color:#6e7681;margin-top:4px">When off, this instance won\u2019t take over even if the leader\u2019s lease expires.</div>' +
      '</div>' +
    '</div>' +

    // ── Controls ──
    '<div style="border:1px solid var(--bdr,#30363d);border-radius:8px;padding:12px;margin-bottom:16px">' +
      '<div style="font-size:9px;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Controls</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
        '<button class="sd-btn secondary" id="im-handoff" style="font-size:11px"' + (iAmLeader ? '' : ' disabled title="Only the current leader can hand off"') + '>Hand off leadership</button>' +
        '<button class="sd-btn secondary" id="im-reconcile" style="font-size:11px">Reconcile now</button>' +
        '<span style="font-size:11px;color:#8b949e;margin-left:6px">Mode:</span>' +
        '<select class="sd-select" id="im-mode" style="font-size:11px;width:auto">' +
          ['ACTIVE', 'STANDBY', 'DEVELOPMENT'].map(m => '<option value="' + m + '"' + (self.role === m ? ' selected' : '') + '>' + m + '</option>').join('') +
        '</select>' +
        '<span id="im-status" style="font-size:11px;color:#8b949e;margin-left:8px"></span>' +
      '</div>' +
    '</div>' +

    // ── Failover history ──
    '<div style="border:1px solid var(--bdr,#30363d);border-radius:8px;padding:12px">' +
      '<div style="font-size:9px;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Failover &amp; recovery history</div>' +
      hist +
    '</div>' +
    '</div>';

  _wire();
}

function _setStatus(msg, color) {
  const el = _q('im-status'); if (el) { el.textContent = msg || ''; el.style.color = color || '#8b949e'; }
}

function _wire() {
  const af = _q('im-autofailover');
  if (af) af.addEventListener('change', async () => {
    _setStatus('Saving…');
    try { const r = await window.ai.clusterSetAutoFailover(af.checked); _setStatus(r && r.ok ? 'Auto-failover ' + (af.checked ? 'enabled' : 'disabled') : 'Failed', r && r.ok ? '#22c55e' : '#ef4444'); }
    catch (e) { _setStatus('Error: ' + e.message, '#ef4444'); }
  });

  const ho = _q('im-handoff');
  if (ho) ho.addEventListener('click', async () => {
    ho.disabled = true; _setStatus('Handing off…');
    try {
      const r = await window.ai.clusterHandoff();
      _setStatus(r && r.ok ? 'Leadership released — standby will take over' : ('Refused: ' + ((r && r.error) || 'unknown')), r && r.ok ? '#22c55e' : '#ef4444');
    } catch (e) { _setStatus('Error: ' + e.message, '#ef4444'); }
    setTimeout(refresh, 800);
  });

  const rc = _q('im-reconcile');
  if (rc) rc.addEventListener('click', async () => {
    rc.disabled = true; _setStatus('Reconciling…');
    try { const r = await window.ai.clusterReconcile(); _setStatus(r && r.ok ? ('Reconciled — applied ' + r.applied + ' event(s)') : 'Reconcile unavailable', r && r.ok ? '#22c55e' : '#f0a800'); }
    catch (e) { _setStatus('Error: ' + e.message, '#ef4444'); }
    finally { rc.disabled = false; }
    setTimeout(refresh, 600);
  });

  const md = _q('im-mode');
  if (md) md.addEventListener('change', async () => {
    _setStatus('Switching mode…');
    try { const r = await window.ai.clusterSetMode(md.value); _setStatus(r && r.ok ? ('Mode: ' + r.mode) : ('Failed: ' + ((r && r.error) || '')), r && r.ok ? '#22c55e' : '#ef4444'); }
    catch (e) { _setStatus('Error: ' + e.message, '#ef4444'); }
    setTimeout(refresh, 600);
  });
}

async function refresh() {
  const d = await _load();
  _render(d);
}

export function mount(container) {
  _el = container;
  refresh();
  if (_timer) clearInterval(_timer);
  _timer = setInterval(refresh, 5000);   // live-ish; cheap IPC read
  return _el;
}

export function unmount() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _el = null;
}

export default { mount, unmount, refresh };
