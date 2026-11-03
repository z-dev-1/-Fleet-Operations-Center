// tests/jobs-states.test.js — T2: state machine + store transitions + reconcile
// (Phase 7, design §3, round-3 fix 6).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const { STATES, TRANSITIONS, TERMINAL, LEASED, WAITING, canTransition } = require('../src/jobs/states');
const schema = require('../src/jobs/schema');
const { createJobStore } = require('../src/jobs/store');

describe('T2 pure state machine', () => {
  it('has the 11 states, frozen', () => {
    expect(STATES).toEqual(['queued', 'claimed', 'running', 'waiting_on_dependency', 'waiting_on_auth', 'waiting_on_approval',
      'verifying', 'completed', 'failed', 'cancelled', 'recovery_required']);
    expect(Object.isFrozen(STATES)).toBe(true);
    expect(Object.isFrozen(TRANSITIONS)).toBe(true);
    expect(TERMINAL).toEqual(['completed', 'failed', 'cancelled']);
    expect(LEASED).toEqual(['claimed', 'running', 'verifying']);
    expect(WAITING).toEqual(['waiting_on_dependency', 'waiting_on_auth', 'waiting_on_approval']);
  });
  it('exhaustive 11x11: canTransition iff listed; same-state rejected', () => {
    let allowed = 0;
    for (const a of STATES) for (const b of STATES) {
      const exp = a !== b && TRANSITIONS[a].includes(b);
      expect(canTransition(a, b), a + '->' + b).toBe(exp);
      if (exp) allowed++;
      if (a === b) expect(canTransition(a, b)).toBe(false);
    }
    expect(allowed).toBe(37);
    expect(canTransition('bogus', 'queued')).toBe(false);
    expect(canTransition('completed', 'queued')).toBe(false);
    expect(canTransition('cancelled', 'queued')).toBe(false);
  });
});

let tmp, db, store, warns, clock;
function mkRow(o) {
  const r = Object.assign({ id: 'j' + Math.random().toString(36).slice(2, 8), type: 'deepScan', scope_key: 'fleet', generation: 1, state: 'queued', attempt: 0, max_attempts: 3, owner: null, lease_until: null, created_at: clock.t, updated_at: clock.t }, o);
  db.prepare('INSERT INTO jobs (id,type,scope_key,generation,idempotency_key,state,attempt,max_attempts,owner,lease_until,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(r.id, r.type, r.scope_key, r.generation, r.type + ':' + r.scope_key + ':' + r.generation, r.state, r.attempt, r.max_attempts, r.owner, r.lease_until, r.created_at, r.updated_at);
  return r.id;
}
const get = (id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-states-'));
  const file = path.join(tmp, 't.sqlite');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 50;');
  const ad = { id: file, exec: (s) => (db.exec(s), true), prepare: (s) => db.prepare(s), getDb: () => db };
  schema._resetForTests();
  expect(schema.ensureSchema(ad).ok).toBe(true);
  warns = [];
  clock = { t: 1_800_000_000_000 };
  store = createJobStore({ adapter: ad, now: () => clock.t, owner: 'hostA|1|bootA', log: { info() {}, warn: (m) => warns.push(m), error: (m) => warns.push(m), debug() {} } });
});
afterEach(() => { try { db.close(); } catch (_) {} });

describe('T2 store.transition', () => {
  it('rejects an illegal move with {ok:false}, row unchanged, warn logged', () => {
    const id = mkRow({ state: 'queued' });
    const before = get(id);
    const r = store.transition(id, 'completed');
    expect(r).toEqual({ ok: false, error: 'illegal transition queued -> completed' });
    expect(get(id)).toEqual(before);
    expect(warns.some((w) => /illegal transition queued -> completed/.test(w))).toBe(true);
  });
  it('rejects same-state', () => {
    const id = mkRow({ state: 'running', attempt: 1 });
    expect(store.transition(id, 'running').ok).toBe(false);
  });
  it('CAS fails when the state changed underneath (expectFrom)', () => {
    const id = mkRow({ state: 'running', attempt: 1 });
    expect(store.transition(id, 'completed', { expectFrom: 'claimed' })).toMatchObject({ ok: false, error: 'state changed' });
    expect(get(id).state).toBe('running');
  });
  it('terminal entry clears the lease and stamps finished_at; history capped at 20', () => {
    const id = mkRow({ state: 'queued' });
    for (let i = 0; i < 12; i++) {
      clock.t += 1;
      expect(store.transition(id, 'claimed').ok).toBe(true);
      db.prepare('UPDATE jobs SET lease_until = ? WHERE id = ?').run(clock.t + 1000, id);
      expect(store.transition(id, 'queued').ok).toBe(true);
    }
    expect(JSON.parse(get(id).history_json).length).toBe(20);
    store.transition(id, 'claimed');
    db.prepare('UPDATE jobs SET lease_until = ? WHERE id = ?').run(clock.t + 1000, id);
    store.transition(id, 'running');
    expect(get(id).lease_until).not.toBeNull();
    clock.t += 5;
    expect(store.transition(id, 'completed').ok).toBe(true);
    const row = get(id);
    expect(row.lease_until).toBeNull();
    expect(row.finished_at).toBe(clock.t);
    expect(row.started_at).not.toBeNull();
  });
  it('recovery_required exits only via reconcile()', () => {
    const id = mkRow({ state: 'recovery_required', attempt: 1 });
    const before = get(id);
    expect(store.transition(id, 'queued')).toEqual({ ok: false, error: 'recovery_required exits only via reconcile()' });
    expect(get(id)).toEqual(before);
    expect(store.reconcile(id, 'not-done').ok).toBe(true);
    expect(get(id).state).toBe('queued');
  });
});

describe('T2 reconcile outcomes [round-3 fix 6]', () => {
  it('accepts exactly not-done/done/failed/cancel', () => {
    const map = { 'not-done': 'queued', done: 'completed', failed: 'failed', cancel: 'cancelled' };
    for (const [outcome, to] of Object.entries(map)) {
      const id = mkRow({ state: 'recovery_required', scope_key: 's-' + outcome, attempt: 1 });
      expect(store.reconcile(id, outcome)).toMatchObject({ ok: true, from: 'recovery_required', to });
      expect(get(id).state).toBe(to);
    }
  });
  it('rejects any other outcome with {ok:false, error:"invalid outcome"} and no write', () => {
    const id = mkRow({ state: 'recovery_required', attempt: 1 });
    const before = get(id);
    for (const bad of ['abandon', 'x', '', null, undefined, 'DONE', 'completed', 'toString', '__proto__', 42]) {
      expect(store.reconcile(id, bad)).toEqual({ ok: false, error: 'invalid outcome' });
      expect(get(id)).toEqual(before);
    }
  });
  it('reconcile on a non-recovery_required row does not write', () => {
    const id = mkRow({ state: 'running', attempt: 1 });
    expect(store.reconcile(id, 'done').ok).toBe(false);
    expect(get(id).state).toBe('running');
  });
});
