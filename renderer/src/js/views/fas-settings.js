// renderer/src/js/views/fas-settings.js
// Wires the Digital Fleet Asset Specialist settings section: mode/config toggles
// and the Shadow-mode comparison log (FAS draft vs. what was actually sent).
// Self-contained so it doesn't bloat the settings.js monolith.

import { slack as slackBridge } from '../bridge.js';
import toast from '../components/toast.js';
import bus from '../bus.js';

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

async function _refreshFollowUps() {
  const list = document.getElementById('fas-followup-list');
  if (!list) return;
  try {
    const rows = await slackBridge.fasGetDueFollowups();
    if (!rows || !rows.length) { list.innerHTML = '<div class="sd-hint">No follow-ups due.</div>'; return; }
    list.innerHTML = rows.map((r) => {
      const when = (() => { try { return new Date(r.dueAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return r.dueAt || ''; } })();
      const openBtn = (r.slackRef && r.slackRef.channelId)
        ? '<button class="sd-btn secondary fas-fu-open" data-ch="' + _esc(r.slackRef.channelId) + '" data-ts="' + _esc(r.slackRef.ts || '') + '">Open Slack</button>' : '';
      return '<div style="border:1px solid var(--bd,#333);border-radius:8px;padding:8px" data-cid="' + _esc(r.caseId) + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
          '<span style="font-size:11px;font-weight:700">' + _esc(r.unit || r.caseId) + (r.owner ? (' \u00b7 ' + _esc(r.owner)) : '') + '</span>' +
          '<span style="font-size:9px;opacity:.7">due ' + _esc(when) + '</span>' +
        '</div>' +
        (r.sourcePromise ? '<div class="sd-hint" style="margin:3px 0"><strong>Promise:</strong> ' + _esc(r.sourcePromise) + '</div>' : '') +
        (r.summary ? '<div class="sd-hint" style="opacity:.8">' + _esc(String(r.summary).slice(0, 200)) + '</div>' : '') +
        '<div class="sd-btn-row" style="margin-top:6px">' +
          '<button class="sd-btn primary fas-fu-complete" data-cid="' + _esc(r.caseId) + '">Complete</button>' +
          '<button class="sd-btn secondary fas-fu-snooze" data-cid="' + _esc(r.caseId) + '">Snooze 1 day</button>' +
          '<button class="sd-btn secondary fas-fu-dismiss" data-cid="' + _esc(r.caseId) + '">Dismiss</button>' +
          openBtn +
        '</div>' +
      '</div>';
    }).join('');
    const refresh = () => _refreshFollowUps();
    list.querySelectorAll('.fas-fu-complete').forEach(b => b.addEventListener('click', async () => {
      try { await slackBridge.fasCompleteFollowup({ caseId: b.getAttribute('data-cid') }); toast.show('success', 'Follow-up completed', 1500); } catch (e) { toast.show('error', e.message, 3000); }
      refresh();
    }));
    list.querySelectorAll('.fas-fu-snooze').forEach(b => b.addEventListener('click', async () => {
      const until = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      try { await slackBridge.fasSnoozeFollowup({ caseId: b.getAttribute('data-cid'), until }); toast.show('success', 'Snoozed 1 day', 1500); } catch (e) { toast.show('error', e.message, 3000); }
      refresh();
    }));
    list.querySelectorAll('.fas-fu-dismiss').forEach(b => b.addEventListener('click', async () => {
      try { await slackBridge.fasDismissFollowup(b.getAttribute('data-cid')); toast.show('info', 'Dismissed', 1500); } catch (e) { toast.show('error', e.message, 3000); }
      refresh();
    }));
    list.querySelectorAll('.fas-fu-open').forEach(b => b.addEventListener('click', () => {
      const ch = b.getAttribute('data-ch');
      if (ch && window.files && window.files.openExternal) window.files.openExternal('slack://channel?id=' + ch);
    }));
  } catch (e) {
    list.innerHTML = '<div class="sd-hint" style="color:var(--err,#c0392b)">Failed to load: ' + _esc(e.message) + '</div>';
  }
}

async function _refreshAutoActions() {
  const list = document.getElementById('fas-autoaction-list');
  if (!list) return;
  try {
    const cat = await slackBridge.fasGetActionCatalog();
    if (!cat || !cat.length) { list.innerHTML = '<div class="sd-hint">No actions registered.</div>'; return; }
    list.innerHTML = cat.map((a) => {
      const lvl = a.level === 'low'
        ? '<span style="color:var(--ok,#2e7d32);font-size:9px">low-risk</span>'
        : '<span style="color:var(--err,#c0392b);font-size:9px">always requires approval</span>';
      const control = a.eligibleForAutomatic
        ? '<label class="sd-hint" style="display:inline-flex;gap:4px;align-items:center"><input type="checkbox" class="fas-auto-cb" data-name="' + _esc(a.name) + '"' + (a.enabled ? ' checked' : '') + '/> allow automatic</label>'
        : '<span class="sd-hint" style="opacity:.6">approval only</span>';
      return '<div style="border:1px solid var(--bd,#333);border-radius:8px;padding:8px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
          '<span style="font-size:11px;font-weight:700">' + _esc(a.name) + '</span>' + lvl +
        '</div>' +
        '<div class="sd-hint" style="margin:3px 0">' + _esc(a.description) + '</div>' +
        control +
      '</div>';
    }).join('');
    list.querySelectorAll('.fas-auto-cb').forEach((cb) => {
      cb.addEventListener('change', async () => {
        // Recompute the full enabled list from the current checkbox state.
        const enabled = [...list.querySelectorAll('.fas-auto-cb')].filter(x => x.checked).map(x => x.getAttribute('data-name'));
        try {
          await slackBridge.fasSaveConfig({ approvedAutomaticActions: enabled });
          toast.show('success', 'Automatic actions updated', 1800);
        } catch (e) { toast.show('error', 'Save failed: ' + e.message, 3000); }
        _refreshAutoActions();
      });
    });
  } catch (e) {
    list.innerHTML = '<div class="sd-hint" style="color:var(--err,#c0392b)">Failed to load: ' + _esc(e.message) + '</div>';
  }
}

async function _refreshReplyApprovals() {
  const list = document.getElementById('fas-reply-approval-list');
  if (!list) return;
  try {
    const rows = await slackBridge.fasGetReplyQueue('pending');
    if (!rows || !rows.length) {
      list.innerHTML = '<div class="sd-hint">No replies awaiting approval. (Only Approval/Autonomous modes queue replies.)</div>';
      return;
    }
    list.innerHTML = rows.map((r) => {
      const facts = (r.evidence && r.evidence.verifiedFacts || []).slice(0, 6)
        .map(f => '· ' + _esc(f.field) + ': ' + _esc(String(typeof f.value === 'object' ? JSON.stringify(f.value) : f.value).slice(0, 80)) + ' [' + _esc(f.source || '?') + ']').join('<br/>');
      const missing = (r.evidence && r.evidence.missingFacts || []).length ? ('<div class="sd-hint" style="color:var(--warn,#b8860b)">Missing/stale: ' + _esc((r.evidence.missingFacts).slice(0, 3).join('; ')) + '</div>') : '';
      const conflicts = (r.evidence && r.evidence.conflicts || []).length ? ('<div class="sd-hint" style="color:var(--err,#c0392b)">Conflicts: ' + _esc((r.evidence.conflicts).map(c => c.type || c.detail || '').join('; ')) + '</div>') : '';
      const risks = (r.proposedActions || []).length ? ('<div class="sd-hint" style="color:var(--err,#c0392b)">Proposed actions (executed on approval): ' + _esc(r.proposedActions.map(a => a && a.tool).filter(Boolean).join(', ')) + '</div>') : '';
      const conf = (r.confidence != null) ? (' · conf ' + Math.round(r.confidence * 100) + '%') : '';
      return '<div style="border:1px solid var(--bd,#333);border-radius:8px;padding:8px" data-id="' + _esc(r.id) + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
          '<span style="font-size:11px;font-weight:700">' + _esc(r.senderName || r.slackId || '') + ' · ' + _esc(r.engine || 'dm') + ' · ' + _esc(r.decision || '') + _esc(conf) + '</span>' +
          '<span style="font-size:9px;opacity:.6">' + _esc(r.targetUnit || '') + '</span>' +
        '</div>' +
        '<div class="sd-hint" style="margin:4px 0"><strong>Request:</strong> ' + _esc((r.request || '').slice(0, 240)) + '</div>' +
        '<div class="sd-hint" style="margin:2px 0"><strong>Proposed reply:</strong> ' + _esc((r.proposedReply || '').slice(0, 400)) + '</div>' +
        (r.reason ? '<div class="sd-hint" style="opacity:.75"><strong>Reason:</strong> ' + _esc(r.reason) + '</div>' : '') +
        (facts ? '<div class="sd-hint" style="margin-top:4px"><strong>Evidence:</strong><br/>' + facts + '</div>' : '') +
        missing + conflicts + risks +
        '<div class="sd-btn-row" style="margin-top:6px">' +
          '<button class="sd-btn primary fas-reply-approve" data-id="' + _esc(r.id) + '">Approve &amp; send</button>' +
          '<button class="sd-btn secondary fas-reply-reject" data-id="' + _esc(r.id) + '">Reject</button>' +
        '</div>' +
      '</div>';
    }).join('');
    list.querySelectorAll('.fas-reply-approve').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        btn.disabled = true; btn.textContent = 'Sending…';
        try {
          const res = await slackBridge.fasApproveReply(id);
          if (res && res.ok) toast.show('success', 'Reply sent (ts ' + (res.sent && res.sent.ts) + ')', 2500);
          else toast.show('error', 'Send failed: ' + ((res && res.error) || 'unknown'), 4000);
        } catch (e) { toast.show('error', 'Approve failed: ' + e.message, 4000); }
        _refreshReplyApprovals();
      });
    });
    list.querySelectorAll('.fas-reply-reject').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        try { await slackBridge.fasRejectReply(id); toast.show('success', 'Rejected (nothing sent)', 1500); } catch (e) { toast.show('error', e.message, 3000); }
        _refreshReplyApprovals();
      });
    });
  } catch (e) {
    list.innerHTML = '<div class="sd-hint" style="color:var(--err,#c0392b)">Failed to load: ' + _esc(e.message) + '</div>';
  }
}

