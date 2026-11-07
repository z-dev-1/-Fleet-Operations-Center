// tests/repair-intel-wo-summary.test.js — per-WO AI 3C summary: output schema,
// anti-fabrication (verbatim quote or "Not recorded"), confirmed vs suspected,
// structured / no-evidence short-circuits, content-hash cache, force, bounded
// concurrency, timeout fallback, priority sources, offsite basis, log hygiene.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const store = require('../src/repair-intel/store');
const ws = require('../src/repair-intel/wo-summary');

const DAY = 24 * 3600 * 1000;
const UNIT = 'UNIT-3C';
const NOW = 1_800_000_000_000;
let tmpDir;

const COMPLAINT = 'Air leak at the rear axle, driver reports low pressure warning';
const C_FIND = 'Tech found a cracked air line at the rear axle brake chamber';
const C_FIX = 'Replaced the cracked air line and leak tested, no leaks found';

function seed(id, opts) {
  const o = opts || {};
  store.upsertEvent(store.normalizeWorkOrder({
    workRequestId: id, assetDisplayName: UNIT, vendor: 'Acme Truck Repair', category: 'Unplanned Repair',
    status: { description: { value: 'COMPLETED' } }, suggestedItems: [{ level1: 'Air System' }],
    damageDescription: o.complaint === undefined ? COMPLAINT : o.complaint,
    reportedDateTime: new Date(NOW - 10 * DAY).toISOString(),
    completedDateTime: new Date(NOW - 9 * DAY).toISOString(),
  }));
  if (o.evidence !== null) {
    store.setWoDetail(id, {
      dealer: null, modifiedAt: 1,
      evidence: Object.assign({
        v: 1, complaint: o.complaint === undefined ? COMPLAINT : (o.complaint || ''), cause: '', correction: '',
        comments: [{ at: NOW - 9.5 * DAY, text: C_FIND }, { at: NOW - 9 * DAY, text: C_FIX }],
        commentCount: 2, lastCommentAt: NOW - 9 * DAY,
      }, o.evidence || {}),
    });
  }
  return ev(id);
}
const ev = (id) => store.eventsForUnit(UNIT).find((e) => e.source_id === id);
const json = (o) => JSON.stringify(o);
const reply = (c, ca, co) => json({ complaint: c || { text: '', quote: '' }, cause: ca || { text: '', quote: '' }, correction: co || { text: '', quote: '' } });
const GOOD = reply(
  { text: 'Air leak at the rear axle.', quote: 'Air leak at the rear axle' },
  { text: 'Cracked air line at the rear brake chamber.', quote: 'cracked air line at the rear axle brake chamber' },
  { text: 'Replaced the air line and leak tested.', quote: 'Replaced the cracked air line and leak tested' },
);

const logs = [];
const logger = { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) };

function make(responses, extra) {
  const q = Array.isArray(responses) ? responses.slice() : [];
  const calls = [];
  const ask = vi.fn(async (prompt, o) => { calls.push({ prompt, o }); return q.length ? q.shift() : GOOD; });
  const rwtCalls = [];
  const runWithTimeout = vi.fn((run, o) => { rwtCalls.push(o); return run(undefined); });
  const s = ws.createWoSummarizer(Object.assign({ ask, runWithTimeout, now: () => NOW, store, logger, getModel: () => 'm1' }, extra || {}));
  return { s, ask, calls, rwtCalls, runWithTimeout };
}

