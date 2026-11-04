// tests/ai-gateway-deep-scan-source.test.js — deep-scan tags its relay.ask calls
// for gateway priority: full-fleet scan = 'deep_scan' (low), forced / on-demand
// unit = 'deep_scan_unit' (normal), explicit opts.aiSource wins.
// Same CJS-cache stubbing as tests/timeline-freshness.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'gw-ds-src-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');

const _ask = vi.fn();
function _stub(rel, exportsObj) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}
_stub('../src/orcha/relay', { ask: (...a) => _ask(...a) });
_stub('../src/scrapers/asist_enrich', { enrichVolvoAsist: async () => ({ ok: false }) });
const deepScan = require('../src/orcha/deep-scan');

const AI_TEXT = 'REPAIR_STATUS: Waiting for parts\nPRIMARY_COMPONENT: ENGINE/MOTOR SYSTEMS\nISSUE: x\nTIMELINE:\n10/21 - y.\n';
const row = () => ({ equipmentId: '320160', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair', vendor: 'ACME', fullConversation: 'Conversation\n10/09 WR created' });
const run = (opts) => deepScan.runOrchaDeepScan([row()], Object.assign({ pushData: () => {}, pushStatus: () => {}, payload: {} }, opts));

beforeEach(() => { store.save('notesStore', {}); _ask.mockReset(); _ask.mockResolvedValue(AI_TEXT); });

describe('deep-scan AI source tags', () => {
  it("full scan -> 'deep_scan'", async () => {
    await run({});
    expect(_ask.mock.calls[0][1]).toEqual({ source: 'deep_scan' });
  });
  it("force -> 'deep_scan_unit'", async () => {
    await run({ force: true });
    expect(_ask.mock.calls[0][1]).toEqual({ source: 'deep_scan_unit' });
  });
  it('explicit aiSource wins (orcha:deep-process passes deep_scan_unit)', async () => {
    await run({ aiSource: 'deep_scan_unit' });
    expect(_ask.mock.calls[0][1]).toEqual({ source: 'deep_scan_unit' });
    const src = fs.readFileSync(path.join(__dirname, '../src/ipc/orcha.js'), 'utf8');
    expect(src).toContain("aiSource:    'deep_scan_unit'");
  });
});
