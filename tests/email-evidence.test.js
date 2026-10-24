import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'email-ev-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const actions = require('../src/scrapers/email_actions');

beforeEach(() => { store.save('emailEvidence', {}); });

describe('email_actions — email as a canonical evidence source (spec §6)', () => {
  const email = {
    id: 'm-1', convId: 'c-1', from: 'dealer@vendor.com', fromName: 'Dealer',
    summary: 'Parts arrived; repair starting', receivedText: '10/19/2026',
    unitRefs: [{ unit: '322472', update: '10/19 - parts arrived, repair started' }],
  };
  const decision = { scope: 'mine', informationType: 'status_change', units: ['322472'], receivedAt: '10/19/2026' };

  it('buildEmailEvidence produces the §6 shape', () => {
    const ev = actions.buildEmailEvidence(decision, email, email.unitRefs[0]);
    expect(ev.source).toBe('email');
    expect(ev.field).toBe('repairUpdate');
    expect(ev.value).toContain('parts arrived');
    expect(ev.messageId).toBe('m-1');
    expect(ev.conversationId).toBe('c-1');
    expect(ev.sender).toBe('dealer@vendor.com');
    expect(ev.usedInConclusion).toBe(true);   // in-scope + status_change
    expect(ev.isConflict).toBe(false);
  });

  it('records evidence per in-scope unit and dedups by messageId', () => {
    const r1 = actions.recordEmailEvidence(decision, email);
    expect(r1.recorded).toBe(1);
    const r2 = actions.recordEmailEvidence(decision, email); // same email again
    expect(r2.recorded).toBe(0);                             // deduped
    const ev = actions.getEmailEvidence('322472');
    expect(ev).toHaveLength(1);
    expect(ev[0].source).toBe('email');
  });

  it('does NOT record evidence for out-of-scope email', () => {
    const r = actions.recordEmailEvidence({ scope: 'other_fas', informationType: 'new', units: ['322472'] }, email);
    expect(r.recorded).toBe(0);
    expect(actions.getEmailEvidence('322472')).toHaveLength(0);
  });

  it('flags a conflict when the email contradicts fresher canonical evidence', () => {
    const ev = actions.buildEmailEvidence({ scope: 'mine', informationType: 'contradiction', units: ['322472'] }, email, email.unitRefs[0]);
    expect(ev.isConflict).toBe(true);
    expect(ev.usedInConclusion).toBe(false); // a contradiction is NOT blindly used
    const r = actions.recordEmailEvidence({ scope: 'mine', informationType: 'contradiction', units: ['322472'] }, email);
    expect(r.conflicts).toBe(1);
  });

  it('a stale or duplicate email is recorded but not used in conclusion', () => {
    const stale = actions.buildEmailEvidence({ scope: 'mine', informationType: 'stale', units: ['322472'] }, email, email.unitRefs[0]);
    expect(stale.usedInConclusion).toBe(false);
    const dup = actions.buildEmailEvidence({ scope: 'mine', informationType: 'duplicate', units: ['322472'] }, email, email.unitRefs[0]);
    expect(dup.usedInConclusion).toBe(false);
  });
});
