/**
 * smoke_deep_scan.js — Stage 4 Bug A smoke test
 *
 * Tests runOrchaDeepScan in 3 tiers:
 *   Tier 1 (always runs): Pure unit tests — store wiring, filtering logic,
 *                         output shape — zero AI calls, zero network, zero Electron.
 *   Tier 2 (always runs): Integration-ready path test — relay.ask is stubbed
 *                         with a realistic response to verify full parse path.
 *   Tier 3 (opt-in):      Live relay call — only if SMOKE_LIVE=1 env var is set.
 *                         Uses the real Orcha WS relay; requires a running Orcha server.
 *
 * Usage:
 *   node smoke_deep_scan.js          → Tier 1 + 2 only
 *   SMOKE_LIVE=1 node smoke_deep_scan.js → Tier 1 + 2 + 3 (live AI call)
 */

'use strict';

const path = require('path');
const os   = require('os');
const fs   = require('fs');

// ── Resolve project root ──────────────────────────────────────────────────────
const BASE = '/home/zilasant/fleet/version_c';  // absolute project root (DevSpace path)
const SRC  = path.join(BASE, 'src');

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const results = [];

function ok(label, result, detail = '') {
  const status = result ? 'PASS' : 'FAIL';
  if (result) passed++; else failed++;
  results.push({ status, label, detail });
  const icon = result ? '  ✓' : '  ✗';
  console.log(`${icon} ${label}${detail ? ' (' + detail + ')' : ''}`);
}

function section(title) {
  console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(0, 56 - title.length)));
}

// ── Isolated module loader (forces fresh require each call) ──────────────────
function freshRequire(rel) {
  const abs = require.resolve(path.join(SRC, rel));
  delete require.cache[abs];
  return require(abs);
}

// ── Sandbox: redirect P.dataDir to a tmp dir so store writes don't pollute real data ──
const TMP_DATA = path.join(os.tmpdir(), 'fleet_smoke_' + Date.now());
fs.mkdirSync(TMP_DATA, { recursive: true });
process.env._FLEET_TEST_DATA_DIR = TMP_DATA;   // paths.js checks this below if we patch it

// Patch paths.js to use our tmp dir
const pathsMod = require(path.join(SRC, 'config/paths.js'));
pathsMod.setDataDir(TMP_DATA);
console.log('Sandbox data dir:', TMP_DATA);

// ── Load real modules ─────────────────────────────────────────────────────────
const store      = require(path.join(SRC, 'store/index.js'));
const { runOrchaDeepScan } = require(path.join(SRC, 'orcha/deep-scan.js'));

// ─────────────────────────────────────────────────────────────────────────────
// TIER 1 — Pure unit tests (no AI, no network, no Electron)
// ─────────────────────────────────────────────────────────────────────────────
section('TIER 1 — Module wiring & store sanity');

// T1-1: store.load does not crash
let notesPreload;
try {
  notesPreload = store.load('notesStore', {});
  ok('T1-1: store.load(notesStore) returns without throwing', true, typeof notesPreload);
} catch(e) {
  ok('T1-1: store.load(notesStore) returns without throwing', false, e.message);
}

// T1-2: store module has no isAbsolute fallback
const storeSource = fs.readFileSync(path.join(SRC, 'store/index.js'), 'utf8');
ok('T1-2: store has no absolute-path fallback', !storeSource.includes('isAbsolute(name)'));

// T1-3: _healthcheck in registry
ok('T1-3: _healthcheck is registered in store REGISTRY', storeSource.includes("'_healthcheck'") || storeSource.includes('"_healthcheck"'));

// T1-4: deep-scan requires store at module level (not from opts)
const deepScanSource = fs.readFileSync(path.join(SRC, 'orcha/deep-scan.js'), 'utf8');
ok('T1-4: deep-scan.js requires store at module level',  deepScanSource.includes("require('../store')"));
ok('T1-5: deep-scan.js does not destructure opts.store', !deepScanSource.includes('const { store'));

