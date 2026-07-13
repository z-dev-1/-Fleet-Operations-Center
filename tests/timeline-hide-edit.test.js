// tests/timeline-hide-edit.test.js
// Regression test for the "hide / edit a timeline entry without it being
// overridden and added back" feature (src/orcha/deep-scan.js's
// _filterHiddenEntries + src/ipc/notes.js's notes:hide-timeline-entry /
// notes:edit-timeline-entry).
//
// This is the direct counterpart to tests/timeline-manual-entries.test.js:
// that file proves a manual entry ALWAYS survives AI regeneration; this file
// proves a hidden/edited entry NEVER resurfaces after AI regeneration. Both
// guarantees are required for the timeline to be trustworthy -- a rescan
// must neither silently drop what the user added nor silently reintroduce
// what the user removed or reworded.

import { describe, it, expect } from 'vitest';
import { _mergeManualEntries, _filterHiddenEntries, _timelineEntrySignature } from '../src/orcha/deep-scan.js';

describe('_filterHiddenEntries (permanent suppression of a hidden line)', () => {
  it('removes a line whose text-body signature matches a hidden entry, date-agnostic', () => {
    const timeline = '07/10 - Estimate approved.\n07/11 - Parts on order.';
    const result = _filterHiddenEntries(timeline, ['07/10 - Estimate approved.']);
    expect(result).not.toContain('Estimate approved');
    expect(result).toContain('Parts on order');
  });

  it('matches on text body only, ignoring the date prefix (same normalization as manual-entry dedupe)', () => {
    const timeline = '07/14 - Driver confirms unit still in bay.';
    // Hidden using a DIFFERENT date than what's in the fresh AI timeline --
    // must still suppress it, otherwise re-dated AI regenerations could dodge a hide.
    const result = _filterHiddenEntries(timeline, ['07/10 - Driver confirms unit still in bay.']);
    expect(result).toBe('');
  });

  it('is case-insensitive when matching signatures', () => {
    const timeline = '07/10 - ESTIMATE APPROVED.';
    const result = _filterHiddenEntries(timeline, ['07/10 - estimate approved.']);
    expect(result).toBe('');
  });

  it('leaves the timeline unchanged when there are no hidden entries', () => {
    const timeline = '07/10 - WO created.\n07/11 - Estimate approved.';
    expect(_filterHiddenEntries(timeline, [])).toBe(timeline);
    expect(_filterHiddenEntries(timeline, undefined)).toBe(timeline);
    expect(_filterHiddenEntries(timeline, null)).toBe(timeline);
  });

  it('handles hiding every line down to an empty timeline without throwing', () => {
    const timeline = '07/10 - Only line.';
    expect(_filterHiddenEntries(timeline, ['07/10 - Only line.'])).toBe('');
  });

  it('handles a blank/empty timeline gracefully', () => {
    expect(_filterHiddenEntries('', ['07/10 - Anything.'])).toBe('');
    expect(_filterHiddenEntries(null, ['07/10 - Anything.'])).toBe(null);
  });

  it('suppresses only the matching line, preserving order of the rest', () => {
    const timeline = '07/10 - A.\n07/11 - B.\n07/12 - C.';
    const result = _filterHiddenEntries(timeline, ['07/11 - B.']);
    expect(result).toBe('07/10 - A.\n07/12 - C.');
  });
});

