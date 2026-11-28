// tests/decisiv-reply.test.js — src/writes/decisiv-reply.js: the exact nested
// reply body, N contacts -> N recipients, the case-roster path (estimate id,
// filter=subcase_dealer then dealer, group_id=-1), the full-directory guard,
// latest-note selection, and the approval-token check. Plus static guards: the reply path
// and the case POST helper live only where they should, and no automated
// path (autopilot, scheduler, dbr, health, asana, ai) can stage a Decisiv reply.
// Synthetic ids and names only; every network call is a mock.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);

const dr = require('../src/writes/decisiv-reply');

const EST = '1000001';
const CASE = '1000002';
const SR = 'https://paccarpg.decisiv.net/fleet/estimates/' + EST;
const cid = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const contact = (n, o = {}) => Object.assign({ id: cid(n), name: 'Contact ' + n, email: 'c' + n + '@example.test', job_role: 'Role ' + n,
  sub_group: n % 2 ? 'Dealer Group A' : 'Amazon Staff Group', pinned: true, filter_name: n % 2 ? 'dealer' : 'fleet_dealer' }, o);
const many = (n, from = 1) => Array.from({ length: n }, (_, i) => contact(from + i));
// apiGetForCase mock answering per filter: { subcase_dealer: [...] | Error, dealer: [...] | Error }.
const rosterApi = (byFilter) => ({
  getEstimateContacts: vi.fn(async () => { throw new Error('groups endpoint must not be called'); }),
  apiGetForCase: vi.fn(async (_u, p) => {
    const f = /[?&]filter=([a-z_]+)&/.exec(p)[1];
    const v = byFilter[f];
    if (v instanceof Error) throw v;
    return v === undefined ? [] : v;
  }),
});
const filterOf = (call) => /[?&]filter=([a-z_]+)&/.exec(call[1])[1];

afterEach(() => { dr._setDepsForTest({}); });

describe('buildReplyRequest', () => {
  it('builds the exact nested body; reply_to_id equals the note id in the path; subject_id is a number', () => {
    const payload = { unitId: 'U1', caseId: CASE, estimateId: EST, srUrl: SR, text: 'Thank you',
      recipients: [{ id: cid(1), name: 'Dealer Writer A' }, { id: cid(2), name: 'Amazon Staff B' }, { id: cid(3), name: 'Dealer Writer C' }] };
    const { path: p, body } = dr.buildReplyRequest(payload, '5000001');
    expect(p).toBe('/mobilecomm/api/estimates/1000001/notes/5000001/reply.json');
    expect(body).toEqual({
      note: {
        recipients: [
          { to_recipient_uuid: cid(1), to_user_id: cid(1), to_group_id: -1 },
          { to_recipient_uuid: cid(2), to_user_id: cid(2), to_group_id: -1 },
          { to_recipient_uuid: cid(3), to_user_id: cid(3), to_group_id: -1 },
        ],
        draft: false,
        public: true,
        note: 'Thank you',
      },
      reply_to_id: '5000001',
      subject_id: 1000002,
      group_id: -1,
    });
    expect(typeof body.subject_id).toBe('number');
    expect(typeof body.reply_to_id).toBe('string');
    expect(p).toContain('/notes/' + body.reply_to_id + '/');
  });

  it('N selected contacts -> N recipient entries (1, 3, 50)', () => {
    for (const n of [1, 3, 50]) {
      const recipients = Array.from({ length: n }, (_, i) => ({ id: cid(i + 1), name: 'N' + i }));
      const { body } = dr.buildReplyRequest({ caseId: CASE, estimateId: EST, text: 'x', recipients }, 5000001);
      expect(body.note.recipients).toHaveLength(n);
      expect(body.note.recipients.map((r) => r.to_recipient_uuid)).toEqual(recipients.map((r) => r.id));
    }
  });

  it('throws on no recipients, too many, empty text, a non-numeric case id or a bad recipient id', () => {
    const ok = { caseId: CASE, estimateId: EST, text: 'x', recipients: [{ id: cid(1) }] };
    expect(() => dr.buildReplyRequest(Object.assign({}, ok, { recipients: [] }), 5000001)).toThrow();
    expect(() => dr.buildReplyRequest(Object.assign({}, ok, { recipients: Array.from({ length: 51 }, (_, i) => ({ id: cid(i + 1) })) }), 5000001)).toThrow();
    expect(() => dr.buildReplyRequest(Object.assign({}, ok, { text: '   ' }), 5000001)).toThrow();
    expect(() => dr.buildReplyRequest(Object.assign({}, ok, { caseId: 'abc' }), 5000001)).toThrow();
    expect(() => dr.buildReplyRequest(Object.assign({}, ok, { recipients: [{ id: 'not-a-uuid' }] }), 5000001)).toThrow();
    expect(() => dr.buildReplyRequest(ok, '')).toThrow();
  });
});

