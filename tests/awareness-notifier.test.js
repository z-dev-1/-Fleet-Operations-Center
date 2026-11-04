// tests/awareness-notifier.test.js
//
// Unified proactive-note notifier (src/orcha/awareness/notifier.js), design §D6, test plan §D16.2.
// The proactive-alerts toNote and deep-scan repairDoneNote key cases are tested with those
// modules' routing change (FEAT-002). Slack, auth, leadership, send and timers are all fakes.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import fsNode from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { createNotifier } = require('../src/orcha/awareness/notifier');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = 60 * 1000;
const H = 60 * M;
const DAY = 24 * H;
const T0 = Date.parse('2026-11-01T12:00:00Z');
const QUIET = { info() {}, warn() {}, debug() {} };
const JUST_ME = 'DJUST';
const ALL_SLACK_CHANNELS = [];

const WATCH_CFG = { enabled: true, channels: [{ id: 'CPART', replyMode: 'mentions' }, { id: JUST_ME, replyMode: 'justme' }] };
const INIT_LEDGER = () => ({ initializedAt: T0 - 3 * DAY, sourceBaseline: { 'proactive-alerts': T0 - 3 * DAY, 'deep-scan': T0 - 3 * DAY }, keys: {}, slackPosts: [] });

function fakeStore(init) {
  const data = JSON.parse(JSON.stringify(init));
  return { data, load: vi.fn((k, d) => (k in data ? JSON.parse(JSON.stringify(data[k])) : d)), save: vi.fn((k, v) => { data[k] = JSON.parse(JSON.stringify(v)); }) };
}

function harness(opts = {}) {
  const store = opts.fs || fakeStore(Object.assign({ slackChannelWatchConfig: WATCH_CFG, settings: {} },
    opts.fresh ? {} : { assistantNoteLedger: INIT_LEDGER() }, opts.store || {}));
  let t = opts.t0 != null ? opts.t0 : T0;
  const slack = {
    checkLiveAuth: vi.fn(async () => ({ authenticated: true, userId: 'U1' })),
    sendToChannel: vi.fn(async (ch) => { ALL_SLACK_CHANNELS.push(ch); return { ok: true }; }),
  };
  if (opts.sendRejects) slack.sendToChannel.mockImplementation(async (ch) => { ALL_SLACK_CHANNELS.push(ch); throw new Error('boom'); });
  const send = vi.fn();
  const timers = { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() };
  const n = createNotifier({
    load: store.load, save: store.save, now: () => t, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    send, loadSettings: () => store.data.settings || {}, slack, log: QUIET,
    actionLog: opts.actionLog || { recent: () => [] },
    mayRunProduction: opts.mayRunProduction || (() => true),
  });
  return { fs: store, slack, send, timers, n, at: (v) => { t = v; }, now: () => t };
}

const note = (unit, extra = {}) => Object.assign({
  key: `${unit}|esc|MCS Lead|WR1`, unit, wr: 'WR1', family: 'esc', icon: '🚨', title: 'New escalation',
  text: `${unit} escalated to MCS Lead.`, source: 'digest', severity: 'high',
}, extra);
const p1a = (u) => note(u, { key: `${u}|ready-api|WR1`, family: 'ready-api', icon: '✅', text: `${u} is Ready, confirmed by the Decisiv API.` });
const p6 = (u) => note(u, { key: `${u}|ready-maybe|WR1`, family: 'ready-maybe', icon: '✅', text: `${u} repair looks complete (done). Verify.`, source: 'deep-scan' });
const p1b = (u) => note(u, { key: `${u}|ready-maybe|WR1`, family: 'ready-maybe', icon: '✅', text: `${u} may be Ready (not confirmed by the Decisiv API).` });
const p4 = (u, w = 0) => note(u, { key: `${u}|stalled|WR1|w${w}`, family: 'stalled', icon: '⚠️', text: `${u} stalled`, source: 'proactive-alerts', severity: 'medium' });

