// tests/email-intel-ipc.test.js — Phase A IPC: ready-DM prepare/confirm (F-18) and the fail-closed legacy
// send-ready-dm (F2-03), F-19 scan-folder and config validation, set-tz-verified, status, dom-probe masking.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import { createRequire } from 'module';
import * as fx from './fixtures/email-intel-fixture.js';
import { createWorld, warmOk, noSleep } from './fixtures/email-intel/fake-owa.js';
import { inboxRows, snapshot, block, person, ZILA } from './fixtures/email-intel/emails.js';
const require = createRequire(import.meta.url);

let flags; let confirm; let intelIpc; let actions; let electronStub; let intelIndex; let domProbeMod;
const call = (ch, ...a) => fx.rec.handlers[ch]({ sender: {} }, ...a);
const RESULTS = {
  emails: [
    { id: 'em_r1', convId: 'conv/r1=', from: 'shop@example.test', fromName: 'Shop', subject: 'Unit 40456 ready', unitRefs: [{ unit: '40456', operator: 'BETA', update: 'ready for pickup', ready: true }], replyState: 'none' },
    { id: 'em_r2', convId: 'conv/r2=', from: 'shop@example.test', fromName: 'Shop', subject: 'Unit 40123', unitRefs: [{ unit: '40123', operator: 'ACME', update: 'in repair', ready: false }], replyState: 'none' },
  ],
  ranAt: '2026-11-04T15:00:00.000Z', authBlocked: false,
};
const DM = { id: 'em_r1', unit: '40456', message: 'Hi BETA, unit 40456 is ready for pickup.' };

beforeAll(() => {
  fx.installStubs();
  electronStub = require('electron');
  flags = require(path.join(fx.ROOT, 'src/email-intel/flags'));
  confirm = require(path.join(fx.ROOT, 'src/email-intel/confirm'));
  domProbeMod = require(path.join(fx.ROOT, 'src/email-intel/capture/dom-probe'));
});
beforeEach(() => {
  fx.resetWorld({ emailTriageResults: RESULTS, emailTriageConfig: { enabled: true, folders: ['Inbox', 'DOMO'], readyDmSuggested: true } });
  flags._setForTests(null);
  confirm._resetForTests();
  ({ actions } = fx.freshLegacy());
  actions.sendReadyDm = vi.fn(async () => ({ ok: true, message: 'Operator notified.' }));
  fx.freshIpc();
  intelIpc = require(path.join(fx.ROOT, 'src/ipc/email-intel'));
  intelIpc.registerEmailIntelIPC({});
  intelIndex = require(path.join(fx.ROOT, 'src/email-intel'));
  delete electronStub.dialog;
});
afterEach(() => { flags._setForTests(null); confirm._resetForTests(); delete electronStub.dialog; });
const capture = () => flags._setForTests({ enabled: true, capture: true });
const acceptDialog = () => { electronStub.dialog = { showMessageBox: vi.fn(async () => ({ response: 1 })) }; return electronStub.dialog; };

