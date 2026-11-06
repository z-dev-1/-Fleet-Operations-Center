// tests/email-intel-restart.test.js — restart persistence (design 5.8, 8.8; R8.3, AC-4). FEAT-005 covers the
// My Email Actions part: action items and question states live in emailIntelActions on disk, survive a process
// restart (fresh modules), keep identical ids, keep user state (dismissed) and are not re-notified.
// FEAT-008 extends this file with staged items, send attempts, ledger, checkpoints and NFR-3 read-only.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { phaseCWorld, fact, fakeReader, T0, PHASE_C } from './fixtures/email-intel/phase-c.js';
import { DEALER, COWORKER, ZILA } from './fixtures/email-intel/emails.js';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 30_000 });                 // scan-level tests: many store writes on slow Windows temp dirs

function freshModules() {
  // A restart: every email-intel module is loaded again (module state gone); the stores are re-read from disk.
  for (const k of Object.keys(require.cache)) if (/[\\/]src[\\/]email-intel[\\/]/.test(k)) delete require.cache[k];
  return {
    flags: require('../src/email-intel/flags'), lane: require('../src/email-intel/understand/lane'),
    idx: require('../src/email-intel/index'), lock: require('../src/email-intel/reliability/lock'), stores: require('../src/email-intel/stores'),
  };
}

