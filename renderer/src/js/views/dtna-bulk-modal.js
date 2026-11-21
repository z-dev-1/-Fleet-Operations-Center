/**
 * dtna-bulk-modal.js — Fleet "DTNA Pull" bulk tool (opened from the Fleet meta
 * bar #fleet-dtna-pull, or "Pull open cases" in the DTNA panel).
 *
 * Opening the modal reads dtna.status() only. Pulling starts only on Start;
 * progress events are filtered by the jobId Start returned; Save buttons write
 * a TSV / Excel file to Downloads through dtna.exportBulk once the job is
 * finished. Subscriptions are dropped when the modal closes.
 */
import bus from '../bus.js';
import modal from '../components/modal.js';
import { dtnaPill } from '../components/status-bar-logic.js';

const _dtna = () => (typeof window !== 'undefined' && window.dtna) || null;

/** "done / total · N failed" for a dtna:progress payload. */
export function progressText(p) {
  const n = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const q = p || {};
  return n(q.done) + ' / ' + n(q.total) + ' \u00b7 ' + n(q.failed) + ' failed';
}

const BODY =
  '<div class="dtna-bulk">' +
    '<div style="margin-bottom:8px">Status: <b id="dtna-bulk-state">DTNA \u2026</b> ' +
      '<button type="button" class="btn" id="dtna-bulk-signin">Sign in</button></div>' +
    '<div style="margin-bottom:8px">Reads every open case in your DTNA Service Tracker list. Nothing runs until you press Start.</div>' +
    '<label style="display:block;margin-bottom:8px"><input type="checkbox" id="dtna-bulk-comments" checked> Include comments</label>' +
    '<div style="display:flex;gap:8px;margin-bottom:8px">' +
      '<button type="button" class="btn primary" id="dtna-bulk-start">Start</button>' +
      '<button type="button" class="btn" id="dtna-bulk-cancel" disabled>Cancel</button>' +
    '</div>' +
    '<progress id="dtna-bulk-progress" max="1" value="0" style="width:100%"></progress>' +
    '<div id="dtna-bulk-progress-text">0 / 0 \u00b7 0 failed</div>' +
    '<div id="dtna-bulk-msg" style="margin:6px 0"></div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button type="button" class="btn" id="dtna-bulk-save-tsv" disabled>Save TSV</button>' +
      '<button type="button" class="btn" id="dtna-bulk-save-xls" disabled>Save Excel</button>' +
      '<button type="button" class="btn" id="dtna-bulk-save-comments" disabled hidden>Save comments TSV</button>' +
    '</div>' +
  '</div>';

const MESSAGES = {
  DTNA_SIGNIN_REQUIRED: 'DTNA sign-in needed. Press Sign in, then Start again.',
  DTNA_SESSION_EXPIRED: 'DTNA session expired. Press Sign in, then Start again.',
  DTNA_BUSY: 'A DTNA pull is already running.',
  DTNA_NETWORK: 'Could not reach DTNA.',
};
const _msgFor = (code) => MESSAGES[code] || ('DTNA pull failed (' + String(code || 'unknown') + ')');

