// FEAT-A1 / AC-7: defensive mappers, occurrence-level keys, join URL rules, transcript URL rule, recording-info whitelist.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const M = require('../src/zoom/data/mappers');
const V = require('../src/zoom/validate');

const env = (list, k = 'list') => ({ status: true, result: { [k]: list } });
const decode = (k) => Buffer.from(k.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

describe('mapMeetings', () => {
  it('maps common field candidates and never returns a URL in items', () => {
    const r = M.mapMeetings(env([
      { meetingId: '912345678', topic: 'Ops sync', startTime: '2026-11-10T15:00:00Z', duration: 30, timezone: 'America/New_York', joinUrl: 'https://amazon.zoom.us/j/912345678?pwd=abc' },
      { meeting_id: '987654321', subject: 'Carrier review', start_time: 1762786800, durationMinutes: '45', recurring: true },
    ]), 'upcoming');
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ topic: 'Ops sync', startIso: '2026-11-10T15:00:00.000Z', durationMin: 30, timezone: 'America/New_York', hasJoin: true, joinNeedsPasscode: false, kind: 'upcoming', recurring: null });
    expect(r.items[1]).toMatchObject({ topic: 'Carrier review', durationMin: 45, recurring: true, hasJoin: true, joinNeedsPasscode: true });
    expect(r.items[1].startIso).toBe(new Date(1762786800 * 1000).toISOString());
    expect(JSON.stringify(r.items)).not.toMatch(/https?:/);
    expect(r.joins.map(([, u]) => u)).toEqual(['https://amazon.zoom.us/j/912345678?pwd=abc', 'https://amazon.zoom.us/j/987654321']);
    for (const it of r.items) {
      expect(() => V.key(it.key)).not.toThrow();
      expect(it.idHash).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('truncates topics to 200 chars and searches every container path', () => {
    for (const k of ['list', 'meetings', 'data', 'items', 'recordings']) {
      const r = M.mapMeetings(env([{ id: 'a1', topic: 'x'.repeat(300), startTime: '2026-11-10T15:00:00Z' }], k), 'previous');
      expect(r.ok).toBe(true);
      expect(r.items[0].topic.length).toBe(200);
      expect(r.items[0].kind).toBe('previous');
    }
  });

  it('SHAPE_UNRECOGNIZED when no array is found, with a key-names-only shape', () => {
    const r = M.mapMeetings({ status: true, result: { weird: { topic: 'SECRET' } } }, 'upcoming');
    expect(r).toMatchObject({ ok: false, code: 'SHAPE_UNRECOGNIZED' });
    expect(JSON.stringify(r.shape)).not.toContain('SECRET');
    expect(r.shape).toEqual({ status: 'boolean', result: { weird: 'object' } });
  });

  it('SHAPE_UNRECOGNIZED when fewer than half the items yield id + start', () => {
    const r = M.mapMeetings(env([{ id: 'a', startTime: '2026-11-10T15:00:00Z' }, { id: 'b' }, { foo: 1 }]), 'upcoming');
    expect(r.code).toBe('SHAPE_UNRECOGNIZED');
    const ok = M.mapMeetings(env([{ id: 'a', startTime: '2026-11-10T15:00:00Z' }, { id: 'b' }]), 'upcoming');
    expect(ok.ok).toBe(true);
    expect(ok.items[1].startIso).toBe(null);
  });

  it('an empty list is a valid empty result', () => {
    expect(M.mapMeetings(env([]), 'upcoming')).toMatchObject({ ok: true, items: [] });
  });
});

describe('occurrence keys (review F-9)', () => {
  it('recurring meeting: two occurrences -> two keys; same item twice -> same key', () => {
    const a = { meetingNumber: '912345678', startTime: '2026-11-10T15:00:00Z' };
    const b = { meetingNumber: '912345678', startTime: '2026-11-17T15:00:00Z' };
    const r1 = M.mapMeetings(env([a, b]), 'upcoming');
    expect(r1.items[0].key).not.toBe(r1.items[1].key);
    const r2 = M.mapMeetings(env([a]), 'upcoming');
    expect(r2.items[0].key).toBe(r1.items[0].key);
    expect(decode(r1.items[0].key)).toBe('m:912345678:2026-11-10T15:00:00.000Z');
  });

  it('uuid alone identifies an occurrence', () => {
    const r = M.mapMeetings(env([{ uuid: 'abc/DEF+==', meetingNumber: '912345678', startTime: '2026-11-10T15:00:00Z' }]), 'upcoming');
    expect(decode(r.items[0].key)).toBe('m:abc/DEF+==');
    expect(r.items[0].key).not.toMatch(/[=+/]/);
  });

  it('recording keys use the r: prefix and snake_case candidates', () => {
    const r = M.mapRecordings(env([{ meeting_uuid: 'U1', start_time: '2026-11-01T10:00:00Z' }, { recording_id: 'R2', startTime: '2026-11-02T10:00:00Z' }]));
    expect(decode(r.items[0].key)).toBe('r:U1');
    expect(decode(r.items[1].key)).toBe('r:R2:2026-11-02T10:00:00.000Z');
  });

  it("keys over 128 chars become 'h_' + sha256 hex slice 40", () => {
    const longId = 'z'.repeat(150);
    const r = M.mapMeetings(env([{ uuid: longId, startTime: '2026-11-10T15:00:00Z' }]), 'upcoming');
    const want = 'h_' + crypto.createHash('sha256').update('m:' + longId).digest('hex').slice(0, 40);
    expect(r.items[0].key).toBe(want);
    expect(() => V.key(r.items[0].key)).not.toThrow();
  });

  it('items without any id candidate are dropped', () => {
    const r = M.mapMeetings(env([{ id: 'a', startTime: '2026-11-10T15:00:00Z' }, { topic: 'no id', startTime: '2026-11-10T15:00:00Z' }]), 'upcoming');
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(1);
  });
});

describe('buildJoinUrl', () => {
  it('accepts https + Zoom host + /j/ or /w/ only', () => {
    expect(M.buildJoinUrl({ joinUrl: 'https://amazon.zoom.us/j/1?pwd=x' })).toEqual({ url: 'https://amazon.zoom.us/j/1?pwd=x', joinNeedsPasscode: false });
    expect(M.buildJoinUrl({ join_url: 'https://us02web.zoom.us/w/5' }).joinNeedsPasscode).toBe(false);
    expect(M.buildJoinUrl({ joinLink: 'http://amazon.zoom.us/j/1' })).toBe(null);
    expect(M.buildJoinUrl({ joinUrl: 'https://evil.test/j/1' })).toBe(null);
    expect(M.buildJoinUrl({ joinUrl: 'https://amazon.zoom.us/meeting/1' })).toBe(null);
    expect(M.buildJoinUrl({ joinUrl: 'https://zoom.us.evil.test/j/1' })).toBe(null);
  });
  it('falls back to the meeting number (9-12 digits) with joinNeedsPasscode', () => {
    expect(M.buildJoinUrl({ joinUrl: 'https://evil.test/j/1', meetingNumber: '912 345 6789' })).toEqual({ url: 'https://amazon.zoom.us/j/9123456789', joinNeedsPasscode: true });
    expect(M.buildJoinUrl({ meetingNumber: '12345' })).toBe(null);
    expect(M.buildJoinUrl({ meetingNumber: '1234567890123' })).toBe(null);
    expect(M.buildJoinUrl({})).toBe(null);
  });
});

describe('mapRecordings', () => {
  it('transcript detection + https / Zoom host URL rule; offsite -> hasTranscript:false', () => {
    const r = M.mapRecordings(env([
      { uuid: 'A', topic: 't1', startTime: '2026-11-01T10:00:00Z', recordingFiles: [{ fileType: 'MP4', downloadUrl: 'https://amazon.zoom.us/rec/a.mp4' }, { fileType: 'TRANSCRIPT', downloadUrl: 'https://amazon.zoom.us/rec/download/a.vtt' }] },
      { uuid: 'B', startTime: '2026-11-02T10:00:00Z', files: [{ file_type: 'CC', download_url: 'https://evil.test/b.vtt' }] },
      { uuid: 'C', startTime: '2026-11-03T10:00:00Z', recording_files: [{ fileType: 'MP4' }] },
      { uuid: 'D', startTime: '2026-11-04T10:00:00Z' },
      { uuid: 'E', startTime: '2026-11-05T10:00:00Z', files: [{ name: 'Audio Transcript.vtt', fileUrl: 'http://amazon.zoom.us/e.vtt' }] },
    ], 'recordings'));
    expect(r.ok).toBe(true);
    expect(r.items.map((i) => i.hasTranscript)).toEqual([true, false, false, null, false]);
    expect(r.items.map((i) => i.fileCount)).toEqual([2, 1, 1, null, 1]);
    expect(r.refs).toEqual([[r.items[0].key, 'https://amazon.zoom.us/rec/download/a.vtt']]);
    expect(r.items.every((i) => i.transcriptRef === null)).toBe(true);
    expect(JSON.stringify(r.items)).not.toMatch(/https?:/);
  });
  it('SHAPE_UNRECOGNIZED on an unknown container', () => {
    expect(M.mapRecordings({ status: true, result: { foo: 1 } }).code).toBe('SHAPE_UNRECOGNIZED');
  });
});

describe('mapRecordingInfo whitelist', () => {
  it('keeps only whitelisted booleans, numbers and short strings', () => {
    const out = M.mapRecordingInfo({
      isShowTranscriptTab: true, enableTranscriptHub: false, enableCloudRecording: 'yes', canPlayDownloadRecording: true,
      canDeleteMeetingTranscript: false, locRecCount: 3, autoDeleteDays: 'x', dateFrom: '2026-10-01', dateTo: '2026-11-01T00:00:00Z',
      email: 'someone@example.com', userId: 'u1',
    });
    expect(out).toEqual({ isShowTranscriptTab: true, enableTranscriptHub: false, canPlayDownloadRecording: true, canDeleteMeetingTranscript: false, locRecCount: 3, dateFrom: '2026-10-01' });
    expect(M.mapRecordingInfo(null)).toEqual({});
  });
});
