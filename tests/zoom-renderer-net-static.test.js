// FEAT-004 / AC15 (design NFR "Networking exception"): renderer zoom files make no network calls,
// except obs-feed.js, which opens exactly one WebSocket and only after checking FEED_URL_RE.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'renderer/src/js/zoom');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).sort();
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

describe('renderer zoom networking (static)', () => {
  it('new WebSocket appears only in renderer/src/js/zoom/obs-feed.js', () => {
    expect(FILES).toContain('obs-feed.js');
    expect(FILES.length).toBeGreaterThan(5);
    for (const f of FILES) {
      const n = (read(f).match(/new\s+WebSocket\b/g) || []).length;
      expect([f, n]).toEqual([f, f === 'obs-feed.js' ? 1 : 0]);
      if (f !== 'obs-feed.js') {
        // No other way to reach a socket either (e.g. a WebSocket reference or a ws:// URL literal).
        expect([f, /WebSocket\s*\(|\bglobalThis\.WebSocket|window\.WebSocket|['"`]wss?:\/\//.test(read(f))]).toEqual([f, false]);
      }
    }
  });

  it('no fetch( or XMLHttpRequest in any renderer zoom file', () => {
    for (const f of FILES) {
      const src = read(f);
      expect([f, /\bfetch\s*\(/.test(src)]).toEqual([f, false]);
      expect([f, /XMLHttpRequest/.test(src)]).toEqual([f, false]);
      expect([f, /\bEventSource\b|sendBeacon|navigator\.connection/.test(src)]).toEqual([f, false]);
    }
  });

  it('obs-feed.js checks FEED_URL_RE before opening the socket', () => {
    const src = read('obs-feed.js');
    expect(src).toMatch(/import \{[^}]*\bFEED_URL_RE\b[^}]*\} from '\.\/obs-logic\.js';/);
    // Inside _open(): the URL test comes before the only `new WebSocket`.
    const open = src.indexOf('function _open(');
    const ctor = src.indexOf('new WebSocket(');
    expect(open).toBeGreaterThan(-1);
    expect(ctor).toBeGreaterThan(open);
    expect(src.slice(open, ctor)).toMatch(/!FEED_URL_RE\.test\(url\)\) return;/);
    // connect() rejects a bad URL before anything is opened.
    const c = src.indexOf('export function connect(');
    const body = src.slice(c, src.indexOf('\n}\n', c));
    expect(body.indexOf('FEED_URL_RE.test(feedUrl)')).toBeGreaterThan(-1);
    expect(body.indexOf('FEED_URL_RE.test(feedUrl)')).toBeLessThan(body.indexOf('_open()'));
  });
});
