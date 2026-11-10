// tests/source-budget.test.js — newest-first trimming helpers + the
// settings.ai.fullContext flag (src/orcha/source-budget.js).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sb = require('../src/orcha/source-budget');

const MARKER_LEN_MAX = '[… 99999 older lines trimmed to fit the AI budget …]'.length + 1;
const pad = (n) => String(n).padStart(2, '0');

// Oldest-first AAP feed: "MM/DD - text" lines over Jan..Apr.
function ascFeed(n, filler = 'x'.repeat(80)) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(pad(1 + Math.floor(i / 28) % 4) + '/' + pad(1 + (i % 28)) + ' - entry ' + i + ' ' + filler);
  return out;
}

function checkShape(input, res, budget) {
  const inLines = new Set(input.split('\n'));
  expect(res.text.length).toBeLessThanOrEqual(budget + MARKER_LEN_MAX);
  for (const l of res.text.split('\n')) {
    if (sb.TRIM_MARKER_RE.test(l) && /^\[…/.test(l)) continue;
    expect(inLines.has(l)).toBe(true);
  }
}

describe('detectOrder', () => {
  it('asc for an oldest-first AAP feed', () => { expect(sb.detectOrder(ascFeed(60))).toBe('asc'); });
  it('desc for a newest-first feed', () => { expect(sb.detectOrder(ascFeed(60).reverse())).toBe('desc'); });
  it("detects the 'Mon D, YYYY' DOM date format", () => {
    const dom = ['Jane Vendor', 'Oct 20, 2026 09:00 AM', 'newest', 'Bob Fleet', 'Oct 2, 2026 08:00 AM', 'older'];
    expect(sb.detectOrder(dom)).toBe('desc');
    expect(sb.detectOrder(dom.slice(3).concat(dom.slice(0, 3)))).toBe('asc');
  });
  it('undated feed defaults to asc', () => { expect(sb.detectOrder(['no dates', 'here', 'at all'])).toBe('asc'); });
  it('month/day-only year wrap reads as asc', () => { expect(sb.detectOrder(['12/20 - a', '12/28 - b', '01/05 - c'])).toBe('asc'); });
  it('years are honored when present', () => { expect(sb.detectOrder(['- 03/01/2026 a', '- 02/01/2025 b'])).toBe('desc'); });
});

describe('keepNewest', () => {
  it('short text is returned as-is', () => {
    expect(sb.keepNewest('a\nb', 100)).toEqual({ text: 'a\nb', dropped: 0, droppedLines: [] });
  });

  it('asc feed keeps the newest lines + the oldest anchor, with a marker', () => {
    const lines = ascFeed(200);
    const input = lines.join('\n');
    const res = sb.keepNewest(input, 5000, { anchor: 300 });
    checkShape(input, res, 5000);
    const out = res.text.split('\n');
    expect(out[0]).toBe(lines[0]);                        // anchor = first entry
    expect(out[out.length - 1]).toBe(lines[lines.length - 1]); // newest kept
    const markerIdx = out.findIndex((l) => /^\[… \d+ older lines trimmed/.test(l));
    expect(markerIdx).toBeGreaterThan(0);
    expect(out[markerIdx]).toBe('[… ' + res.dropped + ' older lines trimmed to fit the AI budget …]');
    expect(res.dropped).toBe(lines.length - (out.length - 1));
    expect(res.droppedLines.length).toBe(res.dropped);
    // droppedLines are newest-first: the first dropped is the line just before the kept tail.
    const firstTail = lines.indexOf(out[markerIdx + 1]);
    expect(res.droppedLines[0]).toBe(lines[firstTail - 1]);
    expect(res.text.length).toBeLessThanOrEqual(5000);
  });

  it('desc feed keeps the head (newest) lines', () => {
    const lines = ascFeed(200).reverse();
    const input = lines.join('\n');
    const res = sb.keepNewest(input, 4000);
    checkShape(input, res, 4000);
    const out = res.text.split('\n');
    expect(out[0]).toBe(lines[0]);
    expect(sb.TRIM_MARKER_RE.test(out[out.length - 1])).toBe(true);
    expect(res.dropped).toBe(lines.length - (out.length - 1));
    expect(res.droppedLines[0]).toBe(lines[out.length - 1]);
  });

  it('desc feed takes its anchor from the tail (oldest) end', () => {
    const lines = ascFeed(200).reverse();
    const res = sb.keepNewest(lines.join('\n'), 4000, { anchor: 200 });
    const out = res.text.split('\n');
    expect(out[0]).toBe(lines[0]);
    expect(out[out.length - 1]).toBe(lines[lines.length - 1]);
  });

  it('undated feed is treated as oldest-first (keeps the tail)', () => {
    const lines = Array.from({ length: 100 }, (_, i) => 'plain line ' + i + ' ' + 'y'.repeat(50));
    const res = sb.keepNewest(lines.join('\n'), 1000);
    const out = res.text.split('\n');
    expect(out[out.length - 1]).toBe(lines[99]);
    expect(sb.TRIM_MARKER_RE.test(out[0])).toBe(true);
  });

  it('a single over-budget newest line is cut without splitting a surrogate pair', () => {
    const emoji = '😀'.repeat(100); // 200 UTF-16 units
    for (const budget of [101, 150, 151]) {
      const res = sb.keepNewest('old line\n' + emoji, budget);
      expect(res.text.length).toBeLessThanOrEqual(budget);
      const last = res.text.split('\n').pop();
      const code = last.charCodeAt(last.length - 1);
      expect(code >= 0xd800 && code <= 0xdbff).toBe(false); // no lone high surrogate
      expect(/^(?:😀)+$/u.test(last)).toBe(true);
    }
  });
});

describe('resolveFullContext / loadFullContext', () => {
  const settingsCases = [[{}, true], [{ ai: { fullContext: false } }, false], [{ ai: { fullContext: true } }, true]];
  for (const [settings, base] of settingsCases) {
    it('settings ' + JSON.stringify(settings), () => {
      expect(sb.resolveFullContext(settings, {})).toBe(base);
      expect(sb.resolveFullContext(settings, { FLEET_AI_FULL_CONTEXT: '0' })).toBe(false);
      expect(sb.resolveFullContext(settings, { FLEET_AI_FULL_CONTEXT: '1' })).toBe(true);
      expect(sb.resolveFullContext(settings, { FLEET_AI_FULL_CONTEXT: 'yes' })).toBe(base);
    });
  }
  it('null settings default ON', () => { expect(sb.resolveFullContext(null, undefined)).toBe(true); });
  it('loadFullContext reads the injected store', () => {
    expect(sb.loadFullContext({ load: () => ({ ai: { fullContext: false } }), env: {} })).toBe(false);
    expect(sb.loadFullContext({ load: () => ({}), env: {} })).toBe(true);
  });
  it('loadFullContext with a throwing load -> true', () => {
    expect(sb.loadFullContext({ load: () => { throw new Error('boom'); }, env: {} })).toBe(true);
  });
});
