// tests/email-intel-restart.test.js — restart persistence (design 5.8, 8.8; R8.3, AC-4). FEAT-005 covers the
// My Email Actions part: action items and question states live in emailIntelActions on disk, survive a process
// restart (fresh modules), keep identical ids, keep user state (dismissed) and are not re-notified.
// FEAT-008 extends this file with staged items, send attempts, ledger, checkpoints and NFR-3 read-only.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { phaseCWorld, fact, fakeReader, T0, PHASE_C } from './fixtures/email-intel/phase-c.js';
import { DEALER, COWORKER, ZILA } from './fixtures/email-intel/emails.js';
const require = createRequire(import.meta.url);

function freshModules() {
  // A restart: every email-intel module is loaded again (module state gone); the stores are re-read from disk.
  for (const k of Object.keys(require.cache)) if (/[\\/]src[\\/]email-intel[\\/]/.test(k)) delete require.cache[k];
  return {
    flags: require('../src/email-intel/flags'), lane: require('../src/email-intel/understand/lane'),
    idx: require('../src/email-intel/index'), lock: require('../src/email-intel/reliability/lock'), stores: require('../src/email-intel/stores'),
  };
}

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
