// tests/timeline-manual-entries.test.js
// Regression test for the "manual timeline entries lost on rescan" bug fixed
// across src/ipc/notes.js, src/ipc/ai.js, src/orcha/deep-scan.js, and src/app.js
// (offline queue flush). Exercises the REAL _mergeManualEntries() logic that
// deep-scan.js uses to reconcile an AI-regenerated timeline against previously
// saved manual entries -- this is the core invariant: a manual entry must
// survive an arbitrary number of AI regenerations, verbatim, never reworded,
// never dropped, unless the regenerated text already contains it.

import { describe, it, expect } from 'vitest';
import { _mergeManualEntries } from '../src/orcha/deep-scan.js';

describe('_mergeManualEntries (timeline manual-entry preservation)', () => {
  it('keeps a manual entry that has no counterpart in the new AI timeline', () => {
    const aiTimeline = '07/10 - Estimate approved.\n07/11 - Parts on order.';
    const manualEntries = ['07/13 - Phone call: driver confirms unit still in bay.'];
    const result = _mergeManualEntries(aiTimeline, manualEntries);
    expect(result).toContain('07/10 - Estimate approved.');
    expect(result).toContain('07/11 - Parts on order.');
    expect(result).toContain('07/13 - Phone call: driver confirms unit still in bay.');
  });

  it('does not duplicate a manual entry whose text already appears in the AI timeline', () => {
    const aiTimeline = '07/10 - Estimate approved.\n07/13 - Phone call: driver confirms unit still in bay.';
    const manualEntries = ['07/13 - Phone call: driver confirms unit still in bay.'];
    const result = _mergeManualEntries(aiTimeline, manualEntries);
    const occurrences = result.split('driver confirms unit still in bay').length - 1;
    expect(occurrences).toBe(1);
  });

  it('preserves manual entries across multiple simulated rescans (no cumulative loss)', () => {
    // Simulates the real production sequence: user adds a manual note, then
    // deep-scan runs (regenerating from raw vendor comments only, with zero
    // knowledge of the manual note) multiple times in a row.
    let manualEntries = [];
    let currentTimeline = '07/10 - WO created.';

    // User manually adds an entry (what notes:add-timeline / ai:append-timeline do)
    const manualLine = '07/13 - Manual: driver called, unit not actually in bay yet.';
    currentTimeline = currentTimeline + '\n' + manualLine;
    manualEntries.push(manualLine);

    // Rescan #1: AI regenerates from raw comments only, has no idea about the manual line
    let aiRegenerated = '07/10 - WO created.\n07/11 - Estimate approved.';
    currentTimeline = _mergeManualEntries(aiRegenerated, manualEntries);
    expect(currentTimeline).toContain(manualLine);

    // Rescan #2: AI regenerates again (e.g. new vendor comment appeared), still no idea about manual line
    aiRegenerated = '07/10 - WO created.\n07/11 - Estimate approved.\n07/12 - Parts ordered.';
    currentTimeline = _mergeManualEntries(aiRegenerated, manualEntries);
    expect(currentTimeline).toContain(manualLine);
    // Must not duplicate across rescans
    expect(currentTimeline.split(manualLine).length - 1).toBe(1);

    // Rescan #3
    aiRegenerated = '07/10 - WO created.\n07/11 - Estimate approved.\n07/12 - Parts ordered.\n07/14 - Repair complete.';
    currentTimeline = _mergeManualEntries(aiRegenerated, manualEntries);
    expect(currentTimeline).toContain(manualLine);
    expect(currentTimeline.split(manualLine).length - 1).toBe(1);
  });

  it('handles multiple distinct manual entries independently', () => {
    const aiTimeline = '07/10 - WO created.';
    const manualEntries = [
      '07/11 - Manual: parts confirmed on hand by phone.',
      '07/12 - Manual: driver reports unit moved to different bay.',
    ];
    const result = _mergeManualEntries(aiTimeline, manualEntries);
    expect(result).toContain('parts confirmed on hand by phone');
    expect(result).toContain('driver reports unit moved to different bay');
  });

  it('returns the AI timeline unchanged when there are no manual entries', () => {
    const aiTimeline = '07/10 - WO created.\n07/11 - Estimate approved.';
    expect(_mergeManualEntries(aiTimeline, [])).toBe(aiTimeline);
    expect(_mergeManualEntries(aiTimeline, undefined)).toBe(aiTimeline);
    expect(_mergeManualEntries(aiTimeline, null)).toBe(aiTimeline);
  });

  it('handles an empty/blank AI timeline gracefully (manual entries become the whole timeline)', () => {
    const manualEntries = ['07/13 - Manual: only entry so far.'];
    const result = _mergeManualEntries('', manualEntries);
    expect(result).toContain('07/13 - Manual: only entry so far.');
  });

  it('is not fooled by partial/substring false negatives (date prefix stripped before comparison)', () => {
    // A manual entry re-dated by a later edit should still match on its text body
    // even if the AI timeline happens to log the same underlying fact on a
    // different date -- this documents current behavior (text-body match only,
    // date-agnostic) so a future change to this rule is a conscious decision.
    const aiTimeline = '07/14 - Driver confirms unit still in bay.';
    const manualEntries = ['07/13 - Driver confirms unit still in bay.'];
    const result = _mergeManualEntries(aiTimeline, manualEntries);
    // Text body matches regardless of date prefix -> should NOT duplicate
    expect(result.split('Driver confirms unit still in bay').length - 1).toBe(1);
  });
});
