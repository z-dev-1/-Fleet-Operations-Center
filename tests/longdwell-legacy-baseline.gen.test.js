// tests/longdwell-legacy-baseline.gen.test.js — env-gated generator for the
// Long Dwell AI Fill legacy-text golden. Captured against the UNCHANGED d8ac226
// renderer/src/js/views/analytics.js and longdwell-csv.js (sha1 of each legacy
// function's source text). Skipped unless FLEET_GEN_BASELINE=1:
//   $env:FLEET_GEN_BASELINE='1'; npx vitest run tests/longdwell-legacy-baseline.gen.test.js; Remove-Item Env:FLEET_GEN_BASELINE
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { hashBlocks, readTexts, BLOCKS } from './helpers/longdwell-legacy-src.js';

describe.skipIf(process.env.FLEET_GEN_BASELINE !== '1')('generate long-dwell legacy baseline', () => {
  it('writes tests/fixtures/longdwell-legacy-baseline.json', () => {
    const texts = readTexts();
    for (const t of Object.values(texts)) expect(t).not.toMatch(/durable-gate/);   // must be the unmodified base
    const out = hashBlocks(texts, false);
    expect(Object.keys(out)).toEqual(Object.keys(BLOCKS));
    const file = fileURLToPath(new URL('./fixtures/longdwell-legacy-baseline.json', import.meta.url));
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  });
});
