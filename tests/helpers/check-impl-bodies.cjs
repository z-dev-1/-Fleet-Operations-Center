'use strict';
// tests/helpers/check-impl-bodies.cjs — Phase 9 REQUIRED FIX 3 scripted diff.
//
// Usage (from the repo root):  node tests/helpers/check-impl-bodies.cjs d57e9b5
//
// Proves the rename-and-wrap kept every wrapped function body BYTE-FOR-BYTE
// identical to the base revision: for each (base declaration -> current
// declaration) pair it extracts the body (the lines after the declaration line
// through the first following line that is exactly "}") from
// `git show <rev>:src/scrapers/auth.js` and from the working file, strips "\r",
// and compares the strings. Prints "OK <name>" or a line diff; exits 1 on any
// mismatch. Dev script only (spawns git); the vitest twin is
// tests/auth-coord-impl-bodies.test.js (SHA-256 constants, no child process).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PAIRS = [
  ['async function injectCookies(targetSession, opts) {', 'async function _injectCookiesImpl(targetSession, opts) {'],
  ['async function injectAeaFromPostureToken(targetSession) {', 'async function _injectAeaFromPostureTokenImpl(targetSession) {'],
  ['async function probeSession() {', 'async function _probeSessionImpl() {'],
  ['async function refreshAeaSilently() {', 'async function _refreshAeaSilentlyImpl() {'],
  ['function runMwinit(force) {', 'function runMwinit(force) {'],
];

function extractBody(src, decl) {
  const lines = src.replace(/\r/g, '').split('\n');
  const i = lines.indexOf(decl);
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    out.push(lines[j]);
    if (lines[j] === '}') return out.join('\n');
  }
  return null;
}

function main() {
  const rev = process.argv[2] || 'd57e9b5';
  const root = path.resolve(__dirname, '..', '..');
  const base = execFileSync('git', ['-C', root, 'show', rev + ':src/scrapers/auth.js'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const cur = fs.readFileSync(path.join(root, 'src', 'scrapers', 'auth.js'), 'utf8');
  let bad = 0;
  for (const [bDecl, cDecl] of PAIRS) {
    const name = cDecl.replace(/^async /, '').replace(/^function /, '').replace(/\(.*$/, '');
    const b = extractBody(base, bDecl);
    const c = extractBody(cur, cDecl);
    if (b == null || c == null) { bad++; console.log('MISSING ' + name + ' (base=' + (b != null) + ', current=' + (c != null) + ')'); continue; }
    if (b === c) { console.log('OK ' + name + ' (' + b.split('\n').length + ' body lines identical to ' + rev + ')'); continue; }
    bad++;
    console.log('DIFF ' + name);
    const bl = b.split('\n'), cl = c.split('\n');
    for (let k = 0; k < Math.max(bl.length, cl.length); k++) {
      if (bl[k] !== cl[k]) { console.log('  line ' + (k + 1) + '\n  - ' + bl[k] + '\n  + ' + cl[k]); }
    }
  }
  process.exit(bad ? 1 : 0);
}

if (require.main === module) main();
module.exports = { extractBody, PAIRS };
