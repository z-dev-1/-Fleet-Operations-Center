// DBR_LOOKUP through the REAL Just Me runner (slack_channel_watch.js) and the REAL
// processOrchaAction (plan.md D8): exactly one sendToChannel and one reply-log
// entry per message, no intent AI call, and no duplicate or missed reply over a
// two-message sequence.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'dbr-lookup-slack-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const { installWatchFakes } = require('./helpers/justme-watch-harness.cjs');

const S = installWatchFakes({ realAi: true });
const ROOT = path.resolve(__dirname, '..');
const relayPath = require.resolve(path.join(ROOT, 'src', 'orcha', 'relay'));
const FLEET = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dbr-lookup', 'fleet-rows.json'), 'utf8'));
const REVIEW_JSON = JSON.stringify({ trends: '6 OOS', barriers: 'Parts delay', expectedFlips: '1', actions: 'Follow up', helpNeeded: 'No help needed' });
const ME = 'ME';

let watch, awtCalls;
beforeEach(() => {
  S.reset();
  S.seedChannel('1000.000000');
  S.data.fleetData = { rows: FLEET.rows, syncedAt: new Date(Date.now() - 3600000).toISOString() };
  S.poa = S.realAi.processOrchaAction;
  awtCalls = [];
  Object.assign(require.cache[relayPath].exports, {
    askWithTimeout: async (p, o) => { awtCalls.push({ prompt: p, opts: o }); return REVIEW_JSON; },
  });
  watch = S.loadWatch();
  process.env.FLEET_AI_DBR_LOOKUP = '1';
});
afterEach(() => { process.env.FLEET_AI_DBR_LOOKUP = '0'; });

describe('DBR lookup via the Just Me runner', () => {
  it('one message → exactly one tagged reply, one reply-log entry, no intent AI call', async () => {
    await S.run(watch, [{ ts: '1001.0', text: 'dbr for AUVTE', userId: ME }]);
    expect(S.poaCalls).toHaveLength(1);
    expect(S.poaCalls[0][1].source).toBe('slack-justme');
    expect(S.relayCalls).toHaveLength(0);
    expect(awtCalls).toHaveLength(1);
    expect(awtCalls[0].opts).toMatchObject({ source: 'dbr_lookup', priority: 'high' });
    expect(S.sent).toHaveLength(1);
    expect(S.sent[0].text.startsWith('<@ME> *DBR — AUVTE* (domicile)')).toBe(true);
    expect(S.replyLog()).toHaveLength(1);
    expect(S.data.slackChannelWatchConfig.channels[0].lastSeenTs).toBe('1001.0');
  });
  it('two messages → two replies total (no duplicate, no miss)', async () => {
    await S.run(watch, [{ ts: '1001.0', text: 'dbr for AUVTE', userId: ME }]);
    await S.run(watch, [{ ts: '1002.0', text: 'dbr for OAK-W', userId: ME }]);
    expect(S.sent).toHaveLength(2);
    expect(S.sent[0].text.startsWith('<@ME> *DBR — AUVTE*')).toBe(true);
    expect(S.sent[1].text.startsWith('<@ME> *DBR — OAK-W*')).toBe(true);
    expect(S.replyLog()).toHaveLength(2);
    expect(S.relayCalls).toHaveLength(0);
    expect(S.data.slackChannelWatchConfig.channels[0].lastSeenTs).toBe('1002.0');
  });
});
