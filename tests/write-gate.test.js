// tests/write-gate.test.js — the Relay write-approval gate (src/writes/write-gate.js):
// requireApproval default TRUE (no env override), interactive prompt approve/deny/timeout,
// the non-interactive pending-approval queue, single-shot approve of the stored payload,
// reject / expiry, approvedBy, dedup, and logs that never carry the comment text.
// All sends are mocks; nothing reaches the network.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const flags = require('../src/config/perf-flags');
const gate = require('../src/writes/write-gate');

const WR = '0a1b2c3d-1111-2222-3333-444455556666';
const TEXT = 'Dealer advised parts ETA 11/12.\nLine two <b>&</b> "quotes"';

function memStore() {
  const data = {};
  return {
    data,
    load: (k, d) => (k in data ? JSON.parse(JSON.stringify(data[k])) : d),
    save: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); },
  };
}

let apiPost, logs, store, notify, nowMs, win, sent;
function setup(over = {}) {
  apiPost = vi.fn(async () => ({ ok: true }));
  logs = [];
  store = memStore();
  notify = vi.fn();
  nowMs = Date.parse('2026-11-10T12:00:00Z');
  sent = [];
  win = { isDestroyed: () => false, webContents: { send: vi.fn((ch, data) => sent.push({ ch, data })) } };
  gate._setDepsForTest(Object.assign({
    apiPost, store, notify, now: () => nowMs, log: (m) => logs.push(m), flags: { requireApproval: true },
  }, over));
  gate.setWindowGetter(null);
}
const spec = (o = {}) => Object.assign({
  kind: 'addComment', origin: 'test', unit: 'B62020', workRequestId: WR,
  payload: { workRequestId: WR, text: TEXT }, interactive: false,
}, o);
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => setup());
afterEach(() => { vi.useRealTimers(); gate._setDepsForTest({}); gate.setWindowGetter(null); });

describe('resolveWriteFlags', () => {
  it('requireApproval defaults to true; only an explicit false disables it', () => {
    expect(flags.resolveWriteFlags({}).requireApproval).toBe(true);
    expect(flags.resolveWriteFlags({ writes: {} }).requireApproval).toBe(true);
    expect(flags.resolveWriteFlags(null).requireApproval).toBe(true);
    expect(flags.resolveWriteFlags({ writes: { requireApproval: 'false' } }).requireApproval).toBe(true);
    expect(flags.resolveWriteFlags({ writes: { requireApproval: false } }).requireApproval).toBe(false);
  });
  it('has no env override', () => {
    const prev = process.env.FLEET_WRITES_REQUIRE_APPROVAL;
    process.env.FLEET_WRITES_REQUIRE_APPROVAL = '0';
    try {
      expect(flags.loadWrites({ load: () => ({}) }).requireApproval).toBe(true);
      expect(flags.resolveWriteFlags({}, { FLEET_WRITES_REQUIRE_APPROVAL: '0' }).requireApproval).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.FLEET_WRITES_REQUIRE_APPROVAL; else process.env.FLEET_WRITES_REQUIRE_APPROVAL = prev;
    }
    expect(flags.loadWrites({ load: () => { throw new Error('x'); } }).requireApproval).toBe(true);
  });
});

