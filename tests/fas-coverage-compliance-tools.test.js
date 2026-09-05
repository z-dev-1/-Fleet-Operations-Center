// tests/fas-coverage-compliance-tools.test.js
//
// The coverage + compliance research tools route through the FAS tool-registry
// with proper scope enforcement: internal senders may use them; external
// (carrier/vendor/unknown) senders are denied. Args are validated by arg-schema.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-covcomp-tools-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const tools = require('../src/orcha/fas/tool-registry');
const profiles = require('../src/orcha/fas/sender-profiles');
const coverage = require('../src/orcha/fas/coverage');

function seed() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable' },
    { equipmentId: '622072', operator: 'SAPB', domicileSite: 'EWR45', lifecycleState: 'Unavailable' },
  ] });
  coverage.refresh({ reason: 'test' });
}
beforeEach(() => { seed(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const internal = () => ({ slackId: 'U_INT', name: 'Zila', type: 'internal', operators: [], domiciles: [],
  allowedDataCategories: profiles.DATA_CATEGORIES.slice(), permittedRequestTypes: profiles.REQUEST_TYPES.slice() });
const carrierSAPB = () => ({ slackId: 'U_SAPB', name: 'SAPB', type: 'carrier', operators: ['SAPB'], domiciles: [],
  allowedDataCategories: ['unit_status', 'repair_timeline'], permittedRequestTypes: ['unit_status'] });

describe('GET_COVERAGE tool', () => {
  it('returns Zila coverage (operators+domiciles) for an internal sender', async () => {
    const r = await tools.runTool('GET_COVERAGE', {}, { profile: internal() });
    expect(r.ok).toBe(true);
    const ops = r.verifiedFacts.find(f => f.field === 'operators');
    expect(ops.value.sort()).toEqual(['SAPB', 'TUZR']);
  });
  it('is DENIED for an external carrier sender (would reveal the full carrier roster)', async () => {
    const r = await tools.runTool('GET_COVERAGE', {}, { profile: carrierSAPB() });
    expect(r.ok).toBe(false);
    expect(r.denied).toBe(true);
  });
});

describe('GET_COMPLIANCE_REQUIREMENT tool', () => {
  it('returns cited DOT requirements for an internal sender', async () => {
    const r = await tools.runTool('GET_COMPLIANCE_REQUIREMENT', { topic: 'tires', equipment: 'day-cab' }, { profile: internal() });
    expect(r.ok).toBe(true);
    const reqs = r.verifiedFacts.find(f => f.field === 'complianceRequirements');
    expect(reqs.value.length).toBeGreaterThan(0);
    expect(reqs.value[0].regId).toMatch(/393\.75/);
    expect(reqs.value[0].source).toBeTruthy();
  });
  it('classifies an observed OOS condition strictly when supplied', async () => {
    const r = await tools.runTool('GET_COMPLIANCE_REQUIREMENT', { condition: 'flat tire on steer axle', equipment: 'day-cab' }, { profile: internal() });
    expect(r.ok).toBe(true);
    const cls = r.verifiedFacts.find(f => f.field === 'complianceClassification');
    expect(cls.value.class).toBe('confirmed-oos');
  });
  it('is DENIED for an external sender (safety/RTS language is internal-only)', async () => {
    const r = await tools.runTool('GET_COMPLIANCE_REQUIREMENT', { topic: 'brakes' }, { profile: carrierSAPB() });
    expect(r.ok).toBe(false);
    expect(r.denied).toBe(true);
  });
  it('rejects an invalid equipment enum via arg-schema', async () => {
    const r = await tools.runTool('GET_COMPLIANCE_REQUIREMENT', { topic: 'tires', equipment: 'trailer' }, { profile: internal() });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/equipment/i);
  });
});
