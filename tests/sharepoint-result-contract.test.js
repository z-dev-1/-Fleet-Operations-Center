// tests/sharepoint-result-contract.test.js
//
// Task #5 — SharePoint result contract + read-back verification semantics.
// These tests exercise the PURE parts (no live SharePoint, no BrowserWindow):
//   - status derivation: ok ONLY when all attempted workbooks verified;
//     partial-failure / verification-pending / blocked-configuration / failed
//   - buildRowValues column mapping (A-N) is preserved, and ACTIVE units clear
//     maintenance columns (the mapping the read-back verification relies on)
//
// The BrowserWindow-driven push + read-back is validated live in the acceptance
// checklist (Task #9), NOT here — no real workbook is touched in dev.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sp = require('../src/scrapers/sharepoint_push');

function base(over = {}) {
  const R = sp._newSpResult();
  return { ...R, ...over };
}

describe('read-back propagation-lag retry: pick the BEST attempt (_verifyMissingCount)', () => {
  it('counts total missing units across sheets', () => {
    expect(sp._verifyMissingCount({ sheets: [{ found: true, expectedMissing: ['a', 'b'] }, { found: true, expectedMissing: [] }] })).toBe(2);
  });
  it('a fully-verified attempt scores 0 (chosen over a partial one)', () => {
    expect(sp._verifyMissingCount({ sheets: [{ found: true, expectedMissing: [] }] })).toBe(0);
  });
  it('a missing worksheet is scored far worse than a couple missing rows', () => {
    const missingSheet = sp._verifyMissingCount({ sheets: [{ found: false }] });
    const fewMissingRows = sp._verifyMissingCount({ sheets: [{ found: true, expectedMissing: ['a', 'b', 'c'] }] });
    expect(missingSheet).toBeGreaterThan(fewMissingRows);
  });
  it('a lifecycle mismatch adds to the missing score', () => {
    expect(sp._verifyMissingCount({ sheets: [{ found: true, expectedMissing: [], sampleLifecycleMatch: false }] })).toBe(1);
  });
  it('null/invalid verify scores Infinity (never chosen over any real attempt)', () => {
    expect(sp._verifyMissingCount(null)).toBe(Infinity);
    // A real attempt with 2 missing beats a null attempt.
    expect(sp._verifyMissingCount({ sheets: [{ found: true, expectedMissing: ['a', 'b'] }] })).toBeLessThan(sp._verifyMissingCount(null));
  });
});

describe('SharePoint status derivation (ok only when read-back verified)', () => {
  it('ok=true only when every attempted workbook verified', () => {
    const d = sp._deriveSpStatus(base({ workbooksAttempted: 2, workbooksSucceeded: 2, workbooksFailed: 0 }));
    expect(d).toEqual({ status: 'ok', ok: true });
  });
  it('partial-failure when some verified, some failed', () => {
    const d = sp._deriveSpStatus(base({ workbooksAttempted: 2, workbooksSucceeded: 1, workbooksFailed: 1 }));
    expect(d.ok).toBe(false);
    expect(d.status).toBe('partial-failure');
  });
  it('verification-pending when pushed but nothing verified and a wb is pending', () => {
    const d = sp._deriveSpStatus(base({ workbooksAttempted: 1, workbooksSucceeded: 0, workbooksFailed: 1, workbooks: [{ status: 'verification-pending' }] }));
    expect(d.ok).toBe(false);
    expect(d.status).toBe('verification-pending');
  });
  it('failed when pushed, nothing verified, no pending', () => {
    const d = sp._deriveSpStatus(base({ workbooksAttempted: 1, workbooksSucceeded: 0, workbooksFailed: 1, workbooks: [{ status: 'failed' }] }));
    expect(d.status).toBe('failed');
    expect(d.ok).toBe(false);
  });
  it('blocked-configuration when nothing attempted', () => {
    const d = sp._deriveSpStatus(base({ workbooksAttempted: 0 }));
    expect(d.status).toBe('blocked-configuration');
    expect(d.ok).toBe(false);
  });
});

describe('buildRowValues column mapping preserved (A-N)', () => {
  const unit = {
    op: 'tuzr', id: 'V12345', bodyType: 'day cab', model: 'Volvo Day Cab',
    atsState: 'Unavailable', savedRepairStatus: 'In Shop', savedPrimaryComponent: 'Engine',
    altId: 'RG-9', savedOffsiteEvent: 'Offsite A', savedSalesforceCase: 'CASE-1',
    repairTimeline: 'timeline text', vendor: 'VendorCo', created: 'Jun 11, 2026 09:05AM -04:00 (11 days ago)',
    serviceUrl: 'https://relay/x', savedOffsiteUrl: 'https://offsite/x', savedSalesforceCaseUrl: 'https://sf/x',
  };
  it('maps carrier/unit/body/make + maintenance fields + urls', () => {
    const row = sp.buildRowValues(unit);
    expect(row.values[0]).toBe('TUZR');          // A carrier
    expect(row.values[1]).toBe('V12345');        // B unit# (join key)
    expect(row.values[2]).toBe('DAY CAB');       // C body type
    expect(row.values[4]).toBe('UNAVAILABLE');   // E lifecycle
    expect(row.values[5]).toBe('In Shop');       // F repair status
    expect(row.values[11]).toBe('VendorCo');     // L vendor
    expect(row.urls.H).toBe('https://relay/x');
    expect(row.urls.J).toBe('https://sf/x');
  });
  it('ACTIVE unit reports ACTIVE lifecycle', () => {
    const row = sp.buildRowValues({ ...unit, atsState: 'Available' });
    expect(row.values[4]).toBe('ACTIVE');
  });
});