async function _refreshApprovals() {
  const list = document.getElementById('fas-approval-list');
  if (!list) return;
  try {
    const rows = await slackBridge.fasGetApprovalQueue('pending');
    if (!rows || !rows.length) {
      list.innerHTML = '<div class="sd-hint">No actions awaiting approval.</div>';
      return;
    }
    list.innerHTML = rows.map((r) => {
      const args = _esc(JSON.stringify(r.args || {}).slice(0, 220));
      return '<div style="border:1px solid var(--bd,#333);border-radius:8px;padding:8px" data-id="' + _esc(r.id) + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
          '<span style="font-size:11px;font-weight:700">' + _esc(r.action) + ' <span style="opacity:.6;font-weight:400">(' + _esc(r.level) + ')</span></span>' +
          '<span style="font-size:9px;opacity:.6">' + _esc(r.requestedBy || '') + '</span>' +
        '</div>' +
        '<div class="sd-hint" style="margin:4px 0">' + args + '</div>' +
        '<div class="sd-btn-row">' +
          '<button class="sd-btn primary fas-approve" data-id="' + _esc(r.id) + '">Approve &amp; run</button>' +
          '<button class="sd-btn secondary fas-reject" data-id="' + _esc(r.id) + '">Reject</button>' +
        '</div>' +
      '</div>';
    }).join('');
    list.querySelectorAll('.fas-approve').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        btn.disabled = true; btn.textContent = 'Running…';
        try {
          const res = await slackBridge.fasApproveAction(id);
          if (res && res.ok) toast.show('success', 'Action done & verified', 2500);
          else toast.show('error', 'Action did not verify: ' + ((res && res.result && res.result.error) || 'unknown'), 4000);
        } catch (e) { toast.show('error', 'Approve failed: ' + e.message, 4000); }
        _refreshApprovals();
      });
    });
    list.querySelectorAll('.fas-reject').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        try { await slackBridge.fasRejectAction(id); toast.show('success', 'Rejected', 1500); } catch (e) { toast.show('error', e.message, 3000); }
        _refreshApprovals();
      });
    });
  } catch (e) {
    list.innerHTML = '<div class="sd-hint" style="color:var(--err,#c0392b)">Failed to load: ' + _esc(e.message) + '</div>';
  }
}

