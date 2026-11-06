// tests/fixtures/email-intel/fleet.js — synthetic fleet for Email Triage Intelligence tests.
// PII-free: addresses use @example.test, vendors are invented, unit ids are fake.
// 4 in-scope units, 3 out-of-scope ids that appear in mail, a stale variant and an empty variant.

export const IN_SCOPE = Object.freeze([
  { equipmentId: '40123', operator: 'ACME DSP', domicileSite: 'ABE1', make: 'Freightliner', repairTimeline: '' },
  { equipmentId: '40456', operator: 'BETA LOGISTICS', domicileSite: 'AVP4', make: 'Volvo', repairTimeline: '' },
  { equipmentId: '40789', operator: 'ACME DSP', domicileSite: 'ABE1', make: 'Peterbilt', repairTimeline: '' },
  { equipmentId: '40999', operator: 'GAMMA FREIGHT', domicileSite: 'TUZR', make: 'Kenworth', repairTimeline: '' },
]);

export const OUT_OF_SCOPE_IDS = Object.freeze(['51888', '62100', '73001']);
export const IN_SCOPE_IDS = Object.freeze(IN_SCOPE.map((r) => r.equipmentId));

const DAY = 86_400_000;

/**
 * fleetData(variant, now) -> the shape stored under the `fleetData` key.
 *   'fresh'  : synced 1 hour before `now`
 *   'stale'  : synced 3 days before `now` (older than FLEET_STALE_HOURS, scope becomes unknown)
 *   'empty'  : no rows
 */
export function fleetData(variant = 'fresh', now = Date.now()) {
  if (variant === 'empty') return { rows: [], syncedAt: new Date(now - 3_600_000).toISOString() };
  const age = variant === 'stale' ? 3 * DAY : 3_600_000;
  return { rows: IN_SCOPE.map((r) => ({ ...r })), syncedAt: new Date(now - age).toISOString() };
}

/** The user's own mail identity used by ownership tests (set through emailIntelConfig.me). */
export const ME = Object.freeze({
  names: ['Zila Santiago', 'Zila'],
  addresses: ['zila.santiago@example.test'],
  distributionLists: ['fleet-ops@example.test'],
});
