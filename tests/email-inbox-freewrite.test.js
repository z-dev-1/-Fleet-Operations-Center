// tests/email-inbox-freewrite.test.js — Inbox Triage free-write reply with inline clarifying questions.
// Backend: the optional clarify / answers fields of draft-thread-reply (validator, draftThreadReply branch) and of the
// legacy emailTriage:draft-reply opts. Renderer: the free-write box renders only with intel on, never carries the
// draft attributes Send reads, keeps typed text across a full re-render, shows the questions box and re-drafts.
// The isolated lane / relay are scripted; no Outlook, no model. Renderer wiring runs against a small fake DOM that
// parses the rendered HTML (the repo has no jsdom).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import { createRequire } from 'module';
import { DEALER, ZILA } from './fixtures/email-intel/emails.js';
import { phaseCWorld, PHASE_C } from './fixtures/email-intel/phase-c.js';
import { FakeElement } from './fixtures/email-intel/fake-dom.js';
import { __test__ as O } from '../renderer/src/js/components/email-triage-overlay.js';
import bus from '../renderer/src/js/bus.js';
import * as fx from './fixtures/email-intel-fixture.js';
const require = createRequire(import.meta.url);

const REPLIES = Object.freeze(Object.assign({}, PHASE_C, { threadReplies: true }));
const CKV = 'cv_0123456789abcdef';

describe('validateDraftThreadReply: optional clarify / answers', () => {
  const { validateDraftThreadReply: V } = require('../src/ipc/email-intel');
  it('without the new fields returns exactly today\'s four fields', () => {
    expect(V({ conversationKey: CKV, mode: 'reply' })).toEqual({ conversationKey: CKV, mode: 'reply', guidance: '', force: false });
    expect(Object.keys(V({ conversationKey: CKV, mode: 'reply-all', guidance: 'g', force: true }))).toEqual(['conversationKey', 'mode', 'guidance', 'force']);
  });
  it('accepts and returns clarify and answers only when present', () => {
    expect(V({ conversationKey: CKV, mode: 'reply', guidance: 'g', clarify: true })).toEqual({ conversationKey: CKV, mode: 'reply', guidance: 'g', force: false, clarify: true });
    expect(V({ conversationKey: CKV, mode: 'reply', guidance: 'g', clarify: false, answers: 'Friday' })).toEqual({ conversationKey: CKV, mode: 'reply', guidance: 'g', force: false, clarify: false, answers: 'Friday' });
    expect(V({ conversationKey: CKV, mode: 'reply', answers: 'a'.repeat(1000) }).answers).toHaveLength(1000);
  });
  it('rejects bad types with BAD_ARG', () => {
    for (const [p, field] of [[{ clarify: 'yes' }, 'clarify'], [{ clarify: 1 }, 'clarify'], [{ answers: 5 }, 'answers'], [{ answers: 'a'.repeat(1001) }, 'answers'], [{ answers: ['x'] }, 'answers']]) {
      expect(V(Object.assign({ conversationKey: CKV, mode: 'reply', guidance: 'g' }, p))).toEqual({ ok: false, code: 'BAD_ARG', field });
    }
  });
});

