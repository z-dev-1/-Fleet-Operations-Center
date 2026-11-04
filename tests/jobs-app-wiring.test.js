// tests/jobs-app-wiring.test.js — Phase 7 app.js wiring: exactly ONE jobs
// init line, after the worker supervisor init and before registerAllIPC.
// app.js requires electron at top level, so it is checked as text.
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const APP_SRC = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
const LINE = "try { require('./jobs').init(); } catch (e) { log.warn('[jobs] init failed (non-fatal, non-durable): ' + e.message); }";

describe('jobs app wiring', () => {
  it('the init line appears exactly once, after the supervisor init and before registerAllIPC', () => {
    expect(APP_SRC.split(LINE).length - 1).toBe(1);
    expect(APP_SRC.split("require('./jobs')").length - 1).toBe(1);
    const iJobs = APP_SRC.indexOf(LINE);
    const iSup = APP_SRC.indexOf("require('./workers/supervisor').init(");
    const iIpc = APP_SRC.indexOf('registerAllIPC(_ctx)');
    expect(iSup).toBeGreaterThan(0);
    expect(iJobs).toBeGreaterThan(iSup);
    expect(iJobs).toBeLessThan(iIpc);
  });
  it('requiring src/jobs is side-effect free (no SQLite open)', () => {
    const engine = require('../src/store/sqlite_engine');
    const spies = ['exec', 'prepare', 'getDb', 'isAvailable'].map((k) => vi.spyOn(engine, k));
    const jobs = require('../src/jobs');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(jobs.getStatus().mode).toBe('off');
    expect(jobs.begin({ type: 'deepScan', scopeKey: 'fleet' })).toBe(jobs.NOOP_HANDLE);
  });
});
