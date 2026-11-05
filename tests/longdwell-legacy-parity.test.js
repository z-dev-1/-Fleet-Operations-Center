// tests/longdwell-legacy-parity.test.js — flag-off parity for the renderer half
// of the durable Long Dwell AI Fill. The legacy fill functions in
// views/analytics.js and views/longdwell-csv.js must stay textually identical
// to base d8ac226 apart from single lines marked `// durable-gate` and the
// `opts /* durable-gate */` parameter line. Golden:
// tests/fixtures/longdwell-legacy-baseline.json (tests/longdwell-legacy-baseline.gen.test.js).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { hashBlocks, readTexts, stripGates, ANALYTICS, CSV } from './helpers/longdwell-legacy-src.js';

const GOLDEN = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/longdwell-legacy-baseline.json', import.meta.url)), 'utf8'));

describe('long-dwell legacy AI Fill text parity', () => {
  it('golden covers the five legacy blocks', () => {
    expect(Object.keys(GOLDEN).sort()).toEqual([
      'analytics.js#_aiFillRow', 'analytics.js#_runFillForRows', 'analytics.js#an-ld-fill-all',
      'longdwell-csv.js#_aiFillAll', 'longdwell-csv.js#_aiFillRow',
    ]);
  });

  it('legacy functions equal the base once the marked gates are removed', () => {
    expect(hashBlocks(readTexts(), true)).toEqual(GOLDEN);
  });

  it('the gates are actually present (durable branches are wired)', () => {
    const t = readTexts();
    expect(t[ANALYTICS]).toMatch(/opts \/\* durable-gate \*\//);
    expect(t[CSV]).toMatch(/opts \/\* durable-gate \*\//);
    expect((t[ANALYTICS].match(/\/\/ durable-gate\r?$/gm) || []).length).toBeGreaterThanOrEqual(3);
    expect((t[CSV].match(/\/\/ durable-gate\r?$/gm) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('an unmarked legacy edit fails parity', () => {
    const t = readTexts();
    const mutated = {
      [ANALYTICS]: t[ANALYTICS].replace("toast.show('success', `AI filled ${done} row(s)`, 2500);", "toast.show('success', `AI filled ${done} rows`, 2500);"),
      [CSV]: t[CSV],
    };
    expect(mutated[ANALYTICS]).not.toBe(t[ANALYTICS]);
    expect(hashBlocks(mutated, true)['analytics.js#_runFillForRows']).not.toBe(GOLDEN['analytics.js#_runFillForRows']);
    // a gate-looking line WITHOUT the marker is not stripped
    const csvMut = t[CSV].replace('  if (await _durableFill(btn)) return; // durable-gate', '  if (await _durableFill(btn)) return;');
    expect(csvMut).not.toBe(t[CSV]);
    expect(hashBlocks({ [ANALYTICS]: t[ANALYTICS], [CSV]: csvMut }, true)['longdwell-csv.js#_aiFillAll']).not.toBe(GOLDEN['longdwell-csv.js#_aiFillAll']);
  });

  it('stripGates removes only marked lines and the marked parameter', () => {
    expect(stripGates('a(x, y,\n  opts /* durable-gate */) {\n  if (z) return; // durable-gate\n  keep();\n}'))
      .toBe('a(x, y) {\n  keep();\n}');
  });
});
