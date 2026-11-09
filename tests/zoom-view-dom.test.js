// FEAT-A2 / AC-13 (+ AC-20 shell rows): data-logic render functions and the real Meetings / Recordings
// panels wired through the hub view with a fake DOM: Connect, Join buttons (incl. the passcode label),
// summary sections + [S#] refs + dropped count + coverage, the summarize progress line, CONSENT_REQUIRED ->
// aiConsent -> retry, the link control (ONE object payload), write buttons only with flags.write, escaping.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createExtDom, createBus, ExtElement } from './fixtures/zoom/fake-dom-ext.js';
import { SENTINEL_TOPIC } from './fixtures/zoom/sentinels.js';

if (typeof globalThis.window === 'undefined') globalThis.window = { app: { platform: 'win32' } };
const view = await import('../renderer/src/js/views/zoom-hub.js');
const logic = await import('../renderer/src/js/zoom/data-logic.js');
const meetings = await import('../renderer/src/js/zoom/meetings-panel.js');
const recordings = await import('../renderer/src/js/zoom/recordings-panel.js');

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const FORBIDDEN = ['Go live', 'Send to Zoom', 'Virtual camera: on'];
const EVIL = SENTINEL_TOPIC + ' <script>alert(1)</script>';

const MEETINGS = [
  { key: 'm1', idHash: 'h1', topic: EVIL, startIso: '2026-11-10T15:00:00.000Z', durationMin: 30, hasJoin: true, joinNeedsPasscode: false, kind: 'upcoming' },
  { key: 'm2', idHash: 'h2', topic: 'Weekly', startIso: null, durationMin: null, hasJoin: true, joinNeedsPasscode: true, kind: 'upcoming' },
  { key: 'm3', idHash: 'h3', topic: 'No link', startIso: '2026-11-11T15:00:00.000Z', durationMin: 15, hasJoin: false, joinNeedsPasscode: false, kind: 'upcoming' },
];
const RECORDINGS = [
  { key: 'r1', idHash: 'rh1', topic: 'Rec one', startIso: '2026-11-01T10:00:00.000Z', durationMin: 40, fileCount: 2, hasTranscript: true },
  { key: 'r2', idHash: 'rh2', topic: 'Rec two', startIso: '2026-11-02T10:00:00.000Z', durationMin: 20, fileCount: 1, hasTranscript: false },
  { key: 'r3', idHash: 'rh3', topic: 'Rec three', startIso: '2026-11-03T10:00:00.000Z', durationMin: 10, fileCount: null, hasTranscript: null },
];
const TRANSCRIPT = { segments: [{ i: 1, speaker: 'Alex', text: 'Unit 59083 brakes' }, { i: 2, speaker: null, text: 'Tow <b>Friday</b>' }], source: 'portal', sha256: 'x', truncated: false };
const SUMMARY = {
  ok: true, cached: false, dropped: 2, coverage: { segmentsCovered: 2, segmentsTotal: 5 },
  summary: {
    keyPoints: [{ text: 'Unit 59083 needs brakes', refs: [1] }],
    actionItems: [{ text: 'Tow it', owner: 'Alex', due: 'Friday', refs: [2] }],
    decisions: [],
  },
};

function fakeHub(over = {}) {
  let progressCb = null;
  const h = {
    status: vi.fn(async () => ({ ok: true, signedIn: false, checkedAt: 'x' })),
    connect: vi.fn(async () => ({ ok: true, signedIn: true })),
    onAuthChanged: vi.fn(() => () => {}),
    listMeetings: vi.fn(async () => ({ ok: true, items: MEETINGS, source: 'cache', fetchedAt: 'x' })),
    listRecordings: vi.fn(async () => ({ ok: true, items: RECORDINGS, source: 'cache', fetchedAt: 'x' })),
    links: vi.fn(async () => ({ ok: true, links: { m1: { topic: 'x', startIso: null, kind: 'meeting', targets: [{ kind: 'unit', id: '123456', linkedAt: 'x' }, { kind: 'carrier', id: 'AMZL', linkedAt: 'x' }] } } })),
    join: vi.fn(async () => ({ ok: true })),
    linkTargets: vi.fn(async () => ({ ok: true, items: [{ id: '59083', label: 'Unit 59083' }] })),
    link: vi.fn(async (p) => ({ ok: true, link: { topic: null, startIso: null, kind: 'meeting', targets: [{ kind: p.kind, id: p.id, linkedAt: 'x' }] } })),
    unlink: vi.fn(async () => ({ ok: true, link: null })),
    getSummary: vi.fn(async () => ({ ok: true, summary: null })),
    getTranscript: vi.fn(async () => ({ ok: true, transcript: TRANSCRIPT })),
    importTranscript: vi.fn(async () => ({ ok: false, code: 'CANCELLED' })),
    summarize: vi.fn(async () => SUMMARY),
    aiConsent: vi.fn(async () => ({ ok: true, consentAt: 'x' })),
    onSummaryProgress: vi.fn((cb) => { progressCb = cb; return () => { progressCb = null; }; }),
    writeOpen: vi.fn(async () => ({ ok: true })),
    emitProgress: (p) => { if (progressCb) progressCb(p); },
  };
  return Object.assign(h, over);
}

