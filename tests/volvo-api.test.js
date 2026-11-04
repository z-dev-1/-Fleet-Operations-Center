// tests/volvo-api.test.js
//
// Volvo ASIST service request via API (src/vendors/volvo/api.js).
// Fixtures mirror what ASIST actually returned in the 2026-10-28 read-only
// browser probes (search.json shape, open_cases fragment, live form entries).
// No real ASIST call is made: the Decisiv window, AI and cache are injected.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const api = require('../src/vendors/volvo/api');

// Live form entries as dumped from the real Request Service page (VASCC1).
const LIVE = [
  ['authenticity_token', 'TOKEN'],
  ['service_request[to_dealer_id]', 'VASCC1'],
  ['service_request[vehicle_id]', '4961577'],
  ['service_request[to_user_id]', '35970'],
  ['service_request[customer_requested_appointment_time]', ''],
  ['service_request[customer_requested_time]', ''],
  ['service_request[complaint]', ''],
  ['saved_responses[note]', ''],
  ['service_request[initial_note]', ''],
  ['saved_responses[note]', ''],
  ['primaryContact', '1'],
  ['estimate[new_case][main_contact_id]', ''],
  ['new_case_main_user_id', '1463094'],
  ['driverContact', '1'],
  ['service_request[breakdown_city]', ''],
  ['service_request[breakdown_state]', ''],
  ['service_request[vmrs_ck16_code]', '5'],
  ['service_request[vmrs_ck17_code]', ''],
  ['service_request[vmrs_ck14_code]', ''],
  ['service_request[vmrs_ck82_codes][]', '002'],
  ['service_request[complaint_vmrs_ck33_code]', '000-000-000'],
  ['service_request[vehicle_mileage_type]', 'miles'],
  ['service_request[vehicle_mileage]', '316969'],
  ['service_request[trailer_loaded]', 'false'],
  ['service_request[trailer_load]', 'Unknown'],
];
const CK82 = [['002', '002 - Air Conditioner Blows Warm Air'], ['021', '021 - Coolant Low'], ['035', '035 - Engine Overheats'], ['039', "039 - Cranks, Won't Start"]];
const SEARCH_JSON = { 'Fleet Vehicles': { total_entries: 1, results: [{ id: 4961577, unit_number: '39110', display_vehicle: '2021 Volvo VNL ISXG12L', customer: { id: 37703724, name: 'Amazon Middle Mile Cng' } }] } };
const get = (e, k) => e.filter(([n]) => n === k).map(([, v]) => v);

describe('vehicle lookup', () => {
  it('builds the search.json path with the unit number', () => {
    expect(api.searchPath('39110')).toContain('/fleet/search.json?');
    expect(api.searchPath('39110')).toContain('search_query%5Bquery%5D=39110');
  });
  it('takes the exact unit match, or a single result', () => {
    expect(api.pickVehicle(SEARCH_JSON, '39110')).toEqual({ vehicleId: '4961577', display: '2021 Volvo VNL ISXG12L' });
    const noUnitField = { 'Fleet Vehicles': { results: [{ id: 7 }] } };
    expect(api.pickVehicle(noUnitField, 'X1').vehicleId).toBe('7');
  });
  it('refuses to guess among several non-matching vehicles, and reports not-found', () => {
    const many = { 'Fleet Vehicles': { results: [{ id: 1, unit_number: 'A' }, { id: 2, unit_number: 'B' }] } };
    expect(() => api.pickVehicle(many, 'C')).toThrow(/not guessing/);
    expect(() => api.pickVehicle({ 'Fleet Vehicles': { results: [] } }, 'C')).toThrow(/not found/);
  });
  it('form path always targets dealer VASCC1', () => {
    expect(api.formPath('4961577')).toBe('/fleet/vehicles/4961577/request_service/VASCC1');
  });
});

