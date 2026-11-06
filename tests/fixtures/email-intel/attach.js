// tests/fixtures/email-intel/attach.js — Phase F helpers: a fake reader that does what owa_capture does when
// the `attachments` flag is effective (policy -> fetch -> extract -> excerpt on the capture, plus the F-14
// re-extract pass), with a scripted fetcher and a stubbed extractItem. No Outlook, no worker, no vision model.
import { createRequire } from 'module';
import { fakeReader, PHASE_C } from './phase-c.js';
const require = createRequire(import.meta.url);
const ex = require('../../../src/email-intel/attach/extract');
export const { REASONS } = require('../../../src/justme-context/constants');

export const PHASE_F = Object.freeze(Object.assign({}, PHASE_C, { attachments: true }));

/** A real-looking attachment as parse-snapshot produces it (an allowed download handle on the chip). */
export function att(name, over = {}) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  return Object.assign({ attId: null, name, ext, sizeBytes: 120_000, kind: ext === 'png' || ext === 'jpg' ? 'image' : 'document', placeholder: false, hasDownloadHandle: true, analysis: { status: 'filename-only' } }, over);
}

/** extract stub: by attachment name -> extractItem-shaped item (or a function(file, ctx) -> item). Opens and records a session. */
export function stubExtract(byName, calls) {
  const c = calls || { n: 0, closed: 0 };
  const fn = async (file, ctx) => {
    c.n++;
    if (!ctx.session) ctx.session = { close() { c.closed++; } };
    const v = byName[file.name];
    const item = typeof v === 'function' ? await v(file, ctx) : v;
    return item || { kind: 'file', status: 'failed', reason: REASONS.PARSE_FAILED, text: '' };
  };
  fn.calls = c;
  return fn;
}

/** attReader(caps, { extract, fetch }) -> readMailbox stand-in; fetch(att, i) -> { ok, buffer } (default: ok). */
export function attReader(caps, o = {}) {
  const calls = o.calls || { fetch: 0, reextractTargets: 0 };
  const fetchOne = async (a, i) => { calls.fetch++; return o.fetch ? o.fetch(a, i) : { ok: true, buffer: Buffer.from('%PDF-1.4 bytes'), mimetype: 'application/pdf' }; };
  const reader = async (r) => {
    if (r.attachments) {
      for (const c of caps) {
        const res = await ex.analyzeAttachments({ attachments: c.attachments, budget: r.attachments.budget, flagOn: true, fetchOne, deps: { extractItem: o.extract } });
        c.attachments = res.attachments;
        if (res.excerpts.length) c.attachmentExcerpts = res.excerpts;
      }
      for (const t of r.reextract || []) {
        calls.reextractTargets++;
        if (o.notFound) { await r.onReextract(t, { status: 'not-found' }); continue; }
        const res = await ex.analyzeAttachments({ attachments: t.attachments, only: new Set(t.indexes), reextract: true, budget: r.attachments.budget, flagOn: true, fetchOne, deps: { extractItem: o.extract } });
        await r.onReextract(t, { status: 'ok', attachments: res.attachments, excerpts: res.excerpts });
      }
    }
    return fakeReader(caps)(r);
  };
  reader.calls = calls;
  return reader;
}
