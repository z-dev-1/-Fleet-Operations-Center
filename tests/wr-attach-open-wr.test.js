// tests/wr-attach-open-wr.test.js
// "Attach to open WR" (unit detail → Actions): main-process validation/upload
// (src/scrapers/wr_attach.js) and the renderer's open-WR picker (openWrChoices,
// imported from the real unit-detail.js with its deps mocked).
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { validateAttachRequest, attachToOpenWr } = require('../src/scrapers/wr_attach');

vi.mock('../renderer/src/js/bridge.js', () => ({ notes: {}, ai: {}, aap: {}, relay: {}, vendor: {}, files: {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() {}, emit() {}, off() {} } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { get() {}, set() {}, on() {} } }));
vi.mock('../renderer/src/js/components/toast.js', () => ({ default: { show() {} } }));
vi.mock('../renderer/src/js/views/vendor-review-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/dealer-wo-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/wr-modal.js', () => ({ open() {}, readFileAsAttachment: async () => null }));

const WR = '0a1b2c3d-1111-2222-3333-444455556666';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const PDF = 'data:application/pdf;base64,JVBERi0xLjQ=';

describe('validateAttachRequest', () => {
  it('accepts a UUID or a /v2/service/<uuid> URL', () => {
    expect(validateAttachRequest({ workRequestId: WR, attachments: [{ name: 'a.png', dataUrl: PNG }] }).ok).toBe(true);
    const v = validateAttachRequest({ workRequestId: 'https://aap-na.corp.amazon.com/v2/service/' + WR, attachments: [{ dataUrl: PDF }] });
    expect(v.ok).toBe(true);
    expect(v.workRequestId).toBe(WR);
    expect(v.attachments[0].name).toBe('attachment-1');
  });
  it('rejects a missing/invalid WR id', () => {
    expect(validateAttachRequest({ workRequestId: '', attachments: [{ dataUrl: PNG }] }).ok).toBe(false);
    expect(validateAttachRequest({ workRequestId: 'not-a-wr', attachments: [{ dataUrl: PNG }] }).ok).toBe(false);
  });
  it('rejects no files, too many files, and non PNG/JPEG/PDF', () => {
    expect(validateAttachRequest({ workRequestId: WR, attachments: [] }).ok).toBe(false);
    expect(validateAttachRequest({ workRequestId: WR, attachments: Array(11).fill({ dataUrl: PNG }) }).ok).toBe(false);
    const heic = validateAttachRequest({ workRequestId: WR, attachments: [{ name: 'x.heic', dataUrl: 'data:image/heic;base64,AAAA' }] });
    expect(heic.ok).toBe(false);
    expect(heic.error).toMatch(/x\.heic/);
  });
  it('rejects more than 25 MB total', () => {
    const big = 'data:image/jpeg;base64,' + 'A'.repeat(26 * 1024 * 1024 * 4 / 3);
    expect(validateAttachRequest({ workRequestId: WR, attachments: [{ dataUrl: big }] }).ok).toBe(false);
  });
});

describe('attachToOpenWr', () => {
  it('uploads to the given WR and reports all-ok', async () => {
    const upload = vi.fn(async (id, atts) => atts.map((a) => ({ name: a.name, ok: true })));
    const r = await attachToOpenWr({ workRequestId: WR, attachments: [{ name: 'a.png', dataUrl: PNG }, { name: 'b.pdf', dataUrl: PDF }] }, { uploadWrAttachments: upload });
    expect(upload).toHaveBeenCalledWith(WR, [{ name: 'a.png', dataUrl: PNG }, { name: 'b.pdf', dataUrl: PDF }], {});
    expect(r.ok).toBe(true);
    expect(r.partial).toBe(false);
  });
  it('reports partial success', async () => {
    const upload = async () => [{ name: 'a', ok: true }, { name: 'b', ok: false, error: 'x' }];
    const r = await attachToOpenWr({ workRequestId: WR, attachments: [{ dataUrl: PNG }, { dataUrl: PNG }] }, { uploadWrAttachments: upload });
    expect(r.ok).toBe(false);
    expect(r.partial).toBe(true);
  });
  it('never uploads an invalid request', async () => {
    const upload = vi.fn();
    const r = await attachToOpenWr({ workRequestId: 'bad', attachments: [{ dataUrl: PNG }] }, { uploadWrAttachments: upload });
    expect(r.ok).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });
  it('turns an upload exception into a failed result', async () => {
    const r = await attachToOpenWr({ workRequestId: WR, attachments: [{ dataUrl: PNG }] }, { uploadWrAttachments: async () => { throw new Error('403'); } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('403');
  });
});

describe('openWrChoices (unit-detail)', async () => {
  const { openWrChoices } = await import('../renderer/src/js/views/unit-detail.js');
  it('lists the primary + secondary open WRs, skipping closed ones and duplicates', () => {
    const W2 = '9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff';
    const W3 = '11111111-2222-3333-4444-555555555555';
    const c = openWrChoices({
      workRequestId: WR, serviceState: 'In Progress', issueDetails: 'Air leak',
      _secondaryWRs: [
        { workRequestId: W2, serviceState: 'Open', issueDetails: 'PM-B' },
        { workRequestId: W3, serviceState: 'Completed' },
        { _serviceUUID: WR },
      ],
    });
    expect(c.map((x) => x.id)).toEqual([WR, W2]);
    expect(c[0].label).toContain('In Progress');
    expect(c[0].label).toContain('Air leak');
  });
  it('returns nothing when the unit has no open WR', () => {
    expect(openWrChoices({ workRequestId: '' })).toEqual([]);
    expect(openWrChoices({ workRequestId: WR, completed: '2026-10-01T00:00:00Z' })).toEqual([]);
  });
});
