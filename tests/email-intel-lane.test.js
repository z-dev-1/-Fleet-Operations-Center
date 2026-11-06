// tests/email-intel-lane.test.js — isolated lane only, priority mapping, health (design 1.6;
// R7.7, F-16, F-17, F2-04, F2-06).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { scriptedRelay } from './fixtures/email-intel/records.js';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lane = require('../src/email-intel/understand/lane');
const { createQueue } = require('../src/email-intel/understand/ai-queue');
const C = require('../src/email-intel/constants');

beforeEach(() => lane._resetForTests());
afterEach(() => lane._resetForTests());

function relayWith(answer, o) {
  const r = scriptedRelay(answer, o);
  r.askCalls = 0;
  r.ask = () => { r.askCalls++; return 'tool-enabled lane must never be used'; };
  lane._setRelayForTests(r);
  return r;
}

describe('askIsolated', () => {
  it('calls relay.askWithTimeout with isolated:true, source email_intel, a timeout and the signal', async () => {
    const r = relayWith(() => '{"ok":true}');
    const ac = new AbortController();
    const res = await lane.askIsolated('PROMPT', { trigger: 'manual', signal: ac.signal });
    expect(res).toEqual({ ok: true, text: '{"ok":true}' });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].opts).toMatchObject({ isolated: true, source: 'email_intel', priority: 'normal', timeoutMs: C.AI_CALL_TIMEOUT_MS, signal: ac.signal });
  });

  it('F2-04 AI priority is normal for manual and chat, low for scheduled', async () => {
    const { _trigger } = require('../src/scrapers/email_triage');
    expect(lane.priorityFor(_trigger({ _trigger: 'scheduled' }))).toBe('low');
    expect(lane.priorityFor(_trigger({}))).toBe('normal');
    expect(lane.priorityFor(_trigger({ _trigger: 'chat' }))).toBe('normal');
    expect(lane.priorityFor(_trigger(undefined))).toBe('normal');
    const r = relayWith(() => 'x');
    await lane.askIsolated('p', { trigger: _trigger({ _trigger: 'scheduled' }) });
    await lane.askIsolated('p', { trigger: _trigger({ _trigger: 'chat' }) });
    expect(r.calls.map((c) => c.opts.priority)).toEqual(['low', 'normal']);
  });

  it('R7.7 no fallback: lane failures return kind lane and never touch the tool-enabled lane; errors carry no model text', async () => {
    const throwing = relayWith(() => { throw new Error('model said: SECRET-CONTENT'); });
    const a = await lane.askIsolated('p', { trigger: 'manual' });
    expect(a).toEqual({ ok: false, kind: 'lane', error: 'threw' });
    const t = relayWith(() => { throw Object.assign(new Error('timed out'), { code: 'AI_TIMEOUT' }); });
    expect(await lane.askIsolated('p', {})).toEqual({ ok: false, kind: 'lane', error: 'timeout' });
    const e = relayWith(() => null);
    expect(await lane.askIsolated('p', {})).toEqual({ ok: false, kind: 'lane', error: 'empty' });
    const u = relayWith(() => 'x', { available: false });
    expect(await lane.askIsolated('p', {})).toEqual({ ok: false, kind: 'lane', error: 'lane-unavailable' });
    expect(u.calls).toHaveLength(0);
    const ac = new AbortController(); ac.abort();
    expect(await lane.askIsolated('p', { signal: ac.signal })).toMatchObject({ ok: false, error: 'aborted' });
    for (const r of [throwing, t, e, u]) expect(r.askCalls).toBe(0);
  });

  it('R7.7 only isolated lane: lane.js is the only file that calls askWithTimeout and it has no other ask path', () => {
    const dir = path.join(ROOT, 'src/email-intel');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]));
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const callers = walk(dir).filter((f) => f.endsWith('.js') && /askWithTimeout\(/.test(strip(fs.readFileSync(f, 'utf8'))));
    expect(callers.map((f) => path.basename(f))).toEqual(['lane.js']);
    const src = strip(fs.readFileSync(path.join(dir, 'understand/lane.js'), 'utf8'));
    expect(src).not.toMatch(/\.ask\(|reason\(|runInSlot|fallback/i);
    expect((src.match(/askWithTimeout\(/g) || []).length).toBe(1);
  });
});

describe('lane health (F-16)', () => {
  it('beginScan: isolatedLaneAvailable false sets unavailable and allows no AI', () => {
    relayWith(() => 'x', { available: false });
    expect(lane.beginScan({ now: 1000 })).toBe(false);
    expect(lane.state()).toMatchObject({ state: 'unavailable', checkedAt: new Date(1000).toISOString() });
    relayWith(() => 'x');
    expect(lane.beginScan({ now: 2000 })).toBe(true);
    expect(lane.state().state).toBe('unknown');
  });

  it('F-16 three lane failures degrade and stop AI for the scan', async () => {
    relayWith(() => 'x');
    lane.beginScan({});
    expect(lane.recordLaneFailure().tripped).toBe(false);
    expect(lane.recordLaneFailure().tripped).toBe(false);
    expect(lane.recordLaneFailure().tripped).toBe(true);
    expect(lane.state().state).toBe('degraded');
    expect(C.LANE_FAILS_TRIP).toBe(3);
    const q = createQueue({ laneState: () => lane.state().state });
    expect(await q.run(async () => 'never')).toEqual({ ok: false, dropped: 'degraded' });
    lane.recordSuccess();
    expect(lane.state()).toMatchObject({ state: 'ok', consecutiveFails: 0 });
  });

  it('F-16 probe-lane updates status, manual only', async () => {
    const r = relayWith(() => '{"ok":true}');
    const ok = await lane.probeLane({ now: 5000 });
    expect(ok).toMatchObject({ ok: true, state: 'ok' });
    expect(r.calls[0].opts).toMatchObject({ isolated: true, priority: 'normal', timeoutMs: 30_000 });
    relayWith(() => 'no json here');
    expect(await lane.probeLane({})).toMatchObject({ ok: false, state: 'unavailable', error: 'bad-output' });
    relayWith(() => 'x', { available: false });
    expect(await lane.probeLane({})).toMatchObject({ ok: false, state: 'unavailable' });
    // never automatic: the scan path does not call the probe
    for (const f of ['understand/analyze.js', 'index.js']) expect(fs.readFileSync(path.join(ROOT, 'src/email-intel', f), 'utf8')).not.toMatch(/probeLane\(/);
  });

  it('F2-06 lane.js documents the warm-process lane-switch cost', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/email-intel/understand/lane.js'), 'utf8');
    expect(src).toMatch(/F2-06 warm-process lane-switch cost/);
    expect(src).toMatch(/isolated and normal calls do not share warm Claude processes/);
    expect(src).toMatch(/first\s+(\*\s+)?email-intel call of a scan and the first interactive call after it may each pay a process start/);
    expect(src).toMatch(/back to back/);
  });
});
