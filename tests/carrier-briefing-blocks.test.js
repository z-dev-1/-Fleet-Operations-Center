// Daily Carrier Briefing — Block Kit layout (approved spec): renderer structure,
// all down units shown, needs-your-action callout, PM/DOT window, carrier
// redaction (no names / $ / internal links), block budget, and the end-to-end
// send path (dedup, self-test, text-only fallback route, gating).
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'cb-blocks-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const R = require('../src/scrapers/carrier_briefing_blocks');

afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });

const TODAY = '2026-11-17';
const STATS_RE = /^\*Uptime\* \d+%   \|   \*Down\* \d+\/\d+   \|   \*ETC today\* \d+   \|   \*No ETC\* \d+$/;
const allText = (blocks) => {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.text === 'string') out.push(o.text);
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  blocks.forEach(walk);
  return out;
};

function downUnit(i, extra) {
  const sev = i % 3 === 0 ? 'red' : (i % 3 === 1 ? 'yellow' : 'white');
  return Object.assign({
    unit: 'GW' + String(100 + i), daysDown: 20 - i, vendor: 'Rush Truck Centers', issue: 'Brake chamber leak',
    estimateLabel: i % 2 ? 'Estimate approved' : '', etcIso: i === 1 ? TODAY : (i % 2 ? '2026-11-2' + (i % 9) : ''),
    etcState: '', nextStep: 'Dealer to finish repair', severity: sev, needsAction: false, actionText: '',
  }, extra || {});
}

function fixtureFacts(nDown) {
  const down = [];
  for (let i = 0; i < nDown; i++) down.push(downUnit(i));
  down[2] = downUnit(2, { needsAction: true, actionText: 'Impound fee must be paid by carrier before release' });
  down[5] = downUnit(5, { needsAction: true, actionText: 'Please confirm accident vendor' });
  return {
    operator: 'GWOP', totalUnits: 40, downCount: down.length, down,
    domiciles: [{ code: 'ABE40', location: 'Allentown, PA' }],
    pmDue: [
      { unit: 'GW900', items: [
        { type: 'DOT', dueIso: '2026-11-02', days: -15 },
        { type: 'PM_B', dueIso: '2026-12-02', days: 15 },
        { type: 'PM_A', dueIso: '2026-11-01', days: -16 },
      ] },
      { unit: 'GW901', items: [{ type: 'PM_X', dueIso: '2027-01-01', days: 45 }, { type: 'WASH', dueIso: '2026-11-01', days: -16 }] },
      { unit: 'GW902', items: [{ type: 'QUARTERLY_LIFT', dueIso: '2026-11-27', days: 10 }] },
      { unit: 'GW903', items: [{ type: 'QUARTERLY_LIFT', dueIso: '2027-02-15', days: 90 }] },
      { unit: 'GW904', items: [{ type: 'PM_X', dueIso: '2026-11-10', days: -7 }] },
    ],
  };
}
const CTX = {
  todayIso: TODAY, dateLabel: 'Tue, Nov 17', updatedLabel: '9:46 AM', ownerTag: '<@U_GW>',
  tip: 'Check tire pressure before every cold-morning departure.', contactUrl: 'https://amazon.enterprise.slack.com/team/UZ',
  testPreviewChannelId: '', includeDown: true, includeDomiciles: true,
};

