// renderer/src/js/views/dtna-stage-actions.js — unit detail "⇢ Change Stage": move the unit's DTNA
// Service Tracker case FORWARD to a later stage (Closed = truck picked up). VISIBLE TO THE DEALER.
//
// The picker lists only stages after the case's current one (window.dtna.stageOptions, cache only).
// "Submit for approval" closes this modal and calls window.dtna.changeStage -> dtna:change-stage ->
// write gate, which ALWAYS shows the approval modal with the exact from -> to change. Nothing auto-sends.
import modalDefault from '../components/modal.js';
import { outcomeMessage } from './relay-actions.js';
import { dtnaCaseIdOf } from './dtna-actions.js';

function escAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The Offsite Event card button; '' unless the offsite URL is a DTNA case. */
export function dtnaStageButtonHtml(unit, offsiteUrl) {
  const id = String((unit && unit.equipmentId) == null ? '' : unit.equipmentId).trim();
  const caseId = dtnaCaseIdOf(offsiteUrl);
  if (!id || !caseId) return '';
  return '<button type="button" class="dp-dtna-pull-btn" data-dtna-stage="' + escAttr(id) + '" data-dtna-case="' + escAttr(caseId) + '"' +
    ' title="Move this DTNA case to a later stage (visible to the dealer; you approve first)">\u21e2 Change Stage</button>';
}

function _label(stage) { return stage === 'Closed' ? 'Closed (truck picked up)' : stage; }

const NOTE_NOT_CONFIGURED = 'Stage changes are not set up yet. Nothing can be sent.';
const NOTE_LAST_STAGE = 'This case is already at its last stage.';

/** dtnaStageModalBody({ current, targets, configured }) — forward-only picker (targets only). */
export function dtnaStageModalBody(opts) {
  const o = opts || {};
  const current = String(o.current || '');
  const targets = Array.isArray(o.targets) ? o.targets.map(String) : [];
  const first = targets[0] || '';
  const note = !o.configured ? NOTE_NOT_CONFIGURED : (!targets.length ? NOTE_LAST_STAGE : '');
  return '<div class="ra-modal ra-modal--stage">' +
    '<p class="ra-hint" role="note"><strong>Visible to the dealer (DTNA Service Tracker).</strong> Forward only. Nothing is sent until you approve.</p>' +
    '<div class="dp-escalate__row">Current stage: <b id="dtna-st-current">' + escAttr(current || '-') + '</b></div>' +
    '<div class="dp-escalate__row"><label for="dtna-st-target">Move to</label> ' +
      '<select id="dtna-st-target" aria-label="New DTNA stage"' + (targets.length ? '' : ' disabled') + '>' +
      targets.map((t) => '<option value="' + escAttr(t) + '">' + escAttr(_label(t)) + '</option>').join('') +
      '</select></div>' +
    '<div class="dp-escalate__row" id="dtna-st-change">' + (first ? escAttr(current) + ' \u2192 ' + escAttr(first) : '') + '</div>' +
    '<div class="dp-escalate__row ra-hint" id="dtna-st-note">' + escAttr(note) + '</div>' +
  '</div>';
}

function _deps(deps) {
  const d = deps || {};
  const w = typeof window !== 'undefined' ? window : {};
  return {
    modal: d.modal || modalDefault,
    bridge: d.bridge || w.dtna || null,
    confirm: d.confirm || ((m) => (typeof w.confirm === 'function' ? w.confirm(m) : false)),
    toast: d.toast || { show() {} },
  };
}

