import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const intel = require('../src/scrapers/email_intel');

const FLEET = [
  { equipmentId: '322472', operator: 'JLIT', domicileSite: 'ABE40' },
  { equipmentId: '520063', operator: 'RYDR', domicileSite: 'EOFE01' },
];

describe('email_intel — vocabularies', () => {
  it('exposes all spec enums with the right members', () => {
    expect(intel.SCOPES).toContain('mine');
    expect(intel.SCOPES).toContain('other_region');
    expect(intel.CATEGORIES).toHaveLength(19);
    expect(intel.CATEGORIES).toContain('estimate_or_approval');
    expect(intel.INTENTS).toContain('request_approval');
    expect(intel.PRIORITIES).toEqual(['critical', 'high', 'normal', 'low', 'hidden']);
    expect(intel.INFORMATION_TYPES).toContain('duplicate');
    expect(intel.ACTION_OWNERS).toContain('internal_team');
    expect(intel.ACTION_TYPES).toContain('review_estimate');
  });
});

describe('email_intel — unit extraction + fleet validation', () => {
  it('splits mentioned numbers into in-fleet vs out-of-fleet', () => {
    const { inFleet, outOfFleet } = intel.extractUnits('Units 322472 and 999999 need attention', FLEET);
    expect(inFleet.map(u => u.unit)).toEqual(['322472']);
    expect(outOfFleet).toContain('999999');
  });
  it('does NOT associate a unit not in fleetData (no hallucination)', () => {
    const { inFleet } = intel.extractUnits('Unit 123456 is down', FLEET);
    expect(inFleet).toHaveLength(0);
  });
});

describe('email_intel — scope (spec §2)', () => {
  it('my fleet unit + vendor update = mine', () => {
    expect(intel.deriveScope({ subject: 'Unit 322472 parts update', bodyText: 'parts arrived' }, FLEET).scope).toBe('mine');
  });
  it('other-region unit not in fleet = out of scope (other_region)', () => {
    expect(intel.deriveScope({ subject: 'Unit 777777 west region issue', bodyText: 'other region' }, FLEET).scope).toBe('other_region');
  });
  it('broad distro but explicitly assigned to me = mine (assignment overrides distro)', () => {
    const r = intel.deriveScope({ subject: 'Team notice', bodyText: 'Zila, your unit needs attention' }, FLEET, { ccOnly: true });
    expect(r.scope).toBe('mine');
    expect(r.assignedToMe).toBe(true);
  });
  it('CC-only FYI with no unit + no assignment = informational', () => {
    expect(intel.deriveScope({ subject: 'Weekly roundup', bodyText: 'general team note' }, FLEET, { ccOnly: true }).scope).toBe('informational');
  });
  it('unit mention not in fleetData and no assignment = not mine (other_fas)', () => {
    expect(intel.deriveScope({ subject: 'Unit 654321 repair', bodyText: 'dealer update' }, FLEET).scope).toBe('other_fas');
  });
  it('unknown scope stays unknown (never invents ownership)', () => {
    expect(intel.deriveScope({ subject: 'Hello', bodyText: 'generic message' }, FLEET).scope).toBe('unknown');
  });
});

describe('email_intel — category + intent (spec §3/§4)', () => {
  it('approval request', () => {
    const e = { subject: 'Estimate for unit 322472 - please approve $8,420', bodyText: 'awaiting your approval' };
    expect(intel.classifyCategory(e)).toBe('estimate_or_approval');
    expect(intel.classifyIntent(e, 'estimate_or_approval')).toBe('request_approval');
  });
  it('status update', () => {
    const e = { subject: 'Unit 322472', bodyText: 'Parts arrived, repair starts today.' };
    expect(intel.classifyCategory(e)).toBe('fleet_status_update');
    expect(intel.classifyIntent(e, 'fleet_status_update')).toBe('provide_update');
  });
  it('data report with attachment', () => {
    const e = { subject: 'PM overdue list', attachments: [{ name: 'pm_overdue.xlsx', type: 'xlsx' }] };
    expect(intel.classifyCategory(e)).toBe('data_report');
    expect(intel.classifyIntent(e, 'data_report')).toBe('provide_data');
  });
  it('ready for pickup', () => {
    expect(intel.classifyCategory({ subject: 'Unit 322472 ready for pickup', bodyText: 'repairs complete, passed road test' })).toBe('ready_for_pickup');
  });
  it('tow-out phrasing is NOT ready_for_pickup', () => {
    expect(intel.classifyCategory({ subject: 'Unit staged', bodyText: 'ready to be towed out to the dealer' })).not.toBe('ready_for_pickup');
  });
  it('meeting invite', () => {
    expect(intel.classifyCategory({ subject: 'Teams meeting: fleet sync', bodyText: 'When: Mon Where: Teams' })).toBe('meeting');
  });
  it('automated notification', () => {
    expect(intel.classifyCategory({ from: 'no-reply@system.com', subject: 'Your report is ready' })).toBe('automated_notification');
  });
});