describe('buildClarifyPrompt / buildDraftPrompt', () => {
  const D = require('../src/email-intel/reply/draft');
  it('buildDraftPrompt without answers is unchanged; the clarify prompt adds the answers and the strict JSON contract', () => {
    const base = D.buildDraftPrompt('CTX', 'confirm Friday', 'reply');
    expect(D.buildDraftPrompt('CTX', 'confirm Friday', 'reply', '')).toBe(base);
    expect(D.buildDraftPrompt('CTX', 'confirm Friday', 'reply', undefined)).toBe(base);
    expect(base.endsWith('THE USER\'S GUIDANCE FOR THIS REPLY (trusted, from the user):\nconfirm Friday\n\nWrite the reply body now.')).toBe(true);
    const c = D.buildClarifyPrompt('CTX', 'confirm Friday', '', 'reply-all');
    expect(c.startsWith(base.slice(0, base.indexOf('REPLY MODE:')))).toBe(true);           // same instruction block and RULES
    expect(c).toContain('REPLY MODE: Reply All (everyone on the thread reads it)');
    expect(c).toContain('CONVERSATION CONTEXT:\nCTX');
    expect(c).toContain('THE USER\'S GUIDANCE FOR THIS REPLY (trusted, from the user):\nconfirm Friday');
    expect(c).toContain('{"done":true,"draft":"<reply body>"}');
    expect(c).toContain('{"done":false,"questions":["q1","q2"]}');
    expect(c).not.toContain('ANSWERS TO YOUR QUESTIONS');
    const a = D.buildClarifyPrompt('CTX', 'confirm Friday', 'Pickup at 3 pm', 'reply');
    expect(a).toContain('THE USER\'S ANSWERS TO YOUR QUESTIONS (trusted, from the user):\nPickup at 3 pm');
    expect(a).toContain('ask again only if something critical is still missing');
  });
});

