// T-JM-FLOW (AC-12/29/30/32/33/40/44), T-JM-SENDER (AC-28/43), the round-3
// fix-8 AC-40 row and the T-VISION-SECRET end-to-end rows (fix 2), through the
// REAL Just Me runner in slack_channel_watch.js.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'jmctx-flow-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const { installWatchFakes } = require('./helpers/justme-watch-harness.cjs');

const S = installWatchFakes({ realAi: true });
const jc = require('../src/justme-context');
const { readSlackFile } = require('../src/justme-context/slack-files');

const ME = 'ME';
const PDF = { id: 'F0PDF1', name: 'report.pdf', mimetype: 'application/pdf', size: 1000, url_private_download: 'https://files.slack.com/files-pri/T1-F0PDF1/report.pdf' };
const PNG = { id: 'F0PNG1', name: 'shot.png', mimetype: 'image/png', size: 70, url_private_download: 'https://files.slack.com/files-pri/T1-F0PNG1/shot.png' };
const readItem = (extra) => Object.assign({ id: 'c1', source: 'file', kind: 'pdf', label: 'report.pdf', status: 'read', text: 'Quarterly numbers', chars: 17, truncated: false, reason: '', meta: {} }, extra || {});
const fileCtx = (extra) => Object.assign({ items: [readItem()], hasFiles: true, hasLinks: false }, extra || {});
const TOKEN_C = 'xoxc-1234567890-abcdefghij';
const TOKEN_D = 'xoxd-1234567890-abcdef';
const WITHHELD = 'I withheld this reply because it contained what looked like credentials.';

let watch, gatherCalls;
const gatherReturns = (v) => watch.__test__.setGatherImpl(async (...a) => { gatherCalls.push(a); return typeof v === 'function' ? v(...a) : v; });

beforeEach(() => {
  S.reset();
  S.seedChannel('1000.000000');
  watch = S.loadWatch();
  gatherCalls = [];
  process.env.FLEET_JUSTME_READ_CONTEXT = '1';
});
afterEach(() => {
  process.env.FLEET_JUSTME_READ_CONTEXT = '0';
  watch.__test__.setGatherImpl(null);
  watch.__test__.setExtractBudgetMs(null);
});

