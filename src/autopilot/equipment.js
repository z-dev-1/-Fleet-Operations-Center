'use strict';
/**
 * autopilot/equipment.js — equipment gate (V2 design §4.1). Pure.
 *
 *   classifyEquipment(row) -> { cls, equipmentClass|null, code }
 *
 * Only POWER_ELIGIBLE units (tractor, box truck) are investigated. The rules run
 * in a fixed order: hostler before trailer before tractor / box truck (FR-1.4).
 * bodyType is never proof of a power unit (FR-1.5); it can only raise a
 * TYPE_CONFLICT for a tractor / box truck. `code` is an ASCII token (<= 32
 * chars) that is safe to store and log; the raw assetType is never logged.
 */

const { normUnit } = require('./constants');

const CLASSES = Object.freeze({
  POWER_ELIGIBLE: 'POWER_ELIGIBLE',
  EXCLUDED_TRAILER: 'EXCLUDED_TRAILER',
  EXCLUDED_HOSTLER: 'EXCLUDED_HOSTLER',
  EXCLUDED_UNSUPPORTED: 'EXCLUDED_UNSUPPORTED',
  TYPE_UNKNOWN: 'TYPE_UNKNOWN',
  TYPE_CONFLICT: 'TYPE_CONFLICT',
  INVALID_ROW: 'INVALID_ROW',
});
const EXCLUDED_CLASSES = Object.freeze([CLASSES.EXCLUDED_TRAILER, CLASSES.EXCLUDED_HOSTLER, CLASSES.EXCLUDED_UNSUPPORTED]);

const HOSTLER_T = /hostler|yard(tractor|truck|dog)|spotter|terminaltractor/;
const HOSTLER_B = /hostler|yard\s*(tractor|truck|dog)|spotter|terminal\s*tractor/;
const TRAILER_T = /trailer|dolly|chassis|container/;
const TRAILER_B = /trailer|dolly|chassis|container/;

function _token(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32); }

function classifyEquipment(row) {
  if (!row || typeof row.equipmentId !== 'string' || !normUnit(row.equipmentId)) {
    return { cls: CLASSES.INVALID_ROW, equipmentClass: null, code: 'invalid_row' };
  }
  const t = String(row.assetType == null ? '' : row.assetType).toLowerCase().replace(/[\s_-]+/g, '');
  const b = String(row.bodyType == null ? '' : row.bodyType).toLowerCase();
  if (HOSTLER_T.test(t)) return { cls: CLASSES.EXCLUDED_HOSTLER, equipmentClass: null, code: _token(t.match(HOSTLER_T)[0]) };
  if (TRAILER_T.test(t)) return { cls: CLASSES.EXCLUDED_TRAILER, equipmentClass: null, code: _token(t.match(TRAILER_T)[0]) };
  if (t === 'tractor' || t === 'boxtruck') {
    const m = b.match(HOSTLER_B) || b.match(TRAILER_B);
    if (m) return { cls: CLASSES.TYPE_CONFLICT, equipmentClass: null, code: ('body_' + _token(m[0])).slice(0, 32) };
    return { cls: CLASSES.POWER_ELIGIBLE, equipmentClass: t === 'tractor' ? 'tractor' : 'boxTruck', code: t };
  }
  if (t !== '') return { cls: CLASSES.EXCLUDED_UNSUPPORTED, equipmentClass: null, code: _token(t) || 'unsupported' };
  return { cls: CLASSES.TYPE_UNKNOWN, equipmentClass: null, code: 'type_unknown' };
}

module.exports = { classifyEquipment, CLASSES, EXCLUDED_CLASSES, ...CLASSES };