describe('draftThreadReply clarify branch (stubbed isolated lane)', () => {
  const draftMod = require('../src/email-intel/reply/draft');
  const identity = require('../src/email-intel/ingest/identity');
  const CK = identity.conversationKey('conv-fw');
  let w = null;
  afterEach(() => { if (w) w.cleanup(); w = null; });
  const seed = async () => {
    w = phaseCWorld(REPLIES);
    w.questions.push({ when: 'can you confirm pickup', q: { ref: 'q1', text: 'Can you confirm pickup for 40123?', about: ['40123'], addressee: { kind: 'me', name: 'Zila', evidence: 'Zila, can you confirm pickup' }, isApprovalOrDecision: false, confidence: 0.9 } });
    await w.scan([w.cap({ from: DEALER, to: [ZILA], subject: 'Pickup 40123', conversationId: 'conv-fw', messageId: 'fw-1', receivedAt: '2026-11-04T14:00:00.000Z', body: 'Zila, can you confirm pickup for 40123?' })]);
  };
  const legacy = () => w.store.load('emailTriageResults').emails.find((e) => e.intel && e.intel.conversationKey === CK);

  it('questions: needsAnswers with at most 3 cleaned questions, nothing persisted', async () => {
    await seed();
    const before = legacy();
    const ask = vi.fn(async () => ({ ok: true, text: 'Sure:\n{"done":false,"questions":["What day?\\u0007","  Which   unit?  ","Who approves?","Fourth?", 7]}' }));
    const r = await draftMod.draftThreadReply({ conversationKey: CK, mode: 'reply', guidance: 'confirm pickup', clarify: true }, { _ask: ask });
    expect(r).toEqual({ ok: true, needsAnswers: true, questions: ['What day?', 'Which unit?', 'Who approves?'], mode: 'reply' });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][1]).toEqual({ trigger: 'manual', timeoutMs: 45000 });
    expect(ask.mock.calls[0][0]).toContain('{"done":false,"questions":["q1","q2"]}');
    expect(ask.mock.calls[0][0]).toContain('status=open, addressed to=me, owner=me');       // same grounded context
    expect(w.open('reply')[0].draft).toBeUndefined();
    expect(legacy()).toEqual(before);
    expect(legacy().replyState).not.toBe('drafted');
  });

  it('done: the same result shape as a normal draft, persisted the same way', async () => {
    await seed();
    const ask = vi.fn(async () => ({ ok: true, text: '{"done":true,"draft":"Hi,\\n\\nPickup Friday at 3 pm is confirmed.\\n\\nBest"}' }));
    const r = await draftMod.draftThreadReply({ conversationKey: CK, mode: 'reply', guidance: 'confirm pickup', clarify: true, answers: 'Friday 3 pm' }, { _ask: ask });
    expect(ask.mock.calls[0][0]).toContain('THE USER\'S ANSWERS TO YOUR QUESTIONS (trusted, from the user):\nFriday 3 pm');
    expect(r).toMatchObject({ ok: true, draft: 'Hi,\n\nPickup Friday at 3 pm is confirmed.\n\nBest', mode: 'reply', aiUnavailable: false });
    const plain = await draftMod.draftThreadReply({ conversationKey: CK, mode: 'reply', guidance: 'confirm pickup' }, { _ask: async () => ({ ok: true, text: 'Hi' }) });
    expect(Object.keys(r).sort()).toEqual(Object.keys(plain).sort());
    expect(r.needsAnswers).toBeUndefined();
    await draftMod.draftThreadReply({ conversationKey: CK, mode: 'reply', guidance: 'confirm pickup', clarify: true }, { _ask: ask });
    expect(w.open('reply')[0].draft).toMatchObject({ text: r.draft, mode: 'reply' });
    expect(legacy()).toMatchObject({ replyState: 'drafted', replyDraft: r.draft });
  });

  it('bad JSON falls back to the editable starter; plain text without JSON is used as the draft; lane failure is the starter', async () => {
    await seed();
    const bad = await draftMod.draftThreadReply({ conversationKey: CK, mode: 'reply', guidance: 'Pickup Friday works.', clarify: true }, { _ask: async () => ({ ok: true, text: '{"done":false,"questions":[' + '}' }) });
    expect(bad).toMatchObject({ ok: true, aiUnavailable: true, draft: 'Hi Dealer,\n\nPickup Friday works.\n\nBest regards' });
    const empty = await draftMod.draftThreadReply({ conversationKey: CK, mode: 'reply', guidance: 'Pickup Friday works.', clarify: true }, { _ask: async () => ({ ok: true, text: '{"done":false,"questions":[]}' }) });
    expect(empty).toMatchObject({ ok: true, aiUnavailable: true });
    const text = await draftMod.draftThreadReply({ conversationKey: CK, mode: 'reply', guidance: 'Pickup Friday works.', clarify: true }, { _ask: async () => ({ ok: true, text: 'Hi,\n\nFriday works.\n\nBest' }) });
    expect(text).toMatchObject({ ok: true, aiUnavailable: false, draft: 'Hi,\n\nFriday works.\n\nBest' });
    const down = await draftMod.draftThreadReply({ conversationKey: CK, mode: 'reply', guidance: 'Pickup Friday works.', clarify: true }, { _ask: async () => ({ ok: false, error: 'lane-unavailable' }) });
    expect(down).toMatchObject({ ok: true, aiUnavailable: true, draft: 'Hi Dealer,\n\nPickup Friday works.\n\nBest regards' });
  });

  it('without the new fields (or clarify without guidance) the prompt and result are today\'s', async () => {
    await seed();
    const prompts = [];
    const ask = async (p) => { prompts.push(p); return { ok: true, text: 'Thanks, confirmed.' }; };
    const a = await draftMod.draftThreadReply({ conversationKey: CK, mode: 'reply' }, { _ask: ask, now: 1 });
    const b = await draftMod.draftThreadReply({ conversationKey: CK, mode: 'reply', clarify: true }, { _ask: ask, now: 1 });
    const c = await draftMod.draftThreadReply({ conversationKey: CK, mode: 'reply', guidance: 'x', clarify: false }, { _ask: ask, now: 1 });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    const strip = (p) => p.replace(/id=[0-9a-f]{16}/g, 'id=N');
    expect(strip(prompts[1])).toBe(strip(prompts[0]));
    expect(prompts[0].endsWith('\n\nWrite the reply body now.')).toBe(true);
    expect(prompts[0]).not.toContain('STRICT JSON');
    expect(prompts[2]).not.toContain('STRICT JSON');
    expect(Object.keys(a).sort()).toEqual(['aiUnavailable', 'basedOnMessageKey', 'draft', 'mode', 'ok', 'recipients', 'replyAllAvailable', 'warnings']);
  });
});