describe('parsers', () => {
  it('reads the open-case count from the ASIST fragment', () => {
    expect(api.parseOpenCases('<div class="pages_stats">Displaying <b>all 9</b> open cases</div>')).toBe(9);
    expect(api.parseOpenCases('<p>No open cases</p>')).toBe(0);
  });
  it('splits City, ST', () => {
    expect(api.parseCityState('Fontana, CA')).toEqual({ city: 'Fontana', state: 'CA' });
    expect(api.parseCityState('Bloomsbury, nj')).toEqual({ city: 'Bloomsbury', state: 'NJ' });
    expect(api.parseCityState('Somewhere')).toEqual({ city: 'Somewhere', state: '' });
    expect(api.parseCityState('')).toEqual({ city: '', state: '' });
  });
  it('accepts only AI codes that exist in the ASIST list (max 3, no dupes)', () => {
    expect(api.parseCk82Reply('{"codes":["021"]}', CK82)).toEqual(['021']);
    expect(api.parseCk82Reply('sure! {"codes":["035","021","035","999","039","002"]}', CK82)).toEqual(['035', '021', '039']);
    expect(api.parseCk82Reply('{"codes":["021 - Coolant Low"]}', CK82)).toEqual(['021']);
    expect(api.parseCk82Reply('no json here', CK82)).toEqual([]);
  });
});

describe('buildPayload', () => {
  const p = api.buildPayload(LIVE, {
    vehicleId: '4961577', complaint: 'Coolant leak, temp gauge high', city: 'Fontana', state: 'CA',
    ck82: ['021', '035'], note: 'Relay Ref: AMZ-1',
  });
  it('applies the operator-chosen values', () => {
    expect(get(p, 'service_request[to_dealer_id]')).toEqual(['VASCC1']);
    expect(get(p, 'service_request[to_user_id]')).toEqual(['35970']);
    expect(get(p, 'service_request[vmrs_ck16_code]')).toEqual(['1']);   // Scheduled
    expect(get(p, 'service_request[vmrs_ck14_code]')).toEqual(['01']);  // Breakdown
    expect(get(p, 'service_request[vmrs_ck17_code]')).toEqual(['']);    // blank
    expect(get(p, 'service_request[vmrs_ck82_codes][]')).toEqual(['021', '035']);
    expect(get(p, 'service_request[complaint]')).toEqual(['Coolant leak, temp gauge high']);
    expect(get(p, 'service_request[breakdown_city]')).toEqual(['Fontana']);
    expect(get(p, 'service_request[breakdown_state]')).toEqual(['CA']);
    expect(get(p, 'service_request[initial_note]')).toEqual(['Relay Ref: AMZ-1']);
  });
  it("keeps ASIST's own prefilled values (token, primary contact, mileage, hidden fields)", () => {
    expect(get(p, 'authenticity_token')).toEqual(['TOKEN']);
    expect(get(p, 'new_case_main_user_id')).toEqual(['1463094']);
    expect(get(p, 'service_request[vehicle_mileage]')).toEqual(['316969']);
    expect(get(p, 'service_request[complaint_vmrs_ck33_code]')).toEqual(['000-000-000']);
    expect(get(p, 'saved_responses[note]').length).toBe(2); // untouched duplicates stay as ASIST sends them
  });
  it('keeps the ASIST default complaint code when the AI picked nothing', () => {
    const q = api.buildPayload(LIVE, { vehicleId: '4961577', complaint: 'x', ck82: [] });
    expect(get(q, 'service_request[vmrs_ck82_codes][]')).toEqual(['002']);
    expect(get(q, 'service_request[breakdown_city]')).toEqual(['']);
  });
  it('preview shows exactly what will be sent', () => {
    const lines = api.buildPreview(p, { display: '2021 Volvo VNL', ck82Options: CK82, ck82Source: 'ai' }).join('\n');
    expect(lines).toContain('Dealer: VASCC1');
    expect(lines).toContain('Priority: 1 - Scheduled');
    expect(lines).toContain('Reason: 01 - Breakdown');
    expect(lines).toContain('021 - Coolant Low; 035 - Engine Overheats');
    expect(lines).toContain('Breakdown: Fontana, CA');
    expect(lines).toContain('ASIST id 4961577');
  });
});

