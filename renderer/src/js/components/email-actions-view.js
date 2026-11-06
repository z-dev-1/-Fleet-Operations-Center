/**
 * email-actions-view.js — "My Email Actions" (Email Triage Intelligence Phase D, default OFF). Loaded with a
 * dynamic import() by the Inbox Triage overlay only when window.emailIntel.status() reports actionsView.
 *
 *   renderActionsHtml(state) -> string   pure (testable in node)
 *   renderAttachmentLabel(att) -> string pure; "Attachment analyzed" vs "Filename only" (prepared for Phase F)
 *   runOp(op, data, deps) -> Promise     one button action through window.emailIntel (no DOM)
 *   mount(container, deps)               thin DOM wiring: load, render, delegate clicks
 *
 * Layout (design 5.5, R4.10): the seven categories in a fixed order with counts; open items first by tier then age;
 * Recorded, Informational and Out of Scope are collapsed by default (count only). Each card shows unit chips, the
 * template-built reason and exact action, and text chips (Partial content, Injection-like text, Staged, Not threaded).
 * Accessibility (NFR-11): real <button> elements with aria-label, an aria-live status line, categories and tiers
 * conveyed by text (not color alone). Reply and Reply All are separate buttons; Reply All is disabled when the
 * recipients are unknown (R5.5). Nothing here approves, sends or deletes by itself: staged decisions go through
 * prepare-action / confirm-action (single-use token + native main-process dialog).
 */
import { esc, renderIdentityHtml, wireIdentityPanel, errorsFromResult } from './email-intel-panels.js';

export const CATEGORY_ORDER = Object.freeze(['reply', 'decision', 'followup', 'review', 'recorded', 'info', 'outofscope']);
export const CATEGORY_LABELS = Object.freeze({
  reply: 'Reply Needed', decision: 'Decision / Approval Needed', followup: 'Follow-Up Needed', review: 'Review Conflicting Information',
  recorded: 'Unit Update Recorded', info: 'Informational / No Action', outofscope: 'Out of Scope',
});
export const COLLAPSED_BY_DEFAULT = Object.freeze(['recorded', 'info', 'outofscope']);
const TIER_LABELS = { required: 'Required', suggested: 'Suggested', fyi: 'FYI' };
const STATE_LABELS = { snoozed: 'Snoozed', dismissed: 'Dismissed', 'done-user': 'Done', 'done-auto': 'Resolved', superseded: 'Superseded', expired: 'Expired' };
const TIER_RANK = { required: 0, suggested: 1, fyi: 2 };
const CHIPS = [['partial', 'Partial content'], ['injection', 'Injection-like text'], ['staged', 'Staged'], ['notThreaded', 'Not threaded'], ['probablyAnswered', 'Probably answered'], ['analysisFailed', 'Analysis failed']];

const _unitLabel = (units) => (units && units.length ? (units.length === 1 ? 'unit ' + units[0] : 'units ' + units.slice(0, 4).join(', ')) : 'this email');

/** Attachment label (R6.3, prepared for Phase F): analyzed content vs filename only; never facts from a name. */
export function renderAttachmentLabel(att) {
  const a = att || {};
  const st = a.analysis && a.analysis.status;
  const analyzed = st === 'content' || st === 'content-partial';
  const label = analyzed ? (st === 'content-partial' ? 'Attachment partly analyzed' : 'Attachment analyzed') : 'Filename only';
  return '<span class="ei-att"><span class="ei-att-name">' + esc(a.name || 'attachment') + '</span> <span class="ei-flag">' + label + '</span></span>';
}

function _sortItems(list) {
  return list.slice().sort((a, b) => ((a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1))
    || ((TIER_RANK[a.tier] || 0) - (TIER_RANK[b.tier] || 0))
    || String(b.firstSeenAt || '').localeCompare(String(a.firstSeenAt || '')));
}

function _btn(op, label, aria, data, extra) {
  const attrs = Object.entries(data || {}).map(([k, v]) => ' data-' + k + '="' + esc(v) + '"').join('');
  return '<button type="button" class="et-mini ei-op" data-op="' + esc(op) + '"' + attrs + ' aria-label="' + esc(aria) + '"' + (extra || '') + '>' + esc(label) + '</button>';
}

