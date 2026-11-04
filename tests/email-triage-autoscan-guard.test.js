// OWA email-triage independent guard (comms poller FEAT-004, design §6 / §10 'OWA').
//
// Harness: real store in a temp dir; fakes injected into require.cache for
// the comms mode source (src/slack/poller getMode), the leader gate
// (src/cluster mayRunProduction), telemetry (src/telemetry track spy), the
// OWA reader used by auto runs (src/scrapers/owa_reader), the AI core used by
// triageEmails (src/orcha/reason) and the logger (recorder). Manual runs use
// the injectable opts._readInbox. email_triage.js is re-required per test so
// its module state (_triageInFlight, _autoRunning, status counters) resets.
// No Electron, no OWA, no network.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'et-autoscan-guard-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

function injectFakeModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── Logger recorder (email-triage namespace only) ─────────────────────────
let _logs;
function _fakeLogger(ns) {
  const rec = (level) => (...a) => { if (ns === 'email-triage') _logs.push({ level, msg: a.join(' ') }); };
  return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), log: rec('info') };
}
_fakeLogger.createLogger = _fakeLogger;
_fakeLogger.setLogDir = () => {};
_fakeLogger.setLevel = () => {};
_fakeLogger.setSilent = () => {};
_fakeLogger.LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
injectFakeModule('../src/utils/logger', _fakeLogger);

// ── Mode source (Slack poller) ────────────────────────────────────────────
let _mode;
injectFakeModule('../src/slack/poller', { getMode: () => _mode });

// ── Leader gate ───────────────────────────────────────────────────────────
let _gate;
const _clusterSpy = vi.fn(() => (typeof _gate === 'function' ? _gate() : _gate));
injectFakeModule('../src/cluster', { mayRunProduction: (...a) => _clusterSpy(...a) });

// ── Telemetry track spy (same contract as the real track) ────────────────
let _tracks;
injectFakeModule('../src/telemetry', {
  track: (name, fn, opts) => {
    const rec = { name, opts, outcome: 'pending', value: undefined };
    _tracks.push(rec);
    return Promise.resolve().then(fn).then(
      (v) => { rec.outcome = opts && opts.skip && opts.skip(v) ? 'skip' : 'ok'; rec.value = v; return v; },
      (e) => { rec.outcome = 'fail'; rec.error = e; throw e; },
    );
  },
});

// ── Slack engine fake (OWA must never consult the Slack lock) ────────────
const _slackInFlightSpy = vi.fn(() => true);
injectFakeModule('../src/scrapers/slack_channel_watch', { isPollInFlight: (...a) => _slackInFlightSpy(...a) });

// ── AI core used by triageEmails ──────────────────────────────────────────
let _reasonImpl;
injectFakeModule('../src/orcha/reason', { reason: (...a) => _reasonImpl(...a) });

// ── Controllable reader (shared by manual _readInbox and auto owa_reader) ─
let reader;
function makeReader() {
  const r = {
    calls: 0, active: 0, maxActive: 0, pending: [], mode: 'immediate',
    emails: [],
    async readInbox() {
      r.calls++; r.active++; r.maxActive = Math.max(r.maxActive, r.active);
      try {
        if (r.mode === 'hang') await new Promise(() => {});
        if (r.mode === 'deferred') await new Promise((res) => r.pending.push(res));
        return { emails: r.emails.slice() };
      } finally { r.active--; }
    },
    release() { const f = r.pending.shift(); if (f) f(); return !!f; },
  };
  return r;
}
injectFakeModule('../src/scrapers/owa_reader', { readInbox: (...a) => reader.readInbox(...a) });

const store = require('../src/store');

async function flush(n = 60) { for (let i = 0; i < n; i++) await Promise.resolve(); }

function loadTriage() {
  const resolved = require.resolve('../src/scrapers/email_triage');
  delete require.cache[resolved];
  return require('../src/scrapers/email_triage');
}

const EMAIL = { id: 'e1', from: 'dealer@example.com', fromName: 'Dealer', subject: 'Hello', bodyText: 'A body that is long enough to count.', receivedText: '10/19/2026' };

