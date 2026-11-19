/**
 * pending-estimates-panel.js — Fleet tab "⏳ Pending Estimates" overlay.
 *
 * Lists the user's work orders whose estimate is submitted and awaiting approval
 * (DTNA excluded), oldest-submitted first, from the rows already in the fleet slice
 * (no new IPC, no AAP call). All HTML comes from ./pending-estimates-logic.js.
 *
 * Escalate reuses the existing WR-card Escalate modal (relay-actions.js
 * openEscalationModal) pre-targeted to MCS High Value Estimate. That modal drafts via
 * relay:draft-action only on "Draft with AI" and sends only through the gated
 * relay:escalate -> write-gate -> approval modal. Nothing here writes.
 *
 * The overlay sits at z-index 850, below the modal.js singleton (900), so the
 * Escalate and approval modals render above it. Escape is ignored while a modal.js
 * modal is open, so the first Escape closes the modal and the next one the overlay.
 *
 * The controller takes injected { doc, bus, getFleet, openEscalation, escalationDeps,
 * modal, navigate } so the DOM test drives it without jsdom (__test__.createController).
 */
import bus from '../bus.js';
import state from '../state.js';
import modal from '../components/modal.js';
import toast from '../components/toast.js';
import { openEscalationModal } from './relay-actions.js';
import * as L from './pending-estimates-logic.js';

let _active = null;

export function openPendingEstimatesPanel({ returnFocusEl } = {}) {
  if (_active) return _active;
  const w = typeof window !== 'undefined' ? window : {};
  const ctl = createController({
    doc: document, bus, modal,
    getFleet: () => state.slice('fleet'),
    openEscalation: openEscalationModal,
    // Same deps the unit-detail WR cards pass to the Escalate modal.
    escalationDeps: { modal, bridge: w.relayWrites, aapApi: w.aapApi, confirm: (m) => w.confirm(m), toast },
    navigate: (id) => bus.emit('navigate:unit', id),
    toast,
    returnFocusEl,
    onClose: () => { _active = null; },
  });
  _active = ctl;
  ctl.open();
  return ctl;
}

function createController(deps) {
  const { doc, returnFocusEl, onClose } = deps;
  const evBus = deps.bus || null;
  const now = deps.now || (() => Date.now());
  const getFleet = typeof deps.getFleet === 'function' ? deps.getFleet : () => ({});
  const mdl = deps.modal || { isOpen: () => false };
  const tst = deps.toast || { show() {} };

  let overlay = null; let backdrop = null; let bodyEl = null;
  let unsub = null; let closed = false; let opening = false;
  let byWr = new Map();

  function render() {
    if (!bodyEl) return;
    const f = getFleet() || {};
    const res = L.collectPendingEstimates(f.rows || [], { now: now(), fleetSyncedAt: f.syncedAt });
    byWr = new Map(res.items.map((it) => [it.wrId, it]));
    bodyEl.innerHTML = L.overlayHtml({ items: res.items, excludedDtna: res.excludedDtna, asOf: f.syncedAt,
      cached: !!(f.usedCache || f.stale) });
  }

  function mount() {
    overlay = doc.createElement('div');
    overlay.id = 'pe-overlay';
    overlay.className = 'pe-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'pe-title');
    backdrop = doc.createElement('div');
    backdrop.className = 'pe-backdrop';
    const panel = doc.createElement('div');
    panel.className = 'pe-panel';
    const head = doc.createElement('div');
    head.className = 'pe-head';
    head.innerHTML = '<div id="pe-title" class="pe-title">\u23F3 Pending Estimates</div>' +
      '<span class="pe-sub">Submitted, awaiting approval \u00B7 your domiciles \u00B7 DTNA excluded</span>' +
      '<button type="button" class="pe-close" data-pe-close="1" aria-label="Close">\u00D7</button>';
    bodyEl = doc.createElement('div');
    bodyEl.id = 'pe-body';
    bodyEl.className = 'pe-body';
    panel.appendChild(head);
    panel.appendChild(bodyEl);
    overlay.appendChild(backdrop);
    overlay.appendChild(panel);
    overlay.addEventListener('click', onClick);
    doc.addEventListener('keydown', onKeydown, true);
    doc.body.appendChild(overlay);
  }

  async function escalate(wrId) {
    const it = byWr.get(wrId);
    if (!it || !it.canEscalate || opening) return;
    opening = true;
    try {
      await deps.openEscalation(it.unit, it.wrId, deps.escalationDeps, { initialTarget: L.HVE_TARGET });
    } catch (e) {
      tst.show('error', 'Could not open: ' + ((e && e.message) || 'unknown'));
    } finally { opening = false; }
  }

  function onClick(e) {
    const t = e && e.target;
    if (!t) return;
    if (t === backdrop || t === overlay) { close(); return; }
    const pick = (sel) => (typeof t.closest === 'function' ? t.closest(sel) : null);
    if (pick('[data-pe-close]')) { close(); return; }
    const esc = pick('[data-pe-escalate]');
    if (esc) { if (!esc.disabled) return escalate(esc.getAttribute('data-pe-escalate')); return; }
    const u = pick('[data-pe-unit]');
    if (u) {
      const id = u.getAttribute('data-pe-unit');
      close();
      if (typeof deps.navigate === 'function') deps.navigate(id);
    }
  }

  function onKeydown(e) {
    if (!e || e.key !== 'Escape' || closed) return;
    if (typeof mdl.isOpen === 'function' && mdl.isOpen()) return; // the modal closes first
    if (typeof e.preventDefault === 'function') e.preventDefault();
    close();
  }

  function open() {
    mount();
    render();
    if (evBus && typeof evBus.on === 'function') unsub = evBus.on('fleet:data', () => render());
  }

  function close() {
    if (closed) return;
    closed = true;
    if (typeof unsub === 'function') unsub();
    unsub = null;
    doc.removeEventListener('keydown', onKeydown, true);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null; bodyEl = null;
    if (returnFocusEl && typeof returnFocusEl.focus === 'function') { try { returnFocusEl.focus(); } catch (_) { /* detached */ } }
    if (typeof onClose === 'function') onClose();
  }

  return { open, close, render, isClosed: () => closed };
}

export const __test__ = { createController };