describe('baselines (AC15)', () => {
  it('first-ever flush is silent and marks keys', async () => {
    const h = harness({ fresh: true });
    h.n.enqueue([note('1'), note('2')]);
    await h.n.flush();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.slack.sendToChannel).not.toHaveBeenCalled();
    const l = h.fs.data.assistantNoteLedger;
    expect(l.initializedAt).toBe(T0);
    expect(Object.keys(l.keys).sort()).toEqual(['1|esc|MCS Lead|WR1', '2|esc|MCS Lead|WR1']);
  });

  it('deep-scan note 10 min after the first proactive-alerts flush is silent', async () => {
    const h = harness({ fresh: true });
    h.n.enqueue([p4('A')]);
    await h.n.flush();
    expect(h.fs.data.assistantNoteLedger.sourceBaseline['proactive-alerts']).toBe(T0);
    h.at(T0 + 10 * M);
    h.n.enqueue([p6('B')]);
    await h.n.flush();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.slack.sendToChannel).not.toHaveBeenCalled();
    expect(h.fs.data.assistantNoteLedger.keys['B|ready-maybe|WR1']).toBe(T0 + 10 * M);
  });

  it('P4 at install+12 h silent, new P4 key at install+25 h delivered, digest note at install+1 h delivered; baseline survives restart', async () => {
    const h = harness({ fresh: true });
    h.n.enqueue([p4('A')]);
    await h.n.flush(); // install
    h.at(T0 + H);
    h.n.enqueue([note('D')]);
    await h.n.flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    h.at(T0 + 12 * H);
    h.n.enqueue([p4('B')]);
    await h.n.flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.fs.data.assistantNoteLedger.keys['B|stalled|WR1|w0']).toBe(T0 + 12 * H);

    // New notifier instance over the same store: sourceBaseline persists.
    const h2 = harness({ fs: h.fs, t0: T0 + 13 * H });
    h2.n.enqueue([p4('C')]);
    await h2.n.flush();
    expect(h2.send).not.toHaveBeenCalled();
    expect(h.fs.data.assistantNoteLedger.sourceBaseline['proactive-alerts']).toBe(T0);
    h2.at(T0 + 25 * H);
    h2.n.enqueue([p4('E')]);
    await h2.n.flush();
    expect(h2.send).toHaveBeenCalledTimes(1);
    expect(h2.send.mock.calls[0][1].notes[0].key).toBe('E|stalled|WR1|w0');
  });

  it('silent:true (digest catch-up) after initializedAt → marked, nothing delivered', async () => {
    const h = harness();
    h.n.enqueue([note('1', { silent: true })]);
    await h.n.flush();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.slack.sendToChannel).not.toHaveBeenCalled();
    expect(h.fs.data.assistantNoteLedger.keys['1|esc|MCS Lead|WR1']).toBe(T0);
  });
});

