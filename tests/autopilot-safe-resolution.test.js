// tests/autopilot-safe-resolution.test.js — fleet-autopilot AC-9 / AC-10 end to end: an AI reply
// that says "unit is repaired, mark road-ready" never resolves the case and its road-ready action
// lands only under actionsRequiringApproval; only a newer aap-api build with lifecycle Active does.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 30000 });   // multi-tick integration tests; the CI host can be loaded
const F = require('./helpers/autopilot-fakes.cjs');

const { MIN } = F;
beforeEach(() => F.freshDb('safe'));

const repaired = (opts) => {
  const id = [...opts.prompt.matchAll(/\[(ev_[a-f0-9_]+)\]/g)].map((m) => m[1])[0];
  return {
    ok: true, aiUsed: true, error: null, raw: '',
    data: {
      schemaVersion: 1,
      summary: 'unit is repaired, mark road-ready',
      confirmedFacts: [{ statement: 'The unit is repaired.', evidenceIds: [id] }],
      inferences: [],
      recommendedActions: [{ action: 'Mark the unit road-ready', rationale: 'unit is repaired', owner: 'fleet', actionClass: 'road_ready', evidenceIds: [id] }],
      actionsRequiringApproval: [{ action: 'Set lifecycle to Active', rationale: 'repaired', owner: 'fleet', actionClass: 'lifecycle_change', evidenceIds: [id] }],
      urgency: 'high', nextReviewInHours: 4,
      state: 'RESOLVED', resolved: true, roadReady: true, execute: ['road_ready'],
    },
  };
};

describe('AC-9: AI output never resolves a case', () => {
  it('stays out of RESOLVED; road_ready only under approval; resolves only on a newer Active aap-api build', async () => {
    const env = F.mkEnv({ reason: async (o) => repaired(o) });
    env.ap.boot();
    await env.supervisor.runTick();
    const id = F.cs.listCases({}).items[0].case_id;
    let c = F.cs.getCase(id).case;
    expect(c.state).toBe('RECOMMENDATION_READY');
    expect(c.resolution_json).toBe(null);
    const out = c.ai_findings;
    expect(out).not.toHaveProperty('state');
    expect(out).not.toHaveProperty('resolved');
    expect(out).not.toHaveProperty('roadReady');
    expect(out.recommendedActions.some((a) => a.actionClass === 'road_ready')).toBe(false);
    const rr = out.actionsRequiringApproval.find((a) => a.actionClass === 'road_ready');
    expect(rr).toMatchObject({ requiresApproval: true, executed: false });

    // A locally edited Active row with no new build (syncedAt re-stamp only) does not resolve (R1).
    env.world.rows[0].lifecycleState = 'Active';
    env.world.syncedAt = new Date(env.clock.now()).toISOString();
    for (let i = 0; i < 2; i++) { env.clock.advance(MIN); await env.supervisor.runTick(); }
    c = F.cs.getCase(id).case;
    expect(c.state).not.toBe('RESOLVED');

    // A legacy (non-API) Active row from a newer build -> NEEDS_REVIEW, still not RESOLVED.
    env.world.source = 'scrape';
    env.world.rows[0]._apiSourced = false;
    env.world.lastOkAt = env.clock.now();
    env.clock.advance(MIN);
    await env.supervisor.runTick();
    expect(F.cs.getCase(id).case.state).toBe('NEEDS_REVIEW');

    // The authoritative fixture: Active from aap-api, built after the last down observation.
    env.world.source = 'aap-api';
    env.world.rows[0]._apiSourced = true;
    env.world.lastOkAt = env.clock.now() + MIN;
    env.clock.advance(2 * MIN);
    await env.supervisor.runTick();
    c = F.cs.getCase(id).case;
    expect(c.state).toBe('RESOLVED');
    expect(c.resolution).toMatchObject({ lifecycleState: 'Active', source: 'aap-api', buildAt: env.world.lastOkAt });
  });
});
