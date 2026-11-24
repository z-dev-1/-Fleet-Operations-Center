// tests/aperia-ai-privacy.test.js — the private Aperia tire block reaches Orcha's prompt only on Z's own
// surfaces (FAB, Just Me) and never on a no-source call or a context turn; plus static isolation checks that
// no partner / team / carrier surface imports src/aperia/ai-context.js. Real src/ipc/ai.js via the harness.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'aperia-ai-privacy-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const { install, ROOT } = require('./helpers/orcha-action-harness.cjs');

const HEADER = '=== APERIA TIRE DATA (PRIVATE to Z';
const UNIT = {
  id: '1', fleetVehicleId: '208336', domicile: 'ABE40', gps: null, gpsReason: 'MISSING', issues: [],
  tires: [{ position: 'L1IC', shortPosition: 'L1I', positionName: 'Left Steer', pressure: 97, setPoint: 110, deltaPsi: -13, temperatureF: 51.8, readAtEt: '11/23/2026, 8:10 PM EST', flag: 'LOW' }],
};

let h; let spies;
function setup() {
  spies = {
    status: vi.fn(() => ({ ok: true, state: 'connected' })),
    lookupUnit: vi.fn(async () => ({ ok: true, unit: UNIT })),
    listIssues: vi.fn(async () => ({ ok: true, rows: [] })),
  };
  h = install({
    fakes: {
      'src/aperia/session.js': { status: spies.status },
      'src/aperia/client.js': { lookupUnit: spies.lookupUnit, listIssues: spies.listIssues, crossLinkCriticalNoCase: () => [] },
      'src/aperia/sync-read.js': { cached: () => null },
      'src/dtna/store.js': { all: () => [] },
    },
  });
}
const prompt = () => h.relayCalls[0].prompt;

beforeEach(() => { vi.setSystemTime(new Date(2026, 10, 23, 21, 0, 0)); setup(); });
afterEach(() => { if (h) h.restore(); h = null; vi.useRealTimers(); });

describe('Aperia block in processOrchaAction', () => {
  for (const source of ['fab', 'slack-justme']) {
    it(source + ': a tire question gets the private block with the unit tires', async () => {
      const r = await h.ai.processOrchaAction('what is the tire pressure on 208336?', { source });
      expect(r.ok).toBe(true);
      expect(prompt()).toContain(HEADER);
      expect(prompt()).toContain('Left Steer (L1I) | 97 PSI | target 110 | delta -13 | 51.8 \u00b0F | 11/23/2026, 8:10 PM EST | LOW');
      expect(spies.lookupUnit).toHaveBeenCalledTimes(1);
    });
  }

  it('fab: a non-tire question gets no block and no Aperia call', async () => {
    await h.ai.processOrchaAction('what is the status of 208336?', { source: 'fab' });
    expect(prompt()).not.toContain(HEADER);
    expect(spies.status).not.toHaveBeenCalled();
  });

  it('no source: no block and no Aperia call', async () => {
    await h.ai.processOrchaAction('what is the tire pressure on 208336?', {});
    expect(prompt()).not.toContain(HEADER);
    expect(spies.status).not.toHaveBeenCalled();
    expect(spies.lookupUnit).not.toHaveBeenCalled();
  });

  it('context turn (Just Me with shared content): no block and no Aperia call', async () => {
    await h.ai.processOrchaAction('what tire psi does this say?', {
      source: 'slack-justme', requestId: 'jm1',
      untrustedContext: { typedText: 'what tire psi does this say?', items: [{ id: 'c1', source: 'file', kind: 'pdf', label: 'r.pdf', status: 'read', text: 'doc body', meta: {} }] },
    });
    expect(h.relayCalls.length).toBe(1);
    expect(prompt()).not.toContain(HEADER);
    expect(spies.status).not.toHaveBeenCalled();
  });
});

describe('static isolation', () => {
  const SRC = path.join(ROOT, 'src');
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((f) => {
    const p = path.join(d, f.name);
    return f.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
  }) : []);
  const scrapers = fs.readdirSync(path.join(SRC, 'scrapers')).filter((f) => /^carrier_briefing.*\.js$/.test(f)).map((f) => path.join(SRC, 'scrapers', f));
  const files = [
    path.join(SRC, 'orcha', 'ai-context.js'),
    path.join(SRC, 'scrapers', 'slack_channel_watch.js'),
    path.join(SRC, 'scrapers', 'slack_dm_autoreply.js'),
  ].filter((p) => fs.existsSync(p))
    .concat(walk(path.join(SRC, 'orcha', 'fas')), walk(path.join(SRC, 'ai', 'tools')), walk(path.join(SRC, 'carrier-intel')), scrapers);

  it('partner / team / carrier surfaces never import aperia/ai-context', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(scrapers.length).toBeGreaterThan(0);
    expect(files.filter((p) => fs.readFileSync(p, 'utf8').includes('aperia/ai-context')).map((p) => path.relative(ROOT, p))).toEqual([]);
  });

  it('src/aperia/ai-context.js never reaches Slack or the share path', () => {
    const t = fs.readFileSync(path.join(SRC, 'aperia', 'ai-context.js'), 'utf8');
    expect(t).not.toContain('slack_send');
    expect(t).not.toContain("'./share'");
    expect(t).not.toContain('scrapers/');
  });

  it('src/ipc/ai.js is the only module that injects the block', () => {
    const users = walk(SRC).filter((p) => !p.endsWith(path.join('aperia', 'ai-context.js')) && fs.readFileSync(p, 'utf8').includes('aperia/ai-context'));
    expect(users.map((p) => path.relative(SRC, p).replace(/\\/g, '/'))).toEqual(['ipc/ai.js']);
  });
});
