import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'et-decision-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const triage = require('../src/scrapers/email_triage');

const FLEET = [
  { equipmentId: '322472', operator: 'JLIT', domicileSite: 'ABE40' },
  { equipmentId: '520063', operator: 'RYDR', domicileSite: 'EOFE01' },
];

beforeEach(() => {
  store.save('fleetData', { rows: FLEET });
  store.save('canonicalState', { units: {} });
});

function rows() { return store.load('fleetData', {}).rows; }

describe('email_triage — rich decision + legacy mapping (spec §24/§25)', () => {
  it('approval email -> estimate_or_approval, decisionRequired, no auto-update, legacy fields preserved', () => {
    const rec = triage._mergeVerdict(
      { id: 'e1', subject: 'Unit 322472 estimate please approve $8,420', bodyText: 'dealer awaiting approval', receivedText: '10/19/2026' },
      { summary: 'Estimate awaiting approval', importance: 'high', unitRefs: [{ unit: '322472', update: '10/19 - estimate submitted', ready: false }] },
      rows());
    const d = rec.decision;
    expect(d.scope).toBe('mine');
    expect(d.category).toBe('estimate_or_approval');
    expect(d.actionOwner).toBe('internal_team');
    expect(d.actionType).toBe('review_estimate');
    expect(d.decisionRequired).toBe(true);
    expect(d.canonicalImpact.shouldUpdate).toBe(false); // approval is not a factual update
    // legacy fields still present for the overlay
    expect(rec.importance).toBe('high');
    expect(rec.replySuggested).toBe(false);
    expect(Array.isArray(rec.unitRefs)).toBe(true);
  });

  it('status update of my unit -> fleet_status_update, shouldUpdate true', () => {
    const rec = triage._mergeVerdict(
      { id: 'e2', subject: 'Unit 322472 parts', bodyText: 'Parts arrived, repair starting today.', receivedText: '10/19/2026' },
      { summary: 'Parts arrived, repair starting', confidence: 0.9, unitRefs: [{ unit: '322472', update: '10/19 - parts arrived, repair started', ready: false }] },
      rows());
    expect(rec.decision.category).toBe('fleet_status_update');
    expect(rec.decision.scope).toBe('mine');
    expect(rec.decision.canonicalImpact.shouldUpdate).toBe(true);
  });

  it('out-of-fleet unit -> not mine, not surfaced, no hallucinated unit ref', () => {
    const rec = triage._mergeVerdict(
      { id: 'e3', subject: 'Unit 999999 west region down', bodyText: 'other region issue', receivedText: '10/19/2026' },
      { summary: 'West region unit', unitRefs: [{ unit: '999999', update: 'x' }] }, // AI hallucinated a non-fleet unit
      rows());
    expect(rec.unitRefs).toHaveLength(0);               // dropped — not in fleetData
    expect(['other_region', 'other_fas', 'unknown']).toContain(rec.decision.scope);
    expect(rec.decision.scope).not.toBe('mine');
  });

  it('CC-only FYI -> informational, not surfaced on the personal board', () => {
    const rec = triage._mergeVerdict(
      { id: 'e4', subject: 'FYI weekly roundup', bodyText: 'general team note', receivedText: '10/19/2026', ccOnly: true },
      { summary: 'FYI note' }, rows());
    expect(rec.decision.scope).toBe('informational');
    expect(rec.decision.shouldSurface).toBe(false);
  });

  it('data report email -> data_report with requiresAttachmentParse', () => {
    const rec = triage._mergeVerdict(
      { id: 'e5', subject: 'PM overdue list attached', bodyText: '15 units', attachments: [{ name: 'pm_overdue.xlsx', type: 'xlsx' }], receivedText: '10/19/2026' },
      { summary: 'PM overdue list' }, rows());
    expect(rec.decision.category).toBe('data_report');
    expect(rec.decision.dataPayload.detected).toBe(true);
    expect(rec.decision.dataPayload.requiresAttachmentParse).toBe(true);
  });

  it('AI-unavailable fallback still produces a deterministic decision (fail safe)', () => {
    const rec = triage._fallbackVerdict(
      { id: 'e6', subject: 'Unit 322472 status', bodyText: 'parts ordered', receivedText: '10/19/2026' },
      rows());
    expect(rec.aiUnavailable).toBe(true);
    expect(rec.decision).toBeTruthy();
    expect(rec.decision.scope).toBe('mine');
  });
});

describe('email_triage — §17 safe auto-apply gate', () => {
  it('auto-applies a factual in-scope new update', () => {
    const results = { emails: [{
      id: 'a1', unitRefs: [{ unit: '322472', update: '10/19 - parts arrived' }],
      decision: { scope: 'mine', informationType: 'new', confidence: 0.9, decisionRequired: false, category: 'fleet_status_update', intent: 'provide_update', hasConflict: false },
    }] };
    const applied = triage.applyPendingUnitUpdates(results);
    expect(applied).toBe(1);
    expect(results.emails[0].unitUpdateApplied).toBe(true);
  });

  it('does NOT auto-apply an approval email (human decision) — stages with a reason', () => {
    const results = { emails: [{
      id: 'a2', unitRefs: [{ unit: '322472', update: '10/19 - estimate submitted' }],
      decision: { scope: 'mine', informationType: 'new', confidence: 0.9, decisionRequired: true, category: 'estimate_or_approval', intent: 'request_approval', hasConflict: false },
    }] };
    const applied = triage.applyPendingUnitUpdates(results);
    expect(applied).toBe(0);
    expect(results.emails[0].unitUpdateApplied).toBeFalsy();
    expect(results.emails[0].autoApplyBlocked).toBe('human-decision-required');
  });

  it('does NOT auto-apply a stale email (no state regression)', () => {
    const results = { emails: [{
      id: 'a3', unitRefs: [{ unit: '322472', update: '10/10 - waiting on parts' }],
      decision: { scope: 'mine', informationType: 'stale', confidence: 0.9, decisionRequired: false, category: 'fleet_status_update', intent: 'provide_update', hasConflict: false },
    }] };
    expect(triage.applyPendingUnitUpdates(results)).toBe(0);
    expect(results.emails[0].autoApplyBlocked).toContain('stale');
  });

  it('does NOT auto-apply an out-of-scope email', () => {
    const results = { emails: [{
      id: 'a4', unitRefs: [{ unit: '520063', update: '10/19 - note' }],
      decision: { scope: 'other_fas', informationType: 'new', confidence: 0.9, decisionRequired: false, category: 'fleet_status_update', intent: 'provide_update', hasConflict: false },
    }] };
    expect(triage.applyPendingUnitUpdates(results)).toBe(0);
    expect(results.emails[0].autoApplyBlocked).toBe('not-in-scope');
  });
});
