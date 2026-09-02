import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-relay-test-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const tools = require('../src/orcha/fas/tool-registry');
const profiles = require('../src/orcha/fas/sender-profiles');

const cachedAt = Date.now() - 2 * 3600 * 1000; // scraped 2h ago

function seed() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Unavailable' },
    { equipmentId: '622072', operator: 'SAPB', domicileSite: 'EWR45', lifecycleState: 'Unavailable' },
  ] });
  store.save('relayCache', {
    '320160': {
      workRequestId: 'WR-777', serviceState: 'Work in progress', vendor: 'Amerit',
      issueDetails: 'Coolant leak', lifecycleReason: 'Offsite Shop Repair', workDuration: '20d',
      vendorWorkOrderId: 'VWO-55', cause: 'Coolant leak at water pump', correction: 'Replaced water pump',
      totalCost: '$1,240.00', salesforceCase: '00123',
      offsiteShopEvent: 'SR-9001', offsiteShopEventUrl: 'https://volvopg.asist.decisiv.net/service_requests/9001',
      asistSource: 'estimate', asistLabel: 'Estimate 21059112', asistScrapedAt: new Date(cachedAt).toISOString(),
      asistNotes: 'Parts on order, ETA per dealer next Tuesday. Awaiting approval.', dealerName: 'Volvo ABE',
      fullConversation: 'Day1: dropped off\nDay2: diagnosed\nDay3: parts ordered',
      pageUrl: 'https://aap-na.corp.amazon.com/v2/service/uuid-abc', _serviceUUID: 'uuid-abc', _cachedAt: cachedAt,
      _plannedWRData: { workRequestId: 'WR-778', serviceState: 'Scheduled', vendor: 'Amerit', _relayUrl: 'https://aap-na.corp.amazon.com/v2/service/uuid-def' },
    },
    '622072': { _noWR: true, _cachedAt: cachedAt },
  });
  store.save('contacts', []);
  store.save('slackSenderProfiles', {});
}
beforeEach(() => { seed(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

const internal = () => ({ slackId: 'U_INT', name: 'Zila', type: 'internal', operators: [], domiciles: [],
  allowedDataCategories: profiles.DATA_CATEGORIES.slice(), permittedRequestTypes: profiles.REQUEST_TYPES.slice() });
const carrierSAPB = () => ({ slackId: 'U_SAPB', name: 'SAPB', type: 'carrier', operators: ['SAPB'], domiciles: [],
  allowedDataCategories: ['unit_status', 'repair_timeline', 'work_orders', 'pm_status'], permittedRequestTypes: ['unit_status'] });

describe('FAS Relay Garage + Offsite Event tools (reuse relayCache)', () => {
  it('GET_RELAY_GARAGE_UNIT returns sourced WR facts with cache timestamp', async () => {
    const r = await tools.runTool('GET_RELAY_GARAGE_UNIT', { unit: '320160' }, { profile: internal() });
    expect(r.ok).toBe(true);
    const wr = r.verifiedFacts.find(f => f.field === 'workRequestId');
    expect(wr.value).toBe('WR-777');
    expect(wr.source).toBe('RelayGarage');
    // Source timestamp reflects the cache scrape time (2h ago), not read time.
    expect(new Date(wr.sourceUpdatedAt).getTime()).toBe(new Date(cachedAt).getTime());
  });

  it('GET_RELAY_WORK_ORDERS returns primary + planned WRs (not a single result)', async () => {
    const r = await tools.runTool('GET_RELAY_WORK_ORDERS', { unit: '320160' }, { profile: internal() });
    const list = r.verifiedFacts.find(f => f.field === 'workOrders').value;
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some(w => w.kind === 'primary' && w.workRequestId === 'WR-777')).toBe(true);
    expect(list.some(w => w.kind === 'planned' && w.workRequestId === 'WR-778')).toBe(true);
  });

  it('GET_RELAY_WORK_ORDER_DETAILS surfaces cause/correction/cost', async () => {
    const r = await tools.runTool('GET_RELAY_WORK_ORDER_DETAILS', { unit: '320160' }, { profile: internal() });
    expect(r.verifiedFacts.find(f => f.field === 'reasonForRepair').value).toMatch(/coolant/i);
    expect(r.verifiedFacts.find(f => f.field === 'workAccomplished').value).toMatch(/water pump/i);
  });

  it('GET_OFFSITE_EVENT reports the linked Decisiv event + url', async () => {
    const r = await tools.runTool('GET_OFFSITE_EVENT', { unit: '320160' }, { profile: internal() });
    expect(r.verifiedFacts.find(f => f.field === 'hasOffsiteEvent').value).toBe(true);
    expect(r.verifiedFacts.find(f => f.field === 'offsiteEventUrl').value).toMatch(/decisiv\.net/);
  });

  it('GET_OFFSITE_EVENT_TIMELINE returns compact dealer notes', async () => {
    const r = await tools.runTool('GET_OFFSITE_EVENT_TIMELINE', { unit: '320160' }, { profile: internal() });
    expect(r.verifiedFacts.find(f => f.field === 'offsiteTimeline').value).toMatch(/parts on order/i);
  });

  it('reports no work order for a negative-cached unit (does not fabricate)', async () => {
    const r = await tools.runTool('GET_RELAY_GARAGE_UNIT', { unit: '622072' }, { profile: internal() });
    expect(r.ok).toBe(true);
    expect(r.verifiedFacts.find(f => f.field === 'relayHasWorkOrder').value).toBe(false);
  });

  it('enforces sender scope: SAPB carrier cannot read TUZR unit relay data', async () => {
    const denied = await tools.runTool('GET_RELAY_GARAGE_UNIT', { unit: '320160' }, { profile: carrierSAPB() });
    expect(denied.denied).toBe(true);
    // ...but can read their own unit
    const ok = await tools.runTool('GET_RELAY_GARAGE_UNIT', { unit: '622072' }, { profile: carrierSAPB() });
    expect(ok.ok).toBe(true);
  });
});