describe('repair-intel wo-summary (per-WO 3C)', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-3c-'));
    setDataDir(tmpDir);
    engine.close();
  });
  afterAll(() => {
    try { engine.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('exact output schema; quote in complaint field → confirmed, from comments → suspected', async () => {
    const e = seed('S1');
    const { s, ask } = make([GOOD]);
    const out = await s.summarize([e]);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(out.results.S1.status).toBe('fresh');
    const t = out.results.S1.threeC;
    expect(Object.keys(t).sort()).toEqual(['ai', 'at', 'basis', 'cause', 'complaint', 'correction', 'model', 'v']);
    expect(t).toEqual({
      v: 1,
      complaint: { text: 'Air leak at the rear axle.', status: 'confirmed' },
      cause: { text: 'Cracked air line at the rear brake chamber.', status: 'suspected' },
      correction: { text: 'Replaced the air line and leak tested.', status: 'suspected' },
      basis: 'aap', ai: true, at: NOW, model: 'm1',
    });
    expect(JSON.parse(ev('S1').wo_3c)).toEqual(t);
    expect(ev('S1').wo_3c_hash).toBe(ws.contentHash(ev('S1'), ''));
    expect(out.counts).toEqual({ cached: 0, fresh: 1, structured: 0, no_evidence: 0, timeout: 0, error: 0 });
  });

  it('model omits correction → Not recorded', async () => {
    const e = seed('S2');
    const { s } = make([json({ complaint: { text: 'Air leak.', quote: 'Air leak at the rear axle' }, cause: { text: 'x', quote: 'cracked air line at the rear axle' } })]);
    const t = (await s.summarize([e])).results.S2.threeC;
    expect(t.correction).toEqual({ text: ws.NOT_RECORDED, status: 'not_recorded' });
  });

  it('cause whose quote is not in the evidence → Not recorded (no invented cause)', async () => {
    const e = seed('S3');
    const { s } = make([reply(
      { text: 'Air leak.', quote: 'Air leak at the rear axle' },
      { text: 'Failed air compressor governor.', quote: 'air compressor governor failed' },
      { text: 'Too short quote', quote: 'Replace' },
    )]);
    const t = (await s.summarize([e])).results.S3.threeC;
    expect(t.cause).toEqual({ text: 'Not recorded', status: 'not_recorded' });
    expect(t.correction).toEqual({ text: 'Not recorded', status: 'not_recorded' }); // quote < 8 chars
    expect(t.complaint.status).toBe('confirmed');
  });

  it('cause quoted from the vendor cause field → confirmed', async () => {
    const e = seed('S4', { evidence: { cause: 'Chafed air line against frame rail' } });
    const { s } = make([reply(
      { text: 'Air leak.', quote: 'Air leak at the rear axle' },
      { text: 'Air line chafed on the frame rail.', quote: 'chafed air line against   frame rail' },
    )]);
    const t = (await s.summarize([e])).results.S4.threeC;
    expect(t.cause).toEqual({ text: 'Air line chafed on the frame rail.', status: 'confirmed' });
  });

  it('confirmed_root_cause set → cause confirmed from it', async () => {
    seed('S5');
    engine.prepare('UPDATE ri_repair_event SET confirmed_root_cause = ? WHERE source_id = ?').run('Cracked air line (vendor confirmed)', 'S5');
    const { s } = make([reply({ text: 'Air leak.', quote: 'Air leak at the rear axle' }, { text: 'Something else', quote: 'not in the evidence at all' })]);
    const t = (await s.summarize([ev('S5')])).results.S5.threeC;
    expect(t.cause).toEqual({ text: 'Cracked air line (vendor confirmed)', status: 'confirmed' });
  });

  it('all structured fields → ai:false, ask not called', async () => {
    const e = seed('S6', { evidence: { cause: 'Cracked air line', correction: 'Replaced air line' } });
    const { s, ask } = make([]);
    const out = await s.summarize([e]);
    expect(ask).not.toHaveBeenCalled();
    expect(out.results.S6.status).toBe('structured');
    expect(out.results.S6.threeC).toMatchObject({
      complaint: { text: COMPLAINT, status: 'confirmed' }, cause: { text: 'Cracked air line', status: 'confirmed' },
      correction: { text: 'Replaced air line', status: 'confirmed' }, ai: false,
    });
    expect(JSON.parse(ev('S6').wo_3c).ai).toBe(false);
  });

  it('no evidence → all Not recorded, ask not called', async () => {
    const e = seed('S7', { complaint: '', evidence: null });
    const { s, ask } = make([]);
    const out = await s.summarize([e]);
    expect(ask).not.toHaveBeenCalled();
    expect(out.results.S7.status).toBe('no_evidence');
    for (const k of ['complaint', 'cause', 'correction']) expect(out.results.S7.threeC[k]).toEqual({ text: 'Not recorded', status: 'not_recorded' });
    expect(out.results.S7.threeC.ai).toBe(false);
  });

  it('second run with the same data → cached; changed wo_evidence → recomputed; force → recomputed', async () => {
    const e = seed('S8');
    const a = make([GOOD]);
    await a.s.summarize([e]);
    const b = make([]);
    const again = await b.s.summarize([ev('S8')]);
    expect(b.ask).not.toHaveBeenCalled();
    expect(again.results.S8.status).toBe('cached');
    expect(again.results.S8.threeC.cause.status).toBe('suspected');

    store.setWoDetail('S8', { dealer: null, modifiedAt: 2, evidence: { v: 1, complaint: COMPLAINT, cause: '', correction: '', comments: [{ at: NOW, text: C_FIND + ' (new note)' }], commentCount: 1, lastCommentAt: NOW } });
    const c = make([GOOD]);
    expect((await c.s.summarize([ev('S8')])).results.S8.status).toBe('fresh');
    expect(c.ask).toHaveBeenCalledTimes(1);

    const d = make([GOOD]);
    expect((await d.s.summarize([ev('S8')], { force: true })).results.S8.status).toBe('fresh');
    expect(d.ask).toHaveBeenCalledTimes(1);
  });

  it('6 queued events with deferred asks → at most 2 in flight', async () => {
    const events = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'].map((id) => seed(id));
    let inflight = 0, max = 0;
    const ask = vi.fn(() => {
      inflight++; max = Math.max(max, inflight);
      return new Promise((r) => setTimeout(() => { inflight--; r(GOOD); }, 5));
    });
    const s = ws.createWoSummarizer({ ask, runWithTimeout: (run) => run(undefined), now: () => NOW, store, logger });
    const out = await s.summarize(events);
    expect(ask).toHaveBeenCalledTimes(6);
    expect(max).toBe(2);
    expect(out.counts.fresh).toBe(6);
  });

  it('runWithTimeout returning null → timeout, nothing cached', async () => {
    const e = seed('S9');
    const ask = vi.fn(async () => GOOD);
    const s = ws.createWoSummarizer({ ask, runWithTimeout: (run, o) => Promise.resolve(o.timeoutResult), now: () => NOW, store, logger });
    const out = await s.summarize([e]);
    expect(out.results.S9).toEqual({ status: 'timeout' });
    expect(ev('S9').wo_3c).toBeNull();
    expect(ev('S9').wo_3c_hash).toBeNull();
  });

  it('ask throwing → error, nothing cached, never throws', async () => {
    const e = seed('S9b');
    const s = ws.createWoSummarizer({ ask: async () => { throw new Error('boom'); }, runWithTimeout: (run) => run(undefined), store, logger });
    const out = await s.summarize([e]);
    expect(out.results.S9b).toEqual({ status: 'error' });
    expect(ev('S9b').wo_3c).toBeNull();
  });

  it('priority low → repair_intel_analysis, normal → repair_intel_unit', async () => {
    seed('S10');
    const low = make([GOOD]);
    await low.s.summarize([ev('S10')], { force: true });
    expect(low.calls[0].o.source).toBe('repair_intel_analysis');
    expect(low.rwtCalls[0]).toMatchObject({ timeoutMs: 55000, timeoutResult: null, source: 'repair_intel_analysis' });
    const normal = make([GOOD]);
    await normal.s.summarize([ev('S10')], { force: true, priority: 'normal' });
    expect(normal.calls[0].o.source).toBe('repair_intel_unit');
    expect(normal.rwtCalls[0].source).toBe('repair_intel_unit');
  });

  it('offsiteFor notes → basis aap+offsite, notes in the prompt, quote can come from them', async () => {
    const e = seed('S11');
    const NOTES = 'Dealer replaced the rear brake chamber diaphragm';
    const { s, calls } = make([reply(
      { text: 'Air leak.', quote: 'Air leak at the rear axle' }, null,
      { text: 'Dealer replaced the diaphragm.', quote: 'replaced the rear brake chamber diaphragm' },
    )]);
    const out = await s.summarize([e], { offsiteFor: () => NOTES });
    expect(calls[0].prompt).toContain('DEALER NOTES: ' + NOTES);
    expect(out.results.S11.threeC.basis).toBe('aap+offsite');
    expect(out.results.S11.threeC.correction.status).toBe('suspected');
    expect(ev('S11').wo_3c_hash).toBe(ws.contentHash(ev('S11'), NOTES));
  });

  it('logger never sees complaint or comment text', () => {
    expect(logs.length).toBeGreaterThan(0);
    for (const m of logs) {
      expect(m).not.toContain('Air leak');
      expect(m).not.toContain('cracked air line');
      expect(m).not.toContain('Replaced');
      expect(m).not.toContain('diaphragm');
    }
  });

  it('buildEvidenceText sections', () => {
    const t = ws.buildEvidenceText(ev('S4'), '');
    expect(t).toContain('REPORTED COMPLAINT: ' + COMPLAINT);
    expect(t).toContain('STATUS: completed');
    expect(t).toContain('VENDOR CAUSE FIELD: Chafed air line against frame rail');
    expect(t).not.toContain('VENDOR CORRECTION FIELD');
    expect(t).toContain('AAP COMMENTS:');
    expect(t).not.toContain('DEALER NOTES');
  });
});
