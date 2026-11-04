import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const aap = require('../src/scrapers/aap_api');

// Real locationLatest geofences for B62049 (captured live 2026-10-19). The unit
// is domiciled at ROC5. geoFences[0] is "SNY8-SHUTTLE" (a shuttle ROUTE, NOT the
// yard) — the old code picked [0] and mislabeled the yard. The real facility is
// ROC5 / ROC5-MMRO. This locks in that the YARD geofence is chosen.
const B62049_LL = {
  geoPoint: { latitude: 43.160592, longitude: -77.768369 },
  geoFences: [
    { name: 'SNY8-SHUTTLE' },
    { name: '250_SHEPARD_RD' },
    { name: '90_SHEPARD' },
    { name: 'ROC5-MMRO' },
    { name: 'New York', category: 'Region' },
    { name: 'ROC5', category: 'SortCenter' },
    { name: 'ROC5-SHUTTLE' },
    { name: 'SYR6' },
  ],
};

function buildFor(opts) {
  // Minimal assetFull; _buildCreateRepairBody reads currentLocation via _buildLocation
  // (coords from locationLatest) + the geofence enrichment under test.
  const assetFull = { aaid: opts.aaid, latestLocation: B62049_LL };
  return aap._buildCreateRepairBody(opts, assetFull, 'VOLVO', null);
}

describe('createRepair yard location — picks the FACILITY geofence, not route/region', () => {
  it('B62049 (domicile ROC5): yard resolves to a ROC5 facility, not SNY8-SHUTTLE', () => {
    const body = buildFor({ aaid: 'aaid_b30bc8d6', domicile: 'ROC5', locationLatest: B62049_LL, areaPairs: [{ area: 'Engine' }] });
    const cl = body.currentLocation || {};
    // Must NOT be the shuttle route that was geoFences[0].
    expect(cl.geofenceName).not.toBe('SNY8-SHUTTLE');
    // Must be a ROC5 facility (domicile match: "ROC5" or "ROC5-MMRO").
    expect(/^ROC5(-MMRO)?$/.test(cl.geofenceName)).toBe(true);
    expect(cl.type).toBe('AMAZON_FACILITY');
    // yardLocation should be populated now (was null before).
    expect(cl.yardLocation).toBeTruthy();
  });

  it('falls back to a site-code geofence when domicile is unknown (no shuttle/region)', () => {
    const body = buildFor({ aaid: 'x', domicile: '', locationLatest: B62049_LL, areaPairs: [{ area: 'Engine' }] });
    const cl = body.currentLocation || {};
    // Prefers the -MMRO facility, else a short site code — never the route/region.
    expect(cl.geofenceName).not.toBe('SNY8-SHUTTLE');
    expect(cl.geofenceName).not.toBe('New York');
    expect(['ROC5-MMRO', 'ROC5', 'SYR6']).toContain(cl.geofenceName);
  });

  it('real coordinates still flow through from locationLatest', () => {
    const body = buildFor({ aaid: 'x', domicile: 'ROC5', locationLatest: B62049_LL, areaPairs: [{ area: 'Engine' }] });
    const cl = body.currentLocation || {};
    expect(cl.latitude).toBeCloseTo(43.160592, 4);
    expect(cl.longitude).toBeCloseTo(-77.768369, 4);
  });
});
