// tests/email-api-flag-off-parity.test.js — AC-19 / I-9: with email.intel.apiTransport OFF (capture ON, and all OFF)
// the DOM build is unchanged: no transport file is loaded, the six-key effective block, the same reader options,
// no new record / checkpoint / attempt fields, and the R4-M1 / R4-L12 call sites keep today's behavior.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { inboxRows } from './fixtures/email-intel/emails.js';
import { makeHarness, stubTriage } from './fixtures/email-intel/scan-harness.js';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const transportLoaded = () => Object.keys(require.cache).filter((k) => /[\\/]src[\\/]email-intel[\\/]transport[\\/]/.test(k));
let h = null;
afterEach(() => { vi.restoreAllMocks(); if (h) h.cleanup(); h = null; });

describe('flag OFF parity', () => {
  it('AC-19 flag OFF loads no transport module and calls DOM entry points as before', async () => {
    const pf = require('../src/config/perf-flags');
    expect(Object.keys(pf.resolveEmailIntelFlags({ email: { intel: { enabled: true, capture: true } } }, {}).effective).sort()).toEqual(['actionsView', 'attachments', 'capture', 'multiRecipient', 'threadReplies', 'timelineWrites']);
    h = makeHarness({ Inbox: inboxRows('Inbox', 2) });
    const owaCapture = require('../src/email-intel/capture/owa_capture');
    const spy = vi.spyOn(owaCapture, 'readMailbox');
    const res = await h.run();
    expect(res.emails.length).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0][0];
    for (const k of ['apiCursors', 'isKnownSeed', 'onApiCursor', '_transport']) expect(opts).not.toHaveProperty(k);
    expect(transportLoaded()).toEqual([]);
    const st = h.idx.getStatus();
    expect(st.flags).not.toHaveProperty('apiTransport');
    expect(st).not.toHaveProperty('api');
    // executors / reconcile / IPC paths under the DOM build load no transport file either
    const executors = require('../src/email-intel/executors');
    const doc = h.msgs();
    const ck = Object.keys(doc.byConv)[0];
    executors.validateSendReply({ conversationKey: ck, mode: 'reply', bodyText: 'x' });
    executors.deleteTarget(ck);
    await require('../src/email-intel/reply/reconcile-send').reconcileSend('sa_0123456789abcdef');
    expect(transportLoaded()).toEqual([]);
  });

  it('AC-19 flag OFF writes no new record, checkpoint or attempt field', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 3) });
    await h.run();
    const doc = h.msgs();
    expect(doc).not.toHaveProperty('convAliasIndex');
    for (const r of Object.values(doc.messages)) for (const k of ['source', 'internetMessageId', 'apiConversationId', 'zoneExplicit']) expect(r).not.toHaveProperty(k);
    for (const f of Object.values(h.ck().folders)) expect(f).not.toHaveProperty('api');
    const guard = require('../src/email-intel/reply/send-guard');
    const c = guard.createAttempt({ conversationKey: 'cv_0123456789abcdef', mode: 'reply', mechanism: 'owa-thread', marker: 'FOC-1' });
    expect(c.attempt).not.toHaveProperty('transport');
    expect(c.attempt).not.toHaveProperty('apiRef');
  });

  it('the re-extract targets handed to the DOM reader carry no itemId key', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 1) });
    h.flags._setForTests({ effective: { capture: true, attachments: true } });
    h.stores.update('messages', (d) => {
      d.messages = { md_a: { messageKey: 'md_a', messageIdSource: 'derived', conversationKey: 'cv_a', convIdRaw: 'CONV/A=', convIdSource: 'owa', folder: 'Inbox', itemId: 'x', receivedAt: null, ingestedAt: new Date().toISOString(),
        attachments: [{ name: 'a.pdf', ext: 'pdf', analysis: { status: 'pending-reextract' } }], analysis: { status: 'pending' }, body: { newContent: '' } } };
      d.byConv = { cv_a: ['md_a'] };
      return d;
    });
    let seen = null;
    const reader = async (o) => { seen = o; return { ok: true, authBlocked: false, folders: [{ folder: 'Inbox', status: 'ok' }], opened: 0, rowsExamined: 0 }; };
    await h.idx.runIntelScan({ folders: ['Inbox'], _readMailbox: reader, _triageEmails: stubTriage() }, 'manual');
    expect(seen.reextract).toHaveLength(1);
    expect(seen.reextract[0]).not.toHaveProperty('itemId');
    expect(transportLoaded()).toEqual([]);
  });

  it('R4-M1 flag OFF: validateSendReply and deleteTarget still use the last record', () => {
    h = makeHarness({ Inbox: [] });
    const ledger = require('../src/email-intel/ingest/ledger');
    const ck = 'cv_0123456789abcdef';
    h.stores.update('messages', (d) => {
      ledger.ensureDoc(d);
      d.messages = {
        mi_api: { messageKey: 'mi_api', messageIdSource: 'owa-item', source: 'api', itemId: 'ID', apiConversationId: 'CONV-1', conversationKey: ck, convIdRaw: 'CONV/1', convIdSource: 'owa', folder: 'Inbox',
          from: { name: 'Shop', address: 'shop@example.test' }, to: [], cc: [], recipientsKnown: true, receivedAt: '2026-11-07T08:00:00.000Z', ingestedAt: '2026-11-07T08:00:00.000Z', legacyId: 'em_1', body: { newContent: 'a' }, analysis: { status: 'pending' } },
        md_dom: { messageKey: 'md_dom', messageIdSource: 'derived', conversationKey: ck, convIdRaw: 'CONV/1', convIdSource: 'owa', folder: 'Archive', from: { name: 'Other', address: null }, to: [], cc: [],
          recipientsKnown: false, receivedAt: null, ingestedAt: '2026-11-07T09:00:00.000Z', legacyId: 'em_1', body: { newContent: 'b' }, analysis: { status: 'pending' } },
      };
      d.byConv = { [ck]: ['mi_api', 'md_dom'] };
      return d;
    });
    const executors = require('../src/email-intel/executors');
    const v = executors.validateSendReply({ conversationKey: ck, mode: 'reply', bodyText: 'x' });
    expect(v.ok).toBe(true);
    expect(v.latest.messageKey).toBe('md_dom');                                // today's "last record"
    expect(v.mechanism).toBe('owa-thread');
    const t = executors.deleteTarget(ck);
    expect(t.target.folder).toBe('Archive');
    expect(t.target).not.toHaveProperty('apiConversationId');
  });

  it('R4-L12 the executors.js fallback line is unchanged from base', () => {
    let base = null;
    try { base = execFileSync('git', ['show', '4c0e1f4:src/email-intel/executors.js'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { base = null; }
    if (base == null) return;                                                   // git unavailable: skip
    const line = base.split(/\r?\n/).find((l) => l.includes("out.fallback = 'new-message'"));
    expect(line).toBeTruthy();
    const now = fs.readFileSync(path.join(ROOT, 'src/email-intel/executors.js'), 'utf8').split(/\r?\n/);
    expect(now).toContain(line);
    expect(base.split(/\r?\n/).indexOf(line) + 1).toBe(549);
  });

  it('the legacy carry-over call sites give today\'s results for DOM records', () => {
    const adapter = require('../src/email-intel/ingest/legacy-adapter');
    const latest = { messageKey: 'md_new', legacyId: 'em_1', body: {}, from: {}, aliases: ['md_old'] };       // a DOM record: no source
    const view = { conversationKey: 'cv_1', records: [latest] };
    const out = (prev, triaged) => adapter.buildResults({ prev: { emails: prev ? [prev] : [] }, views: [view], triaged: triaged ? { em_1: { id: 'em_1' } } : {}, now: Date.now() }).emails;
    expect(out(undefined, true)[0].replyState).toBe('none');
    expect(out({ id: 'em_1', replyState: 'drafted' }, true)[0].replyState).toBe('drafted');                            // prev without intel
    expect(out({ id: 'em_1', replyState: 'drafted', intel: { latestMessageKey: 'md_new' } }, true)[0].replyState).toBe('drafted');
    expect(out({ id: 'em_1', replyState: 'drafted', intel: { latestMessageKey: 'md_old' } }, true)[0].replyState).toBe('none');   // aliases do not count for DOM
    expect(out({ id: 'em_1', replyState: 'drafted', intel: { latestMessageKey: 'md_old' } }, false)[0].intel).toEqual({ latestMessageKey: 'md_old' });   // :143 keeps the stale prev untouched
    expect(adapter.sameLatest('md_old', latest)).toBe(false);
  });
});
