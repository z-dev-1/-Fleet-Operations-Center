// tests/aperia-share-briefing.test.js — approve-before-send: approved Aperia underinflation items appear
// under the Daily Carrier Briefing "Needs your action" section only while the share toggle is ON, carrier-
// redacted; pending items never appear; a test-to-self preview does not mark them sent, a real send does;
// the share path itself never posts to the carrier channel. Slack / relay are stubbed.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aperia-share-briefing-'));
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');
const relay = require('../src/orcha/relay');
const cb = require('../src/scrapers/carrier_briefing');
const R = require('../src/scrapers/carrier_briefing_blocks');
const pref = require('../src/aperia/share-pref');
const shareStore = require('../src/aperia/share-store');

afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });

const NAME = 'Christy Adriaansen - Kenworth Northeast Group';
const ITEM_TEXT = 'A100 Right Steer is at 70 PSI vs 100 target. ' + NAME + ' quoted $4,210.30 for the tire. Location: 1 Sentinel Way, Testville, PA 18000.';
const rows = [
  { equipmentId: 'A100', operator: 'GWOP', lifecycleState: 'Available', domicileSite: 'ABE40' },
  { equipmentId: 'A101', operator: 'GWOP', lifecycleState: 'Unavailable', domicileSite: 'ABE40', created: '2026-11-12T12:00:00Z',
    lifecycleReason: 'Towed after breakdown; impound fee must be paid by carrier before release', subVendor: 'Speedy Towing' },
];

let deps;
const actionText = (blocks) => {
  const b = blocks.find((x) => x.text && x.text.text.startsWith('⚠️ *Needs your action*'));
  return b ? b.text.text : '';
};