describe('T-JM-FLOW', () => {
  it('file-only → files default intent, untrusted items passed, one reply with the report, unfurl off', async () => {
    gatherReturns(fileCtx());
    await S.run(watch, [{ ts: '1001.0', text: '', userId: ME, files: [PDF] }]);
    expect(gatherCalls).toHaveLength(1);
    expect(gatherCalls[0][1]).toMatchObject({ jobId: expect.stringMatching(/^jm\d+$/) });
    expect(gatherCalls[0][1].signal).toBeInstanceOf(AbortSignal);
    const [userMsg, opts] = S.poaCalls[0];
    expect(userMsg).toBe(jc.DEFAULT_INTENT_FILES);
    expect(opts.untrustedContext).toEqual({ typedText: '', items: [readItem()] });
    expect(opts.source).toBe('slack-justme');
    expect(S.sent).toHaveLength(1);
    expect(S.sent[0].args).toHaveLength(4);
    expect(S.sent[0].args[3]).toEqual({ unfurl: false });
    expect(S.sent[0].text.startsWith('<@ME> answer:' + jc.DEFAULT_INTENT_FILES)).toBe(true);
    expect(S.sent[0].text).toContain('\n\n📎 *What I read*\n• `report.pdf` — pdf — read');
  });
  it('link-only → links default intent', async () => {
    gatherReturns({ items: [readItem({ source: 'link', kind: 'page', label: 'w.amazon.com/x' })], hasFiles: false, hasLinks: true });
    await S.run(watch, [{ ts: '1001.0', text: '<https://w.amazon.com/x>', userId: ME }]);
    expect(S.poaCalls[0][0]).toBe(jc.DEFAULT_INTENT_LINKS);
    expect(S.poaCalls[0][1].untrustedContext.typedText).toBe('<https://w.amazon.com/x>');
  });
  it('typed text is passed whole', async () => {
    gatherReturns(fileCtx());
    await S.run(watch, [{ ts: '1001.0', text: 'summarize this for me', userId: ME, files: [PDF] }]);
    expect(S.poaCalls[0][0]).toBe('summarize this for me');
  });
  it('gather throws → one reply with "internal error", no AI call', async () => {
    watch.__test__.setGatherImpl(async () => { throw new Error('boom'); });
    await S.run(watch, [{ ts: '1001.0', text: '', userId: ME, files: [PDF] }]);
    expect(S.poaCalls).toHaveLength(0);
    expect(S.sent).toHaveLength(1);
    expect(S.sent[0].text).toBe("<@ME> I couldn't read anything you sent.\n\n📎 *What I read*\n• I couldn't read the attachments or links (internal error)");
    expect(S.logText()).toContain('context gather failed: Error');
  });
  it('gather hangs past setExtractBudgetMs(50) → "skipped — time budget reached" (real gatherContext, hanging fetch)', async () => {
    watch.__test__.setExtractBudgetMs(50);
    watch.__test__.setGatherImpl((msg, o) => jc.gatherContext(msg, o, { fetchExternal: () => new Promise(() => {}), logger: { info() {}, warn() {} } }));
    await S.run(watch, [{ ts: '1001.0', text: 'what is this <https://example.com/x>', userId: ME }]);
    expect(S.sent).toHaveLength(1);
    expect(S.sent[0].text).toContain('`example.com/x` — page — skipped: skipped — time budget reached');
  });
  it('a reader that never resolves is reported skipped within the budget', async () => {
    watch.__test__.setExtractBudgetMs(200);
    watch.__test__.setGatherImpl((msg, o) => jc.gatherContext(msg, o, { readSlackFile: () => new Promise(() => {}), logger: { info() {}, warn() {} } }));
    const t0 = Date.now();
    await S.run(watch, [{ ts: '1001.0', text: 'read this', userId: ME, files: [PNG] }]);
    expect(S.sent[0].text).toContain('`shot.png` — file — skipped: skipped — time budget reached');
    expect(Date.now() - t0).toBeLessThan(200 + 1500);
  });
  it('five messages → five replies, in order', async () => {
    gatherReturns(fileCtx());
    const msgs = [1, 2, 3, 4, 5].map((i) => ({ ts: '100' + i + '.0', text: 'q' + i, userId: ME, files: [PDF] }));
    await S.run(watch, msgs);
    expect(S.sent.map((s) => s.text.split('\n')[0])).toEqual(['<@ME> answer:q1', '<@ME> answer:q2', '<@ME> answer:q3', '<@ME> answer:q4', '<@ME> answer:q5']);
  });
  it('pending confirm + file + "yes" → confirmSend not called, processed as a new question', async () => {
    let confirmed = 0;
    S.confirmSend = async () => { confirmed++; return { ok: true }; };
    S.poa = async () => ({ ok: true, text: 'Ready.', pendingConfirm: [{ channel: 'slack', recipientName: 'James', body: 'hi' }] });
    await S.run(watch, [{ ts: '1001.0', text: 'send hi to james', userId: ME }]);
    gatherReturns(fileCtx());
    S.poa = async (t) => ({ ok: true, text: 'answer:' + t });
    await S.run(watch, [{ ts: '1002.0', text: 'yes', userId: ME, files: [PDF] }]);
    expect(confirmed).toBe(0);
    expect(S.poaCalls[1][0]).toBe('yes');
    expect((S.data.slackJustMePendingConfirm || {}).CJM).toBeUndefined();
  });
  it('reply log for a context turn: placeholder reply and metadata-only contextItems', async () => {
    gatherReturns(fileCtx());
    S.poa = async () => ({ ok: true, text: 'The doc says Quarterly numbers' });
    await S.run(watch, [{ ts: '1001.0', text: 'what does this say?', userId: ME, files: [PDF] }]);
    const e = S.replyLog()[0];
    expect(e.reply).toBe('<@ME> ' + watch.__test__.REPLY_LOG_PLACEHOLDER);
    expect(e.question).toBe('what does this say?');
    expect(e.contextItems).toEqual([{ source: 'file', kind: 'pdf', label: 'report.pdf', status: 'read' }]);
    expect(JSON.stringify(S.replyLog())).not.toContain('Quarterly');
  });
  it('AC-40: mention tokens are defanged, the tag prefix stays live', async () => {
    gatherReturns(fileCtx());
    S.poa = async () => ({ ok: true, text: '<!channel> hi <@U123|bob> see <#C999|ops>' });
    await S.run(watch, [{ ts: '1001.0', text: 'what is this', userId: ME, files: [PDF] }]);
    const t = S.sent[0].text;
    for (const raw of ['<!channel>', '<@U123', '<#C999']) expect(t).not.toContain(raw);
    expect(t.startsWith('<@ME> ')).toBe(true);
  });
  it('fix 8 AC-40 row: a labelled link shows its target and no "|"', async () => {
    gatherReturns(fileCtx());
    S.poa = async () => ({ ok: true, text: 'Please re-auth: <https://evil.example|Midway>' });
    await S.run(watch, [{ ts: '1001.0', text: 'what is this', userId: ME, files: [PDF] }]);
    expect(S.sent[0].text).toContain('Midway (https://evil.example)');
    expect(S.sent[0].text).not.toContain('|');
  });
  it('AC-44: a staged Slack send shows a preview before "Reply YES"; without context the same output is unchanged', async () => {
    const out = { ok: true, text: 'Ready to send.', pendingConfirm: [{ channel: 'slack', recipientName: 'James Mendez', body: 'Good morning <!here>\nline2' }] };
    S.poa = async () => out;
    gatherReturns(fileCtx());
    await S.run(watch, [{ ts: '1001.0', text: 'send this to james', userId: ME, files: [PDF] }]);
    expect(S.sent[0].text).toContain('Ready to send.\n> To James Mendez: Good morning @\u200Bhere line2\n\nReply YES to send, or NO to cancel.');
    expect(S.data.slackJustMePendingConfirm.CJM.items).toHaveLength(1);
    await S.run(watch, [{ ts: '1002.0', text: 'no', userId: ME }]);
    await S.run(watch, [{ ts: '1003.0', text: 'send good morning to james', userId: ME }]);
    expect(S.sent[2].text).toBe('<@ME> Ready to send.\n\nReply YES to send, or NO to cancel.');
  });
});

