// tests/email-intel-supervisor.test.js — supervisor integration (design 8.5; R8.1, AC-3, AC-K, F-01, F2-04).
// scheduledTick runs under a supervisor stub with the same contract as workers/supervisor (a thrown error is a
// counted failure and trips the breaker after maxFailures; a result with `skipped` is a skip; the ctx signal is
// the timeout abort). No Outlook (fake OWA world or injected reader), no model (scripted isolated lane).
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';
import { inboxRows } from './fixtures/email-intel/emails.js';
import { makeHarness } from './fixtures/email-intel/scan-harness.js';
import { phaseCWorld, fact, fakeReader, T0 } from './fixtures/email-intel/phase-c.js';
import { DEALER, ZILA, COWORKER } from './fixtures/email-intel/emails.js';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 30_000 });                 // scan-level tests: many store writes on slow Windows temp dirs

/** The supervisor's tick contract, reduced: throws are failures (breaker after 3), `skipped` results are skips. */
function supervisorStub(tick, maxFailures = 3) {
  const s = { counts: { ok: 0, failed: 0, skipped: 0 }, errors: [], consecutiveFailures: 0, breakerState: 'ok' };
  s.run = async (ctx) => {
    try {
      const r = await tick(ctx || { signal: new AbortController().signal });
      if (r && r.skipped) s.counts.skipped++; else { s.counts.ok++; s.consecutiveFailures = 0; }
      return r;
    } catch (e) {
      s.counts.failed++; s.errors.push(e);
      if (++s.consecutiveFailures >= maxFailures) s.breakerState = 'isolated';
      return null;
    }
  };
  return s;
}
const autoStatus = () => ({ runs: 0, lastOutcome: null, lastError: null, skipped: { busy: 0, standby: 0 } });
const CFG = { enabled: true, autoScan: true, autoApplyUnitUpdates: true };

