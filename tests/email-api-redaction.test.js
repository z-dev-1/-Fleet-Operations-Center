// tests/email-api-redaction.test.js — AC-16 / FR-1.4 / FR-1.10 / NFR-3 / NFR-6: no token, anchor or cookie value in any
// log line or store document; no address, subject, body, URL or query string in the logs; no new store key.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { installLogSpy, restoreLogSpy, leaks, logText, clearLog } from './fixtures/email-intel/log-spy.js';
import { apiEnv } from './fixtures/email-api/fake-net.js';
import { createTokenWorld, jwt } from './fixtures/email-api/fake-token-window.js';
import { restMessage, mailboxRoutes, mailServerRoutes, WK } from './fixtures/email-api/rest-messages.js';
import { stubTriage } from './fixtures/email-intel/scan-harness.js';
const require = createRequire(import.meta.url);

const TOKEN = jwt(Math.floor(Date.now() / 1000) + 3600, 'SENTINELTOKENVALUE');
const TOKEN_PARTS = TOKEN.slice(7).split('.');
const ANCHOR = 'SMTP:sentinel-anchor-1234@example.test';
const COOKIE = 'SENTINELCOOKIE=abc123';
const ADDR = 'sentinel.person@example.test';
const SUBJ = 'SENTINEL SUBJECT 7788';
const BODY = 'SENTINEL BODY TEXT 99 about unit 40123';
const MARK_RE = /FOC-[0-9a-f]{16}/;

let env; let run;
beforeAll(async () => {
  installLogSpy();
  const msg = restMessage({ Id: 'M1', ConversationId: 'CONV-1', InternetMessageId: '<sentinel-imid@example.test>', Subject: SUBJ, ReceivedDateTime: new Date(Date.now() - 3600_000).toISOString().replace(/\.\d+Z$/, 'Z'),
    From: { EmailAddress: { Name: 'Sentinel Person', Address: ADDR } }, ParentFolderId: WK.inbox, Body: { ContentType: 'Text', Content: BODY } });
  const server = { originals: { M1: msg }, conv: { 'CONV-1': ['M1'] }, send: { status: 503, headers: { 'set-cookie': COOKIE } } };
  const routes = mailServerRoutes(server).concat(mailboxRoutes({ msgs: [msg] })).map((r) => ({ method: r.method, re: r.re, respond: (req) => Object.assign({ headers: { 'set-cookie': COOKIE } }, r.respond(req)) }));
  const world = createTokenWorld({ steps: [{ at: 5, load: 'https://outlook.cloud.microsoft/mail/inbox' },
    { at: 10, cdp: { url: 'https://outlook.cloud.microsoft/api/v2.0/me/x?cookie=' + COOKIE, headers: { Authorization: TOKEN, 'X-AnchorMailbox': ANCHOR, Cookie: COOKIE } } }] });
  const logger = require('../src/utils/logger')('email-intel');
  const tokens = require('../src/email-intel/transport/token-source').createTokenSource({ electron: world.electron, owaRe: require('../src/scrapers/owa-mailer'), log: logger });
  env = apiEnv({ routes, tokens, httpOpts: { log: logger } });
  require('../src/email-intel/reliability/lock')._reset();
  const store = require('../src/store');
  const keysBefore = Object.keys(store.REGISTRY).slice();
  const idx = require('../src/email-intel/index');
  clearLog();
  const scan = await idx.runIntelScan({ folders: ['Inbox'], _transport: env.transport.deps(), _triageEmails: stubTriage() }, 'manual');
  const confirm = require('../src/email-intel/confirm');
  const executors = require('../src/email-intel/executors');
  confirm._resetForTests(); executors.registerAll();
  const rec = Object.values(env.stores.load('messages').messages)[0];
  const p = confirm.prepare('send-reply', { conversationKey: rec.conversationKey, mode: 'reply', bodyText: 'Reply text ' + BODY });
  const sent = await confirm.confirm(p.token, { _dialog: { showMessageBox: async () => ({ response: 1 }) } });
  const rc = await require('../src/email-intel/reply/reconcile-send').reconcileSend(sent.attemptId);
  const st = idx.getStatus();
  const probe = await env.transport.probe();
  run = { scan, sent, rc, st, probe, keysBefore, keysAfter: Object.keys(store.REGISTRY), describe: env.tokens.describe() };
}, 60_000);
afterAll(() => { if (env) env.cleanup(); restoreLogSpy(); });

const storeText = () => fs.readdirSync(env.tmp).map((f) => fs.readFileSync(path.join(env.tmp, f), 'utf8')).join('\n');

describe('AC-16 redaction', () => {
  it('AC-16 sentinel token, anchor and cookie values are absent from logs and every store document', () => {
    expect(run.scan.intel.outcome).toBe('complete');
    expect(run.sent.status).toBe('delivery-uncertain');
    const sentinels = [TOKEN, TOKEN_PARTS[1], 'SENTINELTOKENVALUE', ANCHOR, 'sentinel-anchor-1234', COOKIE, 'SENTINELCOOKIE'];
    expect(leaks(sentinels)).toEqual([]);
    const s = storeText();
    for (const x of sentinels) expect(s.includes(x), x).toBe(false);
    for (const x of [run.st, run.probe, run.describe]) { const j = JSON.stringify(x); for (const y of sentinels) expect(j.includes(y), y).toBe(false); }
    expect(Object.keys(run.probe).sort()).toEqual(['latencyMs', 'ok', 'status', 'token', 'transport']);
    expect(Object.keys(run.describe).sort()).toEqual(['hold', 'lastRefreshAt', 'lastResult', 'present', 'rank', 'refreshCount', 'ttlBucket']);
  });

  it('AC-16 logs contain no sentinel address, subject, body, URL or query string', () => {
    const text = logText();
    expect(text).toMatch(/\[email-api\] op=/);                                // the transport did log
    expect(leaks([ADDR, 'Sentinel Person', SUBJ, BODY, '<sentinel-imid@example.test>', 'CONV-1', 'M1?', 'DRAFT-1', 'outlook.cloud.microsoft', '/api/v2.0', 'mailfolders', '$filter', '$select', '?$', 'ConversationId eq'])).toEqual([]);
    expect(text).not.toMatch(MARK_RE);
  });

  it('AC-16 the memStore key set is unchanged after scan, send and reconcile', () => {
    expect(run.keysAfter).toEqual(run.keysBefore);
    const store = require('../src/store');
    const files = new Set(Object.values(store.REGISTRY).map((fn) => { try { return path.basename(fn()); } catch (_) { return null; } }).filter(Boolean));
    const docs = fs.readdirSync(env.tmp).map((f) => f.replace(/\.(bak|tmp)$/, ''));                  // the store's own backup copies
    for (const f of docs) expect(files.has(f), f).toBe(true);
    expect(docs.filter((f) => /^email_intel_/.test(f)).every((f) => /^email_intel_(config|checkpoints|messages|actions|timeline_ledger|staged|sends)\.json$/.test(f))).toBe(true);
  });
});