describe('T-JM-SENDER (AC-28/43)', () => {
  it('a message from another user with a PDF and a link → no gather, today\'s call', async () => {
    gatherReturns(fileCtx());
    await S.run(watch, [{ ts: '1001.0', text: 'look https://w.amazon.com/x', userId: 'U_OTHER', files: [PDF] }]);
    expect(gatherCalls).toHaveLength(0);
    expect(Object.keys(S.poaCalls[0][1])).toEqual(['signal', 'requestId', 'source']);
    expect(S.sent[0].args).toHaveLength(3);
  });
  it('myUserId empty → no gather', async () => {
    gatherReturns(fileCtx());
    watch.__test__.enqueueJob({ id: 'CJM', name: 'just-me' }, { ts: '1001.0', text: 'x', userId: ME, files: [PDF] }, () => {}, '');
    await watch.__test__.waitForAiQueueIdle(2000);
    expect(gatherCalls).toHaveLength(0);
    expect(S.sent[0].args).toHaveLength(3);
  });
  it('"<@ME> https://w.amazon.com/x" from ME is never enqueued', async () => {
    gatherReturns(fileCtx());
    await S.run(watch, [{ ts: '1001.0', text: '<@ME> https://w.amazon.com/x', userId: ME }]);
    expect(gatherCalls).toHaveLength(0);
    expect(S.poaCalls).toHaveLength(0);
    expect(S.sent).toHaveLength(0);
  });
  it('a ME message containing SELF_REPLY_MARKER plus a file → zero gather calls, today\'s path', async () => {
    gatherReturns(fileCtx());
    await S.run(watch, [{ ts: '1001.0', text: '\u200B\u2060here is the file', userId: ME, files: [PDF] }]);
    expect(gatherCalls).toHaveLength(0);
    expect(S.sent[0].args).toHaveLength(3);
  });
});