describe('R8.1 scheduledTick outcome mapping (Phase A world)', () => {
  let h = null;
  afterEach(() => { if (h) h.cleanup(); h = null; });
  const harnessOpts = (extra) => Object.assign({ folders: ['Inbox'], _electron: h.electron, _warm: async () => ({}), _sleep: async () => {}, authGraceMs: 20, _triageEmails: h.triage }, extra || {});

  it('R8.1 a complete scheduled scan returns its results, notifies the overlay once and counts ok', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 3) });
    const auto = autoStatus(); const notify = vi.fn();
    const sup = supervisorStub((ctx) => h.idx.scheduledTick(ctx, CFG, { autoStatus: auto, notify, loadResults: () => ({ pushed: true }), _scanOpts: harnessOpts() }));
    const res = await sup.run();
    expect(res.intel.outcome).toBe('complete');
    expect(sup.counts).toEqual({ ok: 1, failed: 0, skipped: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ pushed: true });
    expect(auto).toMatchObject({ runs: 1, lastOutcome: 'ok', lastError: null });
  });

  it('F-01 scheduledTick pushes overlay and updates autoStatus', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 2) });
    const auto = autoStatus(); const pushed = [];
    const triage = require('../src/scrapers/email_triage');
    await h.idx.scheduledTick({}, CFG, { autoStatus: auto, notify: (r) => pushed.push(r), loadResults: triage.loadResults, _scanOpts: harnessOpts() });
    expect(pushed).toHaveLength(1);
    expect(pushed[0].emails).toHaveLength(2);                                   // the stored legacy results (same push as the legacy tick)
    expect(auto.runs).toBe(1);
    expect(auto.lastOutcome).toBe('ok');
    // a skipped tick: no push, no run counted, outcome skipped
    const realCapture = require('../src/email-intel/capture/owa_capture');
    const running = h.run({ _readMailbox: async (o) => { await new Promise((r) => setTimeout(r, 20)); return realCapture.readMailbox(o); } });
    const skip = await h.idx.scheduledTick({}, CFG, { autoStatus: auto, notify: (r) => pushed.push(r), loadResults: triage.loadResults, _scanOpts: harnessOpts() });
    expect(skip.skipped).toBe('busy');
    expect(pushed).toHaveLength(1);
    expect(auto).toMatchObject({ runs: 1, lastOutcome: 'skipped' });
    await running;
  });

  it('case K: an auth wall makes scheduledTick throw AuthBlockedError (OWA_AUTH_BLOCKED); the supervisor counts it and checkpoints are kept', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 3) });
    await h.run({ max: 25 });                                                   // one good scan first
    const seen = Object.keys(h.ck().folders.Inbox.seenRows).length;
    const auto = autoStatus(); const notify = vi.fn();
    const tick = (ctx) => h.idx.scheduledTick(ctx, CFG, { autoStatus: auto, notify, loadResults: () => ({}), _scanOpts: harnessOpts({ _warm: async () => ({ authWall: true, url: 'https://login.microsoftonline.com/x' }) }) });
    const sup = supervisorStub(tick);
    expect(await sup.run()).toBeNull();
    expect(sup.counts.failed).toBe(1);
    const err = sup.errors[0];
    expect(err).toBeInstanceOf(h.idx.AuthBlockedError);
    expect(err.code).toBe('OWA_AUTH_BLOCKED');
    expect(auto.lastOutcome).toBe('authBlocked');
    expect(notify).toHaveBeenCalledTimes(1);                                    // the overlay still learns about the block
    expect(h.ck().scan.last).toMatchObject({ outcome: 'auth-blocked', trigger: 'scheduled' });
    expect(h.ck().scan.current).toBeNull();
    expect(Object.keys(h.ck().folders.Inbox.seenRows)).toHaveLength(seen);       // checkpoints intact
    expect(h.idx.getStatus().owaAuth).toMatchObject({ state: 'blocked', blockedCount: 1 });
    // three blocked ticks in a row trip the breaker, exactly like any other failure
    await sup.run(); await sup.run();
    expect(sup.counts.failed).toBe(3);
    expect(sup.breakerState).toBe('isolated');
  });

  it('R8.1 a failed scan throws ScanFailedError with an enum code; a partial (budget) scan is not a failure', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 12) });
    const auto = autoStatus();
    const sup = supervisorStub((ctx) => h.idx.scheduledTick(ctx, CFG, { autoStatus: auto, notify: () => {}, loadResults: () => ({}), _scanOpts: harnessOpts({ _readMailbox: async () => { throw new Error('reader exploded with secret text'); } }) }));
    await sup.run();
    expect(sup.errors[0]).toBeInstanceOf(h.idx.ScanFailedError);
    expect(sup.errors[0].code).toBe('EMAIL_SCAN_FAILED');
    expect(sup.errors[0].message).not.toMatch(/secret/);
    expect(auto).toMatchObject({ lastOutcome: 'fail', lastError: 'read-failed' });
    // partial: max 5 of 12 rows -> backlog; returned, counted ok
    const sup2 = supervisorStub((ctx) => h.idx.scheduledTick(ctx, CFG, { autoStatus: auto, notify: () => {}, loadResults: () => ({}), _scanOpts: harnessOpts({ max: 5 }) }));
    const res = await sup2.run();
    expect(res.intel).toMatchObject({ outcome: 'partial', partial: true });
    expect(sup2.counts).toEqual({ ok: 1, failed: 0, skipped: 0 });
    expect(auto.lastOutcome).toBe('ok');
  });

  it('standby host: the leader gate makes the tick a skip, not a failure', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 2) });
    const cl = require('../src/cluster');
    const spy = vi.spyOn(cl, 'mayRunProduction').mockReturnValue(false);
    try {
      const auto = autoStatus();
      const sup = supervisorStub((ctx) => h.idx.scheduledTick(ctx, CFG, { autoStatus: auto, notify: () => {}, loadResults: () => ({}), _scanOpts: harnessOpts() }));
      const r = await sup.run();
      expect(r).toEqual({ skipped: 'standby' });
      expect(sup.counts.skipped).toBe(1);
      expect(auto.skipped.standby).toBe(1);
      expect(h.world.openLog).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
});