describe('ready DM (F-18, F2-03)', () => {
  it('ready-DM fail-closed: without a native dialog the confirmed send runs nothing', async () => {
    capture();
    const prep = await call('emailIntel:prepare-action', 'send-ready-dm', DM);
    expect(prep).toMatchObject({ ok: true, token: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(prep.summary.headline).toContain('40456');
    expect(await call('emailIntel:confirm-action', prep.token)).toEqual({ ok: false, code: 'DIALOG_UNAVAILABLE' });
    expect(actions.sendReadyDm).not.toHaveBeenCalled();
    expect(await call('emailIntel:confirm-action', prep.token)).toEqual({ ok: false, code: 'TOKEN_USED' });
  });

  it('F-18 ready DM requires token under capture', async () => {
    capture();
    expect(await call('emailTriage:send-ready-dm', 'em_r1', '40456', DM.message)).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' });
    // payload validation mints no token
    expect(await call('emailIntel:prepare-action', 'send-ready-dm', { ...DM, id: 'bad id' })).toEqual({ ok: false, code: 'BAD_ARG', field: 'id' });
    expect(await call('emailIntel:prepare-action', 'send-ready-dm', { ...DM, id: 'em_r2', unit: '40123' })).toEqual({ ok: false, code: 'BAD_ARG', field: 'unit' });   // not ready
    expect(await call('emailIntel:prepare-action', 'send-ready-dm', { ...DM, message: '' })).toEqual({ ok: false, code: 'BAD_ARG', field: 'message' });
    expect(await call('emailIntel:prepare-action', 'send-ready-dm', { ...DM, message: 'x'.repeat(2001) })).toEqual({ ok: false, code: 'BAD_ARG', field: 'message' });
    expect(confirm._liveCount()).toBe(0);
    // cancelled native dialog: token consumed, nothing posted
    electronStub.dialog = { showMessageBox: async () => ({ response: 0 }) };
    const p1 = await call('emailIntel:prepare-action', 'send-ready-dm', DM);
    expect(await call('emailIntel:confirm-action', p1.token)).toEqual({ ok: false, code: 'USER_CANCELLED' });
    expect(actions.sendReadyDm).not.toHaveBeenCalled();
    // accepted native dialog: exactly one post, bookkeeping as the legacy handler did
    const dlg = acceptDialog();
    const p2 = await call('emailIntel:prepare-action', 'send-ready-dm', DM);
    const r = await call('emailIntel:confirm-action', p2.token);
    expect(r).toEqual({ ok: true, message: 'Operator notified.' });
    expect(dlg.showMessageBox).toHaveBeenCalledTimes(1);
    expect(dlg.showMessageBox.mock.calls[0][0]).toMatchObject({ buttons: ['Cancel', 'Send'], cancelId: 0, defaultId: 0 });
    expect(actions.sendReadyDm).toHaveBeenCalledTimes(1);
    expect(actions.sendReadyDm.mock.calls[0][0]).toMatchObject({ unit: '40456', operator: 'BETA' });
    expect(actions.sendReadyDm.mock.calls[0][1]).toBe(DM.message);
    const stored = fx.doc('emailTriageResults').emails.find((e) => e.id === 'em_r1');
    expect(stored.readyDmSent).toBe(true);
    expect(stored.unitRefs[0].readyDmSent).toBe(true);
    expect(await call('emailIntel:confirm-action', p2.token)).toEqual({ ok: false, code: 'TOKEN_USED' });
    expect(actions.sendReadyDm).toHaveBeenCalledTimes(1);
  });

  it('F2-03 legacy send-ready-dm returns CONFIRMATION_REQUIRED under capture and posts nothing', async () => {
    capture();
    const r = await call('emailTriage:send-ready-dm', 'em_r1', '40456', DM.message);
    expect(r).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' });
    expect(actions.sendReadyDm).not.toHaveBeenCalled();
    expect(fx.doc('emailTriageResults').emails[0].readyDmSent).toBeUndefined();
    // flags OFF: the legacy channel is unchanged (renderer confirm, direct post)
    flags._setForTests(null);
    const legacy = await call('emailTriage:send-ready-dm', 'em_r1', '40456', DM.message);
    expect(legacy).toEqual({ ok: true, message: 'Operator notified.' });
    expect(actions.sendReadyDm).toHaveBeenCalledTimes(1);
    // master flag alone (capture not effective) is also legacy
    flags._setForTests({ enabled: true });
    await call('emailTriage:send-ready-dm', 'em_r1', '40456', DM.message);
    expect(actions.sendReadyDm).toHaveBeenCalledTimes(2);
  });

  it('flags OFF: the intel ready-DM channels are inert', async () => {
    expect(await call('emailIntel:prepare-action', 'send-ready-dm', DM)).toEqual({ ok: true, enabled: false });
    expect(await call('emailIntel:confirm-action', '0'.repeat(32))).toEqual({ ok: true, enabled: false });
    expect(await call('emailIntel:status')).toEqual({ ok: true, enabled: false });
  });
});

describe('staged review: get-staged, approve-staged and reject-staged tokens (Phase C)', () => {
  const PHASE_C = { enabled: true, capture: true, multiRecipient: true, actionsView: true, timelineWrites: true };
  let stagedMod;
  function seedStaged() {
    stagedMod = require(path.join(fx.ROOT, 'src/email-intel/facts/staged'));
    const msg = { messageKey: 'mi_0123456789abcdef', conversationKey: 'cv_0123456789abcdef', legacyId: 'em_r2', receivedAt: '2026-11-04T14:30:00.000Z', receivedAtQuality: 'exact', from: { name: 'Dealer Parts Desk', address: 'parts@dealer.example.test' }, body: { status: 'complete' } };
    const doc = stagedMod.ensureDoc({ version: 1 });
    const f = { kind: 'parts_eta', item: 'turbo', value: 'Turbo ETA 11/12', state: 'eta_given', date: '2026-11-12', assertion: 'stated', evidence: 'Turbo ETA 11/12 for 40123', effectiveConfidence: 0.7, caps: [] };
    const low = stagedMod.stage(doc, { fact: f, unit: '40123', msg, reason: 'low-confidence', detail: 'confidence 0.70 is below the threshold', proposedLine: '11/04 Parts ETA: Turbo ETA 11/12 (per Dealer Parts Desk email 11/04) (user-approved) [em:00000000]' }).item;
    const ready = stagedMod.stage(doc, { fact: { kind: 'pickup_readiness', item: null, value: 'Ready for pickup', state: 'ready', date: null, assertion: 'stated', evidence: 'unit 40456 is ready', effectiveConfidence: 0.9 }, unit: '40456', msg, reason: 'conflict-ready', detail: 'canonical status is in_repair', proposedLine: 'x [em:11111111]', canonicalSnapshot: { status: 'in_repair', repairPhase: 'in_repair' } }).item;
    const mention = stagedMod.stage(doc, { fact: null, unit: '40789', msg, reason: 'unprocessed-window', detail: 'part of the email was not analyzed' }).item;
    fx.resetWorld({
      emailTriageResults: RESULTS, emailTriageConfig: { enabled: true, folders: ['Inbox'], autoApplyUnitUpdates: false, readyDmSuggested: true },
      emailIntelStaged: doc, fleetData: { rows: [{ equipmentId: '40123', operator: 'ACME' }, { equipmentId: '40456', operator: 'BETA' }, { equipmentId: '40789', operator: 'ACME' }], syncedAt: new Date(Date.now() - 3_600_000).toISOString() },
      canonicalState: { units: { '40456': { status: 'in_repair' } } },
    });
    return { low, ready, mention };
  }

  it('get-staged pages the open items; inert without timelineWrites or actionsView', async () => {
    seedStaged();
    expect(await call('emailIntel:get-staged', {})).toEqual({ ok: true, enabled: false });
    flags._setForTests({ enabled: true, capture: true, multiRecipient: true });
    expect(await call('emailIntel:get-staged', {})).toEqual({ ok: true, enabled: false });
    flags._setForTests({ enabled: true, capture: true, multiRecipient: true, actionsView: true });       // review visible, writes off
    const r = await call('emailIntel:get-staged', { limit: 2 });
    expect(r).toMatchObject({ ok: true, total: 3, openCount: 3, expiredCount: 0, overCap: false, timelineWrites: false });
    expect(r.items).toHaveLength(2);
    expect(JSON.stringify(r)).not.toContain('parts@dealer');
    for (const bad of [{ limit: 0 }, { limit: 201 }, { offset: -1 }, { state: 'nope' }]) expect((await call('emailIntel:get-staged', bad)).code).toBe('BAD_ARG');
    expect(await call('emailIntel:get-staged', 'x')).toEqual({ ok: false, code: 'BAD_ARG', field: 'payload' });
  });

  it('approve-staged requires a token and an accepted native dialog; TIMELINE_DISABLED without timelineWrites; conflict-ready needs the acknowledgement', async () => {
    const { low, ready, mention } = seedStaged();
    // review on, writes off: approval is refused before any token exists; reject still works
    flags._setForTests({ enabled: true, capture: true, multiRecipient: true, actionsView: true });
    expect(await call('emailIntel:prepare-action', 'approve-staged', { stagedId: low.stagedId })).toEqual({ ok: false, code: 'TIMELINE_DISABLED' });
    expect(confirm._liveCount()).toBe(0);
    flags._setForTests(PHASE_C);
    // payload schema (F-19): nothing is minted on a violation
    for (const [p, field] of [[{}, 'stagedId'], [{ stagedId: 'st_nothex' }, 'stagedId'], [{ stagedId: 'st_' + 'f'.repeat(16) }, 'stagedId'], [{ stagedId: low.stagedId, acknowledgeConflictReady: 'yes' }, 'acknowledgeConflictReady'],
      [{ stagedId: ready.stagedId }, 'acknowledgeConflictReady'], [{ stagedId: mention.stagedId }, 'stagedId']]) {
      expect(await call('emailIntel:prepare-action', 'approve-staged', p)).toEqual({ ok: false, code: 'BAD_ARG', field });
    }
    expect(await call('emailIntel:prepare-action', 'approve-staged', 'x')).toEqual({ ok: false, code: 'BAD_ARG', field: 'payload' });
    expect(confirm._liveCount()).toBe(0);
    // no native dialog in this process: fail closed, nothing written
    const p0 = await call('emailIntel:prepare-action', 'approve-staged', { stagedId: low.stagedId });
    expect(p0).toMatchObject({ ok: true, token: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(p0.summary.headline).toBe('Apply staged update for unit 40123?');
    expect(p0.summary.detailText).toContain('Staged because: low-confidence');
    expect(await call('emailIntel:confirm-action', p0.token)).toEqual({ ok: false, code: 'DIALOG_UNAVAILABLE' });
    expect(fx.doc('notesStore')).toBe('<absent>');
    // accepted dialog: one write through the ledgered writer with the user-approved suffix (autoApply is off in config)
    const dlg = acceptDialog();
    const p1 = await call('emailIntel:prepare-action', 'approve-staged', { stagedId: low.stagedId });
    const r = await call('emailIntel:confirm-action', p1.token);
    expect(r).toMatchObject({ ok: true, state: 'applied' });
    expect(dlg.showMessageBox.mock.calls[0][0]).toMatchObject({ title: 'Apply staged update', buttons: ['Cancel', 'Apply'] });
    expect(fx.doc('notesStore')['40123'].timeline).toMatch(/Turbo ETA 11\/12 \(per Dealer Parts Desk email \d\d\/\d\d\) \(user-approved\) \[em:[0-9a-f]{8}\]$/);
    expect(fx.doc('emailIntelStaged').items[low.stagedId]).toMatchObject({ state: 'approved', decidedBy: 'user' });
    expect(await call('emailIntel:confirm-action', p1.token)).toEqual({ ok: false, code: 'TOKEN_USED' });
    expect(await call('emailIntel:prepare-action', 'approve-staged', { stagedId: low.stagedId })).toEqual({ ok: false, code: 'BAD_ARG', field: 'stagedId' });   // no longer open
    // conflict-ready with the explicit acknowledgement writes the unverified wording
    const p2 = await call('emailIntel:prepare-action', 'approve-staged', { stagedId: ready.stagedId, acknowledgeConflictReady: true });
    expect(p2.summary.detailText).toContain('Warning: canonical state says this unit is not ready');
    expect(await call('emailIntel:confirm-action', p2.token)).toMatchObject({ ok: true, state: 'applied' });
    expect(fx.doc('notesStore')['40456'].timeline).toContain(' - not confirmed in AAP/Relay (user-approved) [em:');
    expect(fx.doc('canonicalState')).toEqual({ units: { '40456': { status: 'in_repair' } } });
  });

  it('reject-staged is a local decision (token, no native dialog) and is allowed with writes off', async () => {
    const { low, mention } = seedStaged();
    flags._setForTests({ enabled: true, capture: true, multiRecipient: true, actionsView: true });
    const p = await call('emailIntel:prepare-action', 'reject-staged', { stagedId: mention.stagedId });
    expect(p.ok).toBe(true);
    expect(await call('emailIntel:confirm-action', p.token)).toEqual({ ok: true, state: 'rejected' });
    expect(fx.doc('emailIntelStaged').items[mention.stagedId]).toMatchObject({ state: 'rejected', decidedBy: 'user' });
    expect(fx.doc('emailIntelStaged').items[low.stagedId].state).toBe('open');
    expect(fx.doc('notesStore')).toBe('<absent>');
    expect(await call('emailIntel:prepare-action', 'reject-staged', { stagedId: mention.stagedId })).toEqual({ ok: false, code: 'BAD_ARG', field: 'stagedId' });
    flags._setForTests(null);
    expect(await call('emailIntel:prepare-action', 'reject-staged', { stagedId: low.stagedId })).toEqual({ ok: true, enabled: false });
  });
});

describe('F-19 scan and config validation', () => {
  it('F-19 scan folders must match configured list', async () => {
    const V = intelIpc.validateScan;
    expect(V({ folders: ['inbox', 'domo', 'Secret Folder'] }, ['Inbox', 'DOMO'])).toEqual({ warnings: ['unknown-folder'], folders: ['Inbox', 'DOMO'] });
    expect(V({ folders: ['Nope'] }, ['Inbox'])).toEqual({ warnings: ['unknown-folder'], folders: undefined });
    for (const bad of [0, 51, 2.5, '5', null]) expect(V({ max: bad }, ['Inbox'])).toEqual({ ok: false, code: 'BAD_ARG', field: 'max' });
    for (const bad of ['Inbox', [], Array(13).fill('Inbox'), [5]]) expect(V({ folders: bad }, ['Inbox'])).toEqual({ ok: false, code: 'BAD_ARG', field: 'folders' });
    expect(V('x', [])).toEqual({ ok: false, code: 'BAD_ARG', field: 'payload' });
    expect(V(undefined, ['Inbox'])).toEqual({ warnings: [] });
    // channel: flags OFF inert; capture on -> runIntelScan gets only configured names
    expect(await call('emailIntel:scan', { folders: ['Inbox'] })).toEqual({ ok: true, enabled: false });
    capture();
    const spy = vi.fn(async () => ({ emails: [], ranAt: 'x', authBlocked: false, readError: null, intel: { outcome: 'complete' } }));
    const real = intelIndex.runIntelScan;
    intelIndex.runIntelScan = spy;
    try {
      const r = await call('emailIntel:scan', { folders: ['domo', 'Evil <script>'], max: 7 });
      expect(spy).toHaveBeenCalledWith({ max: 7, folders: ['DOMO'] }, 'manual');
      expect(r.warnings).toEqual(['unknown-folder']);
      await call('emailIntel:scan', { folders: ['Nope'] });
      expect(spy.mock.calls[1][0]).toEqual({ max: undefined, folders: undefined });
      expect(await call('emailIntel:scan', { max: 99 })).toEqual({ ok: false, code: 'BAD_ARG', field: 'max' });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { intelIndex.runIntelScan = real; }
  });

  it('F-19 config: get/set-config validate, cap the payload, never set the probe-only fields, never auto-apply the suggestion', async () => {
    expect(await call('emailIntel:get-config')).toEqual({ ok: true, enabled: false });
    capture();
    const g = await call('emailIntel:get-config');
    expect(g.ok).toBe(true);
    expect(g.config.me.names).toEqual([]);
    expect(typeof g.suggestions.alias).toBe('string');
    const big = await call('emailIntel:set-config', { banners: Array.from({ length: 20 }, () => 'y'.repeat(2000)) });
    expect(big).toEqual({ ok: false, code: 'BAD_ARG', field: 'config', error: 'too large' });
    expect(fx.doc('emailIntelConfig')).toBe('<absent>');
    expect(await call('emailIntel:set-config', { me: { addresses: ['nope'] } })).toMatchObject({ ok: false, code: 'BAD_ARG', field: 'me.addresses' });
    expect(fx.doc('emailIntelConfig')).toBe('<absent>');
    const ok = await call('emailIntel:set-config', { me: { names: ['Zila Santiago'] }, minConfidence: 0.5, mailboxTzVerified: true, caps: { maxEmails: 500 } });
    expect(ok.ok).toBe(true);
    expect(ok.warnings).toEqual(expect.arrayContaining(['minConfidence-reset', 'clamped-caps.maxEmails']));
    const stored = fx.doc('emailIntelConfig');
    expect(stored).toMatchObject({ version: 1, minConfidence: 0.75, mailboxTzVerified: false, me: { names: ['Zila Santiago'] }, caps: { maxEmails: 50 } });
    expect((await call('emailIntel:get-config')).config.me.names).toEqual(['Zila Santiago']);
  });

  it('set-tz-verified accepts only a fresh probe result whose tz.match is true', async () => {
    capture();
    expect(await call('emailIntel:set-tz-verified', { probeId: 'nope' })).toEqual({ ok: false, code: 'BAD_ARG', field: 'probeId' });
    const id = 'pr_' + '0123456789abcdef';
    expect(await call('emailIntel:set-tz-verified', { probeId: id })).toEqual({ ok: false, code: 'PROBE_UNKNOWN' });
    domProbeMod._setLastForTests({ probeId: id, at: Date.now(), match: false });
    expect(await call('emailIntel:set-tz-verified', { probeId: id })).toEqual({ ok: false, code: 'TZ_MISMATCH' });
    domProbeMod._setLastForTests({ probeId: id, at: Date.now() - 11 * 60_000, match: true });
    expect(await call('emailIntel:set-tz-verified', { probeId: id })).toEqual({ ok: false, code: 'PROBE_EXPIRED' });
    domProbeMod._setLastForTests({ probeId: id, at: Date.now(), match: true });
    expect(await call('emailIntel:set-tz-verified', { probeId: id })).toEqual({ ok: true, mailboxTzVerified: true });
    expect(fx.doc('emailIntelConfig').mailboxTzVerified).toBe(true);
    expect(await call('emailIntel:set-tz-verified', { probeId: id })).toEqual({ ok: false, code: 'PROBE_UNKNOWN' });   // single use
  });

  it('status is the real document under capture (identity warnings, no values)', async () => {
    capture();
    const s = await call('emailIntel:status');
    expect(s).toMatchObject({ ok: true, enabled: true, identity: { set: false }, owaAuth: { state: 'unknown' } });
    expect(s.warnings).toEqual(expect.arrayContaining(['identity-not-set', 'fas-name-not-set']));
    expect(await call('emailIntel:dom-probe', { n: 9 })).toEqual({ ok: false, code: 'BAD_ARG', field: 'n' });
    expect(await call('emailIntel:probe-lane')).toMatchObject({ ok: false, lane: { state: 'unavailable' } });   // implemented in Phase B
  });
});

describe('dom-probe (read-only, masked)', () => {
  it('returns counts and masked addresses only, never body text, and arms set-tz-verified only on a zone match', async () => {
    const rows = inboxRows('Inbox', 3);
    const snap = snapshot({ blocks: [block({ text: 'BODY-SENTINEL secret body text', to: [ZILA, person(4)], time: '2026-11-04T14:30:00-05:00' })] });
    // a matching wall-clock title next to the explicit instant (machine zone)
    const local = new Date(Date.parse('2026-11-04T19:30:00.000Z'));
    const pad = (n) => String(n).padStart(2, '0');
    snap.blocks[0].timeCandidates[0].title = (local.getMonth() + 1) + '/' + local.getDate() + '/' + local.getFullYear() + ' ' + pad(local.getHours()) + ':' + pad(local.getMinutes());
    const { electron } = createWorld({ Inbox: { rows, snapshots: { [rows[0].convId]: snap } } });
    const out = await domProbeMod.domProbe({ n: 2, _electron: electron, _warm: warmOk, _sleep: noSleep, authGraceMs: 20 });
    expect(out.ok).toBe(true);
    expect(out.probeId).toMatch(/^pr_[0-9a-f]{16}$/);
    const text = JSON.stringify(out);
    expect(text).not.toContain('BODY-SENTINEL');
    expect(text).not.toContain('zila.santiago@example.test');
    expect(out.messages[0].captures[0].to).toEqual(['z***@example.test', 'p***@example.test']);
    expect(out.messages[0].captures[0].from).toBe('p***@dealer.example.test');
    expect(out.tz).toMatchObject({ compared: 1, match: true });
    expect(domProbeMod.consumeTzProbe(out.probeId)).toEqual({ ok: true });
  });
});
