// tests/slack-lane-fair-scheduler.test.js
//
// Fair lane design T2: src/slack/fair-lane.js createFairLane with a fake
// `serve` and `now` (no slack_send, no timers). Checks _pump order, `busy`
// exclusivity, exactly-once settle, error handling (design fix 4) and the
// hook arguments (design fix 2).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createFairLane } = require('../src/slack/fair-lane');

const READS = new Set(['r']);
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function harness(opts = {}) {
  const served = []; const pending = []; let inService = 0, maxInService = 0;
  const calls = { enq: [], deq: [] }; const logs = [];
  let t = 0;
  const lane = createFairLane({
    isWrite: (m) => !READS.has(m),
    now: () => t,
    logger: { warn: (m) => logs.push(m) },
    serve: opts.serve || ((job) => {
      served.push(job.params.id); inService++; maxInService = Math.max(maxInService, inService);
      job.started = true;
      return new Promise((res, rej) => pending.push({ job, res: (v) => { inService--; res(v); }, rej: (e) => { inService--; rej(e); } }));
    }),
    hooks: opts.hooks || {
      onEnqueue: (...a) => calls.enq.push(a),
      onDequeue: (...a) => calls.deq.push(a),
    },
  });
  const results = new Map();
  const add = (m, id, origin) => {
    const p = lane.enqueue(m, { id }, origin);
    p.then((v) => results.set(id, [...(results.get(id) || []), ['ok', v]]), (e) => results.set(id, [...(results.get(id) || []), ['err', e.message]]));
    return p;
  };
  // Settle the in-service job (FIFO of serve calls) and let the lane pump.
  const finish = async (how = 'ok') => {
    await flush();
    const x = pending.shift();
    if (how === 'ok') x.res({ echo: x.job.params.id }); else x.rej(new Error(how));
    await flush();
  };
  const drain = async () => { await flush(); while (pending.length) await finish(); };
  return { lane, served, pending, calls, logs, results, add, finish, drain, maxIn: () => maxInService, setT: (v) => { t = v; } };
}

