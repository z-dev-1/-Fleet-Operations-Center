// tests/lifecycle-single-unit-fix.test.js
//
// Regression coverage for two bugs found and fixed 2026-07-16 in the
// single-unit "Modify Asset Lifecycle State" flow (renderer/src/js/views/
// unit-detail.js's _wireLifecycleForm, backed by real AAP browser
// automation in src/scrapers/setLifecycle.js).
//
// BUG A -- wrong dropdown value: the state <select> offered "Available" as
// an option, but AAP's real lifecycle modal only recognizes 'Active' |
// 'Unavailable' | 'End of Life' | 'Ordered' (confirmed via setLifecycle.js's
// own docstring and its own working example call). "Available" has no
// matching option inside the real AAP dropdown, so selecting it would
// silently fail deep inside the automation script.
//
// BUG B -- false success reporting: setLifecycleState() NEVER rejects/
// throws, even when the real AAP automation fails -- it always resolves,
// with { success: false, message: '...' } on failure. The caller's
// try/catch only catches thrown errors (IPC-level failures), so it was
// showing "Lifecycle changed to X" unconditionally regardless of whether
// AAP automation actually succeeded. Combined with BUG A, every attempt to
// flip a unit to "Available" was very likely silently failing while still
// reporting success to the user.
//
// These tests mirror the pure decision logic in isolation (matching the
// project's existing convention of testing extracted logic rather than
// full DOM/IPC integration).

import { describe, it, expect } from 'vitest';

// The 4 real AAP lifecycle states, as documented in setLifecycle.js's own
// docstring: @param {string} opts.state - 'Active' | 'Unavailable' | 'End
// of Life' | 'Ordered'
const REAL_AAP_LIFECYCLE_STATES = ['Active', 'Unavailable', 'Ordered', 'End of Life'];

// Mirrors the fixed dropdown's actual <option value="..."> set in
// unit-detail.js (post-fix).
const FIXED_DROPDOWN_OPTIONS = ['Active', 'Unavailable', 'Ordered', 'End of Life'];

// Mirrors the pre-fix dropdown's actual <option value="..."> set, kept
// here ONLY to document/prove the original bug.
const PRE_FIX_DROPDOWN_OPTIONS = ['Available', 'Unavailable'];

// Mirrors the fixed success/failure check in _wireLifecycleForm's confirm
// handler: const lcResult = await aap.setLifecycle(...); if (!lcResult ||
// !lcResult.success) { showError } else { showSuccess }
function evaluateLifecycleResult(lcResult) {
  if (!lcResult || !lcResult.success) {
    return { outcome: 'error', message: (lcResult && lcResult.message) || 'Unknown error — AAP automation did not confirm the change' };
  }
  return { outcome: 'success' };
}

describe('BUG A (dropdown mismatch): fixed dropdown now offers only real AAP states', () => {
  it('every fixed dropdown option is a real, valid AAP lifecycle state', () => {
    FIXED_DROPDOWN_OPTIONS.forEach(opt => {
      expect(REAL_AAP_LIFECYCLE_STATES).toContain(opt);
    });
  });

  it('the fixed dropdown covers all 4 real AAP states (nothing missing)', () => {
    expect(new Set(FIXED_DROPDOWN_OPTIONS)).toEqual(new Set(REAL_AAP_LIFECYCLE_STATES));
  });

  it('documents the original bug: "Available" was never a valid AAP state', () => {
    expect(PRE_FIX_DROPDOWN_OPTIONS).toContain('Available');
    expect(REAL_AAP_LIFECYCLE_STATES).not.toContain('Available');
  });
});

describe('BUG B (false success reporting): result.success is now checked correctly', () => {
  it('treats { success: true } as a genuine success', () => {
    expect(evaluateLifecycleResult({ success: true, message: 'Lifecycle state changed to Active' })).toEqual({ outcome: 'success' });
  });

  it('treats { success: false, message } as a genuine failure with AAP\'s own message surfaced', () => {
    const result = evaluateLifecycleResult({ success: false, message: 'Could not find lifecycle edit button (pencil)' });
    expect(result.outcome).toBe('error');
    expect(result.message).toBe('Could not find lifecycle edit button (pencil)');
  });

  it('treats a null/undefined result defensively as a failure (not a crash, not a false success)', () => {
    expect(evaluateLifecycleResult(null).outcome).toBe('error');
    expect(evaluateLifecycleResult(undefined).outcome).toBe('error');
  });

  it('falls back to a generic message when success is false but no message was provided', () => {
    const result = evaluateLifecycleResult({ success: false });
    expect(result.message).toBe('Unknown error — AAP automation did not confirm the change');
  });

  it('demonstrates the exact pre-fix bug scenario: real automation failure must NOT be reported as success', () => {
    // This is precisely what setLifecycleState() returns when the AAP
    // automation fails to find/click the Apply button, per setLifecycle.js.
    const realFailureFromAAP = { success: false, message: 'Apply Change button is disabled' };
    const result = evaluateLifecycleResult(realFailureFromAAP);
    expect(result.outcome).not.toBe('success');
    expect(result.outcome).toBe('error');
  });
});