describe('renderer', () => {
  const facts = fixtureFacts(14);
  const blocks = R.buildBriefingBlocks(facts, CTX);

  it('renders the approved layout in order', () => {
    expect(blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: '🚛 Daily Fleet Briefing — GWOP', emoji: true } });
    expect(blocks[1].type).toBe('context');
    expect(blocks[1].elements[0].text).toBe('<@U_GW>');
    expect(blocks[1].elements[1].text).toBe('Tue, Nov 17 · ABE40 (Allentown, PA) · updated 9:46 AM');
    expect(blocks[2].type).toBe('section');
    expect(blocks[2].fields).toBeUndefined();
    expect(blocks[2].text.text).toMatch(STATS_RE);
    expect(blocks[2].text.text).toBe('*Uptime* 65%   |   *Down* 14/40   |   *ETC today* 1   |   *No ETC* 7');
    expect(blocks[3].type).toBe('divider');
    expect(blocks[4].text.text).toBe('*Units down (12)*');
    for (let i = 5; i < 17; i++) expect(blocks[i].type).toBe('section');
    expect(blocks[17].type).toBe('divider');
    expect(blocks[18].text.text.startsWith('⚠️ *Needs your action*')).toBe(true);
    expect(blocks[19].type).toBe('divider');
    expect(blocks[20].text.text).toBe('*🔧 PM / DOT — schedule needed* _(PM-B · DOT · PM-X · Quarterly Lift — overdue, expired, or due ≤60 days)_');
    expect(blocks[21].type).toBe('section');
    expect(blocks[22]).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: '💡 Check tire pressure before every cold-morning departure.' }] });
    expect(blocks[23].type).toBe('actions');
    expect(blocks[23].elements).toHaveLength(1);
    expect(blocks[23].elements[0]).toMatchObject({ type: 'button', text: { type: 'plain_text', text: 'Questions? Message Z' } });
    expect(blocks[23].elements[0].url.startsWith('https://amazon.enterprise.slack.com/team/')).toBe(true);
    expect(blocks[23].elements[0].action_id).toBeUndefined();
    expect(blocks).toHaveLength(24);
  });

  it('shows ALL down units (no "N more" placeholder); action units only in the callout', () => {
    const unitSecs = blocks.slice(5, 17).map((b) => b.text.text);
    const listedIds = facts.down.filter((d) => !d.needsAction).map((d) => d.unit);
    expect(listedIds).toHaveLength(12);
    for (const id of listedIds) expect(unitSecs.filter((t) => t.includes('*' + id + '*'))).toHaveLength(1);
    for (const id of ['GW102', 'GW105']) {
      expect(unitSecs.some((t) => t.includes(id))).toBe(false);
      expect(blocks[18].text.text).toContain('*' + id + '*');
    }
    expect(blocks[18].text.text).toContain('Impound fee must be paid by carrier before release');
    expect(blocks[18].text.text).toContain('Please confirm accident vendor');
    for (const t of allText(blocks)) expect(t).not.toMatch(/\b\d+ more\b/);
  });

  it('each unit row has 3 lines with the right dot, sorted red → yellow → white', () => {
    const secs = blocks.slice(5, 17).map((b) => b.text.text);
    const dot = { red: '🔴', yellow: '🟡', white: '⚪' };
    let lastRank = -1;
    for (const t of secs) {
      const lines = t.split('\n');
      expect(lines).toHaveLength(3);
      const id = lines[0].match(/\*(GW\d+)\*/)[1];
      const d = facts.down.find((x) => x.unit === id);
      expect(lines[0].startsWith(dot[d.severity] + ' *' + id + '* · ' + d.daysDown + 'd · Rush Truck Centers')).toBe(true);
      expect(lines[2]).toMatch(/^\*(ETC [^*]+|No ETC)\* · next: Dealer to finish repair$/);
      const rank = ['red', 'yellow', 'white'].indexOf(d.severity);
      expect(rank).toBeGreaterThanOrEqual(lastRank);
      lastRank = rank;
    }
    expect(secs.find((t) => t.includes('*GW101*')).split('\n')[2].startsWith('*ETC today (Nov 17)*')).toBe(true);
  });

  it('PM / DOT: only PM-B, DOT, PM-X, Quarterly Lift within 60 days, grouped by urgency', () => {
    const pm = blocks[21].text.text;
    expect(pm).toContain('🔴 *Overdue / expired*\n• *GW900* — DOT expired Nov 2 · PM-B due Dec 2 (15d)\n• *GW904* — PM-X overdue 7d');
    expect(pm).toContain('🟡 *Due in ≤30 days*\n• *GW902* — Quarterly Lift due Nov 27 (10d)');
    expect(pm).toContain('⚪ *Due in 31–60 days*\n• *GW901* — PM-X due Jan 1 (45d)');
    expect(pm).not.toMatch(/PM-A|PM_A|Wash|WASH|GW903/);
    const labels = pm.match(/(PM-B|PM-X|DOT|Quarterly Lift|PM-A|Wash)(?= (due|overdue|expired))/g);
    expect(new Set(labels)).toEqual(new Set(['PM-B', 'PM-X', 'DOT', 'Quarterly Lift']));
    const b = R.__test__.pmBuckets(facts.pmDue);
    expect(b.red.map((u) => u.unit)).toEqual(['GW900', 'GW904']);
    expect(b.yellow.map((u) => u.unit)).toEqual(['GW902']);
    expect(b.white.map((u) => u.unit)).toEqual(['GW901']);
  });

  it('stays within Slack limits and has a text fallback', () => {
    expect(blocks.length).toBeLessThanOrEqual(R.MAX_BLOCKS);
    expect(JSON.stringify(blocks).length).toBeLessThanOrEqual(40000);
    for (const t of allText(blocks)) expect(t.length).toBeLessThanOrEqual(3000);
    const text = R.buildBriefingText(facts, CTX);
    expect(text).toBe('<@U_GW> 🚛 Daily Fleet Briefing — GWOP · Tue, Nov 17 — Uptime 65% · Down 14/40 · ETC today 1 · No ETC 7 · 2 need your action · 4 PM/DOT to schedule');
  });

  it('overflow edge case: caps rows and names every remaining unit', () => {
    const big = fixtureFacts(47); // 45 listed + 2 action units
    const bl = R.buildBriefingBlocks(big, CTX);
    expect(bl.length).toBeLessThanOrEqual(50);
    const unitSecs = bl.filter((b) => b.type === 'section' && /^(🔴|🟡|⚪) \*GW/.test(b.text.text));
    expect(unitSecs).toHaveLength(R.MAX_UNIT_ROWS);
    const listed = big.down.filter((d) => !d.needsAction);
    const shownIds = new Set(unitSecs.map((b) => b.text.text.match(/\*(GW\d+)\*/)[1]));
    const rest = listed.filter((d) => !shownIds.has(d.unit));
    expect(rest).toHaveLength(15);
    const over = bl.find((b) => b.type === 'context' && b.elements[0].text.startsWith('➕ '));
    expect(over.elements[0].text.startsWith('➕ 15 more down units: ')).toBe(true);
    for (const d of rest) expect(over.elements[0].text).toContain('*' + d.unit + '*');
    expect(bl[4].text.text).toBe('*Units down (45)*');
  });

  it('empty fleet, no tip, no contact url', () => {
    const bl = R.buildBriefingBlocks({ operator: 'GWOP', totalUnits: 5, downCount: 0, down: [], pmDue: [], domiciles: [] },
      Object.assign({}, CTX, { tip: '', contactUrl: '' }));
    const texts = allText(bl);
    expect(texts).toContain('*Units down (0)*\n✅ All units running.');
    expect(texts).toContain('_Nothing overdue or due in the next 60 days._');
    expect(texts).toContain('*Uptime* 100%   |   *Down* 0/5   |   *ETC today* 0   |   *No ETC* 0');
    expect(bl.some((b) => b.type === 'actions')).toBe(false);
    expect(texts.some((t) => t.startsWith('💡'))).toBe(false);
  });

  it('test preview adds a TEST context right after the header', () => {
    const bl = R.buildBriefingBlocks(facts, Object.assign({}, CTX, { testPreviewChannelId: 'C_GW' }));
    expect(bl[1]).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: '🧪 *TEST preview* — this would post to <#C_GW>' }] });
    expect(R.buildBriefingText(facts, Object.assign({}, CTX, { testPreviewChannelId: 'C_GW' })).startsWith('TEST preview: <@U_GW>')).toBe(true);
  });
});

