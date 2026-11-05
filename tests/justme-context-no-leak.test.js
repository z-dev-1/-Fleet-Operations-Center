// T-NO-LEAK (AC-26/37), T-STORE-KEYS, and the round-3 fix-9 row: content from
// files, links and error messages never reaches a log line or a store payload.
// Real slack_channel_watch runner + real ai.js + real gatherContext/readSlackFile;
// logger, store, Slack and relay are recording fakes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'jmctx-noleak-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const { installWatchFakes } = require('./helpers/justme-watch-harness.cjs');

const S = installWatchFakes({ realAi: true });
const jc = require('../src/justme-context');
const { readSlackFile } = require('../src/justme-context/slack-files');

// The real store REGISTRY (the store module itself is faked for the SUT).
const REGISTRY = (() => {
  const p = require.resolve('../src/store');
  const fake = require.cache[p];
  delete require.cache[p];
  try { return require(p).REGISTRY; } finally { require.cache[p] = fake; }
})();

const SENTINEL = 'SENTINEL-CONTENT-7f3a';
const ME = 'ME';
const file = (id, name) => ({ id, name, mimetype: 'text/plain', size: 100, url_private_download: 'https://files.slack.com/files-pri/T1-' + id + '/' + name });

let watch;
beforeEach(() => {
  S.reset();
  S.seedChannel('1000.000000');
  watch = S.loadWatch();
});
afterEach(() => {
  process.env.FLEET_JUSTME_READ_CONTEXT = '0';
  watch.__test__.setGatherImpl(null);
});

function leakingGather() {
  const deps = {
    slackSend: {
      getFileInfo: async () => ({ ok: false, error: 'unused' }),
      downloadFileBounded: async (f) => ({ ok: true, buffer: Buffer.from('x'), mimetype: 'text/plain', name: f.name }),
    },
    extractItem: async (f) => {
      if (f.name === 'bad.txt') throw new Error('bad token ' + SENTINEL + ' at https://x.example/?t=secret');
      return { kind: 'text', status: 'read', text: 'Body with ' + SENTINEL, chars: 30, truncated: false, reason: '', meta: {} };
    },
    fetchExternal: async () => { const e = new Error('getaddrinfo ENOTFOUND x.example/?t=secret ' + SENTINEL); e.code = 'ENOTFOUND'; throw e; },
  };
  deps.readSlackFile = (f, ctx) => readSlackFile(f, ctx, deps);
  return (msg, o) => jc.gatherContext(msg, o, deps);
}

describe('T-NO-LEAK', () => {
  it('sentinel in a file, echoed by the AI, and inside thrown errors: absent from every log line and store payload', async () => {
    process.env.FLEET_JUSTME_READ_CONTEXT = '1';
    watch.__test__.setGatherImpl(leakingGather());
    S.poa = S.realAi.processOrchaAction;
    S.relayAsk = async () => JSON.stringify({ reply: 'The file says ' + SENTINEL, actions: [] });
    await S.run(watch, [{ ts: '1001.0', text: 'what do these say? https://x.example/page?t=secret', userId: ME, files: [file('F0OK1', 'good.txt'), file('F0BAD1', 'bad.txt')] }]);

    expect(S.relayCalls).toHaveLength(1);
    expect(S.relayCalls[0].opts.isolated).toBe(true);
    expect(S.relayCalls[0].prompt).toContain('Body with ' + SENTINEL);   // the content did reach the isolated lane
    expect(S.sent).toHaveLength(1);
    expect(S.sent[0].text).toContain('The file says ' + SENTINEL);       // and Z's own reply

    const logs = S.logText();
    expect(logs).not.toContain(SENTINEL);
    expect(logs).not.toContain('x.example/?');
    expect(logs).not.toContain('secret');
    expect(logs).toContain('file read failed: Error');

    const saved = JSON.stringify(S.saves);
    expect(saved).not.toContain(SENTINEL);
    const chat = S.data.chatHistory;
    expect(chat[chat.length - 1].text).toBe('(answered using 1 attached/linked item(s); content not retained)');
    const log = S.replyLog()[0];
    expect(log.reply).toBe('<@ME> ' + watch.__test__.REPLY_LOG_PLACEHOLDER);
    expect(log.contextItems.map((i) => i.status)).toEqual(['read', 'failed', 'failed']);
    for (const i of log.contextItems) expect(Object.keys(i)).toEqual(['source', 'kind', 'label', 'status']);
    expect(JSON.stringify(log.contextItems)).not.toContain('?t=');
  });

  it('T-STORE-KEYS: every key saved on a context turn is registered in src/store REGISTRY', async () => {
    process.env.FLEET_JUSTME_READ_CONTEXT = '1';
    watch.__test__.setGatherImpl(leakingGather());
    S.poa = S.realAi.processOrchaAction;
    await S.run(watch, [{ ts: '1001.0', text: 'read these', userId: ME, files: [file('F0OK1', 'good.txt')] }]);
    const keys = [...new Set(S.saves.map((s) => s.key))];
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(Object.prototype.hasOwnProperty.call(REGISTRY, k)).toBe(true);
  });
});

describe('fix 9: the runner catch never logs the error text on a context turn', () => {
  const ERR = 'claude-code error: ' + SENTINEL;
  const ctx = { items: [{ id: 'c1', source: 'file', kind: 'text', label: 'a.txt', status: 'read', text: 'abc', reason: '' }], hasFiles: true, hasLinks: false };
  const LINE = /^\[SlackWatch\]\[jm\d+\] processOrchaAction failed after \d+ms \((\d+) chars\)$/;

  for (const [label, poa] of [
    ['rejects', async () => { throw new Error(ERR); }],
    ['returns ok:false', async () => ({ ok: false, text: ERR })],
  ]) {
    it('context turn, processOrchaAction ' + label + ' → length-only warn, no sentinel anywhere in the logs', async () => {
      process.env.FLEET_JUSTME_READ_CONTEXT = '1';
      watch.__test__.setGatherImpl(async () => ctx);
      S.poa = poa;
      await S.run(watch, [{ ts: '1001.0', text: 'what is this', userId: ME, files: [file('F0A1', 'a.txt')] }]);
      expect(S.logText()).not.toContain(SENTINEL);
      const w = S.logs.filter((l) => l.level === 'warn' && l.text.includes('processOrchaAction failed'));
      expect(w).toHaveLength(1);
      const m = w[0].text.match(LINE);
      expect(m).not.toBeNull();
      expect(Number(m[1])).toBe(ERR.length);
      expect(S.sent).toHaveLength(1);
      expect(S.sent[0].text).toContain("couldn't complete that request");
    });
  }

  it('flag off: the same rejection logs today\'s exact line', async () => {
    S.poa = async () => { throw new Error(ERR); };
    await S.run(watch, [{ ts: '1001.0', text: 'what is this', userId: ME, files: [file('F0A1', 'a.txt')] }]);
    const w = S.logs.filter((l) => l.level === 'warn' && l.text.includes('processOrchaAction failed'));
    expect(w).toHaveLength(1);
    expect(w[0].text).toMatch(/^\[SlackWatch\]\[jm\d+\] processOrchaAction failed after \d+ms: claude-code error: SENTINEL-CONTENT-7f3a$/);
  });
});