let triage;
let notify;
beforeEach(() => {
  _logs = []; _tracks = []; _mode = 'off'; _gate = true;
  _clusterSpy.mockClear(); _slackInFlightSpy.mockClear();
  _reasonImpl = async () => ({ ok: false });
  reader = makeReader();
  store.save('emailTriageConfig', { enabled: true, autoScan: true, autoApplyUnitUpdates: true, folders: ['Inbox'] });
  store.save('emailTriageResults', { emails: [] });
  store.save('fleetData', { rows: [] });
  triage = loadTriage();
  notify = vi.fn();
  triage._setAutoNotify(notify);
});
afterEach(() => {
  vi.useRealTimers();
  try { triage.stopAutoScan(); } catch (_) {}
});

const manual = (opts) => triage.runTriageForIpc({ _readInbox: (o) => reader.readInbox(o), ...(opts || {}) });
const warns = (needle) => _logs.filter((l) => l.level === 'warn' && l.msg.includes(needle));
const infos = (needle) => _logs.filter((l) => l.level === 'info' && l.msg.includes(needle));

function expectZeroCounters(s) {
  expect(s.runs).toBe(0);
  expect(s.skipped).toEqual({ busy: 0, standby: 0, manualBusyTimeout: 0 });
  expect(s.wouldSkip).toEqual({ busy: 0, standby: 0 });
  expect(s.lastOrigin).toBe(null);
  expect(s.lastStartAt).toBe(null);
  expect(s.lastOutcome).toBe(null);
  expect(s.lastGate).toBe(null);
}

describe('email_triage auto-scan guard — mode off (today verbatim)', () => {
  it('_autoTick runs with no gate, no track, counters 0 (even when not the leader)', async () => {
    _gate = false;
    await triage._autoTick();
    expect(reader.calls).toBe(1);
    expect(_clusterSpy).not.toHaveBeenCalled();
    expect(_tracks.length).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(infos('auto-scan tick — folders: Inbox').length).toBe(1);
    expectZeroCounters(triage.getAutoScanStatus());
    expect(triage.getAutoScanStatus().mode).toBe('off');
  });

  it('runTriageForIpc is plain runTriage: no serialization (two readers may overlap)', async () => {
    reader.mode = 'deferred';
    const a = manual(); const b = manual();
    await flush();
    expect(reader.calls).toBe(2);
    expect(reader.maxActive).toBe(2);
    reader.release(); reader.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(Array.isArray(ra.emails)).toBe(true);
    expect(Array.isArray(rb.emails)).toBe(true);
    expect(_tracks.length).toBe(0);
    expect(triage.getAutoScanStatus().running).toBe(false);
    expectZeroCounters(triage.getAutoScanStatus());
  });

  it('auto failure keeps today\'s single warn line and touches no status', async () => {
    reader.emails = [EMAIL];
    _reasonImpl = async () => { throw new Error('ai boom'); };
    await triage._autoTick();
    expect(warns('[email-triage] auto-scan failed: ai boom').length).toBe(1);
    expectZeroCounters(triage.getAutoScanStatus());
    expect(triage.getAutoScanStatus().lastError).toBe(null);
  });
});

describe('email_triage auto-scan guard — mode shadow (observe-only)', () => {
  beforeEach(() => { _mode = 'shadow'; });

  it('standby does not skip the tick; only wouldSkip.standby moves; no track', async () => {
    _gate = false;
    await triage._autoTick();
    expect(reader.calls).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    const s = triage.getAutoScanStatus();
    expect(s.wouldSkip).toEqual({ busy: 0, standby: 1 });
    expect(s.skipped).toEqual({ busy: 0, standby: 0, manualBusyTimeout: 0 });
    expect(s.lastGate).toBe(null);
    expect(_tracks.length).toBe(0);
  });

  it('a manual run in flight does not block auto (readers overlap as today); wouldSkip.busy moves', async () => {
    reader.mode = 'deferred';
    const m = manual();
    await flush();
    const tick = triage._autoTick();
    await flush();
    expect(reader.calls).toBe(2);
    expect(reader.maxActive).toBe(2);
    reader.release(); reader.release();
    const rm = await m; await tick;
    expect(Array.isArray(rm.emails)).toBe(true);
    const s = triage.getAutoScanStatus();
    expect(s.wouldSkip).toEqual({ busy: 1, standby: 0 });
    expect(s.runs).toBe(0);
    expect(s.lastOrigin).toBe(null);
    expect(_tracks.length).toBe(0);
  });

  it('manual rejection reaches the caller unchanged and the observe marker is released', async () => {
    reader.emails = [EMAIL];
    _reasonImpl = async () => { throw new Error('ai boom'); };
    await expect(manual()).rejects.toThrow('ai boom');
    _reasonImpl = async () => ({ ok: false });
    await triage._autoTick();
    expect(triage.getAutoScanStatus().wouldSkip.busy).toBe(0);
  });
});

