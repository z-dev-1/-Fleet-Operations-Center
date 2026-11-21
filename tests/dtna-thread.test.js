// DTNA Phase A step 1: comments -> DTNA_LINE_RE text (thread.js) is read unchanged by the existing parsers.
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { COMMENTS, NO_RO_COMMENTS } from './fixtures/dtna/aura-responses.js';

const require = createRequire(import.meta.url);
const T = require('../src/dtna/thread.js');
const C = require('../src/dtna/constants.js');
const { parseDtnaFeedLines, extractDtnaFeed } = require('../src/repair-intel/wo-extract.js');
const { offsiteNewestFirst } = require('../src/utils/offsite-notes-order.js');

const NOW = Date.parse('2026-09-25T12:00:00.000Z');

describe('fmtDtnaDate', () => {
  it('formats local time with full month, 12-hour clock and padded minutes', () => {
    expect(T.fmtDtnaDate('2026-09-24T10:56:00.000Z')).toBe('September 24, 2026 at 6:56 AM');
    expect(T.fmtDtnaDate('2026-09-24T16:05:00.000Z')).toBe('September 24, 2026 at 12:05 PM');
    expect(T.fmtDtnaDate('2026-01-05T05:00:00.000Z')).toBe('January 5, 2026 at 12:00 AM');
    expect(T.fmtDtnaDate('not a date')).toBe('');
    expect(T.fmtDtnaDate(null)).toBe('');
  });
});

describe('stripHtml', () => {
  it('turns block tags into spaces, strips tags, decodes entities, collapses whitespace', () => {
    expect(T.stripHtml('<p>Estimate sent &amp; pending</p><br>Total&nbsp;<b>parts</b>\n\nlisted')).toBe('Estimate sent & pending Total parts listed');
    expect(T.stripHtml(null)).toBe('');
  });
});

describe('commentsToThread', () => {
  const out = T.commentsToThread(COMMENTS);

  it('one line per comment, newest first, in DTNA_LINE_RE format', () => {
    const lines = out.thread.split('\n');
    expect(out.count).toBe(3);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('September 24, 2026 at 8:30 AM — AFP FAS: [General] Please send an ETA for unit 122269');
    expect(lines[1]).toBe('September 24, 2026 at 6:56 AM — HORWITH FREIGHTLINER: [Estimate] Estimate sent & pending approval Total parts listed');
    expect(lines[2].startsWith('September 22, 2026 at 9:05 AM — API User: [Status Update] Serial No: NP6923')).toBe(true);
  });

  it('parseDtnaFeedLines returns one entry per comment with the right sides', () => {
    const e = parseDtnaFeedLines(out.thread);
    expect(e).toHaveLength(out.count);
    expect(e.map((x) => x.actor)).toEqual(['AFP FAS', 'HORWITH FREIGHTLINER', 'API User']);
    expect(e.map((x) => x.side)).toEqual(['amazon', 'dealer', 'system']);
    expect(e[0].at).toBe('2026-09-24T12:30:00.000Z');
  });

  it('offsiteNewestFirst(thread) === thread', () => {
    expect(offsiteNewestFirst(out.thread)).toBe(out.thread);
    // Input order does not matter.
    const rev = T.commentsToThread(COMMENTS.slice().reverse());
    expect(rev.thread).toBe(out.thread);
  });

  it('extractDtnaFeed yields one event per comment', () => {
    const block = extractDtnaFeed(out.thread, { now: NOW });
    expect(block.events.length).toBe(out.count);
  });

  it('a FromName containing ":" and newlines still parses as one entry', () => {
    const t = T.commentsToThread([{ CommentType: 'General', CommentText: 'Note: call back', FromName: 'Dealer: Shop\n2', CreatedDate: '2026-09-24T12:00:00.000Z' }]);
    const e = parseDtnaFeedLines(t.thread);
    expect(e).toHaveLength(1);
    expect(e[0].actor).toBe('Dealer Shop 2');
    expect(e[0].text).toBe('[General] Note: call back');
  });

  it('defaults the actor to DTNA, falls back to LastUpdatedDate, skips empty and undated comments', () => {
    const t = T.commentsToThread([
      { CommentText: 'from nobody', LastUpdatedDate: '2026-09-24T12:00:00.000Z' },
      { CommentText: '', CommentType: '', CreatedDate: '2026-09-24T13:00:00.000Z' },
      { CommentText: 'no date' },
      null,
    ]);
    expect(t.count).toBe(1);
    expect(t.thread).toBe('September 24, 2026 at 8:00 AM — DTNA: from nobody');
  });

  it('caps each comment at COMMENT_MAX and the thread / offsiteText at a line boundary', () => {
    const many = [];
    for (let i = 0; i < 40; i++) {
      many.push({ CommentType: 'General', FromName: 'AFP FAS', CommentText: 'x'.repeat(3000), CreatedDate: new Date(NOW - i * 60e3).toISOString() });
    }
    const t = T.commentsToThread(many);
    const lines = t.thread.split('\n');
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(C.COMMENT_MAX + 80);
    expect(t.thread.length).toBeLessThanOrEqual(C.THREAD_MAX);
    expect(t.offsiteText.length).toBeLessThanOrEqual(C.OFFSITE_TEXT_MAX);
    expect(t.count).toBe(lines.length);
    expect(parseDtnaFeedLines(t.thread)).toHaveLength(t.count);
    expect(t.thread.startsWith(t.offsiteText)).toBe(true);
    expect(parseDtnaFeedLines(t.offsiteText).every((e) => e.text.length === '[General] '.length + C.COMMENT_MAX)).toBe(true);
  });
});