describe('createFairLane', () => {
  it('_pump order: writes first, then round-robin over origins in ORIGINS order', async () => {
    const h = harness();
    h.add('r', 'd0', 'dmAutoReply');               // starts at once
    h.add('r', 'd1', 'dmAutoReply'); h.add('r', 'd2', 'dmAutoReply');
    h.add('r', 'o0', 'other'); h.add('r', 'n0', 'dmNotify'); h.add('r', 'c0', 'channelWatch');
    h.add('w', 'w0', 'other'); h.add('w', 'w1', 'dmAutoReply');
    await h.drain();
    expect(h.served).toEqual(['d0', 'w0', 'w1', 'c0', 'n0', 'o0', 'd1', 'd2']);
    expect(h.maxIn()).toBe(1);
  });

  it('busy exclusivity: at most one serve in flight; nothing starts until the current one settles', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.add('r', 'd' + i, 'dmAutoReply');
    await flush();
    expect(h.served).toEqual(['d0']);
    expect(h.lane._snapshot()).toMatchObject({ busy: true, reads: { dmAutoReply: 4 } });
    await h.finish();
    expect(h.served).toEqual(['d0', 'd1']);
    await h.drain();
    expect(h.maxIn()).toBe(1);
    expect(h.lane._snapshot()).toMatchObject({ busy: false, writes: 0, reads: { dmAutoReply: 0 } });
  });

  it('every enqueued job is served exactly once and settles exactly once with its own result, incl. rejections', async () => {
    const h = harness();
    const ids = [];
    for (let i = 0; i < 12; i++) { const id = 'j' + i; ids.push(id); h.add(i % 3 === 0 ? 'w' : 'r', id, ['dmAutoReply', 'channelWatch', 'dmNotify', 'other'][i % 4]); }
    await flush();
    for (let i = 0; i < 12; i++) await h.finish(i % 4 === 1 ? 'boom' + i : 'ok');
    expect([...h.served].sort()).toEqual([...ids].sort());
    expect(new Set(h.served).size).toBe(12);
    for (const id of ids) expect(h.results.get(id).length).toBe(1);
    const errs = ids.filter(id => h.results.get(id)[0][0] === 'err');
    expect(errs.length).toBe(3);
    for (const id of ids) if (h.results.get(id)[0][0] === 'ok') expect(h.results.get(id)[0][1]).toEqual({ echo: id });
  });

  it('fix 4: a serve rejection or a sync throw inside serve rejects only that job, with NO log; the lane continues', async () => {
    const logs = []; const served = [];
    const lane = createFairLane({
      isWrite: () => false, logger: { warn: (m) => logs.push(m) },
      serve: (job) => { served.push(job.params.id); if (job.params.id === 'a') throw new Error('sync bug'); if (job.params.id === 'b') return Promise.reject(new Error('net')); return Promise.resolve('ok:' + job.params.id); },
    });
    const r = await Promise.allSettled(['a', 'b', 'c'].map(id => lane.enqueue('r', { id }, 'other')));
    expect(r.map(x => x.status === 'fulfilled' ? x.value : x.reason.message)).toEqual(['sync bug', 'net', 'ok:c']);
    expect(served).toEqual(['a', 'b', 'c']);
    expect(logs).toEqual([]);
  });

  it('fix 4: an exception in the lane\'s own code (a hook) logs "fair lane error" and the job is still served', async () => {
    const logs = []; const served = [];
    const lane = createFairLane({
      isWrite: () => false, logger: { warn: (m) => logs.push(m) },
      serve: (job) => { served.push(job.params.id); return Promise.resolve(job.params.id); },
      hooks: { onEnqueue: () => { throw new Error('enq hook'); }, onDequeue: () => { throw new Error('deq hook'); } },
    });
    const r = await Promise.all(['a', 'b'].map(id => lane.enqueue('r', { id }, 'dmAutoReply')));
    expect(r).toEqual(['a', 'b']);
    expect(served).toEqual(['a', 'b']);
    expect(logs.filter(l => l === '[slack] fair lane error: enq hook').length).toBe(2);
    expect(logs.filter(l => l === '[slack] fair lane error: deq hook').length).toBe(2);
  });

  it('fix 2: hook arguments — onEnqueue(origin, isWrite, totalDepth), onDequeue(origin, isWrite, overtookReads)', async () => {
    const h = harness({ serve: null });
    h.add('r', 'd0', 'dmAutoReply');      // selected at once (serve marks started)
    h.add('r', 'c0', 'channelWatch');
    h.add('w', 'w0', 'channelWatch');     // overtakes c0
    h.add('r', 'x', 'bogus-origin');      // invalid origin -> 'other'
    await h.drain();
    h.add('w', 'w1', 'dmNotify');         // lane idle, no read queued -> not overtaking
    await h.drain();
    expect(h.calls.enq).toEqual([
      // d0 is selected but not started (serve runs a microtask later), so it still counts.
      ['dmAutoReply', false, 1], ['channelWatch', false, 2], ['channelWatch', true, 3], ['other', false, 4], ['dmNotify', true, 1]]);
    expect(h.calls.deq).toEqual([
      ['dmAutoReply', false, false], ['channelWatch', true, true], ['channelWatch', false, false], ['other', false, false], ['dmNotify', true, false]]);
    expect(h.served).toEqual(['d0', 'w0', 'c0', 'x', 'w1']);
  });

  it('totalDepth counts the selected-but-not-started job (today\'s _depth)', async () => {
    const enq = []; let release;
    const lane = createFairLane({
      isWrite: () => false,
      serve: (job) => new Promise((res) => { release = () => { job.started = true; res(1); }; }),
      hooks: { onEnqueue: (o, w, d) => enq.push(d) },
    });
    lane.enqueue('r', {}, 'other'); await flush();
    lane.enqueue('r', {}, 'other');          // first job selected, not yet started -> 2
    release(); await flush();
    expect(enq).toEqual([1, 2]);
  });
});
