import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-freshness-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const tools = require('../src/orcha/fas/tool-registry');
const profiles = require('../src/orcha/fas/sender-profiles');
const runner = require('../src/orcha/fas/runner');
const relay = require('../src/orcha/relay');

const internal = () => ({ slackId: 'U_INT', name: 'Z', type: 'internal', operators: [], domiciles: [],
  allowedDataCategories: profiles.DATA_CATEGORIES.slice(), permittedRequestTypes: profiles.REQUEST_TYPES.slice() });
const carrierTUZR = () => ({ slackId: 'U_C', name: 'C', type: 'carrier', operators: ['TUZR'], domiciles: [],
  allowedDataCategories: ['unit_status', 'repair_timeline', 'work_orders', 'pm_status'], permittedRequestTypes: ['unit_status'] });

function seedFleet() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable' },
  ] });
  store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Z', org: 'Amazon', email: 'z@amazon.com' }]);
  store.save('slackSenderProfiles', {});
}
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('Part 13: source freshness surfacing', () => {
  it('marks a fresh cache entry not-stale and exposes ageMs + sourceUpdatedAt', async () => {
    seedFleet();
    const at = Date.now() - 2 * 3600 * 1000; // 2h ago (< 6h window)
    store.save('relayCache', { '320160': { workRequestId: 'WR-1', serviceState: 'WIP', vendor: 'Amerit', _cachedAt: at } });
    store.save('fasConfig', { enabled: true, mode: 'shadow', dataFreshnessMs: 6 * 3600 * 1000 });
    const r = await tools.runTool('GET_RELAY_GARAGE_UNIT', { unit: '320160' }, { profile: internal() });
    const wr = r.verifiedFacts.find(f => f.field === 'workRequestId');
    expect(wr.stale).toBe(false);
    expect(wr.ageMs).toBeGreaterThan(0);
    expect(wr.sourceUpdatedAt).toBeTruthy();
  });

  it('marks an OLD cache entry stale (older than freshness window)', async () => {
    seedFleet();
    const at = Date.now() - 48 * 3600 * 1000; // 2 days ago
    store.save('relayCache', { '320160': { workRequestId: 'WR-1', serviceState: 'WIP', vendor: 'Amerit', _cachedAt: at } });
    store.save('fasConfig', { enabled: true, mode: 'shadow', dataFreshnessMs: 6 * 3600 * 1000 });
    const r = await tools.runTool('GET_RELAY_GARAGE_UNIT', { unit: '320160' }, { profile: internal() });
    const wr = r.verifiedFacts.find(f => f.field === 'workRequestId');
    expect(wr.stale).toBe(true);
  });
});

describe('Part 13: financial data is internal-only', () => {
  beforeEach(() => {
    seedFleet();
    store.save('relayCache', { '320160': { vendorWorkOrderId: 'VWO-1', cause: 'x', correction: 'y', totalCost: '$1,200.00', _cachedAt: Date.now() } });
    store.save('fasConfig', { enabled: true, mode: 'shadow' });
  });
  it('internal sees totalCost', async () => {
    const r = await tools.runTool('GET_RELAY_WORK_ORDER_DETAILS', { unit: '320160' }, { profile: internal() });
    expect(r.verifiedFacts.some(f => f.field === 'totalCost')).toBe(true);
  });
  it('carrier does NOT see totalCost', async () => {
    const r = await tools.runTool('GET_RELAY_WORK_ORDER_DETAILS', { unit: '320160' }, { profile: carrierTUZR() });
    expect(r.ok).toBe(true);
    expect(r.verifiedFacts.some(f => f.field === 'totalCost')).toBe(false);
  });
});

describe('Part 13: stale evidence blocks autonomous auto-send', () => {
  it('queues instead of auto-sending when backing evidence is stale', async () => {
    seedFleet();
    store.save('relayCache', { '320160': { workRequestId: 'WR-1', serviceState: 'WIP', vendor: 'Amerit', _cachedAt: Date.now() - 48 * 3600 * 1000 } });
    store.save('fasCases', {}); store.save('fasApprovalQueue', []); store.save('fasAuditLog', []);
    store.save('fasConfig', { enabled: true, mode: 'autonomous', maxSteps: 2, dataFreshnessMs: 6 * 3600 * 1000, retry: { inLoopRetries: 0 } });
    vi.spyOn(relay, 'ask').mockResolvedValue(JSON.stringify({ decision: 'answer', confidence: 0.95, reason: 'ok', research: [], actions: [], reply: '320160 is at Amerit.' }));
    const out = await runner.handleInbound({ engine: 'dm', slackId: 'U_INT', senderName: 'Z', channelId: 'C1', ts: '1.1', text: 'status of 320160?' });
    expect(out.outcome).toBe('queued');       // not auto-sent
    expect(out.fasReply).toBeUndefined();
    expect(out.audit.queueReason).toMatch(/stale/i);
  });
});
