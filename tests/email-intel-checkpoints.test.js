// tests/email-intel-checkpoints.test.js — R1.7 per-folder checkpoints on disk, R1.2 reply state never
// inherited by a new reply, restart / crash simulation, rotation, newer-version stores (NFR-3).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { inboxRows, rowDesc, snapshot, block } from './fixtures/email-intel/emails.js';
import { makeHarness } from './fixtures/email-intel/scan-harness.js';
const require = createRequire(import.meta.url);
const store = require('../src/store');

let h = null;
afterEach(() => { if (h) h.cleanup(); h = null; });
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(h.tmp, f), 'utf8'));

describe('R1.7 checkpoints', () => {
  it('R1.7 per-folder checkpoint survives reload: rows, rotation, scan.last and owaAuth are on disk and honored by a fresh module load', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 6), DOMO: inboxRows('DOMO', 3) });
    await h.run({ max: 25 });
    const disk = readJson('email_intel_checkpoints.json');
    expect(disk.version).toBe(1);
    expect(Object.keys(disk.folders.Inbox.seenRows)).toHaveLength(6);
    expect(Object.keys(disk.folders.DOMO.seenRows)).toHaveLength(3);
    expect(disk.folders.Inbox).toMatchObject({ backlog: false, lastOutcome: 'ok' });
    expect(disk.folders.Inbox.lastOkAt).toEqual(expect.any(String));
    expect(disk.folders.Inbox.newestReceivedAt).toBe('2026-11-04T19:30:00.000Z');
    expect(disk.rotation).toBe(1);
    expect(disk.scan.current).toBeNull();
    expect(disk.scan.last).toMatchObject({ outcome: 'complete', partial: false, trigger: 'manual' });
    expect(disk.owaAuth.state).toBe('ok');
    expect(readJson('email_intel_messages.json').version).toBe(1);
    // Simulated restart: drop every email-intel module from the require cache and scan again.
    for (const k of Object.keys(require.cache)) if (/[\\/]src[\\/]email-intel[\\/]/.test(k)) delete require.cache[k];
    const flags = require('../src/email-intel/flags');
    flags._setForTests({ enabled: true, capture: true });
    const idx = require('../src/email-intel/index');
    const before = h.world.openLog.length;
    const res = await idx.runIntelScan({ folders: ['Inbox', 'DOMO'], _electron: h.electron, _warm: async () => ({}), _sleep: async () => {}, authGraceMs: 20, _triageEmails: h.triage }, 'manual');
    expect(h.world.openLog.length).toBe(before);                 // nothing re-opened after the restart
    expect(res.intel.outcome).toBe('complete');
  });

  it('a crash after the first committed batch keeps that batch; the next scan does not re-open it', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 8) });
    const realCapture = require('../src/email-intel/capture/owa_capture');
    let crashed = false;
    const res = await h.run({
      max: 25,
      _readMailbox: async (o) => realCapture.readMailbox(Object.assign({}, o, {
        onBatch: async (folder, items) => { await o.onBatch(folder, items); if (!crashed) { crashed = true; throw new Error('simulated crash after commit'); } },
      })),
    });
    expect(res.intel.outcome).not.toBe('complete');
    expect(h.ck().scan.current).toBeNull();
    const committed = Object.keys(h.ck().folders.Inbox.seenRows).length;
    expect(committed).toBe(5);
    expect(Object.keys(h.msgs().messages)).toHaveLength(5);
    const before = h.world.openLog.length;
    await h.run({ max: 25 });
    expect(h.world.openLog.length - before).toBe(3);             // only the 3 rows that were never committed
    expect(Object.keys(h.msgs().messages)).toHaveLength(8);
  });

  it('a reader that throws ends the scan failed, clears scan.current and keeps the previous results', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 2) });
    await h.run({ max: 25 });
    const prev = store.load('emailTriageResults', null);
    const res = await h.run({ _readMailbox: async () => { throw new Error('boom'); } });
    expect(res.intel.outcome).toBe('failed');
    expect(res.readError).toBe('read failed');
    expect(res.emails.map((e) => e.id).sort()).toEqual(prev.emails.map((e) => e.id).sort());
    expect(h.ck().scan.current).toBeNull();
    expect(h.ck().scan.last.outcome).toBe('failed');
  });

  it('NFR-3 a store written by a newer build is read-only: the scan refuses and writes nothing', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 2) });
    fs.writeFileSync(path.join(h.tmp, 'email_intel_messages.json'), JSON.stringify({ version: 2, messages: {}, byConv: {} }));
    const res = await h.run({ max: 25 });
    expect(res.intel).toMatchObject({ outcome: 'failed', errorCode: 'store-newer-version' });
    expect(h.world.openLog).toHaveLength(0);
    expect(readJson('email_intel_messages.json').version).toBe(2);
    expect(h.idx.getStatus().warnings).toContain('storeVersionNewer');
  });
});

