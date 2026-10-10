import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const cp = require('../src/scrapers/convo_parse');

// The real B62064 Offsite (Decisiv) thread shape: multi-line author header
// (sender line 1, "to <recipient>" + "and N MORE CONTACT" lines), then date,
// then text, then a share-scope line.
const B62064 = [
  'Jose Mallen - Hunter Truck - Buffalo (Service Advisor) to',
  'Z SANTIAGO - Amazon Logistics and 1 MORE CONTACT',
  'Oct 9, 2026 06:07 PM',
  'ON THE MIRROR, IT IS ON BACK ORDER, BUT WE CAN ORDER THIS WITH FREIGHT AND IT WOULD BE HERE WITHIN 6-9 DAYS. PLEASE ADVISE IF YOU WOULD LIKE TO ORDER NORMAL OR WITH FREIGHT.',
  'Vendor',
  'Z SANTIAGO - Amazon Logistics',
  'Oct 9, 2026 07:15 PM',
  'can you provide an est WITH FREIGHT?',
  'Internal Only',
].join('\n');

describe('convo_parse — the B62064 vendor-asked-then-we-replied thread', () => {
  it('parses two comments with correct sides and the vendor as the FIRST sender', () => {
    const c = cp.parseConversation(B62064, { usNames: ['Z SANTIAGO'] });
    expect(c.length).toBe(2);
    expect(c[0].side).toBe('vendor');          // Jose / Hunter Truck
    expect(c[0].author).toContain('Jose Mallen');
    expect(c[0].text).toContain('ORDER NORMAL OR WITH FREIGHT');
    expect(c[1].side).toBe('us');              // our reply
    expect(c[1].text).toContain('est WITH FREIGHT');
  });

  it('reports WE spoke last (so intent should be chase, not re-ask)', () => {
    const c = cp.parseConversation(B62064, { usNames: ['Z SANTIAGO'] });
    const last = cp.lastComment(c);
    expect(last.side).toBe('us');
    expect(cp.lastCommentLine(c)).toMatch(/^us on Oct 9, 2026: can you provide/);
  });

  it('does NOT mistake the "to <recipient>" line for the author', () => {
    const c = cp.parseConversation(B62064, { usNames: ['Z SANTIAGO'] });
    // the vendor comment's author is the sender (Jose), not the recipient (Z SANTIAGO)
    expect(c[0].author).not.toMatch(/^Z SANTIAGO/);
  });
});

describe('convo_parse — side inference', () => {
  it('classifies vendor roles/companies as vendor', () => {
    expect(cp.inferSide('Mike at Rush Truck Center (Service Advisor)')).toBe('vendor');
    expect(cp.inferSide('Volvo Technician')).toBe('vendor');
  });
  it('classifies our names/orgs as us', () => {
    expect(cp.inferSide('Z SANTIAGO - Amazon Logistics')).toBe('us');
    expect(cp.inferSide('Fleet Ops Coordinator')).toBe('us');
  });
  it('returns unknown when there is no signal', () => {
    expect(cp.inferSide('Pat Q')).toBe('unknown');
    expect(cp.inferSide('')).toBe('unknown');
  });
});

describe('convo_parse — robustness', () => {
  it('handles numeric dates (10/09/26)', () => {
    const blob = [
      'Hunter Truck Service Advisor',
      '10/09/26',
      'parts on order, ETC 6-9 days',
      'Z SANTIAGO Amazon Logistics',
      '10/09/26',
      'please send the freight estimate',
    ].join('\n');
    const c = cp.parseConversation(blob);
    expect(c.length).toBe(2);
    expect(cp.lastComment(c).side).toBe('us');
  });

  it('returns [] for a blob with no parseable comment blocks (blob fallback still used upstream)', () => {
    expect(cp.parseConversation('just some random page text with no author or date structure at all')).toEqual([]);
    expect(cp.parseConversation('')).toEqual([]);
    expect(cp.parseConversation(null)).toEqual([]);
  });

  it('never throws on odd input', () => {
    expect(() => cp.parseConversation(undefined)).not.toThrow();
    expect(() => cp.parseConversation(12345)).not.toThrow();
    expect(() => cp.parseConversation({})).not.toThrow();
  });

  it('tail-biases the cap: keeps the NEWEST comments', () => {
    const blocks = [];
    for (let i = 1; i <= 10; i++) {
      blocks.push('Hunter Truck Advisor', 'Oct ' + i + ', 2026', 'vendor update number ' + i);
    }
    const c = cp.parseConversation(blocks.join('\n'), { cap: 3 });
    expect(c.length).toBe(3);
    // last kept comment should be the newest (number 10)
    expect(cp.lastComment(c).text).toContain('number 10');
  });

  it('lastComment / lastCommentLine handle empty gracefully', () => {
    expect(cp.lastComment([])).toBeNull();
    expect(cp.lastCommentLine([])).toBe('');
  });
});