describe('email_triage auto-scan guard — mode on', () => {
  beforeEach(() => { _mode = 'on'; });

  it('auto tick while a manual run is in flight -> {skipped:busy}, no apply/notify, one reader call', async () => {
    reader.mode = 'deferred';
    const m = manual();
    await flush();
    const r = await triage._autoTick();
    expect(r).toEqual({ skipped: 'busy' });
    expect(reader.calls).toBe(1);
    expect(notify).not.toHaveBeenCalled();
    const s = triage.getAutoScanStatus();
    expect(s.lastOutcome).toBe('skipped');
    expect(s.skipped.busy).toBe(1);
    expect(s.runs).toBe(0);
    expect(s.running).toBe(true);
    reader.release();
    await m;
    await flush();
    expect(triage.getAutoScanStatus().running).toBe(false);
  });

  it('3 concurrent manual runs + 1 auto tick -> max concurrent 1, all manual get results, auto skipped', async () => {
    reader.mode = 'deferred';
    const ms = [manual(), manual(), manual()];
    await flush();
    const autoR = await triage._autoTick();
    expect(autoR).toEqual({ skipped: 'busy' });
    for (let i = 0; i < 3; i++) {
      await flush();
      expect(reader.calls).toBe(i + 1);
      expect(reader.release()).toBe(true);
    }
    const results = await Promise.all(ms);
    for (const r of results) expect(Array.isArray(r.emails)).toBe(true);
    expect(reader.calls).toBe(3);
    expect(reader.maxActive).toBe(1);
    await flush();
    expect(triage.getAutoScanStatus().running).toBe(false);
  });

  it('a manual run whose triageEmails rejects -> caller gets the rejection, guard cleared, next manual proceeds', async () => {
    reader.emails = [EMAIL];
    _reasonImpl = async () => { throw new Error('ai boom'); };
    await expect(manual()).rejects.toThrow('ai boom');
    await flush();
    expect(triage.getAutoScanStatus().running).toBe(false);
    _reasonImpl = async () => ({ ok: false });
    const r = await manual();
    expect(Array.isArray(r.emails)).toBe(true);
    expect(reader.calls).toBe(2);
  });

  it('auto failure is observed: one warn, lastOutcome fail, track fail, _autoRunning held while pending', async () => {
    reader.emails = [EMAIL];
    reader.mode = 'deferred';
    _reasonImpl = async () => { throw new Error('ai boom'); };
    const t1 = triage._autoTick();
    await flush();
    expect(reader.calls).toBe(1);
    await triage._autoTick();               // _autoRunning still true -> no-op
    expect(reader.calls).toBe(1);
    reader.release();
    await t1;
    expect(warns('[email-triage] auto-scan failed: ai boom').length).toBe(1);
    const s = triage.getAutoScanStatus();
    expect(s.lastOutcome).toBe('fail');
    expect(s.lastError).toBe('ai boom');
    expect(_tracks.length).toBe(1);
    expect(_tracks[0].outcome).toBe('fail');
    // _autoRunning released after settle -> next tick reads again
    reader.mode = 'immediate';
    _reasonImpl = async () => ({ ok: false });
    await flush();
    await triage._autoTick();
    expect(reader.calls).toBe(2);
    expect(triage.getAutoScanStatus().lastOutcome).toBe('ok');
    expect(triage.getAutoScanStatus().lastError).toBe(null);
  });

  it('hung reader: B rejects "Email triage is busy" after 5 min, reader called once, no timers left from B', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    reader.mode = 'hang';
    const a = manual();
    a.catch(() => {});
    await flush();
    expect(reader.calls).toBe(1);
    const before = vi.getTimerCount();
    const b = manual().then(() => null, (e) => e);
    await flush();
    expect(vi.getTimerCount()).toBe(before + 1);
    const autoR = await triage._autoTick();
    expect(autoR).toEqual({ skipped: 'busy' });
    await vi.advanceTimersByTimeAsync(triage.MANUAL_WAIT_MS);
    const err = await b;
    expect(err).toBeInstanceOf(Error);
    expect(err.message.startsWith('Email triage is busy')).toBe(true);
    expect(triage.getAutoScanStatus().skipped.manualBusyTimeout).toBe(1);
    expect(reader.calls).toBe(1);
    expect(vi.getTimerCount()).toBe(before);
    expect(warns('manual run rejected').length).toBe(1);
  });

  it('lastStartAt / lastOrigin recorded for manual and auto runs (plus end/duration)', async () => {
    await manual();
    await flush();
    let s = triage.getAutoScanStatus();
    expect(s.lastOrigin).toBe('manual');
    expect(typeof s.lastStartAt).toBe('number');
    expect(typeof s.lastEndAt).toBe('number');
    expect(typeof s.lastDurationMs).toBe('number');
    expect(s.runs).toBe(0);                 // runs counts auto only
    await triage._autoTick();
    await flush();
    s = triage.getAutoScanStatus();
    expect(s.lastOrigin).toBe('auto');
    expect(s.runs).toBe(1);
    expect(s.lastOutcome).toBe('ok');
  });

  it('_logStandbyTransition: gate true,true,false,false,true -> exactly two info lines', async () => {
    for (const g of [true, true, false, false, true]) {
      _gate = g;
      await triage._autoTick();
    }
    expect(infos('auto-scan standby — not the production leader').length).toBe(1);
    expect(infos('auto-scan resumed — production leader').length).toBe(1);
    expect(_logs.filter((l) => /auto-scan (standby|resumed)/.test(l.msg)).length).toBe(2);
    expect(triage.getAutoScanStatus().lastGate).toBe(true);
  });

  it('standby -> auto tick skipped, reader not called, skipped.standby 1, no track', async () => {
    _gate = false;
    await triage._autoTick();
    expect(reader.calls).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    const s = triage.getAutoScanStatus();
    expect(s.skipped.standby).toBe(1);
    expect(s.lastGate).toBe(false);
    expect(_tracks.length).toBe(0);
  });

  it('manual runs are not leader-gated', async () => {
    _gate = false;
    const r = await manual();
    expect(Array.isArray(r.emails)).toBe(true);
    expect(reader.calls).toBe(1);
    expect(_clusterSpy).not.toHaveBeenCalled();
  });

  it('track called with owa.triageAutoScan and a skip predicate matching {skipped}', async () => {
    await triage._autoTick();
    expect(_tracks.length).toBe(1);
    expect(_tracks[0].name).toBe('owa.triageAutoScan');
    expect(_tracks[0].outcome).toBe('ok');
    const skip = _tracks[0].opts.skip;
    expect(skip({ skipped: 'busy' })).toBe(true);
    expect(skip({ emails: [] })).toBe(false);
    expect(skip(null)).toBe(false);
  });

  it('getAutoScanStatus: mode, armed cadence, counters', async () => {
    store.save('emailTriageConfig', { enabled: true, autoScan: true, autoScanMinutes: 30 });
    triage.startAutoScan();
    const s = triage.getAutoScanStatus();
    expect(s.mode).toBe('on');
    expect(s.armedMinutes).toBe(30);
    expect(typeof s.armedAt).toBe('number');
    expect(s.nextRunAt).toBe(s.armedAt + 30 * 60 * 1000);
    expect(s.running).toBe(false);
    expect(s.skipped).toEqual({ busy: 0, standby: 0, manualBusyTimeout: 0 });
    expect(s.wouldSkip).toEqual({ busy: 0, standby: 0 });
    triage.stopAutoScan();
    expect(triage.getAutoScanStatus().armedMinutes).toBe(null);
    expect(triage.getAutoScanStatus().nextRunAt).toBe(null);
  });

  it('OWA independent of the Slack lock: Slack isPollInFlight true -> auto tick still reads once, spy 0 calls', async () => {
    await triage._autoTick();
    expect(reader.calls).toBe(1);
    expect(_slackInFlightSpy).toHaveBeenCalledTimes(0);
  });
});