describe('parseSubmitResult', () => {
  it('created: redirect to the new SR / estimate', () => {
    expect(api.parseSubmitResult({ status: 200, redirected: true, url: 'https://volvopg.asist.decisiv.net/fleet/service_requests/21500001' }))
      .toMatchObject({ outcome: 'created', srNumber: '21500001' });
    expect(api.parseSubmitResult({ status: 200, redirected: true, url: 'https://volvopg.asist.decisiv.net/fleet/estimates/21332788' }))
      .toMatchObject({ outcome: 'created', srNumber: '21332788' });
  });
  it('rejected: form shown again or 4xx (nothing created)', () => {
    expect(api.parseSubmitResult({ status: 200, redirected: true, url: 'https://x/fleet/vehicles/1/request_service/VASCC1' }).outcome).toBe('rejected');
    expect(api.parseSubmitResult({ status: 422, url: 'https://x/fleet/service_requests' }).outcome).toBe('rejected');
    expect(api.parseSubmitResult({ status: 200, redirected: false, url: 'https://x/fleet/service_requests', flash: "Complaint can't be blank" }).outcome).toBe('rejected');
  });
  it('unconfirmed: never guesses "created" (5xx, no redirect, no number)', () => {
    expect(api.parseSubmitResult({ status: 500, url: 'https://x/fleet/service_requests' }).outcome).toBe('unconfirmed');
    expect(api.parseSubmitResult({ status: 0, error: 'Failed to fetch' }).outcome).toBe('unconfirmed');
    expect(api.parseSubmitResult({ status: 200, redirected: false, url: 'https://x/fleet/service_requests', snippet: 'Case # 12345678' }).outcome).toBe('unconfirmed');
    expect(api.parseSubmitResult({ status: 200, redirected: true, url: 'https://x/fleet' }).outcome).toBe('unconfirmed');
  });
});

// ── runApi end-to-end with fakes ─────────────────────────────────────────────
function makeFakes({ postReply, cache = {}, searchCalls = { n: 0 }, posts = [] } = {}) {
  const sent = [];
  const merged = [];
  const listeners = {};
  const win = {
    loadURL: () => setTimeout(() => (listeners['did-finish-load'] || []).forEach(f => f()), 0),
    webContents: {
      on: (ev, f) => { (listeners[ev] = listeners[ev] || []).push(f); },
      removeListener: (ev, f) => { listeners[ev] = (listeners[ev] || []).filter(x => x !== f); },
      loadURL: (u) => win.loadURL(u),
      executeJavaScript: async (script) => {
        if (script.includes('open_cases')) return { status: 200, html: 'Displaying <b>all 2</b> open cases' };
        if (script.includes("method: 'POST'")) { posts.push(script); return postReply; }
        if (script.includes('new FormData(form)')) return { ok: true, url: 'https://volvopg.asist.decisiv.net/fleet/vehicles/4961577/request_service/VASCC1', entries: LIVE, ck82: CK82, commit: ['commit', 'Submit'], token: 'TOKEN', mainUser: '1463094',
          apptInfo: { tag: 'input', type: 'text', placeholder: '', data: {} }, timeInfo: { tag: 'input', type: 'text', placeholder: '', data: {} },
          fileInfo: { name: 'service_request[download][attachment]', multiple: false } };
        throw new Error('unexpected script');
      },
    },
  };
  win.webContents.loadURL = win.loadURL;
  // _loadUrl calls win.loadURL (BrowserWindow API)
  const decisiv = {
    apiGet: async () => { searchCalls.n++; return SEARCH_JSON; },
    withWindow: async (_v, fn) => fn(win, { token: 'TOKEN' }),
    dispose: () => {},
  };
  const deps = {
    decisiv, settleMs: 0,
    sendToAll: (ch, p) => sent.push([ch, p]),
    askAi: async () => '{"codes":["021"]}',
    now: () => new Date(2026, 9, 28, 14, 5),
    mergeToPdf: async (imgs) => { merged.push(imgs.map(i => i.name)); return { name: 'attachments.pdf', mime: 'application/pdf', b64: 'JVBERi0=' }; },
    cache: { get: (u) => cache[u] || null, set: (u, r) => { if (r) cache[u] = r; else delete cache[u]; } },
  };
  const relayNotes = [];
  const workflow = { progress: () => {}, _writeToRelay: async (...a) => { relayNotes.push(a); } };
  return { deps, sent, workflow, relayNotes, searchCalls, posts, cache, merged };
}

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPG = 'data:image/jpeg;base64,/9j/4AAQ';
const PDF = 'data:application/pdf;base64,JVBERi0xLjQ=';