describe('enqueue / timers / ledger', () => {
  it('enqueue never saves and arms a 20 s quiet timer (90 s hard max)', () => {
    const h = harness();
    h.n.enqueue([note('1')]);
    expect(h.fs.save).not.toHaveBeenCalled();
    expect(h.timers.setTimeout.mock.calls[0][1]).toBe(20000);
    h.at(T0 + 80 * 1000);
    h.n.enqueue([note('2')]);
    expect(h.timers.setTimeout.mock.calls[1][1]).toBe(10000);
    expect(h.fs.save).not.toHaveBeenCalled();
  });

  it('invalid notes are dropped', async () => {
    const h = harness();
    h.n.enqueue([{ key: '', text: 'x' }, { key: 'k' }, null, { key: 'a|b|c', text: 'x'.repeat(400), unit: 'a' }]);
    await h.n.flush();
    const sent = h.send.mock.calls[0][1].notes;
    expect(sent).toHaveLength(1);
    expect(sent[0].text.length).toBe(300);
  });

  it('de-dupe across flushes and a restart (AC7)', async () => {
    const h = harness();
    h.n.enqueue([p1a('1')]);
    await h.n.flush();
    h.n.enqueue([p1a('1')]);
    await h.n.flush();
    const h2 = harness({ fs: h.fs, t0: T0 + H });
    h2.n.enqueue([p1a('1')]);
    await h2.n.flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h2.send).not.toHaveBeenCalled();
    expect(h.slack.sendToChannel).toHaveBeenCalledTimes(1);
  });

  it('keep-alive: re-detected key suppressed through day 31; un-detected key pruned then re-delivered', async () => {
    const h = harness();
    h.n.enqueue([note('X'), note('Y')]);
    await h.n.flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    let last = 0;
    for (let d = 1; d <= 31; d++) {
      last = T0 + d * DAY;
      h.at(last);
      h.n.enqueue([note('X')]);
      await h.n.flush();
    }
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.fs.data.assistantNoteLedger.keys['X|esc|MCS Lead|WR1']).toBe(last);
    expect(h.fs.data.assistantNoteLedger.keys['Y|esc|MCS Lead|WR1']).toBeUndefined();
    h.n.enqueue([note('Y')]);
    await h.n.flush();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1][1].notes[0].unit).toBe('Y');
  });

  it('a touched-only enqueue arms the timer; its flush saves the ledger without delivering', async () => {
    const h = harness({ store: { assistantNoteLedger: Object.assign(INIT_LEDGER(), { keys: { '1|esc|MCS Lead|WR1': T0 - DAY } }) } });
    h.n.enqueue([note('1')]);
    expect(h.timers.setTimeout).toHaveBeenCalledTimes(1);
    h.at(T0 + M);
    await h.n.flush();
    expect(h.fs.save).toHaveBeenCalledWith('assistantNoteLedger', expect.anything());
    expect(h.fs.data.assistantNoteLedger.keys['1|esc|MCS Lead|WR1']).toBe(T0 + M);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.slack.sendToChannel).not.toHaveBeenCalled();
  });

  it('ledger save throws → nothing delivered, pending kept for next flush', async () => {
    const h = harness();
    h.n.enqueue([note('1')]);
    h.fs.save.mockImplementationOnce(() => { throw new Error('disk'); });
    await h.n.flush();
    expect(h.send).not.toHaveBeenCalled();
    await h.n.flush();
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

describe('ready de-dupe across signal strengths (AC8)', () => {
  it('P6 + P1a in one flush → one note with the P1a text (either order)', async () => {
    const h = harness();
    h.n.enqueue([p6('1')]);
    h.n.enqueue([p1a('1')]);
    h.n.enqueue([p1a('2'), p6('2')]);
    await h.n.flush();
    const sent = h.send.mock.calls[0][1].notes;
    expect(sent.map((n) => n.key).sort()).toEqual(['1|ready-api|WR1', '2|ready-api|WR1']);
    expect(h.fs.data.assistantNoteLedger.keys['1|ready-maybe|WR1']).toBe(T0);
  });

  it('P6 on day 1 then P1a on day 3 → both delivered', async () => {
    const h = harness();
    h.n.enqueue([p6('1')]);
    await h.n.flush();
    h.at(T0 + 2 * DAY);
    h.n.enqueue([p1a('1')]);
    await h.n.flush();
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1][1].notes[0].text).toContain('confirmed by the Decisiv API');
  });

  it('P1a flushed, then P6 or P1b → dropped', async () => {
    const h = harness();
    h.n.enqueue([p1a('1')]);
    await h.n.flush();
    h.n.enqueue([p6('1')]);
    await h.n.flush();
    h.n.enqueue([p1b('1')]);
    await h.n.flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.slack.sendToChannel).toHaveBeenCalledTimes(1);
  });
});

