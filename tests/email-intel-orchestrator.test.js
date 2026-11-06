// tests/email-intel-orchestrator.test.js — runIntelScan orchestration (design 8.2; F-20 deadline, step order,
// containment). Injected reader and scripted isolated lane; temp data dir; no Outlook, no model.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { phaseCWorld, fact, fakeReader, T0 } from './fixtures/email-intel/phase-c.js';
import { DEALER, ZILA, COWORKER } from './fixtures/email-intel/emails.js';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 30_000 });                 // scan-level tests: many store writes on slow Windows temp dirs
const C = require('../src/email-intel/constants');
const CFG = { enabled: true, autoScan: true, autoApplyUnitUpdates: true };
const auto = () => ({ runs: 0, lastOutcome: null, lastError: null, skipped: { busy: 0, standby: 0 } });

describe('F-20 scan deadline', () => {
  let w = null;
  afterEach(() => { if (w) w.cleanup(); w = null; });
  const caps = () => [
    w.cap({ from: DEALER, to: [ZILA, COWORKER], subject: 'Turbo 40123', conversationId: 'conv-o1', messageId: 'o-1', body: 'Turbo ETA 11/12 for 40123' }),
    w.cap({ from: DEALER, to: [ZILA], subject: 'Brakes 40456', conversationId: 'conv-o2', messageId: 'o-2', body: 'Brake pads arrived for 40456' }),
  ];

  it('F-20 the reader gets one wall-clock deadline 20 minutes out, below the 30 minute supervisor timeout', async () => {
    w = phaseCWorld();
    let got = null;
    const base = fakeReader(caps());
    const start = Date.now();
    await w.scan(null, { _readMailbox: async (o) => { got = o.deadlineAt; return base(o); } });
    expect(C.SCAN_DEADLINE_MS).toBe(20 * 60_000);
    expect(C.SCAN_DEADLINE_MS).toBeLessThan(30 * 60_000);
    expect(got).toBeGreaterThanOrEqual(start + C.SCAN_DEADLINE_MS);
    expect(got).toBeLessThanOrEqual(Date.now() + C.SCAN_DEADLINE_MS);
    // the test hook can only shorten it
    await w.scan(null, { _deadlineMs: 99 * 60_000, _readMailbox: async (o) => { got = o.deadlineAt; return fakeReader([])(o); } });
    expect(got - Date.now()).toBeLessThanOrEqual(C.SCAN_DEADLINE_MS);
  });

  it('F-20 a read stopped by the deadline ends partial (deadline), keeps what was committed and is not a supervisor failure', async () => {
    w = phaseCWorld();
    w.rules.push({ unit: '40123', fact: fact() });
    const base = fakeReader(caps().slice(0, 1));
    const reader = async (o) => {
      const r = await base(o);
      r.folders[0] = Object.assign({}, r.folders[0], { status: 'skipped-budget', deadline: true, backlog: true, backlogRemaining: 4, caughtUp: false });
      return r;
    };
    const res = await w.idx.scheduledTick({ signal: new AbortController().signal }, CFG, { autoStatus: auto(), notify: () => {}, loadResults: () => ({}), _scanOpts: { _now: T0, folders: ['Inbox'], _readMailbox: reader } });
    expect(res.intel).toMatchObject({ outcome: 'partial', partial: true });
    const last = w.stores.load('checkpoints').scan.last;
    expect(last).toMatchObject({ outcome: 'partial', errorCode: 'deadline', trigger: 'scheduled' });
    expect(Object.keys(w.messages())).toHaveLength(1);
    expect(w.lines('40123').length).toBe(1);                                   // the committed message was still analyzed and applied
  });

  it('F-20 when the deadline is too close for another AI call, analysis stops: messages stay pending, outcome partial, no lane call', async () => {
    w = phaseCWorld();
    w.rules.push({ unit: '40123', fact: fact() });
    const res = await w.scan(caps(), { _deadlineMs: C.AI_CALL_TIMEOUT_MS - 1 });
    expect(w.relay.calls).toHaveLength(0);
    expect(res.intel).toMatchObject({ outcome: 'partial', partial: true });
    expect(w.stores.load('checkpoints').scan.last.errorCode).toBe('pending-analysis');
    for (const m of Object.values(w.messages())) expect(String(m.analysis.status)).toMatch(/^pending/);
    // the next scan (normal deadline) analyzes them
    const again = await w.scan([]);
    expect(w.relay.calls.length).toBe(2);
    expect(again.intel.outcome).toBe('complete');
  });
});

describe('design 8.2 step order and containment', () => {
  let w = null;
  afterEach(() => { if (w) w.cleanup(); w = null; });

  it('step 4 runs before the read: a scan.current left by a crashed run is recorded as interrupted, then this scan proceeds', async () => {
    w = phaseCWorld();
    w.stores.update('checkpoints', (ck) => { ck.scan = { current: { scanId: 'sc_dead', startedAt: new Date(T0 - 60_000).toISOString(), trigger: 'scheduled' }, last: null }; return ck; });
    let seenAtRead = null;
    const res = await w.scan(null, { _readMailbox: async (o) => { seenAtRead = JSON.parse(JSON.stringify(w.stores.load('checkpoints').scan)); return fakeReader([])(o); } });
    expect(seenAtRead.last).toMatchObject({ scanId: 'sc_dead', outcome: 'interrupted', trigger: 'scheduled', errorCode: 'interrupted' });
    expect(seenAtRead.current.scanId).toBe(res.intel.scanId);                  // this scan owns scan.current while it reads
    const ck = w.stores.load('checkpoints');
    expect(ck.scan.current).toBeNull();
    expect(ck.scan.last.scanId).toBe(res.intel.scanId);
  });

  it('a stage that throws is contained: the scan still records scan.last, clears scan.current and returns results', async () => {
    w = phaseCWorld();
    const pipeline = require('../src/email-intel/facts/pipeline');
    const orig = pipeline.runFactStage;
    pipeline.runFactStage = async () => { throw new Error('fact stage exploded'); };
    try {
      w.rules.push({ unit: '40123', fact: fact() });
      const res = await w.scan([w.cap({ from: DEALER, to: [ZILA], subject: 'Turbo 40123', conversationId: 'conv-o9', messageId: 'o-9', body: 'Turbo ETA 11/12 for 40123' })]);
      expect(Array.isArray(res.emails)).toBe(true);
      expect(res.emails).toHaveLength(1);
      expect(w.lines('40123')).toEqual([]);                                     // nothing written without the fact stage
      const ck = w.stores.load('checkpoints');
      expect(ck.scan.current).toBeNull();
      expect(ck.scan.last.scanId).toBe(res.intel.scanId);
    } finally { pipeline.runFactStage = orig; }
  });
});
