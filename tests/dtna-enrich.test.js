'use strict';
// tests/dtna-enrich.test.js
//
// DTNA_CASE_RE in src/scrapers/dtna_enrich.js (now a cache-backed facade; the
// facade itself is covered by tests/dtna-enrich-facade.test.js).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { DTNA_CASE_RE } = require('../src/scrapers/dtna_enrich');

describe('dtna_enrich — DTNA_CASE_RE', () => {
  it('matches a Servicetracker case URL and captures the Salesforce id', () => {
    const m = 'https://dtna.my.site.com/Servicetracker/s/case/500gx000000SJcUAAW'.match(DTNA_CASE_RE);
    expect(m).toBeTruthy();
    expect(m[1]).toBe('500gx000000SJcUAAW');
  });
  it('does not match non-DTNA URLs', () => {
    expect(DTNA_CASE_RE.test('https://volvopg.asist.decisiv.net/fleet/estimates/123')).toBe(false);
  });
});
