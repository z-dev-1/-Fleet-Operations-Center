// tests/dtna-enrich.test.js
//
// Unit tests for the DTNA Servicetracker comment-feed parser (parseFeed in
// src/scrapers/dtna_enrich.js). The fixture is the REAL rendered Chatter feed
// text captured from a live DTNA case (unit 922516, case 500gx000000SJcUAAW),
// so this pins the parser against actual Salesforce Lightning output. The
// networked enrichDtna() (warm vendor window + DOM scrape) isn't exercised here.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { parseFeed, DTNA_CASE_RE } = require('../src/scrapers/dtna_enrich');

// Trimmed-but-faithful slice of the real captured feed (dtna_comments_dom.txt).
const REAL_FEED = `Sort by:
Latest Posts
Refresh this feed
Skip Feed
CRM Admin (Employee) closed this case as Closed.
October 13, 2026 at 7:03 AM
Actions for this Feed Item
Status
In-Repair to Closed
Like
Comment
Write a comment...
AFP FAS (Partner - Y16782)
September 24, 2026 at 6:56 AM
Actions for this Feed Item
07/28
—
Work order created with Kenworth (PACCAR) at Sherwood Freightliner (Decisiv case 20882180). Unit towed to dealer.
08/08
—
Estimate rejected. No estimate or photos submitted to work order for review.
09/11
—
Contacted dealer directly. Confirmed dealer is actively working oil pan and low oil PSI faults.
Expand Post
Like
Comment
Write a comment...
AFP FAS (Partner - Y16782)
September 24, 2026 at 6:53 AM
Actions for this Feed Item
EST and pictures
Adobe PDF
1964_260901091538_001
Show more actions
Like
Comment
Write a comment...
AFP FAS (Partner - Y16782) updated this record.
September 24, 2026 at 6:44 AM
Actions for this Feed Item
Status
Arrived to In-Repair
Like
Comment
Write a comment...
Michelle Sutton (Partner) updated this record.
September 24, 2026 at 6:44 AM
Actions for this Feed Item
Status
Pre-Repair to Arrived
Like
Comment
Write a comment...
End of Feed
6 Chatter Feed Items`;

describe('dtna_enrich — DTNA_CASE_RE', () => {
  it('matches a Servicetracker case URL and captures the Salesforce id', () => {
    const m = 'https://dtna.my.site.com/Servicetracker/s/case/500gx000000SJcUAAW'.match(DTNA_CASE_RE);
    expect(m).toBeTruthy();
    expect(m[1]).toBe('500gx000000SJcUAAW');
  });
  it('does not match non-DTNA URLs', () => {
    expect(DTNA_CASE_RE.test('https://volvopg.asist.decisiv.net/fleet/estimates/123')).toBe(false);
  });
});

describe('dtna_enrich — parseFeed (real captured feed)', () => {
  const out = parseFeed(REAL_FEED);

  it('produces a non-empty dated timeline', () => {
    expect(out.length).toBeGreaterThan(200);
  });

  it('captures the case-closed status transition', () => {
    expect(out).toMatch(/October 13, 2026 — CRM Admin: closed this case as Closed \(In-Repair to Closed\)/);
  });

  it('captures the dated coordinator log body intact', () => {
    expect(out).toContain('07/28 — Work order created with Kenworth (PACCAR)');
    expect(out).toContain('09/11 — Contacted dealer directly. Confirmed dealer is actively working oil pan');
  });

  it('captures status-transition feed items with author + from/to', () => {
    expect(out).toMatch(/AFP FAS: updated this record \(Arrived to In-Repair\)/);
    expect(out).toMatch(/Michelle Sutton: updated this record \(Pre-Repair to Arrived\)/);
  });

  it('strips all Lightning/Chatter UI chrome', () => {
    for (const noise of ['Like', 'Write a comment', 'Actions for this Feed Item', 'Sort by:', 'Refresh this feed', 'End of Feed', 'Chatter Feed Items', 'Expand Post', 'Skip Feed']) {
      // chrome tokens must not appear as standalone lines in the output
      expect(out.split('\n').some(l => l.trim() === noise)).toBe(false);
    }
  });

  it('drops attachment filename rows', () => {
    expect(out).not.toContain('1964_260901091538_001');
    expect(out).not.toMatch(/\bAdobe PDF\b/);
  });

  it('is empty-safe', () => {
    expect(parseFeed('')).toBe('');
    expect(parseFeed(null)).toBe('');
    expect(parseFeed('Sort by:\nLike\nEnd of Feed')).toBe(''); // only chrome -> nothing
  });
});
