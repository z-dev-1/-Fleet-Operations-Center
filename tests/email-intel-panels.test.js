// tests/email-intel-panels.test.js — F-12 "My identity" panel, F2-10 FAS-name hint, Phase A banners,
// NFR-11 accessibility basics. Pure render functions in node + the hand-written DOM stub for wiring.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { createFakeDom } from './fixtures/email-intel/fake-dom.js';
import * as P from '../renderer/src/js/components/email-intel-panels.js';
const require = createRequire(import.meta.url);
const cfg = require('../src/email-intel/config');

const tick = () => new Promise((r) => setTimeout(r, 0));
function domFor(ids) { const d = createFakeDom(); const el = {}; for (const id of ids) el[id] = d.add(id); return { doc: d.document, el }; }
const FORM_IDS = ['ei-id-names', 'ei-id-addresses', 'ei-id-dls', 'ei-id-fas', 'ei-id-save', 'ei-id-cancel', 'ei-id-suggest', 'ei-id-live'];

describe('F-12 My identity', () => {
  it('F-12 identity form renders, validates, persists', async () => {
    const html = P.renderIdentityHtml({ me: { names: ['Zila Santiago'], addresses: ['zila@example.test'], distributionLists: [], fasName: '' }, suggestions: { alias: 'zilasant' } });
    for (const id of ['ei-id-names', 'ei-id-addresses', 'ei-id-dls', 'ei-id-fas', 'ei-id-save']) expect(html).toContain('id="' + id + '"');
    expect(html).toContain('<label for="ei-id-names">');
    expect(html).toContain('value="Zila Santiago"');
    // validation errors come back from set-config and render inline, linked with aria-describedby
    const bad = cfg.validate({ me: { addresses: ['not-an-address'] } }, cfg.defaults());
    expect(bad).toMatchObject({ ok: false, field: 'me.addresses' });
    const withErr = P.renderIdentityHtml({ me: {}, errors: P.errorsFromResult(bad) });
    expect(withErr).toMatch(/id="ei-id-addresses"[^>]*aria-invalid="true" aria-describedby="ei-id-addresses-err"/);
    expect(withErr).toContain('id="ei-id-addresses-err" role="alert"');
    // persists: Save reads the inputs and calls setConfig with the patch; the validated config comes back
    const { doc, el } = domFor(FORM_IDS);
    el['ei-id-names'].value = 'Zila Santiago, Z Santiago, zila santiago';
    el['ei-id-addresses'].value = 'zila@example.test';
    el['ei-id-dls'].value = 'Fleet Ops DL';
    el['ei-id-fas'].value = ' Zila S ';
    el['ei-id-suggest'].setAttribute('data-alias', 'zilasant');
    const calls = []; let saved = null; let errored = null;
    P.wireIdentityPanel(doc, {
      setConfig: async (patch) => { calls.push(patch); const v = cfg.validate(patch, cfg.defaults()); return v.ok ? { ok: true, config: v.config } : v; },
      onSaved: (r) => { saved = r; }, onError: (r) => { errored = r; },
    });
    el['ei-id-save'].click(); await tick();
    expect(calls).toEqual([{ me: { names: ['Zila Santiago', 'Z Santiago'], addresses: ['zila@example.test'], distributionLists: ['Fleet Ops DL'], fasName: 'Zila S' } }]);
    expect(saved.config.me).toMatchObject({ names: ['Zila Santiago', 'Z Santiago'], fasName: 'Zila S' });
    expect(errored).toBeNull();
    expect(el['ei-id-live'].textContent).toBe('Identity saved.');
    el['ei-id-addresses'].value = 'broken';
    el['ei-id-save'].click(); await tick();
    expect(errored).toMatchObject({ ok: false, field: 'me.addresses' });
  });

  it('F-12 empty me shows the banner and ownership stays unknown (identity not set in status)', () => {
    const status = { ok: true, enabled: true, identity: { set: false }, warnings: ['identity-not-set', 'fas-name-not-set'], scan: { last: null } };
    const html = P.renderBannersHtml(status);
    expect(html).toContain(P.IDENTITY_BANNER);
    expect(html).toContain('id="ei-id-setup"');
    expect(html).toMatch(/role="status" aria-live="polite"/);
    expect(P.renderBannersHtml(Object.assign({}, status, { identity: { set: true }, warnings: ['fas-name-not-set'] }))).not.toContain(P.IDENTITY_BANNER);
    expect(P.renderBannersHtml(Object.assign({}, status, { enabled: false }))).toBe('');
    const { doc, el } = domFor(['ei-id-setup', 'ei-scan-again']);
    let setups = 0; let scans = 0;
    P.wireBanners(doc, { onSetup: () => setups++, onScanAgain: () => scans++ });
    el['ei-id-setup'].click(); el['ei-scan-again'].click();
    expect([setups, scans]).toEqual([1, 1]);
  });

  it('F-12 suggestion never auto-applied: the alias is only a chip, it fills the input on click and is saved only by Save', async () => {
    const html = P.renderIdentityHtml({ me: { names: [], addresses: [] }, suggestions: { alias: 'zilasant' } });
    expect(html).toMatch(/<input id="ei-id-names" type="text" value=""/);
    expect(html).toContain('id="ei-id-suggest" data-alias="zilasant"');
    const { doc, el } = domFor(FORM_IDS);
    el['ei-id-suggest'].setAttribute('data-alias', 'zilasant');
    const calls = [];
    P.wireIdentityPanel(doc, { setConfig: async (p) => { calls.push(p); return { ok: true, config: { me: p.me } }; } });
    expect(calls).toEqual([]);
    el['ei-id-suggest'].click();
    expect(el['ei-id-names'].value).toBe('zilasant');
    expect(calls).toEqual([]);                                      // still nothing saved
    el['ei-id-suggest'].click();
    expect(el['ei-id-names'].value).toBe('zilasant');               // not duplicated
    el['ei-id-save'].click(); await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].me.names).toEqual(['zilasant']);
  });
});

