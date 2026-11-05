// tests/longdwell-fill-ipc.test.js — long-dwell-ai:* IPC surface: all six
// channels registered, payload validation returned as {ok:false} (never
// thrown), flag off -> {ok:false, code:'off'} with no timer and no files,
// flag on -> lazy unref'd sweep timer + renderer-destroyed cancel.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

function inject(rel, exp) { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; }
const handlers = {};
inject('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } });
function fakeLogger() { return { debug() {}, info() {}, warn() {}, error() {} }; }
fakeLogger.createLogger = fakeLogger; fakeLogger.setLogDir = () => {}; fakeLogger.setLevel = () => {}; fakeLogger.setSilent = () => {}; fakeLogger.LEVELS = {};
inject('../src/utils/logger', fakeLogger);

const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const jobs = require('../src/jobs');
const fill = require('../src/jobs/long-dwell-ai-fill');
const ipc = require('../src/ipc/long-dwell-ai');
ipc.registerLongDwellAiIPC();

const CHANNELS = ['status', 'plan', 'unit-start', 'commit', 'finish', 'today'].map((c) => 'long-dwell-ai:' + c);
const call = (ch, payload, ev) => handlers['long-dwell-ai:' + ch](ev || {}, payload);
const U = { key: 'U1::primary', equipmentId: 'U1', woKey: 'primary', isPrimary: true, fp: 'fp1' };
let tmp;

function sender() {
  const ls = {};
  return { once: (ev, fn) => { ls[ev] = fn; }, fire: (ev) => ls[ev] && ls[ev]() };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-ipc-'));
  engine.close(); setDataDir(tmp);
  fill._resetDefaultForTests();
  ipc._resetForTests();
});
afterEach(() => { ipc._resetForTests(); fill._resetDefaultForTests(); jobs._resetForTests(); engine.close(); });

describe('long-dwell-ai IPC', () => {
  it('registers all six channels', () => {
    for (const ch of CHANNELS) expect(typeof handlers[ch]).toBe('function');
    expect(Object.keys(handlers).filter((k) => k.startsWith('long-dwell-ai:')).sort()).toEqual(CHANNELS.slice().sort());
  });

  it('flag off: status durable:false, the rest {ok:false, code:off}; no timer, no files', async () => {
    jobs._resetForTests({ flags: { enabled: false, types: {} } }); jobs.init();
    expect(await call('status')).toMatchObject({ ok: true, durable: false });
    const OFF = { ok: false, code: 'off' };
    expect(await call('plan', { table: 'computed', units: [U] })).toEqual(OFF);
    expect(await call('unit-start', { runId: 'r', key: 'U1::primary' })).toEqual(OFF);
    expect(await call('commit', { runId: 'r', table: 'computed', key: 'U1::primary', fp: 'fp1', result: { delayReason: 'Weather' } })).toEqual(OFF);
    expect(await call('finish', { runId: 'r' })).toEqual(OFF);
    expect(await call('today', { table: 'csv' })).toEqual(OFF);
    expect(ipc._sweepTimerForTests()).toBeNull();
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('validation errors come back as {ok:false}, never thrown', async () => {
    jobs._resetForTests({ flags: { enabled: false, types: {} } }); jobs.init();
    const bad = [
      ['plan', null],
      ['plan', { table: 'other', units: [] }],
      ['plan', { table: 'computed', units: 'x' }],
      ['plan', { table: 'computed', units: new Array(5001).fill(U) }],
      ['plan', { table: 'computed', units: [{ key: 'k'.repeat(257), fp: '' }] }],
      ['plan', { table: 'computed', units: [{ key: 'U1::primary', fp: 42 }] }],
      ['plan', { table: 'computed', units: [null] }],
      ['unit-start', { runId: '', key: 'k' }],
      ['commit', { runId: null, table: 'computed', key: 'k', fp: 'x'.repeat(65) }],
      ['commit', { runId: 'r', table: 'computed', key: 'k', fp: '', result: { summary: 5 } }],
      ['commit', { runId: 'r', table: 'computed', key: 'k', fp: '', result: [] }],
      ['finish', 'nope'],
      ['today', { table: 7 }],
    ];
    for (const [ch, p] of bad) {
      const r = await call(ch, p);
      expect(r, ch + ' ' + JSON.stringify(p && p.table)).toMatchObject({ ok: false, code: 'CONFIG_ERROR' });
    }
    expect(ipc._sweepTimerForTests()).toBeNull();
  });

  it('flag on: plan -> commit -> finish -> today; sweep timer created lazily (unref); destroyed renderer cancels the run', async () => {
    jobs._resetForTests({ flags: { enabled: true, types: { longDwellAiFill: true } } });
    expect(jobs.init()).toEqual({ mode: 'active' });
    expect(await call('status')).toMatchObject({ ok: true, durable: true, pending: [], filledToday: { computed: 0, csv: 0 } });
    expect(ipc._sweepTimerForTests()).toBeNull();
    const s1 = sender();
    const p = await call('plan', { table: 'computed', units: [U] }, { sender: s1 });
    expect(p).toMatchObject({ ok: true, busy: false, toFill: [{ key: 'U1::primary', reason: 'blank' }] });
    const timer = ipc._sweepTimerForTests();
    expect(timer).not.toBeNull();
    expect(typeof timer.hasRef === 'function' ? timer.hasRef() : false).toBe(false);
    expect(await call('unit-start', { runId: p.runId, key: 'U1::primary' })).toEqual({ ok: true });
    const c = await call('commit', { runId: p.runId, table: 'computed', key: 'U1::primary', fp: 'fp1', result: { delayReason: 'Weather', escalation: 'SEV5', summary: 'S' } });
    expect(c).toMatchObject({ ok: true, outcome: 'filled', unit: { delayReason: 'Weather', escalationLevel: 'SEV5', summary: 'S' } });
    expect(await call('finish', { runId: p.runId })).toMatchObject({ ok: true, counts: { filled: 1 } });
    expect(Object.keys((await call('today', { table: 'computed' })).entries)).toEqual(['U1::primary']);
    // destroyed renderer -> run cancelled, next plan is not busy
    const s2 = sender();
    const p2 = await call('plan', { table: 'csv', units: [] }, { sender: s2 });
    expect((await call('plan', { table: 'csv', units: [] })).busy).toBe(true);
    s2.fire('destroyed');
    expect(await call('finish', { runId: p2.runId })).toEqual({ ok: false, code: 'unknown-run' });
    expect((await call('plan', { table: 'csv', units: [] })).busy).toBe(false);
    expect(ipc._sweepTimerForTests()).toBe(timer);   // one timer only
  });
});