describe('legacy emailTriage:draft-reply opts (no conversation key)', () => {
  let relay; let actions; let realAsk;
  const RESULTS = { emails: [{ id: 'em_l1', convId: 'conv/l1=', from: 'shop@example.test', fromName: 'Shop Desk', subject: 'Unit 40123 pickup', bodyText: 'Can you confirm pickup?', unitRefs: [], replyState: 'none' }], ranAt: 'x', authBlocked: false };
  const call = (ch, ...a) => fx.rec.handlers[ch]({ sender: {} }, ...a);
  const rec = () => fx.doc('emailTriageResults').emails[0];
  beforeAll(() => { fx.installStubs(); relay = require(path.join(fx.ROOT, 'src/orcha/relay')); realAsk = relay.askWithTimeout; });
  beforeEach(() => {
    fx.resetWorld({ emailTriageResults: JSON.parse(JSON.stringify(RESULTS)) });
    require(path.join(fx.ROOT, 'src/email-intel/flags'))._setForTests(null);
    ({ actions } = fx.freshLegacy());
    fx.freshIpc();
  });
  afterEach(() => { relay.askWithTimeout = realAsk; });

  it('without opts: actions.draftReply(email, guidance, {}) exactly as today', async () => {
    const spy = vi.spyOn(actions, 'draftReply').mockResolvedValue({ ok: true, draft: 'Hi Shop' });
    expect(await call('emailTriage:draft-reply', 'em_l1', '')).toEqual({ ok: true, draft: 'Hi Shop', aiUnavailable: false });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe('');
    expect(spy.mock.calls[0][2]).toEqual({});
    expect(rec()).toMatchObject({ replyState: 'drafted', replyDraft: 'Hi Shop' });
  });

  it('clarify: questions persist nothing; answers then draft; the prompt is the legacy reply prompt plus the contract', async () => {
    const prompts = [];
    relay.askWithTimeout = vi.fn(async (p, o) => { prompts.push([p, o]); return prompts.length === 1 ? '{"done":false,"questions":["What time is pickup?"]}' : '{"done":true,"draft":"Hi Shop,\\n\\nPickup is confirmed for 3 pm.\\n\\nBest regards"}'; });
    const spy = vi.spyOn(actions, 'draftReply');
    const q = await call('emailTriage:draft-reply', 'em_l1', 'confirm pickup', { clarify: true, ignored: 1 });
    expect(q).toEqual({ ok: true, needsAnswers: true, questions: ['What time is pickup?'] });
    expect(rec().replyState).toBe('none');
    expect(rec().replyDraft).toBeUndefined();
    expect(prompts[0][0].startsWith(actions._buildReplyPrompt(fx.doc('emailTriageResults').emails[0], 'confirm pickup'))).toBe(true);
    expect(prompts[0][0]).toContain('{"done":false,"questions":["q1","q2"]}');
    expect(prompts[0][1]).toEqual({ source: 'email_actions', timeoutMs: 45000, timeoutMessage: 'ai-timeout' });
    const d = await call('emailTriage:draft-reply', 'em_l1', 'confirm pickup', { clarify: true, answers: '3 pm' });
    expect(d).toEqual({ ok: true, draft: 'Hi Shop,\n\nPickup is confirmed for 3 pm.\n\nBest regards', aiUnavailable: false });
    expect(prompts[1][0]).toContain('THE USER\'S ANSWERS TO YOUR QUESTIONS (follow these): 3 pm');
    expect(rec()).toMatchObject({ replyState: 'drafted', replyDraft: d.draft });
    expect(spy).not.toHaveBeenCalled();
  });

  it('clarify fallbacks: AI unavailable gives the starter; unusable JSON drafts the normal way; Draft anyway folds the answers in', async () => {
    relay.askWithTimeout = vi.fn(async () => { throw new Error('ai-timeout'); });
    expect(await call('emailTriage:draft-reply', 'em_l1', 'confirm pickup', { clarify: true })).toEqual({ ok: true, draft: 'Hi Shop,\n\nThank you for your email.\n\n\n\nBest regards', aiUnavailable: true });
    expect(relay.askWithTimeout).toHaveBeenCalledTimes(1);
    const spy = vi.spyOn(actions, 'draftReply').mockResolvedValue({ ok: true, draft: 'normal' });
    relay.askWithTimeout = vi.fn(async () => '{"done":"maybe"}');
    expect(await call('emailTriage:draft-reply', 'em_l1', 'confirm pickup', { clarify: true })).toEqual({ ok: true, draft: 'normal', aiUnavailable: false });
    expect(spy.mock.calls[0].slice(1)).toEqual(['confirm pickup', {}]);
    await call('emailTriage:draft-reply', 'em_l1', 'confirm pickup', { clarify: false, answers: '3 pm' });
    expect(spy.mock.calls[1].slice(1)).toEqual(['confirm pickup\n3 pm', {}]);
  });

  it('bad opts types are refused before any AI call', async () => {
    relay.askWithTimeout = vi.fn();
    for (const opts of [{ clarify: 'yes' }, { answers: 5 }, { answers: 'a'.repeat(1001) }, 'x', [1]]) {
      const r = await call('emailTriage:draft-reply', 'em_l1', 'g', opts);
      expect(r.ok, JSON.stringify(opts)).toBe(false);
    }
    expect(relay.askWithTimeout).not.toHaveBeenCalled();
    expect(rec().replyState).toBe('none');
  });
});

