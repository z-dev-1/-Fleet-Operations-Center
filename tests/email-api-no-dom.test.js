// tests/email-api-no-dom.test.js — AC-1 / I-8: with apiTransport effective no Email Triage path reaches a DOM entry
// point, in success and in every failure mode (no DOM fallback). FR-3.6: the ready-DM still goes to Slack.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { apiEnv, createFakeNet, fakeTokens } from './fixtures/email-api/fake-net.js';
import { restMessage, mailboxRoutes, mailServerRoutes, WK } from './fixtures/email-api/rest-messages.js';
import { stubTriage } from './fixtures/email-intel/scan-harness.js';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const handlers = {};
const electronStub = { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, BrowserWindow: { getAllWindows: () => [] }, dialog: { showMessageBox: async () => ({ response: 1 }) } };
const slackCalls = [];
function inject(rel, exportsObj) {
  const p = rel === 'electron' ? require.resolve('electron') : require.resolve(path.join(ROOT, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}
beforeAll(() => {
  inject('electron', electronStub);
  inject('src/scrapers/slack_send', { sendToChannel: async (ch, body) => { slackCalls.push([ch, body.length]); return { ok: true }; } });
  inject('src/scrapers/pm_alert_reply', { resolveOperatorEntry: () => ({ channelId: 'C-OPS', operator: 'ACME' }) });
});
const call = (ch, ...a) => handlers[ch]({ sender: {} }, ...a);

const DOM = [
  ['src/email-intel/capture/owa_capture', ['openSession', 'readMailbox']],
  ['src/scrapers/owa_reader', ['readInbox', 'probeInbox', 'deleteMessage']],
  ['src/scrapers/owa-mailer', ['sendViaOwa', 'warmOwaSession', '_verifySentItems']],
  ['src/email-intel/reply/owa_reply', ['sendThreadReply']],
  ['src/email-intel/attach/fetch', ['fetchAttachment']],
  ['src/email-intel/capture/dom-probe', ['domProbe']],
];
let spies = [];
function spyDom() {
  spies = [];
  for (const [rel, names] of DOM) {
    const m = require(path.join(ROOT, rel));
    for (const n of names) spies.push([rel + '.' + n, vi.spyOn(m, n).mockImplementation(async () => { throw new Error('DOM entry point reached: ' + n); })]);
  }
}
const domCalls = () => spies.filter(([, s]) => s.mock.calls.length).map(([n]) => n);

const ORIG = restMessage({ Id: 'M1', ConversationId: 'CONV-1', InternetMessageId: '<m1@example.test>', ReceivedDateTime: new Date(Date.now() - 3600_000).toISOString().replace(/\.\d+Z$/, 'Z'), ParentFolderId: WK.inbox, HasAttachments: true });
let env;
function boot(o) {
  const x = o || {};
  const world = { msgs: [ORIG], atts: { M1: [{ '@odata.type': '#Microsoft.OutlookServices.FileAttachment', Id: 'A1', Name: 'estimate.pdf', Size: 100 }] } };
  const server = { originals: { M1: ORIG }, conv: { 'CONV-1': ['M1'] } };
  const routes = x.routes || [{ method: 'GET', re: /\/attachments\/A1$/, respond: () => ({ status: 200, json: { ContentBytes: Buffer.from('%PDF').toString('base64') } }) }].concat(mailServerRoutes(server), mailboxRoutes(world));
  const timers = { setTimeout: (f, ms) => setTimeout(f, ms >= 20_000 ? 400 : ms), clearTimeout: (t) => clearTimeout(t) };
  env = apiEnv({ flags: x.flags || { effective: { capture: true, apiTransport: true } }, routes, tokens: x.tokens, httpOpts: { timers } });
  require('../src/email-intel/reliability/lock')._reset();
  spyDom();
  return env;
}
afterEach(() => { vi.restoreAllMocks(); if (env) env.cleanup(); env = null; });
const scanOpts = () => ({ folders: ['Inbox'], _transport: env.transport.deps(), _triageEmails: stubTriage() });

describe('AC-1 no DOM fallback', () => {
  it('AC-1 zero DOM entry-point calls across every Email Triage path and failure mode', async () => {
    const E = require('../src/email-intel/transport/errors');
    const modes = {
      ok: {},
      'auth 401x2': { routes: [{ re: /./, respond: () => ({ status: 401 }) }] },
      'http 500': { routes: [{ re: /./, respond: () => ({ status: 500 }) }] },
      timeout: { routes: [{ re: /./, respond: () => ({ hang: true }) }] },
      'throttle 429': { routes: [{ re: /./, respond: () => ({ status: 429 }) }] },
      'token window wall': { tokens: fakeTokens({ getAuthError: () => new E.ApiAuthBlockedError() }) },
    };
    for (const [name, o] of Object.entries(modes)) {
      boot(o);
      const idx = require('../src/email-intel/index');
      const scan = await idx.runIntelScan(scanOpts(), 'manual');
      expect(scan && scan.intel, name).toBeTruthy();
      await idx.scheduledTick({ signal: new AbortController().signal }, {}, { _scanOpts: scanOpts() }).catch(() => {});
      // the chat route (email_triage.runTriage) goes through the intel scan
      await require('../src/scrapers/email_triage').runTriage(scanOpts()).catch(() => {});
      // attachments flag on: the API fetchOne, never attach/fetch
      env.flags._setForTests({ effective: { capture: true, attachments: true, apiTransport: true } });
      await idx.runIntelScan(Object.assign(scanOpts(), { _attachDeps: { extractItem: async () => ({ status: 'read', kind: 'pdf', text: 'x' }) } }), 'manual').catch(() => {});
      env.flags._setForTests({ effective: { capture: true, threadReplies: true, actionsView: true, apiTransport: true } });
      // sends in all modes, reconcile, deletes
      const confirm = require('../src/email-intel/confirm');
      const executors = require('../src/email-intel/executors');
      confirm._resetForTests(); executors.registerAll();
      const rec = env.addApi(ORIG);
      require('../src/store').save('emailTriageResults', { emails: [{ id: rec.legacyId, convId: rec.convIdRaw, from: 'shop@example.test', fromName: 'Shop Desk', subject: 'x', deleteSuggested: true, intel: { conversationKey: rec.conversationKey, latestMessageKey: rec.messageKey } }] });
      for (const mode of ['reply', 'reply-all', 'new-message']) {
        env.guard._resetForTests();
        const p = confirm.prepare('send-reply', { conversationKey: rec.conversationKey, mode, bodyText: 'Thanks' });
        if (p.ok) await confirm.confirm(p.token, { _dialog: electronStub.dialog });
        for (const a of env.guard.list({ limit: 10 })) if (['delivery-uncertain', 'unconfirmed-not-found'].includes(a.state)) await require('../src/email-intel/reply/reconcile-send').reconcileSend(a.attemptId).catch(() => {});
        env.stores.update('sends', (d) => { d.attempts = {}; return d; });
      }
      const pd = confirm.prepare('delete', { conversationKey: rec.conversationKey });
      if (pd.ok) await confirm.confirm(pd.token, { _dialog: electronStub.dialog });
      // legacy channels and probes
      env.flags._setForTests({ effective: { capture: true, apiTransport: true } });
      vi.spyOn(require('../src/scrapers/email_triage'), 'startAutoScan').mockImplementation(() => {});
      require('../src/ipc/email-triage').registerEmailTriageIPC({});
      require('../src/ipc/email-intel').registerEmailIntelIPC({});
      require('../src/store').save('emailTriageResults', { emails: [{ id: rec.legacyId, convId: rec.convIdRaw, from: 'shop@example.test', subject: 'x', deleteSuggested: true, replyDraft: 'Thanks', intel: { conversationKey: rec.conversationKey, latestMessageKey: rec.messageKey } }] });
      env.stores.update('sends', (d) => { d.attempts = {}; return d; });
      await call('emailTriage:send-reply', rec.legacyId, 'Thanks').catch(() => {});
      await call('emailTriage:delete', rec.legacyId).catch(() => {});
      await call('emailTriage:delete-suggested').catch(() => {});
      await call('emailTriage:probe').catch(() => {});
      await call('emailIntel:dom-probe', {}).catch(() => {});
      await call('emailIntel:set-tz-verified', { probeId: 'pr_0123456789abcdef' }).catch(() => {});
      expect(domCalls(), name).toEqual([]);
      expect(env.fn.calls.every((c) => c.host === 'outlook.cloud.microsoft'), name).toBe(true);
      vi.restoreAllMocks();
      env.cleanup(); env = null;
    }
  }, 180_000);

  it('FR-3.6 ready-DM still posts through slack_send.sendToChannel under apiTransport', async () => {
    boot();
    const confirm = require('../src/email-intel/confirm');
    const executors = require('../src/email-intel/executors');
    confirm._resetForTests(); executors.registerAll();
    require('../src/store').save('emailTriageResults', { emails: [{ id: 'em_r1', unitRefs: [{ unit: '40456', operator: 'ACME', ready: true }] }] });
    slackCalls.length = 0;
    const p = confirm.prepare('send-ready-dm', { id: 'em_r1', unit: '40456', message: 'Unit 40456 is ready for pickup.' });
    const r = await confirm.confirm(p.token, { _dialog: electronStub.dialog });
    expect(r.ok).toBe(true);
    expect(slackCalls).toEqual([['C-OPS', 'Unit 40456 is ready for pickup.'.length]]);
    expect(domCalls()).toEqual([]);
    expect(env.fn.calls).toHaveLength(0);                                    // no email request for a Slack DM
  });
});
