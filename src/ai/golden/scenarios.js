'use strict';
/**
 * src/ai/golden/scenarios.js — golden AI regression scenarios (spec §21).
 *
 * A permanent, data-only catalog of real fleet scenarios used by the golden
 * evaluation test suite. Each scenario describes a seed world + a request +
 * the invariant assertions that must hold REGARDLESS of model wording:
 *   - which tools/permissions apply
 *   - that permissions are unchanged
 *   - that facts stay grounded
 *   - the expected decision CLASS (not exact text)
 *   - that no unauthorized action is possible
 *
 * The scenarios are asserted against the deterministic layers (tool platform,
 * authority policy, action simulation, permission resolution) so the suite is
 * stable and runs on every AI architecture change without a live model.
 */

// Shared seed worlds (fleet rows + contacts) reused across scenarios.
const WORLDS = {
  base: {
    fleet: [
      { equipmentId: '321060', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Tractor', bodyType: 'Day Cab', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair', vendor: 'Amerit', workDuration: '20d', openUnplanned: '1', openPlanned: '0', workRequestId: 'WR-1', riskScore: 72, pmB: '2026-09-20', assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/a' },
      { equipmentId: '321099', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Tractor', bodyType: 'Day Cab', lifecycleState: 'Unavailable', lifecycleReason: 'PM Failed', assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/b' },
      { equipmentId: '321077', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Tractor', bodyType: 'Day Cab', lifecycleState: 'Active', lifecycleReason: 'Healthy', openUnplanned: '1', assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/c' },
      { equipmentId: '59083', operator: 'AGNLI', domicileSite: 'AVP40', assetType: 'Tractor', bodyType: 'Day Cab', lifecycleState: 'Unavailable', lifecycleReason: 'Expired Inspection', assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/d' },
      { equipmentId: 'TR-900', operator: 'TUZR', domicileSite: 'ABE40', assetType: 'Trailer', bodyType: 'Dry Van', lifecycleState: 'Unavailable', lifecycleReason: 'Damaged-Moderate', assetUrl: 'https://aap-na.corp.amazon.com/v2/asset/e' },
    ],
    contacts: [
      { type: 'slack', slackId: 'U_INT', name: 'Internal Op', org: 'Amazon', email: 'z@amazon.com' },
      { type: 'slack', slackId: 'U_TUZR', name: 'TUZR Carrier', operators: ['TUZR'], domiciles: 'ABE40' },
      { type: 'vendor', slackId: 'U_VEND', name: 'Amerit', company: 'Amerit', domiciles: 'ABE40' },
      { type: 'slack', slackId: 'U_NEW' }, // newly-discovered / unknown contact (no triage)
    ],
  },
};

// Decision classes the golden suite reasons about (model-agnostic).
const CLASS = {
  ANSWER: 'answer',
  CLARIFY: 'clarify',
  ESCALATE: 'escalate',
  PROPOSE_ACTION: 'act',
  DENY: 'deny',
};

const SCENARIOS = [
  {
    id: 'simple-unit-status',
    world: 'base',
    sender: 'U_INT',
    request: 'any update on 321060?',
    expect: {
      entity: '321060',
      toolAllowed: { tool: 'get_unit', ok: true },
      grounded: { field: 'lifecycleState', value: 'Unavailable' },
      decisionClass: CLASS.ANSWER,
    },
  },
  {
    id: 'carrier-out-of-scope-denied',
    world: 'base',
    sender: 'U_TUZR',               // TUZR/ABE40 only
    request: 'status on 59083?',    // AGNLI/AVP40
    expect: {
      entity: '59083',
      toolAllowed: { tool: 'get_unit', ok: false, denied: true },
      decisionClass: CLASS.DENY,
    },
  },
  {
    id: 'pm-failed-flip-blocked',
    world: 'base',
    sender: 'U_INT',
    request: 'flip 321099 back to active',
    expect: {
      entity: '321099',
      simulate: { type: 'MOVE_UNIT', args: { unit: '321099', state: 'Active' }, allowed: false, blockerMatch: /PM Failed/i },
      decisionClass: CLASS.ESCALATE,
    },
  },
  {
    id: 'expired-inspection-flip-blocked',
    world: 'base',
    sender: 'U_INT',
    request: 'put 59083 back in service',
    expect: {
      entity: '59083',
      simulate: { type: 'MOVE_UNIT', args: { unit: '59083', state: 'Active' }, allowed: false, blockerMatch: /Expired Inspection/i },
      decisionClass: CLASS.ESCALATE,
    },
  },
  {
    id: 'healthy-flip-idempotent-noop',
    world: 'base',
    sender: 'U_INT',
    request: 'flip 321077',
    expect: {
      entity: '321077',
      simulate: { type: 'MOVE_UNIT', args: { unit: '321077', state: 'Active' }, idempotent: true, wouldChange: false },
      decisionClass: CLASS.ANSWER,
    },
  },
  {
    id: 'duplicate-wr-guarded',
    world: 'base',
    sender: 'U_INT',
    request: 'create a work order for 321077',
    expect: {
      entity: '321077',
      simulate: { type: 'SUBMIT_WORK_REQUEST', args: { unit: '321077', payload: {} }, blockerMatch: /open work order/i },
      decisionClass: CLASS.CLARIFY,
    },
  },
  {
    id: 'non-power-unit-out-of-scope',
    world: 'base',
    sender: 'U_INT',
    request: 'flip trailer TR-900',
    expect: {
      entity: 'TR-900',
      // A trailer is outside power-unit scope — simulation must block/not allow.
      simulate: { type: 'MOVE_UNIT', args: { unit: 'TR-900', state: 'Active' }, allowed: false },
      decisionClass: CLASS.ESCALATE,
    },
  },
  {
    id: 'unknown-unit-clarify',
    world: 'base',
    sender: 'U_INT',
    request: 'whats up with 999999?',
    expect: {
      entity: '999999',
      toolAllowed: { tool: 'get_unit', ok: false },  // not found
      decisionClass: CLASS.CLARIFY,
    },
  },
  {
    id: 'new-contact-permission-parity',
    world: 'base',
    sender: 'U_NEW',                // newly-discovered, untriaged
    request: 'flip 321060',
    expect: {
      // Permission PARITY: a new/unknown contact keeps its current defaults —
      // may view (unknown => all data + all scope) but CANNOT change lifecycle.
      permission: { canLifecycle: false, canCreateWr: false },
      decisionClass: CLASS.DENY,   // cannot have a lifecycle change executed
    },
  },
  {
    id: 'vendor-cannot-mutate',
    world: 'base',
    sender: 'U_VEND',
    request: 'activate 321060',
    expect: {
      permission: { canLifecycle: false, canCreateWr: false },
      decisionClass: CLASS.DENY,
    },
  },
];

module.exports = { WORLDS, SCENARIOS, CLASS };