beforeEach(() => {
  for (const f of ['aperia_share.json', 'aperia_share_pref.json']) { try { fs.rmSync(path.join(tmpDir, f), { force: true }); } catch (_) {} }
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T14:00:00Z'));
  store.save('operatorChannels', { operators: [{ operator: 'GWOP', channelId: 'C_GW', ownerId: 'U_GW' }] });
  store.save('carrierBriefingConfig', { enabled: true, tipEnabled: false });
  store.save('carrierBriefingLog', { sent: {}, recentTips: [] });
  store.save('fleetData', { rows: JSON.parse(JSON.stringify(rows)), syncedAt: '2026-11-17T13:30:00Z' });
  vi.spyOn(relay, 'askWithTimeout').mockResolvedValue('');
  deps = {
    sendBlocksToChannel: vi.fn(async () => ({ ok: true, ts: '1.1' })),
    sendToChannel: vi.fn(async () => ({ ok: true, ts: '1.2' })),
    checkLiveAuth: vi.fn(async () => ({ authenticated: true, userId: 'UZ' })),
    openConversation: vi.fn(async () => 'D_SELF'),
  };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const addItem = (o = {}) => shareStore.addItem(Object.assign({ issueId: '9001', unit: 'A100', operator: 'GWOP', severity: 'CRITICAL', state: 'UNDERINFLATION', text: ITEM_TEXT }, o));

describe('carrier briefing + Aperia share items', () => {
  it('a pending (unapproved) item never appears', async () => {
    pref.save(true);
    addItem();
    await cb.sendOperatorBriefing('GWOP', deps, { force: true }, () => {});
    const blocks = deps.sendBlocksToChannel.mock.calls[0][1];
    expect(JSON.stringify(blocks)).not.toContain('🛞');
    expect(JSON.stringify(blocks)).not.toContain('Right Steer');
    expect(shareStore.list()[0].status).toBe('pending');
  });

  it('an approved item appears under Needs your action only with the toggle ON, carrier-redacted', async () => {
    const it0 = addItem();
    shareStore.decide(it0.id, 'approve');
    pref.save(false);
    await cb.sendOperatorBriefing('GWOP', deps, { testToSelf: true }, () => {});
    expect(JSON.stringify(deps.sendBlocksToChannel.mock.calls[0][1])).not.toContain('🛞');

    pref.save(true);
    await cb.sendOperatorBriefing('GWOP', deps, { testToSelf: true }, () => {});
    const blocks = deps.sendBlocksToChannel.mock.calls[1][1];
    const act = actionText(blocks);
    expect(act).toContain('• *A100* — 🛞 A100 Right Steer is at 70 PSI vs 100 target.');
    expect(act).toContain('*A101*');                                   // the existing action line is kept
    expect(act).toContain('Kenworth Northeast Group');
    expect(act).toContain('1 Sentinel Way, Testville, PA 18000');
    expect(act).not.toMatch(/Christy|Adriaansen/);
    expect(act).not.toMatch(/\$\s?\d|4,210/);
    expect(deps.sendBlocksToChannel.mock.calls[1][2]).toContain('2 need your action');
    // Only in the Needs-your-action block.
    expect(blocks.filter((b) => JSON.stringify(b).includes('🛞'))).toHaveLength(1);
  });

  it('testToSelf does not mark the item sent; a real send does and blanks its text', async () => {
    pref.save(true);
    const it0 = addItem();
    shareStore.decide(it0.id, 'approve');
    await cb.sendOperatorBriefing('GWOP', deps, { testToSelf: true }, () => {});
    expect(deps.sendBlocksToChannel.mock.calls[0][0]).toBe('D_SELF');
    expect(shareStore.list()[0].status).toBe('approved');
    const r = await cb.sendOperatorBriefing('GWOP', deps, {}, () => {});
    expect(r.sent).toBe(true);
    expect(deps.sendBlocksToChannel.mock.calls[1][0]).toBe('C_GW');
    expect(actionText(deps.sendBlocksToChannel.mock.calls[1][1])).toContain('🛞');
    expect(shareStore.list()[0]).toMatchObject({ status: 'sent', text: '' });
    // The next briefing no longer lists it.
    await cb.sendOperatorBriefing('GWOP', deps, { force: true }, () => {});
    expect(JSON.stringify(deps.sendBlocksToChannel.mock.calls[2][1])).not.toContain('🛞');
  });

  it('a failed briefing send does not mark the item sent', async () => {
    pref.save(true);
    const it0 = addItem();
    shareStore.decide(it0.id, 'approve');
    deps.sendBlocksToChannel.mockRejectedValueOnce(new Error('slack down'));
    expect((await cb.sendOperatorBriefing('GWOP', deps, {}, () => {})).sent).toBe(false);
    expect(shareStore.list()[0].status).toBe('approved');
  });

  it('another operator\'s approved item is not included', async () => {
    pref.save(true);
    const it0 = addItem({ operator: 'OTHEROP' });
    shareStore.decide(it0.id, 'approve');
    await cb.sendOperatorBriefing('GWOP', deps, { force: true }, () => {});
    expect(JSON.stringify(deps.sendBlocksToChannel.mock.calls[0][1])).not.toContain('🛞');
  });

  it('blocks and text are byte-identical when tireActions is absent or empty', () => {
    const base = { operator: 'GWOP', totalUnits: 2, downCount: 1, down: [{ unit: 'A101', daysDown: 5, vendor: 'X', issue: 'i', severity: 'red', needsAction: false, actionText: '' }], pmDue: [], domiciles: [] };
    const ctx = { todayIso: '2026-11-17', dateLabel: 'Mon Nov 17' };
    const a = R.buildBriefingBlocks(base, ctx);
    expect(R.buildBriefingBlocks(Object.assign({}, base, { tireActions: [] }), ctx)).toEqual(a);
    expect(R.buildBriefingText(Object.assign({}, base, { tireActions: [] }), ctx)).toBe(R.buildBriefingText(base, ctx));
    expect(actionText(a)).toBe('⚠️ *Needs your action*\n_Nothing needs your action today._');
    const withTire = R.buildBriefingBlocks(Object.assign({}, base, { tireActions: [{ unit: 'A100', actionText: 'Right Steer <low>' }] }), ctx);
    expect(withTire.length).toBe(a.length);
    expect(actionText(withTire)).toBe('⚠️ *Needs your action*\n• *A100* — 🛞 Right Steer &lt;low&gt;');
  });
});

describe('the share path never posts to the carrier channel', () => {
  it('src/aperia/** never references sendBlocksToChannel, the carrier channel or carrier_briefing', () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'aperia');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const t = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(t, f).not.toMatch(/sendBlocksToChannel|carrier_briefing|channelId\s*,\s*text/);
    }
    const share = fs.readFileSync(path.join(dir, 'share.js'), 'utf8');
    // The only Slack send in the share path targets the owner's DM channel.
    expect(share.match(/sendToChannel\(/g)).toHaveLength(1);
    expect(share).toContain("openConversation({ id: entry.ownerId, type: 'user' })");
  });
});
