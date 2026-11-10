// FEAT-A1 / AC-3: the six Zoom store keys resolve to .json files under the data dir; none is SQLite-backed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const KEYS = {
  zoomLinks: 'zoom_links.json',
  zoomSummaries: 'zoom_summaries.json',
  zoomStudioPresets: 'zoom_studio_presets.json',
  zoomStudioLibrary: 'zoom_studio_library.json',
  zoomStudioConfig: 'zoom_studio_config.json',
  zoomStudioObs: 'zoom_studio_obs.json',
};

let tmp;
let store;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-store-'));
  require('../src/config/paths').setDataDir(tmp);
  store = require('../src/store');
});
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

describe('Zoom REGISTRY keys', () => {
  for (const [k, file] of Object.entries(KEYS)) {
    it(k + ' -> ' + file + ' under the data dir (JSON, not SQLite)', () => {
      store.save(k, { version: 1 });
      expect(fs.existsSync(path.join(tmp, file))).toBe(true);
      expect(store.load(k, null)).toEqual({ version: 1 });
      const r = store.update(k, (cur) => Object.assign({}, cur, { n: 1 }), { version: 1 });
      expect(r === undefined || r === null || typeof r === 'object').toBe(true);
      expect(store.load(k, null)).toMatchObject({ version: 1, n: 1 });
    });
  }

  it('no Zoom key is in SQLITE_KEYS', () => {
    for (const [k, file] of Object.entries(KEYS)) {
      expect(store.SQLITE_KEYS.has(k)).toBe(false);
      expect(store.REGISTRY[k]()).toBe(path.join(tmp, file));
    }
    const src = fs.readFileSync(require.resolve('../src/store/index.js'), 'utf8');
    const m = /const SQLITE_KEYS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(m).toBeTruthy();
    for (const k of Object.keys(KEYS)) expect(m[1].includes("'" + k + "'")).toBe(false);
  });
});