describe('email_intel — informationType vs canonical (spec §5)', () => {
  const canonAwaitingParts = { repairPhase: 'awaiting_parts', situation: 'Turbo parts on order ETA 10/23', updatedAt: new Date().toISOString(), lastMeaningfulUpdate: { at: new Date().toISOString(), text: 'parts on order ETA 10/23' } };

  it('duplicate: email repeats the known awaiting_parts state', () => {
    const t = intel.deriveInformationType({ phase: 'awaiting_parts', text: 'Parts on order, ETA 10/23' }, canonAwaitingParts);
    expect(t).toBe('duplicate');
  });
  it('status_change: parts arrived advances the phase', () => {
    const t = intel.deriveInformationType({ phase: 'parts_received', text: 'Parts arrived, going into the bay' }, canonAwaitingParts);
    expect(t).toBe('status_change');
  });
  it('stale: an older email describing an earlier phase does not regress state', () => {
    const t = intel.deriveInformationType({ phase: 'awaiting_vendor', text: 'waiting on vendor' }, { repairPhase: 'repair_in_progress', updatedAt: new Date().toISOString() });
    expect(t).toBe('stale');
  });
  it('new: no prior canonical record', () => {
    expect(intel.deriveInformationType({ text: 'Diagnosis complete, turbo failed' }, null)).toBe('new');
  });
  it('insufficient: empty fact', () => {
    expect(intel.deriveInformationType({ text: '' }, canonAwaitingParts)).toBe('insufficient');
  });
});

describe('email_intel — priority (spec §13)', () => {
  it('safety escalation is critical', () => {
    expect(intel.derivePriority({ subject: 'Safety: unit blocking the dock, urgent' }, 'mine', 'repair_blocker')).toBe('critical');
  });
  it('estimate approval is high', () => {
    expect(intel.derivePriority({ subject: 'estimate' }, 'mine', 'estimate_or_approval')).toBe('high');
  });
  it('out-of-scope is hidden (unless safety)', () => {
    expect(intel.derivePriority({ subject: 'west region note' }, 'other_region', 'fleet_status_update')).toBe('hidden');
    expect(intel.derivePriority({ subject: 'west region SAFETY out of service' }, 'other_region', 'compliance')).toBe('high');
  });
  it('FYI is low', () => {
    expect(intel.derivePriority({ subject: 'fyi' }, 'mine', 'informational')).toBe('low');
  });
});

describe('email_intel — relevance score (spec §14)', () => {
  it('my unit + assigned scores high; other region scores low', () => {
    const mine = intel.deriveScope({ subject: 'Unit 322472', bodyText: 'your unit update' }, FLEET);
    const other = intel.deriveScope({ subject: 'Unit 888888 west region', bodyText: 'other' }, FLEET);
    expect(intel.scoreRelevance({}, mine, 'fleet_status_update')).toBeGreaterThan(0.7);
    expect(intel.scoreRelevance({}, other, 'fleet_status_update')).toBeLessThan(0.3);
  });
});

describe('email_intel — action owner/type: never chase vendor when we are blocker (spec §9)', () => {
  it('estimate awaiting approval -> owner internal_team, action review_estimate', () => {
    expect(intel.deriveActionOwner('estimate_or_approval', 'request_approval', {})).toBe('internal_team');
    expect(intel.deriveActionType('estimate_or_approval', 'request_approval', {})).toBe('review_estimate');
  });
  it('we asked vendor, canon waitingOn=vendor -> owner vendor, action request_vendor_update', () => {
    expect(intel.deriveActionOwner('repair_blocker', 'follow_up', { waitingOnFine: 'vendor' })).toBe('vendor');
    expect(intel.deriveActionType('repair_blocker', 'follow_up', { waitingOnFine: 'vendor' })).toBe('request_vendor_update');
  });
  it('ready for pickup -> operator / arrange_pickup', () => {
    expect(intel.deriveActionOwner('ready_for_pickup', 'confirm_completion', {})).toBe('operator');
    expect(intel.deriveActionType('ready_for_pickup', 'confirm_completion', {})).toBe('arrange_pickup');
  });
});

describe('email_intel — data payload (spec §15/§16)', () => {
  it('detects a PM report with a parseable attachment', () => {
    const d = intel.detectDataPayload({ subject: 'PM overdue list', attachments: [{ name: 'pm.xlsx', type: 'xlsx' }], bodyText: '15 units' }, FLEET);
    expect(d.detected).toBe(true);
    expect(d.type).toBe('pm_report');
    expect(d.requiresAttachmentParse).toBe(true);
    expect(d.attachmentNames).toContain('pm.xlsx');
  });
  it('no attachment, no data signals -> not detected', () => {
    expect(intel.detectDataPayload({ subject: 'quick question', bodyText: 'can you call me' }, FLEET).detected).toBe(false);
  });
});

describe('email_intel — safe auto-apply gate (spec §17)', () => {
  const base = { scope: 'mine', informationType: 'new', confidence: 0.9, decisionRequired: false, category: 'fleet_status_update', intent: 'provide_update', hasConflict: false };
  it('applies only when all conditions hold', () => {
    expect(intel.shouldAutoApply(base).apply).toBe(true);
  });
  it('blocks when out of scope', () => {
    expect(intel.shouldAutoApply({ ...base, scope: 'other_fas' }).apply).toBe(false);
  });
  it('blocks when stale', () => {
    expect(intel.shouldAutoApply({ ...base, informationType: 'stale' }).apply).toBe(false);
  });
  it('blocks when it conflicts with canonical', () => {
    expect(intel.shouldAutoApply({ ...base, hasConflict: true }).apply).toBe(false);
  });
  it('blocks when confidence is low', () => {
    expect(intel.shouldAutoApply({ ...base, confidence: 0.5 }).apply).toBe(false);
  });
  it('blocks when a human decision is required', () => {
    expect(intel.shouldAutoApply({ ...base, decisionRequired: true }).apply).toBe(false);
  });
  it('blocks a question/request (not factual)', () => {
    expect(intel.shouldAutoApply({ ...base, category: 'question', intent: 'request_information' }).apply).toBe(false);
  });
  it('blocks a duplicate (nothing new to write)', () => {
    expect(intel.shouldAutoApply({ ...base, informationType: 'duplicate' }).apply).toBe(false);
  });
});