function _cardHtml(it, st) {
  const id = it.actionId;
  const about = _unitLabel(it.units);
  const units = (it.units || []).map((u) => '<span class="ei-unit">Unit ' + esc(u) + '</span>').join('');
  const chips = CHIPS.filter(([k]) => it.chips && it.chips[k]).map(([, l]) => '<span class="ei-flag">' + esc(l) + '</span>').join('');
  const stateLabel = it.state !== 'open' && STATE_LABELS[it.state]
    ? '<span class="ei-state">' + esc(STATE_LABELS[it.state]) + (it.state === 'snoozed' && it.snoozeUntil ? ' until ' + esc(String(it.snoozeUntil).slice(0, 16).replace('T', ' ')) : '') + '</span>' : '';
  const atts = (it.attachments || []).map(renderAttachmentLabel).join('');
  const btns = [];
  if (it.state === 'open' || it.state === 'snoozed') {
    if (it.category === 'reply') {
      btns.push(_btn('reply', 'Reply', 'Reply to the sender about ' + about, { id, mode: 'reply' }));
      const unknown = it.recipientsKnown === false;
      btns.push(_btn('reply', 'Reply All', 'Reply all about ' + about + (unknown ? ' (unavailable: recipients unknown)' : ''), { id, mode: 'reply-all' },
        unknown ? ' disabled aria-disabled="true" title="Recipients unknown"' : ''));
    }
    if (it.category === 'review' && (it.stagedIds || []).length) {
      const sid = it.stagedIds[0];
      if (it.hasFact) {
        btns.push(_btn('record', 'Record anyway', 'Record this update on ' + about + ' anyway', { id, staged: sid, reason: it.reasonCode || '' },
          st.timelineWrites ? '' : ' disabled aria-disabled="true" title="Timeline writes are off"'));
      }
      btns.push(_btn('reject', 'Reject', 'Reject this staged update for ' + about, { id, staged: sid }));
    }
    if (it.chips && it.chips.analysisFailed) btns.push(_btn('retry-analysis', 'Retry analysis', 'Retry the analysis of this email', { id }));
    btns.push(_btn('done', 'Done', 'Mark done: ' + (it.reasonText || about), { id }));
    btns.push(_btn('snooze', 'Snooze 1 day', 'Snooze for one day: ' + (it.reasonText || about), { id }));
    btns.push(_btn('dismiss', 'Dismiss', 'Dismiss: ' + (it.reasonText || about), { id }));
  } else {
    btns.push(_btn('reopen', 'Reopen', 'Reopen: ' + (it.reasonText || about), { id }));
  }
  return '<article class="ei-item ei-item--' + esc(it.tier || 'fyi') + '" data-action-id="' + esc(id) + '" aria-label="' + esc(CATEGORY_LABELS[it.category] || 'Item') + ': ' + esc(it.reasonText || '') + '">' +
    '<div class="ei-item-top"><span class="ei-tier">' + esc(TIER_LABELS[it.tier] || 'FYI') + '</span>' + units + chips + stateLabel + '</div>' +
    (it.subject ? '<div class="ei-subj">' + esc(it.subject) + '</div>' : '') +
    '<p class="ei-reason"><span class="ei-k">Why:</span> ' + esc(it.reasonText || '') + '</p>' +
    '<p class="ei-act"><span class="ei-k">Action:</span> ' + esc(it.actionText || '') + '</p>' +
    (it.evidenceQuote ? '<details class="ei-evidence"><summary>Quoted text from the email</summary><blockquote>' + esc(it.evidenceQuote) + '</blockquote></details>' : '') +
    (atts ? '<div class="ei-atts">' + atts + '</div>' : '') +
    '<div class="ei-item-btns">' + btns.join('') + '</div>' +
  '</article>';
}

/**
 * renderActionsHtml({ items, counts, expanded:{[category]:bool}, status, error, loading, timelineWrites, identityOpen, identity })
 */
