// tests/workers-isolation-protocol.test.js — protocol v1, group spec, canonical result validator (design §5).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const P = require('../src/workers/isolation/protocol');
const groups = require('../src/workers/isolation/groups');
const canonical = require('../src/orcha/canonical_state');

const vw = (m) => P.validateFromWorker(m);
const vh = (m) => P.validateFromHost(m);

describe('protocol v1', () => {
  it('constants', () => {
    expect(P.PROTOCOL_VERSION).toBe(1);
    expect(Object.keys(P.CODES)).toHaveLength(16);
    expect(P.EXIT).toEqual({ PARENT_SILENT: 3, NO_INIT: 4, BAD_INIT: 65, FATAL: 70 });
  });

  it('validateFromWorker accepts/rejects every type', () => {
    for (const bad of [null, 1, 'x', [], { t: 1 }, { t: 'nope' }]) expect(vw(bad).ok).toBe(false);
    expect(vw({ t: 'hello', v: 1, group: 'canonical', pid: 10, ppid: 2, ops: ['a'] }).ok).toBe(true);
    expect(vw({ t: 'hello', v: 2, group: 'canonical', pid: 10, ppid: 2, ops: ['a'] }).reason).toBe('version');
    expect(vw({ t: 'hello', v: 1, group: 'canonical', pid: 10, ppid: 2, ops: 'a' }).ok).toBe(false);
    expect(vw({ t: 'hello', v: 1, group: 'c', pid: 10, ppid: 2, ops: [], diag: { envKeys: ['A'], execArgv: [] } }).msg.diag).toEqual({ envKeys: ['A'], execArgv: [] });
    expect(vw({ t: 'hello', v: 1, group: 'c', pid: 10, ppid: 2, ops: [], diag: { envKeys: 'A' } }).ok).toBe(false);
    expect(vw({ t: 'res', id: 1, ok: true, result: { a: 1 } }).ok).toBe(true);
    expect(vw({ t: 'res', id: 1.5, ok: true }).ok).toBe(false);
    expect(vw({ t: 'res', id: 1, ok: 'yes' }).ok).toBe(false);
    expect(vw({ t: 'res', id: 1, ok: false, error: { code: 'OP_FAILED', message: 'x'.repeat(500) } }).msg.error.message).toHaveLength(200);
    expect(vw({ t: 'res', id: 1, ok: false, error: { code: 'op-failed', message: 'x' } }).ok).toBe(false);
    expect(vw({ t: 'res', id: 1, ok: false, error: { code: 'A'.repeat(41), message: 'x' } }).ok).toBe(false);
    expect(vw({ t: 'progress', id: 1, pct: 50, note: 'n' }).ok).toBe(true);
    expect(vw({ t: 'progress', id: 1, pct: 101 }).ok).toBe(false);
    expect(vw({ t: 'progress', id: 1, pct: -1 }).ok).toBe(false);
    expect(vw({ t: 'progress', id: 1, pct: NaN }).ok).toBe(false);
    expect(vw({ t: 'pong', seq: 1, rss: 10, heapUsed: 5 }).ok).toBe(true);
    expect(vw({ t: 'pong', seq: 1, rss: -1, heapUsed: 5 }).ok).toBe(false);
    expect(vw({ t: 'log', level: 'warn', msg: 'hi' }).ok).toBe(true);
    expect(vw({ t: 'log', level: 'trace', msg: 'hi' }).ok).toBe(false);
    expect(vw({ t: 'log', level: 'info', msg: 'y'.repeat(900) }).msg.msg).toHaveLength(500);
    expect(vw({ t: 'ai', aiId: 1, id: 1, prompt: 'p', opts: {} }).ok).toBe(true);
    expect(vw({ t: 'ai', aiId: 0, id: 1, prompt: 'p' }).ok).toBe(false);
    expect(vw({ t: 'ai', aiId: 1, id: 1, prompt: 5 }).ok).toBe(false);
    expect(vw({ t: 'fatal', code: 'UNCAUGHT', message: 'm' }).ok).toBe(true);
    expect(vw({ t: 'fatal', code: 1, message: 'm' }).ok).toBe(false);
  });

  it('validateFromHost accepts/rejects every type', () => {
    const init = { t: 'init', v: 1, group: 'canonical', parentPid: 5, pingTimeoutMs: 30000, ppidPollMs: 2000, maxLogPerMin: 50, workerSilenceExitMs: 45000, diag: false };
    expect(vh(init).ok).toBe(true);
    expect(vh(Object.assign({}, init, { v: 2 })).ok).toBe(false);
    expect(vh(Object.assign({}, init, { parentPid: 0 })).ok).toBe(false);
    expect(vh(Object.assign({}, init, { diag: 'no' })).ok).toBe(false);
    expect(vh({ t: 'req', id: 1, op: 'x', payload: { a: 1 } }).ok).toBe(true);
    expect(vh({ t: 'req', id: 0, op: 'x' }).ok).toBe(false);
    expect(vh({ t: 'req', id: 1, op: '' }).ok).toBe(false);
    expect(vh({ t: 'cancel', id: 1 }).ok).toBe(true);
    expect(vh({ t: 'cancel', id: -1 }).ok).toBe(false);
    expect(vh({ t: 'ping', seq: 1 }).ok).toBe(true);
    expect(vh({ t: 'ping', seq: 0 }).ok).toBe(false);
    expect(vh({ t: 'ai.res', aiId: 1, ok: true, text: 't' }).ok).toBe(true);
    expect(vh({ t: 'ai.res', aiId: 1, ok: false, code: 'bad code' }).ok).toBe(false);
    expect(vh({ t: 'shutdown' }).ok).toBe(true);
    for (const bad of [null, [], { t: 'hello' }, { t: 3 }]) expect(vh(bad).ok).toBe(false);
  });

  it('clip limits and control-char strip', () => {
    expect(P.clip('a\u0000b\nc\u007f', 10)).toBe('abc');
    expect(P.clip('x'.repeat(10), 4)).toBe('xxxx');
    expect(P.clip(null, 4)).toBe('');
  });
});

