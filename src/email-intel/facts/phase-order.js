'use strict';
/**
 * email-intel/facts/phase-order.js — frozen copy of the repair-phase order used by
 * src/scrapers/email_intel.js deriveInformationType (design 3.5, F-25).
 *
 * The original array is a local const inside deriveInformationType, it is not exported, and
 * email_intel.js is not edited by this work. This copy is the `repair_stage` state enum of the
 * v2 schema. The drift test `email-intel-validate` :: "F-25 PHASE_ORDER matches email_intel.js
 * source" reads email_intel.js as text and deep-equals the literal, so the two cannot diverge.
 */

const PHASE_ORDER = Object.freeze([
  'awaiting_vendor', 'appointment_scheduled', 'vehicle_arrived', 'diagnosis',
  'diagnosis_complete', 'awaiting_estimate', 'awaiting_approval', 'awaiting_parts',
  'parts_backordered', 'parts_received', 'repair_in_progress', 'road_test',
  'quality_check', 'ready_for_pickup', 'pickup_scheduled', 'repair_complete', 'closed',
]);

// repair_stage values that claim the unit is ready to be picked up (ready is still only offered
// when canonical state confirms it, design 2.9).
const READY_PHASES = Object.freeze(['ready_for_pickup']);

const phaseIndex = (p) => PHASE_ORDER.indexOf(String(p == null ? '' : p));

module.exports = { PHASE_ORDER, READY_PHASES, phaseIndex };
