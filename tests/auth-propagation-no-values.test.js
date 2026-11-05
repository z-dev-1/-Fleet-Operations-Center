// tests/auth-propagation-no-values.test.js — no cookie value ever reaches a log line
// or a renderer payload (auth.propagation FEAT-003, plan item 17, design test 9).
// (a) seeder, propagation and supervisor scenarios run with the harness sentinels
//     (FAKE-SESSION-VALUE, FAKE-AEA-VALUE, synthetic posture JWT) and every captured
//     log line / broadcast payload is scanned;
// (b) static guard: the four new modules contain no `.value` property read.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { installAuthCoordHarness } = require('./helpers/auth-coord-fakes.cjs');
const h = installAuthCoordHarness({ vi });
const fs = require('fs');
const auth = require('../src/scrapers/auth');
const seeder = require('../src/auth/session-seeder');
const prop = require('../src/auth/propagation');
const sup = require('../src/auth/midway-health-supervisor');
const authReport = require('../src/auth/auth-report');

const POSTURE_JWT = h.posture.token();
const SENTINELS = ['FAKE-SESSION-VALUE', 'FAKE-AEA-VALUE', 'FAKE-SIGNATURE', POSTURE_JWT, POSTURE_JWT.split('.')[1].slice(0, 12)];

function recLogger(sink) {
  const rec = (level) => (...a) => sink.push(level + ' ' + a.map(String).join(' '));
  return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

afterEach(() => {
  prop._reset(); seeder._reset(); sup._reset(); authReport._reset(); auth._resetCoord();
  h.electron.resetCounters();
});

describe('no cookie values in logs or payloads', () => {
  it('seeder + propagation + supervisor scenario with the harness sentinels', async () => {
    const lines = [];
    const sent = [];
    const log = recLogger(lines);
    authReport._setEnabledForTest(true);
    sup._setDeps({ propagation: true, isOffline: () => false });
    const imm = [];
    sup._setTimers({ immediate: (fn) => imm.push(fn), set: (fn, ms) => ({ fn, ms }), clear: () => {} });
    const vendor = h.electron.fakeVendorSession;

    // Seeder: real auth.js writes the sentinel values into the vendor jar.
    const seeded = await seeder.seedSession(vendor, { reason: 'no-values', partition: 'persist:vendor-uptake' }, { auth, electron: h.electron, logger: log });
    expect(seeded.ok).toBe(true);
    const stored = JSON.stringify([...vendor._store.values()]);
    expect(stored).toContain('FAKE-SESSION-VALUE');       // the jar really holds the sentinels
    expect(stored).toContain('FAKE-AEA-VALUE');
    expect(stored).toContain(POSTURE_JWT.split('.')[0]);
    // Inventory over the real jar.
    const inv = await seeder.buildInventory(vendor, {});
    lines.push(seeder.formatInventory(inv, 'test'));
    lines.push(JSON.stringify(inv));
    // Guard rejection path.
    await expect(seeder.guardedSession(vendor, {}, log).cookies.set({ name: 'session', domain: '.evil.test', value: 'FAKE-SESSION-VALUE' })).rejects.toThrow('non-amazon-host');

    // Propagation on the real supervisor, inventory over the seeded jar.
    let t = 10_000_000;
    const timers = { q: [], set(fn, ms) { const x = { fn, ms }; this.q.push(x); return x; }, clear() {} };
    const handle = prop.init({
      sendRaw: (ch, p) => sent.push([ch, p]),
      getCtx: () => ({ _loadFleetViaApiStartup: async () => {} }),
      deps: {
        logger: log, now: () => t, timers, inventorySession: vendor,
        aapApi: { dispose() {} }, workers: { wakeDependents: () => 0 }, scheduler: { recoverBlockedSlots: async () => {} },
        auth: { aeaSessionExpiryMin: () => auth.aeaSessionExpiryMin() },
        stickyDeps: { fromPartition: () => vendor, auth, electron: h.electron, logger: log },
      },
    });
    expect(handle).not.toBeNull();
    const runImm = () => { while (imm.length) imm.shift()(); };
    const runTimers = () => { const q = timers.q.splice(0); for (const x of q) x.fn(); };

    // Supervisor scenario: traffic success, failure, step-up signal, evidence, recovery.
    sup.noteApiOutcome({ ok: true, source: 'aap-api' });            // UNKNOWN -> HEALTHY
    runImm(); await flush(); runTimers(); await flush();
    sup.noteApiOutcome({ ok: false, err: { code: 'MIDWAY_SESSION_INVALID', message: 'FAKE-SESSION-VALUE' }, source: 'aap-api' });
    sup.noteStepUpSignal({ source: 'rca' });
    runImm(); await flush(); runTimers(); await flush();
    handle.interceptLegacy({ ok: true, expiresInMin: 600, aeaExpiresInMin: 30, token: 'FAKE-AEA-VALUE' });
    handle.interceptLegacy('error:FAKE-SESSION-VALUE');
    t += 6 * 60 * 1000;
    sup.noteApiOutcome({ ok: true, source: 'aap-api' });            // back to HEALTHY
    runImm(); await flush(); runTimers(); await flush();
    handle.broadcast();

    expect(sent.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('[auth-inventory]'))).toBe(true);
    const haystack = [
      ...lines,
      ...h.logs.map((l) => l.msg),
      JSON.stringify(sent),
      JSON.stringify(sup.getStatus()),
      JSON.stringify(sup.getHistory()),
      JSON.stringify(sup.getSnapshot()),
    ].join('\n');
    for (const s of SENTINELS) expect(haystack).not.toContain(s);
  });
});

describe('static guard', () => {
  it.each(['session-seeder', 'propagation', 'auth-status', 'auth-report'])('src/auth/%s.js contains no .value property read', (name) => {
    const src = fs.readFileSync(require.resolve('../src/auth/' + name + '.js'), 'utf8');
    expect(src).not.toMatch(/\.value\b/);
    expect(src).not.toMatch(/\[\s*['"]value['"]\s*\]/);
  });
});