export function renderActionsHtml(state) {
  const st = state || {};
  const items = Array.isArray(st.items) ? st.items : [];
  const counts = st.counts || {};
  const expanded = st.expanded || {};
  const sections = CATEGORY_ORDER.map((cat) => {
    const list = _sortItems(items.filter((x) => x.category === cat));
    const n = Number.isFinite(counts[cat]) ? counts[cat] : list.filter((x) => x.state === 'open').length;
    const collapsed = COLLAPSED_BY_DEFAULT.includes(cat) ? !expanded[cat] : expanded[cat] === false;
    const bodyId = 'ei-cat-body-' + cat;
    return '<section class="ei-cat ei-cat--' + cat + '" data-category="' + cat + '" aria-labelledby="ei-cat-' + cat + '">' +
      '<h3 class="ei-cat-title" id="ei-cat-' + cat + '">' +
        '<button type="button" class="ei-cat-toggle" data-op="toggle" data-category="' + cat + '" aria-expanded="' + (collapsed ? 'false' : 'true') + '" aria-controls="' + bodyId + '">' +
        esc(CATEGORY_LABELS[cat]) + ' (' + n + ')</button></h3>' +
      (collapsed ? '' : '<div class="ei-cat-body" id="' + bodyId + '">' + (list.length ? list.map((it) => _cardHtml(it, st)).join('') : '<p class="ei-empty">Nothing here.</p>') + '</div>') +
    '</section>';
  }).join('');
  const settings = '<div class="ei-act-settings">' +
    '<button type="button" class="et-mini" data-op="identity" id="ei-act-identity" aria-expanded="' + (st.identityOpen ? 'true' : 'false') + '" aria-controls="ei-act-identity-panel">My identity</button>' +
    '<button type="button" class="et-mini" data-op="refresh" aria-label="Refresh My Email Actions">Refresh</button>' +
    '<div id="ei-act-identity-panel">' + (st.identityOpen && st.identity ? renderIdentityHtml(st.identity) : '') + '</div></div>';
  return '<section class="ei-actions" aria-labelledby="ei-act-title">' +
    '<h2 class="ei-act-title" id="ei-act-title">My Email Actions</h2>' + settings +
    '<div class="ei-live" id="ei-act-live" role="status" aria-live="polite">' + esc(st.loading ? 'Loading...' : (st.error || st.status || '')) + '</div>' +
    sections + '</section>';
}

function _stamp(ms) { return new Date(ms).toISOString(); }

/**
 * runOp(op, data, deps) -> { ok, message, reload }
 * deps: { api (window.emailIntel), confirmFn(text) -> bool (in-app confirm), onReply(item, mode), now() }
 */
export async function runOp(op, data, deps) {
  const d = deps || {};
  const api = d.api || {};
  const id = data && data.id;
  const now = typeof d.now === 'function' ? d.now() : Date.now();
  if (op === 'dismiss' || op === 'done' || op === 'reopen' || op === 'retry-analysis' || op === 'snooze') {
    const payload = { actionId: id, op };
    if (op === 'snooze') payload.snoozeUntil = _stamp(now + 86_400_000);
    const r = await api.actionUpdate(payload);
    const msg = r && r.ok ? ({ dismiss: 'Dismissed.', done: 'Marked done.', reopen: 'Reopened.', snooze: 'Snoozed for one day.', 'retry-analysis': 'Analysis will run on the next scan.' })[op]
      : 'Not updated: ' + ((r && (r.code || r.error)) || 'unknown');
    return { ok: !!(r && r.ok), message: msg, reload: true };
  }
  if (op === 'record' || op === 'reject') {
    const kind = op === 'record' ? 'approve-staged' : 'reject-staged';
    const payload = { stagedId: data.staged };
    if (op === 'record' && data.reason === 'conflict-ready') payload.acknowledgeConflictReady = true;
    const prep = await api.prepareAction(kind, payload);
    if (!prep || !prep.ok) return { ok: false, message: 'Not available: ' + ((prep && (prep.code || prep.error)) || 'unknown'), reload: false };
    const text = prep.summary ? prep.summary.headline + '\n\n' + (prep.summary.detailText || '') : 'Continue?';
    if (typeof d.confirmFn === 'function' && !d.confirmFn(text)) return { ok: false, message: 'Cancelled.', reload: false };
    const r = await api.confirmAction(prep.token);
    if (r && r.ok) return { ok: true, message: op === 'record' ? 'Recorded on the timeline.' : 'Rejected.', reload: true };
    return { ok: false, message: r && r.code === 'USER_CANCELLED' ? 'Cancelled.' : 'Not done: ' + ((r && (r.code || r.error)) || 'unknown'), reload: true };
  }
  if (op === 'reply') {
    if (typeof d.onReply === 'function') d.onReply(data, data.mode === 'reply-all' ? 'reply-all' : 'reply');
    return { ok: true, message: '', reload: false };
  }
  return { ok: false, message: '', reload: false };
}

