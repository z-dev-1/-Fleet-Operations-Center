import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { verifyResolution, isVerified, payloadOf } = require('../src/autopilot/resolution');

const B1 = Date.parse('2026-11-10T12:00:00Z');
const H = 3600000;
const caseRec = (extra) => Object.assign({ case_id: 'ap_x', last_down_build_at: B1 }, extra || {});
const active = (extra) => Object.assign({ equipmentId: 'U1', lifecycleState: 'Active' }, extra || {});
const meta = (extra) => Object.assign({ source: 'aap-api', syncedAt: new Date(B1 + 2 * H).toISOString(), buildAtMs: B1 + H }, extra || {});

describe('verifyResolution', () => {
  it('Active + API-sourced + build newer than the last down build -> token', () => {
    const r = verifyResolution(caseRec(), active({ workRequestId: 'WR1', canonicalStatus: 'available' }), meta(), B1 + 3 * H);
    expect(isVerified(r.token)).toBe(true);
    expect(payloadOf(r.token)).toMatchObject({ lifecycleState: 'Active', source: 'aap-api', buildAt: B1 + H, openWr: true, canonicalStatus: 'available' });
    expect(isVerified(verifyResolution(caseRec(), active({ _apiSourced: true }), meta({ source: 'legacy' }), B1).token)).toBe(true);
    expect(isVerified(verifyResolution(caseRec(), active({ lifecycleState: ' active ' }), meta(), B1).token)).toBe(true);
  });

  it('build not newer than the last down build -> null with no review (R1: syncedAt is ignored)', () => {
    expect(verifyResolution(caseRec(), active(), meta({ buildAtMs: B1 }), B1)).toBe(null);
    expect(verifyResolution(caseRec(), active(), meta({ buildAtMs: B1 - 1 }), B1)).toBe(null);
    // A syncedAt re-stamp far in the future with the same build changes nothing.
    expect(verifyResolution(caseRec(), active(), meta({ buildAtMs: B1, syncedAt: new Date(B1 + 99 * H).toISOString() }), B1)).toBe(null);
    expect(verifyResolution(caseRec(), active(), meta({ buildAtMs: null }), B1)).toBe(null);
  });

  it('a down row, or a missing row, never resolves', () => {
    expect(verifyResolution(caseRec(), active({ lifecycleState: 'Unavailable' }), meta(), B1)).toBe(null);
    expect(verifyResolution(caseRec(), null, meta(), B1)).toBe(null);
    const isDown = () => true;
    expect(verifyResolution(caseRec(), active(), meta({ isDown }), B1)).toBe(null);
  });

  it('dealer "ready", canonical ready_for_pickup or an AI statement alone never resolves', () => {
    const row = { equipmentId: 'U1', lifecycleState: 'Unavailable', offsiteStage: 'ready', canonicalStatus: 'ready_for_pickup', aiSays: 'repaired, mark road-ready' };
    expect(verifyResolution(caseRec({ ai_findings_json: '{"summary":"unit is repaired"}' }), row, meta(), B1)).toBe(null);
  });

  it('requests NEEDS_REVIEW for non-API rows, non-Active lifecycles and missing down observations', () => {
    expect(verifyResolution(caseRec(), active(), meta({ source: 'scrape' }), B1)).toEqual({ review: 'non_api_lifecycle' });
    expect(verifyResolution(caseRec(), active({ lifecycleState: 'Ordered' }), meta(), B1)).toEqual({ review: 'lifecycle_not_active' });
    expect(verifyResolution(caseRec(), active({ lifecycleState: 'Decommissioned' }), meta(), B1)).toEqual({ review: 'lifecycle_not_active' });
    expect(verifyResolution(caseRec({ last_down_build_at: null }), active(), meta(), B1)).toEqual({ review: 'no_down_observation' });
  });

  it('copies and hand-built objects are not verified tokens', () => {
    const t = verifyResolution(caseRec(), active(), meta(), B1).token;
    const copy = Object.assign({}, t);
    for (const s of Object.getOwnPropertySymbols(t)) copy[s] = t[s];
    expect(isVerified(copy)).toBe(false);
    expect(isVerified(JSON.parse(JSON.stringify(t)))).toBe(false);
    expect(isVerified({ lifecycleState: 'Active', source: 'aap-api' })).toBe(false);
    expect(isVerified(null)).toBe(false);
    expect(Object.isFrozen(t)).toBe(true);
  });

  it('is pure: requires nothing', () => {
    const src = fs.readFileSync(require.resolve('../src/autopilot/resolution.js'), 'utf8');
    expect(src.match(/require\(/g)).toBe(null);
  });
});