// ── Renderer ───────────────────────────────────────────────────────────────────
const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** A fake document whose querySelector parses the current #et-body HTML into FakeElements (one per tag per render). */
function htmlDom() {
  const byId = new Map();
  let html = ''; let tags = null; let cache = new Map();
  const body = new FakeElement('et-body');
  Object.defineProperty(body, 'innerHTML', { get: () => html, set: (v) => { html = String(v); tags = null; cache = new Map(); } });
  byId.set('et-body', body); byId.set('et-meta', new FakeElement('et-meta'));
  const parse = () => {
    if (tags) return tags;
    tags = [];
    const re = /<([a-z]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*>/gi; let m;
    while ((m = re.exec(html))) {
      const attrs = {}; const ar = /([\w-]+)(?:="([^"]*)")?/g; let a;
      while ((a = ar.exec(m[2]))) attrs[a[1]] = a[2] === undefined ? '' : unesc(a[2]);
      const inner = m[1].toLowerCase() === 'textarea' ? unesc(html.slice(re.lastIndex, html.indexOf('</textarea>', re.lastIndex))) : '';
      tags.push({ tag: m[1].toLowerCase(), attrs, inner, pos: m.index });
    }
    return tags;
  };
  const el = (i) => {
    if (cache.has(i)) return cache.get(i);
    const t = parse()[i]; const e = new FakeElement(t.attrs.id || '', t.tag);
    for (const [k, v] of Object.entries(t.attrs)) e.setAttribute(k, v);
    (t.attrs.class || '').split(/\s+/).filter(Boolean).forEach((c) => e.classList.add(c));
    e.value = t.inner; e.disabled = 'disabled' in t.attrs; e.scrollIntoView = () => {}; e.focus = () => {};
    cache.set(i, e); return e;
  };
  const matches = (t, sel) => {
    const m = /^([a-z]+)?\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (!m) return false;
    if (m[1] && t.tag !== m[1]) return false;
    if (!(m[2] in t.attrs)) return false;
    return m[3] === undefined || t.attrs[m[2]] === m[3];
  };
  const within = (lo, hi) => (sel) => parse().map((t, i) => [t, i]).filter(([t]) => t.pos >= lo && t.pos < hi && matches(t, sel)).map(([, i]) => el(i));
  const cardFor = (id) => {
    const list = parse();
    const start = list.findIndex((t) => t.tag === 'div' && /\bet-card\b/.test(t.attrs.class || '') && t.attrs['data-id'] === id);
    if (start === -1) return null;
    const next = list.findIndex((t, i) => i > start && t.tag === 'div' && /\bet-card\b/.test(t.attrs.class || '') && 'data-id' in t.attrs);
    const find = within(list[start].pos, next === -1 ? Infinity : list[next].pos);
    const card = el(start);
    card.querySelectorAll = find; card.querySelector = (sel) => find(sel)[0] || null;
    return card;
  };
  const document = {
    head: new FakeElement('head'), body: new FakeElement('body'), createElement: (t) => new FakeElement('', t),
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => {
      const c = /^\.et-card\[data-id="([^"]*)"\]$/.exec(sel);
      if (c) return cardFor(c[1]);
      return within(0, Infinity)(sel)[0] || null;
    },
    querySelectorAll: (sel) => within(0, Infinity)(sel),
  };
  return { document, body, q: (sel) => document.querySelector(sel) };
}

