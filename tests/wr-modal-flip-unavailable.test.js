// tests/wr-modal-flip-unavailable.test.js
//
// "Set unit to Unavailable after the WR is created" in the WR modal. Imports the
// REAL renderer module with its bridge/toast/dealer deps mocked, so this both
// syntax-checks wr-modal.js and exercises the actual reason-suggestion logic.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../renderer/src/js/bridge.js', () => ({ aap: {}, files: {}, relay: {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() {}, emit() {} } }));
vi.mock('../renderer/src/js/components/toast.js', () => ({ default: { show() {} } }));
vi.mock('../renderer/src/js/views/dealer-wo-modal.js', () => ({ open() {} }));

const { suggestFlipReason } = await import('../renderer/src/js/views/wr-modal.js');

describe('suggestFlipReason', () => {
  it('defaults to Damaged - Moderate for ordinary repair text', () => {
    expect(suggestFlipReason('Driver side mirror broken')).toBe('DAMAGED_MODERATE');
    expect(suggestFlipReason('Air leak at rear axle, brake chamber')).toBe('DAMAGED_MODERATE');
    expect(suggestFlipReason('')).toBe('DAMAGED_MODERATE');
  });
  it('picks Preventative Maintenance for PM work', () => {
    expect(suggestFlipReason('PM-B service due')).toBe('PREVENTATIVE_MAINTENANCE');
    expect(suggestFlipReason('Preventive maintenance')).toBe('PREVENTATIVE_MAINTENANCE');
  });
  it('picks PM Failed when the PM failed', () => {
    expect(suggestFlipReason('PM failed - brakes out of spec')).toBe('PM_FAILED');
  });
  it('picks Campaign for recalls', () => {
    expect(suggestFlipReason('OEM recall 24V-123')).toBe('CAMPAIGN');
  });
  it('picks post-accident inspection for collisions', () => {
    expect(suggestFlipReason('Collision with dock, bumper damage')).toBe('SAFETY_INSPECTION_POST_ACCIDENT');
  });
  it('picks License/Permit and GPS when clearly stated', () => {
    expect(suggestFlipReason('Expired registration / plate')).toBe('LICENSE_OR_PERMIT_ISSUE');
    expect(suggestFlipReason('GPS not reporting')).toBe('GPS_MALFUNCTIONING');
  });
  it('does not match PM inside other words', () => {
    expect(suggestFlipReason('Pump leaking coolant')).toBe('DAMAGED_MODERATE');
  });
});
