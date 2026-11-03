// tests/jobs-repair-intel-baseline.gen.test.js — env-gated generator for the
// Phase 7 repair-intel flags-off golden (gate b). Captured against the
// UNCHANGED d57e9b5 src/repair-intel/background.js. Skipped unless
// FLEET_GEN_BASELINE=1.
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import * as fx from './fixtures/jobs-repair-intel-fixture.js';
const require = createRequire(import.meta.url);

describe.skipIf(process.env.FLEET_GEN_BASELINE !== '1')('generate repair-intel baseline', () => {
  afterAll(() => { vi.useRealTimers(); });
  it('writes tests/fixtures/jobs-repair-intel-baseline.json', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-ri-gen-'));
    require('../src/config/paths').setDataDir(tmp);
    fx.installStubs();
    const bg = require('../src/repair-intel/background');
    fx.setupClock();
    const out = {};
    for (const name of Object.keys(fx.SCENARIOS)) out[name] = await fx.runScenario(bg, name);
    vi.useRealTimers();
    const file = fileURLToPath(new URL('./fixtures/jobs-repair-intel-baseline.json', import.meta.url));
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    expect(out.changed.analyze.length).toBe(1);
  });
});