export function openDtnaBulkModal(deps) {
  const d = deps || {};
  const dt = d.dtna !== undefined ? d.dtna : _dtna();
  const m = d.modal || modal;
  const b = d.bus || bus;
  const toast = (type, message, duration) => { try { b.emit('ui:toast', { type, message, duration }); } catch (_) {} };

  let root = null;
  let jobId = null;
  let running = false;
  let finished = false;
  let withComments = true;
  const unsubs = [];
  const q = (sel) => (root ? root.querySelector(sel) : null);
  const setMsg = (t) => { const el = q('#dtna-bulk-msg'); if (el) el.textContent = t || ''; };
  const applyStatus = (s) => { const el = q('#dtna-bulk-state'); if (el) el.textContent = dtnaPill(s).text; };
  const refreshButtons = () => {
    const start = q('#dtna-bulk-start'); if (start) start.disabled = running || !dt;
    const cancel = q('#dtna-bulk-cancel'); if (cancel) cancel.disabled = !running;
    for (const id of ['#dtna-bulk-save-tsv', '#dtna-bulk-save-xls', '#dtna-bulk-save-comments']) {
      const el = q(id); if (el) el.disabled = !(finished && jobId);
    }
    const sc = q('#dtna-bulk-save-comments'); if (sc) sc.hidden = !(finished && withComments);
  };
  const onProgress = (p) => {
    if (!p || !jobId || p.jobId !== jobId) return;
    const bar = q('#dtna-bulk-progress');
    if (bar) {
      const total = Number(p.total) || 0;
      bar.setAttribute('max', String(total || 1));
      bar.setAttribute('value', String(Number(p.done) || 0));
    }
    const txt = q('#dtna-bulk-progress-text'); if (txt) txt.textContent = progressText(p);
    if (p.finished) {
      running = false;
      finished = true;
      if (p.code) setMsg(_msgFor(p.code));
      else if (p.cancelled) setMsg('Cancelled.');
      else setMsg('Done.');
    }
    refreshButtons();
  };

  const start = () => {
    if (!dt || running) return;
    const cb = q('#dtna-bulk-comments');
    withComments = cb ? cb.checked !== false : true;
    running = true; finished = false; jobId = null;
    setMsg('Starting\u2026');
    refreshButtons();
    Promise.resolve().then(() => dt.bulkPull({ includeComments: withComments })).then((r) => {
      if (r && r.ok && r.jobId) { jobId = r.jobId; setMsg('Pulling\u2026'); }
      else { running = false; setMsg(_msgFor(r && r.code)); }
      refreshButtons();
    }).catch(() => { running = false; setMsg(_msgFor('DTNA_INTERNAL')); refreshButtons(); });
  };
  const cancel = () => {
    if (!dt || !running || !jobId) return;
    Promise.resolve().then(() => dt.bulkCancel({ jobId })).catch(() => {});
  };
  const save = (format, mode) => {
    if (!dt || !finished || !jobId) return;
    Promise.resolve().then(() => dt.exportBulk({ jobId, format, mode })).then((r) => {
      if (r && r.ok) toast('success', 'Saved ' + r.filename + ' to Downloads', 4000);
      else toast('error', 'DTNA export failed (' + String((r && r.code) || 'unknown') + ')', 4000);
    }).catch(() => toast('error', 'DTNA export failed', 4000));
  };
  const signin = () => {
    const btn = q('#dtna-bulk-signin');
    if (!dt || typeof dt.login !== 'function' || (btn && btn.disabled)) return;
    if (btn) btn.disabled = true;
    Promise.resolve().then(() => dt.login()).catch(() => {}).finally(() => {
      if (btn) btn.disabled = false;
      return Promise.resolve().then(() => dt.status()).then(applyStatus).catch(() => {});
    });
  };

  m.show({
    title: 'DTNA Pull',
    width: 520,
    body: BODY,
    onMount: (el) => {
      root = el;
      if (!dt) setMsg('DTNA is not available in this build');
      const on = (sel, fn) => { const x = q(sel); if (x) x.addEventListener('click', fn); };
      on('#dtna-bulk-start', start);
      on('#dtna-bulk-cancel', cancel);
      on('#dtna-bulk-signin', signin);
      on('#dtna-bulk-save-tsv', () => save('tsv', 'cases'));
      on('#dtna-bulk-save-xls', () => save('xls', 'cases'));
      on('#dtna-bulk-save-comments', () => save('tsv', 'comments'));
      refreshButtons();
      if (!dt) return;
      try { if (typeof dt.onProgress === 'function') unsubs.push(dt.onProgress(onProgress)); } catch (_) {}
      try { if (typeof dt.onStatus === 'function') unsubs.push(dt.onStatus(applyStatus)); } catch (_) {}
      try { Promise.resolve(dt.status()).then(applyStatus).catch(() => {}); } catch (_) {}
    },
    onClose: () => {
      for (const u of unsubs.splice(0)) { try { if (typeof u === 'function') u(); } catch (_) {} }
      root = null;
    },
  });
}