describe('renderer: free-write markup (pure HTML)', () => {
  const em = (o = {}) => Object.assign({ id: 'em_f1', fromName: 'Dealer', subject: 'Pickup 40123', summary: 's', importance: 'normal', unitRefs: [], replyState: 'none', intel: { conversationKey: CKV, recipientsKnown: true } }, o);
  afterEach(() => { O._setIntelForTests(null); O._setFwUiForTests('em_f1', null); });

  it('renders only when intel is set; flags off the card has no free-write markup', () => {
    O._setIntelForTests(null);
    for (const st of ['none', 'drafted', 'dismissed']) expect(O._cardHtml(em({ replyState: st }))).not.toContain('et-fw');
    O._setIntelForTests({ ok: true, enabled: true, flags: { capture: true, threadReplies: true } });
    const card = O._cardHtml(em());
    expect(card).toContain('data-fw-toggle="em_f1"');
    expect(card).toContain('✍️ Write my own reply');
    expect(card.indexOf('et-fw')).toBeGreaterThan(card.indexOf('et-footer'));             // after the reply panel slot
  });

  it('skips sent / uncertain / deleted cards; expanded box never carries data-draft or et-draft', () => {
    O._setIntelForTests({ ok: true, enabled: true, flags: { capture: true, threadReplies: true } });
    for (const o of [{ replyState: 'sent' }, { replyState: 'uncertain' }, { replyState: 'deleted' }, { deleted: true }]) expect(O._freeWriteHtml(em(o))).toBe('');
    O._setFwUiForTests('em_f1', { open: true, text: 'say "hi" <now>', questions: ['When <exactly>?'] });
    const h = O._freeWriteHtml(em({ intel: { conversationKey: CKV, recipientsKnown: false } }));
    expect(h).not.toMatch(/data-draft=|\bet-draft\b|data-reply=|data-redraft=|data-send=|data-ei-|data-dismiss=/);
    expect(h).toContain('<textarea class="et-fw-input" data-fw-text="em_f1"');
    expect(h).toContain('>say &quot;hi&quot; &lt;now&gt;</textarea>');
    expect(h).toContain('data-fw-draft="reply" data-fw-id="em_f1">Draft Reply</button>');
    expect(h).toMatch(/data-fw-draft="reply-all" data-fw-id="em_f1" disabled aria-disabled="true"[^>]*>Draft Reply All</);
    expect(h).toContain('<li>When &lt;exactly&gt;?</li>');
    expect(h).toContain('data-fw-answers="em_f1"');
    expect(h).toContain('➤ Submit answers');
    expect(h).toContain('Draft anyway');
    // a legacy card (threadReplies off) gets the single legacy button
    O._setIntelForTests({ ok: true, enabled: true, flags: { capture: true } });
    expect(O._freeWriteHtml(em())).toContain('data-fw-draft="reply" data-fw-id="em_f1">Draft from my notes</button>');
    expect(O._freeWriteHtml(em())).not.toContain('Draft Reply All');
  });
});

