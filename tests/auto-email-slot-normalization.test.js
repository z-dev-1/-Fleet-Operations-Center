// tests/auto-email-slot-normalization.test.js
//
// Regression coverage for the 2026-07-16 "morning email sent as EOS instead
// of SOS" bug fix (renderer/src/js/views/email-composer.js).
//
// Root cause: src/app.js's scheduler passes slot.label to the
// fleet:auto-email event, which is a raw "HH:MM" time string (e.g. "08:00",
// "15:15") -- see settings:save-schedule-slots in src/ipc/settings.js:
// `label = String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0')`.
// But _buildSubject() and emailBuilder.js's slot-dependent logic
// (slotDisplayLabel, slot colors/icons) all do strict equality checks
// against the literal string 'AM'. Since "08:00" is truthy but !== 'AM',
// EVERY auto-send (both the AM and PM scheduled slots) fell through to the
// PM/"EOS REPORT" branch, every single time -- the AM slot was never once
// able to render as "SOS REPORT". The manual Compose Email view was
// unaffected because its AM/PM toggle (_currentSlotValue()) already
// produces the literal strings "AM"/"PM" directly.
//
// Following the existing project convention (see tests/validation.test.js,
// tests/sync-interval.test.js), this mirrors the isolated
// _normalizeSlotToAmPm() logic rather than importing the real renderer
// module (which depends on browser globals / IPC bridges not available
// under Vitest's node environment).

import { describe, it, expect } from 'vitest';

// Mirrors _normalizeSlotToAmPm() in renderer/src/js/views/email-composer.js
function normalizeSlotToAmPm(slot) {
  if (slot === 'AM' || slot === 'PM') return slot;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(slot || '').trim());
  if (m) return parseInt(m[1], 10) < 12 ? 'AM' : 'PM';
  return 'PM';
}

describe('_normalizeSlotToAmPm() — auto-email SOS/EOS fix', () => {
  it('passes through literal "AM" unchanged (manual compose path)', () => {
    expect(normalizeSlotToAmPm('AM')).toBe('AM');
  });

  it('passes through literal "PM" unchanged (manual compose path)', () => {
    expect(normalizeSlotToAmPm('PM')).toBe('PM');
  });

  it('converts the default 08:00 scheduler slot to AM (the exact bug scenario)', () => {
    expect(normalizeSlotToAmPm('08:00')).toBe('AM');
  });

  it('converts the default 15:15 scheduler slot to PM', () => {
    expect(normalizeSlotToAmPm('15:15')).toBe('PM');
  });

  it('treats 11:59 as AM and 12:00 as PM (noon boundary)', () => {
    expect(normalizeSlotToAmPm('11:59')).toBe('AM');
    expect(normalizeSlotToAmPm('12:00')).toBe('PM');
  });

  it('handles single-digit hour time strings (e.g. "8:00")', () => {
    expect(normalizeSlotToAmPm('8:00')).toBe('AM');
  });

  it('handles any custom user-configured AM slot correctly', () => {
    expect(normalizeSlotToAmPm('06:30')).toBe('AM');
    expect(normalizeSlotToAmPm('09:45')).toBe('AM');
  });

  it('handles any custom user-configured PM slot correctly', () => {
    expect(normalizeSlotToAmPm('16:00')).toBe('PM');
    expect(normalizeSlotToAmPm('23:59')).toBe('PM');
  });

  it('falls back to PM for missing/empty input (matches pre-existing fallback)', () => {
    expect(normalizeSlotToAmPm('')).toBe('PM');
    expect(normalizeSlotToAmPm(undefined)).toBe('PM');
    expect(normalizeSlotToAmPm(null)).toBe('PM');
  });

  it('falls back to PM for unparseable garbage input', () => {
    expect(normalizeSlotToAmPm('not-a-time')).toBe('PM');
  });
});