// ── Sender permissions (read-only view of the Contact Book) ──────────────────
// (The per-profile editor was removed in Part 1 — identity + permissions are
// edited on the Contact Book contact, the single source of truth. _refreshProfiles
// below renders a read-only Contact Book FAS view.)

async function _refreshProfiles() {
  const list = document.getElementById('fas-profile-list');
  if (!list) return;
  // PART 1: FAS Sender Profiles is now a FILTERED, READ-ONLY view of the Contact
  // Book. Identity + permissions are edited on the contact itself (single source
  // of truth), not in a separate profile store.
  // "Edit in Contact Book" — this view is READ-ONLY; all identity/scope/
  // permission edits happen in the Contact Book (single source of truth).
  const editBtnHtml = '<div style="margin-bottom:8px"><button class="sd-btn secondary" id="fas-edit-in-contact-book">Edit in Contact Book</button>' +
    '<span class="sd-hint" style="opacity:.6;margin-left:8px">Read-only summary. Identity, scope and permissions are set in the Contact Book.</span></div>';
  const wireEditBtn = () => {
    const b = document.getElementById('fas-edit-in-contact-book');
    if (b && !b._wired) { b._wired = true; b.addEventListener('click', () => bus.emit('ui:contacts-toggle')); }
  };
  try {
    const view = (window.contacts && window.contacts.getFasView) ? await window.contacts.getFasView() : [];
    if (!view || !view.length) { list.innerHTML = editBtnHtml + '<div class="sd-hint">No Slack-linked contacts yet. Add people in the Contact Book (with a Slack ID) and set their identity type + scope there.</div>'; wireEditBtn(); return; }
    list.innerHTML = editBtnHtml + view.map(p => {
      const disabled = p.enabled === false ? ' <span style="color:var(--err,#c0392b)">(disabled)</span>' : '';
      return '<div style="border-bottom:1px solid var(--bd,#333);padding:4px 0">' +
        '<div style="font-size:11px;font-weight:700">' + _esc(p.name || p.slackId) + ' — ' + _esc(p.identityType) + disabled + '</div>' +
        '<div class="sd-hint" style="opacity:.85">' + _esc(p.summary || '') + '</div>' +
        '<div class="sd-hint" style="opacity:.55;font-size:9px">Edit identity/scope/permissions in the Contact Book. Source: ' + _esc(p.permissionSource || 'contact-book') + '</div>' +
      '</div>';
    }).join('');
    wireEditBtn();
  } catch (e) { list.innerHTML = '<div class="sd-hint">Failed: ' + _esc(e.message) + '</div>'; }
}