describe('Hide guarantee across simulated rescans (the actual user-facing contract)', () => {
  it('a hidden AI-generated line never resurfaces even if later rescans regenerate the same underlying vendor comment', () => {
    // Simulates: user hides an AI-generated line. Every subsequent deep-scan
    // regenerates aiTimeline fresh from raw vendor comments -- with zero
    // awareness that the line was hidden -- so the AI keeps producing it
    // verbatim. hiddenEntries[] is what breaks that loop.
    const hiddenEntries = ['07/10 - Estimate approved.'];

    let aiRegenerated = '07/10 - Estimate approved.\n07/11 - Parts on order.';
    let result = _filterHiddenEntries(_mergeManualEntries(aiRegenerated, []), hiddenEntries);
    expect(result).not.toContain('Estimate approved');

    // Rescan #2 -- AI still regenerates the same line (it has no memory of the hide)
    aiRegenerated = '07/10 - Estimate approved.\n07/11 - Parts on order.\n07/12 - Repair started.';
    result = _filterHiddenEntries(_mergeManualEntries(aiRegenerated, []), hiddenEntries);
    expect(result).not.toContain('Estimate approved');
    expect(result).toContain('Parts on order');
    expect(result).toContain('Repair started');

    // Rescan #3
    aiRegenerated = '07/10 - Estimate approved.\n07/11 - Parts on order.\n07/12 - Repair started.\n07/13 - Repair complete.';
    result = _filterHiddenEntries(_mergeManualEntries(aiRegenerated, []), hiddenEntries);
    expect(result).not.toContain('Estimate approved');
    expect(result).toContain('Repair complete');
  });

  it('hide + merge interact correctly: a hidden entry is suppressed even if it was also a manual entry', () => {
    // Covers notes:hide-timeline-entry's real behavior: it strips the entry from
    // manualEntries[] AND records it in hiddenEntries[] -- belt and suspenders.
    // This test proves the suspenders alone (hiddenEntries filtering applied
    // AFTER the merge) are sufficient even if a stale manualEntries[] entry
    // somehow survived the removal step.
    const aiTimeline = '07/10 - WO created.';
    const staleManualEntries = ['07/13 - Manual: driver called, unit not actually in bay yet.'];
    const hiddenEntries = ['07/13 - Manual: driver called, unit not actually in bay yet.'];

    const merged = _mergeManualEntries(aiTimeline, staleManualEntries);
    expect(merged).toContain('driver called'); // merge alone would keep it

    const final = _filterHiddenEntries(merged, hiddenEntries);
    expect(final).not.toContain('driver called'); // hide-filter removes it regardless
    expect(final).toContain('WO created');
  });
});

describe('Edit guarantee (old wording hidden forever, new wording persists forever)', () => {
  it('simulates the edit contract: old text is hidden, new text becomes a manual entry, both survive multiple rescans', () => {
    // This mirrors exactly what src/ipc/notes.js's notes:edit-timeline-entry
    // handler does: push oldEntryText into hiddenEntries[], push newLine into
    // manualEntries[]. We simulate that state transition here and prove the
    // combined effect (_mergeManualEntries then _filterHiddenEntries, the same
    // order deep-scan.js applies them in) holds across repeated regenerations.
    const oldText = '07/10 - Estimate approved.';
    const newText = '07/10 - Estimate approved pending parts confirmation.';
    const hiddenEntries = [oldText];
    const manualEntries = [newText];

    let aiRegenerated = '07/10 - Estimate approved.\n07/11 - Parts on order.';
    let result = _filterHiddenEntries(_mergeManualEntries(aiRegenerated, manualEntries), hiddenEntries);
    expect(result).not.toContain('Estimate approved.\n'); // old exact wording gone (note: newline anchor avoids matching the edited line as substring)
    expect(result).toContain('Estimate approved pending parts confirmation.');
    expect(result).toContain('Parts on order');

    // Rescan #2 -- AI still regenerates the OLD wording verbatim (no memory of edit)
    aiRegenerated = '07/10 - Estimate approved.\n07/11 - Parts on order.\n07/12 - Repair started.';
    result = _filterHiddenEntries(_mergeManualEntries(aiRegenerated, manualEntries), hiddenEntries);
    expect(result).not.toContain('Estimate approved.\n');
    expect(result).toContain('Estimate approved pending parts confirmation.');
    // New wording must not duplicate across rescans
    expect(result.split('Estimate approved pending parts confirmation.').length - 1).toBe(1);

    // Rescan #3
    aiRegenerated = '07/10 - Estimate approved.\n07/11 - Parts on order.\n07/12 - Repair started.\n07/13 - Repair complete.';
    result = _filterHiddenEntries(_mergeManualEntries(aiRegenerated, manualEntries), hiddenEntries);
    expect(result).toContain('Estimate approved pending parts confirmation.');
    expect(result).toContain('Repair complete');
    expect(result.split('Estimate approved pending parts confirmation.').length - 1).toBe(1);
  });
});

describe('_timelineEntrySignature (normalization used by both the merge and hide paths)', () => {
  it('strips a MM/DD date prefix and lowercases', () => {
    expect(_timelineEntrySignature('07/10 - Estimate Approved.')).toBe('estimate approved.');
    expect(_timelineEntrySignature('07/10 \u2013 Estimate Approved.')).toBe('estimate approved.'); // en-dash variant
  });

  it('handles a line with no date prefix', () => {
    expect(_timelineEntrySignature('Estimate Approved.')).toBe('estimate approved.');
  });

  it('handles empty/null/undefined input without throwing', () => {
    expect(_timelineEntrySignature('')).toBe('');
    expect(_timelineEntrySignature(null)).toBe('');
    expect(_timelineEntrySignature(undefined)).toBe('');
  });
});