describe('appointment time + attachments helpers', () => {
  const t = new Date(2026, 9, 28, 14, 5); // Oct 28 2026 2:05 PM local
  it('formats the WO-creation time for the live ASIST input', () => {
    expect(api.formatTime(t, { type: 'text' })).toBe('10/28/2026 02:05 PM');
    expect(api.formatTime(t, { type: 'datetime-local' })).toBe('2026-10-28T14:05');
    expect(api.formatTime(t, { type: 'date' })).toBe('2026-10-28');
    expect(api.formatTime(t, { type: 'time' })).toBe('14:05');
    expect(api.formatTime(t, { type: 'text', placeholder: 'YYYY-MM-DD HH:mm' })).toBe('2026-10-28 14:05');
    expect(api.formatTime(t, null)).toBe('10/28/2026 02:05 PM');
  });
  it('one file goes as-is; several images become one PDF; extras are listed', () => {
    const one = api.planAttachments([{ name: 'a.png', dataUrl: PNG }], { multiple: false });
    expect(one.send.map(f => f.name)).toEqual(['a.png']);
    const imgs = api.planAttachments([{ name: 'a.png', dataUrl: PNG }, { name: 'b.jpg', dataUrl: JPG }, { name: 'c.pdf', dataUrl: PDF }], { multiple: false });
    expect(imgs.mergeImages.map(f => f.name)).toEqual(['a.png', 'b.jpg']);
    expect(imgs.dropped.join(' ')).toContain('c.pdf');
    const multi = api.planAttachments([{ name: 'a.png', dataUrl: PNG }, { name: 'c.pdf', dataUrl: PDF }], { multiple: true });
    expect(multi.send.length).toBe(2);
    expect(api.planAttachments([], { multiple: false }).send).toEqual([]);
  });
  it('payload carries location, auth number, appointment time and the file description', () => {
    const p = api.buildPayload(LIVE, { vehicleId: '1', complaint: 'BLOCK', note: 'BLOCK', location: '123 Main St, Allentown PA 18101',
      authNumber: 'AMZ-555', apptTime: '10/28/2026 02:05 PM', hasFile: true });
    expect(get(p, 'service_request[breakdown_location]')).toEqual(['123 Main St, Allentown PA 18101']);
    expect(get(p, 'service_request[auth_number]')).toEqual(['AMZ-555']);
    expect(get(p, 'service_request[customer_requested_appointment_time]')).toEqual(['10/28/2026 02:05 PM']);
    expect(get(p, 'service_request[initial_note]')).toEqual(['BLOCK']);
    expect(get(p, 'service_request[download][description]')).toEqual(['BLOCK']);
  });
});

describe('runApi: all fields filled', () => {
  it('Complaint = Notes = Description, location/auth/time set, images combined into one PDF', async () => {
    const f = makeFakes({ postReply: { status: 200, redirected: true, url: 'https://x/fleet/estimates/21500009' } });
    const issue = 'FAS HAS CONFIRMED WITH POC THAT UNIT IS READY FOR PICK UP\nCompliant: Transmission codes\nPlease assign unit to BERGEY\'S TRUCK CENTER Souderton 462 Harleysville Pike, Souderton PA 18964 for service';
    await api.runApi(f.workflow, { id: '320160' }, 'AMZ-777', {
      workflowId: 'w5', approveSignal: Promise.resolve({ approved: true }),
      formData: { cityState: 'Allentown, PA', breakdownLocation: '123 Main St, Allentown PA 18101', issue,
        attachments: [{ name: 'uptake1.png', dataUrl: PNG }, { name: 'photo.jpg', dataUrl: JPG }] },
    }, f.deps);
    expect(f.merged).toEqual([['uptake1.png', 'photo.jpg']]);
    const post = f.posts[0];
    const E = JSON.parse(post.match(/var E = (\[.*?\]);\n/s)[1]);
    expect(get(E, 'service_request[complaint]')).toEqual([issue]);
    expect(get(E, 'service_request[initial_note]')).toEqual([issue]);
    expect(get(E, 'service_request[download][description]')).toEqual([issue]);
    expect(get(E, 'service_request[breakdown_location]')).toEqual(['123 Main St, Allentown PA 18101']);
    expect(get(E, 'service_request[auth_number]')).toEqual(['AMZ-777']);
    expect(get(E, 'service_request[customer_requested_appointment_time]')).toEqual(['10/28/2026 02:05 PM']);
    expect(post).toContain('attachments.pdf');
    expect(post).toContain('service_request[download][attachment]');
    const review = f.sent.find(([c]) => c === 'vendor:review-ready')[1].previewLines.join('\n');
    expect(review).toContain('Auth Number: AMZ-777');
    expect(review).toContain('attachments.pdf (uptake1.png, photo.jpg)');
  });
  it('Auth Number follows the AMZ number corrected on the review screen', async () => {
    const f = makeFakes({ postReply: { status: 200, redirected: true, url: 'https://x/fleet/estimates/21500010' } });
    await api.runApi(f.workflow, { id: '320160' }, 'AMZ-1', {
      workflowId: 'w6', approveSignal: Promise.resolve({ approved: true, altId: 'AMZ-2' }), formData: { issue: 'x' } }, f.deps);
    const E = JSON.parse(f.posts[0].match(/var E = (\[.*?\]);\n/s)[1]);
    expect(get(E, 'service_request[auth_number]')).toEqual(['AMZ-2']);
  });
});

