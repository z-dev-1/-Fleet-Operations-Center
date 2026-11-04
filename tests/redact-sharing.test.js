// tests/redact-sharing.test.js
//
// redactForSharing strips personal names + dollar amounts for carrier-facing
// surfaces, while KEEPING vendor/company names, dealer locations, case numbers,
// parts, dates, and the actual repair text. Fixtures use the real B62060 10/12
// dealer comment that this redaction was built for.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { redactForSharing } = require('../src/orcha/redact_sharing');

describe('redactForSharing', () => {
  it('removes personal names from "Name - Company (Role)" headers but keeps the company/location', () => {
    const input = 'Christy Adriaansen - Kenworth Northeast Group - Rochester (Service Advisor) to MALCOLM REED - Amazon Logistics (Fleet Support)';
    const out = redactForSharing(input);
    expect(out).not.toMatch(/Christy Adriaansen/);
    expect(out).not.toMatch(/MALCOLM REED/);
    // Company + dealer location survive.
    expect(out).toMatch(/Kenworth Northeast Group - Rochester/);
    expect(out).toMatch(/Amazon Logistics/);
    expect(out).toMatch(/Service Advisor/);
  });

  it('removes dollar amounts', () => {
    expect(redactForSharing('Estimate Approved - $4,210.30')).not.toMatch(/\$|4,210/);
    expect(redactForSharing('total $2,601.95 approved')).not.toMatch(/\$|2,601/);
    expect(redactForSharing('est approved $13,977')).not.toMatch(/\$|13,977/);
  });

  it('keeps the actual repair text intact (the part the carrier needs)', () => {
    const input = 'GOOD MORNING, THE PART WE RECEIVED WAS DAMAGED- WE ARE WAITING FOR NEW ONE TO COME IN- SHOULD BE HERE IN THE NEXT COUPLE OF DAYS.';
    const out = redactForSharing(input);
    expect(out).toMatch(/PART WE RECEIVED WAS DAMAGED/);
    expect(out).toMatch(/WAITING FOR NEW ONE/);
  });

  it('strips signature tails like "BETSY TA" -> "TA" but keeps the vendor token', () => {
    const out = redactForSharing('Please approve. BETSY TA');
    expect(out).not.toMatch(/BETSY/);
    expect(out).toMatch(/\bTA\b/);
  });

  it('removes emails and phone numbers', () => {
    const out = redactForSharing('contact jsmith@kenworth.com or 716-614-2167 for status');
    expect(out).not.toMatch(/@kenworth\.com/);
    expect(out).not.toMatch(/716-614-2167/);
  });

  it('keeps case/reference numbers and dates', () => {
    const out = redactForSharing('Case 00026307 — estimate version 3 approved on 10/12/26');
    expect(out).toMatch(/00026307/);
    expect(out).toMatch(/10\/12\/26/);
    expect(out).toMatch(/version 3/);
  });

  it('never throws and returns empty string for empty/nullish input', () => {
    expect(redactForSharing('')).toBe('');
    expect(redactForSharing(null)).toBe('');
    expect(redactForSharing(undefined)).toBe('');
  });

  it('leaves clean text (no names/money) essentially unchanged', () => {
    const clean = 'Parts on order. Vendor estimates completion 07/01.';
    expect(redactForSharing(clean)).toBe(clean);
  });
});
