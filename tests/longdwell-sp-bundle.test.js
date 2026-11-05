// tests/longdwell-sp-bundle.test.js - the renderer entry that hosts the Long
// Dwell weekly sheet panel still bundles: esbuild resolves every import of
// analytics.js (including the new views/longdwell-sp.js) for the browser.
import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEsbuild() {
  try { return require('esbuild'); } catch (e) {
    throw new Error('esbuild could not be resolved (it ships with vite); run npm install. Cause: ' + (e && e.code));
  }
}

async function bundle(rel) {
  const esbuild = loadEsbuild();
  const r = await esbuild.build({
    entryPoints: [path.join(ROOT, rel)], bundle: true, write: false, format: 'esm', platform: 'browser',
    loader: { '.css': 'empty' }, logLevel: 'silent',
  });
  expect(r.errors).toEqual([]);
  return r.outputFiles.map((f) => f.text).join('\n');
}

describe('esbuild bundle', () => {
  it('analytics.js bundles and contains the sheet panel mount and host id', async () => {
    const out = await bundle('renderer/src/js/views/analytics.js');
    expect(out).toContain('longDwellSp');
    expect(out).toContain('an-ld-sp-host');
  }, 60000);
  it('views/longdwell-sp.js bundles on its own', async () => {
    const out = await bundle('renderer/src/js/views/longdwell-sp.js');
    expect(out).toContain('an-ld-sp-host');
    expect(out).toContain('an-ld-sp-pane');
  }, 60000);
});
