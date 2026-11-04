// tests/jobs-deep-scan-baseline.gen.test.js — env-gated generator for the
// Phase 7 deep-scan flags-off golden (gate b). Captured against the UNCHANGED
// d57e9b5 src/orcha/deep-scan.js. Skipped unless FLEET_GEN_BASELINE=1:
//   $env:FLEET_GEN_BASELINE='1'; npx vitest run tests/jobs-deep-scan-baseline.gen.test.js; Remove-Item Env:FLEET_GEN_BASELINE
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { vi } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import * as fx from './fixtures/jobs-deep-scan-fixture.js';
const require = createRequire(import.meta.url);

describe.skipIf(process.env.FLEET_GEN_BASELINE !== '1')('generate deep-scan baseline', () => {
  afterAll(() => { vi.useRealTimers(); });
  it('writes tests/fixtures/jobs-deep-scan-baseline.json', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-ds-gen-'));
    require('../src/config/paths').setDataDir(tmp);
    fx.installStubs();
    const ds = require('../src/orcha/deep-scan');
    fx.setupClock();
    const out = {};
    for (const mode of ['fleet', 'ondemand', 'force']) {
      fx.resetRecorders();
      out[mode] = await fx.runScenario(ds, mode);
    }
    vi.useRealTimers();
    const file = fileURLToPath(new URL('./fixtures/jobs-deep-scan-baseline.json', import.meta.url));
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    expect(out.fleet.pushDataCount).toBeGreaterThan(1);
  });
});
