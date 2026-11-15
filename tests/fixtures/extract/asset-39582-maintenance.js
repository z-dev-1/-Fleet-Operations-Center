// tests/fixtures/extract/asset-39582-maintenance.js — getAsset maintenanceScheduleStatuses
// for WO 39582 (design §20.1). The 6 real probe types and their field shapes come from
// shape-probe/39582.asset_maintenance.json (DOT, PM_A, PM_B, WASH, STATE_DOT,
// R360_HANDOFF_INSPECTION; nextDueDate values 2026-11-01 / 2025-11-19 / 2026-09-16 /
// 2026-01-31; DATE and MONTH_AND_YEAR formats; usageEventList on 2 types). Vendor and
// person fields are masked. `syntheticTypes` is explicitly SYNTHETIC (types the probe
// did not see) for AC13's second case.
const lse = (type, display, vendor, completedTimeIso) => ({
  id: 'lse-' + type.toLowerCase(), maintenanceType: type, state: 'COMPLETED', vendor,
  maintenanceTypeDisplay: display, stateDisplay: 'Completed', completedTimeIso, createdBy: '<createdBy>',
});
const st = (o) => Object.assign({
  subMaintenanceTypes: null, lastCompletedSubMaintenanceTypes: null, openWorkRequest: null, openWorkOrders: [],
  allowedVendors: ['TA', 'OEM'], usageEventList: [], lastIntervalCompleted: null, nextIntervalDue: null,
  nextExpiryDate: null, ongoingStatusDisplay: 'Not scheduled',
}, o);

export const statuses39582 = [
  st({ maintenanceType: 'DOT', maintenanceTypeDisplay: 'DOT', nextDueDate: '2026-11-01', nextExpiryDate: '2026-11-30',
    dueDateDisplayFormat: 'DATE', lastCompletedDate: '2025-11-01', statusDisplay: 'Completed',
    lastServiceEvent: lse('DOT', 'DOT', 'TA', '2025-11-01T13:06:19Z') }),
  st({ maintenanceType: 'PM_A', maintenanceTypeDisplay: 'PM A', nextDueDate: '2025-11-19', dueDateDisplayFormat: 'DATE',
    lastCompletedDate: '2025-10-20', statusDisplay: 'Completed', nextIntervalDue: 12,
    usageEventList: [{ attributeName: 'ODOMETER', usagePercentage: 157.01990997574165, isAlternativeData: false, nextIntervalDue: 12 }],
    lastServiceEvent: lse('PM_A', 'PM A', 'OEM', '2025-10-20T00:00Z') }),
  st({ maintenanceType: 'PM_B', maintenanceTypeDisplay: 'PM B', nextDueDate: '2026-09-16', dueDateDisplayFormat: 'MONTH_AND_YEAR',
    lastCompletedDate: '2026-05-19', statusDisplay: 'Completed',
    usageEventList: [{ attributeName: 'ODOMETER', usagePercentage: 8.287575558736975, isAlternativeData: false }],
    lastServiceEvent: lse('PM_B', 'PM B', 'TA', '2026-05-19T15:00Z') }),
  st({ maintenanceType: 'WASH', maintenanceTypeDisplay: 'Wash', nextDueDate: '2026-01-31', dueDateDisplayFormat: 'DATE',
    lastCompletedDate: '2025-12-22', statusDisplay: 'Completed', lastServiceEvent: lse('WASH', 'Wash', 'OEM', '2025-12-22T15:00Z') }),
  st({ maintenanceType: 'STATE_DOT', maintenanceTypeDisplay: 'State DOT', nextDueDate: '2026-11-01', dueDateDisplayFormat: 'DATE',
    lastCompletedDate: null, statusDisplay: 'Not scheduled', lastServiceEvent: null }),
  st({ maintenanceType: 'R360_HANDOFF_INSPECTION', maintenanceTypeDisplay: 'R360 Handoff Inspection', nextDueDate: '2026-09-16',
    dueDateDisplayFormat: 'DATE', lastCompletedDate: '2026-06-11', statusDisplay: 'Completed',
    lastServiceEvent: lse('R360_HANDOFF_INSPECTION', 'R360 Handoff Inspection', 'TA', '2026-06-11T15:00Z') }),
];
export const asset39582 = { asset: { aaid: 'aaid_39582', maintenanceScheduleStatuses: statuses39582 } };

// SYNTHETIC: types absent from the probe.
export const syntheticTypes = [
  st({ maintenanceType: 'APU', maintenanceTypeDisplay: 'APU', nextDueDate: '2026-12-05', dueDateDisplayFormat: 'DATE', statusDisplay: 'Not scheduled' }),
  st({ maintenanceType: 'SVR', maintenanceTypeDisplay: 'SVR', nextDueDate: '2026-10-01', dueDateDisplayFormat: 'DATE', statusDisplay: 'Not scheduled' }),
  st({ maintenanceType: 'PM_X', maintenanceTypeDisplay: 'PM X', nextDueDate: '2027-02-01', dueDateDisplayFormat: 'MONTH_AND_YEAR', statusDisplay: 'Not scheduled' }),
  st({ maintenanceType: 'SEMIANNUAL_LIFT', maintenanceTypeDisplay: 'Semiannual Lift', nextDueDate: '2026-11-20', dueDateDisplayFormat: 'DATE', statusDisplay: 'Not scheduled' }),
  st({ maintenanceType: 'FOO_TYPE', maintenanceTypeDisplay: 'Foo', nextDueDate: null, dueDateDisplayFormat: 'DATE', statusDisplay: 'Not scheduled' }),
];
export const assetSynthetic = { asset: { maintenanceScheduleStatuses: syntheticTypes } };
