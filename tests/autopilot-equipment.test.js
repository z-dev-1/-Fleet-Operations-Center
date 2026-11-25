// tests/autopilot-equipment.test.js — Autopilot V2 AC-3: the pure equipment gate (design §4.1).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { classifyEquipment, CLASSES } = require('../src/autopilot/equipment');
const C = (assetType, bodyType, extra) => classifyEquipment(Object.assign({ equipmentId: 'U1', assetType, bodyType }, extra || {}));

describe('classifyEquipment (AC-3)', () => {
  it('returns each of the 7 classes', () => {
    expect(C('tractor', 'Day Cab')).toEqual({ cls: 'POWER_ELIGIBLE', equipmentClass: 'tractor', code: 'tractor' });
    expect(C('trailer', '').cls).toBe(CLASSES.EXCLUDED_TRAILER);
    expect(C('hostler', '').cls).toBe(CLASSES.EXCLUDED_HOSTLER);
    expect(C('forklift', '').cls).toBe(CLASSES.EXCLUDED_UNSUPPORTED);
    expect(C('', 'Day Cab').cls).toBe(CLASSES.TYPE_UNKNOWN);
    expect(C('tractor', 'Trailer').cls).toBe(CLASSES.TYPE_CONFLICT);
    expect(classifyEquipment({ equipmentId: '  ', assetType: 'tractor' }).cls).toBe(CLASSES.INVALID_ROW);
    expect(classifyEquipment({ equipmentId: 42, assetType: 'tractor' }).cls).toBe(CLASSES.INVALID_ROW);
    expect(classifyEquipment(null).cls).toBe(CLASSES.INVALID_ROW);
    expect(Object.keys(CLASSES).length).toBe(7);
  });

  it('never returns POWER_ELIGIBLE for trailers, dollies, chassis, hostlers, yard / terminal tractors or spotters', () => {
    const types = ['trailer', 'Reefer Trailer', 'flatbed_trailer', 'dolly', 'Converter Dolly', 'chassis', 'container', 'hostler',
      'Yard Tractor', 'yard_truck', 'yard-dog', 'Terminal Tractor', 'terminal_tractor', 'spotter'];
    for (const t of types) {
      for (const b of ['', 'Day Cab', 'Box Truck', 'Sleeper']) {
        const r = C(t, b);
        expect(r.cls, t + ' / ' + b).not.toBe(CLASSES.POWER_ELIGIBLE);
        expect([CLASSES.EXCLUDED_TRAILER, CLASSES.EXCLUDED_HOSTLER]).toContain(r.cls);
      }
    }
  });

  it('runs the hostler rule before the tractor and trailer rules', () => {
    expect(C('Yard Tractor', 'Day Cab').cls).toBe(CLASSES.EXCLUDED_HOSTLER);
    expect(C('terminaltractor', '').cls).toBe(CLASSES.EXCLUDED_HOSTLER);
    expect(C('hostler trailer', '').cls).toBe(CLASSES.EXCLUDED_HOSTLER);
  });

  it('bodyType is never proof: a Day Cab body with an empty assetType is TYPE_UNKNOWN', () => {
    expect(C('', 'Day Cab')).toEqual({ cls: 'TYPE_UNKNOWN', equipmentClass: null, code: 'type_unknown' });
    expect(C(undefined, 'Box Truck').cls).toBe(CLASSES.TYPE_UNKNOWN);
    expect(C(null, 'Tractor').cls).toBe(CLASSES.TYPE_UNKNOWN);
  });

  it('a tractor or box truck with a trailer or hostler body is TYPE_CONFLICT with a body_ code', () => {
    expect(C('tractor', 'Reefer Trailer')).toEqual({ cls: 'TYPE_CONFLICT', equipmentClass: null, code: 'body_trailer' });
    expect(C('boxTruck', 'Yard Tractor')).toEqual({ cls: 'TYPE_CONFLICT', equipmentClass: null, code: 'body_yardtractor' });
    expect(C('tractor', 'Chassis').code).toBe('body_chassis');
  });

  it('boxTruck, box_truck and Box Truck are the same eligible class; a Reefer body stays eligible', () => {
    for (const t of ['boxTruck', 'box_truck', 'Box Truck', 'BOX-TRUCK']) {
      expect(C(t, 'Reefer'), t).toEqual({ cls: 'POWER_ELIGIBLE', equipmentClass: 'boxTruck', code: 'boxtruck' });
    }
  });

  it('codes are ASCII tokens of at most 32 chars', () => {
    const odd = C('Weird <script>alert(1)</script> type with a very long name indeed', '');
    expect(odd.cls).toBe(CLASSES.EXCLUDED_UNSUPPORTED);
    expect(odd.code).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(C('ünïcødé', '').code).toMatch(/^[a-z0-9_]{1,32}$/);
    for (const r of [C('trailer', ''), C('hostler', ''), C('tractor', 'Trailer'), C('', ''), C('tractor', '')]) {
      expect(r.code).toMatch(/^[a-z0-9_]{1,32}$/);
    }
  });
});
