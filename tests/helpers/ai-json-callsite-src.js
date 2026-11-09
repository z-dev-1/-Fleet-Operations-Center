// tests/helpers/ai-json-callsite-src.js — slices the real AI-reply parse lines
// out of the (non-exported) call sites so tests/ai-json-call-sites.test.js can
// run the shipped code in a new Function sandbox with fakes injected. A moved
// or renamed block throws loudly instead of silently testing nothing.
import fs from 'fs';
import { fileURLToPath } from 'url';
import { BLOCKS } from './longdwell-legacy-src.js';

const p = (rel) => fileURLToPath(new URL(rel, import.meta.url));
export const ANALYTICS = p('../../renderer/src/js/views/analytics.js');
export const CSV = p('../../renderer/src/js/views/longdwell-csv.js');
export const WR_MODAL = p('../../renderer/src/js/views/wr-modal.js');
export const DAILY_CALL = p('../../renderer/src/js/views/daily-call.js');
export const HEARTBEAT = p('../../src/orcha/heartbeat.js');

export const readLines = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');

// Lines from the first one containing `startIncludes` through the first later
// line matching `endPred` (inclusive).
export function sliceLines(lines, startIncludes, endPred, label) {
  const s = lines.findIndex((l) => l.includes(startIncludes));
  if (s < 0) throw new Error('call-site start not found: ' + label);
  for (let i = s + 1; i < lines.length; i++) {
    if (endPred(lines[i])) return lines.slice(s, i + 1).join('\n');
  }
  throw new Error('call-site end not found: ' + label);
}
export const includes = (str) => (l) => l.includes(str);
export const exactly = (str) => (l) => l === str;

// The _aiFillRow block (as hashed by the legacy parity test) of a Long Dwell view.
export function aiFillRowLines(key) {
  const [file, extract] = BLOCKS[key];
  return extract(readLines(file)).split('\n');
}
