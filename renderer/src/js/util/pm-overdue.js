// Days-overdue for a PM/DOT item, read from the raw per-label due field that
// already rides on the row (pmBDue / pmXDue / dotDue / quarterlyLiftDue).
// The short pill value (row.pmB etc.) collapses every past date to 'overdue',
// so the count has to come from the raw field. Display-only: nothing here
// feeds back into data or sorting.
//
// Recognized raw forms (see src/scrapers/relay.js _formatPmDate):
//   "Overdue 4 days" / "Overdue 1 day"  -> 4 / 1
//   "Sep 11, 2026" (in the past)         -> calendar days since that date
// Anything else ("Overdue 5 months", month-only "Feb 2027", future dates,
// blanks) returns null so the caller keeps the plain "overdue" text.
export const PM_RAW_KEY = { pmB: 'pmBDue', pmX: 'pmXDue', dot: 'dotDue', quarterlyLift: 'quarterlyLiftDue' };

export function pmOverdueDays(raw) {
  if (raw == null) return null;
  const t = String(raw).trim();
  let m = t.match(/^overdue\s+(\d+)\s+days?$/i);
  if (m) { const n = parseInt(m[1], 10); return n > 0 ? n : null; }
  m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (!m) return null;
  const d = new Date(m[1] + ' ' + m[2] + ', ' + m[3]);
  if (isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const n = Math.round((today - d) / 86400000);
  return n > 0 ? n : null;
}
