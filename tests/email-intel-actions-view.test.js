// tests/email-intel-actions-view.test.js — the My Email Actions view (design 5.5; R4.10, R5.5, R6.3, NFR-11).
// Pure render functions in node; the button operations run against a fake window.emailIntel; the DOM stub is used
// only for the click delegation.
import { describe, it, expect, vi } from 'vitest';
import * as V from '../renderer/src/js/components/email-actions-view.js';
import * as P from '../renderer/src/js/components/email-intel-panels.js';
import { FakeElement } from './fixtures/email-intel/fake-dom.js';

const NOW = Date.parse('2026-11-04T20:00:00.000Z');
const it_ = (id, cat, o) => Object.assign({
  actionId: 'ac_' + id.padStart(16, '0'), category: cat, tier: cat === 'reply' || cat === 'decision' ? 'required' : 'fyi', state: 'open', units: ['40123'],
  subject: 'Unit 40123 status', reasonText: 'Reason for ' + cat, actionText: 'Action for ' + cat, chips: {}, recipientsKnown: true, firstSeenAt: '2026-11-04T10:00:00.000Z',
}, o);
const ALL = [
  it_('7', 'outofscope'), it_('6', 'info'), it_('5', 'recorded'), it_('4', 'review', { tier: 'required', stagedIds: ['st_00000000000000a1'], hasFact: true, reasonCode: 'conflict-canonical', chips: { staged: true } }),
  it_('3', 'followup', { tier: 'required' }), it_('2', 'decision'), it_('1', 'reply'),
];
const sections = (html) => Array.from(html.matchAll(/<section class="ei-cat ei-cat--([a-z]+)"/g)).map((m) => m[1]);

