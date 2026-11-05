// tests/helpers/dbr-renderer-src.js — extracts the DBR review functions from
// the renderer view (renderer/src/js/views/daily-call.js), hashes their source
// text, and runs them in a `new Function` sandbox so tests can compare the
// main-process port (src/dbr/review-engine.js) against the real renderer code.
// Modeled on tests/helpers/longdwell-legacy-src.js.
//
// Extraction is line based: a multi-line top-level block runs from its
// declaration line to the first following line that is exactly the end marker
// ('}' for functions, '];' for arrays, '};' for objects); single-line blocks are
// just their declaration line. A missing or duplicated marker throws, so a
// renderer edit that moves a block fails loudly.
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

export const DAILY_CALL = fileURLToPath(new URL('../../renderer/src/js/views/daily-call.js', import.meta.url));

// [name, declaration-line prefix, end line (null = single line)]
export const BLOCK_SPECS = [
  ['TREND_TERMS', 'const TREND_TERMS = [', '];'],
  ['TREND_MIN_UNITS', 'const TREND_MIN_UNITS = ', null],
  ['BARRIER_TERMS', 'const BARRIER_TERMS = [', '];'],
  ['FLIP_SIGNAL', 'const FLIP_SIGNAL = ', null],
  ['STATUS_BARRIER_MAP', 'const STATUS_BARRIER_MAP = {', '};'],
  ['_unitText', 'function _unitText(', '}'],
  ['_parseDaysOpen', 'function _parseDaysOpen(', '}'],
  ['_isUnavail', 'function _isUnavail(', '}'],
  ['_computeGroup', 'function _computeGroup(', '}'],
  ['_dbrMatchUnits', 'function _dbrMatchUnits(', '}'],
  ['_dbrBuildReviewPrompt', 'function _dbrBuildReviewPrompt(', '}'],
  ['_dbrNormalizeTrendsText', 'function _dbrNormalizeTrendsText(', '}'],
  ['_dbrNormalizeHelpText', 'function _dbrNormalizeHelpText(', '}'],
  ['_dbrAskAi', 'async function _dbrAskAi(', '}'],
  ['_dbrReviewKey', 'function _dbrReviewKey(', null],
  ['_DBR_AI_TIMEOUT_MS', 'const _DBR_AI_TIMEOUT_MS = ', null],
  ['_dbrReviewRow', 'async function _dbrReviewRow(', '}'],
];

export function readRendererText() {
  return fs.readFileSync(DAILY_CALL, 'utf8').replace(/\r\n/g, '\n');
}

// { name: blockText } in BLOCK_SPECS order.
export function extractBlocks(text = readRendererText()) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = {};
  for (const [name, prefix, end] of BLOCK_SPECS) {
    const hits = [];
    lines.forEach((l, i) => { if (l.startsWith(prefix)) hits.push(i); });
    if (hits.length === 0) throw new Error('renderer DBR block not found: ' + name);
    if (hits.length > 1) throw new Error('renderer DBR block marker not unique: ' + name);
    const s = hits[0];
    if (end === null) { out[name] = lines[s]; continue; }
    let e = -1;
    for (let i = s + 1; i < lines.length; i++) { if (lines[i] === end) { e = i; break; } }
    if (e < 0) throw new Error('renderer DBR block end not found: ' + name);
    out[name] = lines.slice(s, e + 1).join('\n');
  }
  return out;
}

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// { blockName: sha1 } — the tripwire golden.
export function blockHashes(text) {
  const blocks = extractBlocks(text);
  const out = {};
  for (const [name] of BLOCK_SPECS) out[name] = sha1(blocks[name]);
  return out;
}

// Runs the extracted renderer code with fakes for its globals:
//   state.slice('fleet').rows -> rows, window.ai.ask -> ask, console -> quiet,
//   setTimeout -> inert (so _dbrAskAi's 95 s timeout never fires in tests).
export function loadRenderer({ rows = [], ask } = {}) {
  const blocks = extractBlocks();
  const src = BLOCK_SPECS.map(([n]) => blocks[n]).join('\n\n') + '\nlet _dbrReview = {};\n'
    + 'return { TREND_TERMS, TREND_MIN_UNITS, BARRIER_TERMS, FLIP_SIGNAL, STATUS_BARRIER_MAP, '
    + '_unitText, _parseDaysOpen, _isUnavail, _computeGroup, _dbrMatchUnits, _dbrBuildReviewPrompt, '
    + '_dbrNormalizeTrendsText, _dbrNormalizeHelpText, _dbrAskAi, _dbrReviewRow };';
  const state = { slice: () => ({ rows }) };
  const win = { ai: { ask: ask || (async () => { throw new Error('no ask'); }) } };
  const quiet = { log() {}, warn() {}, error() {}, info() {} };
  const inertTimeout = () => 0;
  // eslint-disable-next-line no-new-func
  return new Function('state', 'window', 'console', 'setTimeout', src)(state, win, quiet, inertTimeout);
}