describe('paths and refs', () => {
  it('the roster path takes the id and one of the two filters, with group_id=-1 and mobile=false', () => {
    expect(dr.rosterPath(EST, 'subcase_dealer')).toBe('/mobilecomm/api/contacts/estimate_contacts_for_group.json?estimate_id=1000001&group_id=-1&filter=subcase_dealer&mobile=false');
    expect(dr.rosterPath(EST, 'dealer')).toBe('/mobilecomm/api/contacts/estimate_contacts_for_group.json?estimate_id=1000001&group_id=-1&filter=dealer&mobile=false');
    expect(() => dr.rosterPath(EST, 'fleet_dealer')).toThrow();
    expect(() => dr.rosterPath(EST)).toThrow();
    expect([...dr.ROSTER_FILTERS]).toEqual(['subcase_dealer', 'dealer']);
  });
  it('the feed path is activity_logs page 1, 50 per page (not notes.json)', () => {
    expect(dr.activityPath(EST)).toBe('/mobilecomm/api/estimates/1000001/activity_logs?page=1&per_page=50');
  });
  it('replyRefFromUrl: PACCAR estimate URLs only', () => {
    expect(dr.replyRefFromUrl(SR + '?tab=notes')).toEqual({ estimateId: EST, srUrl: SR });
    expect(dr.replyRefFromUrl('https://pssmfleet.decisiv.net/fleet/estimates/7')).toEqual({ estimateId: '7', srUrl: 'https://pssmfleet.decisiv.net/fleet/estimates/7' });
    expect(dr.replyRefFromUrl('https://volvopg.asist.decisiv.net/fleet/estimates/7')).toEqual({ estimateId: '7', srUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/7' });
    expect(dr.replyRefFromUrl('https://evil.example/fleet/estimates/7')).toBe(null);
    expect(dr.replyRefFromUrl('https://volvopg.asist.decisiv.net.evil.example/fleet/estimates/7')).toBe(null);
    expect(dr.replyRefFromUrl('http://volvopg.asist.decisiv.net/fleet/estimates/7')).toBe(null);
    expect(dr.replyRefFromUrl('https://dtna.my.site.com/Servicetracker/s/case/500x')).toBe(null);
    expect(dr.replyRefFromUrl('http://paccarpg.decisiv.net/fleet/estimates/7')).toBe(null);
    expect(dr.replyRefFromUrl('')).toBe(null);
  });
});

describe('normalizeRoster', () => {
  it('keeps id, name, jobRole, subGroup, filterName; drops emails, non-UUID ids and duplicates', () => {
    const out = dr.normalizeRoster([contact(1), contact(2, { job_role: '' }), contact(1), { id: 'bad', name: 'X' }, null]);
    expect(out).toEqual([
      { id: cid(1), name: 'Contact 1', jobRole: 'Role 1', subGroup: 'Dealer Group A', filterName: 'dealer' },
      { id: cid(2), name: 'Contact 2', jobRole: '', subGroup: 'Amazon Staff Group', filterName: 'fleet_dealer' },
    ]);
    expect(JSON.stringify(out)).not.toContain('@');
  });
});

describe('pickLatestNote (synthetic activity_logs)', () => {
  const feed = (notes) => ({ notes, total_count: notes.length, page: 1, per_page: 50 });
  it('Decisiv-format created_at out of feed order -> the max timestamp', () => {
    const r = dr.pickLatestNote(feed([
      { id: 5000001, created_at: '11/10/26 10:28 am EST', draft: false },
      { id: 5000003, created_at: '11/12/26 1:05 pm EST', draft: false },
      { id: 5000002, created_at: '11/12/26 9:59 am EST', draft: false },
    ]));
    expect(r).toEqual({ ok: true, noteId: '5000003', by: 'created_at' });
  });
  it('12 am / 12 pm and 4-digit years parse in order', () => {
    expect(dr.parseNoteTime('11/12/26 12:05 am EST').ms).toBeLessThan(dr.parseNoteTime('11/12/26 1:00 am EST').ms);
    expect(dr.parseNoteTime('11/12/2026 12:05 pm').ms).toBeGreaterThan(dr.parseNoteTime('11/12/26 11:59 am PST').ms);
    expect(dr.parseNoteTime('nonsense')).toBe(null);
  });
  it('ties go to the earlier feed position (feed is newest-first)', () => {
    const r = dr.pickLatestNote(feed([
      { id: 5000005, created_at: '11/12/26 1:05 pm EST' },
      { id: 5000004, created_at: '11/12/26 1:05 pm EST' },
    ]));
    expect(r.noteId).toBe('5000005');
  });
  it('one unparsable created_at -> feed order (notes[0])', () => {
    const r = dr.pickLatestNote(feed([
      { id: 5000001, created_at: '11/10/26 10:28 am EST' },
      { id: 5000003, created_at: 'yesterday' },
    ]));
    expect(r).toEqual({ ok: true, noteId: '5000001', by: 'feed-order' });
  });
  it('draft notes and notes without a numeric id are skipped', () => {
    const r = dr.pickLatestNote(feed([
      { id: 5000009, created_at: '11/20/26 10:28 am EST', draft: true },
      { id: 'abc', created_at: '11/19/26 10:28 am EST' },
      { id: '5000002', created_at: '11/11/26 10:28 am EST' },
    ]));
    expect(r.noteId).toBe('5000002');
  });
  it('an empty feed -> DECISIV_NO_NOTE', () => {
    expect(dr.pickLatestNote(feed([]))).toEqual({ ok: false, code: 'DECISIV_NO_NOTE' });
    expect(dr.pickLatestNote(null)).toEqual({ ok: false, code: 'DECISIV_NO_NOTE' });
  });
});

describe('loadCaseRoster / latestNoteId (mocked transport)', () => {
  it('subcase_dealer case (like the captured Volvo case): the estimate id goes straight to the roster GET, no groups call', async () => {
    const api = rosterApi({ subcase_dealer: [contact(1), contact(2)], dealer: many(3, 10) });
    dr._setDepsForTest({ api });
    const r = await dr.loadCaseRoster({ estimateId: EST, srUrl: SR });
    expect(api.getEstimateContacts).not.toHaveBeenCalled();
    expect(api.apiGetForCase).toHaveBeenCalledTimes(1);
    const [u, p] = api.apiGetForCase.mock.calls[0];
    expect(u).toBe(SR);
    expect(p).toBe('/mobilecomm/api/contacts/estimate_contacts_for_group.json?estimate_id=' + EST + '&group_id=-1&filter=subcase_dealer&mobile=false');
    expect(r).toEqual({ ok: true, caseId: EST, filter: 'subcase_dealer', contacts: dr.normalizeRoster([contact(1), contact(2)]) });
  });
  it('dealer case (like the captured filter=dealer case): subcase_dealer empty -> falls back to filter=dealer', async () => {
    const api = rosterApi({ subcase_dealer: [], dealer: [contact(3), contact(4), contact(5)] });
    dr._setDepsForTest({ api });
    const r = await dr.loadCaseRoster({ estimateId: EST, srUrl: SR });
    expect(api.apiGetForCase.mock.calls.map(filterOf)).toEqual(['subcase_dealer', 'dealer']);
    expect(api.apiGetForCase.mock.calls[1][1]).toBe('/mobilecomm/api/contacts/estimate_contacts_for_group.json?estimate_id=' + EST + '&group_id=-1&filter=dealer&mobile=false');
    expect(r.ok).toBe(true);
    expect(r.caseId).toBe(EST);
    expect(r.filter).toBe('dealer');
    expect(r.contacts.map((c) => c.id)).toEqual([cid(3), cid(4), cid(5)]);
  });
  it('a subcase_dealer transport error falls back to dealer', async () => {
    const api = rosterApi({ subcase_dealer: Object.assign(new Error('x'), { code: 'DECISIV_API_ERROR' }), dealer: [contact(1)] });
    dr._setDepsForTest({ api });
    expect(await dr.loadCaseRoster({ estimateId: EST, srUrl: SR })).toMatchObject({ ok: true, caseId: EST, filter: 'dealer' });
  });
  it('a full-directory-sized list loses to the other filter\'s smaller case roster', async () => {
    const api = rosterApi({ subcase_dealer: many(212), dealer: many(30, 300) });
    dr._setDepsForTest({ api });
    const r = await dr.loadCaseRoster({ estimateId: EST, srUrl: SR });
    expect(r.ok).toBe(true);
    expect(r.filter).toBe('dealer');
    expect(r.contacts).toHaveLength(30);
    expect(r.contacts[0].id).toBe(cid(300));
  });
  it('a list at the threshold is a case roster; one above it is not', async () => {
    dr._setDepsForTest({ api: rosterApi({ subcase_dealer: many(dr.DIRECTORY_SIZE) }) });
    expect(await dr.loadCaseRoster({ estimateId: EST, srUrl: SR })).toMatchObject({ ok: true, filter: 'subcase_dealer' });
    dr._setDepsForTest({ api: rosterApi({ subcase_dealer: many(dr.DIRECTORY_SIZE + 1) }) });
    expect(await dr.loadCaseRoster({ estimateId: EST, srUrl: SR })).toEqual({ ok: false, code: 'DECISIV_ROSTER_TOO_BROAD' });
  });
  it('only directory-sized lists -> DECISIV_ROSTER_TOO_BROAD, never presented as the case roster', async () => {
    dr._setDepsForTest({ api: rosterApi({ subcase_dealer: many(212), dealer: many(212) }) });
    expect(await dr.loadCaseRoster({ estimateId: EST, srUrl: SR })).toEqual({ ok: false, code: 'DECISIV_ROSTER_TOO_BROAD' });
  });
  it('both filters empty -> DECISIV_NO_ROSTER (fails closed)', async () => {
    const api = rosterApi({ subcase_dealer: [], dealer: { contacts: [] } });
    dr._setDepsForTest({ api });
    expect(await dr.loadCaseRoster({ estimateId: EST, srUrl: SR })).toEqual({ ok: false, code: 'DECISIV_NO_ROSTER' });
    expect(api.apiGetForCase).toHaveBeenCalledTimes(2);
  });
  it('a transport error on both filters never throws and returns its code', async () => {
    const e = Object.assign(new Error('x'), { code: 'DECISIV_SESSION_INVALID' });
    dr._setDepsForTest({ api: rosterApi({ subcase_dealer: e, dealer: e }) });
    expect(await dr.loadCaseRoster({ estimateId: EST, srUrl: SR })).toEqual({ ok: false, code: 'DECISIV_SESSION_INVALID' });
  });
  it('the roster id is the id that becomes subject_id in the reply body', async () => {
    dr._setDepsForTest({ api: rosterApi({ dealer: [contact(1)] }) });
    const r = await dr.loadCaseRoster({ estimateId: EST, srUrl: SR });
    const { body } = dr.buildReplyRequest({ caseId: r.caseId, estimateId: EST, text: 'x', recipients: r.contacts }, '5000001');
    expect(body.subject_id).toBe(Number(EST));
  });
  it('latestNoteId reads activity_logs page 1 / 50 and picks the newest', async () => {
    const api = { getActivityLogs: vi.fn(async () => ({ notes: [{ id: 5000001, created_at: '11/10/26 10:28 am EST' }, { id: 5000002, created_at: '11/11/26 10:28 am EST' }] })) };
    dr._setDepsForTest({ api });
    expect(await dr.latestNoteId({ estimateId: EST, srUrl: SR })).toMatchObject({ ok: true, noteId: '5000002' });
    expect(api.getActivityLogs).toHaveBeenCalledWith(EST, { srUrl: SR, page: 1, perPage: 50 });
  });
});

describe('postApproved', () => {
  const P = '/mobilecomm/api/estimates/1000001/notes/5000001/reply.json';
  it('no token or a fake token never calls the POST', async () => {
    const api = { apiPostForCase: vi.fn(async () => ({})) };
    dr._setDepsForTest({ api });
    expect(await dr.postApproved(SR, P, {}, undefined)).toEqual({ ok: false, code: 'DECISIV_NOT_APPROVED' });
    expect(await dr.postApproved(SR, P, {}, {})).toEqual({ ok: false, code: 'DECISIV_NOT_APPROVED' });
    expect(api.apiPostForCase).not.toHaveBeenCalled();
  });
  it('a live token posts once to the reply path', async () => {
    const api = { apiPostForCase: vi.fn(async () => ({ notes: [{ id: 5000099 }] })) };
    dr._setDepsForTest({ api, isApprovalToken: () => true });
    const r = await dr.postApproved(SR, P, { a: 1 }, {});
    expect(r).toEqual({ ok: true, json: { notes: [{ id: 5000099 }] } });
    expect(api.apiPostForCase).toHaveBeenCalledWith(SR, P, { a: 1 });
  });
  it('a non-reply path is refused even with a token', async () => {
    const api = { apiPostForCase: vi.fn() };
    dr._setDepsForTest({ api, isApprovalToken: () => true });
    expect(await dr.postApproved(SR, '/mobilecomm/api/estimates/1/notes.json', {}, {})).toEqual({ ok: false, code: 'DECISIV_BAD_REF' });
    expect(api.apiPostForCase).not.toHaveBeenCalled();
  });
});

describe('static guards', () => {
  const ROOT = path.join(__dirname, '..');
  const SRC = path.join(ROOT, 'src');
  function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(c?js)$/.test(e.name)) out.push(p);
    }
    return out;
  }
  const files = walk(SRC);
  const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

  it('the /reply.json literal appears only in src/writes/decisiv-reply.js', () => {
    const hits = files.filter((f) => fs.readFileSync(f, 'utf8').includes('/reply.json')).map(rel);
    expect(hits).toEqual(['src/writes/decisiv-reply.js']);
  });
  it('apiPostForCase appears only in the transport and src/writes/decisiv-reply.js', () => {
    const hits = files.filter((f) => fs.readFileSync(f, 'utf8').includes('apiPostForCase')).map(rel).sort();
    expect(hits).toEqual(['src/scrapers/decisiv_api.js', 'src/writes/decisiv-reply.js']);
  });
  it('no automated path (autopilot, scheduler, dbr, health, asana, ai) names decisivReply or decisiv-reply', () => {
    const auto = files.filter((f) => /^src\/(autopilot|scheduler|dbr|health|asana|ai)\//.test(rel(f)));
    expect(auto.length).toBeGreaterThan(0);
    const bad = auto.filter((f) => /decisivReply|decisiv-reply/.test(fs.readFileSync(f, 'utf8'))).map(rel);
    expect(bad).toEqual([]);
  });
  it('the transport never requires anything under src/writes/', () => {
    const src = fs.readFileSync(path.join(SRC, 'scrapers', 'decisiv_api.js'), 'utf8');
    expect(src).not.toMatch(/require\(\s*['"][^'"]*writes\//);
  });
});