describe('R4.10 renders seven sections in order', () => {
  it('R4.10 renders seven sections in order', () => {
    const html = V.renderActionsHtml({ items: ALL, counts: { reply: 1, decision: 1, followup: 1, review: 1, recorded: 1, info: 1, outofscope: 1 } });
    expect(sections(html)).toEqual(['reply', 'decision', 'followup', 'review', 'recorded', 'info', 'outofscope']);
    const titles = Array.from(html.matchAll(/data-op="toggle" data-category="[a-z]+" aria-expanded="(true|false)" aria-controls="[^"]+">([^<]+)<\/button>/g)).map((m) => [m[2], m[1]]);
    expect(titles).toEqual([
      ['Reply Needed (1)', 'true'], ['Decision / Approval Needed (1)', 'true'], ['Follow-Up Needed (1)', 'true'], ['Review Conflicting Information (1)', 'true'],
      ['Unit Update Recorded (1)', 'false'], ['Informational / No Action (1)', 'false'], ['Out of Scope (1)', 'false'],
    ]);
    // collapsed by default: count only, no cards; expanding shows them
    expect(html).not.toContain('Reason for recorded');
    expect(html).not.toContain('Reason for outofscope');
    expect(html).toContain('Reason for reply');
    const open = V.renderActionsHtml({ items: ALL, expanded: { recorded: true, info: true, outofscope: true, reply: false } });
    expect(open).toContain('Reason for recorded');
    expect(open).not.toContain('Reason for reply');
    // empty categories still render (always seven sections)
    expect(sections(V.renderActionsHtml({ items: [] }))).toHaveLength(7);
    expect(V.renderActionsHtml({ items: [] })).toContain('Nothing here.');
    // open items first by tier then age; closed after
    const order = V.renderActionsHtml({ items: [it_('a', 'reply', { tier: 'suggested', reasonText: 'S1' }), it_('b', 'reply', { state: 'snoozed', reasonText: 'Z1', snoozeUntil: '2026-11-05T10:00:00.000Z' }), it_('c', 'reply', { reasonText: 'R1' })] });
    expect(order.indexOf('R1')).toBeLessThan(order.indexOf('S1'));
    expect(order.indexOf('S1')).toBeLessThan(order.indexOf('Z1'));
    expect(order).toContain('Snoozed until 2026-11-05 10:00');
  });

  it('every text is escaped (subjects, reasons, evidence, unit ids)', () => {
    const html = V.renderActionsHtml({ items: [it_('1', 'reply', { subject: '<img src=x onerror=alert(1)>', reasonText: '<b>r</b>', actionText: '"a"', evidenceQuote: '</blockquote><script>x</script>', units: ['<u>'] })] });
    expect(html).not.toMatch(/<img|<script|<b>r|<u>/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<details class="ei-evidence"><summary>Quoted text from the email</summary><blockquote>&lt;/blockquote&gt;&lt;script&gt;x&lt;/script&gt;</blockquote></details>');
  });
});

describe('NFR-11 buttons, aria-live, text labels', () => {
  it('NFR-11 buttons, aria-live, text labels', () => {
    const html = V.renderActionsHtml({ items: ALL, expanded: { recorded: true, info: true, outofscope: true }, status: 'Loaded.', timelineWrites: true });
    const buttons = html.match(/<button[^>]*>[^<]*<\/button>/g) || [];
    expect(buttons.length).toBeGreaterThan(20);
    for (const b of buttons) {
      expect(b).toMatch(/type="button"/);
      expect(b.replace(/<[^>]+>/g, '').trim().length).toBeGreaterThan(2);                       // visible text label
      if (/class="et-mini ei-op"/.test(b)) expect(b).toMatch(/aria-label="[^"]{6,}"/);         // item buttons carry an aria-label
    }
    expect(html).toContain('<div class="ei-live" id="ei-act-live" role="status" aria-live="polite">Loaded.</div>');
    // tiers, categories and chips are text, not color alone
    expect(html).toContain('<span class="ei-tier">Required</span>');
    expect(html).toContain('<span class="ei-tier">FYI</span>');
    expect(html).toContain('<span class="ei-flag">Staged</span>');
    for (const label of Object.values(V.CATEGORY_LABELS)) expect(html).toContain(label + ' (');
    const chips = V.renderActionsHtml({ items: [it_('1', 'reply', { chips: { partial: true, injection: true, staged: true, notThreaded: true, probablyAnswered: true } })] });
    for (const t of ['Partial content', 'Injection-like text', 'Staged', 'Not threaded', 'Probably answered']) expect(chips).toContain('<span class="ei-flag">' + t + '</span>');
    // every section is labelled by its heading
    expect((html.match(/<section class="ei-cat [^"]+" data-category="[a-z]+" aria-labelledby="ei-cat-[a-z]+">/g) || []).length).toBe(7);
  });

  it('identity panel from email-intel-panels is reused in the settings area', () => {
    const html = V.renderActionsHtml({ items: [], identityOpen: true, identity: { me: { names: ['Zila Santiago'] }, suggestions: {} } });
    expect(html).toContain(P.renderIdentityHtml({ me: { names: ['Zila Santiago'] }, suggestions: {} }));
    expect(html).toContain('id="ei-act-identity" aria-expanded="true"');
    expect(V.renderActionsHtml({ items: [] })).not.toContain('ei-identity');
  });
});

describe('R5.5 separate buttons, reply-all disabled when unknown', () => {
  it('R5.5 separate buttons, reply-all disabled when unknown', () => {
    const known = V.renderActionsHtml({ items: [it_('1', 'reply')] });
    expect(known).toMatch(/<button type="button" class="et-mini ei-op" data-op="reply" data-id="ac_0000000000000001" data-mode="reply" aria-label="Reply to the sender about unit 40123">Reply<\/button>/);
    expect(known).toMatch(/data-mode="reply-all" aria-label="Reply all about unit 40123">Reply All<\/button>/);
    const unknown = V.renderActionsHtml({ items: [it_('1', 'reply', { recipientsKnown: false })] });
    expect(unknown).toMatch(/data-mode="reply-all" aria-label="Reply all about unit 40123 \(unavailable: recipients unknown\)" disabled aria-disabled="true" title="Recipients unknown">Reply All<\/button>/);
    expect(unknown).toMatch(/data-mode="reply" aria-label="[^"]+">Reply<\/button>/);
    // other categories have no reply buttons; review offers Record anyway (disabled while timeline writes are off) and Reject
    const rev = V.renderActionsHtml({ items: [ALL[3]] });
    expect(rev).not.toContain('data-op="reply"');
    expect(rev).toMatch(/data-op="record"[^>]*disabled aria-disabled="true" title="Timeline writes are off">Record anyway<\/button>/);
    expect(rev).toContain('>Reject</button>');
    expect(V.renderActionsHtml({ items: [ALL[3]], timelineWrites: true })).not.toContain('title="Timeline writes are off"');
  });
});

describe('R6.3 label rendering (prepared for Phase F)', () => {
  it('R6.3 label rendering: analyzed vs filename only, never facts from a name', () => {
    expect(V.renderAttachmentLabel({ name: 'Estimate_40123.pdf' })).toBe('<span class="ei-att"><span class="ei-att-name">Estimate_40123.pdf</span> <span class="ei-flag">Filename only</span></span>');
    expect(V.renderAttachmentLabel({ name: 'a.pdf', analysis: { status: 'content' } })).toContain('Attachment analyzed');
    expect(V.renderAttachmentLabel({ name: 'a.pdf', analysis: { status: 'content-partial' } })).toContain('Attachment partly analyzed');
    expect(V.renderAttachmentLabel({ name: '<x>.pdf', analysis: { status: 'unreadable' } })).toContain('&lt;x&gt;.pdf</span> <span class="ei-flag">Filename only');
    expect(V.renderActionsHtml({ items: [it_('1', 'reply', { attachments: [{ name: 'Estimate.pdf' }] })] })).toContain('Filename only');
  });
});

describe('button operations (runOp) and click delegation', () => {
  const api = () => ({
    actionUpdate: vi.fn(async (p) => ({ ok: true, actionId: p.actionId, state: 'x' })),
    prepareAction: vi.fn(async () => ({ ok: true, token: 'a'.repeat(32), summary: { headline: 'Reject staged update for unit 40123?', detailText: 'Unit: 40123' } })),
    confirmAction: vi.fn(async () => ({ ok: true, state: 'rejected' })),
    getActions: vi.fn(async () => ({ ok: true, items: ALL, counts: {}, timelineWrites: false })),
  });
  it('local ops call action-update only; snooze is one day; staged decisions use prepare + in-app confirm + confirm-action', async () => {
    const a = api();
    for (const op of ['dismiss', 'done', 'reopen', 'retry-analysis']) expect((await V.runOp(op, { id: 'ac_1' }, { api: a })).ok).toBe(true);
    await V.runOp('snooze', { id: 'ac_1' }, { api: a, now: () => NOW });
    expect(a.actionUpdate.mock.calls.map((c) => c[0].op)).toEqual(['dismiss', 'done', 'reopen', 'retry-analysis', 'snooze']);
    expect(a.actionUpdate.mock.calls[4][0]).toEqual({ actionId: 'ac_1', op: 'snooze', snoozeUntil: new Date(NOW + 86_400_000).toISOString() });
    expect(a.prepareAction).not.toHaveBeenCalled();
    // reject: in-app confirm shows the server summary; cancelling there sends nothing to confirm-action
    const no = vi.fn(() => false);
    expect(await V.runOp('reject', { id: 'ac_4', staged: 'st_1' }, { api: a, confirmFn: no })).toMatchObject({ ok: false, message: 'Cancelled.' });
    expect(no.mock.calls[0][0]).toBe('Reject staged update for unit 40123?\n\nUnit: 40123');
    expect(a.confirmAction).not.toHaveBeenCalled();
    expect(await V.runOp('reject', { id: 'ac_4', staged: 'st_1' }, { api: a, confirmFn: () => true })).toMatchObject({ ok: true, reload: true });
    expect(a.prepareAction).toHaveBeenLastCalledWith('reject-staged', { stagedId: 'st_1' });
    await V.runOp('record', { id: 'ac_4', staged: 'st_2', reason: 'conflict-ready' }, { api: a, confirmFn: () => true });
    expect(a.prepareAction).toHaveBeenLastCalledWith('approve-staged', { stagedId: 'st_2', acknowledgeConflictReady: true });
    // reply hands over to the overlay (no send here)
    const onReply = vi.fn();
    await V.runOp('reply', { id: 'ac_1', mode: 'reply-all' }, { api: a, onReply });
    expect(onReply).toHaveBeenCalledWith({ id: 'ac_1', mode: 'reply-all' }, 'reply-all');
    expect(a.confirmAction).toHaveBeenCalledTimes(2);
  });

  it('mount loads the items, renders them, and a delegated click runs the operation then reloads', async () => {
    const a = api();
    const box = new FakeElement('ei-actions');
    const toast = vi.fn();
    V.mount(box, { api: a, toast });
    await new Promise((r) => setTimeout(r, 0));
    expect(a.getActions).toHaveBeenCalledWith({ includeClosed: false, limit: 200 });
    expect(sections(box.innerHTML)).toHaveLength(7);
    const btn = new FakeElement('', 'button');
    btn.setAttribute('data-op', 'dismiss'); btn.setAttribute('data-id', 'ac_0000000000000001');
    btn.closest = () => btn;
    await box.dispatch('click', { target: btn });
    await new Promise((r) => setTimeout(r, 0));
    expect(a.actionUpdate).toHaveBeenCalledWith({ actionId: 'ac_0000000000000001', op: 'dismiss' });
    expect(toast).toHaveBeenCalledWith('Dismissed.');
    expect(a.getActions).toHaveBeenCalledTimes(2);
  });
});
