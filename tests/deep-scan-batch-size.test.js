// tests/deep-scan-batch-size.test.js — deepScanBatchSize() helper
// (src/orcha/deep-scan.js, perf.deepScanMatchPool).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'ds-batch-size-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const { deepScanBatchSize, DS_BATCH_SIZE } = require('../src/orcha/deep-scan');

describe('deepScanBatchSize', () => {
  it('base is 3', () => { expect(DS_BATCH_SIZE).toBe(3); });
  it('flag off -> base, whatever the lane / pool', () => {
    for (const orchaUp of [true, false]) {
      for (const poolSize of [0, 1, 2, 5, undefined]) {
        expect(deepScanBatchSize({ matchPool: false, orchaUp, poolSize })).toBe(3);
      }
    }
  });
  it('Orcha up -> base even with the flag on', () => {
    expect(deepScanBatchSize({ matchPool: true, orchaUp: true, poolSize: 1 })).toBe(3);
  });
  it('Orcha down + flag on -> capped to the Claude pool, never above base', () => {
    expect(deepScanBatchSize({ matchPool: true, orchaUp: false, poolSize: 1 })).toBe(1);
    expect(deepScanBatchSize({ matchPool: true, orchaUp: false, poolSize: 2 })).toBe(2);
    expect(deepScanBatchSize({ matchPool: true, orchaUp: false, poolSize: 3 })).toBe(3);
    expect(deepScanBatchSize({ matchPool: true, orchaUp: false, poolSize: 5 })).toBe(3);
  });
  it('bad pool sizes -> 1', () => {
    for (const poolSize of [0, NaN, undefined, null, 'x', -2]) {
      expect(deepScanBatchSize({ matchPool: true, orchaUp: false, poolSize })).toBe(1);
    }
  });
  it('custom base', () => {
    expect(deepScanBatchSize({ base: 4, matchPool: true, orchaUp: false, poolSize: 2 })).toBe(2);
    expect(deepScanBatchSize({ base: 4, matchPool: false, orchaUp: false, poolSize: 2 })).toBe(4);
  });
});