describe('group spec', () => {
  it('canonical spec literal', () => {
    const s = groups.canonical;
    expect(Object.isFrozen(s)).toBe(true);
    expect(s).toMatchObject({ group: 'canonical', name: 'isoCanonical', serviceName: 'fleet-worker-canonical', heapMb: 384, rssCapMb: 512,
      startTimeoutMs: 10000, requestTimeoutMs: 30000, cancelGraceMs: 2000, maxConcurrency: 1, queueMax: 4, pingIntervalMs: 10000,
      pingMissLimit: 3, workerSilenceExitMs: 45000, ppidPollMs: 2000, maxCrashes: 3, cooldownMs: 1800000, maxRestarts: 3, maxLogPerMin: 50 });
    expect(s.ai.maxPerRequest).toBe(0);
    expect(s.file.endsWith(require('path').join('entries', 'canonical-worker.js'))).toBe(true);
  });

  it('assertSpec throws for AI budget with zero timeout', () => {
    expect(() => groups.assertSpec({ group: 'x', ai: { maxPerRequest: 1, maxTimeoutMs: 0, maxConcurrent: 1, maxPromptChars: 10 } })).toThrow(/maxTimeoutMs/);
    expect(() => groups.assertSpec({ group: 'x', ai: { maxPerRequest: 1, maxTimeoutMs: 1000, maxConcurrent: 0, maxPromptChars: 10 } })).toThrow(/maxConcurrent/);
    expect(() => groups.assertSpec({ group: 'x', ai: { maxPerRequest: 1, maxTimeoutMs: 1000, maxConcurrent: 1, maxPromptChars: 0 } })).toThrow(/maxPromptChars/);
    expect(() => groups.assertSpec({ group: 'x', ai: { maxPerRequest: 0 } })).not.toThrow();
  });
});

const ROWS = [
  { equipmentId: 'U1', lifecycleState: 'Unavailable', issueSummary: 'turbo replacement', offsiteStage: 'ready', offsiteStageSince: '2026-10-29T09:00:00Z' },
  { equipmentId: 'U2', lifecycleState: 'Available' },
  { equipmentId: 'U3', lifecycleState: 'Unavailable', offsiteStage: 'repair', offsiteStageDetail: 'Road Test', offsiteStageSince: '2026-10-29T09:00:00Z' },
];
const build = (rows) => { const { units, counts } = canonical.buildAll(rows, { decisions: {}, prior: {} }); return structuredClone({ units, counts }); };
const V = (res, rows) => groups.validateCanonicalResult('canonical.buildAll', res, { rows });

describe('validateCanonicalResult', () => {
  it('validator rejects corruptions', () => {
    const good = build(ROWS);
    expect(V(good, ROWS).ok).toBe(true);
    const foreign = structuredClone(good); foreign.units.ZZ = Object.assign({}, foreign.units.U1, { equipmentId: 'ZZ' }); foreign.counts.total = 4;
    expect(V(foreign, ROWS.concat([{ equipmentId: 'U4' }])).rule).toBe('foreign-key');
    const status = structuredClone(good); status.units.U1.status = 'bogus';
    expect(V(status, ROWS).rule).toBe('status');
    const vid = structuredClone(good); vid.units.U1.equipmentId = 'U2';
    expect(V(vid, ROWS).rule).toBe('value-id');
    const cnt = structuredClone(good); cnt.counts.total = 99;
    expect(V(cnt, ROWS).rule).toBe('counts-total');
    const neg = structuredClone(good); neg.counts.changed = -1;
    expect(V(neg, ROWS).rule).toBe('counts-shape');
    expect(V(Object.assign({}, good, { units: [1, 2] }), ROWS).rule).toBe('units-shape');
    expect(V(good, ROWS.slice(0, 1)).rule).toBe('units-count');
    expect(V(null, ROWS).rule).toBe('result-shape');
    expect(groups.validateCanonicalResult('other.op', good, { rows: ROWS }).rule).toBe('op');
  });

  it('validator accepts padded/NUL/mojibake ids from real buildAll', () => {
    const moj = 'B12\u00e2\u20ac\u201c343';   // UTF-8 en dash read as cp1252
    const rows = [{ equipmentId: '  322504 ', lifecycleState: 'Unavailable' }, { equipmentId: 'X9\u0000', lifecycleState: 'Available' }, { equipmentId: moj, lifecycleState: 'Available' }];
    const res = build(rows);
    expect(Object.keys(res.units)).toContain('322504');
    expect(Object.keys(res.units)).toContain('X9');
    expect(Object.keys(res.units)).toContain(canonical._normId(moj));
    const v = V(res, rows);
    expect(v.ok).toBe(true);
    expect(v.value.counts.total).toBe(3);
  });

  it('keying parity: _normId matches buildAll keys', () => {
    const rows = ROWS.concat([{ equipmentId: '  7 ' }, { equipmentId: 'Y\u0000' }, { equipmentId: '' }, { equipmentId: null }, { equipmentId: 'B12\u00e2\u20ac\u201c1' }]);
    const keys = new Set(Object.keys(canonical.buildAll(rows, { decisions: {}, prior: {} }).units));
    const ids = new Set(rows.map((r) => canonical._normId(r.equipmentId)).filter(Boolean));
    expect(keys).toEqual(ids);
  });
});
