import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-fu-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const caseStore = require('../src/orcha/fas/case-store');
const scheduler = require('../src/orcha/fas/scheduler');

function enable(mode) { store.save('fasConfig', { enabled: true, mode: mode || 'shadow' }); }
function seedDue(unit) {
  caseStore.upsert(caseStore.caseIdForUnit(unit), {
    unit, currentSummary: 'awaiting ' + unit, responsibleParty: 'Amerit',
    promises: [{ text: "I'll confirm the ETA", madeAt: new Date().toISOString() }],
    relatedSlackMessages: [{ channelId: 'C1', ts: '100.1' }],
    nextFollowUpAt: new Date(Date.now() - 3600 * 1000).toISOString(),
  }, unit);
}
beforeEach(() => { store.save('fasCases', {}); store.save('fasAuditLog', []); enable(); });
afterEach(() => { scheduler.stopScheduler(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('Part 8: follow-up scheduler UI data + anti-spam', () => {
  it('getDueFollowUps returns actionable fields (unit, owner, dueAt, sourcePromise, slackRef)', () => {
    seedDue('320160');
    const due = scheduler.getDueFollowUps();
    expect(due.length).toBe(1);
    expect(due[0].unit).toBe('320160');
    expect(due[0].owner).toBe('Amerit');
    expect(due[0].sourcePromise).toMatch(/confirm the ETA/);
    expect(due[0].slackRef.channelId).toBe('C1');
  });

  it('does NOT re-surface the same follow-up every cycle (marks lastSurfacedAt)', () => {
    seedDue('320160');
    const first = scheduler.surfaceDueFollowUps();
    expect(first.length).toBe(1);
    const second = scheduler.surfaceDueFollowUps(); // immediately again
    expect(second.length).toBe(0); // within resurface interval -> not re-surfaced
    // Only ONE audit entry was written, not two.
    const audits = store.load('fasAuditLog', []).filter(a => a.kind === 'followups-due');
    expect(audits.length).toBe(1);
  });

  it('does nothing when FAS is disabled and follow-up tracking is off', () => {
    store.save('fasConfig', { enabled: false, mode: 'shadow' });
    seedDue('320160');
    expect(scheduler.getDueFollowUps()).toEqual([]);
    expect(scheduler.surfaceDueFollowUps()).toEqual([]);
  });

  it('surfaces when FAS disabled but followUpTracking explicitly enabled', () => {
    store.save('fasConfig', { enabled: false, mode: 'shadow', followUpTracking: true });
    seedDue('320160');
    expect(scheduler.getDueFollowUps().length).toBe(1);
  });

  it('snooze pushes the due time out and clears it from the due list', () => {
    seedDue('320160');
    const until = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const r = scheduler.snooze(caseStore.caseIdForUnit('320160'), until);
    expect(r.ok).toBe(true);
    expect(scheduler.getDueFollowUps().length).toBe(0); // no longer due
  });

  it('complete clears the follow-up and records completion', () => {
    seedDue('320160');
    const r = scheduler.complete(caseStore.caseIdForUnit('320160'), 'called Amerit');
    expect(r.ok).toBe(true);
    expect(scheduler.getDueFollowUps().length).toBe(0);
    const c = caseStore.getCase(caseStore.caseIdForUnit('320160'));
    expect(c.completedActions.some(a => /called Amerit/.test(a.note))).toBe(true);
  });

  it('dismiss clears the follow-up without recording completion', () => {
    seedDue('320160');
    const r = scheduler.dismiss(caseStore.caseIdForUnit('320160'));
    expect(r.ok).toBe(true);
    expect(scheduler.getDueFollowUps().length).toBe(0);
    const c = caseStore.getCase(caseStore.caseIdForUnit('320160'));
    expect((c.completedActions || []).length).toBe(0);
  });
});