describe('interactive prompt', () => {
  it('deny -> 0 sends, skipped-not-approved', async () => {
    gate.setWindowGetter(() => win);
    const p = gate.requestWrite(spec({ interactive: true }));
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].ch).toBe('relayWrites:approval-request');
    expect(gate.respond(sent[0].data.id, false).ok).toBe(true);
    const r = await p;
    expect(r.outcome).toBe('skipped-not-approved');
    expect(r.ok).toBe(false);
    expect(apiPost).not.toHaveBeenCalled();
    expect(gate.list().items.find((i) => i.id === r.id).state).toBe('not-approved');
  });

  it('grant -> exactly 1 addComment with the previewed text byte-for-byte', async () => {
    gate.setWindowGetter(() => win);
    const p = gate.requestWrite(spec({ interactive: true, aiDrafted: true }));
    await flush();
    const req = sent[0].data;
    expect(req.kind).toBe('addComment');
    expect(req.aiDrafted).toBe(true);
    expect(req.preview).toContain('AI-drafted: yes');
    expect(req.preview).toContain('https://aap-na.corp.amazon.com/v2/service/' + WR);
    expect(req.preview).toContain('Visibility: internal-only');
    gate.respond(req.id, true);
    const r = await p;
    expect(r.outcome).toBe('sent');
    expect(apiPost).toHaveBeenCalledTimes(1);
    const [path, body] = apiPost.mock.calls[0];
    expect(path).toBe('/api/v1/addComment');
    expect(body).toEqual({ workRequestId: WR, text: TEXT, internalOnly: true, externalConsumers: [] });
    expect(req.preview.endsWith('\n' + body.text)).toBe(true);
    expect(gate.list().items.find((i) => i.id === r.id).state).toBe('sent');
  });

  it('text over 2000 chars: the preview shows the same truncated text that is sent', async () => {
    gate.setWindowGetter(() => win);
    const long = 'x'.repeat(2100);
    const p = gate.requestWrite(spec({ interactive: true, payload: { workRequestId: WR, text: long } }));
    await flush();
    gate.respond(sent[0].data.id, true);
    await p;
    const body = apiPost.mock.calls[0][1];
    expect(body.text).toHaveLength(2000);
    expect(sent[0].data.preview.endsWith('\n' + body.text)).toBe(true);
  });

  it('no answer within APPROVAL_WAIT_MS -> skipped, 0 sends', async () => {
    vi.useFakeTimers();
    gate.setWindowGetter(() => win);
    const p = gate.requestWrite(spec({ interactive: true }));
    await vi.advanceTimersByTimeAsync(gate.APPROVAL_WAIT_MS + 10);
    const r = await p;
    expect(r.outcome).toBe('skipped-not-approved');
    expect(apiPost).not.toHaveBeenCalled();
    // A late answer cannot send it.
    expect(gate.respond(r.id, true).ok).toBe(false);
    expect((await gate.approve(r.id)).ok).toBe(false);
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe('non-interactive queue', () => {
  it('no window -> pending-approval, 0 sends; approve sends the stored payload once', async () => {
    const r = await gate.requestWrite(spec({ interactive: true }));   // interactive but no window
    expect(r.outcome).toBe('pending-approval');
    expect(apiPost).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('relayWrites:updated', expect.anything());
    const item = gate.list().items.find((i) => i.id === r.id);
    expect(item.state).toBe('pending');
    expect(item.payload).toBeUndefined();          // list never exposes payloads
    const a = await gate.approve(r.id);
    expect(a.outcome).toBe('sent');
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(apiPost.mock.calls[0][1].text).toBe(TEXT);
    const again = await gate.approve(r.id);
    expect(again.ok).toBe(false);
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('reject -> never sent', async () => {
    const r = await gate.requestWrite(spec());
    expect(gate.reject(r.id).ok).toBe(true);
    expect((await gate.approve(r.id)).ok).toBe(false);
    expect(apiPost).not.toHaveBeenCalled();
    expect(gate.list().items.find((i) => i.id === r.id).state).toBe('rejected');
  });

  it('pending over 24 h -> expired and refused', async () => {
    const r = await gate.requestWrite(spec());
    nowMs += gate.PENDING_TTL_MS + 1000;
    const a = await gate.approve(r.id);
    expect(a.ok).toBe(false);
    expect(a.error).toMatch(/expired/);
    expect(apiPost).not.toHaveBeenCalled();
    expect(gate.list().items.find((i) => i.id === r.id).state).toBe('expired');
  });

  it('identical pending writes reuse the id', async () => {
    const a = await gate.requestWrite(spec());
    const b = await gate.requestWrite(spec());
    expect(b.id).toBe(a.id);
    expect(gate.list().items.filter((i) => i.state === 'pending')).toHaveLength(1);
    const c = await gate.requestWrite(spec({ payload: { workRequestId: WR, text: TEXT + '!' } }));
    expect(c.id).not.toBe(a.id);
  });

  it('a payload over 2 MB is held in memory only and still sends exactly once', async () => {
    const big = { aaid: 'aaid-1', vendor: 'COX', vendorCode: 'COX', title: 'T', attachments: [{ name: 'a.png', dataUrl: 'data:image/png;base64,' + 'A'.repeat(2.2 * 1024 * 1024) }] };
    const commitWorkOrder = vi.fn(async () => ({ ok: true, phase: 'commit', workRequestId: 'wr-new' }));
    setup({ commitWorkOrder });
    const r = await gate.requestWrite({ kind: 'createWorkOrder', origin: 'test', unit: 'U1', payload: big, interactive: false });
    expect(r.outcome).toBe('pending-approval');
    expect(store.data.relayWritesPending.items[0].payload).toBeNull();
    expect(store.data.relayWritesPending.items[0].memoryOnly).toBe(true);
    const a = await gate.approve(r.id);
    expect(a.outcome).toBe('sent');
    expect(commitWorkOrder).toHaveBeenCalledTimes(1);
    expect(commitWorkOrder.mock.calls[0][0]).toBe(big);
  });
});

describe('approvedBy / requireApproval false', () => {
  it('approvedBy -> 1 send, no prompt, logged approved by=', async () => {
    gate.setWindowGetter(() => win);
    const r = await gate.requestWrite(spec({ interactive: true, approvedBy: 'relay-reconcile-overlay' }));
    expect(r.outcome).toBe('sent');
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
    expect(logs.some((l) => /\[write\] approved .*by=relay-reconcile-overlay/.test(l))).toBe(true);
  });

  it('requireApproval false -> 1 send, no prompt', async () => {
    setup({ flags: { requireApproval: false } });
    gate.setWindowGetter(() => win);
    const r = await gate.requestWrite(spec({ interactive: true }));
    expect(r.outcome).toBe('sent');
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
  });

  it('send failure -> send-failed', async () => {
    setup({ apiPost: vi.fn(async () => { throw new Error('AAP API 500: boom'); }) });
    const r = await gate.requestWrite(spec({ approvedBy: 'x' }));
    expect(r.outcome).toBe('send-failed');
    expect(r.ok).toBe(false);
    expect(logs.some((l) => l.startsWith('[write] send-failed'))).toBe(true);
  });
});

describe('createWorkOrder preview + token', () => {
  it('preview lists the WR fields from the stored payload', () => {
    const pv = gate.previewOf('createWorkOrder', {
      title: 'Check engine light', vendor: 'Amerit', vendorCode: 'AMERITFLT', offSite: true,
      locStreet: '1 Main St', locCity: 'Allentown', locState: 'PA', locZip: '18101',
      towToStreet: '2 Yard Rd', towToCity: 'Bethlehem', towDirection: 'return-to-yard',
      areaPairs: [{ area: 'ENG', subcategory: 'CEL', subSubcategory: '' }], urgent: 'Yes', urgencyReason: 'DEA - Asset Shortage',
      comments: 'Please diagnose', shareWith: 'internal', contactName: 'Z', contactPhone: '716-614-2167',
      attachments: [{ name: 'photo.png', dataUrl: 'data:' }], copiedFromWorkRequestId: WR,
    }, { unit: 'B62020', origin: 'fas-action' });
    for (const s of ['Unit: B62020', 'Title: Check engine light', 'Vendor: Amerit -> AMERITFLT', 'Off-site: 1 Main St, Allentown, PA, 18101',
      'Tow destination: 2 Yard Rd, Bethlehem (return-to-yard)', 'ENG / CEL', 'Urgent: yes (DEA - Asset Shortage)', 'internal-only',
      'Contact: Z, 716-614-2167', 'Attachments: 1 (photo.png)', 'Linked WR: ' + WR, 'Origin: fas-action', 'Please diagnose']) {
      expect(pv).toContain(s);
    }
  });

  it('isApprovalToken accepts only a live gate token, once', async () => {
    let seen = null;
    const commitWorkOrder = vi.fn(async (_o, t) => { seen = gate.isApprovalToken(t); return { ok: true, workRequestId: 'w' }; });
    setup({ commitWorkOrder });
    await gate.requestWrite({ kind: 'createWorkOrder', origin: 't', payload: { aaid: 'a' }, approvedBy: 'x' });
    expect(seen).toBe(true);
    expect(gate.isApprovalToken({})).toBe(false);
    expect(gate.isApprovalToken(null)).toBe(false);
  });
});

describe('logging', () => {
  it('logs attempted, gated, approved, sent — never the comment text', async () => {
    const r = await gate.requestWrite(spec());
    await gate.approve(r.id);
    const joined = logs.join('\n');
    for (const ev of ['attempted', 'gated', 'approved', 'sent']) expect(joined).toContain('[write] ' + ev + ' kind=addComment');
    expect(joined).toContain('status=pending-approval');
    expect(joined).toContain('len=' + TEXT.length);
    expect(joined).not.toContain('Dealer advised');
    expect(joined).not.toContain('Line two');
  });
});
describe('review fixes: preview completeness, aiDrafted tri-state, dedup, onSent', () => {
  const WO = {
    aaid: 'aaid-1', title: 'Check engine light', issue: 'AI: CEL on, derate after 20 mi', vendor: 'Cox', vendorCode: 'COX',
    supplierId: 'SUP-9', arcClaim: 'ARC-77', simNumber: 'SIM-5', comments: 'Please diagnose', contactName: 'Z',
    areaPairs: [{ area: 'ENG', subcategory: 'CEL' }],
  };
  it('createWorkOrder preview shows the description, supplier, ARC claim, SIM and comment author', () => {
    const pv = gate.previewOf('createWorkOrder', WO, { unit: 'B62020', aiDrafted: true });
    for (const s of ['Description (exact, 30 chars):\nAI: CEL on, derate after 20 mi', 'Supplier: SUP-9', 'ARC claim: ARC-77',
      'SIM number: SIM-5', 'Comment author: Z', 'AI-drafted: yes']) expect(pv).toContain(s);
  });
  it('description falls back to the title, then the generic text, like the /createRepair body', () => {
    expect(gate.previewOf('createWorkOrder', { title: 'T1' }, {})).toContain('Description (exact, 2 chars):\nT1');
    expect(gate.previewOf('createWorkOrder', {}, {})).toContain('Repair requested via Fleet Ops Center');
    expect(gate.previewOf('createWorkOrder', { vendorCode: 'UNASSIGNED', supplierId: 'S' }, {})).toContain('Supplier: (the Relay vendor recommendation');
  });
  it('AI-drafted is unknown when the caller does not say, no only when it says false', async () => {
    expect(gate.previewOf('createWorkOrder', WO, {})).toContain('AI-drafted: unknown');
    expect(gate.previewOf('createWorkOrder', WO, { aiDrafted: false })).toContain('AI-drafted: no');
    const r = await gate.requestWrite({ kind: 'createWorkOrder', origin: 'approve-wr', payload: WO, interactive: false });
    const it0 = gate.list().items.find((i) => i.id === r.id);
    expect(it0.aiDrafted).toBeNull();
    expect(it0.preview).toContain('AI-drafted: unknown');
  });
  it('a repeat WR request that differs only in live GPS / address reuses the pending item', async () => {
    const a = await gate.requestWrite({ kind: 'createWorkOrder', origin: 'daily-tasks', payload: Object.assign({}, WO,
      { locationLatest: { geoPoint: { latitude: 40.1, longitude: -75.1 } }, offSite: true, locStreet: '1 Main St' }), interactive: false });
    const b = await gate.requestWrite({ kind: 'createWorkOrder', origin: 'daily-tasks', payload: Object.assign({}, WO,
      { locationLatest: { geoPoint: { latitude: 40.2, longitude: -75.2 } }, offSite: true, locStreet: '9 Other Rd' }), interactive: false });
    expect(b.id).toBe(a.id);
    expect(gate.list().items.filter((i) => i.state === 'pending')).toHaveLength(1);
    const c = await gate.requestWrite({ kind: 'createWorkOrder', origin: 'daily-tasks', payload: Object.assign({}, WO, { title: 'Other' }), interactive: false });
    expect(c.id).not.toBe(a.id);
  });
  it('onSent tells the origin when its queued item is approved and sent (ref + WR id), not on reject', async () => {
    const commitWorkOrder = vi.fn(async () => ({ ok: true, phase: 'commit', workRequestId: 'wr-77' }));
    setup({ commitWorkOrder });
    const seen = [];
    gate.onSent('daily-tasks', (item) => seen.push(item));
    try {
      const r = await gate.requestWrite({ kind: 'createWorkOrder', origin: 'daily-tasks', payload: WO, interactive: false, ref: { taskId: 't9' } });
      expect(seen).toHaveLength(0);
      await gate.approve(r.id);
      expect(seen).toHaveLength(1);
      expect(seen[0].ref).toEqual({ taskId: 't9' });
      expect(seen[0].sentWorkRequestId).toBe('wr-77');
      const r2 = await gate.requestWrite({ kind: 'createWorkOrder', origin: 'daily-tasks', payload: Object.assign({}, WO, { title: 'X' }), interactive: false, ref: { taskId: 't10' } });
      gate.reject(r2.id);
      expect(seen).toHaveLength(1);
    } finally { gate.onSent('daily-tasks', null); }
  });
});

describe('dtnaComment (dealer-visible DTNA case comment, findings §10)', () => {
  const CASE = '500gx000002E4U5AAK';
  const DTEXT = 'Hi team, can you share the ETA for unit 122269?';
  const dspec = (o = {}) => Object.assign({
    kind: 'dtnaComment', origin: 'unit-detail-dtna', unit: '122269', aiDrafted: true,
    payload: { caseId: CASE, repairOrderId: 'a0Xgx0000012345AAA', repairOrderNo: 'R101048154', text: DTEXT }, interactive: false,
  }, o);
  let post;
  let tokens;
  function dsetup(over = {}) {
    tokens = [];
    post = vi.fn(async (_p, t) => { tokens.push(t); return { ok: true, commentId: 'a1Agx0000000099AAA' }; });
    setup(Object.assign({ dtnaPostComment: post }, over));
  }

  it('previewOf shows the exact case, RO, dealer visibility and text', () => {
    const pv = gate.previewOf('dtnaComment', { caseId: CASE, repairOrderNo: 'R101048154', text: DTEXT }, { unit: '122269', origin: 'unit-detail-dtna', aiDrafted: true });
    expect(pv).toBe([
      'DTNA write: post comment to Service Tracker case',
      'Unit: 122269',
      'DTNA case: ' + CASE + '  https://dtna.my.site.com/Servicetracker/s/case/' + CASE + '/detail',
      'Repair order: R101048154',
      'Comment type: (none)',
      'Visibility: VISIBLE TO THE DEALER (DTNA)',
      'AI-drafted: yes',
      'Origin: unit-detail-dtna',
      'Text (exact, ' + DTEXT.length + ' chars):',
      DTEXT,
    ].join('\n'));
    expect(gate.previewOf('dtnaComment', { caseId: CASE, text: 'x' }, {})).toContain('Repair order: (none)');
  });

  it('is gated even with requireApproval:false (no window -> pending-approval, nothing sent)', async () => {
    dsetup({ flags: { requireApproval: false } });
    const r = await gate.requestWrite(dspec());
    expect(r.outcome).toBe('pending-approval');
    expect(r.error).toContain('nothing was sent to DTNA');
    expect(post).not.toHaveBeenCalled();
    expect(logs.some((l) => /approved .*by=setting-requireApproval-false/.test(l))).toBe(false);
    const it0 = gate.list().items.find((i) => i.id === r.id);
    expect(it0.kind).toBe('dtnaComment');
    expect(it0.preview).toContain('Visibility: VISIBLE TO THE DEALER (DTNA)');
  });

  it('approvedBy does not bypass approval (logged approvedBy-ignored)', async () => {
    dsetup({ flags: { requireApproval: false } });
    const r = await gate.requestWrite(dspec({ approvedBy: 'some-modal' }));
    expect(r.outcome).toBe('pending-approval');
    expect(post).not.toHaveBeenCalled();
    expect(logs.some((l) => l.startsWith('[write] approvedBy-ignored kind=dtnaComment'))).toBe(true);
  });

  it('interactive approve sends exactly once; a second approve is refused', async () => {
    dsetup({ flags: { requireApproval: false } });
    gate.setWindowGetter(() => win);
    const p = gate.requestWrite(dspec({ interactive: true }));
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].data.kind).toBe('dtnaComment');
    expect(sent[0].data.preview).toContain('VISIBLE TO THE DEALER (DTNA)');
    expect(post).not.toHaveBeenCalled();
    gate.respond(sent[0].data.id, true);
    const r = await p;
    expect(r).toMatchObject({ ok: true, outcome: 'sent', result: { commentId: 'a1Agx0000000099AAA' } });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toEqual({ caseId: CASE, repairOrderId: 'a0Xgx0000012345AAA', repairOrderNo: 'R101048154', text: DTEXT });
    const again = await gate.approve(r.id);
    expect(again.outcome).toBe('skipped-not-approved');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('interactive deny -> nothing sent', async () => {
    dsetup();
    gate.setWindowGetter(() => win);
    const p = gate.requestWrite(dspec({ interactive: true }));
    await flush();
    gate.respond(sent[0].data.id, false);
    const r = await p;
    expect(r).toMatchObject({ ok: false, outcome: 'skipped-not-approved', error: 'Not approved; nothing was sent to DTNA' });
    expect(post).not.toHaveBeenCalled();
  });

  it('the token passed to the DTNA post is a single-use approval token', async () => {
    let accepted = null;
    let second = null;
    dsetup({ dtnaPostComment: vi.fn(async (_p, t) => { accepted = gate.isApprovalToken(t); second = gate.isApprovalToken(t); return { ok: true, commentId: '' }; }) });
    const r = await gate.requestWrite(dspec());
    await gate.approve(r.id);
    expect(accepted).toBe(true);
    expect(second).toBe(false);
    expect(gate.isApprovalToken({})).toBe(false);
  });

  it('a failed post -> send-failed with the code only; logs carry len= and never the text', async () => {
    dsetup({ dtnaPostComment: vi.fn(async () => ({ ok: false, code: 'DTNA_APEX_ERROR', message: 'secret ' + DTEXT })) });
    const r = await gate.requestWrite(dspec());
    const s = await gate.approve(r.id);
    expect(s).toEqual({ ok: false, outcome: 'send-failed', id: r.id, result: null, error: 'DTNA_APEX_ERROR' });
    dsetup();
    const r2 = await gate.requestWrite(dspec());
    await gate.approve(r2.id);
    expect(logs.some((l) => l.startsWith('[write] sent kind=dtnaComment') && l.includes('len=' + DTEXT.length))).toBe(true);
    expect(logs.join('\n')).not.toContain(DTEXT);
  });

  it('a throwing post -> DTNA_INTERNAL, no message', async () => {
    dsetup({ dtnaPostComment: vi.fn(async () => { throw new Error('boom ' + DTEXT); }) });
    const r = await gate.requestWrite(dspec());
    const s = await gate.approve(r.id);
    expect(s).toMatchObject({ ok: false, outcome: 'send-failed', error: 'DTNA_INTERNAL' });
    expect(logs.join('\n')).not.toContain(DTEXT);
  });

  it('EXTERNAL_KINDS holds only the DTNA kinds; addComment with requireApproval:false still sends directly', async () => {
    expect([...gate.EXTERNAL_KINDS]).toEqual(['dtnaComment', 'dtnaStage']);
    dsetup({ flags: { requireApproval: false } });
    const r = await gate.requestWrite(spec());
    expect(r.outcome).toBe('sent');
    expect(apiPost).toHaveBeenCalledTimes(1);
  });
});

describe('dtnaStage (dealer-visible forward-only DTNA stage change, Phase C)', () => {
  const CASE = '500gx000002E4U5AAK';
  const PAY = { caseId: CASE, fromStage: 'In-Repair', toStage: 'Closed', repairOrderNo: 'R101048154' };
  const sspec = (o = {}) => Object.assign({
    kind: 'dtnaStage', origin: 'unit-detail-dtna-stage', unit: '122269', payload: PAY, interactive: false,
  }, o);
  let change;
  let tokens;
  function ssetup(over = {}) {
    tokens = [];
    change = vi.fn(async (p, t) => { tokens.push(t); return { ok: true, toStage: p.toStage }; });
    setup(Object.assign({ dtnaChangeStage: change }, over));
  }

  it('previewOf is exact: from -> to, unit, case + url, RO, dealer-visible, origin', () => {
    expect(gate.previewOf('dtnaStage', PAY, { unit: '122269', origin: 'unit-detail-dtna-stage' })).toBe([
      'CHANGE DTNA CASE STAGE: In-Repair -> Closed',
      'Unit: 122269',
      'DTNA case: ' + CASE + '  https://dtna.my.site.com/Servicetracker/s/case/' + CASE + '/detail',
      'Repair order: R101048154',
      'Visibility: VISIBLE TO THE DEALER (DTNA)',
      'Origin: unit-detail-dtna-stage',
    ].join('\n'));
    expect(gate.previewOf('dtnaStage', { caseId: CASE, fromStage: 'Arrived', toStage: 'In-Repair' }, {})).toContain('Repair order: (none)');
  });

  it('is gated even with requireApproval:false (pending-approval, nothing sent)', async () => {
    ssetup({ flags: { requireApproval: false } });
    const r = await gate.requestWrite(sspec());
    expect(r.outcome).toBe('pending-approval');
    expect(r.error).toContain('nothing was sent to DTNA');
    expect(change).not.toHaveBeenCalled();
    expect(logs.some((l) => /approved .*by=setting-requireApproval-false/.test(l))).toBe(false);
    const it0 = gate.list().items.find((i) => i.id === r.id);
    expect(it0.kind).toBe('dtnaStage');
    expect(it0.preview).toContain('CHANGE DTNA CASE STAGE: In-Repair -> Closed');
    expect(it0.preview).toContain('VISIBLE TO THE DEALER (DTNA)');
  });

  it('approvedBy is ignored (logged approvedBy-ignored)', async () => {
    ssetup({ flags: { requireApproval: false } });
    const r = await gate.requestWrite(sspec({ approvedBy: 'some-modal' }));
    expect(r.outcome).toBe('pending-approval');
    expect(change).not.toHaveBeenCalled();
    expect(logs.some((l) => l.startsWith('[write] approvedBy-ignored kind=dtnaStage'))).toBe(true);
  });

  it('same / earlier / unknown stage or a bad case id -> DTNA_STAGE_NOT_FORWARD: nothing staged, no prompt, no send', async () => {
    ssetup({ flags: { requireApproval: false } });
    gate.setWindowGetter(() => win);
    const bad = [
      { fromStage: 'In-Repair', toStage: 'In-Repair' },
      { fromStage: 'Closed', toStage: 'In-Repair' },
      { fromStage: 'In-Repair', toStage: 'Arrived' },
      { fromStage: 'In-Repair', toStage: 'Done' },
      { fromStage: 'Bogus', toStage: 'Closed' },
      { caseId: 'nope' },
    ];
    for (const b of bad) {
      const r = await gate.requestWrite(sspec({ interactive: true, payload: Object.assign({}, PAY, b) }));
      expect(r).toEqual({ ok: false, outcome: 'skipped-not-approved', id: null, error: 'DTNA_STAGE_NOT_FORWARD' });
    }
    expect(sent).toHaveLength(0);
    expect(gate.list().items).toHaveLength(0);
    expect(change).not.toHaveBeenCalled();
  });

  it('interactive approve sends once with a single-use token; a second approve is refused', async () => {
    let accepted = null;
    let second = null;
    ssetup({ flags: { requireApproval: false }, dtnaChangeStage: vi.fn(async (p, t) => { accepted = gate.isApprovalToken(t); second = gate.isApprovalToken(t); return { ok: true, toStage: p.toStage }; }) });
    gate.setWindowGetter(() => win);
    const p = gate.requestWrite(sspec({ interactive: true }));
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].data.kind).toBe('dtnaStage');
    expect(sent[0].data.preview).toContain('CHANGE DTNA CASE STAGE: In-Repair -> Closed');
    gate.respond(sent[0].data.id, true);
    const r = await p;
    expect(r).toMatchObject({ ok: true, outcome: 'sent', result: { toStage: 'Closed' } });
    expect(accepted).toBe(true);
    expect(second).toBe(false);
    const again = await gate.approve(r.id);
    expect(again.outcome).toBe('skipped-not-approved');
    expect(again.error).toBe('write already sent');
    expect(logs.some((l) => l.startsWith('[write] sent kind=dtnaStage') && l.includes('len=0'))).toBe(true);
  });

  it('the send gets the exact stored payload; deny -> nothing sent', async () => {
    ssetup();
    const r = await gate.requestWrite(sspec());
    await gate.approve(r.id);
    expect(change).toHaveBeenCalledTimes(1);
    expect(change.mock.calls[0][0]).toEqual(PAY);
    ssetup();
    gate.setWindowGetter(() => win);
    const p = gate.requestWrite(sspec({ interactive: true }));
    await flush();
    gate.respond(sent[0].data.id, false);
    expect(await p).toMatchObject({ ok: false, outcome: 'skipped-not-approved', error: 'Not approved; nothing was sent to DTNA' });
    expect(change).not.toHaveBeenCalled();
  });

  it('a failed change -> send-failed with a sanitized code; a throw -> DTNA_INTERNAL', async () => {
    ssetup({ dtnaChangeStage: vi.fn(async () => ({ ok: false, code: 'DTNA_apex error <x> ' + 'A'.repeat(80), message: 'secret' })) });
    const r = await gate.requestWrite(sspec());
    const s = await gate.approve(r.id);
    expect(s).toEqual({ ok: false, outcome: 'send-failed', id: r.id, result: null, error: 'DTNA_' + 'A'.repeat(35) });
    ssetup({ dtnaChangeStage: vi.fn(async () => { throw new Error('boom secret'); }) });
    const r2 = await gate.requestWrite(sspec());
    expect(await gate.approve(r2.id)).toMatchObject({ ok: false, outcome: 'send-failed', error: 'DTNA_INTERNAL' });
    expect(logs.join('\n')).not.toContain('secret');
  });
});
