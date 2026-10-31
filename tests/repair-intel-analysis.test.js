import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Injected relay stub (passed via opts.relay so no module mocking is needed).
let _askResponse = '';
const fakeRelay = {
  ask: async () => _askResponse,
  getStatus: () => ({ model: 'test-model', backends: { orcha: true, claude: false } }),
};

const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const store = require('../src/repair-intel/store');
const analysis = require('../src/repair-intel/analysis');

const DAY = 24 * 3600 * 1000;
let tmpDir;

function wo(overrides) {
  return Object.assign({
    workRequestId: 'WR' + Math.random().toString(36).slice(2),
    assetDisplayName: 'UNIT-A',
    vendor: 'Acme Truck Repair',
    category: 'Unplanned Repair',
    status: { description: { value: 'COMPLETED' } },
    suggestedItems: [{ level1: 'Brakes', level2: 'Pads' }],
    damageDescription: 'grinding noise when braking',
    reportedDateTime: new Date(Date.now() - 20 * DAY).toISOString(),
    completedDateTime: new Date(Date.now() - 19 * DAY).toISOString(),
    totalEstimatePendingApprovalCost: 500,
  }, overrides);
}

describe('repair-intel analysis (AI layer)', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-ai-'));
    setDataDir(tmpDir);
    engine.close();
    store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'B1' })));
    store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'B2',
      reportedDateTime: new Date(Date.now() - 5 * DAY).toISOString(),
      completedDateTime: new Date(Date.now() - 4 * DAY).toISOString() })));
  });
  afterAll(() => {
    try { engine.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('_parseJson tolerates code fences and surrounding prose', () => {
    const out = analysis._parseJson('Here is the result:\n```json\n{"summary":"hi","events":[]}\n```\nthanks');
    expect(out).toBeTruthy();
    expect(out.summary).toBe('hi');
  });

  it('classifies events, writes recommendations, and caches by evidence hash', async () => {
    _askResponse = JSON.stringify({
      summary: 'Recurring brake wear; two corrective repairs in 20 days.',
      events: [
        { id: 'B1', suspected_root_cause: 'worn brake pads', corrective_actions: 'replaced pads', outcome: 'resolved-repeated' },
        { id: 'B2', suspected_root_cause: 'worn brake pads', corrective_actions: 'replaced pads and rotor', outcome: 'resolved' },
        { id: 'BOGUS', outcome: 'resolved' }, // unknown id must be ignored
      ],
      recommendations: [
        { kind: 'technical', finding: 'Brakes recurring', reason: 'two repairs in 20d', recommendedAction: 'inspect caliper', priority: 'medium', confidence: 'medium', supportingWos: ['B1', 'B2'] },
      ],
    });

    const res = await analysis.analyzeUnit('UNIT-A', { force: true, relay: fakeRelay });
    expect(res.ok).toBe(true);
    expect(res.summary).toContain('brake');
    expect(res.events.length).toBe(2); // BOGUS dropped
    expect(res.recommendations.length).toBe(1);
    expect(res.recommendations[0].kind).toBe('technical');

    // AI columns written back to the events
    const events = store.eventsForUnit('UNIT-A');
    const b1 = events.find(e => e.source_id === 'B1');
    expect(b1.outcome).toBe('resolved-repeated');
    expect(b1.suspected_root_cause).toBe('worn brake pads');
    // confirmed_root_cause must stay NULL (no fabrication)
    expect(b1.confirmed_root_cause == null).toBe(true);

    // recommendation persisted
    const recs = store.getRecommendations('unit', 'UNIT-A');
    expect(recs.length).toBe(1);

    // second call with unchanged evidence returns cached (no new model call)
    _askResponse = 'THIS SHOULD NOT BE USED';
    const cached = await analysis.analyzeUnit('UNIT-A', { relay: fakeRelay });
    expect(cached.ok).toBe(true);
    expect(cached.cached).toBe(true);
    expect(cached.summary).toContain('brake');
  });

  it('returns a pending note when the AI lane yields nothing', async () => {
    _askResponse = '';
    const res = await analysis.analyzeUnit('UNIT-A', { force: true, relay: fakeRelay });
    expect(res.ok).toBe(false);
    expect(res.pending).toBe(true);
    expect(res.report).toBeTruthy(); // deterministic report still present
  });
});
