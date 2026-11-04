import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const uptake = require('../src/scrapers/uptake');

// renderHeaderedShot must NOT load a unique `data:` URL per screenshot.
// Chromium persists zoom per "host" and a data: URL's whole text becomes the
// key, which grew the profile Preferences file to 75 MB (1,115 keys). It now
// renders from ONE fixed file path, so every screenshot shares one zoom key.

function fakeFs() {
  const files = new Map();
  return {
    files,
    writes: [],
    writeFileSync(p, data) { files.set(p, data); this.writes.push(p); },
    unlinkSync(p) { if (!files.has(p)) throw new Error('ENOENT'); files.delete(p); },
  };
}

function fakeWin(loaded, pngBytes = 5000) {
  let size = [900, 900];
  return {
    isDestroyed: () => false,
    loadURL: async (u) => { loaded.push({ kind: 'url', u }); },
    loadFile: async (p) => { loaded.push({ kind: 'file', p }); },
    getSize: () => size,
    setSize: (w, h) => { size = [w, h]; },
    webContents: {
      executeJavaScript: async () => 1200,
      capturePage: async () => ({ toPNG: () => Buffer.alloc(pngBytes, 1) }),
    },
  };
}

const deps = (fs, extra) => Object.assign({ fs, sleep: async () => {}, renderFile: 'C:\\tmp\\render.html', screenshotsDir: 'C:\\shots' }, extra);
const H = { title: 'Low Coolant <b>', status: 'OPEN', summary: 'x', recommended: 'a\nb', _label: 'U1_0' };

describe('uptake renderHeaderedShot — no per-screenshot data: URL', () => {
  it('loads the same fixed file for every screenshot, never a data: URL', async () => {
    const fs = fakeFs(); const loaded = [];
    const win = fakeWin(loaded);
    await uptake._renderHeaderedShot(win, 'QUJD', H, deps(fs));
    await uptake._renderHeaderedShot(win, 'REVG', { ...H, _label: 'U1_1' }, deps(fs));
    expect(loaded).toHaveLength(2);
    expect(loaded.every((l) => l.kind === 'file')).toBe(true);
    expect(new Set(loaded.map((l) => l.p)).size).toBe(1);
    expect(loaded[0].p).toBe('C:\\tmp\\render.html');
  });

  it('writes the HTML (escaped, with the chart) to the render file, then removes it', async () => {
    const fs = fakeFs(); const loaded = [];
    let htmlSeen = '';
    const win = fakeWin(loaded);
    win.loadFile = async (p) => { htmlSeen = fs.files.get(p); loaded.push({ kind: 'file', p }); };
    const out = await uptake._renderHeaderedShot(win, 'QUJD', H, deps(fs));
    expect(htmlSeen).toContain('data:image/png;base64,QUJD');
    expect(htmlSeen).toContain('Low Coolant &lt;b&gt;');
    expect(fs.files.has('C:\\tmp\\render.html')).toBe(false);   // cleaned up
    expect(out).toBe(require('path').join('C:\\shots', 'uptake_insight_U1_0.png'));
    expect(fs.files.has(out)).toBe(true);                         // PNG saved
  });

  it('still cleans up the render file and returns null when the capture is too small', async () => {
    const fs = fakeFs(); const loaded = [];
    const out = await uptake._renderHeaderedShot(fakeWin(loaded, 100), 'QUJD', H, deps(fs));
    expect(out).toBeNull();
    expect(fs.files.has('C:\\tmp\\render.html')).toBe(false);
  });

  it('returns null without touching anything when the window is destroyed', async () => {
    const fs = fakeFs();
    const out = await uptake._renderHeaderedShot({ isDestroyed: () => true }, 'QUJD', H, deps(fs));
    expect(out).toBeNull();
    expect(fs.writes).toHaveLength(0);
  });
});

describe('uptake "no change, no new picture" key', () => {
  const ins = { _insightId: 'ins-1', title: 'Low Coolant', status: 'OPEN', subsystem: 'Cooling',
    firstSeen: '2026-10-01T05:00:00Z', lastSeen: '2026-10-30T05:00:00Z', summary: 'Trending low', recommended: 'Top off' };

  it('is the same for identical content, even when lastSeen moves forward', () => {
    const a = uptake.insightShotKey('322504', ins, 'QUJD');
    const b = uptake.insightShotKey('322504', { ...ins, lastSeen: '2026-10-31T09:00:00Z' }, 'QUJD');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when anything shown in the picture changes', () => {
    const base = uptake.insightShotKey('322504', ins, 'QUJD');
    expect(uptake.insightShotKey('322504', { ...ins, status: 'CLOSED' }, 'QUJD')).not.toBe(base);
    expect(uptake.insightShotKey('322504', { ...ins, summary: 'Now critical' }, 'QUJD')).not.toBe(base);
    expect(uptake.insightShotKey('322504', { ...ins, recommended: 'Replace pump' }, 'QUJD')).not.toBe(base);
    expect(uptake.insightShotKey('322504', ins, 'REVG')).not.toBe(base);          // chart changed
    expect(uptake.insightShotKey('324040', ins, 'QUJD')).not.toBe(base);          // other unit
    expect(uptake.insightShotKey('322504', { ...ins, _insightId: 'ins-2' }, 'QUJD')).not.toBe(base);
  });

  it('distinguishes a no-chart key from a chart key', () => {
    expect(uptake.insightShotKey('322504', ins, null)).not.toBe(uptake.insightShotKey('322504', ins, 'QUJD'));
  });

  it('builds a stable, filesystem-safe path per unit + key', () => {
    const p = uptake.insightShotPath('B6/20:49', 'abc123', 'C:\\shots');
    expect(p).toBe(require('path').join('C:\\shots', 'uptake_insight_B6_20_49_abc123.png'));
  });

  it('reuses an existing picture and refreshes its date so 7-day retention keeps it', () => {
    const touched = [];
    const f = { existsSync: (p) => p === 'C:\\shots\\x.png', utimesSync: (p) => touched.push(p) };
    expect(uptake.reuseInsightShot('C:\\shots\\x.png', f)).toBe(true);
    expect(touched).toEqual(['C:\\shots\\x.png']);
    expect(uptake.reuseInsightShot('C:\\shots\\missing.png', f)).toBe(false);
  });
});
