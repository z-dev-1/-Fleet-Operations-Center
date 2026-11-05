// T-PARITY-JM (AC-2/AC-4): with the flag off, or on but with nothing to read,
// the Just Me runner calls processOrchaAction, sendToChannel and the reply log
// exactly as it did before the context reader existed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { installWatchFakes } = require('./helpers/justme-watch-harness.cjs');

const S = installWatchFakes();
const PDF = { id: 'F0PDF1', name: 'report.pdf', mimetype: 'application/pdf', size: 1000, url_private_download: 'https://files.slack.com/files-pri/T1-F0PDF1/report.pdf' };
const TODAY_LOG_KEYS = ['id', 'channelId', 'channelName', 'ts', 'replyTs', 'question', 'reply', 'wasMentioned', 'wasThreadReply', 'inScope', 'category', 'title', 'createdAt', 'status'];

let watch, gatherCalls;
beforeEach(() => {
  S.reset();
  S.seedChannel('1000.000000');
  watch = S.loadWatch();
  gatherCalls = 0;
  watch.__test__.setGatherImpl(async () => { gatherCalls++; return { items: [], hasFiles: false, hasLinks: false }; });
});
afterEach(() => {
  process.env.FLEET_JUSTME_READ_CONTEXT = '0';
  watch.__test__.setGatherImpl(null);
  watch.__test__.setExtractBudgetMs(null);
});

function expectToday(text) {
  expect(gatherCalls).toBe(0);
  expect(S.poaCalls).toHaveLength(1);
  const [arg, opts] = S.poaCalls[0];
  expect(arg).toBe(text);
  expect(Object.keys(opts)).toEqual(['signal', 'requestId', 'source']);
  expect(opts.source).toBe('slack-justme');
  expect(S.sent).toHaveLength(1);
  expect(S.sent[0].args).toHaveLength(3);
  expect(S.sent[0].args[1]).toBe('<@ME> answer:' + text);
  const log = S.replyLog();
  expect(log).toHaveLength(1);
  expect(Object.keys(log[0])).toEqual(TODAY_LOG_KEYS);
  expect(log[0].reply).toBe('<@ME> answer:' + text);
  expect(S.logText()).not.toContain('context');
}

describe('T-PARITY-JM', () => {
  it('flag off: PDF + empty text → today\'s call, 3-arg send, today\'s reply log', async () => {
    await S.run(watch, [{ ts: '1001.0', text: '', userId: 'ME', files: [PDF] }]);
    expectToday('');
  });
  it('flag off: a link → today\'s path', async () => {
    await S.run(watch, [{ ts: '1001.0', text: 'look <https://w.amazon.com/x>', userId: 'ME', files: [] }]);
    expectToday('look <https://w.amazon.com/x>');
  });
  it('flag on, no files and no links → today\'s path', async () => {
    process.env.FLEET_JUSTME_READ_CONTEXT = '1';
    await S.run(watch, [{ ts: '1001.0', text: 'how many units are down?', userId: 'ME', files: [], attachments: [] }]);
    expectToday('how many units are down?');
  });
  it('flag off: a pending confirm + "yes" still confirms as today', async () => {
    S.poa = async () => ({ ok: true, text: 'Ready.', pendingConfirm: [{ channel: 'slack', recipientName: 'James', body: 'hi' }] });
    let confirmed = 0;
    S.confirmSend = async () => { confirmed++; return { ok: true, message: 'Slack sent to James' }; };
    await S.run(watch, [{ ts: '1001.0', text: 'send hi to james', userId: 'ME' }]);
    expect(S.sent[0].text).toBe('<@ME> Ready.\n\nReply YES to send, or NO to cancel.');
    await S.run(watch, [{ ts: '1002.0', text: 'yes', userId: 'ME', files: [PDF] }]);
    expect(confirmed).toBe(1);
    expect(S.sent[1].text).toBe('<@ME> Slack sent to James');
  });
  it('_jmEnqueueJob logs the same line with and without the 4th argument', async () => {
    S.poa = async (t) => ({ ok: true, text: 'answer:' + t });
    const ch = { id: 'CJM', name: 'just-me' };
    watch.__test__.enqueueJob(ch, { ts: '5.0', text: 'a', userId: 'ME' }, () => {});
    watch.__test__.enqueueJob(ch, { ts: '6.0', text: 'b', userId: 'ME' }, () => {}, 'ME');
    await watch.__test__.waitForAiQueueIdle(2000);
    const q = S.logs.map((l) => l.text).filter((t) => t.includes('-- queued'));
    expect(q).toHaveLength(2);
    expect(q[0].replace(/jm\d+/, 'jmN').replace('5.0', 'X')).toBe(q[1].replace(/jm\d+/, 'jmN').replace('6.0', 'X'));
  });
});
