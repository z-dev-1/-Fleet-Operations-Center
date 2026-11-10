// tests/repair-intel-analysis-context.test.js — repair-intel unit analysis
// sends ALL work orders newest-first (within a 30,000-char block) plus the
// vendor cause / correction / newest 3 comments from wo_evidence when
// settings.ai.fullContext is on; flag OFF keeps the legacy 40 x 200 prompt.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const store = require('../src/repair-intel/store');
const analysis = require('../src/repair-intel/analysis');

const HOUR = 3600 * 1000;
let tmpDir;
let prompts = [];
const fakeRelay = {
  ask: async (p) => { prompts.push(p); return JSON.stringify({ summary: 'ok', events: [], recommendations: [] }); },
  getStatus: () => ({ model: 'test-model' }),
};

const pad = (n) => String(n).padStart(3, '0');
function wo(unit, id, i, complaint) {
  return {
    workRequestId: id,
    assetDisplayName: unit,
    vendor: 'Acme Truck Repair',
    category: 'Unplanned Repair',
    status: { description: { value: 'COMPLETED' } },
    suggestedItems: [{ level1: 'Brakes', level2: 'Pads' }],
    damageDescription: complaint,
    reportedDateTime: new Date(Date.now() - (i + 1) * HOUR).toISOString(),
    completedDateTime: new Date(Date.now() - i * HOUR).toISOString(),
    totalEstimatePendingApprovalCost: 100 + i,
  };
}

const RULES = [
  '1. Do NOT invent parts, part numbers, costs, dates, people, or a CONFIRMED root cause.',
  '2. If a root cause is not stated in the complaint/thread, mark it suspected or say "not documented".',
  '3. Ground every statement in the work orders above. No speculation presented as fact.',
  '4. Recommendations are ADVISORY. Never claim a unit is ready/not-ready for service.',
  '5. Exclude vendor judgments about Velocity, Fleetnet, or Goodyear (already filtered out).',
];

const idLines = (p) => p.split('\n').filter((l) => l.startsWith('- id='));

