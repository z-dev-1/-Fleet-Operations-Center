// tests/history-wo-open.test.js — History tab "📋 Open": which URLs go left /
// right, the split view's vendor partition, and the URL allow-list. Pure
// helpers exported from the real unit-detail.js with its deps mocked.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../renderer/src/js/bridge.js', () => ({ notes: {}, ai: {}, aap: {}, relay: {}, vendor: {}, files: {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() {}, emit() {}, off() {} } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { get() {}, set() {}, on() {} } }));
vi.mock('../renderer/src/js/components/toast.js', () => ({ default: { show() {} } }));
vi.mock('../renderer/src/js/views/vendor-review-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/dealer-wo-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/wr-modal.js', () => ({ open() {}, readFileAsAttachment: async () => null }));

const m = await import('../renderer/src/js/views/unit-detail.js');

const RELAY = 'https://aap-na.corp.amazon.com/v2/service/W1';
const OFFSITE = 'https://aap-na.corp.amazon.com/v2/offsite-events/CASE1';
const DEALER = 'https://pssmfleet.decisiv.net/fleet/estimates/E1';
const UNIT_DEALER = 'https://volvopg.asist.decisiv.net/fleet/estimates/V1';
const entry = (refs, wo) => ({ workOrderId: wo || 'W1', sourceRefs: refs });

describe('historyOpenUrls', () => {
  it('dealer in refs → right dealer', () => {
    expect(m.historyOpenUrls(entry({ relay: RELAY, offsite: OFFSITE, dealer: DEALER }), {}))
      .toEqual({ left: RELAY, right: DEALER, rightKind: 'dealer' });
  });
  it('owned unit-row dealer (stamped and unstamped) → right dealer', () => {
    const refs = { relay: RELAY, offsite: OFFSITE };
    expect(m.historyOpenUrls(entry(refs), { _offsiteWrId: 'W1', workRequestId: 'W2', offsiteShopEventUrl: UNIT_DEALER }))
      .toEqual({ left: RELAY, right: UNIT_DEALER, rightKind: 'dealer' });
    expect(m.historyOpenUrls(entry(refs), { workRequestId: 'W1', savedOffsiteUrl: UNIT_DEALER }))
      .toEqual({ left: RELAY, right: UNIT_DEALER, rightKind: 'dealer' });
  });
  it('unit row not owned → offsite', () => {
    const refs = { relay: RELAY, offsite: OFFSITE };
    expect(m.historyOpenUrls(entry(refs), { _offsiteWrId: 'W9', workRequestId: 'W1', offsiteShopEventUrl: UNIT_DEALER }))
      .toEqual({ left: RELAY, right: OFFSITE, rightKind: 'offsite' });
    expect(m.historyOpenUrls(entry(refs), { workRequestId: 'W2', asistSrUrl: UNIT_DEALER }))
      .toEqual({ left: RELAY, right: OFFSITE, rightKind: 'offsite' });
  });
  it('owned unit row with an Amazon URL is not a dealer', () => {
    expect(m.historyOpenUrls(entry({ relay: RELAY, offsite: OFFSITE }), { workRequestId: 'W1', offsiteShopEventUrl: OFFSITE }))
      .toEqual({ left: RELAY, right: OFFSITE, rightKind: 'offsite' });
  });
  it('only offsite', () => {
    expect(m.historyOpenUrls(entry({ relay: null, offsite: OFFSITE }), null)).toEqual({ left: '', right: OFFSITE, rightKind: 'offsite' });
  });
  it("relay only → right ''", () => {
    expect(m.historyOpenUrls(entry({ relay: RELAY, offsite: null }), {})).toEqual({ left: RELAY, right: '', rightKind: 'none' });
  });
  it("nothing → both ''", () => {
    expect(m.historyOpenUrls(entry({}), {})).toEqual({ left: '', right: '', rightKind: 'none' });
    expect(m.historyOpenUrls({}, null)).toEqual({ left: '', right: '', rightKind: 'none' });
  });
  it('hostile refs.dealer dropped → falls back to offsite', () => {
    expect(m.historyOpenUrls(entry({ relay: RELAY, offsite: OFFSITE, dealer: DEALER + '" onload="x' }), {}))
      .toEqual({ left: RELAY, right: OFFSITE, rightKind: 'offsite' });
    expect(m.historyOpenUrls(entry({ relay: RELAY, offsite: OFFSITE, dealer: 'http://pssmfleet.decisiv.net/fleet/estimates/E1' }), {}))
      .toEqual({ left: RELAY, right: OFFSITE, rightKind: 'offsite' });
  });
});

describe('splitPartitionFor', () => {
  it.each([
    ['https://volvopg.asist.decisiv.net/fleet/estimates/V1', 'persist:vendor-volvo'],
    ['https://dtna.my.site.com/Servicetracker/s/case/C1', 'persist:vendor-dtna'],
    ['https://portal.daimlertruck.com/x', 'persist:vendor-dtna'],
    ['https://pssmfleet.decisiv.net/fleet/estimates/E1', 'persist:vendor-paccar-pssmfleet'],
    ['https://paccarpg.decisiv.net/service_requests/S1', 'persist:vendor-paccar'],
    ['https://unknown.example.com/x', 'persist:vendor-paccar'],
    ['https://aap-na.corp.amazon.com/v2/offsite-events/CASE1', ''],
  ])('%s → %s', (url, part) => {
    expect(m.splitPartitionFor(url)).toBe(part);
  });
});

describe('isSafeHistoryUrl', () => {
  it('accepts the allow-listed https hosts', () => {
    expect(m.isSafeHistoryUrl(RELAY)).toBe(true);
    expect(m.isSafeHistoryUrl(DEALER)).toBe(true);
    expect(m.isSafeHistoryUrl('https://dtna.my.site.com/Servicetracker/s/case/C1')).toBe(true);
  });
  it('rejects others', () => {
    expect(m.isSafeHistoryUrl('http://aap-na.corp.amazon.com/v2/service/W1')).toBe(false);
    expect(m.isSafeHistoryUrl('javascript:alert(1)')).toBe(false);
    expect(m.isSafeHistoryUrl('https://evil.example.com/x')).toBe(false);
    expect(m.isSafeHistoryUrl('https://decisiv.net.evil.com/x')).toBe(false);
    expect(m.isSafeHistoryUrl(RELAY + "'x")).toBe(false);
    expect(m.isSafeHistoryUrl(RELAY + ' x')).toBe(false);
    expect(m.isSafeHistoryUrl(RELAY + '<b>')).toBe(false);
    expect(m.isSafeHistoryUrl('not a url')).toBe(false);
    expect(m.isSafeHistoryUrl('')).toBe(false);
    expect(m.isSafeHistoryUrl(null)).toBe(false);
  });
});
