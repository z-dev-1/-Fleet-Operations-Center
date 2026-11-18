// tests/carrier-intel-readonly-graph.test.js — carrier-intel design B11: the structural
// read-only check (AC-30). A walker collects every require('./…') / require('../…') string
// literal (top-level and lazy), resolves it relative to the file and recurses.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CI_DIR = path.join(ROOT, 'src', 'carrier-intel');
const REQ_RE = /require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

const WRITE_MODULES = [
  'src/writes/',
  'src/scrapers/aap_api.js',
  'src/scrapers/aap_create_wr.js',
  'src/scrapers/relay.js',
  'src/scrapers/slack_send.js',
  'src/scrapers/carrier_briefing.js',
  'src/scrapers/aap_longdwell.js',
  'src/orcha/relay.js',
  'src/orcha/repair-history.js',
  'src/scheduler/',
  'src/ipc/relay-writes.js',
  'src/ipc/ai.js',
  'src/sync/',
];
const isWrite = (p) => WRITE_MODULES.some((w) => (w.endsWith('/') ? p.startsWith(w) : p === w));
const ACTION_NAMES_RE = /\b(MOVE_UNIT|CREATE_WR|TIMELINE|APPROVE_WR|SLACK|EMAIL|PIN|REMIND|SYNC|SP_PUSH|BRIEFING|DBR_PULL)\b/;

function directRequires(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(REQ_RE)) out.push(m[2]);
  return out;
}

function closure(start) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!/\.(c?js)$/.test(f)) continue;
    const req = createRequire(f);
    for (const spec of directRequires(f)) {
      let resolved;
      try { resolved = req.resolve(spec); } catch (_) { continue; }
      if (!seen.has(resolved)) stack.push(resolved);
    }
  }
  return new Set([...seen].map(rel));
}

const ciFiles = fs.readdirSync(CI_DIR).filter((f) => f.endsWith('.js')).sort();
const pure = ciFiles.filter((f) => f !== 'index.js');

describe('AC-30 read-only require graph', () => {
  it('walker self-test: src/dbr/lookup.js reaches the relay and the write gate (lazy requires followed)', () => {
    const c = closure(path.join(ROOT, 'src', 'dbr', 'lookup.js'));
    expect(c.has('src/orcha/relay.js')).toBe(true);
    expect(c.has('src/writes/write-gate.js')).toBe(true);
  });

  it('the pure modules exist', () => {
    expect(pure).toEqual(['answer.js', 'context.js', 'facts.js', 'gaps.js', 'intent.js', 'taxonomy.js', 'themes.js']);
    expect(ciFiles).toContain('index.js');
  });

  it('the union closure of the pure modules has no write module and no src/dbr/lookup.js', () => {
    const union = new Set();
    for (const f of pure) for (const p of closure(path.join(CI_DIR, f))) union.add(p);
    expect(union.has('src/carrier-intel/index.js')).toBe(false);
    expect([...union].filter(isWrite)).toEqual([]);
    expect(union.has('src/dbr/lookup.js')).toBe(false);
  });

  it('no pure module requires ../utils/logger', () => {
    for (const f of pure) {
      const reqs = directRequires(path.join(CI_DIR, f));
      expect(reqs.filter((r) => /utils\/logger/.test(r)), f).toEqual([]);
    }
  });

  it('index.js direct requires are inside the allow-list', () => {
    const ALLOW = [/^\.\/[^/]+$/, /^\.\.\/store$/, /^\.\.\/orcha\/relay$/, /^\.\.\/ipc\/fleet-dbr$/, /^\.\.\/dbr\/[^/]+$/, /^\.\.\/utils\/logger$/];
    const reqs = directRequires(path.join(CI_DIR, 'index.js'));
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.filter((r) => !ALLOW.some((re) => re.test(r)))).toEqual([]);
    // No non-relative requires either (electron, fs, …).
    const src = fs.readFileSync(path.join(CI_DIR, 'index.js'), 'utf8');
    const all = [...src.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2]);
    expect(all.filter((r) => !r.startsWith('.'))).toEqual([]);
  });

  it('index.js references no action type names', () => {
    const src = fs.readFileSync(path.join(CI_DIR, 'index.js'), 'utf8');
    expect(src.match(ACTION_NAMES_RE)).toBeNull();
  });
});
