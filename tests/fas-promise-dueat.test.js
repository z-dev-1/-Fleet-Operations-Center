import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-promise-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const runner = require('../src/orcha/fas/runner');
const caseStore = require('../src/orcha/fas/case-store');

afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('Part 7: promise detection excludes soft/capability phrasing', () => {
  it('treats real commitments as promises', () => {
    expect(runner._extractPromise("I'll follow up with Amerit today.")).toMatch(/follow up/i);
    expect(runner._extractPromise('I will confirm the ETA.')).toMatch(/confirm/i);
    expect(runner._extractPromise("We'll get that scheduled.")).toBeTruthy();
    expect(runner._extractPromise('Let me check with the vendor.')).toMatch(/check/i);
    expect(runner._extractPromise('I will have it done by EOD.')).toBeTruthy();
  });

  it('does NOT treat "I can" / "I could" / "I may" as commitments', () => {
    expect(runner._extractPromise('I can look into that if you want.')).toBeNull();
    expect(runner._extractPromise('I could reach out to the dealer.')).toBeNull();
    expect(runner._extractPromise("I'd be happy to help.")).toBeNull();
    expect(runner._extractPromise('That may be possible.')).toBeNull();
  });

  it('does not fabricate a promise from a plain status answer', () => {
    expect(runner._extractPromise('320160 is at Amerit, parts ordered.')).toBeNull();
  });
});

describe('Part 7: followUp.dueAt validation', () => {
  it('accepts a valid ISO date', () => {
    const d = new Date(Date.now() + 3 * 864e5).toISOString();
    expect(runner._validateDueAt(d)).toBe(new Date(d).toISOString());
  });
  it('rejects unparseable / absurd dates', () => {
    expect(runner._validateDueAt('not a date')).toBeNull();
    expect(runner._validateDueAt('0100-01-01')).toBeNull();      // year 100 AD
    expect(runner._validateDueAt('2999-01-01T00:00:00Z')).toBeNull(); // >2y out
    expect(runner._validateDueAt(null)).toBeNull();
  });
  it('next business day is a weekday at 09:00, in the future', () => {
    const iso = runner._nextBusinessDueAt();
    const d = new Date(iso);
    expect(d.getDay()).not.toBe(0); // not Sunday
    expect(d.getDay()).not.toBe(6); // not Saturday
    expect(d.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('Part 7: newer verified facts supersede older ones for the same field', () => {
  it('replaces a conflicting value instead of accumulating both', () => {
    const cid = caseStore.caseIdForUnit('320160');
    caseStore.upsert(cid, { unit: '320160', verifiedFacts: [{ field: 'serviceState', value: 'Work in progress', source: 'RelayGarage' }] }, '320160');
    caseStore.upsert(cid, { unit: '320160', verifiedFacts: [{ field: 'serviceState', value: 'Completed', source: 'RelayGarage' }] }, '320160');
    const c = caseStore.getCase(cid);
    const states = c.verifiedFacts.filter(f => f.field === 'serviceState');
    expect(states.length).toBe(1);            // no conflicting duplicates
    expect(states[0].value).toBe('Completed'); // newest wins
  });
});