describe('repair-intel analysis full context', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-ctx-'));
    setDataDir(tmpDir);
    engine.close();
    for (let i = 0; i < 100; i++) store.upsertEvent(store.normalizeWorkOrder(wo('UNIT-B', 'E' + pad(i), i, 'complaint ' + i + ' ' + 'c'.repeat(150))));
    for (let i = 0; i < 200; i++) store.upsertEvent(store.normalizeWorkOrder(wo('UNIT-C', 'F' + pad(i), i, 'long ' + 'd'.repeat(400))));
  });
  afterAll(() => {
    try { engine.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('flag OFF: legacy 40 lines, complaint <= 200 chars, no 2b rule', async () => {
    prompts = [];
    const res = await analysis.analyzeUnit('UNIT-B', { force: true, relay: fakeRelay, fullContext: false });
    expect(res.ok).toBe(true);
    expect(res.omittedEvents).toBeUndefined();
    const lines = idLines(prompts[0]);
    expect(lines.length).toBe(40);
    for (const l of lines) expect(l.split(' | complaint: ')[1].length).toBeLessThanOrEqual(200);
    expect(prompts[0]).not.toContain('2b. VENDOR CAUSE');
    for (const r of RULES) expect(prompts[0]).toContain(r);
    // 400-char complaints are cut to the legacy 200.
    prompts = [];
    await analysis.analyzeUnit('UNIT-C', { force: true, relay: fakeRelay, fullContext: false });
    const c = idLines(prompts[0]);
    expect(c.length).toBe(40);
    for (const l of c) expect(l.split(' | complaint: ')[1].length).toBe(200);
    expect(prompts[0]).not.toContain('older work orders not listed');
  });

  it('hash: changes after setWoDetail with flag ON, unchanged with flag OFF', () => {
    const before = store.eventsForUnit('UNIT-B');
    const onBefore = analysis._evidenceHash(before, { fullContext: true });
    const offBefore = analysis._evidenceHash(before, { fullContext: false });
    expect(analysis._evidenceHash(before)).toBe(offBefore); // legacy default
    store.setWoDetail('E005', { evidence: {
      cause: 'CAUSE_X worn caliper slide pins',
      correction: 'CORR_X replaced caliper',
      comments: [
        { at: '2026-10-01T10:00:00Z', text: 'OLD_COMMENT_1' },
        { at: '2026-10-20T10:00:00Z', text: 'NEW_COMMENT_2' },
        { at: '2026-10-21T10:00:00Z', text: 'NEW_COMMENT_3' },
        { at: '2026-09-15T10:00:00Z', text: 'OLD_COMMENT_0' },
        { at: '2026-10-19T10:00:00Z', text: 'NEW_COMMENT_1' },
      ],
    } });
    store.setWoDetail('E050', { evidence: { cause: 'CAUSE_Y', correction: 'CORR_Y', comments: [] } });
    const after = store.eventsForUnit('UNIT-B');
    expect(analysis._evidenceHash(after, { fullContext: true })).not.toBe(onBefore);
    expect(analysis._evidenceHash(after, { fullContext: false })).toBe(offBefore);
  });

  it('flag ON: all 100 events newest-first with vendor evidence + newest 3 comments', async () => {
    prompts = [];
    const res = await analysis.analyzeUnit('UNIT-B', { force: true, relay: fakeRelay, fullContext: true });
    expect(res.ok).toBe(true);
    expect(res.omittedEvents).toBeUndefined();
    const p = prompts[0];
    const ids = idLines(p).map((l) => l.slice(5, 9));
    expect(ids).toEqual(Array.from({ length: 100 }, (_, i) => 'E' + pad(i)));
    expect(idLines(p)[0]).toContain(' | est $100');
    expect(p).toContain('    vendor cause: CAUSE_X worn caliper slide pins');
    expect(p).toContain('    vendor correction: CORR_X replaced caliper');
    expect(p).toContain('    comment 2026-10-21: NEW_COMMENT_3');
    expect(p).toContain('    comment 2026-10-20: NEW_COMMENT_2');
    expect(p).toContain('    comment 2026-10-19: NEW_COMMENT_1');
    expect(p).not.toContain('OLD_COMMENT');
    expect(p).toContain('CAUSE_Y');
    // Evidence lines follow their own event line.
    const lines = p.split('\n');
    expect(lines[lines.findIndex((l) => l.startsWith('- id=E005')) + 1]).toContain('CAUSE_X');
    expect(p).toContain('2b. VENDOR CAUSE / CORRECTION / COMMENT lines are source evidence; still mark a cause suspected unless the vendor states it.');
    for (const r of RULES) expect(p).toContain(r);
    expect(p.indexOf(RULES[1])).toBeLessThan(p.indexOf('2b. VENDOR'));
    expect(p.indexOf('2b. VENDOR')).toBeLessThan(p.indexOf(RULES[2]));
    expect(p).not.toContain('older work orders not listed');
  });

  it('flag ON over budget: lists newest within 30,000 chars and reports omittedEvents', async () => {
    prompts = [];
    const res = await analysis.analyzeUnit('UNIT-C', { force: true, relay: fakeRelay, fullContext: true });
    expect(res.ok).toBe(true);
    const p = prompts[0];
    const lines = idLines(p);
    const n = 200 - lines.length;
    expect(n).toBeGreaterThan(0);
    expect(res.omittedEvents).toBe(n);
    expect(p).toContain('(' + n + ' older work orders not listed — AI input budget)');
    expect(lines[0].startsWith('- id=F000')).toBe(true);
    expect(lines[lines.length - 1].startsWith('- id=F' + pad(lines.length - 1))).toBe(true);
    const start = p.indexOf('WORK ORDERS (newest first):\n') + 'WORK ORDERS (newest first):\n'.length;
    const end = p.indexOf('\n(' + n + ' older work orders');
    expect(end - start).toBeLessThanOrEqual(30000);
  });
});