describe('Slack delivery', () => {
  it('3 notes → exactly one sendToChannel, text starts with "<@U1> " (AC9)', async () => {
    const h = harness();
    h.n.enqueue([note('1')]); h.n.enqueue([note('2')]); h.n.enqueue([note('3')]);
    await h.n.flush();
    expect(h.slack.sendToChannel).toHaveBeenCalledTimes(1);
    const [ch, text] = h.slack.sendToChannel.mock.calls[0];
    expect(ch).toBe(JUST_ME);
    expect(text.startsWith('<@U1> ')).toBe(true);
    expect(text).toContain('*1* escalated');
    expect(text).toContain('Suggestions only');
  });

  it('escapes Slack control characters (AC27)', async () => {
    const h = harness();
    h.n.enqueue([note('1', { text: '1 at <!channel> <img src=x onerror=alert(1)> & co' })]);
    await h.n.flush();
    const text = h.slack.sendToChannel.mock.calls[0][1];
    expect(text.startsWith('<@U1> ')).toBe(true);
    expect(text).toContain('&lt;!channel&gt;');
    expect(text).toContain('&lt;img');
    expect(text).toContain('&amp; co');
    expect(text).not.toContain('<!channel>');
  });

  it('hourly cap 4: fifth flush in the hour skips Slack, in-app still delivered (AC10)', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) {
      h.at(T0 + i * 5 * M);
      h.n.enqueue([note('U' + i)]);
      await h.n.flush();
    }
    expect(h.slack.sendToChannel).toHaveBeenCalledTimes(4);
    expect(h.send).toHaveBeenCalledTimes(5);
  });

  it('8-bullet cap with "+N more"', async () => {
    const h = harness();
    const fams = ['a', 'b', 'c', 'd', 'e'];
    const list = [];
    for (let i = 0; i < 10; i++) list.push(note('U' + i, { key: `U${i}|${fams[i % 5]}|WR1`, family: fams[i % 5] }));
    h.n.enqueue(list);
    await h.n.flush();
    const text = h.slack.sendToChannel.mock.calls[0][1];
    expect(text.split('\n').filter((l) => l.startsWith('• '))).toHaveLength(8);
    expect(text).toContain('+2 more in the app.');
  });

  it('family collapse > 5 and flood breaker > 15 (AC16)', async () => {
    const h = harness();
    h.n.enqueue(Array.from({ length: 6 }, (_, i) => note('F' + i)));
    await h.n.flush();
    const sent = h.send.mock.calls[0][1].notes;
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('F0, F1, F2, F3, F4, F5');
    expect(sent[0].id.startsWith('n_sum_')).toBe(true);

    h.at(T0 + M);
    h.n.enqueue(Array.from({ length: 16 }, (_, i) => note('G' + i, { key: `G${i}|f${i}|WR1`, family: 'f' + i })));
    await h.n.flush();
    const sent2 = h.send.mock.calls[1][1].notes;
    expect(sent2).toHaveLength(1);
    expect(sent2[0].text).toBe('16 fleet changes detected at once. Ask Orcha "what changed?"');
  });

  it('toggles off (AC11)', async () => {
    const h = harness({ store: { settings: { proactiveNotesSlack: false } } });
    h.n.enqueue([note('1')]);
    await h.n.flush();
    expect(h.slack.sendToChannel).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);

    const h2 = harness({ store: { settings: { proactiveNotesInApp: false } } });
    h2.n.enqueue([note('1')]);
    await h2.n.flush();
    expect(h2.send).not.toHaveBeenCalled();
    expect(h2.fs.data.assistantNotesFeed).toBeUndefined();
    expect(h2.slack.sendToChannel).toHaveBeenCalledTimes(1);
    expect(h2.fs.data.assistantNoteLedger.keys['1|esc|MCS Lead|WR1']).toBe(T0);

    const h3 = harness({ store: { settings: { proactiveNotesInApp: false, proactiveNotesSlack: false } } });
    h3.n.enqueue([note('1')]);
    await h3.n.flush();
    expect(h3.send).not.toHaveBeenCalled();
    expect(h3.slack.sendToChannel).not.toHaveBeenCalled();
    expect(h3.fs.data.assistantNoteLedger.keys['1|esc|MCS Lead|WR1']).toBe(T0);
  });

  it('no Just Me channel / legacy mode only / disabled / cfg disabled / global fallback only → no Slack (AC12)', async () => {
    const cfgs = [
      { enabled: true, channels: [{ id: 'C1', mode: 'justme' }] },
      { enabled: true, channels: [{ id: 'C1', replyMode: 'justme', enabled: false }] },
      { enabled: false, channels: [{ id: 'C1', replyMode: 'justme' }] },
      { enabled: true, replyMode: 'justme', channels: [{ id: 'C1' }] },
      { enabled: true, channels: [] },
    ];
    for (const cfg of cfgs) {
      const h = harness({ store: { slackChannelWatchConfig: cfg } });
      h.n.enqueue([note('1')]);
      await h.n.flush();
      expect(h.slack.sendToChannel).not.toHaveBeenCalled();
      expect(h.send).toHaveBeenCalledTimes(1);
    }
  });

  it('carrier-channel guard refuses a Just Me channel mapped as a carrier channel', async () => {
    const h = harness({ store: { operatorChannels: { operators: [{ operator: 'ACME', channelId: JUST_ME }] } } });
    h.n.enqueue([note('1')]);
    await h.n.flush();
    expect(h.slack.sendToChannel).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('mayRunProduction false → no Slack, in-app delivered; throwing → treated as true (AC23)', async () => {
    const h = harness({ mayRunProduction: () => false });
    h.n.enqueue([note('1')]);
    await h.n.flush();
    expect(h.slack.sendToChannel).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
    const h2 = harness({ mayRunProduction: () => { throw new Error('x'); } });
    h2.n.enqueue([note('1')]);
    await h2.n.flush();
    expect(h2.slack.sendToChannel).toHaveBeenCalledTimes(1);
  });

  it('not authenticated → no Slack', async () => {
    const h = harness();
    h.slack.checkLiveAuth.mockResolvedValue({ authenticated: false });
    h.n.enqueue([note('1')]);
    await h.n.flush();
    expect(h.slack.sendToChannel).not.toHaveBeenCalled();
  });

  it('sendToChannel rejects → flush does not throw, in-app delivered, no retry', async () => {
    const h = harness({ sendRejects: true });
    h.n.enqueue([note('1')]);
    await expect(h.n.flush()).resolves.toBeUndefined();
    expect(h.send).toHaveBeenCalledTimes(1);
    await h.n.flush();
    expect(h.slack.sendToChannel).toHaveBeenCalledTimes(1);
  });

  it('P2 suppressed by a user escalation in the action log', async () => {
    const recent = vi.fn(() => [{ type: 'escalation', unit: '1', at: T0 - M }]);
    const h = harness({ actionLog: { recent } });
    h.n.enqueue([note('1'), note('2')]);
    await h.n.flush();
    expect(h.send.mock.calls[0][1].notes.map((n) => n.unit)).toEqual(['2']);
    expect(recent.mock.calls[0][1]).toBe(2 * H);
  });
});

