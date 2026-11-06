// tests/email-intel-risk.test.js — risky-phrase warnings on a reply draft (design 6.2 step 4). Warnings never block.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { scanRisk, RISK_CODES } = require('../src/email-intel/reply/risk');
const codes = (t) => scanRisk(t).map((w) => w.code);

describe('reply risk scan', () => {
  it('flags approval, go ahead, PO, amounts and date promises', () => {
    expect(codes('I approve the estimate.')).toEqual(['approval']);
    expect(codes('We authorized the tow')).toEqual(['approval']);
    expect(codes('Please go ahead with the repair')).toEqual(['go-ahead']);
    expect(codes('I will send the PO # today')).toContain('purchase-order');
    expect(codes('the purchase order is attached')).toEqual(['purchase-order']);
    expect(codes('The total is $1,840.50')).toEqual(['amount']);
    expect(codes('about 900 dollars')).toEqual(['amount']);
    expect(codes('It will be ready by Friday')).toEqual(['date-promise']);
    expect(codes('we need it back by 11/15')).toEqual(['date-promise']);
  });
  it('a neutral reply has no warnings; every warning is a code plus a fixed label (no matched text)', () => {
    expect(scanRisk('Thanks for the update, I will check and get back to you.')).toEqual([]);
    const w = scanRisk('Approved, go ahead, PO 123 for $500 by tomorrow');
    expect(w.map((x) => x.code)).toEqual(RISK_CODES);
    for (const x of w) expect(Object.keys(x).sort()).toEqual(['code', 'label']);
    expect(JSON.stringify(w)).not.toContain('500');
  });
  it('does not misread words that merely contain the letters', () => {
    expect(codes('Possible ETA, report attached')).toEqual([]);
  });
});