// ── Knowledge drafts + playbook ──────────────────────────────────────────────
async function _refreshDrafts() {
  const list = document.getElementById('fas-drafts-list');
  if (!list) return;
  try {
    const rows = await slackBridge.fasGetKnowledgeDrafts('pending');
    if (!rows || !rows.length) { list.innerHTML = '<div class="sd-hint">No pending knowledge drafts.</div>'; return; }
    list.innerHTML = rows.map(r => '<div style="border:1px solid var(--bd,#333);border-radius:8px;padding:8px" data-id="' + _esc(r.id) + '">' +
      '<div style="font-size:11px;font-weight:700">' + _esc(r.topic || 'guidance') + '</div>' +
      '<div class="sd-hint" style="margin:4px 0">' + _esc((r.guidance||'').slice(0,300)) + '</div>' +
      '<div class="sd-btn-row"><button class="sd-btn primary kd-approve" data-id="' + _esc(r.id) + '">Approve into playbook</button>' +
      '<button class="sd-btn secondary kd-reject" data-id="' + _esc(r.id) + '">Reject</button></div></div>').join('');
    list.querySelectorAll('.kd-approve').forEach(b => b.addEventListener('click', async () => {
      try { await slackBridge.fasApproveKnowledgeDraft({ id: b.getAttribute('data-id') }); toast.show('success','Added to playbook',2000); _refreshDrafts(); _refreshPlaybook(); }
      catch(e){ toast.show('error', e.message, 3000); }
    }));
    list.querySelectorAll('.kd-reject').forEach(b => b.addEventListener('click', async () => {
      try { await slackBridge.fasRejectKnowledgeDraft(b.getAttribute('data-id')); _refreshDrafts(); } catch(e){ toast.show('error', e.message, 3000); }
    }));
  } catch (e) { list.innerHTML = '<div class="sd-hint">Failed: ' + _esc(e.message) + '</div>'; }
}

