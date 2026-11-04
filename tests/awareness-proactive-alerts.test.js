// tests/awareness-proactive-alerts.test.js
// proactive-alerts.js and deep-scan.js routed through the unified notifier
// (design §D6 "Routing existing sources", test plan §D16.7 + the toNote /
// repairDoneNote key cases from §D16.2). Store, notifier and Slack are fakes.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Any Slack send attempt from these modules would hit this spy.
const slackSpy = { sendToChannel: vi.fn(async () => ({ ok: true })), sendSlackMessage: vi.fn(async () => ({ ok: true })) };
const slackPath = require.resolve('../src/scrapers/slack_send');
require.cache[slackPath] = { id: slackPath, filename: slackPath, loaded: true, exports: slackSpy };

const pa = require('../src/orcha/proactive-alerts');
const ds = require('../src/orcha/deep-scan');
const cd = require('../src/orcha/awareness/change-digest');

function fakeStore(init) {
  const data = Object.assign({}, init || {});
  return { data, load: (k, d) => (k in data ? data[k] : d), save: (k, v) => { data[k] = v; } };
}
const fakeNotifier = () => ({ enqueue: vi.fn() });
const JUSTME_CFG = { enabled: true, channels: [{ id: 'CJUSTME', replyMode: 'justme', enabled: true }] };

describe('runProactiveAlerts (§D16.7)', () => {
  it('no prior score -> no risk alert, score baselined', async () => {
    const fs = fakeStore();
    const n = fakeNotifier();
    await pa.runProactiveAlerts([{ equipmentId: 'A', riskScore: 85, lifecycleState: 'Active' }], null, { load: fs.load, save: fs.save, notifier: n });
    expect(n.enqueue).not.toHaveBeenCalled();
    expect(fs.data.proactiveLastScores).toEqual({ A: 85 });
  });

  it('a 1-row push does not wipe the other units\' scores', async () => {
    const fs = fakeStore({ proactiveLastScores: { A: 40, B: 50 } });
    const n = fakeNotifier();
    await pa.runProactiveAlerts([{ equipmentId: 'A', riskScore: 45, lifecycleState: 'Active' }], null, { load: fs.load, save: fs.save, notifier: n });
    expect(fs.data.proactiveLastScores).toEqual({ A: 45, B: 50 });
  });

  it('alerts go to deps.notifier.enqueue with P4/P5 keys, source and wr', async () => {
    const fs = fakeStore({ proactiveLastScores: { R: 40 }, slackChannelWatchConfig: JUSTME_CFG });
    const n = fakeNotifier();
    const send = vi.fn();
    const rows = [
      { equipmentId: 'S1', lifecycleState: 'Unavailable', workDuration: '6d', vendor: 'V1', workRequestId: 'WR7' },
      { equipmentId: 'S2', lifecycleState: 'Unavailable', workDuration: '12d', vendor: 'V2' },
      { equipmentId: 'R', lifecycleState: 'Active', riskScore: 67, workRequestId: 'WR9' },
    ];
    await pa.runProactiveAlerts(rows, { send }, { load: fs.load, save: fs.save, notifier: n });
    expect(n.enqueue).toHaveBeenCalledTimes(1);
    const notes = n.enqueue.mock.calls[0][0];
    expect(notes.map((x) => x.key).sort()).toEqual(['R|risk|60', 'S1|stalled|WR7|w0', 'S2|stalled|-|w1']);
    for (const x of notes) expect(x.source).toBe('proactive-alerts');
    expect(notes.find((x) => x.unit === 'R').wr).toBe('WR9');
    expect(notes.find((x) => x.unit === 'S2').wr).toBe('-');
    // existing renderer push and 12h cooldown kept
    expect(send).toHaveBeenCalledWith('orcha:proactive-alerts', expect.objectContaining({ count: 3 }));
    expect(Object.keys(fs.data.proactiveAlertHistory).sort()).toEqual(['R', 'S1', 'S2']);
    // no Slack call from proactive-alerts itself
    expect(slackSpy.sendToChannel).not.toHaveBeenCalled();
    expect(slackSpy.sendSlackMessage).not.toHaveBeenCalled();
  });

  it('notifier throwing never rejects', async () => {
    const fs = fakeStore();
    const n = { enqueue: vi.fn(() => { throw new Error('boom'); }) };
    await expect(pa.runProactiveAlerts([{ equipmentId: 'S1', lifecycleState: 'Unavailable', workDuration: '9d' }], null,
      { load: fs.load, save: fs.save, notifier: n })).resolves.toBeUndefined();
  });
});

describe('_toNote keys (§D16.2)', () => {
  const stalled = (days) => pa._toNote({ type: 'stalled', unitId: 'U1', wr: 'WR1', days, message: 'm' });
  it('stalled days 5 and 11 share bucket w0, day 12 is w1', () => {
    expect(stalled(5).key).toBe('U1|stalled|WR1|w0');
    expect(stalled(11).key).toBe('U1|stalled|WR1|w0');
    expect(stalled(12).key).toBe('U1|stalled|WR1|w1');
    expect(stalled(5).wr).toBe('WR1');
    expect(stalled(5).family).toBe('stalled');
  });
  it('risk 67 -> |risk|60 and carries wr', () => {
    const n = pa._toNote({ type: 'risk-jump', unitId: 'U1', wr: 'WR2', riskScore: 67, message: 'm' });
    expect(n.key).toBe('U1|risk|60');
    expect(n.wr).toBe('WR2');
    expect(n.source).toBe('proactive-alerts');
  });
});

describe('deep-scan note mappers', () => {
  it('_repairDoneNote key equals the change-digest P1b key for the same unit+WR', () => {
    const p1b = cd.proactiveCandidates([{ u: 'U1', k: 'canonical', f: 'in_repair', t: 'ready_for_pickup', wr: 'WR5', text: 'x' }], {});
    expect(p1b).toHaveLength(1);
    const n = ds._repairDoneNote({ id: 'U1', wr: 'WR5', signal: 'status: complete' });
    expect(n.key).toBe(p1b[0].key);
    expect(n.key).toBe('U1|ready-maybe|WR5');
    expect(n.source).toBe('deep-scan');
    expect(n.text).toContain('repair looks complete (status: complete)');
  });
  it('_outOfScopeNote key and source', () => {
    const n = ds._outOfScopeNote({ id: 'U2', wr: '-', signal: 'out of scope' });
    expect(n.key).toBe('U2|out-of-scope|-');
    expect(n.source).toBe('deep-scan');
    expect(n.family).toBe('out-of-scope');
  });
});
