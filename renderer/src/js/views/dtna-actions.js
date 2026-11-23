// renderer/src/js/views/dtna-actions.js — unit detail "💬 Post to DTNA": compose a comment on the
// unit's DTNA Service Tracker case. The comment is VISIBLE TO THE DEALER.
//
// Trimmed copy of relay-actions.js openCommentModal. "AI draft" only fills the textarea
// (window.dtna.draftComment, text only). The channel row shows where the post goes:
// window.dtna.channels picks Chatter (case feed) when external communication is on for the
// case and Chatter posting is set up, else the case comment; the user may pick the other
// one when both are available. Send closes this modal and calls window.dtna.postChatter
// (dtna:post-chatter) or window.dtna.postComment (dtna:post-comment) -> write gate, which
// ALWAYS shows the approval modal with the exact text and the channel. Nothing auto-sends.
import modalDefault from '../components/modal.js';
import { outcomeMessage } from './relay-actions.js';

export const DTNA_COMMENT_MAX = 2000;
const DTNA_CASE_RE = /^https:\/\/dtna\.my\.site\.com\/Servicetracker\/s\/case\/(500[A-Za-z0-9]{15})(?:[/?#]|$)/;

function escAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** dtnaCaseIdOf(url) -> the DTNA case id of a case URL | ''. */
export function dtnaCaseIdOf(url) {
  const m = DTNA_CASE_RE.exec(String(url || '').trim());
  return m ? m[1] : '';
}

/** The Offsite Event card button; '' unless the offsite URL is a DTNA case. */
export function dtnaPostButtonHtml(unit, offsiteUrl) {
  const id = String((unit && unit.equipmentId) == null ? '' : unit.equipmentId).trim();
  const caseId = dtnaCaseIdOf(offsiteUrl);
  if (!id || !caseId) return '';
  return '<button type="button" class="dp-dtna-pull-btn" data-dtna-post="' + escAttr(id) + '" data-dtna-case="' + escAttr(caseId) + '"' +
    ' title="Write a comment on this DTNA case (visible to the dealer; you approve the exact text first)">\uD83D\uDCAC Post to DTNA</button>';
}

// Why a channel cannot be used (dtna:channels reason codes).
const CHANNEL_REASON = {
  DTNA_CHATTER_NOT_CONFIGURED: 'Chatter posting is not set up yet.',
  DTNA_CHATTER_DISABLED: 'External communication is off for this case.',
  DTNA_CHATTER_UNKNOWN: 'Could not check whether Chatter is on for this case.',
  DTNA_POST_NOT_CONFIGURED: 'Case comments are not set up yet.',
  DTNA_NO_REPAIR_ORDER: 'This case has no repair order.',
  DTNA_NOT_PULLED: 'Pull DTNA for this unit first.',
};
const CHANNEL_LABEL = { chatter: 'Chatter (case feed)', comment: 'Case comment' };

/** channelReasonText(code) -> plain text for a channel reason code ('' for none). */
export function channelReasonText(code) {
  if (!code) return '';
  return CHANNEL_REASON[code] || 'Unavailable (' + String(code).replace(/[^A-Z0-9_]/g, '').slice(0, 40) + ').';
}

export function dtnaCommentModalBody() {
  return '<div class="ra-modal ra-modal--cm">' +
    '<p class="ra-hint" role="note"><strong>Visible to the dealer (DTNA Service Tracker).</strong> Nothing is sent until you approve the exact text.</p>' +
    '<div class="dp-escalate__row" role="radiogroup" aria-label="Post channel">' +
      '<label><input type="radio" name="dtna-ch" id="dtna-ch-chatter" value="chatter" disabled> ' + CHANNEL_LABEL.chatter + '</label>' +
      ' <span id="dtna-ch-chatter-why" class="ra-hint">Checking\u2026</span>' +
      ' <label><input type="radio" name="dtna-ch" id="dtna-ch-comment" value="comment" checked> ' + CHANNEL_LABEL.comment + '</label>' +
      ' <span id="dtna-ch-comment-why" class="ra-hint"></span>' +
    '</div>' +
    '<p id="dtna-ch-note" class="ra-hint">Will post to: ' + CHANNEL_LABEL.comment + '</p>' +
    '<textarea id="dtna-cm-text" class="dp-escalate__comment" maxlength="' + DTNA_COMMENT_MAX + '" rows="7" aria-label="DTNA case comment" placeholder="Message to the repair facility"></textarea>' +
    '<div class="dp-escalate__row"><button type="button" id="dtna-cm-draft" class="dp-escalate__btn dp-ra-btn">AI draft</button>' +
      // Attachments are a fast-follow: wired placeholder, disabled until the upload path ships (files: [] today).
      '<button type="button" id="dtna-cm-attach" class="dp-escalate__btn dp-ra-btn" disabled aria-disabled="true"' +
        ' title="Attaching files to DTNA comments is coming soon">\uD83D\uDCCE Attach file (coming soon)</button>' +
      '<span id="dtna-cm-count" class="dp-escalate__count">0/' + DTNA_COMMENT_MAX + '</span></div>' +
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

function _draftErr(r) {
  const c = String((r && r.code) || 'unknown');
  if (c === 'DTNA_NOT_PULLED') return 'Pull DTNA for this unit first.';
  if (c === 'DTNA_BUSY') return 'An AI draft for this case is already running.';
  if (c === 'DTNA_CASE_MISMATCH') return 'AI draft unavailable: the DTNA case does not match this unit.';
  return 'AI draft failed: ' + c;
}

/** postMessage(r, caseId, channel) -> { level, text } for the dtna:post-comment / dtna:post-chatter result. */
export function postMessage(r, caseId, channel) {
  const tag = String(caseId || '').slice(-6);
  const code = r && r.code;
  if (r && r.outcome === 'sent' && channel === 'chatter') return { level: 'success', text: 'Posted to the DTNA case Chatter feed \u2026' + tag + '.' };
  if (r && r.outcome === 'sent') return { level: 'success', text: 'Comment posted to DTNA case \u2026' + tag + '. Pull DTNA to see it in the thread.' };
  if (code === 'DTNA_CHATTER_NOT_CONFIGURED') return { level: 'warn', text: 'Posting to the DTNA Chatter feed is not set up yet. Nothing was sent.' };
  if (code === 'DTNA_CHATTER_DISABLED') return { level: 'warn', text: 'External communication is off for this DTNA case, so Chatter is unavailable. Post a case comment instead. Nothing was sent.' };
  if (code === 'DTNA_CHATTER_REJECTED') return { level: 'error', text: 'DTNA did not accept the Chatter post. Check the case feed before trying again.' };
  if (code === 'DTNA_POST_NOT_CONFIGURED') return { level: 'warn', text: 'Posting to DTNA is not set up yet. Nothing was sent.' };
  if (code === 'DTNA_POST_REJECTED') return { level: 'error', text: 'DTNA did not accept the comment (message not sent to the repair facility). Pull DTNA to check the thread before trying again.' };
  if (code === 'DTNA_NOT_PULLED') return { level: 'warn', text: 'Pull DTNA for this unit first.' };
  if (code === 'DTNA_NO_REPAIR_ORDER') return { level: 'warn', text: 'This DTNA case has no repair order; the portal does not accept comments on it.' };
  if (code === 'DTNA_SESSION_LOW') return { level: 'warn', text: 'Your DTNA session is about to expire. Sign in again, then send. Nothing was sent.' };
  return outcomeMessage(r, 'DTNA comment');
}

/** openDtnaCommentModal(unit, { caseId }, { modal, toast, bridge, confirm }) */
export function openDtnaCommentModal(unit, caseCtx, deps) {
  const d = _deps(deps);
  const u = unit || {};
  const equipmentId = String(u.equipmentId == null ? '' : u.equipmentId).trim();
  const caseId = String((caseCtx && caseCtx.caseId) || '');
  let q = () => null;
  let aiDrafted = false;
  let drafting = false;
  let sending = false;
  // The channel the send goes to: the dtna:channels auto choice, or the user's pick. Default (no probe,
  // probe failed) = the case comment, as before Chatter existed.
  let channel = 'comment';
  let channelsP = null; // the pending dtna:channels probe, if any

  const radio = (c) => q(c === 'chatter' ? '#dtna-ch-chatter' : '#dtna-ch-comment');
  const note = () => { const n = q('#dtna-ch-note'); if (n) n.textContent = 'Will post to: ' + CHANNEL_LABEL[channel]; };
  const pick = (c) => {
    channel = c;
    const a = radio('chatter');
    const b = radio('comment');
    if (a) a.checked = c === 'chatter';
    if (b) b.checked = c === 'comment';
    note();
  };
  function applyChannels(r) {
    const why = (c, text) => { const w = q('#dtna-ch-' + c + '-why'); if (w) w.textContent = text; };
    if (!r || !r.ok) {
      const a = radio('chatter');
      if (a) a.disabled = true;
      why('chatter', 'Could not check the Chatter channel; posting as a case comment.');
      pick('comment');
      return;
    }
    const chat = r.chatter || {};
    const com = r.comment || {};
    const a = radio('chatter');
    const b = radio('comment');
    if (a) a.disabled = !chat.available;
    // Neither available: keep the case comment selectable (the send reports why, as before).
    if (b) b.disabled = !com.available && !!chat.available;
    why('chatter', chat.available ? '' : channelReasonText(chat.reason));
    why('comment', com.available ? '' : channelReasonText(com.reason));
    pick(r.auto === 'chatter' && chat.available ? 'chatter' : 'comment');
  }

  const count = () => {
    const ta = q('#dtna-cm-text');
    const c = q('#dtna-cm-count');
    if (ta && c) c.textContent = String(ta.value || '').length + '/' + DTNA_COMMENT_MAX;
  };

  async function draft() {
    const ta = q('#dtna-cm-text');
    const btn = q('#dtna-cm-draft');
    if (drafting) return;
    if (!d.bridge || typeof d.bridge.draftComment !== 'function') { d.toast.show('error', 'AI draft failed: DTNA bridge unavailable.'); return; }
    if (ta && String(ta.value || '').trim() && !d.confirm('Replace the comment text with an AI draft?')) return;
    const before = ta ? ta.value : '';
    drafting = true;
    if (btn) btn.disabled = true;
    let r;
    try { r = await d.bridge.draftComment({ equipmentId, caseId }); } catch (_) { r = { ok: false, code: 'unknown' }; }
    finally { drafting = false; if (btn) btn.disabled = false; }
    if (!r || !r.ok) { d.toast.show('error', _draftErr(r)); return; }
    if (r.noUpdate || !String(r.draft || '').trim()) { d.toast.show('info', 'AI found nothing new to ask the dealer.'); return; }
    if (ta && ta.value !== before && String(ta.value || '').trim() && !d.confirm('Replace the comment text with an AI draft?')) {
      d.toast.show('info', 'AI draft ready, kept your text. Click AI draft to replace it.');
      return;
    }
    if (ta) ta.value = String(r.draft).slice(0, DTNA_COMMENT_MAX);
    aiDrafted = true;
    count();
    d.toast.show('info', 'AI draft inserted. Review it before you send; the dealer will see it.');
  }

  async function submit() {
    const ta = q('#dtna-cm-text');
    const text = String((ta && ta.value) || '').trim();
    if (!text) { d.toast.show('warn', 'Write a comment first.'); return; }
    if (text.length > DTNA_COMMENT_MAX) { d.toast.show('warn', 'Comment must be ' + DTNA_COMMENT_MAX + ' characters or fewer.'); return; }
    if (sending) return;
    if (!d.bridge || typeof d.bridge.postComment !== 'function') { d.toast.show('warn', 'DTNA is not available in this build'); return; }
    sending = true;
    d.modal.close();
    d.toast.show('info', 'Waiting for your approval\u2026', 3000);
    // A send before the channel probe answered waits for it, so the auto choice is used.
    if (channelsP) { try { await channelsP; } catch (_) { /* applyChannels already fell back */ } }
    const ch = channel === 'chatter' && typeof d.bridge.postChatter === 'function' ? 'chatter' : 'comment';
    let r;
    try {
      r = ch === 'chatter'
        ? await d.bridge.postChatter({ equipmentId, caseId, text, aiDrafted })
        : await d.bridge.postComment({ equipmentId, caseId, text, aiDrafted });
    } catch (_) { r = { ok: false, code: 'DTNA_INTERNAL' }; }
    const o = postMessage(r, caseId, ch);
    d.toast.show(o.level, o.text);
    if (r && r.code === 'DTNA_SESSION_LOW' && typeof d.bridge.login === 'function' && d.confirm('Sign in to DTNA again now?')) {
      try { await d.bridge.login(); } catch (_) { /* the sign-in window reports its own state */ }
    }
  }

  d.modal.show({
    title: 'Post to DTNA \u2014 case \u2026' + caseId.slice(-6),
    width: 560,
    body: dtnaCommentModalBody(),
    actions: [
      { label: 'Cancel', cls: '', onClick: () => d.modal.close() },
      { label: 'Send to DTNA', cls: 'primary', onClick: () => submit() },
    ],
    onMount(panel) {
      q = (s) => (panel && panel.querySelector ? panel.querySelector(s) : null);
      const ta = q('#dtna-cm-text');
      if (ta) ta.addEventListener('input', () => { count(); if (!String(ta.value || '').trim()) aiDrafted = false; });
      const db = q('#dtna-cm-draft');
      if (db) db.addEventListener('click', () => draft());
      for (const c of ['chatter', 'comment']) {
        const rb = radio(c);
        if (rb) rb.addEventListener('change', () => { if (!rb.disabled) pick(c); });
      }
      if (d.bridge && typeof d.bridge.channels === 'function') {
        channelsP = Promise.resolve()
          .then(() => d.bridge.channels({ equipmentId, caseId }))
          .then((r) => applyChannels(r), () => applyChannels(null))
          .finally(() => { channelsP = null; });
      } else {
        applyChannels(null);
      }
    },
  });
}
