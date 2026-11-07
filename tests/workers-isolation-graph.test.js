// tests/workers-isolation-graph.test.js — the worker's transitive require graph (review M3, design §9.2/§11.2).
import { describe, it, expect } from 'vitest';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// Bare module names (after stripping `node:`); any `fs/…` subpath is forbidden too.
export const FORBIDDEN_MODULES = [
  'electron', 'child_process', 'fs', 'fs/promises', 'sqlite', 'sqlite3', 'better-sqlite3',
  'http', 'https', 'http2', 'net', 'tls', 'dgram', 'worker_threads', 'cluster', 'ws', 'undici',
];
// Path fragments (repo-relative, '/' separators) no resolved file may live under.
export const FORBIDDEN_PATHS = [
  'src/store/', 'src/config/paths', 'src/utils/logger', 'src/orcha/relay', 'src/ai/', 'src/jobs/',
  'src/orcha/fleet-brain', 'src/scrapers/slack_send', 'src/cluster/',
];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(ROOT, 'tests', 'workers-isolation-fixtures', 'graph-probe.cjs');

function probe(target) {
  const r = spawnSync(process.execPath, [PROBE, target], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

function violations(records) {
  const bad = [];
  for (const { request, resolved } of records) {
    const bare = request.startsWith('node:') ? request.slice(5) : request;
    if (FORBIDDEN_MODULES.includes(bare) || bare.startsWith('fs/')) bad.push('module ' + request);
    if (resolved && path.isAbsolute(resolved)) {
      const rel = path.relative(ROOT, resolved).split(path.sep).join('/');
      for (const p of FORBIDDEN_PATHS) if (rel.startsWith(p)) bad.push('path ' + rel);
    }
  }
  return bad;
}

describe('worker require graph (M3)', { timeout: 30000 }, () => {
  it('canonical-worker.js graph has no fs/sqlite/network/store/electron modules', () => {
    const rec = probe(path.join(ROOT, 'src', 'workers', 'isolation', 'entries', 'canonical-worker.js'));
    expect(rec.some((r) => r.resolved && r.resolved.endsWith(path.join('orcha', 'canonical_state.js')))).toBe(true);
    expect(violations(rec)).toEqual([]);
  });

  it('worker-runtime.js graph has no fs/sqlite/network/store/electron modules', () => {
    const rec = probe(path.join(ROOT, 'src', 'workers', 'isolation', 'worker-runtime.js'));
    expect(rec.some((r) => r.resolved && r.resolved.endsWith(path.join('isolation', 'protocol.js')))).toBe(true);
    expect(violations(rec)).toEqual([]);
  });

  it('probe detects a forbidden require (self-check)', () => {
    const rec = probe(path.join(ROOT, 'tests', 'workers-isolation-fixtures', 'requires-fs.cjs'));
    expect(violations(rec)).toContain('module fs');
    expect(violations([{ request: 'node:fs/promises', resolved: null }])).toHaveLength(1);
    expect(violations([{ request: '../store', resolved: path.join(ROOT, 'src', 'store', 'sqlite_engine.js') }])).toHaveLength(1);
  });
});
