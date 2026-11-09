// tests/email-intel-recipients.test.js — Reply vs Reply All recipient computation (design 6.3; R5.5, R5.6).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { ME } from './fixtures/email-intel/fleet.js';
import { ZILA, DEALER, COWORKER, person } from './fixtures/email-intel/emails.js';
const require = createRequire(import.meta.url);
const R = require('../src/email-intel/reply/recipients');

const msg = (o = {}) => Object.assign({ from: DEALER, to: [ZILA, COWORKER], cc: [person(1), { name: 'Vendor Desk', address: 'desk@vendor.other.test' }], recipientsKnown: true, flags: {} }, o);

describe('reply vs reply-all (R5.5)', () => {
  it('reply goes to the sender only', () => {
    const r = R.computeRecipients(msg(), 'reply', ME);
    expect(r).toMatchObject({ ok: true, mode: 'reply', toCount: 1, ccCount: 0, unknownAddress: 0 });
    expect(r.to).toEqual([{ name: 'Dealer Parts Desk', address: 'parts@dealer.example.test', role: 'sender' }]);
  });

  it('reply-all is sender + To + CC minus me, de-duplicated, CC kept separate', () => {
    const r = R.computeRecipients(msg({ to: [ZILA, COWORKER, { name: 'MIKE RIVERA', address: 'Mike.Rivera@example.test' }], cc: [person(1), DEALER, { name: 'Zila', address: null }] }), 'reply-all', ME);
    expect(r.to.map((e) => e.address)).toEqual(['parts@dealer.example.test', 'mike.rivera@example.test']);
    expect(r.cc.map((e) => e.address)).toEqual(['person01@example.test']);           // the dealer is already in To, "Zila" is me by name
    expect(r.cc[0].role).toBe('cc');
    expect(r).toMatchObject({ ok: true, toCount: 2, ccCount: 1 });
  });

  it('external counts recipients outside my address domains (null when I have no address configured)', () => {
    const r = R.computeRecipients(msg(), 'reply-all', ME);
    expect(r.external).toBe(2);                                                         // parts@dealer.example.test and desk@vendor.other.test
    expect(R.computeRecipients(msg(), 'reply-all', { names: ['Zila'], addresses: [] }).external).toBeNull();
  });

  it('RECIPIENTS_UNKNOWN: reply-all needs recipientsKnown and an address on every entry; reply still works', () => {
    expect(R.computeRecipients(msg({ recipientsKnown: false }), 'reply-all', ME)).toMatchObject({ ok: false, blocked: 'RECIPIENTS_UNKNOWN' });
    expect(R.computeRecipients(msg({ cc: [{ name: 'Name Only', address: null }] }), 'reply-all', ME)).toMatchObject({ ok: false, blocked: 'RECIPIENTS_UNKNOWN', unknownAddress: 1 });
    expect(R.computeRecipients(msg({ recipientsKnown: false }), 'reply', ME)).toMatchObject({ ok: true, toCount: 1 });
  });

  it('my own latest message: Reply goes to its To recipients, never to me', () => {
    const r = R.computeRecipients(msg({ from: ZILA, to: [DEALER, ZILA], cc: [] }), 'reply', ME);
    expect(r.to.map((e) => e.address)).toEqual(['parts@dealer.example.test']);
    expect(R.computeRecipients(msg({ from: ZILA, to: [ZILA], cc: [] }), 'reply', ME)).toMatchObject({ ok: false, blocked: 'NO_RECIPIENTS' });
  });

  it('new-message is the sender only (the unchanged legacy sendReply path)', () => {
    expect(R.computeRecipients(msg(), 'new-message', ME).to.map((e) => e.role)).toEqual(['sender']);
  });
});

describe('compareSets (R5.6 / AC-8 verification)', () => {
  it('equal sets ignore order, case and duplicates; names compare when an address is missing', () => {
    const exp = [{ name: 'Dealer Parts Desk', address: 'parts@dealer.example.test' }, { name: 'Mike Rivera', address: null }];
    const act = [{ name: 'Mike  Rivera', address: null }, { name: 'Dealer', address: 'PARTS@dealer.example.test' }, { name: 'Dealer', address: 'parts@dealer.example.test' }];
    expect(R.compareSets(exp, act)).toEqual({ equal: true, missing: [], extra: [] });
  });
  it('a difference returns the missing and extra entries', () => {
    const d = R.compareSets([{ name: 'A', address: 'a@x.test' }], [{ name: 'B', address: 'b@x.test' }]);
    expect(d.equal).toBe(false);
    expect(d.missing).toEqual([{ name: 'A', address: 'a@x.test' }]);
    expect(d.extra).toEqual([{ name: 'B', address: 'b@x.test' }]);
  });
});

describe('selfOnlyFallback (apiTransport, "To (0): none" fix)', () => {
  const OPT = { selfOnlyFallback: true };
  it('Reply (From only) is identical with and without the option', () => {
    for (const o of [undefined, OPT]) {
      const r = R.computeRecipients(msg(), 'reply', ME, o);
      expect(r.to).toEqual([{ name: 'Dealer Parts Desk', address: 'parts@dealer.example.test', role: 'sender' }]);
      expect(r.cc).toEqual([]);
      expect(r.selfOnly).toBeUndefined();
    }
  });

  it('Reply All = From + To + CC minus self (address and name), deduped, CC separate, identical with the option', () => {
    const m = msg({ to: [ZILA, COWORKER, DEALER], cc: [person(1), DEALER, { name: 'Zila', address: null }, COWORKER] });
    const a = R.computeRecipients(m, 'reply-all', ME);
    const b = R.computeRecipients(m, 'reply-all', ME, OPT);
    expect(b).toEqual(a);
    expect(b.to.map((e) => e.address)).toEqual(['parts@dealer.example.test', 'mike.rivera@example.test']);
    expect(b.cc.map((e) => e.address)).toEqual(['person01@example.test']);
  });

  it('a self-addressed message: Reply goes to my real address, Reply All stays NO_RECIPIENTS; no option -> today', () => {
    const m = msg({ from: ZILA, to: [ZILA], cc: [], flags: { fromMe: true } });
    const r = R.computeRecipients(m, 'reply', ME, OPT);
    expect(r).toMatchObject({ ok: true, toCount: 1, selfOnly: true });
    expect(r.blocked).toBeUndefined();
    expect(r.to).toEqual([{ name: 'Zila Santiago', address: 'zila.santiago@example.test', role: 'to' }]);
    expect(R.computeRecipients(m, 'reply-all', ME, OPT)).toMatchObject({ ok: false, blocked: 'NO_RECIPIENTS', toCount: 0 });
    expect(R.computeRecipients(m, 'reply', ME)).toMatchObject({ ok: false, blocked: 'NO_RECIPIENTS', toCount: 0 });
  });

  it('From me -> someone else: Reply still goes to them (no fallback)', () => {
    const r = R.computeRecipients(msg({ from: ZILA, to: [COWORKER], cc: [], flags: { fromMe: true } }), 'reply', ME, OPT);
    expect(r.to).toEqual([{ name: 'Mike Rivera', address: 'mike.rivera@example.test', role: 'to' }]);
    expect(r.selfOnly).toBeUndefined();
  });

  it('a name-only me entry never becomes an address-less recipient', () => {
    const r = R.computeRecipients(msg({ from: { name: 'Zila', address: null }, to: [{ name: 'Zila Santiago', address: null }], cc: [] }), 'reply', ME, OPT);
    expect(r).toMatchObject({ ok: false, blocked: 'NO_RECIPIENTS', toCount: 0 });
  });
});
