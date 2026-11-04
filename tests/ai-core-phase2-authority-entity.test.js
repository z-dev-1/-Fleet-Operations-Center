import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'ai-phase2-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const authority = require('../src/ai/authority');
const entityContext = require('../src/ai/entity-context');
const profiles = require('../src/orcha/fas/sender-profiles');

function seed() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '321060', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair', vendor: 'Amerit', workDuration: '20d', openUnplanned: '1', openPlanned: '0', workRequestId: 'WR-1', riskScore: 72, pmB: '2026-09-20' },
    { equipmentId: '59083', operator: 'AGNLI', domicileSite: 'AVP40', lifecycleState: 'Unavailable', lifecycleReason: 'PM Failed' },
  ] });
  store.save('contacts', [
    { type: 'slack', slackId: 'U_INT', name: 'Internal', org: 'Amazon', email: 'x@amazon.com' },
    { type: 'slack', slackId: 'U_TUZR', name: 'Carrier', operators: ['TUZR'], domiciles: 'ABE40' },
  ]);
  store.save('slackSenderProfiles', {});
  store.save('aiMemory', []);
}
beforeEach(() => { seed(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('Phase 2 — field-specific source authority (spec §4)', () => {
  it('lifecycleState: live AAP beats canonical beats older fleet snapshot', () => {
    const r = authority.resolveField('lifecycleState', [
      { value: 'Unavailable', source: 'fleetData', freshness: 'RECENT' },
      { value: 'Active', source: 'AAP/live', freshness: 'LIVE' },
      { value: 'Repair', source: 'canonical', freshness: 'RECENT' },
    ]);
    expect(r.value).toBe('Active');     // AAP wins by field authority
    expect(r.source).toMatch(/AAP/);
    expect(r.conflict).toBe(true);      // distinct values -> conflict surfaced
  });

  it('serviceState: live dealer/Relay beats cached note', () => {
    const r = authority.resolveField('serviceState', [
      { value: 'Awaiting Parts', source: 'notes/Relay', freshness: 'STALE' },
      { value: 'In Repair', source: 'RelayGarage', freshness: 'RECENT' },
    ]);
    expect(r.value).toBe('In Repair');
    expect(r.conflict).toBe(true);
  });

  it('no conflict when all sources agree', () => {
    const r = authority.resolveField('lifecycleState', [
      { value: 'Active', source: 'AAP', freshness: 'LIVE' },
      { value: 'Active', source: 'canonical', freshness: 'RECENT' },
    ]);
    expect(r.conflict).toBe(false);
    expect(r.value).toBe('Active');
  });

  it('field with no rule: freshest source wins', () => {
    const r = authority.resolveField('someAdHocField', [
      { value: 'old', source: 'x', freshness: 'STALE' },
      { value: 'new', source: 'y', freshness: 'LIVE' },
    ]);
    expect(r.value).toBe('new');
    expect(r.conflict).toBe(true);
  });

  it('riskScore: Uptake is authoritative', () => {
    const r = authority.resolveField('riskScore', [
      { value: 50, source: 'fleetData', freshness: 'RECENT' },
      { value: 72, source: 'Uptake', freshness: 'LIVE' },
    ]);
    expect(r.value).toBe(72);
  });

  it('reconcile() over evidence envelopes returns resolved fields + explicit conflicts', () => {
    const evidence = [
      { ok: true, tool: 'get_unit', source: 'AAP', freshness: 'LIVE', data: { facts: [{ field: 'lifecycleState', value: 'Active', source: 'AAP' }] } },
      { ok: true, tool: 'get_canonical_state', source: 'canonical', freshness: 'RECENT', data: { facts: [{ field: 'lifecycleState', value: 'Unavailable', source: 'canonical' }] } },
    ];
    const rec = authority.reconcile(evidence);
    expect(rec.fields.lifecycleState.value).toBe('Active');
    expect(rec.conflicts.length).toBe(1);
    expect(rec.conflicts[0].field).toBe('lifecycleState');
  });
});

describe('Phase 2 — entity-centric retrieval (spec §5)', () => {
  it('builds a compact unit context from structured sources (parallel) + reconciles', async () => {
    const ctx = { profile: profiles.resolveSender('U_INT') };
    const c = await entityContext.buildUnitContext('321060', ctx);
    expect(c.equipmentId).toBe('321060');
    expect(c.denied).toBe(false);
    expect(Object.keys(c.resolved).length).toBeGreaterThan(0);
    expect(c.resolved.lifecycleState.value).toBe('Unavailable');
    expect(c.sources.length).toBeGreaterThan(0);
    const comp = entityContext.compact(c);
    expect(comp.equipmentId).toBe('321060');
    expect(comp.fields.lifecycleState.value).toBe('Unavailable');
  });

  it('attaches relevant durable memories for the unit', async () => {
    const memory = require('../src/ai/memory');
    memory.remember({ type: 'unit', entity: '321060', fact: 'recurring DEF faults', origin: 'operator_confirmed' });
    const ctx = { profile: profiles.resolveSender('U_INT') };
    const c = await entityContext.buildUnitContext('321060', ctx);
    expect(c.relevantMemories.some((m) => /DEF/.test(m.fact))).toBe(true);
  });

  it('respects sender scope — an out-of-scope unit is denied, not widened', async () => {
    const ctx = { profile: profiles.resolveSender('U_TUZR') }; // TUZR/ABE40 only
    const c = await entityContext.buildUnitContext('59083', ctx); // AGNLI/AVP40
    expect(c.denied).toBe(true);
    // No resolved authoritative facts leaked for the out-of-scope unit.
    expect(c.resolved.lifecycleState).toBeUndefined();
  });

  it('requires a resolved sender profile', async () => {
    const c = await entityContext.buildUnitContext('321060', {});
    expect(c.error).toMatch(/profile/i);
  });
});
