import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'ai-core-phase-g-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const memory = require('../src/ai/memory');
const caseStore = require('../src/orcha/fas/case-store');

beforeEach(() => {
  store.save('aiMemory', []);
  store.save('fasCases', {});
});
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('AI Core Phase G — durable memory (spec #4)', () => {
  it('stores a concise structured memory and rejects a whole-conversation dump', () => {
    const ok = memory.remember({ type: 'vendor', entity: 'Amerit', fact: 'Usually needs a follow-up after 48h with no ETA.', source: 'operator_correction', origin: 'operator_confirmed' });
    expect(ok.ok).toBe(true);
    // Reject a bloated transcript.
    const big = memory.remember({ type: 'vendor', entity: 'Amerit', fact: 'x'.repeat(5000) });
    expect(big.ok).toBe(false);
    // Reject invalid category.
    expect(memory.remember({ type: 'nonsense', entity: 'x', fact: 'y' }).ok).toBe(false);
  });

  it('operator-confirmed memory OUTRANKS ai-inferred for the same entity', () => {
    memory.remember({ type: 'vendor', entity: 'Kenworth', fact: 'slow on brake jobs', origin: 'ai_inferred', confidence: 0.6 });
    memory.remember({ type: 'vendor', entity: 'Kenworth', fact: 'reliable, call the service manager directly', origin: 'operator_confirmed' });
    const mems = memory.retrieve({ vendors: ['Kenworth'] }, { limit: 10 });
    expect(mems.length).toBeGreaterThanOrEqual(2);
    // The operator-confirmed memory ranks first.
    expect(mems[0].origin).toBe('operator_confirmed');
  });

  it('only retrieves memories RELEVANT to the queried entities', () => {
    memory.remember({ type: 'unit', entity: '321060', fact: 'awaiting turbo part', origin: 'ai_inferred' });
    memory.remember({ type: 'unit', entity: '999999', fact: 'unrelated', origin: 'ai_inferred' });
    const mems = memory.retrieve({ units: ['321060'], includeGlobal: false }, { limit: 10 });
    expect(mems.some((m) => m.entity === '321060')).toBe(true);
    expect(mems.some((m) => m.entity === '999999')).toBe(false);
  });

  it('confirm() upgrades an ai-inferred memory to operator-confirmed', () => {
    const r = memory.remember({ type: 'site', entity: 'ABE40', fact: 'prefers morning pickups', origin: 'ai_inferred' });
    expect(memory.confirm(r.id)).toBe(true);
    const mems = memory.retrieve({ sites: ['ABE40'] }, { limit: 10 });
    expect(mems[0].origin).toBe('operator_confirmed');
  });

  it('reads FAS case memory (unit) as operator-confirmed without disturbing it', () => {
    caseStore.upsert(caseStore.caseIdForUnit('321060'), { unit: '321060', currentSummary: 'Parts ordered, ETA Friday', status: 'open' });
    const mems = memory.retrieve({ units: ['321060'] }, { categories: ['unit'], limit: 10 });
    const fromCase = mems.find((m) => /Parts ordered/.test(m.fact));
    expect(fromCase).toBeTruthy();
    expect(fromCase.origin).toBe('operator_confirmed');
    // The case store itself is untouched (still readable in its own shape).
    expect(caseStore.getCase(caseStore.caseIdForUnit('321060')).currentSummary).toBe('Parts ordered, ETA Friday');
  });

  it('reads operator corrections from orcha/learn and marks them operator-confirmed', () => {
    // Seed a correction via the existing learn store shape.
    store.save('orchaCorrections', { corrections: [
      { timestamp: new Date().toISOString(), unitId: '321060', field: 'vendor', orchaSuggested: 'TA', userChose: 'Amerit', context: { domicile: 'ABE40' } },
    ], stats: {} });
    const mems = memory.retrieve({ units: ['321060'] }, { categories: ['correction'], limit: 10 });
    expect(mems.length).toBeGreaterThanOrEqual(1);
    expect(mems[0].origin).toBe('operator_confirmed');
    expect(mems[0].fact).toMatch(/Amerit/);
  });

  it('retrieveContext marks operator-confirmed vs ai-inferred for prompt injection', () => {
    memory.remember({ type: 'vendor', entity: 'Amerit', fact: 'follow up after 48h', origin: 'operator_confirmed' });
    memory.remember({ type: 'vendor', entity: 'Amerit', fact: 'often slow on fridays', origin: 'ai_inferred' });
    const ctx = memory.retrieveContext({ vendors: ['Amerit'] }, { limit: 10 });
    expect(ctx).toMatch(/\[operator-confirmed\]/);
    expect(ctx).toMatch(/\[ai-inferred\]/);
  });

  it('dedupes identical memories and confirming upgrades origin', () => {
    memory.remember({ type: 'workflow', entity: 'flip-process', fact: 'verify readback before confirming', origin: 'ai_inferred' });
    const again = memory.remember({ type: 'workflow', entity: 'flip-process', fact: 'verify readback before confirming', origin: 'operator_confirmed' });
    expect(again.updated).toBe(true);
    const mems = memory.retrieve({ includeGlobal: true }, { categories: ['workflow'], limit: 10 });
    const m = mems.find((x) => x.entity === 'flip-process');
    expect(m.origin).toBe('operator_confirmed');
  });
});
