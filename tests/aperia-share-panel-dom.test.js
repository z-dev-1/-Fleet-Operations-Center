// tests/aperia-share-panel-dom.test.js
// The Aperia sign-in / status panel (aperia-panel.js) shows both labeled
// toggles: "Tire Alerts" and "Share underinflation alerts" (OFF by default),
// plus the carrier-briefing approval list. Mini DOM; window.aperia is a fake
// with vi.fn for all 16 preload keys. No IPC, Slack or Aperia call is real.
process.env.TZ = 'UTC';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { createMiniDocument } from './fixtures/mini-dom.js';

const ITEM = { id: 's1abc', unit: 'NP6923', severity: 'CRITICAL', state: 'UNDERINFLATION_AND_LEAK', text: 'Left Steer at 10 PSI <b>bold</b>', status: 'pending', createdAt: 1 };

const m = vi.hoisted(() => {
  const s = { cur: null, items: [] };
  const aperia = {
    login: vi.fn(async () => ({ ok: true, state: 'connected' })),
    logout: vi.fn(async () => ({ ok: true, state: 'signed-out' })),
    status: vi.fn(async () => s.cur),
    unit: vi.fn(async () => ({ ok: true })),
    bulk: vi.fn(async () => ({ ok: true, jobId: 'a1' })),
    fleetTires: vi.fn(async () => ({ ok: true, jobId: 'a2' })),
    issues: vi.fn(async () => ({ ok: true, jobId: 'a3', rows: [] })),
    startAlerts: vi.fn(async () => ({ ok: true })),
    stopAlerts: vi.fn(async () => ({ ok: true })),
    pollNow: vi.fn(async () => ({ ok: true, newCount: 0 })),
    exportBulk: vi.fn(async () => ({ ok: true, filename: 'x.tsv' })),
    onProgress: vi.fn(() => () => {}),
    onAlert: vi.fn(() => () => {}),
    setShare: vi.fn(async (p) => { s.cur = { ...s.cur, share: p.enabled }; return { ok: true, share: p.enabled }; }),
    shareItems: vi.fn(async () => ({ ok: true, items: s.items.map((x) => ({ ...x })) })),
    shareItem: vi.fn(async (p) => {
      const it = s.items.find((x) => x.id === p.id);
      if (it) it.status = p.action === 'approve' ? 'approved' : 'dismissed';
      s.cur = { ...s.cur, sharePending: s.items.filter((x) => x.status === 'pending').length };
      return { ok: true, status: it && it.status };
    }),
  };
  return { s, aperia };
});

const KEYS = ['login', 'logout', 'status', 'unit', 'bulk', 'fleetTires', 'issues', 'startAlerts', 'stopAlerts', 'pollNow', 'exportBulk', 'onProgress', 'onAlert', 'setShare', 'shareItems', 'shareItem'];
const BASE = { ok: true, state: 'connected', alerts: 'polling', minutes: 5, lastPullAt: null, share: false, sharePending: 0 };

let doc, panel;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const ov = () => doc.getElementById('aperia-panel-overlay');
const q = (sel) => ov().querySelector(sel);
const openPanel = async () => { panel.open({ aperia: m.aperia, document: doc }); await flush(); };

beforeAll(async () => {
  doc = createMiniDocument();
  globalThis.document = doc;
  panel = await import('../renderer/src/js/components/aperia-panel.js');
});
afterAll(() => { panel.close(); delete globalThis.document; });
beforeEach(() => {
  panel.close();
  vi.clearAllMocks();
  m.s.cur = { ...BASE };
  m.s.items = [];
});