describe('R1.2 new replies start fresh', () => {
  it('R1.2 new reply does not inherit applied state, drafts or kept; uncertain reply state carries', async () => {
    const rows = inboxRows('Inbox', 2);
    const cid = rows[0].convId;
    h = makeHarness({ Inbox: { rows, snapshots: { [cid]: snapshot({ blocks: [block({ text: 'Turbo ETA 11/12 for 40456.', convId: cid, itemId: 'm1', time: '2026-11-04T09:00:00-05:00' })] }) } } });
    await h.run({ max: 25 });
    const id0 = store.load('emailTriageResults', null).emails.find((e) => e.convId === cid).id;
    const patch = (fields) => { const r = store.load('emailTriageResults', null); const i = r.emails.findIndex((e) => e.id === id0); r.emails[i] = { ...r.emails[i], ...fields }; store.save('emailTriageResults', r); };
    patch({ replyState: 'drafted', replyDraft: 'my draft', unitUpdateApplied: true, kept: true, readyDmSent: true });
    // A rescan with no new message keeps the user's state.
    h.world.folders.Inbox.rows = inboxRows('Inbox', 2);
    await h.run({ max: 25 });
    expect(store.load('emailTriageResults', null).emails.find((e) => e.id === id0)).toMatchObject({ replyState: 'drafted', replyDraft: 'my draft', unitUpdateApplied: true, kept: true });
    // A new reply in the same conversation: new message key, fresh legacy state.
    h.world.folders.Inbox.rows[0] = rowDesc({ i: 0, convId: cid, folder: 'inbox', from: 'Inbox Sender', subject: 'Status Inbox 0', preview: 'Updated ETA 11/14' });
    h.world.folders.Inbox.snapshots[cid] = snapshot({ blocks: [
      block({ text: 'Turbo ETA 11/12 for 40456.', convId: cid, itemId: 'm1', time: '2026-11-04T09:00:00-05:00' }),
      block({ text: 'Updated: turbo ETA is now 11/14 for 40456.', convId: cid, itemId: 'm2', time: '2026-11-05T09:00:00-05:00' }),
    ] });
    await h.run({ max: 25 });
    const rec = store.load('emailTriageResults', null).emails.find((e) => e.id === id0);
    expect(rec).toMatchObject({ replyState: 'none', replyDraft: '', unitUpdateApplied: false, kept: false, readyDmSent: false });
    expect(rec.intel).toMatchObject({ messageCount: 2 });
    const conv = Object.values(h.msgs().messages).filter((m) => m.convIdRaw === cid);
    expect(conv).toHaveLength(2);
    expect(new Set(conv.map((m) => m.messageKey)).size).toBe(2);
    expect(new Set(conv.map((m) => m.conversationKey)).size).toBe(1);
    expect(rec.intel.latestMessageKey).toBe(conv.find((m) => m.itemId === 'm2').messageKey);
    // replyState 'uncertain' carries across a new reply until the send is reconciled.
    patch({ replyState: 'uncertain', replyDraft: 'sent?' });
    h.world.folders.Inbox.rows[0] = rowDesc({ i: 0, convId: cid, folder: 'inbox', from: 'Inbox Sender', subject: 'Status Inbox 0', preview: 'Third message' });
    h.world.folders.Inbox.snapshots[cid].blocks.push(block({ text: 'Third: confirmed 11/14.', convId: cid, itemId: 'm3', time: '2026-11-06T09:00:00-05:00' }));
    await h.run({ max: 25 });
    expect(store.load('emailTriageResults', null).emails.find((e) => e.id === id0).replyState).toBe('uncertain');
  });
});
