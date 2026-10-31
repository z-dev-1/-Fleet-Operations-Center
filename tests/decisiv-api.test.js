// tests/decisiv-api.test.js
//
// Unit tests for the pure/offline parts of the Decisiv JSON API client
// (src/scrapers/decisiv_api.js): formatting the activity_logs JSON into the
// flat dated comment thread the enricher consumes, HTML stripping, date
// normalization, and host routing. The networked parts (warm authenticated
// window + fetch) require a live Decisiv session and are not exercised here.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const api = require('../src/scrapers/decisiv_api');

describe('decisiv_api — host routing (originFor)', () => {
  it('PRESERVES the actual host of a real URL (same-origin fetch requirement)', () => {
    expect(api.originFor('https://volvopg.asist.decisiv.net/fleet/estimates/123')).toBe('https://volvopg.asist.decisiv.net');
    // PACCAR confirmed-real host — must stay pssmfleet, not be rewritten.
    expect(api.originFor('https://pssmfleet.decisiv.net/fleet/estimates/123')).toBe('https://pssmfleet.decisiv.net');
    // PACCAR stale fallback host — preserved as-is when that's the real URL.
    expect(api.originFor('https://paccarpg.decisiv.net/fleet/estimates/123')).toBe('https://paccarpg.decisiv.net');
  });
  it('falls back to a vendor default only for a bare vendor name', () => {
    expect(api.originFor('volvo')).toBe(api.HOSTS.volvo);
    expect(api.originFor('paccar')).toBe(api.HOSTS.paccar); // pssmfleet (confirmed-real)
    expect(api.originFor('')).toBe(api.HOSTS.volvo);        // default
  });
});

describe('decisiv_api — _plain (HTML -> text)', () => {
  it('strips tags, unwraps anchors, decodes entities', () => {
    expect(api._plain('Case #<a href="https://x/y">12345</a> opened')).toBe('Case #12345 opened');
    expect(api._plain('line1<br>line2')).toBe('line1\nline2');
    expect(api._plain('a &amp; b &lt;c&gt; &#39;d&#39;')).toBe("a & b <c> 'd'");
    expect(api._plain(null)).toBe('');
  });
});

describe('decisiv_api — _noteDate', () => {
  it('normalizes ISO timestamps to "YYYY-MM-DD HH:MM"', () => {
    expect(api._noteDate({ created_at: '2026-10-15T14:30:00Z' })).toBe('2026-10-15 14:30');
  });
  it('returns empty when no date is present', () => {
    expect(api._noteDate({})).toBe('');
  });
});

describe('decisiv_api — formatActivityLogs', () => {
  // Shaped like the real captured /mobilecomm/api/estimates/{id}/activity_logs.
  const sample = {
    notes: [
      {
        id: 1, created_at: '2026-10-12T09:00:00Z',
        from: { name: 'Janita Galindo', email: 'jgalindo@tec.com', location: 'TEC of California - Fontana', job_role: 'service_advisor' },
        recipients: [{ name: '1 MCS Team', email: 'mcs-team@amazon.com' }],
        subject: 'Parts update', body: 'The part we received was damaged - waiting for a new one.',
        system_generated: false, platform_generated: false, status: 'unread',
      },
      {
        id: 2, created_at: '2026-10-13T16:45:00Z',
        from: { name: 'Z SANTIAGO', email: 'z@amazon.com', location: 'Amazon Logistics' },
        subject: '', body: 'Any updated ETC?', system_generated: false,
      },
      {
        // System note — excluded by default.
        id: 3, created_at: '2026-10-13T16:46:00Z',
        from: { name: 'System', email: '' }, subject: 'Status changed', body: 'auto',
        system_generated: true,
      },
    ],
  };

  it('flattens notes into dated who: content lines, chronological, skipping system notes', () => {
    const { text, count, newest } = api.formatActivityLogs(sample);
    expect(count).toBe(2); // system note excluded
    const lines = text.split('\n');
    expect(lines[0]).toContain('2026-10-12 09:00');
    expect(lines[0]).toContain('Janita Galindo (TEC of California - Fontana)');
    expect(lines[0]).toContain('Parts update — The part we received was damaged');
    expect(lines[1]).toContain('Z SANTIAGO (Amazon Logistics): Any updated ETC?');
    expect(newest).toContain('Any updated ETC?');
  });

  it('includes system notes when opts.includeSystem is set', () => {
    const { count } = api.formatActivityLogs(sample, { includeSystem: true });
    expect(count).toBe(3);
  });

  it('accepts a bare array as well as { notes: [...] }', () => {
    const { count } = api.formatActivityLogs(sample.notes);
    expect(count).toBe(2);
  });

  it('is empty-safe', () => {
    expect(api.formatActivityLogs(null)).toEqual({ text: '', count: 0, newest: '' });
    expect(api.formatActivityLogs({})).toEqual({ text: '', count: 0, newest: '' });
    expect(api.formatActivityLogs({ notes: [] })).toEqual({ text: '', count: 0, newest: '' });
  });
});

