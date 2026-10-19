import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const aap = require('../src/scrapers/aap_api');

// Real-ish locationLatest for a unit whose live GPS is at a non-yard geofence
// (mirrors 321963: live geofence "116FCLGQY_ITR" while the unit is physically
// at the dealer for a return-to-yard tow). The off-site pickup address MUST win.
const LL = {
  geoPoint: { latitude: 40.607464, longitude: -75.562252 },
  geoFences: [{ name: '116FCLGQY_ITR' }, { name: 'EOFE01-SHUTTLE' }],
};

describe('createRepair tow location — off-site pickup wins over live-GPS yard geofence', () => {
  it('return-to-yard tow: currentLocation is the PICKUP address, not the live geofence', () => {
    const opts = {
      aaid: 'aaid_9cfd07ce', domicile: 'EOFE01', locationLatest: LL,
      areaPairs: [{ area: 'TOW', subcategory: 'Transloading required' }],
      // off-site pickup (the dealer the unit is sitting at)
      offSite: true, locStreet: '1407 Bulldog Drive', locCity: 'Allentown', locState: 'PA', locZip: '18104',
    };
    const body = aap._buildCreateRepairBody(opts, { aaid: 'aaid_9cfd07ce', latestLocation: LL }, 'FLEETNET', null);
    const cl = body.currentLocation || {};
    // Pickup address flows through…
    expect(cl.street).toBe('1407 Bulldog Drive');
    expect(cl.city).toBe('Allentown');
    expect(cl.subRegion).toBe('PA');
    // …and the live-GPS yard geofence must NOT have clobbered it.
    expect(cl.geofenceName).toBeNull();
    expect(cl.geofenceName).not.toBe('116FCLGQY_ITR');
    expect(cl.yardLocation).toContain('1407 Bulldog Drive');
  });

  it('on-site (not a return tow): still picks the yard geofence as before', () => {
    const opts = {
      aaid: 'x', domicile: 'EOFE01', locationLatest: LL,
      areaPairs: [{ area: 'Engine', subcategory: 'CEL' }],
      // no offSite → normal yard enrichment runs
    };
    const body = aap._buildCreateRepairBody(opts, { aaid: 'x', latestLocation: LL }, 'VOLVO', null);
    const cl = body.currentLocation || {};
    // Not off-site → it enriches from geofences (EOFE01 domicile match or first).
    expect(cl.geofenceName).toBeTruthy();
    expect(cl.type).toBe('AMAZON_FACILITY');
  });
});