async function _refreshPlaybook() {
  const list = document.getElementById('fas-playbook-list');
  if (!list) return;
  try {
    const pb = await slackBridge.fasGetPlaybook();
    const secs = (pb && pb.sections) || [];
    list.innerHTML = secs.map(s => '<div class="sd-hint" style="border-bottom:1px solid var(--bd,#333);padding:3px 0"><strong>' + _esc(s.title) + '</strong>: ' + _esc((s.body||'').slice(0,240)) + '</div>').join('');
  } catch (e) { list.innerHTML = '<div class="sd-hint">Failed: ' + _esc(e.message) + '</div>'; }
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
  if (refreshBtn) refreshBtn.addEventListener('click', () => { _refreshAudit(); _refreshReplyApprovals(); _refreshFollowUps(); _refreshApprovals(); _refreshAutoActions(); _refreshDrafts(); _refreshProfiles(); });
  const migrateBtn = document.getElementById('fas-migrate-profiles');
  if (migrateBtn) migrateBtn.addEventListener('click', async () => {
    migrateBtn.disabled = true; migrateBtn.textContent = 'Migrating…';
    try {
      const res = (window.contacts && window.contacts.migrateSenderProfiles) ? await window.contacts.migrateSenderProfiles() : { error: 'unavailable' };
      if (res && !res.error) toast.show('success', 'Migrated: ' + (res.merged || 0) + ' merged, ' + (res.created || 0) + ' created', 3500);
      else toast.show('error', 'Migration failed: ' + (res && res.error), 4000);
    } catch (e) { toast.show('error', e.message, 4000); }
    migrateBtn.disabled = false; migrateBtn.textContent = 'Migrate legacy profiles → Contact Book';
    _refreshProfiles();
  });
  const autoReset = document.getElementById('fas-autoaction-reset');
  if (autoReset) autoReset.addEventListener('click', async () => {
    try { await slackBridge.fasSaveConfig({ approvedAutomaticActions: [] }); toast.show('success', 'Reset — all automatic actions off', 2000); }
    catch (e) { toast.show('error', e.message, 3000); }
    _refreshAutoActions();
  });
  _loadConfig();
  _refreshAudit();
  _refreshReplyApprovals();
  _refreshFollowUps();
  _refreshApprovals();
  _refreshAutoActions();
  _refreshProfiles();
  _refreshDrafts();
  _refreshPlaybook();
}

export { _refreshAudit as refreshFasAudit };
