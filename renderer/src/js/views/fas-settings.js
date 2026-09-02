// renderer/src/js/views/fas-settings.js
// Wires the Digital Fleet Asset Specialist settings section: mode/config toggles
// and the Shadow-mode comparison log (FAS draft vs. what was actually sent).
// Self-contained so it doesn't bloat the settings.js monolith.

import { slack as slackBridge } from '../bridge.js';
import toast from '../components/toast.js';

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _status(msg, kind) {
  const el = document.getElementById('fas-status');
  if (!el) return;
  el.style.display = '';
  el.textContent = msg;
  el.className = 'sd-status' + (kind ? ' ' + kind : '');
}

async function _loadConfig() {
  try {
    const c = await slackBridge.fasGetConfig();
    const en = document.getElementById('fas-enabled');
    const mode = document.getElementById('fas-mode');
    const steps = document.getElementById('fas-max-steps');
    const rt = document.getElementById('fas-max-runtime');
    if (en) en.checked = !!c.enabled;
    if (mode) mode.value = c.mode || 'shadow';
    if (steps) steps.value = c.maxSteps || 6;
    if (rt) rt.value = Math.round((c.maxRuntimeMs || 45000) / 1000);
  } catch (e) { /* config not available yet */ }
}

async function _saveConfig() {
  try {
    const enabled = !!document.getElementById('fas-enabled').checked;
    const mode = document.getElementById('fas-mode').value;
    const maxSteps = parseInt(document.getElementById('fas-max-steps').value, 10) || 6;
    const maxRuntimeMs = (parseInt(document.getElementById('fas-max-runtime').value, 10) || 45) * 1000;
    await slackBridge.fasSaveConfig({ enabled, mode, maxSteps, maxRuntimeMs });
    _status('FAS config saved (' + mode + (enabled ? ', enabled' : ', disabled') + ')', 'ok');
    toast.show('success', 'FAS config saved', 2000);
  } catch (e) {
    _status('Save failed: ' + e.message, 'error');
  }
}

function _divergenceBadge(d) {
  const pct = Math.round((d || 0) * 100);
  const color = pct >= 60 ? 'var(--err,#c0392b)' : pct >= 30 ? 'var(--warn,#c98a00)' : 'var(--acc2,#2d7)';
  return '<span style="font-size:9px;font-weight:700;color:#fff;background:' + color + ';padding:2px 6px;border-radius:8px">' + pct + '% diff</span>';
}

async function _refreshAudit() {
  const list = document.getElementById('fas-audit-list');
  if (!list) return;
  list.innerHTML = '<div class="sd-hint">Loading…</div>';
  try {
    const rows = await slackBridge.fasGetAudit(60);
    if (!rows || !rows.length) {
      list.innerHTML = '<div class="sd-hint">No shadow comparisons yet. Enable FAS in Shadow mode; entries appear as DMs are handled.</div>';
      return;
    }
    // Highest divergence first, then newest.
    rows.sort((a, b) => (b.divergence - a.divergence) || (String(b.at).localeCompare(String(a.at))));
    list.innerHTML = rows.map((r) => {
      const when = (() => { try { return new Date(r.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; } })();
      const actions = (r.fasProposedActions || []).length ? ('<div class="sd-hint">Proposed: ' + _esc(r.fasProposedActions.join(', ')) + '</div>') : '';
      const denied = (r.deniedScope || []).length ? ('<div class="sd-hint" style="color:var(--err,#c0392b)">Out of scope (blocked): ' + _esc(r.deniedScope.join(', ')) + '</div>') : '';
      const missing = (r.missingFacts || []).length ? ('<div class="sd-hint">Missing/stale: ' + _esc(r.missingFacts.slice(0, 3).join('; ')) + '</div>') : '';
      return '<div style="border:1px solid var(--bd,#333);border-radius:8px;padding:8px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
          '<span style="font-size:10px;font-weight:700">' + _esc(r.channelName || '') + ' · ' + _esc(r.fasDecision || '') + '</span>' +
          _divergenceBadge(r.divergence) +
        '</div>' +
        '<div class="sd-hint" style="margin:4px 0"><strong>Msg:</strong> ' + _esc((r.message || '').slice(0, 200)) + '</div>' +
        '<div class="sd-hint" style="margin:2px 0"><strong>Sent:</strong> ' + _esc((r.actualReply || '').slice(0, 300)) + '</div>' +
        '<div class="sd-hint" style="margin:2px 0"><strong>FAS would say:</strong> ' + _esc((r.fasReply || '').slice(0, 300)) + '</div>' +
        actions + denied + missing +
        '<div class="sd-hint" style="opacity:.6;margin-top:2px">' + _esc(when) + (r.fasReason ? ' · ' + _esc(r.fasReason) : '') + '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    list.innerHTML = '<div class="sd-hint" style="color:var(--err,#c0392b)">Failed to load: ' + _esc(e.message) + '</div>';
  }
}

// Called once from settings.init(). Idempotent (guards against double-wiring).
let _wired = false;
export function initFasSettings() {
  const sect = document.getElementById('sect-fas');
  if (!sect || _wired) return;
  _wired = true;
  const saveBtn = document.getElementById('fas-save');
  const refreshBtn = document.getElementById('fas-refresh-audit');
  if (saveBtn) saveBtn.addEventListener('click', _saveConfig);
  if (refreshBtn) refreshBtn.addEventListener('click', _refreshAudit);
  _loadConfig();
  _refreshAudit();
}

export { _refreshAudit as refreshFasAudit };
