// tests/jobs-no-tx-across-await.test.js — T9 (gate d): no transaction ever
// spans an await of network / AI / browser work. Covers the _tx guards
// (async fn, thenable, nested, _inTx fallback, begin failed, prepare null),
// a static scan of store.js / schema.js, and live durable runs of deep-scan,
// repair-intel and rca:draft whose every outside call asserts that neither
// the recording adapter nor the db is inside a transaction.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import * as fx from './fixtures/jobs-deep-scan-fixture.js';
const require = createRequire(import.meta.url);

fx.installStubs();   // logger, JSON store (Map), relay, enrich, notifier, ready-pickup, repair-history
function inject(rel, exp) { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; }
let probe = () => {};
inject('../src/cluster', { mayRunProduction: () => true });
inject('../src/repair-intel/schema', { ensureSchema: () => true });
inject('../src/repair-intel/store', { getCheckpoint: () => null });
inject('../src/repair-intel/fetch', { syncUnit: async (id) => { probe('syncUnit:' + id); return { ok: true, added: id === 'R1' ? 1 : 0 }; } });
inject('../src/repair-intel/analysis', { analyzeUnit: async (id) => { probe('analyzeUnit:' + id); return { ok: true }; } });
const handlers = {};
inject('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } });
inject('../src/rca/autofill', { buildDraft: async () => { probe('buildDraft'); return { ok: true, draft: {} }; }, computePrefill: async () => ({}) });
inject('../src/rca/client', { getTemplate: async () => ({}), findRcaResponse: async () => null, responseIdOf: () => null, submitResponse: async () => ({}) });
inject('../src/rca/template', { normalizeResponse: () => ({ response: {}, errors: [], warnings: [] }) });

const { DatabaseSync } = require('node:sqlite');
const schema = require('../src/jobs/schema');
const { createJobStore, JobsTxError } = require('../src/jobs/store');
const jobs = require('../src/jobs');
const ds = require('../src/orcha/deep-scan');
const bg = require('../src/repair-intel/background');
require('../src/ipc/rca').registerRcaIPC();

let tmp, file; const dbs = [];
function open() {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 50;');
  dbs.push(db);
  return db;
}
function recAdapter(db) {
  const r = { inTx: false, begins: 0 };
  r.ad = {
    id: file,
    exec: (s) => { if (/^BEGIN/.test(s)) r.begins++; db.exec(s); if (/^BEGIN/.test(s)) r.inTx = true; if (/^(COMMIT|ROLLBACK)/.test(s)) r.inTx = false; return true; },
    prepare: (s) => db.prepare(s),
    getDb: () => db,
  };
  return r;
}
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-notx-')); file = path.join(tmp, 't.sqlite'); schema._resetForTests(); fx.resetRecorders(); probe = () => {}; });
afterEach(() => { vi.restoreAllMocks(); jobs._resetForTests(); while (dbs.length) { try { dbs.pop().close(); } catch (_) {} } });

describe('T9 _tx guards', () => {
  function mk(adapterOverride) {
    const db = open();
    const r = recAdapter(db);
    schema.ensureSchema(r.ad);
    const s = createJobStore({ adapter: adapterOverride ? adapterOverride(db, r.ad) : r.ad, now: () => 1, owner: 'h|1|b', log: quiet });
    return { s, db, r };
  }
  const insert = (db, id) => db.prepare("INSERT INTO jobs (id,type,scope_key,generation,idempotency_key,state,created_at,updated_at) VALUES (?, 'deepScan', ?, 1, ?, 'queued', 1, 1)").run(id, id, id);
  const count = (db) => db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;

  it('_tx(async …) throws before BEGIN; _tx(() => Promise.resolve()) throws and rolls back, leaving no row', () => {
    const { s, db, r } = mk();
    expect(() => s._tx(async () => { insert(db, 'a1'); })).toThrow('async fn not allowed');
    expect(r.begins).toBe(0);
    expect(() => s._tx(() => { insert(db, 'a2'); return Promise.resolve(); })).toThrow(JobsTxError);
    expect(() => s._tx(() => { insert(db, 'a3'); return Promise.resolve(); })).toThrow('thenable returned');
    expect(count(db)).toBe(0);
    expect(db.isTransaction).toBe(false);
  });

  it('nested guard', () => {
    const { s, db } = mk();
    expect(() => s._tx(() => s._tx(() => 1))).toThrow('nested');
    expect(db.isTransaction).toBe(false);
  });

  it('_inTx fallback with isTransaction hidden: nested and thenable guards still fire', () => {
    const { s, db } = mk((rawDb, ad) => {
      const hidden = new Proxy(rawDb, { get: (t, k) => (k === 'isTransaction' ? undefined : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
      return Object.assign({}, ad, { getDb: () => hidden });
    });
    expect(() => s._tx(() => s._tx(() => 1))).toThrow('nested');
    expect(() => s._tx(() => { insert(db, 'h1'); return { then() {} }; })).toThrow('thenable returned');
    expect(count(db)).toBe(0);
    expect(() => s._recoverRowInTx({ id: 'x', state: 'running' }, 1)).toThrow('not in tx');
  });

  it('exec -> false: begin failed, fn never called, begin -> {code:"sqlite"}; facade NOOP with lastError.code sqlite', () => {
    const { s } = mk((rawDb, ad) => Object.assign({}, ad, { exec: () => false }));
    const fn = vi.fn(() => 1);
    expect(() => s._tx(fn)).toThrow('begin failed');
    expect(fn).not.toHaveBeenCalled();
    expect(s.begin('deepScan', 'fleet', require('../src/jobs/types').get('deepScan'))).toMatchObject({ ok: false, code: 'sqlite' });
    // facade: schema already created on this file; adapter exec now returns false for BEGIN
    const db2 = open();
    const ad2 = { id: file, exec: (q) => (/^BEGIN/.test(q) ? false : (db2.exec(q), true)), prepare: (q) => db2.prepare(q), getDb: () => db2 };
    jobs._resetForTests({ flags: { enabled: true, types: { deepScan: true } }, adapter: ad2, logger: quiet });
    jobs.init();
    const h = jobs.begin({ type: 'deepScan', scopeKey: 'fleet' });
    expect(h.durable).toBe(false);
    expect(jobs.getStatus().lastError.code).toBe('sqlite');
  });

  it('prepare -> null: code sqlite, NOOP, no TypeError escapes', () => {
    const { s } = mk((rawDb, ad) => Object.assign({}, ad, { prepare: () => null }));
    let r;
    expect(() => { r = s.begin('deepScan', 'fleet', require('../src/jobs/types').get('deepScan')); }).not.toThrow();
    expect(r).toMatchObject({ ok: false, code: 'sqlite', error: 'prepare returned null' });
    expect(s.lastError.code).toBe('sqlite');
  });

  it('static scan: store.js and schema.js contain no async functions and no await', () => {
    for (const f of ['../src/jobs/store.js', '../src/jobs/schema.js']) {
      const src = fs.readFileSync(require.resolve(f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``');
      expect(src, f).not.toMatch(/\basync\b|\bawait\b/);
    }
  });
});

describe('T9 durable runs: no transaction open at any outside await', () => {
  function facade(flags) {
    const db = open();
    const r = recAdapter(db);
    jobs._resetForTests({ flags, adapter: r.ad, logger: quiet });
    expect(jobs.init()).toEqual({ mode: 'active' });
    const seen = [];
    const violations = [];
    // Recorded (not thrown): the bodies catch stub errors, which would hide a failed expect.
    probe = (what) => { seen.push(what); if (r.inTx !== false || db.isTransaction !== false) violations.push(what); };
    return { db, r, seen, violations };
  }

  it('deep-scan (relay.ask + enrich)', async () => {
    const f = facade({ enabled: true, types: { deepScan: true } });
    fx.rec.onRelay = (id) => probe('relay:' + id);
    fx.rec.onEnrich = (u) => probe('enrich:' + u);
    await fx.runScenario(ds, 'fleet');
    expect(f.seen.filter((s) => s.startsWith('relay:')).length).toBe(6);
    expect(f.seen.filter((s) => s.startsWith('enrich:')).length).toBe(5);
    expect(f.r.begins).toBeGreaterThan(3);
    expect(f.db.prepare('SELECT state FROM jobs').get().state).toBe('completed');
    expect(f.violations).toEqual([]);
  });

  it('repair-intel (syncUnit + analyzeUnit)', async () => {
    const f = facade({ enabled: true, types: { repairIntel: true } });
    fx.rec.store.set('fleetData', { rows: [{ equipmentId: 'R1' }, { equipmentId: 'R2' }] });
    await bg.runOnce();
    expect(f.seen).toEqual(['syncUnit:R1', 'syncUnit:R2', 'analyzeUnit:R1']);
    expect(f.db.prepare('SELECT state FROM jobs').get().state).toBe('completed');
    expect(f.violations).toEqual([]);
  });

  it('rca:draft (buildDraft)', async () => {
    const f = facade({ enabled: true, types: { rcaAutofill: true } });
    const r = await handlers['rca:draft']({}, { workOrderId: '11111111-2222-3333-4444-555555555555' });
    expect(r).toEqual({ ok: true, draft: {} });
    expect(f.seen).toEqual(['buildDraft']);
    expect(f.db.prepare('SELECT state FROM jobs').get().state).toBe('completed');
    expect(f.violations).toEqual([]);
  });
});
