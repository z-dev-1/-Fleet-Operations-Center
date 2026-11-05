// tests/helpers/longdwell-legacy-src.js — extracts the legacy Long Dwell AI
// Fill functions from the two renderer views and hashes their source text.
// Shared by tests/longdwell-legacy-baseline.gen.test.js (captures the golden
// from the unmodified base) and tests/longdwell-legacy-parity.test.js.
//
// Extraction is line based: a top-level function runs from its declaration
// line to the first following line that is exactly '}'; the #an-ld-fill-all
// click handler runs from its addEventListener line to the first following
// line that is exactly '    });'.
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

export const ANALYTICS = fileURLToPath(new URL('../../renderer/src/js/views/analytics.js', import.meta.url));
export const CSV = fileURLToPath(new URL('../../renderer/src/js/views/longdwell-csv.js', import.meta.url));

function _slice(lines, startPred, endLine, label) {
  const s = lines.findIndex(startPred);
  if (s < 0) throw new Error('legacy block not found: ' + label);
  for (let i = s + 1; i < lines.length; i++) {
    if (lines[i] === endLine) return lines.slice(s, i + 1).join('\n');
  }
  throw new Error('legacy block end not found: ' + label);
}

const fnBlock = (name) => (lines) => _slice(lines, (l) => l.startsWith('async function ' + name + '('), '}', name);
const fillAllHandler = (lines) => _slice(lines, (l) => l.includes("fillAllBtn.addEventListener('click', async () => {"), '    });', 'an-ld-fill-all handler');

export const BLOCKS = {
  'analytics.js#_aiFillRow': [ANALYTICS, fnBlock('_aiFillRow')],
  'analytics.js#_runFillForRows': [ANALYTICS, fnBlock('_runFillForRows')],
  'analytics.js#an-ld-fill-all': [ANALYTICS, fillAllHandler],
  'longdwell-csv.js#_aiFillRow': [CSV, fnBlock('_aiFillRow')],
  'longdwell-csv.js#_aiFillAll': [CSV, fnBlock('_aiFillAll')],
};

// Undo the marked durable gates: drop whole lines ending in `// durable-gate`
// and the `,\n  opts /* durable-gate */` parameter line.
export function stripGates(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/,\n {2}opts \/\* durable-gate \*\//g, '')
    .split('\n')
    .filter((l) => !/\/\/ durable-gate\s*$/.test(l))
    .join('\n');
}

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// { blockName: sha1 } for the given file texts ({ [path]: text }).
export function hashBlocks(texts, strip) {
  const out = {};
  for (const [name, [file, extract]] of Object.entries(BLOCKS)) {
    let text = String(texts[file]).replace(/\r\n/g, '\n');
    if (strip) text = stripGates(text);
    out[name] = sha1(extract(text.split('\n')));
  }
  return out;
}

export function readTexts() {
  return { [ANALYTICS]: fs.readFileSync(ANALYTICS, 'utf8'), [CSV]: fs.readFileSync(CSV, 'utf8') };
}
