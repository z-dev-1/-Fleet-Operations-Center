// tests/aap-create-wr-title-copy.test.js
//
// Create Work Request: (1) WR title is hard-capped at 90 chars regardless of
// caller; (2) a second WR reusing existing data links via copiedFromWorkRequestId
// (accepts a raw UUID or a /v2/service/<uuid> URL; unrecognized -> null so the
// second WR is created UNLINKED rather than pointing at garbage — supports a
// dealer-tracking-only WR).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { capWrTitle, normalizeCopiedFromId, WR_TITLE_MAX } = require('../src/scrapers/aap_create_wr');

describe('WR title 90-char cap', () => {
  it('caps a title longer than 90 characters', () => {
    const long = 'X'.repeat(150);
    expect(capWrTitle(long).length).toBe(90);
    expect(WR_TITLE_MAX).toBe(90);
  });
  it('leaves a short title unchanged', () => {
    expect(capWrTitle('Dealer Tracking Event')).toBe('Dealer Tracking Event');
  });
  it('falls back to "Work Request" for empty/missing titles', () => {
    expect(capWrTitle('')).toBe('Work Request');
    expect(capWrTitle(null)).toBe('Work Request');
    expect(capWrTitle(undefined)).toBe('Work Request');
  });
  it('caps exactly at the boundary', () => {
    expect(capWrTitle('A'.repeat(90)).length).toBe(90);
    expect(capWrTitle('A'.repeat(91)).length).toBe(90);
  });
});

describe('copiedFromWorkRequestId normalization (2nd WR / dealer tracking link)', () => {
  const UUID = 'ffb8271d-b8ad-4c12-9fa4-27fcbe75a3af';
  it('accepts a bare UUID', () => {
    expect(normalizeCopiedFromId(UUID)).toBe(UUID);
  });
  it('extracts the UUID from a /v2/service/<uuid> URL', () => {
    expect(normalizeCopiedFromId('https://aap-na.corp.amazon.com/v2/service/' + UUID)).toBe(UUID);
  });
  it('returns null for a missing/blank reference (unlinked 2nd WR allowed)', () => {
    expect(normalizeCopiedFromId(null)).toBeNull();
    expect(normalizeCopiedFromId('')).toBeNull();
    expect(normalizeCopiedFromId(undefined)).toBeNull();
  });
  it('returns null for a non-UUID string rather than fabricating a link', () => {
    expect(normalizeCopiedFromId('not-a-real-id')).toBeNull();
    expect(normalizeCopiedFromId('12345')).toBeNull();
  });
});