function mountHub(flags, hub = fakeHub()) {
  view._resetForTests();
  const { document, dom } = createExtDom();
  const bus = createBus();
  const mount = new ExtElement('views-mount', 'div', dom);
  const h = view.init(mount, flags, { bus, addTab: vi.fn(), zoomHub: hub, document });
  return { h, bus, hub, panel: (k) => h.root.querySelector('#zh-panel-' + k) };
}

const click = (el, dataset) => el.dispatch('click', { target: { dataset } });

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); meetings.destroy(); recordings.destroy(); });

describe('data-logic render functions (pure)', () => {
  it('renderMeetingRows: one Join per hasJoin item, passcode label, Linked chip, escaping, empty state', () => {
    const html = logic.renderMeetingRows(MEETINGS, { links: { m1: { targets: [{ kind: 'unit', id: '123456' }, { kind: 'carrier', id: 'AMZL' }] } } });
    expect(html.match(/data-action="join"/g).length).toBe(2);
    expect(html).toContain('>Join (may ask for passcode)</button>');
    expect(html).toContain('>Join</button>');
    expect(html).toContain('Linked: unit 123456, AMZL');
    expect(html).toContain('Recurring — no fixed time');
    expect(html).toContain('30 min');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toMatch(/<button type="button"[^>]*aria-label=/);
    expect(logic.renderMeetingRows([])).toContain('No meetings found');
  });

  it('renderRecordingRows: transcript badge Available / None / Unknown', () => {
    const html = logic.renderRecordingRows(RECORDINGS);
    expect(html).toContain('Transcript: Available');
    expect(html).toContain('Transcript: None');
    expect(html).toContain('Transcript: Unknown');
    expect(logic.renderRecordingRows([])).toContain('No recordings found');
  });

  it('renderSummary: three sections, clickable [S#] chips, dropped footer, coverage note', () => {
    const html = logic.renderSummary(SUMMARY);
    for (const t of ['Key points', 'Action items', 'Decisions']) expect(html).toContain('<h4>' + t + '</h4>');
    expect(html).toContain('data-action="ref" data-seg="1"');
    expect(html).toContain('[S2]');
    expect(html).toContain('Owner: Alex');
    expect(html).toContain('Due: Friday');
    expect(html).toContain('2 unsupported items removed');
    expect(html).toContain('Summary covers the first 2 of 5 segments');
    expect(logic.renderSummary({ summary: { keyPoints: [], actionItems: [], decisions: [] }, dropped: 0, coverage: { segmentsCovered: 3, segmentsTotal: 3 } })).not.toContain('removed');
    expect(logic.renderSummary({ summary: { keyPoints: [{ text: '<img onerror=x>', refs: [1] }] } })).not.toContain('<img');
  });

  it('renderTranscript: "[S#] speaker: text", escaped, virtualized to at most 500 rows around the focus', () => {
    const html = logic.renderTranscript(TRANSCRIPT);
    expect(html).toContain('[S1] <span class="zh-speaker">Alex</span>: Unit 59083 brakes');
    expect(html).toContain('[S2] Tow &lt;b&gt;Friday&lt;/b&gt;');
    const big = { segments: Array.from({ length: 1200 }, (_v, n) => ({ i: n + 1, speaker: null, text: 't' + (n + 1) })), source: 'import' };
    const w = logic.renderTranscript(big, { focus: 900 });
    expect(w.match(/class="zh-seg[ "]/g).length).toBe(500);
    expect(w).toContain('id="zh-seg-900"');
    expect(w).toContain('zh-seg zh-seg-focus');
    expect(w).toContain('Imported file');
    expect(w).toContain('data-action="seg-page"');
  });

  it('codeMessage reason entries (review F-3, F-4) and renderLinkChips', () => {
    expect(logic.codeMessage('TRANSCRIPT_UNAVAILABLE', 'not-loaded')).toBe('Load or import the transcript first');
    expect(logic.codeMessage('AI_UNAVAILABLE', 'no-isolated-lane')).toBe("Fleet's private AI lane isn't available on this PC.");
    expect(logic.resultMessage({ ok: false, code: 'AI_UNAVAILABLE', reason: 'budget' })).toBe(logic.codeMessage('AI_UNAVAILABLE'));
    const chips = logic.renderLinkChips({ targets: [{ kind: 'unit', id: '59083' }, { kind: 'carrier', id: 'AGNLI' }] }, { removable: true });
    expect(chips).toContain('Unit 59083');
    expect(chips).toContain('Carrier AGNLI');
    expect(chips.match(/data-action="unlink"/g).length).toBe(2);
    expect(logic.renderLinkChips(null)).toContain('Not linked');
  });

  it('renderRecordingActions: Get transcript only when hasTranscript !== false; Delete only with write; busy disables', () => {
    expect(logic.renderRecordingActions(RECORDINGS[0])).toContain('Get transcript');
    expect(logic.renderRecordingActions(RECORDINGS[1])).not.toContain('Get transcript');
    expect(logic.renderRecordingActions(RECORDINGS[2])).toContain('Get transcript');
    expect(logic.renderRecordingActions(RECORDINGS[0])).not.toContain('Delete in Zoom portal');
    expect(logic.renderRecordingActions(RECORDINGS[0], { write: true })).toContain('Delete in Zoom portal…');
    expect(logic.renderRecordingActions(RECORDINGS[0], { busy: true })).toMatch(/data-action="summarize"[^>]*disabled/);
  });
});

