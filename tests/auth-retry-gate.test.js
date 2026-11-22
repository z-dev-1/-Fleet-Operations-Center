// Phase E step 1: src/utils/auth-retry-gate.js — single-flight, min gap, transient cooldown, action latch.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRetryGate } = require('../src/utils/auth-retry-gate.js');

const MIN = 60e3;
function mk() {
  let t = 1_000_000;
  const clock = { now: () => t, add: (ms) => { t += ms; } };
  const gate = createRetryGate({
    minGapMs: 2 * MIN, failCooldownMs: 5 * MIN, actionCooldownMs: 30 * MIN,
    actionCodes: new Set(['X_ACTION']), now: clock.now,
  });
  return { gate, clock };
}

describe('auth-retry-gate', () => {
  it('concurrent run -> fn called once, every caller gets the same result', async () => {
    const { gate } = mk();
    let calls = 0;
    let release;
    const fn = () => { calls++; return new Promise((r) => { release = r; }); };
    const a = gate.run(fn);
    const b = gate.run(fn);
    expect(a).toBe(b);
    expect(gate.state()).toEqual({ inFlight: true, actionNeeded: false });
    release({ ok: true });
    expect(await a).toEqual({ ok: true });
    expect(await b).toEqual({ ok: true });
    expect(calls).toBe(1);
    expect(gate.state().inFlight).toBe(false);
  });

  it('a second run inside the min gap is gated without calling fn', async () => {
    const { gate, clock } = mk();
    let calls = 0;
    const fn = async () => { calls++; return { ok: true }; };
    await gate.run(fn);
    clock.add(MIN);
    expect(await gate.run(fn)).toEqual({ ok: false, code: 'AUTH_COOLDOWN', gated: true });
    expect(calls).toBe(1);
    clock.add(MIN + 1);
    expect(await gate.run(fn)).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('a transient failure gates for 5 min, then allows', async () => {
    const { gate, clock } = mk();
    let calls = 0;
    const fn = async () => { calls++; return { ok: false, code: 'X_TIMEOUT' }; };
    expect(await gate.run(fn)).toEqual({ ok: false, code: 'X_TIMEOUT' });
    clock.add(3 * MIN);
    expect(gate.canStart()).toBe(false);
    expect((await gate.run(fn)).code).toBe('AUTH_COOLDOWN');
    clock.add(2 * MIN + 1);
    expect(gate.canStart()).toBe(true);
    await gate.run(fn);
    expect(calls).toBe(2);
    expect(gate.state().actionNeeded).toBe(false);
  });

  it('an action code latches: firstAction once, gated 30 min, still latched after a second failure', async () => {
    const { gate, clock } = mk();
    const fn = async () => ({ ok: false, code: 'X_ACTION' });
    expect(await gate.run(fn)).toEqual({ ok: false, code: 'X_ACTION', firstAction: true });
    expect(gate.state().actionNeeded).toBe(true);
    clock.add(29 * MIN);
    expect((await gate.run(fn)).code).toBe('AUTH_COOLDOWN');
    clock.add(MIN + 1);
    const again = await gate.run(fn);
    expect(again).toEqual({ ok: false, code: 'X_ACTION' });
    expect(again.firstAction).toBeUndefined();
    expect(gate.state().actionNeeded).toBe(true);
  });

  it('clearAction() unlatches; a later ok also clears', async () => {
    const { gate, clock } = mk();
    await gate.run(async () => ({ ok: false, code: 'X_ACTION' }));
    gate.clearAction();
    expect(gate.state().actionNeeded).toBe(false);
    clock.add(2 * MIN + 1);
    expect(gate.canStart()).toBe(true);
    await gate.run(async () => ({ ok: false, code: 'X_ACTION' }));
    clock.add(31 * MIN);
    await gate.run(async () => ({ ok: true }));
    expect(gate.state().actionNeeded).toBe(false);
  });

  it('fn throwing or rejecting -> AUTH_INTERNAL (transient), never rejects', async () => {
    const { gate, clock } = mk();
    expect(await gate.run(() => { throw new Error('boom'); })).toEqual({ ok: false, code: 'AUTH_INTERNAL' });
    clock.add(6 * MIN);
    expect(await gate.run(async () => { throw new Error('boom'); })).toEqual({ ok: false, code: 'AUTH_INTERNAL' });
    gate._reset();
    expect(gate.canStart()).toBe(true);
  });
});
