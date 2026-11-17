// sendBlocksToChannel posts Block Kit (blocks as a JSON string, unfurl off) and
// validates limits before any call; text-only senders keep today's payloads.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'slack-blocks-send-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const ss = require('../src/scrapers/slack_send');

let calls, nextResult;
beforeAll(() => {
  ss._setRawRequestForTests((method, params) => {
    calls.push({ method, params });
    return Promise.resolve(typeof nextResult === 'function' ? nextResult(method, params) : nextResult);
  });
});
beforeEach(() => { calls = []; nextResult = { ok: true, ts: '1.1' }; ss._resetForTests(); });
afterAll(() => { ss._setRawRequestForTests(null); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });

const b = [
  { type: 'header', text: { type: 'plain_text', text: 'Hi', emoji: true } },
  { type: 'section', text: { type: 'mrkdwn', text: '*x*' } },
];

describe('sendBlocksToChannel', () => {
  it('posts blocks as JSON with fallback text and unfurl off', async () => {
    const r = await ss.sendBlocksToChannel('C1', b, 'fb');
    expect(r).toEqual({ ok: true, ts: '1.1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('chat.postMessage');
    expect(calls[0].params).toEqual({ channel: 'C1', text: 'fb', blocks: JSON.stringify(b), unfurl_links: 'false', unfurl_media: 'false' });
  });
  it('opts.threadTs adds thread_ts', async () => {
    await ss.sendBlocksToChannel('C1', b, 'fb', { threadTs: '9.9' });
    expect(calls[0].params.thread_ts).toBe('9.9');
  });
  it('rejects bad input without calling Slack', async () => {
    const many = Array.from({ length: 51 }, () => ({ type: 'divider' }));
    const huge = [{ type: 'section', text: { type: 'mrkdwn', text: 'x'.repeat(40001) } }];
    await expect(ss.sendBlocksToChannel('C1', [], 'fb')).rejects.toThrow();
    await expect(ss.sendBlocksToChannel('C1', many, 'fb')).rejects.toThrow();
    await expect(ss.sendBlocksToChannel('C1', huge, 'fb')).rejects.toThrow();
    await expect(ss.sendBlocksToChannel('C1', b, '')).rejects.toThrow();
    await expect(ss.sendBlocksToChannel('', b, 'fb')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it('Slack error rejects with the API error', async () => {
    nextResult = { ok: false, error: 'invalid_blocks' };
    await expect(ss.sendBlocksToChannel('C1', b, 'fb')).rejects.toThrow('Slack API error: invalid_blocks');
  });
});

describe('text-only senders unaffected', () => {
  it('sendToChannel payload has no blocks key', async () => {
    await ss.sendToChannel('C1', 'hello');
    expect(calls[0].params).toEqual({ channel: 'C1', text: 'hello', unfurl_links: 'true', unfurl_media: 'true' });
  });
  it('sendSlackMessage posts { channel, text } only', async () => {
    nextResult = (method) => (method === 'conversations.list'
      ? { ok: true, channels: [{ id: 'CG', name: 'gen' }] }
      : { ok: true, ts: '2.2' });
    await ss.sendSlackMessage('#gen', 'hi');
    const post = calls.find((c) => c.method === 'chat.postMessage');
    expect(post.params).toEqual({ channel: 'CG', text: 'hi' });
  });
});
