// tests/fas-inspection-status.test.js
//
// Spec v2: routine DOT questions are the unit's inspection DUE/expiration date,
// answered from VERIFIED fleet data (never invented), classified current /
// approaching / expired / unavailable. GET_INSPECTION_STATUS provides this; the
// agent uses it for due-date questions instead of searching regulations.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-insp-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const tools = require('../src/orcha/fas/tool-registry');
const profiles = require('../src/orcha/fas/sender-profiles');
const agent = require('../src/orcha/fas/agent');

const internal = () => ({ slackId: 'U_INT', name: 'Z', type: 'internal', operators: [], domiciles: [],
  allowedDataCategories: profiles.DATA_CATEGORIES.slice(), permittedRequestTypes: profiles.REQUEST_TYPES.slice() });

function dateStr(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
}
function seed() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: 'CURRENT1', operator: 'TUZR', domicileSite: 'ABE40', bodyType: 'Day Cab', dot: dateStr(120) },
    { equipmentId: 'SOON1', operator: 'TUZR', domicileSite: 'ABE40', bodyType: 'Day Cab', dot: dateStr(10) },
    { equipmentId: 'EXPIRED1', operator: 'TUZR', domicileSite: 'ABE40', bodyType: 'Day Cab', dot: dateStr(-5) },
    { equipmentId: 'NODATE1', operator: 'TUZR', domicileSite: 'ABE40', bodyType: 'Day Cab' }, // no dot field
  ] });
}
beforeEach(() => { seed(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const field = (r, f) => r.verifiedFacts.find(x => x.field === f);

describe('GET_INSPECTION_STATUS — from verified fleet data', () => {
  it('classifies a far-future date as current and returns the exact date', async () => {
    const r = await tools.runTool('GET_INSPECTION_STATUS', { unit: 'CURRENT1' }, { profile: internal() });
    expect(r.ok).toBe(true);
    expect(field(r, 'inspectionStatus').value).toBe('current');
    expect(field(r, 'inspectionDueDate').value).toBeTruthy();
  });
  it('classifies a within-30-days date as approaching', async () => {
    const r = await tools.runTool('GET_INSPECTION_STATUS', { unit: 'SOON1' }, { profile: internal() });
    expect(field(r, 'inspectionStatus').value).toBe('approaching');
  });
  it('classifies a past date as expired', async () => {
    const r = await tools.runTool('GET_INSPECTION_STATUS', { unit: 'EXPIRED1' }, { profile: internal() });
    expect(field(r, 'inspectionStatus').value).toBe('expired');
  });
  it('reports unavailable (never invents a date) when no inspection date is recorded', async () => {
    const r = await tools.runTool('GET_INSPECTION_STATUS', { unit: 'NODATE1' }, { profile: internal() });
    expect(field(r, 'inspectionStatus').value).toBe('unavailable');
    expect(field(r, 'inspectionDueDate').value).toBeNull();
  });
  it('errors for an unknown unit (no fabrication)', async () => {
    const r = await tools.runTool('GET_INSPECTION_STATUS', { unit: 'GHOST' }, { profile: internal() });
    expect(r.ok).toBe(false);
  });
});

describe('agent prompt: due-date vs regulatory rules are distinguished', () => {
  it('SAFETY_RULES tell the agent to use GET_INSPECTION_STATUS for due-date questions and NOT search regs', () => {
    expect(agent.SAFETY_RULES).toMatch(/GET_INSPECTION_STATUS/);
    expect(agent.SAFETY_RULES).toMatch(/do not search regulations for a due-date question/i);
  });
  it('SAFETY_RULES still require GET_COMPLIANCE_REQUIREMENT for genuine regulatory questions', () => {
    expect(agent.SAFETY_RULES).toMatch(/GET_COMPLIANCE_REQUIREMENT/);
    expect(agent.SAFETY_RULES).toMatch(/never declare a unit safe, compliant, in violation, or out of service/i);
  });
});
