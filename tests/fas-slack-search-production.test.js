import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-slacksearch-prod-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const { searchSlack, _loadLocalIndex } = require('../src/orcha/fas/slack-search');
const profiles = require('../src/orcha/fas/sender-profiles');

const internal = () => ({ type: 'internal', operators: [], domiciles: [], allowedDataCategories: profiles.DATA_CATEGORIES.slice() });

// PRODUCTION-SHAPE records exactly as _appendReplyLog writes them in
// slack_dm_autoreply.js / slack_channel_watch.js: incoming under `question`,
// sent reply under `reply`, `replyTs`, `channelName`, `ts`.
function seedProductionLogs() {
  store.save('slackDMReplies', [
    { id: 'C1:100.1', channelId: 'C1', channelName: 'Donte (DM)', ts: '100.1', replyTs: '100.5',
      question: 'any update on 320160?', reply: '320160 is at Amerit, parts ordered.',
      inScope: true, senderName: 'Donte', operator: 'TUZR', createdAt: new Date().toISOString(), status: 'auto-answered' },
    { id: 'C1:200.1', channelId: 'C1', channelName: 'Donte (DM)', ts: '200.1', replyTs: null,
      question: 'is 622072 ready to dispatch?', reply: '(queued for FAS approval)',
      inScope: true, senderName: 'Donte', operator: 'SAPB', createdAt: new Date().toISOString(), status: 'fas-queued' },
  ]);
  store.save('slackChannelReplies', [
    { id: 'CH1:300.1', channelId: 'CH1', channelName: '#mmfm-predictive', ts: '300.1', replyTs: '300.9',
      question: 'grounding date for 322136?', reply: 'Acknowledged — will align within 24h.',
      wasMentioned: true, senderName: 'MCS', operator: 'TUZR', createdAt: new Date().toISOString() },
  ]);
  store.save('slackMentionThreads', {});
}

beforeEach(() => { seedProductionLogs(); });
afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('Part 10: Slack search over REAL production reply-log shapes', () => {
  it('indexes the incoming question (stored under `question`)', () => {
    const idx = _loadLocalIndex();
    // Each answered DM record yields an incoming + a reply entry.
    expect(idx.some(e => e.kind === 'incoming' && /update on 320160/.test(e.text))).toBe(true);
    expect(idx.some(e => e.kind === 'reply' && /at Amerit/.test(e.text))).toBe(true);
  });

  it('finds a unit by searching the incoming question content', () => {
    const r = searchSlack({ unit: '320160' }, internal(), {}); // no injected index -> uses store
    expect(r.ok).toBe(true);
    expect(r.results.length).toBeGreaterThanOrEqual(1);
    const incoming = r.results.find(x => x.kind === 'incoming');
    expect(incoming).toBeTruthy();
    expect(incoming.excerpt).toMatch(/320160/);
    expect(incoming.sender).toBe('Donte');
    expect(incoming.channel).toBe('Donte (DM)');
  });

  it('labels our sent reply separately from the incoming question', () => {
    const r = searchSlack({ keywords: 'Amerit' }, internal(), {});
    const reply = r.results.find(x => x.kind === 'reply');
    expect(reply).toBeTruthy();
    expect(reply.excerpt).toMatch(/Amerit/);
    expect(reply.source).toMatch(/reply/);
  });

  it('searches channel reply logs too', () => {
    const r = searchSlack({ unit: '322136' }, internal(), {});
    expect(r.results.some(x => /322136/.test(x.excerpt))).toBe(true);
    expect(r.results.some(x => x.channel === '#mmfm-predictive')).toBe(true);
  });

  it('re-filters by requesting sender scope on production records', () => {
    const carrierSAPB = { type: 'carrier', operators: ['SAPB'], domiciles: [], allowedDataCategories: ['unit_status'] };
    // SAPB carrier searching a TUZR-tagged 320160 message -> excluded.
    const r = searchSlack({ unit: '320160' }, carrierSAPB, {});
    expect(r.results.length).toBe(0);
    // But can see their own SAPB 622072 message.
    const own = searchSlack({ unit: '622072' }, carrierSAPB, {});
    expect(own.results.some(x => /622072/.test(x.excerpt))).toBe(true);
  });
});