// ── Case status (case_repair_status_changes.json), 2026-10-28 ───────────────
// Fixtures = the real responses captured read-only from Volvo ASIST case
// 21350186 and PACCAR pssmfleet case 21467830.
const VOLVO_21350186 = [
  { milestone: 'arrival', milestone_display: 'Arrival', current: false, repair_statuses: [{ status: 'Checked-in', changed_at: '2026-10-12T14:53:48-04:00', current: false }] },
  { milestone: 'diagnosis', milestone_display: 'Diagnosis', current: false, repair_statuses: [{ status: 'Diagnosing', changed_at: '2026-10-13T07:21:10-04:00', current: false }] },
  { milestone: 'approval', milestone_display: 'Approval', current: false, repair_statuses: [{ status: 'Hold (auth)', changed_at: '2026-10-15T09:04:38-04:00', current: false }] },
  { milestone: 'repair', milestone_display: 'Repair', current: false, repair_statuses: [{ status: 'Hold (parts)', changed_at: '2026-10-15T09:45:25-04:00', current: false }] },
  { milestone: 'approval', milestone_display: 'Approval', current: false, repair_statuses: [
    { status: 'Approved', changed_at: '2026-10-15T16:19:30-04:00', current: false },
    { status: 'Hold (auth)', changed_at: '2026-10-15T20:19:00-04:00', current: false },
    { status: 'Approved', changed_at: '2026-10-16T10:00:07-04:00', current: false }] },
  { milestone: 'repair', milestone_display: 'Repair', current: true, repair_statuses: [
    { status: 'Working', changed_at: '2026-10-21T12:57:31-04:00', current: false },
    { status: 'Road Test', changed_at: '2026-10-28T18:26:37-04:00', current: true }] },
  { milestone: 'ready', milestone_display: 'Ready', current: false, repair_statuses: [] },
];