describe('Aperia panel: Tire Alerts + Share underinflation alerts toggles', () => {
  it('the fake carries all 16 preload keys', () => {
    expect(Object.keys(m.aperia)).toEqual(KEYS);
  });

  it('opening the panel calls only status(); both toggles render with their labels; share defaults OFF', async () => {
    await openPanel();
    expect(m.aperia.status).toHaveBeenCalledTimes(1);
    for (const k of KEYS) if (k !== 'status' && k !== 'onAlert') expect(m.aperia[k], k).not.toHaveBeenCalled();
    expect(q('#aperia-panel-alerts-label').textContent).toBe('Tire Alerts');
    expect(q('#aperia-panel-alerts-state').textContent).toContain('Tire Alerts: ON');
    expect(q('#aperia-panel-alerts').textContent).toBe('Turn Tire Alerts OFF');
    expect(q('#aperia-panel-share-label').textContent).toBe('Share underinflation alerts');
    expect(q('#aperia-panel-share-state').textContent).toBe('Share underinflation alerts: OFF');
    expect(q('#aperia-panel-share').textContent).toBe('Turn sharing ON');
    expect(q('#aperia-panel-share').disabled).toBe(false);
    expect(q('#aperia-panel-share-note').textContent.startsWith('Off by default.')).toBe(true);
    expect(q('#aperia-panel-share-note').textContent).toContain('Settings \u2192 Operator Channels');
    expect(q('#aperia-panel-share-review').textContent).toBe('Carrier-briefing items (0)');
    expect(q('#aperia-panel-share-review').disabled).toBe(false);
    expect(q('#aperia-panel-share-list')).toBeTruthy();
  });

  it('with 0 pending the review button still opens the list so approved-but-unsent items can be dismissed', async () => {
    m.s.items = [{ ...ITEM, status: 'approved' }];
    m.s.cur = { ...BASE, share: true, sharePending: 0 };
    await openPanel();
    const review = q('#aperia-panel-share-review');
    expect(review.textContent).toBe('Carrier-briefing items (0)');
    expect(review.disabled).toBe(false);
    review.click();
    await flush();
    expect(m.aperia.shareItems).toHaveBeenCalledTimes(1);
    expect(q('#aperia-panel-share-list').textContent).toContain('Status: approved');
  });

  it('a status without share reads OFF', async () => {
    m.s.cur = { ok: true, state: 'signed-out', alerts: 'off' };
    await openPanel();
    expect(q('#aperia-panel-share-state').textContent).toBe('Share underinflation alerts: OFF');
    expect(q('#aperia-panel-share').textContent).toBe('Turn sharing ON');
  });

  it('clicking the share toggle calls setShare({ enabled:true }); the status re-read flips it to ON, then back OFF', async () => {
    await openPanel();
    q('#aperia-panel-share').click();
    await flush();
    expect(m.aperia.setShare).toHaveBeenCalledTimes(1);
    expect(m.aperia.setShare).toHaveBeenCalledWith({ enabled: true });
    expect(m.aperia.status).toHaveBeenCalledTimes(2);
    expect(q('#aperia-panel-share-state').textContent).toBe('Share underinflation alerts: ON');
    expect(q('#aperia-panel-share').textContent).toBe('Turn sharing OFF');
    q('#aperia-panel-share').click();
    await flush();
    expect(m.aperia.setShare.mock.calls[1][0]).toEqual({ enabled: false });
    expect(q('#aperia-panel-share-state').textContent).toBe('Share underinflation alerts: OFF');
    expect(m.aperia.startAlerts).not.toHaveBeenCalled();
    expect(m.aperia.stopAlerts).not.toHaveBeenCalled();
  });

  it('the review button shows the pending count; the list renders via textContent; Approve calls shareItem and reloads', async () => {
    m.s.items = [{ ...ITEM }];
    m.s.cur = { ...BASE, share: true, sharePending: 1 };
    await openPanel();
    const review = q('#aperia-panel-share-review');
    expect(review.textContent).toBe('Carrier-briefing items (1)');
    expect(review.disabled).toBe(false);
    review.click();
    await flush();
    expect(m.aperia.shareItems).toHaveBeenCalledTimes(1);
    const list = q('#aperia-panel-share-list');
    expect(list.textContent).toContain('NP6923');
    expect(list.textContent).toContain('CRITICAL');
    expect(list.textContent).toContain('UNDERINFLATION AND LEAK');
    expect(list.textContent).toContain('Left Steer at 10 PSI <b>bold</b>');
    expect(list.textContent).toContain('Status: pending');
    expect(list.querySelectorAll('b')).toHaveLength(1); // the item header only; the item text is not parsed
    expect(list.innerHTML).toContain('&lt;b&gt;bold&lt;/b&gt;');
    const approve = list.querySelector('button[data-action="approve"]');
    expect(approve.textContent).toBe('Approve');
    expect(list.querySelector('button[data-action="dismiss"]').textContent).toBe('Dismiss');
    approve.click();
    await flush();
    expect(m.aperia.shareItem).toHaveBeenCalledTimes(1);
    expect(m.aperia.shareItem).toHaveBeenCalledWith({ id: 's1abc', action: 'approve' });
    expect(m.aperia.shareItems).toHaveBeenCalledTimes(2);
    expect(q('#aperia-panel-share-list').textContent).toContain('Status: approved');
    expect(q('#aperia-panel-share-review').textContent).toBe('Carrier-briefing items (0)');
  });

  it('an approve refused while sharing is OFF shows a message', async () => {
    m.s.items = [{ ...ITEM }];
    m.s.cur = { ...BASE, share: false, sharePending: 1 };
    m.aperia.shareItem.mockResolvedValueOnce({ ok: false, code: 'APERIA_SHARE_OFF' });
    await openPanel();
    q('#aperia-panel-share-review').click();
    await flush();
    q('#aperia-panel-share-list').querySelector('button[data-action="approve"]').click();
    await flush();
    expect(q('#aperia-panel-msg').textContent).toBe('Turn sharing ON to approve carrier-briefing items.');
  });

  it('without the share preload keys the share controls are disabled', async () => {
    const { setShare, shareItems, shareItem, ...older } = m.aperia;
    m.s.cur = { ...BASE, sharePending: 2 };
    panel.open({ aperia: older, document: doc });
    await flush();
    expect(q('#aperia-panel-share').disabled).toBe(true);
    expect(q('#aperia-panel-share-review').disabled).toBe(true);
    expect(setShare).not.toHaveBeenCalled();
    expect(shareItems).not.toHaveBeenCalled();
    expect(shareItem).not.toHaveBeenCalled();
  });
});
