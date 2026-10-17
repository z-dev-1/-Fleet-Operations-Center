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
  it('routes volvo and paccar URLs/vendors to the right origin', () => {
    expect(api.originFor('https://volvopg.asist.decisiv.net/fleet/estimates/123')).toBe(api.HOSTS.volvo);
    expect(api.originFor('https://paccarpg.decisiv.net/fleet/estimates/123')).toBe(api.HOSTS.paccar);
    expect(api.originFor('volvo')).toBe(api.HOSTS.volvo);
    expect(api.originFor('paccar')).toBe(api.HOSTS.paccar);
    expect(api.originFor('')).toBe(api.HOSTS.volvo); // default
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