// T1-6: call sites no longer pass loadNotesStore / saveNotesStore
const syncSource  = fs.readFileSync(path.join(SRC, 'sync/index.js'), 'utf8');
const orchaSource = fs.readFileSync(path.join(SRC, 'ipc/orcha.js'), 'utf8');
ok('T1-6: sync/index.js has no loadNotesStore opt',  !syncSource.includes('loadNotesStore'));
ok('T1-7: sync/index.js has no saveNotesStore opt',  !syncSource.includes('saveNotesStore'));
ok('T1-8: ipc/orcha.js has no loadNotesStore opt',   !orchaSource.includes('loadNotesStore'));
ok('T1-9: ipc/orcha.js has no saveNotesStore opt',   !orchaSource.includes('saveNotesStore'));

// T1-10: runOrchaDeepScan is exported
ok('T1-10: runOrchaDeepScan is a function', typeof runOrchaDeepScan === 'function');

// T1-11: filtering logic — only unavail/offsite units are processed
section('TIER 1 — Unit filtering logic');
const mockRows = [
  { equipmentId: 'UNIT-001', lifecycleState: 'unavailable', atsState: 'ok',          relayStatus: 'available' },
  { equipmentId: 'UNIT-002', lifecycleState: 'active',      atsState: 'unavailable', relayStatus: 'available' },
  { equipmentId: 'UNIT-003', lifecycleState: 'active',      atsState: 'ok',          relayStatus: 'offsite'   },
  { equipmentId: 'UNIT-004', lifecycleState: 'active',      atsState: 'ok',          relayStatus: 'available' }, // should NOT be processed
];

// Re-implement filter logic from deep-scan.js to validate it independently
const shouldProcess = mockRows.filter(u => {
  const lc    = (u.lifecycleState || '').toLowerCase();
  const ats   = (u.atsState       || '').toLowerCase();
  const relay = (u.relayStatus    || '').toLowerCase();
  return lc.includes('unavail') || ats.includes('unavail') || relay.includes('offsite');
});
ok('T1-11: filter selects 3 of 4 test units',  shouldProcess.length === 3, `got ${shouldProcess.length}`);
ok('T1-12: UNIT-001 selected (lifecycleState)', shouldProcess.some(u => u.equipmentId === 'UNIT-001'));
ok('T1-13: UNIT-002 selected (atsState)',        shouldProcess.some(u => u.equipmentId === 'UNIT-002'));
ok('T1-14: UNIT-003 selected (relayStatus)',     shouldProcess.some(u => u.equipmentId === 'UNIT-003'));
ok('T1-15: UNIT-004 not selected (active/avail)',!shouldProcess.some(u => u.equipmentId === 'UNIT-004'));

// T1-16: store.save round-trip
section('TIER 1 — Store round-trip');
try {
  store.save('notesStore', { 'UNIT-001': { notes: 'test note', _testRun: true } });
  const loaded = store.load('notesStore', {});
  ok('T1-16: store.save then store.load round-trip', loaded['UNIT-001'] && loaded['UNIT-001'].notes === 'test note');
} catch(e) {
  ok('T1-16: store.save then store.load round-trip', false, e.message);
}