describe('runApi', () => {
  it('nothing is sent on Cancel', async () => {
    const f = makeFakes({ postReply: { status: 200 } });
    await expect(api.runApi(f.workflow, { id: '39110', issueDetails: 'Coolant low' }, 'AMZ-1',
      { workflowId: 'w1', approveSignal: Promise.reject(new Error('cancelled')), formData: { cityState: 'Fontana, CA', issue: 'Coolant low light on' } }, f.deps))
      .rejects.toThrow(/cancelled/);
    expect(f.posts.length).toBe(0);
    const review = f.sent.find(([c]) => c === 'vendor:review-ready')[1];
    expect(review.previewLines.join('\n')).toContain('021 - Coolant Low');
    expect(review.isDuplicate).toBe(true); // 2 open cases -> warning
  });

  it('Approve posts once, caches the vehicle id, writes the relay note, emits complete', async () => {
    const f = makeFakes({ postReply: { status: 200, redirected: true, url: 'https://volvopg.asist.decisiv.net/fleet/estimates/21500001', title: 'Case' } });
    const res = await api.runApi(f.workflow, { id: '39110' }, 'AMZ-1',
      { workflowId: 'w2', approveSignal: Promise.resolve({ approved: true }), formData: { cityState: 'Fontana, CA', issue: 'Coolant low' } }, f.deps);
    expect(res.srNumber).toBe('21500001');
    expect(f.posts.length).toBe(1);
    expect(f.posts[0]).toContain('VASCC1');
    expect(f.cache['39110'].vehicleId).toBe('4961577');
    expect(f.relayNotes.length).toBe(1);
    expect(f.sent.some(([c, p]) => c === 'vendor:complete' && p.caseNumber === '21500001')).toBe(true);
  });

  it('uses the cached vehicle id (no search) on the next request', async () => {
    const f = makeFakes({ postReply: { status: 200, redirected: true, url: 'https://x/fleet/estimates/21500002' }, cache: { '39110': { vehicleId: '4961577', display: 'VNL' } } });
    await api.runApi(f.workflow, { id: '39110' }, '', { workflowId: 'w3', approveSignal: Promise.resolve({ approved: true }), formData: { issue: 'x' } }, f.deps);
    expect(f.searchCalls.n).toBe(0);
  });

  it('an unconfirmed submit is reported as an error and is NOT retried', async () => {
    const f = makeFakes({ postReply: { status: 500, url: 'https://x/fleet/service_requests' } });
    await expect(api.runApi(f.workflow, { id: '39110' }, '', { workflowId: 'w4', approveSignal: Promise.resolve({ approved: true }), formData: { issue: 'x' } }, f.deps))
      .rejects.toThrow(/BEFORE trying again/);
    expect(f.posts.length).toBe(1);
    expect(f.sent.some(([c]) => c === 'vendor:complete')).toBe(false);
  });
});