/** mount(container, { api, toast(msg), confirmFn, onReply(data, mode), document }) -> { reload } */
export function mount(container, deps) {
  const d = deps || {};
  const doc = d.document || (typeof document !== 'undefined' ? document : null);
  const st = { items: [], counts: {}, expanded: {}, status: '', loading: true, timelineWrites: false, identityOpen: false, identity: null };
  const render = () => {
    container.innerHTML = renderActionsHtml(st);
    if (st.identityOpen && st.identity && doc) {
      wireIdentityPanel(doc, {
        setConfig: (patch) => d.api.setConfig(patch),
        onSaved: (r) => { st.identity = { me: r.config.me, suggestions: st.identity.suggestions, errors: {} }; st.status = 'Identity saved.'; render(); },
        onError: (r) => { st.identity = Object.assign({}, st.identity, { errors: errorsFromResult(r) }); render(); },
        onClose: () => { st.identityOpen = false; render(); },
      });
    }
  };
  const load = async () => {
    st.loading = true; render();
    try {
      const r = await d.api.getActions({ includeClosed: false, limit: 200 });
      if (r && r.ok) { st.items = r.items || []; st.counts = r.counts || {}; st.timelineWrites = !!r.timelineWrites; st.error = ''; }
      else st.error = 'My Email Actions is not available.';
    } catch (_) { st.error = 'Could not load My Email Actions.'; }
    st.loading = false; render();
  };
  container.addEventListener('click', async (ev) => {
    const btn = ev && ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('button[data-op]') : null;
    if (!btn || btn.disabled) return;
    const op = btn.getAttribute('data-op');
    if (op === 'toggle') {
      const cat = btn.getAttribute('data-category');
      const wasCollapsed = btn.getAttribute('aria-expanded') !== 'true';
      st.expanded[cat] = wasCollapsed;               // expand a collapsed section, collapse an open one
      render();
      return;
    }
    if (op === 'refresh') { await load(); return; }
    if (op === 'identity') {
      st.identityOpen = !st.identityOpen;
      if (st.identityOpen) {
        try { const c = await d.api.getConfig(); st.identity = { me: (c && c.config && c.config.me) || {}, suggestions: (c && c.suggestions) || {}, errors: {} }; } catch (_) { st.identity = { me: {}, suggestions: {}, errors: {} }; }
      }
      render();
      return;
    }
    const data = { id: btn.getAttribute('data-id'), mode: btn.getAttribute('data-mode'), staged: btn.getAttribute('data-staged'), reason: btn.getAttribute('data-reason') };
    btn.disabled = true;
    let r;
    try { r = await runOp(op, data, d); } catch (_) { r = { ok: false, message: 'Something went wrong.', reload: true }; }
    st.status = r.message || '';
    if (r.message && typeof d.toast === 'function') d.toast(r.message);
    if (r.reload) await load(); else { btn.disabled = false; render(); }
  });
  load();
  return { reload: load };
}

export const ACTIONS_CSS = `
  #email-triage .ei-tabs { display:flex; gap:6px; padding:8px 18px 0; }
  #email-triage .ei-tab { background:#21262d; border:1px solid #30363d; color:#c9d1d9; border-radius:6px 6px 0 0; padding:6px 12px; font-size:12px; cursor:pointer; }
  #email-triage .ei-tab[aria-selected="true"] { background:#0d1117; border-bottom-color:#0d1117; color:#e6edf3; font-weight:600; }
  #email-triage .ei-actions { padding:10px 18px; font-size:12px; color:#c9d1d9; overflow:auto; }
  #email-triage .ei-act-title { font-size:14px; margin:0 0 6px; color:#e6edf3; }
  #email-triage .ei-act-settings { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:6px; }
  #email-triage .ei-cat { margin:8px 0; }
  #email-triage .ei-cat-title { margin:0; font-size:13px; }
  #email-triage .ei-cat-toggle { background:transparent; border:0; color:#e6edf3; font-weight:600; cursor:pointer; padding:4px 0; }
  #email-triage .ei-item { border:1px solid #30363d; border-radius:8px; padding:8px 10px; margin:6px 0; background:#0d1117; }
  #email-triage .ei-item--required { border-left:3px solid #f85149; }
  #email-triage .ei-item--suggested { border-left:3px solid #d29922; }
  #email-triage .ei-item-top { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  #email-triage .ei-tier, #email-triage .ei-state { font-size:10px; font-weight:700; text-transform:uppercase; }
  #email-triage .ei-unit, #email-triage .ei-flag { font-size:10px; background:#21262d; border:1px solid #30363d; border-radius:10px; padding:1px 7px; }
  #email-triage .ei-subj { color:#e6edf3; margin-top:4px; }
  #email-triage .ei-reason, #email-triage .ei-act { margin:3px 0; }
  #email-triage .ei-k { color:#8b949e; }
  #email-triage .ei-item-btns { display:flex; gap:6px; flex-wrap:wrap; margin-top:6px; }
  #email-triage .ei-evidence blockquote { margin:4px 0; padding-left:8px; border-left:2px solid #30363d; color:#8b949e; }
`;