describe('feed', () => {
  it('ids: n_ + 12 hex, n_sum_ for summaries, ≤ 64; getFeed / markSeen / dismiss', async () => {
    const h = harness();
    h.n.enqueue([note('1')]);
    await h.n.flush();
    h.at(T0 + M);
    h.n.enqueue(Array.from({ length: 16 }, (_, i) => note('G' + i, { key: `G${i}|f${i}|WR1`, family: 'f' + i })));
    await h.n.flush();
    let feed = h.n.getFeed();
    expect(feed.notes).toHaveLength(2);
    expect(feed.unseen).toBe(2);
    const [sum, normal] = feed.notes;
    expect(normal.id).toMatch(/^n_[0-9a-f]{12}$/);
    expect(sum.id.startsWith('n_sum_')).toBe(true);
    expect(sum.id.length).toBeLessThanOrEqual(64);
    expect(h.send.mock.calls[0][1].unseen).toBe(1);

    expect(h.n.markSeen()).toEqual({ ok: true });
    expect(h.n.getFeed().unseen).toBe(0);
    expect(h.n.dismiss(normal.id)).toEqual({ ok: true });
    expect(h.n.dismiss(sum.id)).toEqual({ ok: true });
    expect(h.n.getFeed().notes).toEqual([]);
    expect(h.n.dismiss('n_nope')).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('configure({ send }) replaces the push target', async () => {
    const h = harness();
    const send2 = vi.fn();
    h.n.configure({ send: send2 });
    h.n.enqueue([note('1')]);
    await h.n.flush();
    expect(send2).toHaveBeenCalledWith('assistant:notes', expect.objectContaining({ unseen: 1 }));
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('safety (AC13)', () => {
  it('every sendToChannel call in this file used the Just Me channel id', () => {
    expect(ALL_SLACK_CHANNELS.length).toBeGreaterThan(0);
    expect(ALL_SLACK_CHANNELS.every((c) => c === JUST_ME)).toBe(true);
  });

  it('notifier.js requires none of the carrier / AAP-write modules', () => {
    const src = fsNode.readFileSync(path.join(ROOT, 'src/orcha/awareness/notifier.js'), 'utf8');
    const reqs = Array.from(src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)).map((m) => m[1]);
    for (const bad of ['ready_pickup_notify', 'carrier_briefing', 'pm_alert_reply', 'aap_api', 'aap_lifecycle_api', 'setLifecycle']) {
      expect(reqs.some((r) => r.includes(bad))).toBe(false);
    }
    expect(src).not.toMatch(/setLifecycle/);
    const allowed = ['node:crypto', '../../store', '../../utils/logger', '../../scrapers/slack_justme_channel', '../../scrapers/slack_send', '../../cluster', './action-log'];
    expect(reqs.filter((r) => !allowed.includes(r))).toEqual([]);
  });
});
