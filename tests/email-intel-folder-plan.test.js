// tests/email-intel-folder-plan.test.js — R1.6, F-04, F-05: per-folder quota and rotation, row signatures,
// backlog drain rules.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fp = require('../src/email-intel/capture/folder-plan');
const C = require('../src/email-intel/constants');

describe('R1.6 per-folder quota and rotation', () => {
  it('R1.6 per-folder quota and rotation: max 25 over 3 folders gives q=8 plus 1 spill', () => {
    const p = fp.planFolderBudgets({ folders: ['Inbox', 'DOMO', 'Relay Garage'], max: 25, rotationNext: 0 });
    expect(p.order).toEqual(['Inbox', 'DOMO', 'Relay Garage']);
    expect(p.quota).toEqual({ Inbox: 8, DOMO: 8, 'Relay Garage': 8 });
    expect(p.spill).toBe(1);
    expect(p.warnings).toEqual([]);
  });

  it('the folder that went first last time goes last next time', () => {
    const folders = ['A', 'B', 'C'];
    let rot = 0; const firsts = [];
    for (let i = 0; i < 4; i++) { firsts.push(fp.planFolderBudgets({ folders, max: 12, rotationNext: rot }).order[0]); rot = fp.nextRotation(rot, folders.length); }
    expect(firsts).toEqual(['A', 'B', 'C', 'A']);
    expect(fp.planFolderBudgets({ folders, max: 12, rotationNext: 1 }).order).toEqual(['B', 'C', 'A']);
  });

  it('every folder gets at least MIN_PER_FOLDER: max is raised and a warning is raised', () => {
    const folders = Array.from({ length: 12 }, (_, i) => 'F' + i);
    const p = fp.planFolderBudgets({ folders, max: 10 });
    expect(Object.values(p.quota).every((q) => q >= C.MIN_PER_FOLDER)).toBe(true);
    expect(p.max).toBe(36);
    expect(p.warnings).toContain('too-many-folders-for-max');
    expect(Object.values(p.quota).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(p.max);
  });

  it('the total never exceeds the hard cap and a single folder takes the whole budget', () => {
    expect(fp.planFolderBudgets({ folders: ['Inbox'], max: 999 }).quota).toEqual({ Inbox: C.MAX_EMAILS_HARD });
    expect(fp.planFolderBudgets({ folders: [], max: 10 }).order).toEqual([]);
  });

  it('pass 2 spill goes round-robin to folders that still have rows, backlog folders first', () => {
    const out = fp.allocateSpill({
      order: ['A', 'B', 'C'], spill: 5, hasMore: { A: true, B: false, C: true }, checkpoints: { C: { backlog: true }, A: { backlog: false } },
    });
    expect(out).toEqual(expect.arrayContaining([{ folder: 'C', extra: 3 }, { folder: 'A', extra: 2 }]));
    expect(fp.allocateSpill({ order: ['A'], spill: 3, hasMore: {} })).toEqual([]);
    expect(fp.allocateSpill({ order: ['A'], spill: 0, hasMore: { A: true } })).toEqual([]);
  });
});

describe('F-05 rowSig ignores unread state and the time token', () => {
  it('F-05 rowSig ignores unread and time token but follows preview and message count', () => {
    const a = fp.rowSig({ convKey: 'cv_1', preview: 'Parts arrived  for 40123', msgCountToken: '' });
    expect(fp.rowSig({ convKey: 'cv_1', preview: 'parts ARRIVED for 40123', msgCountToken: '' })).toBe(a);
    expect(fp.rowSig({ convKey: 'cv_1', preview: 'Parts arrived for 40123 and more', msgCountToken: '' })).not.toBe(a);   // 120-char window still differs
    expect(fp.rowSig({ convKey: 'cv_1', preview: 'Parts arrived for 40123', msgCountToken: '3' })).not.toBe(a);
    expect(fp.rowSig({ convKey: 'cv_2', preview: 'Parts arrived for 40123', msgCountToken: '' })).not.toBe(a);
    // only the first 120 normalized chars count
    const long = 'x'.repeat(120);
    expect(fp.rowSig({ convKey: 'c', preview: long + 'AAA' })).toBe(fp.rowSig({ convKey: 'c', preview: long + 'BBB' }));
    expect(fp.parseMsgCount('Dealer Re: turbo 3 messages 18:09 preview')).toBe('3');
    expect(fp.parseMsgCount('Dealer Re: turbo 18:09')).toBe('');
  });

  it('classifyRow: known only when convKey maps to the same signature', () => {
    const ck = fp.emptyFolderCheckpoint('Inbox');
    fp.recordSeen(ck, 'cv_1', 'sigA');
    expect(fp.classifyRow(ck, 'cv_1', 'sigA')).toBe('known');
    expect(fp.classifyRow(ck, 'cv_1', 'sigB')).toBe('new');
    expect(fp.classifyRow(ck, 'cv_2', 'sigA')).toBe('new');
  });

  it('seenRows is an LRU capped at SEEN_ROWS_LRU, most recently seen kept', () => {
    const ck = fp.emptyFolderCheckpoint('Inbox');
    for (let i = 0; i < C.SEEN_ROWS_LRU + 20; i++) fp.recordSeen(ck, 'cv_' + i, 's' + i);
    expect(Object.keys(ck.seenRows)).toHaveLength(C.SEEN_ROWS_LRU);
    expect(ck.seenRows.cv_0).toBeUndefined();
    expect(ck.seenRows['cv_' + (C.SEEN_ROWS_LRU + 19)]).toBeDefined();
    fp.recordSeen(ck, 'cv_25', 'again');   // refreshing moves it to the end
    expect(Object.keys(ck.seenRows).pop()).toBe('cv_25');
  });
});

describe('F-04 backlog and stop rules', () => {
  it('a caught-up folder stops after 8 consecutive known rows; a backlog folder never does', () => {
    expect(fp.shouldStopOnKnown(7, false)).toBe(false);
    expect(fp.shouldStopOnKnown(8, false)).toBe(true);
    expect(fp.shouldStopOnKnown(50, true)).toBe(false);
  });

  it('F-04 backlog is set when the budget ran out or unseen rows remain, cleared only by reaching the end', () => {
    expect(fp.computeBacklog({ budgetExhausted: true, leftUnseen: 44 })).toBe(true);
    expect(fp.computeBacklog({ interrupted: true, reachedEnd: true })).toBe(true);
    expect(fp.computeBacklog({ prevBacklog: true, stoppedOnKnown: true })).toBe(true);        // still draining
    expect(fp.computeBacklog({ prevBacklog: false, stoppedOnKnown: true })).toBe(false);      // caught up
    expect(fp.computeBacklog({ prevBacklog: true, reachedEnd: true })).toBe(false);
    expect(fp.computeBacklog({ prevBacklog: true, reachedHorizon: true })).toBe(false);
    expect(fp.computeBacklog({ prevBacklog: true, examinedCap: true, budgetExhausted: false })).toBe(false);
    expect(fp.computeBacklog({ prevBacklog: true, examinedCap: true, budgetExhausted: true, leftUnseen: 3 })).toBe(true);
  });

  it('F-03 preview-only rows are retried and committed as preview-only only on the third failure', () => {
    const ck = fp.emptyFolderCheckpoint('Inbox');
    expect(fp.shouldCommitPreviewOnly(ck, 'cv_1')).toBe(false);
    expect(fp.recordRetry(ck, 'cv_1')).toBe(1);
    expect(fp.shouldCommitPreviewOnly(ck, 'cv_1')).toBe(false);
    expect(fp.recordRetry(ck, 'cv_1')).toBe(2);
    expect(fp.shouldCommitPreviewOnly(ck, 'cv_1')).toBe(true);
    fp.recordSeen(ck, 'cv_1', 'sig');
    expect(ck.rowRetries.cv_1).toBeUndefined();
  });
});
