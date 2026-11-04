// T-PARITY-SEND + getFileInfo: sendToChannel 4th-arg unfurl opt-out leaves the
// default payload byte-identical; getFileInfo goes through slackWebApi('files.info').
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'jmctx-send-' + Date.now());
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

describe('sendToChannel payload parity', () => {
  it('3-arg call deep-equals today\'s payload (unfurl on)', async () => {
    await ss.sendToChannel('C1', 'hello', '123.4');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('chat.postMessage');
    expect(calls[0].params).toEqual({ channel: 'C1', text: 'hello', unfurl_links: 'true', unfurl_media: 'true', thread_ts: '123.4' });
  });
  it('2-arg call has no thread_ts and unfurl on', async () => {
    await ss.sendToChannel('C1', 'hello');
    expect(calls[0].params).toEqual({ channel: 'C1', text: 'hello', unfurl_links: 'true', unfurl_media: 'true' });
  });
  it('{ unfurl:false } turns both unfurl fields to "false"', async () => {
    await ss.sendToChannel('C1', 'hello', undefined, { unfurl: false });
    expect(calls[0].params).toEqual({ channel: 'C1', text: 'hello', unfurl_links: 'false', unfurl_media: 'false' });
    await ss.sendToChannel('C1', 'hello', '9.9', { unfurl: false });
    expect(calls[1].params.thread_ts).toBe('9.9');
    expect(calls[1].params.unfurl_links).toBe('false');
  });
  it('other option values leave unfurl on', async () => {
    await ss.sendToChannel('C1', 'x', undefined, {});
    await ss.sendToChannel('C1', 'x', undefined, { unfurl: true });
    await ss.sendToChannel('C1', 'x', undefined, { unfurl: 'false' });
    for (const c of calls) { expect(c.params.unfurl_links).toBe('true'); expect(c.params.unfurl_media).toBe('true'); }
  });
});

describe('getFileInfo', () => {
  it('returns the file record on success and calls files.info with the id', async () => {
    nextResult = { ok: true, file: { id: 'F123', name: 'a.pdf', url_private: 'https://files.slack.com/x' } };
    const r = await ss.getFileInfo('F123');
    expect(r).toEqual({ ok: true, file: { id: 'F123', name: 'a.pdf', url_private: 'https://files.slack.com/x' } });
    expect(calls[0]).toEqual({ method: 'files.info', params: { file: 'F123' } });
  });
  it('returns the Slack error code on failure', async () => {
    nextResult = { ok: false, error: 'file_not_found' };
    expect(await ss.getFileInfo('F404')).toEqual({ ok: false, error: 'file_not_found' });
  });
  it('a transport rejection becomes { ok:false } without throwing', async () => {
    nextResult = () => { throw new Error('socket hang up'); };
    const r = await ss.getFileInfo('F1');
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain('socket');
  });
});
