// askInternal opt-ins (fix 7): { redactLog, unfurl:false }. A 1-argument call is
// byte-identical to today: sendToChannel gets 2 args and the log carries q.slice(0,120).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const slackPath = require.resolve('../src/scrapers/slack_send');
const realSlack = require.cache[slackPath];
const { askInternal, AITEAMMATE_CHANNEL } = require('../src/orcha/ask-internal');
const SENTINEL = 'SENTINEL-CONTENT-7f3a';

let sendToChannel, lines;
beforeEach(() => {
  vi.useFakeTimers();
  sendToChannel = vi.fn(async () => ({ ok: true, ts: '100.5' }));
  require.cache[slackPath] = {
    id: slackPath, filename: slackPath, loaded: true,
    exports: {
      checkLiveAuth: async () => ({ authenticated: true, userId: 'UME' }),
      sendToChannel,
      readMessages: async () => [{ ts: '101.0', userId: 'UBOT', text: 'the answer' }],
    },
  };
  lines = [];
  const sink = (c) => { lines.push(String(c)); return true; };
  vi.spyOn(process.stdout, 'write').mockImplementation(sink);
  vi.spyOn(process.stderr, 'write').mockImplementation(sink);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (realSlack) require.cache[slackPath] = realSlack; else delete require.cache[slackPath];
});

async function run(q, opts) {
  const p = opts === undefined ? askInternal(q) : askInternal(q, opts);
  await vi.advanceTimersByTimeAsync(3000);
  return p;
}

describe('askInternal 1-argument call (parity)', () => {
  it('sendToChannel gets exactly 2 args and the log has the first 120 chars', async () => {
    const q = 'q'.repeat(130) + SENTINEL;
    const res = await run(q);
    expect(res).toEqual({ ok: true, answer: 'the answer' });
    expect(sendToChannel).toHaveBeenCalledTimes(1);
    expect(sendToChannel.mock.calls[0]).toEqual([AITEAMMATE_CHANNEL, q]);
    expect(sendToChannel.mock.calls[0]).toHaveLength(2);
    expect(lines.join('')).toContain('question sent to AITeammate (ts=100.5): ' + q.slice(0, 120));
  });
  it('an empty options object behaves the same as no options', async () => {
    await run('hello there', {});
    expect(sendToChannel.mock.calls[0]).toHaveLength(2);
    expect(lines.join('')).toContain('hello there');
  });
});

describe('askInternal { redactLog, unfurl:false }', () => {
  it('logs only the length and posts with unfurl disabled', async () => {
    const q = 'please look at https://evil.example/x ' + SENTINEL;
    const res = await run(q, { redactLog: true, unfurl: false });
    expect(res.ok).toBe(true);
    expect(sendToChannel).toHaveBeenCalledTimes(1);
    expect(sendToChannel.mock.calls[0]).toEqual([AITEAMMATE_CHANNEL, q, undefined, { unfurl: false }]);
    const all = lines.join('');
    expect(all).toContain('(ts=100.5): (' + q.length + ' chars)');
    expect(all).not.toContain(SENTINEL);
    expect(all).not.toContain('evil.example');
  });
  it('redactLog alone keeps the 2-arg post but hides the text', async () => {
    const q = 'abc ' + SENTINEL;
    await run(q, { redactLog: true });
    expect(sendToChannel.mock.calls[0]).toHaveLength(2);
    expect(lines.join('')).not.toContain(SENTINEL);
  });
});