/** stageMessage(r, caseId) -> { level, text } for a dtna:stage-options / dtna:change-stage result. */
export function stageMessage(r, caseId) {
  const tag = String(caseId || '').slice(-6);
  const code = r && r.code;
  if (r && r.outcome === 'sent') {
    if (r.confirmed) return { level: 'success', text: 'DTNA case \u2026' + tag + ' moved to ' + String(r.toStage || '') + '.' };
    return { level: 'warn', text: 'Stage change sent, but DTNA shows ' + (String(r.currentStage || '') || 'an unknown stage') + '. Open the case in DTNA to check.' };
  }
  if (code === 'DTNA_STAGE_NOT_CONFIGURED') return { level: 'warn', text: 'Changing the DTNA stage is not set up yet. Nothing was sent.' };
  if (code === 'DTNA_STAGE_NOT_FORWARD') return { level: 'warn', text: 'DTNA now shows ' + (String((r && r.currentStage) || '') || 'a later stage') + '; only a later stage can be chosen. Nothing was sent.' };
  if (code === 'DTNA_STAGE_REJECTED') return { level: 'error', text: 'DTNA did not accept the stage change. Pull DTNA to check the case before trying again.' };
  if (code === 'DTNA_NOT_PULLED') return { level: 'warn', text: 'Pull DTNA for this unit first.' };
  if (code === 'DTNA_STAGE_UNKNOWN') return { level: 'warn', text: 'The DTNA case stage is unknown. Pull DTNA for this unit, then try again.' };
  if (code === 'DTNA_BUSY') return { level: 'warn', text: 'A stage change for this case is already running.' };
  if (code === 'DTNA_SESSION_LOW') return { level: 'warn', text: 'Your DTNA session is about to expire. Sign in again, then change the stage. Nothing was sent.' };
  return outcomeMessage(r, 'DTNA stage change');
}

const SESSION_LOW_ASK = 'Your DTNA session expires in under 2 minutes (or has expired). Sign in again now?';

/** openDtnaStageModal(unit, { caseId }, { modal, toast, bridge, confirm }) */
export async function openDtnaStageModal(unit, caseCtx, deps) {
  const d = _deps(deps);
  const u = unit || {};
  const equipmentId = String(u.equipmentId == null ? '' : u.equipmentId).trim();
  const caseId = String((caseCtx && caseCtx.caseId) || '');
  if (!d.bridge || typeof d.bridge.stageOptions !== 'function' || typeof d.bridge.changeStage !== 'function') {
    d.toast.show('warn', 'DTNA is not available in this build');
    return;
  }
  let opt;
  try { opt = await d.bridge.stageOptions({ equipmentId, caseId }); } catch (_) { opt = { ok: false, code: 'DTNA_INTERNAL' }; }
  if (!opt || !opt.ok) { const m = stageMessage(opt, caseId); d.toast.show(m.level, m.text); return; }
  const current = String(opt.current || '');
  const targets = Array.isArray(opt.targets) ? opt.targets.map(String) : [];
  const canSubmit = !!opt.configured && targets.length > 0;
  let q = () => null;
  let sending = false;

  const selected = () => {
    const s = q('#dtna-st-target');
    const v = s ? String(s.value || '') : '';
    return targets.includes(v) ? v : (targets[0] || '');
  };

  async function submit() {
    if (sending) return;
    if (!canSubmit) {
      d.toast.show('warn', !opt.configured ? NOTE_NOT_CONFIGURED : NOTE_LAST_STAGE);
      return;
    }
    const target = selected();
    if (!target) return;
    sending = true;
    d.modal.close();
    d.toast.show('info', 'Waiting for your approval\u2026', 3000);
    let r;
    try { r = await d.bridge.changeStage({ equipmentId, caseId, target }); } catch (_) { r = { ok: false, code: 'DTNA_INTERNAL' }; }
    if (r && r.code === 'DTNA_SESSION_LOW') {
      if (d.confirm(SESSION_LOW_ASK) && typeof d.bridge.login === 'function') {
        try { await d.bridge.login(); } catch (_) { /* the sign-in window reports its own state */ }
        return;
      }
    }
    const o = stageMessage(r, caseId);
    d.toast.show(o.level, o.text);
  }

  d.modal.show({
    title: 'Change DTNA stage \u2014 case \u2026' + caseId.slice(-6),
    width: 520,
    body: dtnaStageModalBody({ current, targets, configured: !!opt.configured }),
    actions: [
      { label: 'Cancel', cls: '', onClick: () => d.modal.close() },
      { label: 'Submit for approval', cls: 'primary', onClick: () => submit() },
    ],
    onMount(panel) {
      q = (s) => (panel && panel.querySelector ? panel.querySelector(s) : null);
      const btn = q('[data-modal-action="1"]');
      if (btn && !canSubmit) { btn.disabled = true; try { btn.setAttribute('aria-disabled', 'true'); } catch (_) {} }
      const sel = q('#dtna-st-target');
      const ch = q('#dtna-st-change');
      if (sel) sel.addEventListener('change', () => { if (ch) ch.textContent = current + ' \u2192 ' + selected(); });
    },
  });
}
