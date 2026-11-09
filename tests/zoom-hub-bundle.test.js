// FEAT-A1 / AC-20: the Zoom hub renderer modules bundle for the browser (longdwell-sp-bundle pattern).
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

describe('esbuild bundle (Zoom hub)', () => {
  it('views/zoom-hub.js bundles with its stub panels and the connection card', async () => {
    const out = await bundle('renderer/src/js/views/zoom-hub.js');
    expect(out).toContain('view-zoom');
    expect(out).toContain('Not available yet.');
    expect(out).toContain('zoom-hub.css');
    for (const bad of ['Go live', 'Send to Zoom', 'Virtual camera: on']) expect(out).not.toContain(bad);
  }, 60000);
  it('app.js bundles with the boot gate', async () => {
    const out = await bundle('renderer/src/js/app.js');
    expect(out).toContain('zoom-hub-boot');
  }, 60000);
  it('views/zoom-hub-boot.js bundles and never references navigator.mediaDevices', async () => {
    const out = await bundle('renderer/src/js/views/zoom-hub-boot.js');
    expect(out).not.toContain('mediaDevices');
  }, 60000);
});
