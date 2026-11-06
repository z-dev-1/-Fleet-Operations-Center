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
