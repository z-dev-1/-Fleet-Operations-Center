import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-threadcount-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);
const store = require('../src/store');

afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('slackDMThreadReplyCount restart recovery', () => {
  it('restores the persisted thread-reply baseline at module load', () => {
    // Simulate a prior session having saved a baseline.
    store.save('slackDMThreadReplyCount', { 'C1:100.1': 3, 'C2:200.2': 1 });
    // Fresh module load (as on app restart).
    const resolved = require.resolve('../src/scrapers/slack_dm_autoreply.js');
    delete require.cache[resolved];
    const mod = require('../src/scrapers/slack_dm_autoreply.js');
    const restored = mod._getThreadReplyCountForTest();
    expect(restored['C1:100.1']).toBe(3);
    expect(restored['C2:200.2']).toBe(1);
  });

  it('defaults to empty object when nothing was persisted', () => {
    store.save('slackDMThreadReplyCount', null);
    const resolved = require.resolve('../src/scrapers/slack_dm_autoreply.js');
    delete require.cache[resolved];
    const mod = require('../src/scrapers/slack_dm_autoreply.js');
    expect(mod._getThreadReplyCountForTest()).toEqual({});
  });
});