describe('decisiv_api: case status summary', () => {
  it('Volvo: current stage + detail + since, even with repeated approval/repair', () => {
    const s = api.summarizeCaseStatus(VOLVO_21350186);
    expect(s.stage).toBe('repair');
    expect(s.stageDisplay).toBe('Repair');
    expect(s.status).toBe('Road Test');
    expect(s.since).toBe('2026-10-28T18:26:37-04:00');
    expect(s.history.length).toBe(9);
    expect(s.history[0]).toEqual({ stage: 'arrival', status: 'Checked-in', at: '2026-10-12T14:53:48-04:00' });
  });
  it('PACCAR shape: Approval / Approved', () => {
    const s = api.summarizeCaseStatus([
      { milestone: 'arrival', current: false, repair_statuses: [{ status: 'Checked-in', changed_at: '2026-10-20T08:00:00-04:00' }] },
      { milestone: 'diagnosis', current: false, repair_statuses: [{ status: 'Diagnosing', changed_at: '2026-10-21T08:00:00-04:00' }] },
      { milestone: 'approval', milestone_display: 'Approval', current: true, repair_statuses: [{ status: 'Approved', changed_at: '2026-10-24T18:05:58-04:00', current: true }] },
      { milestone: 'repair', current: false, repair_statuses: [] },
      { milestone: 'ready', current: false, repair_statuses: [] },
    ]);
    expect(s).toMatchObject({ stage: 'approval', status: 'Approved', since: '2026-10-24T18:05:58-04:00' });
  });
  it('Ready when the ready segment is current', () => {
    const s = api.summarizeCaseStatus([{ milestone: 'repair', current: false, repair_statuses: [{ status: 'Working' }] },
      { milestone: 'ready', milestone_display: 'Ready', current: true, repair_statuses: [{ status: 'Asset Ready', changed_at: '2026-10-29T09:00:00-04:00', current: true }] }]);
    expect(s).toMatchObject({ stage: 'ready', status: 'Asset Ready' });
  });
  it('no current flag: falls back to the last segment that has statuses', () => {
    const s = api.summarizeCaseStatus([{ milestone: 'arrival', repair_statuses: [{ status: 'Checked-in' }] },
      { milestone: 'diagnosis', repair_statuses: [{ status: 'Diagnosing', changed_at: 'x' }] }, { milestone: 'ready', repair_statuses: [] }]);
    expect(s).toMatchObject({ stage: 'diagnosis', status: 'Diagnosing' });
  });
  it('dealer never set a status (real 21405062 / unit 322504 response) -> empty, not an error', () => {
    const resp = ['arrival', 'diagnosis', 'approval', 'repair', 'ready'].map((m) => ({ milestone: m, milestone_display: m, current: false, repair_statuses: [] }));
    expect(api.summarizeCaseStatus(resp)).toEqual({ stage: '', stageDisplay: '', status: '', since: '', history: [], empty: true });
  });
  it('unusable input -> null (caller keeps the old fallback)', () => {
    expect(api.summarizeCaseStatus(null)).toBe(null);
    expect(api.summarizeCaseStatus([])).toBe(null);
    expect(api.summarizeCaseStatus({ error: 'x' })).toBe(null);
    expect(api.summarizeCaseStatus([{ milestone: 'weird', current: true, repair_statuses: [] }])).toBe(null);
  });
  it('getCaseStatus rejects a non-numeric id before any network call', async () => {
    await expect(api.getCaseStatus('abc')).rejects.toThrow(/numeric/);
  });
});

// PACCAR paccarpg landing (2026-10-28): paccarpg.decisiv.net/fleet forwards to
// pssmfleet, but the case page itself stays on paccarpg (operator-verified), so
// the API window lands on the case page when it has one.
describe('decisiv_api: API window landing page', () => {
  const P = 'https://paccarpg.decisiv.net';
  it('lands on the case page when the case URL is on the same host', () => {
    expect(api._landingUrl(P, 'https://paccarpg.decisiv.net/fleet/estimates/21467830')).toBe(P + '/fleet/estimates/21467830');
    expect(api._landingUrl(P, 'https://paccarpg.decisiv.net/fleet/estimates/21467830?tab=notes#x')).toBe(P + '/fleet/estimates/21467830');
  });
  it('falls back to /fleet for no URL, another host, or a non-case page', () => {
    expect(api._landingUrl(P, '')).toBe(P + '/fleet');
    expect(api._landingUrl(P, 'https://pssmfleet.decisiv.net/fleet/estimates/1')).toBe(P + '/fleet');
    expect(api._landingUrl(P, 'https://paccarpg.decisiv.net/service_requests/9')).toBe(P + '/fleet');
  });
  it('builds the case page from the id when the caller gave no usable URL', () => {
    expect(api._caseUrl(P, '21467830', {})).toBe(P + '/fleet/estimates/21467830');
    expect(api._caseUrl(P, '21467830', { srUrl: P + '/fleet/estimates/21467830' })).toBe(P + '/fleet/estimates/21467830');
    expect(api._landingUrl(P, api._caseUrl(P, '21467830', {}))).toBe(P + '/fleet/estimates/21467830');
  });
});
