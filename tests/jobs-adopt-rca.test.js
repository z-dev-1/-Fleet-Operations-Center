// tests/jobs-adopt-rca.test.js — T12: rca:draft tracking-only adoption (Phase 7,
// design §9.3). Fake ipcMain + stubbed autofill.buildDraft; no Relay/AI/Electron.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

function inject(rel, exp) { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; }
const handlers = {};
inject('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } });
const warnings = [];
function fakeLogger(ns) { return { debug() {}, info() {}, warn: (m) => warnings.push(ns + ':' + m), error: (m) => warnings.push(ns + ':' + m) }; }
fakeLogger.createLogger = fakeLogger; fakeLogger.setLogDir = () => {}; fakeLogger.setLevel = () => {}; fakeLogger.setSilent = () => {}; fakeLogger.LEVELS = {};
inject('../src/utils/logger', fakeLogger);
let draftImpl = null;
const draftCalls = [];
inject('../src/rca/autofill', {
  buildDraft: async (a) => { draftCalls.push(a); return draftImpl(a); },
  computePrefill: async () => { throw new Error('rca:submit must not run'); },
});
const submits = [];
inject('../src/rca/client', {
  getTemplate: async () => ({}), findRcaResponse: async () => null, responseIdOf: () => null,
  submitResponse: async (...a) => { submits.push(a); return {}; },
});
inject('../src/rca/template', { normalizeResponse: () => ({ response: {}, errors: [], warnings: [] }) });

const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const jobs = require('../src/jobs');
require('../src/ipc/rca').registerRcaIPC();
const draft = (args) => handlers['rca:draft']({}, args);
const WO = '11111111-2222-3333-4444-555555555555';
const ARGS = { equipmentId: 'U1', workOrderId: WO, unit: { equipmentId: 'U1' } };
const OK = { ok: true, draft: { values: { a: 1 } }, existing: false, aiError: null };

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-rca-')); engine.close(); setDataDir(tmp); draftCalls.length = 0; warnings.length = 0; });
afterEach(() => { vi.restoreAllMocks(); jobs._resetForTests(); engine.close(); });
const rows = () => engine.getDb().prepare('SELECT type, scope_key, state, last_error FROM jobs ORDER BY generation').all();

describe('T12 rca:draft', () => {
  it('return value identical with flags off and on; on -> completed tracking row', async () => {
    draftImpl = async () => JSON.parse(JSON.stringify(OK));
    jobs._resetForTests({ flags: { enabled: false, types: {} } }); jobs.init();
    const off = await draft(ARGS);
    expect(fs.existsSync(path.join(tmp, 'transactional.sqlite'))).toBe(false);
    jobs._resetForTests({ flags: { enabled: true, types: { rcaAutofill: true } } }); jobs.init();
    const on = await draft(ARGS);
    expect(on).toEqual(off);
    expect(draftCalls).toEqual([
      { equipmentId: 'U1', workOrderId: WO, vendorWorkOrderId: null, unit: { equipmentId: 'U1' } },
      { equipmentId: 'U1', workOrderId: WO, vendorWorkOrderId: null, unit: { equipmentId: 'U1' } },
    ]);
    expect(rows()).toEqual([{ type: 'rcaAutofill', scope_key: WO, state: 'completed', last_error: null }]);
  });

  it('[gate f] degraded -> identical to flags off', async () => {
    draftImpl = async () => JSON.parse(JSON.stringify(OK));
    jobs._resetForTests({ flags: { enabled: false, types: {} } }); jobs.init();
    const off = await draft(ARGS);
    vi.spyOn(engine, 'isAvailable').mockReturnValue(false);
    jobs._resetForTests({ flags: { enabled: true, types: { rcaAutofill: true } } });
    expect(jobs.init().mode).toBe('degraded');
    expect(await draft(ARGS)).toEqual(off);
  });

  it('ok:false -> job failed; returned unchanged', async () => {
    draftImpl = async () => ({ ok: false, error: 'Template unavailable' });
    jobs._resetForTests({ flags: { enabled: true, types: { rcaAutofill: true } } }); jobs.init();
    expect(await draft(ARGS)).toEqual({ ok: false, error: 'Template unavailable' });
    expect(rows()).toEqual([{ type: 'rcaAutofill', scope_key: WO, state: 'failed', last_error: 'Template unavailable' }]);
  });

  it('a throw -> job failed and the handler maps it to {ok:false} as today', async () => {
    draftImpl = async () => { const e = new Error('relay down'); e.code = 'RELAY_NETWORK'; throw e; };
    jobs._resetForTests({ flags: { enabled: false, types: {} } }); jobs.init();
    const off = await draft(ARGS);
    jobs._resetForTests({ flags: { enabled: true, types: { rcaAutofill: true } } }); jobs.init();
    const on = await draft(ARGS);
    expect(on).toEqual({ ok: false, error: 'relay down', code: 'RELAY_NETWORK' });
    expect(on).toEqual(off);
    expect(rows()).toEqual([{ type: 'rcaAutofill', scope_key: WO, state: 'failed', last_error: 'relay down' }]);
  });

  it('a concurrent same-work-order call gets busy and still returns the draft', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    draftImpl = async () => { await gate; return JSON.parse(JSON.stringify(OK)); };
    jobs._resetForTests({ flags: { enabled: true, types: { rcaAutofill: true } } }); jobs.init();
    const p1 = draft(ARGS);
    const p2 = draft(ARGS);
    release();
    expect(await p1).toEqual(OK);
    expect(await p2).toEqual(OK);
    expect(rows()).toEqual([{ type: 'rcaAutofill', scope_key: WO, state: 'completed', last_error: null }]);
  });

  it('invalid work order id is rejected before any job; rca:submit creates no rows', async () => {
    jobs._resetForTests({ flags: { enabled: true, types: { rcaAutofill: true } } }); jobs.init();
    expect(await draft({ workOrderId: 'nope' })).toEqual({ ok: false, error: 'Invalid work order id' });
    await handlers['rca:submit']({}, { workOrderId: 'bad' });
    expect(rows()).toEqual([]);
    expect(submits).toEqual([]);
  });
});