describe('renderer: free-write DOM flow', () => {
  let d; let toasts; let off;
  const EM = () => ({ id: 'em_d1', fromName: 'Dealer', subject: 'Pickup 40123', summary: 's', importance: 'normal', unitRefs: [], replyState: 'none', intel: { conversationKey: CKV, recipientsKnown: true } });
  const DRAFT = { ok: true, draft: 'Hi Dealer,\n\nPickup Friday at 3 pm is confirmed.\n\nBest', mode: 'reply', aiUnavailable: false, warnings: [], basedOnMessageKey: 'mi_1', recipients: { to: [{ name: 'Dealer', address: 'd@example.test' }], cc: [] }, replyAllAvailable: true };
  beforeEach(() => {
    toasts = []; off = bus.on('ui:toast', (x) => toasts.push(x.message));
    d = htmlDom();
    globalThis.document = d.document; globalThis.CSS = { escape: (s) => s }; globalThis.confirm = () => true;
    O._setResultsForTests({ emails: [EM()] });
  });
  afterEach(() => {
    off(); O._setIntelForTests(null); O._setResultsForTests(null); O._setFwUiForTests('em_d1', null); O._setReplyUiForTests('em_d1', null);
    delete globalThis.window; delete globalThis.document; delete globalThis.CSS; delete globalThis.confirm;
  });

  it('intel card: toggle, typing survives a re-render, questions box, answers via Ctrl+Enter re-draft into the normal panel', async () => {
    O._setIntelForTests({ ok: true, enabled: true, flags: { capture: true, threadReplies: true } });
    const draftThreadReply = vi.fn(async (p) => (p.answers ? DRAFT : { ok: true, needsAnswers: true, questions: ['What time is pickup?'], mode: 'reply' }));
    globalThis.window = { emailIntel: { draftThreadReply } };
    O._render();
    expect(d.q('textarea[data-fw-text]')).toBeNull();
    d.q('[data-fw-toggle]').click();
    const ta = d.q('textarea[data-fw-text="em_d1"]');
    expect(ta).not.toBeNull();
    expect(ta.getAttribute('data-draft')).toBeNull();
    expect(ta.classList.contains('et-draft')).toBe(false);
    expect(d.q('[data-fw-draft="reply"]')).not.toBeNull();
    expect(d.q('[data-fw-draft="reply-all"]').disabled).toBe(false);
    ta.value = 'confirm Friday pickup, ask for the final invoice';
    ta.dispatch('input');
    O._render();                                                                       // full re-render (e.g. an emailTriage:updated push)
    expect(d.q('textarea[data-fw-text="em_d1"]').value).toBe('confirm Friday pickup, ask for the final invoice');
    expect(d.q('textarea[data-draft="em_d1"]')).toBeNull();

    d.q('[data-fw-draft="reply"]').click();
    await vi.waitFor(() => expect(d.q('[data-fw-submit]')).not.toBeNull());
    expect(draftThreadReply).toHaveBeenCalledTimes(1);
    expect(draftThreadReply.mock.calls[0][0]).toEqual({ conversationKey: CKV, mode: 'reply', force: false, guidance: 'confirm Friday pickup, ask for the final invoice', clarify: true });
    expect(d.body.innerHTML).toContain('<li>What time is pickup?</li>');
    expect(O._results().emails[0].replyState).toBe('none');                            // needsAnswers touches nothing else
    expect(O._results().emails[0].replyDraft).toBeUndefined();
    expect(toasts).toContain('The AI needs a bit more detail — answer below.');

    const ans = d.q('textarea[data-fw-answers="em_d1"]');
    ans.value = '3 pm';
    ans.dispatch('input');
    ans.dispatch('keydown', { key: 'Enter', ctrlKey: true });
    await vi.waitFor(() => expect(O._results().emails[0].replyState).toBe('drafted'));
    expect(draftThreadReply.mock.calls[1][0]).toEqual({ conversationKey: CKV, mode: 'reply', force: false, guidance: 'confirm Friday pickup, ask for the final invoice', clarify: true, answers: '3 pm' });
    const panel = d.q('textarea[data-draft="em_d1"]');
    expect(panel.value).toBe(DRAFT.draft);                                              // the normal reply panel, same Send flow
    expect(d.q('[data-fw-submit]')).toBeNull();                                         // questions cleared
    expect(d.q('textarea[data-fw-text="em_d1"]').value).toBe('confirm Friday pickup, ask for the final invoice');
    expect(d.q('[data-ei-send="reply"]')).not.toBeNull();
  });

  it('Draft anyway re-runs with clarify:false; the default Reply button payload is unchanged', async () => {
    O._setIntelForTests({ ok: true, enabled: true, flags: { capture: true, threadReplies: true } });
    const draftThreadReply = vi.fn(async (p) => (p.clarify ? { ok: true, needsAnswers: true, questions: ['Which unit?'], mode: p.mode } : DRAFT));
    globalThis.window = { emailIntel: { draftThreadReply } };
    O._setFwUiForTests('em_d1', { open: true, text: 'confirm pickup' });
    O._render();
    d.q('[data-fw-draft="reply-all"]').click();
    await vi.waitFor(() => expect(d.q('[data-fw-skip]')).not.toBeNull());
    d.q('[data-fw-skip]').click();
    await vi.waitFor(() => expect(O._results().emails[0].replyState).toBe('drafted'));
    expect(draftThreadReply.mock.calls[1][0]).toEqual({ conversationKey: CKV, mode: 'reply-all', force: false, guidance: 'confirm pickup', clarify: false });
    // the existing auto-draft buttons send exactly today's payload
    O._setResultsForTests({ emails: [EM()] });
    O._render();
    d.q('[data-ei-reply="reply"]').click();
    await vi.waitFor(() => expect(draftThreadReply).toHaveBeenCalledTimes(3));
    expect(draftThreadReply.mock.calls[2]).toEqual([{ conversationKey: CKV, mode: 'reply', force: false }]);
  });

  it('legacy card: Draft from my notes uses emailTriage.draftReply with opts; the legacy Reply button still sends (id, \'\')', async () => {
    O._setIntelForTests({ ok: true, enabled: true, flags: { capture: true } });
    const draftReply = vi.fn(async (_id, g) => (g ? { ok: true, needsAnswers: true, questions: ['Which day?'] } : { ok: true, draft: 'Hi' }));
    globalThis.window = { emailTriage: { draftReply } };
    O._setFwUiForTests('em_d1', { open: true, text: 'confirm pickup' });
    O._render();
    d.q('[data-fw-draft="reply"]').click();
    await vi.waitFor(() => expect(d.q('[data-fw-submit]')).not.toBeNull());
    expect(draftReply.mock.calls[0]).toEqual(['em_d1', 'confirm pickup', { clarify: true }]);
    expect(O._results().emails[0].replyState).toBe('none');
    d.q('[data-reply]').click();
    await vi.waitFor(() => expect(draftReply).toHaveBeenCalledTimes(2));
    expect(draftReply.mock.calls[1]).toEqual(['em_d1', '']);
  });

  it('flags off: no free-write box is rendered or wired', () => {
    O._setIntelForTests(null);
    globalThis.window = { emailTriage: { draftReply: vi.fn() } };
    O._render();
    expect(d.body.innerHTML).not.toContain('data-fw-');
  });
});