describe('R8.1 signal, trigger and single flight (Phase B/C world)', () => {
  let w = null;
  afterEach(() => { if (w) w.cleanup(); w = null; });
  const caps = () => [
    w.cap({ from: DEALER, to: [ZILA, COWORKER], subject: 'Turbo 40123', conversationId: 'conv-s1', messageId: 's-1', body: 'Turbo ETA 11/12 for 40123' }),
    w.cap({ from: DEALER, to: [ZILA], subject: 'Brakes 40456', conversationId: 'conv-s2', messageId: 's-2', body: 'Brake pads arrived for 40456' }),
  ];

  it('F2-04 scheduledTick passes _trigger scheduled', async () => {
    w = phaseCWorld();
    w.rules.push({ unit: '40123', fact: fact() });
    const res = await w.idx.scheduledTick({ signal: new AbortController().signal }, CFG, { autoStatus: autoStatus(), notify: () => {}, loadResults: () => ({}), _scanOpts: { _now: T0, folders: ['Inbox'], _readMailbox: fakeReader(caps()) } });
    expect(res.intel.outcome).not.toBe('failed');
    expect(w.stores.load('checkpoints').scan.last.trigger).toBe('scheduled');
    expect(w.relay.calls.length).toBeGreaterThan(0);
    for (const c of w.relay.calls) expect(c.opts).toMatchObject({ isolated: true, priority: 'low' });     // scheduled -> low AI priority
    const src = fs.readFileSync(require.resolve('../src/email-intel/index.js'), 'utf8');
    expect(src).toMatch(/_trigger: 'scheduled' \}\);\s*\n\s*const res = await runIntelScan\(scanOpts, 'scheduled'\);/);
    // a manual scan of the same world uses normal priority
    const n = w.relay.calls.length;
    await w.scan([w.cap({ from: DEALER, to: [ZILA], subject: 'Turbo 40123', conversationId: 'conv-s3', messageId: 's-3', body: 'Turbo ETA 11/12 for 40123 again' })]);
    for (const c of w.relay.calls.slice(n)) expect(c.opts.priority).toBe('normal');
  });

  it('R8.1 the supervisor abort signal reaches the reader and the lane; the tick throws ScanAbortedError and keeps committed batches', async () => {
    w = phaseCWorld();
    w.rules.push({ unit: '40123', fact: fact() });
    const ac = new AbortController();
    let readerSignal = null;
    const base = fakeReader(caps());
    const reader = async (o) => { readerSignal = o.signal; const r = await base(o); ac.abort(); return r; };    // the timeout fires right after the read
    const sup = supervisorStub((ctx) => w.idx.scheduledTick(ctx, CFG, { autoStatus: autoStatus(), notify: () => {}, loadResults: () => ({}), _scanOpts: { _now: T0, folders: ['Inbox'], _readMailbox: reader } }));
    await sup.run({ signal: ac.signal });
    expect(readerSignal).toBe(ac.signal);
    expect(sup.errors[0]).toBeInstanceOf(w.idx.ScanAbortedError);
    expect(sup.errors[0].code).toBe('EMAIL_SCAN_ABORTED');
    expect(w.relay.calls).toHaveLength(0);                                      // no AI call after the abort
    expect(Object.keys(w.messages())).toHaveLength(2);                          // the committed batch stays
    const ck = w.stores.load('checkpoints');
    expect(ck.scan.last).toMatchObject({ outcome: 'aborted', trigger: 'scheduled' });
    expect(ck.scan.current).toBeNull();
    // the next scan picks up the pending analysis
    const again = await w.scan([]);
    expect(again.intel.outcome).not.toBe('aborted');
    expect(w.relay.calls.length).toBeGreaterThan(0);
  });

  it('R8.1 an abort during the analysis stops further lane calls (each call carries the signal)', async () => {
    w = phaseCWorld();
    w.rules.push({ unit: '40123', fact: fact() });
    const ac = new AbortController();
    const seen = [];
    const orig = w.relay.askWithTimeout;
    w.relay.askWithTimeout = async (prompt, opts) => { seen.push(opts.signal); const r = await orig(prompt, opts); ac.abort(); return r; };
    const sup = supervisorStub((ctx) => w.idx.scheduledTick(ctx, CFG, { autoStatus: autoStatus(), notify: () => {}, loadResults: () => ({}), _scanOpts: { _now: T0, folders: ['Inbox'], _readMailbox: fakeReader(caps()) } }));
    await sup.run({ signal: ac.signal });
    expect(seen).toHaveLength(1);                                               // the second message's call never starts
    expect(seen[0]).toBe(ac.signal);
    expect(sup.errors[0]).toBeInstanceOf(w.idx.ScanAbortedError);
  });

  it('AC-3 a chat runTriage({}) during a scheduled tick joins it (one read), and the tick still maps its own outcome', async () => {
    w = phaseCWorld();
    let reads = 0;
    const base = fakeReader(caps());
    const slow = async (o) => { reads++; await new Promise((r) => setTimeout(r, 30)); return base(o); };
    const tick = w.idx.scheduledTick({ signal: new AbortController().signal }, CFG, { autoStatus: autoStatus(), notify: () => {}, loadResults: () => ({}), _scanOpts: { _now: T0, folders: ['Inbox'], _readMailbox: slow } });
    await new Promise((r) => setTimeout(r, 5));
    const chat = await require('../src/scrapers/email_triage').runTriage({});
    const t = await tick;
    expect(reads).toBe(1);
    expect(chat.intel.coalesced).toBe(true);
    expect(chat.intel.scanId).toBe(t.intel.scanId);
  });
});
