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

async function bundle(rel, plugins = []) {
  const esbuild = loadEsbuild();
  const r = await esbuild.build({
    entryPoints: [path.join(ROOT, rel)], bundle: true, write: false, format: 'esm', platform: 'browser',
    loader: { '.css': 'empty' }, logLevel: 'silent', plugins,
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
    // FEAT-B1: the Studio devices module (reached only through the area-gated dynamic import of
    // views/zoom-hub.js) references mediaDevices lazily inside functions. esbuild inlines dynamic
    // imports, so keep that import external here: the boot gate and its static deps must stay clean.
    const externalView = {
      name: 'external-view',
      setup(b) {
        b.onResolve({ filter: /^\.\/zoom-hub\.js$/ }, (a) => (/zoom-hub-boot\.js$/.test(a.importer) ? { path: a.path, external: true } : undefined));
      },
    };
    const out = await bundle('renderer/src/js/views/zoom-hub-boot.js', [externalView]);
    expect(out).toContain('./zoom-hub.js');
    expect(out).not.toContain('mediaDevices');
  }, 60000);
  it('FEAT-B1: views/zoom-hub.js bundles the real Studio panel (honesty banner, no forbidden phrase)', async () => {
    const out = await bundle('renderer/src/js/views/zoom-hub.js');
    expect(out).toContain('zs-honesty');
    expect(out).toContain("Zoom can't see this video.");
  }, 60000);
  it('OBS: the hub bundle keeps the OFF HONESTY_BANNER and OBS_NOTE_FOUND and contains no forbidden phrase', async () => {
    const out = await bundle('renderer/src/js/views/zoom-hub.js');
    const L = await import('../renderer/src/js/zoom/studio-logic.js');
    const O = await import('../renderer/src/js/zoom/obs-logic.js');
    // esbuild may re-quote string literals, so compare on JSON-escaped / plain forms of the copy.
    const has = (s) => out.includes(s) || out.includes(JSON.stringify(s).slice(1, -1)) || out.includes(s.replace(/'/g, "\\'"));
    expect(has(L.HONESTY_BANNER)).toBe(true);
    expect(has(L.OBS_NOTE_FOUND)).toBe(true);
    expect(has(O.HONESTY_BANNER_OBS)).toBe(true);
    expect(out).toContain('obs-feed');
    for (const bad of ['Go live', 'Send to Zoom', 'Virtual camera: on']) expect(out.toLowerCase()).not.toContain(bad.toLowerCase());
  }, 60000);
});
