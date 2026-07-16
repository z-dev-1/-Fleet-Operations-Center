// tests/slack-auth-status.test.js
//
// Regression coverage for the 2026-07-16 Slack (and Asana) "always shows
// Connected" bug fix in renderer/src/js/views/settings.js.
//
// Root cause: checkAuth() IPC handlers resolve to an OBJECT
// ({ authenticated: bool } for Slack, { ok: bool } for Asana), not a plain
// boolean. The old code did:
//   bridge.checkAuth().then((ok) => { el.textContent = ok ? 'Connected' : ... })
// Since a non-null object is ALWAYS truthy in JS, this showed "Connected"
// every single time the promise resolved, regardless of the actual
// `authenticated`/`ok` field inside it -- the status indicator had never
// once been able to correctly show "Not connected."
//
// Following the existing project convention (tests/validation.test.js,
// tests/sync-interval.test.js, tests/auto-email-slot-normalization.test.js),
// this mirrors the isolated boolean-derivation logic rather than importing
// the real renderer module (DOM + IPC bridge dependent).

import { describe, it, expect } from 'vitest';

// Mirrors the fixed logic: const ok = !!(res && res.authenticated);
function deriveSlackConnected(res) {
  return !!(res && res.authenticated);
}

// Mirrors the fixed logic: const ok = !!(res && res.ok);
function deriveAsanaValid(res) {
  return !!(res && res.ok);
}

// The exact pre-fix bug, preserved here ONLY to prove the old behavior was
// broken -- i.e. it always evaluates truthy for any non-null object.
function preFixBuggyCoercion(res) {
  return !!res;
}

describe('Slack auth status derivation (post-fix)', () => {
  it('correctly reports connected when authenticated is true', () => {
    expect(deriveSlackConnected({ authenticated: true })).toBe(true);
  });

  it('correctly reports NOT connected when authenticated is false (the exact bug scenario)', () => {
    expect(deriveSlackConnected({ authenticated: false })).toBe(false);
  });

  it('correctly reports NOT connected when authenticated is false with a reason field present', () => {
    expect(deriveSlackConnected({ authenticated: false, reason: 'not_configured' })).toBe(false);
  });

  it('handles a null/undefined response defensively', () => {
    expect(deriveSlackConnected(null)).toBe(false);
    expect(deriveSlackConnected(undefined)).toBe(false);
  });
});

describe('Asana auth status derivation (post-fix)', () => {
  it('correctly reports valid when ok is true', () => {
    expect(deriveAsanaValid({ ok: true, user: 'someone' })).toBe(true);
  });

  it('correctly reports invalid when ok is false (the exact bug scenario)', () => {
    expect(deriveAsanaValid({ ok: false, error: 'token expired' })).toBe(false);
  });

  it('handles a null/undefined response defensively', () => {
    expect(deriveAsanaValid(null)).toBe(false);
  });
});

describe('proof of the original bug (documentation only)', () => {
  it('demonstrates the pre-fix coercion was always truthy for ANY non-null object, even {authenticated:false}', () => {
    // This is exactly why the status indicator always said "Connected":
    // {authenticated: false} is still a non-null object -> truthy.
    expect(preFixBuggyCoercion({ authenticated: false })).toBe(true);
    expect(preFixBuggyCoercion({ ok: false })).toBe(true);
  });
});