describe('T-VISION-SECRET end to end (fix 2)', () => {
  const PNG_BYTES = fs.readFileSync(path.join(__dirname, 'fixtures', 'justme-context', 'tiny.png'));
  it('a vision stub that transcribes an xoxc- token: the token reaches no relay.ask prompt and no sendToChannel call', async () => {
    S.poa = S.realAi.processOrchaAction;
    S.relayAsk = async () => '{"reply":"I could not read the image.","actions":[]}';
    const deps = {
      slackSend: {
        getFileInfo: async () => ({ ok: false, error: 'unused' }),
        downloadFileBounded: async () => ({ ok: true, buffer: PNG_BYTES, mimetype: 'image/png', name: 'shot.png' }),
      },
      bedrock: { readFileWithVision: async () => ({ ok: true, text: 'Session cookie: ' + TOKEN_C }) },
      logger: { info() {}, warn() {} },
    };
    deps.readSlackFile = (f, ctx) => readSlackFile(f, ctx, deps);
    watch.__test__.setGatherImpl((msg, o) => jc.gatherContext(msg, o, deps));
    await S.run(watch, [{ ts: '1001.0', text: 'what does this screenshot say?', userId: ME, files: [PNG] }]);
    expect(S.sent).toHaveLength(1);
    for (const c of S.relayCalls) expect(c.prompt).not.toContain(TOKEN_C);
    for (const s of S.sent) expect(JSON.stringify(s.args)).not.toContain(TOKEN_C);
    expect(S.sent[0].text).toContain('image text looked like credentials — not used');
    expect(S.logText()).not.toContain(TOKEN_C);
    expect(JSON.stringify(S.saves)).not.toContain(TOKEN_C);
  });
  it('an AI reply containing xoxd-… on a context turn is withheld; the report is still posted', async () => {
    gatherReturns(fileCtx());
    S.poa = async () => ({ ok: true, text: 'Here you go: ' + TOKEN_D });
    await S.run(watch, [{ ts: '1001.0', text: 'what is this', userId: ME, files: [PDF] }]);
    const t = S.sent[0].text;
    expect(t).not.toContain(TOKEN_D);
    expect(t).toBe('<@ME> ' + WITHHELD + '\n\n📎 *What I read*\n• `report.pdf` — pdf — read');
    expect(S.logText()).toContain('context reply withheld: slack-token');
    expect(S.logText()).not.toContain(TOKEN_D);
  });
  it('a staged send whose body holds an AWS key is withheld and never stored', async () => {
    gatherReturns(fileCtx());
    S.poa = async () => ({ ok: true, text: 'Ready.', pendingConfirm: [{ channel: 'email', recipientName: 'bob@example.com', subject: 'keys', body: 'AKIAABCDEFGHIJKLMNOP' }] });
    await S.run(watch, [{ ts: '1001.0', text: 'email this to bob@example.com', userId: ME, files: [PDF] }]);
    expect(S.sent[0].text.startsWith('<@ME> ' + WITHHELD)).toBe(true);
    expect(S.sent[0].text).not.toContain('AKIA');
    expect((S.data.slackJustMePendingConfirm || {}).CJM).toBeUndefined();
  });
});