describe('AC-4 / R8.3 restart safety (FEAT-008, design 8.8)', () => {
  let w = null; let m2 = null;
  afterEach(() => { if (m2) { m2.flags._setForTests(null); m2.lane._resetForTests(); m2.lock._reset(); } m2 = null; if (w) w.cleanup(); w = null; });
  const DAY = 86_400_000;
  const FULL = Object.assign({}, PHASE_C, { threadReplies: true });

  async function seededWorld() {
    w = phaseCWorld(FULL);
    w.rules.push({ unit: '40123', fact: fact() });                                                     // applied
    w.rules.push({ unit: '40456', fact: fact({ item: 'brake pads', value: 'Brake pads ETA 11/20', date: '2026-11-20', evidence: 'Brake pads ETA 11/20 for 40456', confidence: 0.5 }) });   // staged low-confidence
    w.questions.push({ when: 'can you confirm pickup', q: { ref: 'q1', text: 'Can you confirm pickup Friday for 40789?', about: ['40789'], addressee: { kind: 'me', name: 'Zila', evidence: 'Zila, can you confirm pickup' }, isApprovalOrDecision: false, confidence: 0.9 } });
    const caps = [
      w.cap({ from: DEALER, to: [ZILA, COWORKER], subject: 'Turbo 40123', conversationId: 'conv-b1', messageId: 'b-1', body: 'Turbo ETA 11/12 for 40123' }),
      w.cap({ from: DEALER, to: [ZILA], subject: 'Brakes 40456', conversationId: 'conv-b2', messageId: 'b-2', body: 'Brake pads ETA 11/20 for 40456' }),
      w.cap({ from: DEALER, to: [ZILA], subject: 'Pickup 40789', conversationId: 'conv-b3', messageId: 'b-3', body: 'Zila, can you confirm pickup Friday for 40789?' }),
    ];
    await w.scan(caps);
    expect(w.lines('40123')).toHaveLength(1);
    expect(w.staged().filter((s) => s.state === 'open').length).toBeGreaterThanOrEqual(1);
    expect(w.open('reply').length).toBe(1);
    return caps;
  }

  function simulateCrash() {
    const now = Date.now();
    const guard = require('../src/email-intel/reply/send-guard');
    const msgs = w.messages();
    const ckA = Object.values(msgs).find((m) => m.convIdRaw === 'conv-b1').conversationKey;
    const ckB = Object.values(msgs).find((m) => m.convIdRaw === 'conv-b3').conversationKey;
    const sending = guard.createAttempt({ conversationKey: ckA, mode: 'reply', mechanism: 'owa-thread', to: [DEALER] }).attempt;
    guard.markSending(sending.attemptId);                                                                // the app died after the Send click
    const preparing = guard.createAttempt({ conversationKey: ckB, mode: 'reply', mechanism: 'owa-thread', to: [DEALER] }, { now: now - 11 * 60_000 }).attempt;
    const fresh = guard.createAttempt({ conversationKey: 'ck-fresh', mode: 'reply', mechanism: 'owa-thread', to: [DEALER] }).attempt;   // preparing, 0 min old
    // a timeline write whose ledger entry was still pending when the app died (the line itself landed)
    w.stores.update('ledger', (doc) => {
      const e = Object.values(doc.entries).find((x) => x.unit === '40123' && x.state === 'applied');
      e.state = 'pending'; e.createdAt = new Date(now - 5 * 60_000).toISOString(); delete e.appliedAt;
      return doc;
    });
    // staged: one expirable item (timeline-disabled) and one protected item, both 31 days old
    w.stores.update('staged', (doc) => {
      const base = Object.values(doc.items).find((x) => x.state === 'open');
      doc.items.st_old_disabled = Object.assign(JSON.parse(JSON.stringify(base)), { stagedId: 'st_old_disabled', reason: 'timeline-disabled', createdAt: new Date(now - 31 * DAY).toISOString(), lastSeenAt: new Date(now - 31 * DAY).toISOString() });
      doc.items.st_old_conflict = Object.assign(JSON.parse(JSON.stringify(base)), { stagedId: 'st_old_conflict', reason: 'conflict-canonical', createdAt: new Date(now - 31 * DAY).toISOString(), lastSeenAt: new Date(now - 31 * DAY).toISOString() });
      return doc;
    });
    // a snoozed action whose time has passed
    const reply = w.open('reply')[0];
    require('../src/email-intel/actions/store').update((doc) => { doc.items[reply.actionId].state = 'snoozed'; doc.items[reply.actionId].snoozeUntil = new Date(now - 60_000).toISOString(); });
    // the scan that was running when the app died
    w.stores.update('checkpoints', (ck) => { ck.scan.current = { scanId: 'sc_crash', startedAt: new Date(now - 120_000).toISOString(), trigger: 'manual' }; return ck; });
    return { sending, preparing, fresh, replyId: reply.actionId };
  }

  it('AC-4 after a simulated restart open actions, staged items, send attempts, pending timeline intents and checkpoints are intact and reconciled', async () => {
    await seededWorld();
    const s = simulateCrash();
    const before = {
      actions: Object.keys(w.stores.load('actions').items).sort(),
      questions: Object.keys(w.stores.load('actions').questions).sort(),
      staged: Object.keys(w.stores.load('staged').items).sort(),
      folders: JSON.stringify(w.stores.load('checkpoints').folders),
      messages: Object.keys(w.messages()).sort(),
      timeline: w.timeline('40123'),
    };
    m2 = freshModules();
    m2.flags._setForTests(FULL);
    m2.lane._setRelayForTests(w.relay);
    const out = await require('../src/email-intel/reliability/boot').reconcileOnBoot();
    expect(out).toMatchObject({ ran: true, interrupted: true, sends: { uncertain: 1, failed: 1 }, staged: { expired: 1 }, reopened: 1, errors: 0 });
    expect(out.ledger).toMatchObject({ resolved: 1, retried: 0 });
    // checkpoints: the crashed scan is interrupted, per-folder progress untouched
    const ck = m2.stores.load('checkpoints');
    expect(ck.scan.current).toBeNull();
    expect(ck.scan.last).toMatchObject({ scanId: 'sc_crash', outcome: 'interrupted', partial: true });
    expect(JSON.stringify(ck.folders)).toBe(before.folders);
    // sends: sending -> delivery-uncertain, old preparing -> failed-before-send, a fresh preparing one untouched
    const guard = require('../src/email-intel/reply/send-guard');
    expect(guard.get(s.sending.attemptId)).toMatchObject({ state: 'delivery-uncertain', errorCode: 'BOOT_RECOVERY' });
    expect(guard.get(s.preparing.attemptId)).toMatchObject({ state: 'failed-before-send' });
    expect(guard.get(s.fresh.attemptId).state).toBe('preparing');
    expect(guard.canSend(s.sending.conversationKey).ok).toBe(false);                                   // L: never blindly resent
    // ledger: the pending entry is reconciled by its marker, no second line
    const entry = Object.values(m2.stores.load('ledger').entries).find((x) => x.unit === '40123');
    expect(entry).toMatchObject({ state: 'applied', reconciled: true });
    expect(w.timeline('40123')).toBe(before.timeline);
    // staged: only the expirable reason expired; protected and live items stay
    const st = m2.stores.load('staged').items;
    expect(Object.keys(st).sort()).toEqual(before.staged);
    expect(st.st_old_disabled.state).toBe('expired');
    expect(st.st_old_conflict.state).toBe('open');
    // actions: same ids, the snoozed item reopened
    const acts = m2.stores.load('actions');
    expect(Object.keys(acts.items).sort()).toEqual(before.actions);
    expect(Object.keys(acts.questions).sort()).toEqual(before.questions);
    expect(acts.items[s.replyId].state).toBe('open');
    expect(Object.keys(m2.stores.load('messages').messages).sort()).toEqual(before.messages);
    // status after the restart shows the interrupted scan and the unreconciled send
    const status = m2.idx.getStatus();
    expect(status.warnings).toContain('scan-interrupted');
    expect(status.backlog.unreconciledSends).toBeGreaterThanOrEqual(1);
    // a second boot reconcile changes nothing
    const again = await require('../src/email-intel/reliability/boot').reconcileOnBoot();
    expect(again).toMatchObject({ interrupted: false, sends: { uncertain: 0, failed: 0 }, reopened: 0 });
    expect(again.staged.expired).toBe(0);
  });

  it('R8.3 IPC registration runs the boot reconcile only when engaged (no scan is started)', () => {
    const src = fs.readFileSync(require.resolve('../src/ipc/email-intel.js'), 'utf8');
    expect(src).toMatch(/if \(flags\.engaged\(\)\) \{\s*try \{\s*require\('\.\.\/email-intel\/reliability\/boot'\)\.reconcileOnBoot\(\)/);
    const boot = fs.readFileSync(require.resolve('../src/email-intel/reliability/boot.js'), 'utf8');
    expect(boot).not.toMatch(/runIntelScan|askIsolated|readMailbox|relay/);
  });

  it('NFR-3 newer version read-only: boot reconcile and scans never write a store from a newer build', async () => {
    await seededWorld();
    const s = simulateCrash();
    const tmp = w.tmp;
    // a newer build rewrote the sends and checkpoints documents
    for (const f of ['email_intel_sends.json', 'email_intel_checkpoints.json']) {
      const p = path.join(tmp, f);
      const d = JSON.parse(fs.readFileSync(p, 'utf8')); d.version = 2; fs.writeFileSync(p, JSON.stringify(d));
    }
    const bytes = (f) => fs.readFileSync(path.join(tmp, f), 'utf8');
    const sendsBefore = bytes('email_intel_sends.json');
    const ckBefore = bytes('email_intel_checkpoints.json');
    m2 = freshModules();
    m2.flags._setForTests(FULL);
    m2.lane._setRelayForTests(w.relay);
    await require('../src/email-intel/reliability/boot').reconcileOnBoot();
    expect(bytes('email_intel_sends.json')).toBe(sendsBefore);                                         // sending stays as written (read-only)
    expect(bytes('email_intel_checkpoints.json')).toBe(ckBefore);
    expect(require('../src/email-intel/reply/send-guard').get(s.sending.attemptId).state).toBe('sending');
    const res = await m2.idx.runIntelScan({ _now: T0, folders: ['Inbox'], _readMailbox: fakeReader([]) }, 'manual');
    expect(res.intel).toMatchObject({ outcome: 'failed', errorCode: 'store-newer-version' });
    expect(bytes('email_intel_checkpoints.json')).toBe(ckBefore);
    expect(m2.idx.getStatus().warnings).toContain('storeVersionNewer');
    // the other (current-version) stores were still reconciled
    expect(m2.stores.load('staged').items.st_old_disabled.state).toBe('expired');
  });
});

describe('R8.3 actions survive reload (partial, FEAT-005)', () => {
  let w = null; let m2 = null;
  afterEach(() => { if (m2) { m2.flags._setForTests(null); m2.lane._resetForTests(); m2.lock._reset(); } m2 = null; if (w) w.cleanup(); w = null; });

  it('R8.3 actions survive reload with identical ids, user state kept, no second notification', async () => {
    w = phaseCWorld();
    w.rules.push({ unit: '40123', fact: fact({ kind: 'approval_status', item: 'estimate', value: 'Estimate received for $1,840', state: 'estimate_received', date: null, amount: { value: 1840, currency: 'USD' }, evidence: 'please approve the $1,840 estimate for 40123' }) });
    w.questions.push({ when: 'please approve', q: { ref: 'q1', text: 'Please approve the $1,840 estimate for 40123', about: ['40123'], addressee: { kind: 'me', name: 'Zila', evidence: 'Zila, please approve' }, isApprovalOrDecision: true, decisionKind: 'estimate', confidence: 0.9 } });
    w.questions.push({ when: 'can you confirm pickup', q: { ref: 'q1', text: 'Can you confirm pickup Friday for 40456?', about: ['40456'], addressee: { kind: 'me', name: 'Zila', evidence: 'Zila, can you confirm pickup' }, isApprovalOrDecision: false, confidence: 0.9 } });
    const caps = [
      w.cap({ from: DEALER, to: [COWORKER], cc: [ZILA], subject: 'Estimate 40123', conversationId: 'conv-r1', messageId: 'r-1', body: 'Zila, please approve the $1,840 estimate for 40123.' }),
      w.cap({ from: DEALER, to: [ZILA], subject: 'Pickup 40456', conversationId: 'conv-r2', messageId: 'r-2', body: 'Zila, can you confirm pickup Friday for 40456?' }),
      w.cap({ from: DEALER, to: [ZILA, COWORKER], subject: 'Newsletter', conversationId: 'conv-r3', messageId: 'r-3', body: 'Shop hours change next week.' }),
    ];
    const notify = vi.fn(() => true);
    await w.scan(caps, { _notify: notify });
    expect(notify).toHaveBeenCalledTimes(1);
    const before = w.stores.load('actions');
    const ids = Object.keys(before.items).sort();
    expect(ids.length).toBeGreaterThanOrEqual(4);                                 // decision, review (spend), reply, info
    const reply = Object.values(before.items).find((x) => x.category === 'reply');
    // the user dismisses the reply item, then the app restarts
    require('../src/email-intel/actions/store').update((doc) => { doc.items[reply.actionId].state = 'dismissed'; });

    m2 = freshModules();
    m2.flags._setForTests(PHASE_C);
    m2.lane._setRelayForTests(w.relay);
    const persisted = m2.stores.load('actions');
    expect(Object.keys(persisted.items).sort()).toEqual(ids);
    expect(Object.keys(persisted.questions).sort()).toEqual(Object.keys(before.questions).sort());
    expect(persisted.items[reply.actionId].state).toBe('dismissed');
    // a rescan after the restart re-derives the same conversations: identical ids, no duplicates, no new notification
    await m2.idx.runIntelScan({ _now: T0, folders: ['Inbox'], _readMailbox: fakeReader(caps), _notify: notify }, 'manual');
    const after = m2.stores.load('actions');
    expect(Object.keys(after.items).sort()).toEqual(ids);
    expect(after.items[reply.actionId].state).toBe('dismissed');
    for (const id of ids) {
      expect(after.items[id].firstSeenAt).toBe(before.items[id].firstSeenAt);
      expect(after.items[id].notifyCount).toBe(before.items[id].notifyCount);
    }
    expect(notify).toHaveBeenCalledTimes(1);
    // the read path after the restart re-derives nothing new either
    require('../src/email-intel/actions/stage').refresh({ now: Date.now() });
    expect(Object.keys(m2.stores.load('actions').items).sort()).toEqual(ids);
  });
});