// T1-17: unknown store name throws
try {
  store.load('nonExistentStore_' + Date.now(), {});
  ok('T1-17: unknown store name throws', false, 'should have thrown');
} catch(e) {
  ok('T1-17: unknown store name throws', e.message.includes('Unknown store'));
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
// TIER 2 — Stubbed AI: full code path without live network
// Stubs relay.ask to return a realistic Orcha response.
// Verifies: store wiring, batch loop, note writing, return shape.
// ─────────────────────────────────────────────────────────────────────────────
section('TIER 2 — Full code path (relay.ask stubbed)');

// Stub relay.ask before loading orcha_ws so it intercepts the require chain
const relayPath = require.resolve(path.join(SRC, 'orcha/relay.js'));
const realRelay = require.cache[relayPath];
let stubCallCount = 0;

// Inject a fake relay into the module cache
require.cache[relayPath] = {
  id: relayPath, filename: relayPath, loaded: true, exports: {
    ask: async (prompt) => {
      stubCallCount++;
      // Simulate Orcha returning a properly formatted response
      const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' });
      return (
        'SUMMARY: Unit is at Acme Fleet Service undergoing brake system diagnosis. ' +
        'Awaiting repair estimate from vendor.\n' +
        `NOTE: ${today} - Unit at Acme Fleet Service pending brake diagnosis – awaiting estimate.`
      );
    },
    healthCheck: async () => ({ ok: true }),
    getStatus: () => 'connected',
  }
};

// Also clear orcha_ws and deep-scan caches so they pick up the stubbed relay
const owsPath  = require.resolve(path.join(SRC, 'scrapers/orcha_ws.js'));
const dspPath  = require.resolve(path.join(SRC, 'orcha/deep-scan.js'));
delete require.cache[owsPath];
delete require.cache[dspPath];

// Write a minimal notesStore pre-state
store.save('notesStore', {});

const testRows = [
  {
    equipmentId:   'UNIT-TEST-01',
    lifecycleState: 'unavailable',
    atsState:       'ok',
    relayStatus:    'available',
    vendor:         'Acme Fleet Service',
    lastConversation: 'Unit dropped for brake inspection 06/25. Awaiting diagnosis.',
    issueDetails:   'Brake system failure',
  },
  {
    equipmentId:   'UNIT-TEST-02',
    lifecycleState: 'active',
    atsState:       'ok',
    relayStatus:    'available',   // should NOT trigger AI
  },
];

// Capture what pushData / pushStatus receive
let pushDataCalled  = false;
let pushStatusCalls = [];
let scanResult;

const opts = {
  pushData:    (payload) => { pushDataCalled = true; },
  pushStatus:  (msg)     => { pushStatusCalls.push(msg); },
  payload:     { rows: testRows },
  uptakeCount: 2,
  relayCount:  0,
};

const { runOrchaDeepScan: runScan } = require(path.join(SRC, 'orcha/deep-scan.js'));

try {
  scanResult = await runScan(testRows, opts);

  ok('T2-1: runOrchaDeepScan resolves without throwing', true);
  ok('T2-2: returns { processed, improved }',
     scanResult && typeof scanResult.processed === 'number' && typeof scanResult.improved === 'number',
     JSON.stringify(scanResult));
  ok('T2-3: processed = 1 (only UNIT-TEST-01 qualifies)',  scanResult.processed === 1, `got ${scanResult.processed}`);
  ok('T2-4: relay.ask was called exactly once',            stubCallCount === 1,         `called ${stubCallCount}x`);
  ok('T2-5: pushData was called',                          pushDataCalled);
  ok('T2-6: pushStatus was called at least twice',         pushStatusCalls.length >= 2, `called ${pushStatusCalls.length}x`);

  // Verify note was written to store
  const notesAfter = store.load('notesStore', {});
  const u1Notes    = notesAfter['UNIT-TEST-01'];
  ok('T2-7: UNIT-TEST-01 written to notesStore',          !!u1Notes,            u1Notes ? 'present' : 'missing');
  ok('T2-8: notes field populated',                        u1Notes && typeof u1Notes.notes === 'string' && u1Notes.notes.length > 0, u1Notes ? u1Notes.notes.substring(0, 60) : 'none');
  ok('T2-9: _lastAiCorrection timestamp set',              u1Notes && !!u1Notes._lastAiCorrection);
  ok('T2-10: UNIT-TEST-02 NOT written (not unavail)',      !notesAfter['UNIT-TEST-02']);

  // Verify row mutation
  ok('T2-11: UNIT-TEST-01 row has _orchaProcessed=true',   testRows[0]._orchaProcessed === true);
  ok('T2-12: UNIT-TEST-01 row has _orchaProcessedAt',      !!testRows[0]._orchaProcessedAt);
  ok('T2-13: UNIT-TEST-01 row has repairTimeline set',     typeof testRows[0].repairTimeline === 'string' && testRows[0].repairTimeline.length > 0);
  ok('T2-14: UNIT-TEST-01 row has issueSummary set',       typeof testRows[0].issueSummary === 'string' && testRows[0].issueSummary.length > 0);

  // Verify improved count
  ok('T2-15: improved = 1 (one new note written)',         scanResult.improved === 1, `got ${scanResult.improved}`);

} catch(e) {
  ok('T2-1: runOrchaDeepScan resolves without throwing', false, e.message);
  console.error('    Full error:', e.stack);
  // Skip rest of T2
  for (let i = 2; i <= 15; i++) ok(`T2-${i}: (skipped — scan threw)`, false, 'scan threw');
}

// Restore real relay
if (realRelay) require.cache[relayPath] = realRelay;
else delete require.cache[relayPath];

// ── T2b: second scan same unit — "no change" path ─────────────────────────
section('TIER 2b — Idempotency (no change when note is unchanged)');
stubCallCount = 0;
delete require.cache[owsPath];
delete require.cache[dspPath];
require.cache[relayPath] = {
  id: relayPath, filename: relayPath, loaded: true, exports: {
    ask: async () => {
      stubCallCount++;
      // Return a note that matches what's already in the store → should NOT increment improved
      const currentNotes = store.load('notesStore', {});
      const existing = (currentNotes['UNIT-TEST-01'] || {}).notes || '';
      const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' });
      return (
        'SUMMARY: No change.\n' +
        `NOTE: ${existing || (today + ' - No new repair updates. Pending vendor follow-up.')}`
      );
    },
    healthCheck: async () => ({ ok: true }),
    getStatus: () => 'connected',
  }
};

const testRows2 = [{ ...testRows[0], _orchaProcessed: false }];
try {
  const { runOrchaDeepScan: runScan2 } = require(path.join(SRC, 'orcha/deep-scan.js'));
  const r2 = await runScan2(testRows2, { ...opts, payload: { rows: testRows2 } });
  ok('T2b-1: second scan resolves', true);
  ok('T2b-2: improved = 0 when note unchanged', r2.improved === 0, `got ${r2.improved}`);
} catch(e) {
  ok('T2b-1: second scan resolves', false, e.message);
  ok('T2b-2: improved = 0 when note unchanged', false, 'scan threw');
}

if (realRelay) require.cache[relayPath] = realRelay;
else delete require.cache[relayPath];

// ─────────────────────────────────────────────────────────────────────────────
// TIER 3 — Live relay (opt-in, SMOKE_LIVE=1 only)
// ─────────────────────────────────────────────────────────────────────────────
if (process.env.SMOKE_LIVE === '1') {
  section('TIER 3 — Live relay call (SMOKE_LIVE=1)');
  console.log('  → Connecting to Orcha relay...');
  delete require.cache[owsPath];
  delete require.cache[dspPath];

  const liveRow = [{
    equipmentId:    'SMOKE-LIVE-01',
    lifecycleState: 'unavailable',
    atsState:       'ok',
    relayStatus:    'available',
    vendor:         'Test Fleet Services',
    lastConversation: '06/27 - Unit towed to vendor for brake system inspection. Awaiting diagnosis.',
    issueDetails:   'Brake system — rear drums worn, pulling right',
  }];

  try {
    const { runOrchaDeepScan: runLive } = require(path.join(SRC, 'orcha/deep-scan.js'));
    const liveStart = Date.now();
    const lr = await runLive(liveRow, {
      pushData:    () => {},
      pushStatus:  (m) => console.log('    pushStatus:', m),
      payload:     { rows: liveRow },
      uptakeCount: 0,
      relayCount:  0,
    });
    const elapsed = Date.now() - liveStart;
    ok('T3-1: live scan resolves', true, `${elapsed}ms`);
    ok('T3-2: processed = 1',      lr.processed === 1, `got ${lr.processed}`);
    ok('T3-3: improved >= 0',      typeof lr.improved === 'number');
    const liveNotes = store.load('notesStore', {});
    const ln = liveNotes['SMOKE-LIVE-01'];
    ok('T3-4: note written to store', !!ln && !!ln.notes, ln ? ln.notes.substring(0, 80) : 'none');
    if (ln && ln.notes) console.log('\n  Generated note:', ln.notes);
  } catch(e) {
    ok('T3-1: live scan resolves', false, e.message);
  }
} else {
  section('TIER 3 — Skipped (set SMOKE_LIVE=1 to enable live relay call)');
  console.log('  → To run live: SMOKE_LIVE=1 node smoke_deep_scan.js');
}

// ─────────────────────────────────────────────────────────────────────────────



// RESULT SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(60));
console.log('SMOKE TEST RESULT');
console.log('='.repeat(60));
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
if (failed === 0) {
  console.log('\n  ✓ ALL CLEAR — deep-scan is fully functional after Bug A fix');
} else {
  console.log('\n  ✗ FAILURES FOUND — review above');
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log('    FAIL:', r.label, r.detail ? '(' + r.detail + ')' : '');
  });
}

// Cleanup sandbox
try { fs.rmSync(TMP_DATA, { recursive: true }); } catch(_) {}

process.exit(failed > 0 ? 1 : 0);

} // end main()

main().catch(e => { console.error("Unhandled:", e); process.exit(1); });