describe('F2-10 FAS-name hint', () => {
  it('F2-10 the identity panel shows the FAS-name hint line linked to the input', () => {
    const html = P.renderIdentityHtml({ me: {} });
    expect(P.FAS_HINT).toBe('Set your FAS name so units assigned to other FAS people at the same site are staged, not written.');
    expect(html).toContain('<div class="ei-hint" id="ei-id-fas-hint">' + P.FAS_HINT + '</div>');
    expect(html).toMatch(/id="ei-id-fas"[^>]*aria-describedby="ei-id-fas-hint"/);
  });
});

describe('Phase A banners', () => {
  const last = (outcome, folders) => ({ ok: true, enabled: true, identity: { set: true }, warnings: [], scan: { last: { outcome, folders } }, owaAuth: { state: outcome === 'auth-blocked' ? 'blocked' : 'ok' } });
  it('auth-blocked: counts read so far, folders not read, progress saved, Scan again', () => {
    const html = P.renderBannersHtml(last('auth-blocked', [{ folder: 'Inbox', status: 'ok', ingested: 6 }, { folder: 'DOMO', status: 'partial', ingested: 0 }, { folder: 'Relay Garage', status: 'not-reached', ingested: 0 }]));
    expect(html).toContain('Outlook needs sign-in. Read 6 messages from 1 folder; 2 folders not read. Progress is saved.');
    expect(html).toContain('<button type="button" class="et-mini" id="ei-scan-again">Scan again</button>');
  });
  it('partial: per-folder backlog and missing folders, escaped', () => {
    const html = P.renderBannersHtml(last('partial', [{ folder: 'Inbox', status: 'skipped-budget', backlog: true, backlogRemaining: 44 }, { folder: '<b>X</b>', status: 'not-found' }]));
    expect(html).toContain('Inbox: 44 messages still to read');
    expect(html).toContain('&lt;b&gt;X&lt;/b&gt;: folder not found');
    expect(html).not.toContain('<b>X</b>');
    expect(P.renderBannersHtml(last('complete', []))).toBe('');
  });
});

describe('Phase B lane banner (isolated-lane-unavailable, F-16)', () => {
  const st = (o) => Object.assign({ ok: true, enabled: true, identity: { set: true }, warnings: [], scan: { last: null }, owaAuth: { state: 'ok' }, lane: { state: 'ok', checkedAt: null } }, o);
  it('shows for the warning and for unavailable / degraded lane states, never otherwise', () => {
    for (const s of [st({ warnings: ['isolated-lane-unavailable'] }), st({ lane: { state: 'unavailable' } }), st({ lane: { state: 'degraded' } })]) {
      const html = P.renderBannersHtml(s);
      expect(html).toContain('ei-banner--lane');
      expect(html).toContain(P.LANE_BANNER);
      expect(html).toContain('role="status" aria-live="polite"');
      expect(html).toContain('<button type="button" class="et-mini" id="ei-probe-lane">Check AI connection</button>');
    }
    for (const s of [st({}), st({ lane: { state: 'unknown' } }), st({ enabled: false, lane: { state: 'unavailable' } })]) expect(P.renderBannersHtml(s)).not.toContain('ei-banner--lane');
    expect(P.LANE_BANNER).toMatch(/nothing is applied automatically/);
  });
  it('the Check AI connection button runs the manual probe once per click and re-enables', async () => {
    const { doc, el } = domFor(['ei-probe-lane']);
    let n = 0;
    P.wireBanners(doc, { onProbeLane: async () => { n++; expect(el['ei-probe-lane'].disabled).toBe(true); } });
    el['ei-probe-lane'].click();
    await tick();
    expect(n).toBe(1);
    expect(el['ei-probe-lane'].disabled).toBe(false);
    P.wireBanners(domFor([]).doc, {});                       // no button, no deps: nothing throws
  });
});
describe('NFR-11 accessibility basics', () => {
  it('NFR-11 buttons, aria-live, text labels', () => {
    const html = P.renderIdentityHtml({ me: {}, suggestions: { alias: 'x' } }) + P.renderBannersHtml({ enabled: true, identity: { set: false }, warnings: ['identity-not-set'], owaAuth: { state: 'blocked' }, scan: { last: { outcome: 'auth-blocked', folders: [] } } });
    const buttons = html.match(/<button[^>]*>[^<]*<\/button>/g) || [];
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    for (const b of buttons) { expect(b).toMatch(/type="button"/); expect(b.replace(/<[^>]+>/g, '').trim().length).toBeGreaterThan(2); }
    const inputs = html.match(/<input id="([^"]+)"/g) || [];
    for (const i of inputs) { const id = /id="([^"]+)"/.exec(i)[1]; expect(html).toContain('<label for="' + id + '">'); }
    expect(html).toMatch(/aria-live="polite"/);
    expect(P.parseList(' a; b,, A \n c ')).toEqual(['a', 'b', 'c']);
    expect(P.esc('<"\'&>')).toBe('&lt;&quot;&#39;&amp;&gt;');
  });
});