describe('stageFromCase', () => {
  const steps = [
    { name: 'Arrived', status: 'Complete', at: '2026-09-22T13:00:00.000Z' },
    { name: 'In Repair', status: 'Current', at: '2026-09-23T14:00:00.000Z' },
    { name: 'Ready', status: '', at: '' },
  ];
  const cases = [
    [{ caseStatus: 'Closed' }, 'ready'],
    [{ caseStatus: 'Repair Complete' }, 'ready'],
    [{ caseStatus: 'Ready for Pickup' }, 'ready'],
    [{ caseStatus: 'In-Repair' }, 'repair'],
    [{ caseStatus: 'Post Repair' }, 'repair'],
    [{ caseStatus: 'Arrived' }, 'arrival'],
    [{ caseStatus: 'Open', comments: [{ type: 'General', at: '2026-09-20T00:00:00Z' }, { type: 'Ready for Pick Up', at: '2026-09-21T00:00:00Z' }] }, 'ready'],
    [{ caseStatus: 'Open', comments: [{ type: 'Ready for Pick Up', at: '2026-09-20T00:00:00Z' }, { type: 'General', at: '2026-09-21T00:00:00Z' }] }, ''],
    [{ caseStatus: 'Open', thread: 'x closed this case as Resolved' }, 'ready'],
    [{ caseStatus: 'Open', thread: 'status changed to In-Repair' }, 'repair'],
    [{ caseStatus: 'Open', thread: 'Unit Arrived at dealer' }, 'arrival'],
    [{ caseStatus: 'Open' }, ''],
    [{}, ''],
  ];
  for (const [input, stage] of cases) {
    it(JSON.stringify(input) + ' -> ' + (stage || "''"), () => {
      expect(T.stageFromCase(input).stage).toBe(stage);
    });
  }

  it('since is the dated step matching the stage, else empty', () => {
    expect(T.stageFromCase({ caseStatus: 'In Repair', steps })).toEqual({ stage: 'repair', since: '2026-09-23T14:00:00.000Z' });
    expect(T.stageFromCase({ caseStatus: 'Arrived', steps })).toEqual({ stage: 'arrival', since: '2026-09-22T13:00:00.000Z' });
    expect(T.stageFromCase({ caseStatus: 'Closed', steps })).toEqual({ stage: 'ready', since: '' });
    expect(T.stageFromCase({ caseStatus: 'Open', steps }).since).toBe('');
  });

  it('no-RO fixture: Ready for Pick Up comment', () => {
    expect(T.stageFromCase({ caseStatus: 'Open', comments: [{ type: NO_RO_COMMENTS[0].CommentType, at: NO_RO_COMMENTS[0].CreatedDate }] }).stage).toBe('ready');
  });
});