describe('hub view with the real panels', () => {
  it('signed-out: the connection card shows Connect', async () => {
    const { h, bus } = mountHub({ enabled: true, data: true });
    bus.emit('ui:view-change', { to: 'zoom' });
    await tick();
    expect(h.root.querySelector('.zh-conn').innerHTML).toContain('data-action="connect"');
  });

  it('Meetings: rows render on show, one Join button per hasJoin item, Join calls zoomHub.join({key})', async () => {
    const { bus, hub, panel } = mountHub({ enabled: true, data: true });
    bus.emit('ui:view-change', { to: 'zoom' });
    await tick();
    expect(hub.listMeetings).toHaveBeenCalledWith({ kind: 'upcoming' });
    const list = panel('meetings').querySelector('.zh-list');
    expect(list.innerHTML.match(/data-action="join"/g).length).toBe(2);
    expect(list.innerHTML).toContain('Join (may ask for passcode)');
    expect(list.innerHTML).toContain('Linked: unit 123456, AMZL');
    expect(list.innerHTML).not.toContain('<script>');
    click(list, { action: 'join', key: 'm2' });
    await tick();
    expect(hub.join).toHaveBeenCalledTimes(1);
    expect(hub.join.mock.calls[0]).toEqual([{ key: 'm2' }]);
    for (const bad of FORBIDDEN) expect(list.innerHTML).not.toContain(bad);
  });

  it('Meetings: Previous toggle + Refresh; SHAPE_UNRECOGNIZED state; Schedule only with flags.write', async () => {
    const hub = fakeHub();
    const { bus, panel } = mountHub({ enabled: true, data: true }, hub);
    bus.emit('ui:view-change', { to: 'zoom' });
    await tick();
    const head = panel('meetings').querySelector('.zh-panel-head');
    expect(head.innerHTML).not.toContain('Schedule in Zoom portal');
    hub.listMeetings.mockResolvedValueOnce({ ok: false, code: 'SHAPE_UNRECOGNIZED' });
    click(head, { action: 'kind', kind: 'previous' });
    await tick();
    expect(hub.listMeetings).toHaveBeenLastCalledWith({ kind: 'previous' });
    expect(panel('meetings').querySelector('.zh-status').textContent).toBe("Zoom changed its page format; Fleet couldn't read meetings safely.");
    hub.listMeetings.mockResolvedValueOnce({ ok: true, items: [], source: 'replay', fetchedAt: 'x' });
    click(head, { action: 'refresh' });
    await tick();
    expect(hub.listMeetings).toHaveBeenLastCalledWith({ kind: 'previous', refresh: true });
    expect(panel('meetings').querySelector('.zh-list').innerHTML).toContain('No meetings found');

    const w = mountHub({ enabled: true, data: true, write: true });
    const whead = w.panel('meetings').querySelector('.zh-panel-head');
    expect(whead.innerHTML).toContain('Schedule in Zoom portal…');
    click(whead, { action: 'schedule' });
    await tick();
    expect(w.hub.writeOpen.mock.calls[0]).toEqual([{ action: 'schedule' }]);
  });

  it('link control: lists targets, Add calls zoomHub.link with ONE object payload, debounced search, unlink', async () => {
    vi.useFakeTimers();
    const { bus, hub, panel } = mountHub({ enabled: true, data: true });
    bus.emit('ui:view-change', { to: 'zoom' });
    await tick();
    const p = panel('meetings');
    click(p.querySelector('.zh-list'), { action: 'select', key: 'm3' });
    await tick();
    expect(p.querySelector('.zh-detail').style.display).toBe('');
    expect(hub.linkTargets).toHaveBeenLastCalledWith({ kind: 'unit', q: '' });
    const results = p.querySelector('.zh-link-results');
    expect(results.innerHTML).toContain('Add link Unit 59083');
    click(results, { action: 'add', id: '59083' });
    await tick();
    expect(hub.link).toHaveBeenCalledTimes(1);
    expect(hub.link.mock.calls[0]).toEqual([{ key: 'm3', kind: 'unit', id: '59083' }]);
    expect(p.querySelector('.zh-link-chips').innerHTML).toContain('Unit 59083');
    expect(p.querySelector('.zh-list').innerHTML).toContain('Linked: unit 59083');
    // debounced search (200 ms), kind switch
    const input = p.querySelector('.zh-link-q');
    const select = p.querySelector('.zh-link-kind');
    hub.linkTargets.mockClear();
    input.value = '59';
    input.dispatch('input');
    input.dispatch('input');
    await vi.advanceTimersByTimeAsync(150);
    expect(hub.linkTargets).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(hub.linkTargets).toHaveBeenCalledTimes(1);
    expect(hub.linkTargets).toHaveBeenLastCalledWith({ kind: 'unit', q: '59' });
    select.value = 'carrier';
    select.dispatch('change');
    await tick();
    expect(hub.linkTargets).toHaveBeenLastCalledWith({ kind: 'carrier', q: '59' });
    click(p.querySelector('.zh-link-chips'), { action: 'unlink', kind: 'unit', id: '59083' });
    await tick();
    expect(hub.unlink.mock.calls[0]).toEqual([{ key: 'm3', kind: 'unit', id: '59083' }]);
  });

  it('Recordings: badge, Get transcript -> viewer, Summarize progress line + disabled button, summary sections', async () => {
    let release;
    const hub = fakeHub({ summarize: vi.fn(() => new Promise((res) => { release = () => res(SUMMARY); })) });
    const { h, bus, panel } = mountHub({ enabled: true, data: true }, hub);
    h.selectTab('recordings');
    bus.emit('ui:view-change', { to: 'zoom' });
    await tick();
    const p = panel('recordings');
    expect(p.querySelector('.zh-list').innerHTML).toContain('Transcript: Available');
    click(p.querySelector('.zh-list'), { action: 'select', key: 'r1' });
    await tick();
    expect(hub.getSummary).toHaveBeenCalledWith({ key: 'r1' });
    const actions = p.querySelector('.zh-actions');
    expect(actions.innerHTML).toContain('Get transcript');
    expect(actions.innerHTML).toContain('Import transcript file…');
    expect(actions.innerHTML).not.toContain('Delete in Zoom portal');
    click(actions, { action: 'get-transcript' });
    await tick();
    expect(hub.getTranscript.mock.calls[0]).toEqual([{ key: 'r1' }]);
    expect(p.querySelector('.zh-viewer').innerHTML).toContain('[S1] <span class="zh-speaker">Alex</span>');
    click(actions, { action: 'summarize' });
    await tick();
    expect(hub.summarize.mock.calls[0]).toEqual([{ key: 'r1' }]);
    expect(actions.innerHTML).toMatch(/data-action="summarize"[^>]*disabled/);
    const progress = p.querySelector('.zh-progress');
    expect(progress.getAttribute('role')).toBe('status');
    expect(progress.getAttribute('aria-live')).toBe('polite');
    hub.emitProgress({ idHash: 'other', chunk: 1, of: 2 });
    expect(progress.textContent).toBe('Summarizing…');
    hub.emitProgress({ idHash: 'rh1', chunk: 1, of: 2 });
    expect(progress.textContent).toBe('Summarizing… (chunk 1 of 2)');
    click(actions, { action: 'summarize' });          // ignored while busy
    expect(hub.summarize).toHaveBeenCalledTimes(1);
    release();
    await tick();
    expect(progress.textContent).toBe('');
    const sum = p.querySelector('.zh-summary-host').innerHTML;
    expect(sum).toContain('Key points');
    expect(sum).toContain('2 unsupported items removed');
    expect(sum).toContain('Summary covers the first 2 of 5 segments');
    expect(actions.innerHTML).toContain('Regenerate');
    // [S#] chip scrolls the viewer to that segment
    click(p.querySelector('.zh-summary-host'), { action: 'ref', seg: '2' });
    expect(p.querySelector('.zh-viewer').innerHTML).toContain('zh-seg zh-seg-focus" id="zh-seg-2"');
    // Regenerate = summarize({key, force:true})
    hub.summarize = vi.fn(async () => SUMMARY);
    click(actions, { action: 'regenerate' });
    await tick();
    expect(hub.summarize.mock.calls[0]).toEqual([{ key: 'r1', force: true }]);
    for (const bad of FORBIDDEN) expect(p.querySelector('.zh-summary-host').innerHTML + actions.innerHTML).not.toContain(bad);
  });

  it('Recordings: CONSENT_REQUIRED -> aiConsent() -> retry; not-loaded and no-lane messages', async () => {
    const hub = fakeHub();
    hub.summarize = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'CONSENT_REQUIRED' })
      .mockResolvedValueOnce(SUMMARY)
      .mockResolvedValueOnce({ ok: false, code: 'TRANSCRIPT_UNAVAILABLE', reason: 'not-loaded' })
      .mockResolvedValueOnce({ ok: false, code: 'AI_UNAVAILABLE', reason: 'no-isolated-lane' });
    const { h, bus, panel } = mountHub({ enabled: true, data: true, write: true }, hub);
    h.selectTab('recordings');
    bus.emit('ui:view-change', { to: 'zoom' });
    await tick();
    const p = panel('recordings');
    click(p.querySelector('.zh-list'), { action: 'select', key: 'r2' });
    await tick();
    const actions = p.querySelector('.zh-actions');
    expect(actions.innerHTML).not.toContain('Get transcript');           // hasTranscript false
    expect(actions.innerHTML).toContain('Delete in Zoom portal…');       // flags.write
    click(actions, { action: 'summarize' });
    await tick();
    expect(hub.aiConsent).toHaveBeenCalledTimes(1);
    expect(hub.summarize).toHaveBeenCalledTimes(2);
    expect(p.querySelector('.zh-summary-host').innerHTML).toContain('Key points');
    click(actions, { action: 'regenerate' });
    await tick();
    expect(p.querySelector('.zh-message').textContent).toBe('Load or import the transcript first');
    click(actions, { action: 'regenerate' });
    await tick();
    expect(p.querySelector('.zh-message').textContent).toBe("Fleet's private AI lane isn't available on this PC.");
    click(actions, { action: 'delete-portal' });
    await tick();
    expect(hub.writeOpen.mock.calls[0]).toEqual([{ action: 'delete-recording', key: 'r2' }]);
    click(actions, { action: 'import-transcript' });
    await tick();
    expect(hub.importTranscript.mock.calls[0]).toEqual([{ key: 'r2' }]);
    expect(p.querySelector('.zh-message').textContent).toBe('');           // CANCELLED is quiet
  });

  it("to:'settings' leaves the view visible; to:'fleet' hides and unsubscribes summary progress", async () => {
    const hub = fakeHub();
    const { h, bus } = mountHub({ enabled: true, data: true }, hub);
    h.selectTab('recordings');
    bus.emit('ui:view-change', { to: 'zoom' });
    await tick();
    expect(hub.onSummaryProgress).toHaveBeenCalledTimes(1);
    bus.emit('ui:view-change', { to: 'settings' });
    expect(h.root.style.display).toBe('flex');
    bus.emit('ui:view-change', { to: 'fleet' });
    expect(h.root.style.display).toBe('none');
    expect(recordings._state().unsubProgress).toBe(null);
  });
});
