import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const aap = require('../src/scrapers/aap_api');

// Real data for B62049 (2026-10-29). LIVE = AAP locationHistories/latest;
// HERE_ITEM = the revgeocode result for that GPS, the same lookup AAP's own
// wizard does when you click On Site -> Off Site.
const LIVE = {
  geoPoint: { latitude: 43.160658, longitude: -77.768327 },
  geoFences: [
    { name: 'New York', category: 'Region' }, { name: 'SNY8-SHUTTLE' }, { name: 'ROC5-MMRO' },
    { name: 'ROC5-SHUTTLE' }, { name: 'ROC5', category: 'SortCenter' },
  ],
};
const HERE_ITEM = {
  title: '90 Shepard Rd, Rochester, NY 14624-1148, United States',
  address: {
    label: '90 Shepard Rd, Rochester, NY 14624-1148, United States', countryCode: 'USA',
    countryName: 'United States', stateCode: 'NY', state: 'New York', county: 'Monroe',
    city: 'Rochester', street: 'Shepard Rd', postalCode: '14624-1148', houseNumber: '90',
  },
  timeZone: { name: 'America/New_York', utcOffset: '-04:00' },
};
const BASE = { aaid: 'aaid_b30bc8d6', domicile: 'ROC5', vendor: 'KWNE', locationLatest: LIVE, areaPairs: [{ area: 'Electrical' }] };
const build = (opts) => aap._buildCreateRepairBody(opts, { aaid: BASE.aaid, latestLocation: LIVE }, 'KWNE', null);

describe('WR unit location: Off Site from the truck GPS address', () => {
  it('BEFORE (no GPS address): yard geofence, no street address', () => {
    const cl = build(BASE).currentLocation;
    expect(cl.type).toBe('AMAZON_FACILITY');
    expect(cl.street).toBe('');
  });

  it('maps the HERE result to off-site address fields', () => {
    expect(aap._offSiteFromGeocode(HERE_ITEM)).toEqual({
      locStreet: '90 Shepard Rd', locCity: 'Rochester', locState: 'NY', locZip: '14624-1148',
      locTimeZone: 'America/New_York', locLabel: '90 Shepard Rd, Rochester, NY 14624-1148, United States',
    });
    expect(aap._offSiteFromGeocode({ address: {} })).toBeNull();
    expect(aap._offSiteFromGeocode(null)).toBeNull();
  });

  it('AFTER: B62049 WR goes in Off Site with 90 Shepard Rd and the real GPS', () => {
    const body = build({ ...BASE, offSite: true, ...aap._offSiteFromGeocode(HERE_ITEM) });
    const cl = body.currentLocation;
    expect(body.calltype).toBe('OFFSITE');
    expect(cl.type).toBe('OTHER');
    expect(cl.street).toBe('90 Shepard Rd');
    expect(cl.city).toBe('Rochester');
    expect(cl.subRegion).toBe('NY');
    expect(cl.postalCode).toBe('14624-1148');
    expect(cl.timeZone).toBe('America/New_York');
    expect(cl.latitude).toBeCloseTo(43.160658, 5);
    expect(cl.longitude).toBeCloseTo(-77.768327, 5);
    expect(cl.yardLocation).toBe('90 Shepard Rd, Rochester, NY');
  });

  it('Location name: truck inside ROC5 -> "ROC5", never the vendor', () => {
    const cl = build({ ...BASE, offSite: true, locFromGps: true, ...aap._offSiteFromGeocode(HERE_ITEM) }).currentLocation;
    expect(cl.code).toBe('ROC5');
    expect(cl.geofenceName).toBe('ROC5');
    expect(cl.code).not.toBe('KWNE');
  });

  it('Location name: truck not at any Amazon yard -> the street address', () => {
    const away = { geoPoint: { latitude: 42.9, longitude: -78.8 },
      geoFences: [{ name: 'New York', category: 'Region' }, { name: 'SNY8-SHUTTLE' }] };
    const opts = { ...BASE, locationLatest: away, offSite: true, locFromGps: true, ...aap._offSiteFromGeocode(HERE_ITEM) };
    const cl = aap._buildCreateRepairBody(opts, { aaid: BASE.aaid, latestLocation: away }, 'KWNE', null).currentLocation;
    expect(cl.code).toBe('90 Shepard Rd');
    expect(cl.code).not.toBe('KWNE');
  });

  it('Tow with a typed pickup: location name is the pickup street, not the vendor', () => {
    const opts = { ...BASE, vendor: 'FLEETNET', areaPairs: [{ area: 'TOW', subcategory: 'MECHANICAL ISSUE' }],
      offSite: true, towDirection: 'return-to-yard',
      locStreet: '1407 Bulldog Dr', locCity: 'Allentown', locState: 'PA', locZip: '18104' };
    const cl = aap._buildCreateRepairBody(opts, { aaid: BASE.aaid, latestLocation: LIVE }, 'FLEETNET', null).currentLocation;
    expect(cl.code).toBe('1407 Bulldog Dr');
    expect(cl.geofenceName).toBe('1407 Bulldog Dr');
    expect(cl.code).not.toBe('FLEETNET');
  });

  it('No GPS address (fallback On Site): B62049 live order picks "ROC5", not "ROC5-MMRO"', () => {
    const order = { geoPoint: LIVE.geoPoint, geoFences: [
      { name: 'New York', category: 'Region' }, { name: 'PYR6' }, { name: 'SNY8-SHUTTLE' },
      { name: '310 PARAGON DR_OON' }, { name: 'ROC5-MMRO' }, { name: 'ROC5-SHUTTLE' }, { name: 'SYR6' },
      { name: 'ROC5_NI_14624_583' }, { name: '90_SHEPARD' }, { name: '250_SHEPARD_RD' },
      { name: 'ROC5', category: 'SortCenter' } ] };
    const cl = aap._buildCreateRepairBody({ ...BASE, locationLatest: order }, { aaid: BASE.aaid, latestLocation: order }, 'KWNE', null).currentLocation;
    expect(cl.type).toBe('AMAZON_FACILITY');
    expect(cl.geofenceName).toBe('ROC5');
    expect(cl.code).toBe('ROC5');
  });

  it('reverseGeocodeGps ignores missing / 0,0 coordinates without calling out', async () => {
    expect(await aap.reverseGeocodeGps(null, null)).toBeNull();
    expect(await aap.reverseGeocodeGps(0, 0)).toBeNull();
  });
});
