// wr-classify relayOpts forwarding (fix 1): a 2-argument call still gives
// relay.ask exactly one argument; a 3-argument call forwards the options.
// The store is faked through require.cache (never vi.mock of src/store).
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const storePath = require.resolve('../src/store');
require.cache[storePath] = {
  id: storePath, filename: storePath, loaded: true,
  exports: { load: (k, fb) => (k === 'fleetData' ? { rows: [{ equipmentId: 'U1', manufacturer: 'Volvo', domicileSite: 'ABE40', lifecycleState: 'IN_SERVICE' }] } : fb), save: () => {} },
};
const { classifyRequest } = require('../src/ipc/wr-classify');

const AI_JSON = JSON.stringify({ title: 'Brake repair needed', issue: 'Brakes worn.', area: 'Brakes', subcategory: 'x', vendor: '', urgent: false, severity: 'LOW', comments: '' });
const REQ = () => ({ unit: 'U1', issue: 'brakes grinding', site: 'ABE40' });

describe('classifyRequest relayOpts', () => {
  it('2-arg call: relay.ask receives exactly 1 argument', async () => {
    const relay = { ask: vi.fn(async () => AI_JSON) };
    const out = await classifyRequest(REQ(), relay);
    expect(relay.ask).toHaveBeenCalledTimes(1);
    expect(relay.ask.mock.calls[0]).toHaveLength(1);
    expect(typeof relay.ask.mock.calls[0][0]).toBe('string');
    expect(out.aiClassified).toBe(true);
  });

  it('3-arg call: relay.ask receives the options object', async () => {
    const relay = { ask: vi.fn(async () => AI_JSON) };
    const opts = { isolated: true, source: 'orcha_action:slack-justme' };
    const out = await classifyRequest(REQ(), relay, opts);
    expect(relay.ask).toHaveBeenCalledTimes(1);
    expect(relay.ask.mock.calls[0]).toHaveLength(2);
    expect(relay.ask.mock.calls[0][1]).toEqual({ isolated: true, source: 'orcha_action:slack-justme' });
    expect(out.status).toBe('ready');
  });

  it('prompt text is identical with and without relayOpts', async () => {
    const a = { ask: vi.fn(async () => AI_JSON) };
    const b = { ask: vi.fn(async () => AI_JSON) };
    await classifyRequest(REQ(), a);
    await classifyRequest(REQ(), b, { isolated: true });
    expect(b.ask.mock.calls[0][0]).toBe(a.ask.mock.calls[0][0]);
  });
});
