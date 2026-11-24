// tests/autopilot-auth.test.js — fleet-autopilot auth handling (§B8 step 4, §B10.3, §B10.6, AC-13):
// no live AAP read unless Midway is HEALTHY, one local notification per auth episode (2 h spacing),
// AUTH_REQUIRED vs WAITING_FOR_DATA from the fleet-freshness rule, auth_restored / retry_due re-queues.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 30000 });   // multi-tick integration tests; the CI host can be loaded
const F = require('./helpers/autopilot-fakes.cjs');

const { H, MIN } = F;
beforeEach(() => F.freshDb('auth'));

const only = () => { const l = F.cs.listCases({}).items; expect(l.length).toBe(1); return l[0]; };
const planOf = (id) => Object.fromEntries(F.cs.getCase(id).runs[0].plan.map((p) => [p.source, p.status]));
const liveWorld = () => F.mkWorld({ aapWarm: true, aapLive: () => ({ ok: true, value: { workRequest: { id: 'svc-1', assetDisplayName: '322283', lifecycleState: 'Unavailable' } } }) });

describe('Midway WAITING_FOR_USER', () => {
  it('no live AAP call, cached evidence used, one notification per episode with 2 h spacing (AC-13)', async () => {
    const world = liveWorld();
    world.midway = 'WAITING_FOR_USER';
    const env = F.mkEnv({ world });
    await env.ctl.runOnce();
    const c = only();
    expect(world.calls.aapLive).toBe(0);
    expect(planOf(c.case_id).aap_live).toBe('cache_only:gate_closed');
    expect(c.state).toBe('RECOMMENDATION_READY');
    expect(F.cs.getCase(c.case_id).findings.some((f) => f.source === 'aap_cache')).toBe(true);
    expect(env.notifications).toEqual([{ title: 'Autopilot: sign-in needed', body: 'Midway needs you to sign in (MFA). Autopilot keeps using cached data and resumes on its own.' }]);
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    expect(env.notifications.length).toBe(1);
    world.midway = 'HEALTHY';
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    world.midway = 'WAITING_FOR_USER';
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    expect(env.notifications.length).toBe(1);   // new episode within 2 h -> no second notice
    world.midway = 'HEALTHY';
    env.clock.advance(2 * H);
    await env.ctl.runOnce();
    world.midway = 'WAITING_FOR_USER';
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    expect(env.notifications.length).toBe(2);
  });

  it('live AAP reads stay off until HEALTHY', async () => {
    for (const m of ['UNKNOWN', 'DEGRADED', 'COOLDOWN']) {
      F.freshDb('auth-' + m);
      const world = liveWorld();
      world.midway = m;
      const env = F.mkEnv({ world });
      await env.ctl.runOnce();
      expect(world.calls.aapLive, m).toBe(0);
    }
    F.freshDb('auth-ok');
    const world = liveWorld();
    const env = F.mkEnv({ world });
    await env.ctl.runOnce();
    expect(world.calls.aapLive).toBe(1);
  });

  it('Aperia actionNeeded -> one notification', async () => {
    const world = F.mkWorld({ aperia: { state: 'expired', actionNeeded: true } });
    const env = F.mkEnv({ world });
    await env.ctl.runOnce();
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    expect(env.notifications.map((n) => n.body.split(' ')[0])).toEqual(['Aperia']);
  });
});

describe('required source unusable (§B8 step 4)', () => {
  const run = async (over) => {
    const world = F.mkWorld(over);
    const env = F.mkEnv({ world });
    await env.ctl.runOnce();
    return { env, world, c: only() };
  };

  it('red age>3x with Midway in AUTH_DOWN -> AUTH_REQUIRED, next attempt in 1 h', async () => {
    const { env, c } = await run({ ffLevel: 'red', ffReasons: ['age>3x'], midway: 'WAITING_FOR_USER' });
    expect(c.state).toBe('AUTH_REQUIRED');
    expect(c.next_attempt_at).toBe(env.clock.now() + H);
  });

  it('the same data with Midway UNKNOWN -> WAITING_FOR_DATA', async () => {
    const { c } = await run({ ffLevel: 'red', ffReasons: ['superseded'], midway: 'UNKNOWN' });
    expect(c.state).toBe('WAITING_FOR_DATA');
  });

  it('red aap-timeouts alone does not make the data unusable', async () => {
    const { c } = await run({ ffLevel: 'red', ffReasons: ['aap-timeouts'], midway: 'WAITING_FOR_USER' });
    expect(c.state).toBe('RECOMMENDATION_READY');
  });

  it('grey with a stored sync older than 3x the interval -> unusable; a fresh stored sync -> usable', async () => {
    const old = await run({ ffLevel: 'grey', lastOkAt: null, syncedAt: new Date(F.T0 - 2 * H).toISOString(), midway: 'COOLDOWN' });
    expect(old.c.state).toBe('AUTH_REQUIRED');
    F.freshDb('auth-grey');
    const fresh = await run({ ffLevel: 'grey', lastOkAt: null, syncedAt: new Date(F.T0 - 10 * MIN).toISOString(), midway: 'COOLDOWN' });
    expect(fresh.c.state).toBe('RECOMMENDATION_READY');
  });
});

describe('re-queue triggers', () => {
  it('an AUTH_REQUIRED case re-queues when Midway leaves AUTH_DOWN (UNKNOWN counts) and a fresh sync makes it usable', async () => {
    const world = F.mkWorld({ ffLevel: 'red', ffReasons: ['age>3x'], midway: 'WAITING_FOR_USER' });
    const env = F.mkEnv({ world });
    await env.ctl.runOnce();
    const id = only().case_id;
    expect(only().state).toBe('AUTH_REQUIRED');
    env.clock.advance(10 * MIN);
    await env.ctl.runOnce();
    expect(only().state).toBe('AUTH_REQUIRED');          // still in AUTH_DOWN: no trigger
    Object.assign(world, { midway: 'UNKNOWN', ffLevel: 'green', ffReasons: [] });
    env.clock.advance(25 * MIN);
    await env.ctl.runOnce();
    expect(only().state).toBe('RECOMMENDATION_READY');
    expect(F.cs.getCase(id).events.some((e) => e.kind === 'transition' && e.reason_code === 'auth_restored')).toBe(true);
  });

  it('a WAITING_FOR_DATA case re-queues at next_attempt_at (retry_due)', async () => {
    const world = F.mkWorld({ ffLevel: 'red', ffReasons: ['wedged'], midway: 'UNKNOWN' });
    const env = F.mkEnv({ world });
    await env.ctl.runOnce();
    const id = only().case_id;
    env.clock.advance(30 * MIN);
    await env.ctl.runOnce();
    expect(F.cs.getCase(id).runs.length).toBe(1);
    env.clock.advance(31 * MIN);
    await env.ctl.runOnce();
    expect(F.cs.getCase(id).events.some((e) => e.kind === 'transition' && e.reason_code === 'retry_due')).toBe(true);
    expect(F.cs.getCase(id).runs.length).toBe(2);
  });
});