describe('end-to-end sendOperatorBriefing', () => {
  const store = require('../src/store');
  const relay = require('../src/orcha/relay');
  const cb = require('../src/scrapers/carrier_briefing');
  const NAME = 'Christy Adriaansen - Kenworth Northeast Group (Service Advisor)';
  const AAP = 'https://aap-na.corp.amazon.com/v2/assets/123';
  const rows = [
    { equipmentId: 'A100', operator: 'GWOP', lifecycleState: 'Unavailable', domicileSite: 'ABE40', created: '2026-11-10T12:00:00Z',
      lifecycleReason: NAME + ': brake chamber replaced, estimate $4,210.30 approved',
      issueDetails: NAME + ': quoted $4,210.30 for brake chamber',
      repairTimeline: '11/12: ' + NAME + ' quoted $4,210.30',
      estimateStatus: 'approved', totalCost: '$4,210.30', subVendor: 'Kenworth Northeast Group', repairEtc: '2026-11-20',
      assetUrl: AAP, serviceUrl: AAP + '/service',
      pmSchedule: [
        { type: 'DOT', nextDueIso: '2026-11-10' }, { type: 'PM_B', nextDueIso: '2026-12-07' },
        { type: 'PM_X', nextDueIso: '2027-01-01' }, { type: 'QUARTERLY_LIFT', nextDueIso: '2027-02-15' },
        { type: 'PM_A', nextDueIso: '2026-11-01' }, { type: 'WASH', nextDueIso: '2026-11-01' },
      ] },
    { equipmentId: 'A101', operator: 'GWOP', lifecycleState: 'Unavailable', domicileSite: 'ABE40', created: '2026-11-12T12:00:00Z',
      lifecycleReason: 'Towed after breakdown; impound fee must be paid by carrier before release', subVendor: 'Speedy Towing',
      assetUrl: AAP },
    { equipmentId: 'A102', operator: 'GWOP', lifecycleState: 'Unavailable', domicileSite: 'ABE40', created: '2026-11-15T12:00:00Z',
      lifecycleReason: 'Accident damage to front bumper; please confirm accident vendor', assetUrl: AAP },
    { equipmentId: 'A103', operator: 'GWOP', lifecycleState: 'Unavailable', domicileSite: 'ABE40', created: '2026-11-14T12:00:00Z',
      lifecycleReason: 'Turbo actuator', partsStatus: 'Waiting on parts', vendor: 'Rush Truck Centers', assetUrl: AAP },
    { equipmentId: 'A104', operator: 'GWOP', lifecycleState: 'Unavailable', domicileSite: 'ABE40', created: '2026-10-28T12:00:00Z',
      lifecycleReason: 'Engine derate', issueDetails: 'Engine derate code, see https://relay.amazon.com/loads/9 and ' + AAP,
      vendor: 'TA', serviceUrl: AAP },
    { equipmentId: 'B200', operator: 'GWOP', lifecycleState: 'Available', domicileSite: 'ABE40', pmBDue: 'Nov 27, 2026' },
    { equipmentId: 'C300', operator: 'GWOP', lifecycleState: 'Available', domicileSite: 'ABE40' },
  ];
  let deps;
  const blocksOf = (call) => call[1];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T14:00:00Z'));
    store.save('operatorChannels', { operators: [{ operator: 'GWOP', channelId: 'C_GW', ownerId: 'U_GW' }] });
    store.save('carrierBriefingConfig', { enabled: true, tipEnabled: true });
    store.save('carrierBriefingLog', { sent: {}, recentTips: [] });
    store.save('fleetData', { rows: JSON.parse(JSON.stringify(rows)), syncedAt: '2026-11-17T13:30:00Z' });
    vi.spyOn(relay, 'askWithTimeout').mockResolvedValue('Check tire pressure before every cold-morning departure.');
    deps = {
      sendBlocksToChannel: vi.fn(async () => ({ ok: true, ts: '1.1' })),
      sendToChannel: vi.fn(async () => ({ ok: true, ts: '1.2' })),
      checkLiveAuth: vi.fn(async () => ({ authenticated: true, userId: 'UZ' })),
      openConversation: vi.fn(async () => 'D_SELF'),
    };
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('posts redacted Block Kit with no internal links, PM window, and action callout', async () => {
    const r = await cb.sendOperatorBriefing('GWOP', deps, {}, () => {});
    expect(r).toEqual({ sent: true, operator: 'GWOP', channelId: 'C_GW', aiWritten: true, testToSelf: false });
    expect(deps.sendToChannel).not.toHaveBeenCalled();
    expect(deps.sendBlocksToChannel).toHaveBeenCalledTimes(1);
    const [ch, blocks, text, o] = deps.sendBlocksToChannel.mock.calls[0];
    expect(ch).toBe('C_GW');
    expect(o).toEqual({ unfurl: false });
    expect(text.startsWith('<@U_GW> 🚛 Daily Fleet Briefing — GWOP')).toBe(true);
    const json = JSON.stringify(blocks);

    // Redaction: no $ figures or personal names; vendor / unit / estimate status / dates kept.
    expect(json).not.toMatch(/\$\s?\d/);
    expect(json).not.toMatch(/Christy|Adriaansen/);
    expect(json).toContain('Kenworth Northeast Group');
    expect(json).toContain('Estimate approved');
    expect(json).toContain('*ETC Nov 20*');
    for (const id of ['A100', 'A101', 'A102', 'A103', 'A104', 'B200']) expect(json).toContain('*' + id + '*');

    // No internal links: the only URL is the Slack contact button.
    expect(json).not.toMatch(/aap-na/);
    expect(json).not.toMatch(/https?:\/\/[^"\s]*relay/i);
    const urls = json.match(/https?:\/\/[^"\s<>|]+/g);
    expect(urls).toEqual(['https://amazon.enterprise.slack.com/team/UZ']);

    // PM / DOT.
    const pm = blocks[blocks.findIndex((b) => b.text && /^\*🔧 PM \/ DOT/.test(b.text.text)) + 1].text.text;
    expect(pm).toContain('• *A100* — DOT expired Nov 10 · PM-B due Dec 7 (20d) · PM-X due Jan 1 (45d)');
    expect(pm).toContain('• *B200* — PM-B due Nov 27 (10d)');
    expect(pm).not.toMatch(/Quarterly Lift|PM-A|Wash|C300/);

    // Needs your action: impound + accident units only there.
    const actIdx = blocks.findIndex((b) => b.text && b.text.text.startsWith('⚠️ *Needs your action*'));
    expect(blocks[actIdx].text.text).toContain('*A101*');
    expect(blocks[actIdx].text.text).toContain('*A102*');
    const unitRows = blocks.filter((b) => b.type === 'section' && /^(🔴|🟡|⚪) \*[A-Z]+\d+\*/.test(b.text.text)).map((b) => b.text.text);
    expect(unitRows).toHaveLength(3);
    expect(unitRows.some((t) => /A101|A102/.test(t))).toBe(false);
    expect(unitRows[0].startsWith('🔴 *A104* · 20d · TA')).toBe(true);
    expect(unitRows.find((t) => t.includes('*A103*')).startsWith('🟡 *A103* · 3d · Rush Truck Centers')).toBe(true);
    expect(unitRows.find((t) => t.includes('*A100*')).startsWith('⚪ *A100* · 7d · Kenworth Northeast Group')).toBe(true);
    expect(blocks.some((b) => b.text && b.text.text === '*Units down (3)*')).toBe(true);
    expect(blocks.find((b) => b.text && STATS_RE.test(b.text.text)).text.text)
      .toBe('*Uptime* 29%   |   *Down* 5/7   |   *ETC today* 0   |   *No ETC* 4');

    // Tip + totals.
    expect(json).toContain('💡 Check tire pressure before every cold-morning departure.');
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(text.length).toBeGreaterThan(0);
  });

  it('dedup: a second non-force send the same day posts nothing', async () => {
    await cb.sendOperatorBriefing('GWOP', deps, {}, () => {});
    const r2 = await cb.sendOperatorBriefing('GWOP', deps, {}, () => {});
    expect(r2).toEqual({ sent: false, reason: 'already-sent' });
    expect(deps.sendBlocksToChannel).toHaveBeenCalledTimes(1);
  });

  it('testToSelf posts to the self-DM with the TEST marker and records no dedup key', async () => {
    const r = await cb.sendOperatorBriefing('GWOP', deps, { testToSelf: true }, () => {});
    expect(r).toMatchObject({ sent: true, testToSelf: true, channelId: 'C_GW' });
    const call = deps.sendBlocksToChannel.mock.calls[0];
    expect(call[0]).toBe('D_SELF');
    expect(blocksOf(call)[1].elements[0].text).toBe('🧪 *TEST preview* — this would post to <#C_GW>');
    expect(call[2].startsWith('TEST preview: ')).toBe(true);
    expect(Object.keys(store.load('carrierBriefingLog', {}).sent || {})).toHaveLength(0);
  });

  it('deps without sendBlocksToChannel fall back to text-only sendToChannel', async () => {
    delete deps.sendBlocksToChannel;
    const r = await cb.sendOperatorBriefing('GWOP', deps, { force: true }, () => {});
    expect(r.sent).toBe(true);
    expect(deps.sendToChannel).toHaveBeenCalledTimes(1);
    const [ch, text] = deps.sendToChannel.mock.calls[0];
    expect(ch).toBe('C_GW');
    expect(text.startsWith('<@U_GW> 🚛 Daily Fleet Briefing — GWOP')).toBe(true);
  });

  it('deps with the real slack_send.sendToChannel only (ipc/ai.js shape) still post blocks', async () => {
    const ss = require('../src/scrapers/slack_send');
    const calls = [];
    ss._setRawRequestForTests((method, params) => { calls.push({ method, params }); return Promise.resolve({ ok: true, ts: '3.3' }); });
    ss._resetForTests();
    try {
      const r = await cb.sendOperatorBriefing('GWOP', { sendToChannel: ss.sendToChannel, checkLiveAuth: deps.checkLiveAuth }, { force: true }, () => {});
      expect(r.sent).toBe(true);
      const posts = calls.filter((c) => c.method === 'chat.postMessage');
      expect(posts).toHaveLength(1);
      expect(posts[0].params.channel).toBe('C_GW');
      expect(JSON.parse(posts[0].params.blocks)[0].text.text).toBe('🚛 Daily Fleet Briefing — GWOP');
      expect(posts[0].params.unfurl_links).toBe('false');
    } finally { ss._setRawRequestForTests(null); ss._resetForTests(); }
  });

  it('gating: disabled without force posts nothing', async () => {
    store.save('carrierBriefingConfig', { enabled: false });
    const r = await cb.runDailyBriefing(deps, {}, () => {});
    expect(r).toEqual({ ran: false, reason: 'disabled' });
    expect(deps.sendBlocksToChannel).not.toHaveBeenCalled();
    expect(deps.sendToChannel).not.toHaveBeenCalled();
  });

  it('tipEnabled:false skips the AI and the tip block', async () => {
    store.save('carrierBriefingConfig', { enabled: true, tipEnabled: false });
    const r = await cb.sendOperatorBriefing('GWOP', deps, {}, () => {});
    expect(r.aiWritten).toBe(false);
    expect(relay.askWithTimeout).not.toHaveBeenCalled();
    expect(JSON.stringify(deps.sendBlocksToChannel.mock.calls[0][1])).not.toContain('💡');
  });
});
