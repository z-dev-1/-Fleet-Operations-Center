// tests/relay-write-approval-kinds-dom.test.js — approval prompt titles for the
// gate's updateEscalations / setLifecycle kinds (renderer/src/js/components/
// relay-write-approval.js). Same fake modal + bus + bridge as
// tests/relay-write-approval-dom.test.js; the two existing titles are unchanged.
import { describe, it, expect, vi } from 'vitest';

const M = vi.hoisted(() => {
  const state = { opts: null };
  const modal = {
    show: (o) => { state.opts = o; },
    close: () => { const o = state.opts; state.opts = null; if (o && o.onClose) o.onClose(); },
    isOpen: () => !!state.opts,
  };
  const bus = { on: () => {}, emit: () => {} };
  return { state, modal, bus };
});
vi.mock('../renderer/src/js/components/modal.js', () => ({ default: M.modal }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: M.bus }));

globalThis.document = { getElementById: () => null, querySelector: () => ({}) };
const respond = vi.fn(() => ({ ok: true }));
globalThis.window = { relayWrites: { respond } };

const C = await import('../renderer/src/js/components/relay-write-approval.js');

function titleFor(kind) {
  C.showRequest({ id: 'id-' + kind, kind, preview: 'x', aiDrafted: false });
  const t = M.state.opts.title;
  M.state.opts.actions.find((a) => a.label === 'Cancel').onClick();
  return t;
}

describe('approval titles', () => {
  it('names the new kinds and keeps the existing ones', () => {
    expect(titleFor('updateEscalations')).toBe('Approve Relay escalation');
    expect(titleFor('setLifecycle')).toBe('Approve AAP lifecycle change');
    expect(titleFor('addComment')).toBe('Approve Relay comment');
    expect(titleFor('createWorkOrder')).toBe('Approve Relay work request');
    expect(respond).toHaveBeenCalledTimes(4);
    expect(respond.mock.calls.every((c) => c[1] === false)).toBe(true);
  });

  it('a DTNA stage change says it is dealer-visible and shows the exact from -> to preview (Phase C)', async () => {
    respond.mockClear();
    const { createRequire } = await import('node:module');
    const gate = createRequire(import.meta.url)('../src/writes/write-gate.js');
    const preview = gate.previewOf('dtnaStage', { caseId: '500gx000002E4U5AAK', fromStage: 'In-Repair', toStage: 'Closed', repairOrderNo: 'R101048154' },
      { unit: '122269', origin: 'unit-detail-dtna-stage' });
    C.showRequest({ id: 'id-stage', kind: 'dtnaStage', preview, aiDrafted: null });
    expect(M.state.opts.title).toBe('Approve DTNA stage change (dealer-visible)');
    const pre = /<pre class="rwa-preview"[^>]*>([\s\S]*?)<\/pre>/.exec(M.state.opts.body);
    expect(pre).toBeTruthy();
    expect(pre[1]).toContain('CHANGE DTNA CASE STAGE: In-Repair -&gt; Closed');
    expect(pre[1]).toContain('VISIBLE TO THE DEALER (DTNA)');
    expect(pre[1]).toContain('DTNA case: 500gx000002E4U5AAK');
    M.state.opts.actions.find((a) => a.label === 'Cancel').onClick();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0][1]).toBe(false);
  });

  it('a DTNA comment says it is dealer-visible', () => {
    respond.mockClear();
    expect(titleFor('dtnaComment')).toBe('Approve DTNA comment (dealer-visible)');
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0][1]).toBe(false);
  });
});
