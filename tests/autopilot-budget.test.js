// tests/autopilot-budget.test.js — Autopilot V2 AI daily cap and deferral (design §6.7, AC-20): a cap
// never removes a unit from coverage; cap-deferred cases keep their fallback and rest with
// ai_pending_reason 'cap'; raising the cap or a local-day rollover releases them through the
// ai_capacity trigger. Run on the multi-turn path and on the V1 single-call path (multiTurn false).
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 60000 });
const F = require('./helpers/autopilot-fakes.cjs');

const { MIN, cs } = F;
const UNITS = ['B1', 'B2', 'B3', 'B4', 'B5'];
const NEXT_MIDNIGHT = new Date(2026, 10, 21).getTime();   // T0 is 2026-11-20 10:00 local

beforeEach(() => { vi.restoreAllMocks(); F.freshDb('budget'); });

function mkEnv(multiTurn) {
  const rows = UNITS.map((u, i) => F.baseRow({ equipmentId: u, _serviceId: 'svc-b' + i, workRequestId: 'wr-b' + i }));
  return F.mkEnv({
    world: F.mkWorld({ rows }),
    autopilot: { scope: { mode: 'fleet' }, ai: { dailyCap: 2 }, dailyCap: 2, queue: { maxStartsPerTick: 5 }, features: { liveReads: true, multiTurn } },
  });
}
const open = () => cs.listOpen();
const capPending = () => open().filter((c) => c.ai_pending_reason === 'cap');
// The dashboard's "not yet AI-investigated" list (§6.7): ai_investigated_at IS NULL OR ai_pending_reason IS NOT NULL.
const aiPendingList = () => open().filter((c) => c.ai_investigated_at == null || c.ai_pending_reason != null);

for (const multiTurn of [true, false]) {
  describe('dailyCap 2 with 5 cases (AC-20), multiTurn ' + multiTurn, () => {
    async function firstTick() {
      const env = mkEnv(multiTurn);
      const out = await env.ctl.runOnce({ forceDetect: true });
      expect(out.investigated.length).toBe(5);
      expect(env.reason.calls.length).toBe(2);
      const cases = open();
      expect(cases.length).toBe(5);
      for (const c of cases) {
        expect(c.recommendation_json, c.unit_id).toBeTruthy();
        expect(['RESOLVED', 'PAUSED', 'FAILED']).not.toContain(c.state);
      }
      expect(capPending().length).toBe(3);
      expect(aiPendingList().map((c) => c.case_id).sort()).toEqual(capPending().map((c) => c.case_id).sort());
      for (const c of capPending()) {
        expect(c.ai_retry_at).toBeGreaterThanOrEqual(NEXT_MIDNIGHT);
        expect(c.ai_retry_at).toBeLessThanOrEqual(NEXT_MIDNIGHT + 30 * MIN);
      }
      // Coverage keeps every unit (a cap never drops one).
      expect(cs.coverage(env.clock.now()).pass).toMatchObject({ case_open: 5, down_eligible: 5 });
      expect(cs.aiBacklog(env.clock.now(), { cap: 2 })).toMatchObject({ callsToday: 2, cap: 2 });
      return env;
    }

    it('2 AI calls, 5 recommendations, 3 cases deferred with ai_pending_reason cap, none dropped', async () => {
      await firstTick();
    });

    it('raising the cap releases the cap-deferred cases through the ai_capacity trigger', async () => {
      const env = await firstTick();
      const deferred = capPending().map((c) => c.case_id);
      expect(env.ap.setConfig({ ai: { dailyCap: 5 } }).ok).toBe(true);
      for (const id of deferred) expect(cs.getCase(id).case.ai_retry_at).toBe(env.clock.now());
      env.deferred.length = 0;                  // the set-config re-detection run is not needed here
      env.clock.advance(31 * MIN);              // past the 30-min automatic spacing
      const out = await env.ctl.runOnce();
      expect(out.triggers).toBe(3);
      expect(env.reason.calls.length).toBe(5);
      expect(capPending().length).toBe(0);
      for (const id of deferred) {
        expect(cs.getCase(id).runs[0].trigger).toBe('ai_capacity');
        expect(cs.getCase(id).case.ai_investigated_at).toBe(env.clock.now());
      }
    });

    it('a local-day rollover releases them (the new day has its own cap)', async () => {
      const env = await firstTick();
      env.clock.t = NEXT_MIDNIGHT + 31 * MIN;
      const out = await env.ctl.runOnce();
      expect(out.triggers).toBeGreaterThanOrEqual(3);
      expect(env.reason.calls.length).toBe(4);   // day 2 cap 2: two more calls
      expect(capPending().length).toBe(1);
      expect(open().length).toBe(5);
      for (const c of open()) expect(['RESOLVED', 'PAUSED', 'FAILED']).not.toContain(c.state);
    });
  });
}
