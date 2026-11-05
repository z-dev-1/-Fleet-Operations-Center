// extract-host: T-WORKER-UNIT (fake child), fix 4 (fixed partition), fix 11 (worker env),
// and T-WORKER-REAL (real processes: infinite loop, cyclic CFB, PDF stream bomb).
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const H = require('./helpers/jmctx-worker.cjs');
const host = require('../src/justme-context/extract-host');
const { createWorkerSession, workerEnv, WORKER_PARTITION, extractItem } = host;
const { REASONS, LIMITS } = require('../src/justme-context/constants');

const JOB = { name: 'a.txt', mimetype: 'text/plain', buffer: Buffer.from('hello') };
const fakeElectron = (children) => ({ utilityProcess: { fork: vi.fn(() => children.shift()) } });
const echoChild = () => H.makeFakeChild(vi, (m, c) => setImmediate(() => c.reply(H.okReply(m))));

describe('T-WORKER-UNIT (fake child)', () => {
  let logger;
  beforeEach(() => { logger = H.makeLogger(vi); });
  afterEach(() => { vi.useRealTimers(); });

  it('a valid reply resolves and the child is reused for the next job', async () => {
    const child = echoChild();
    const spawnWorker = vi.fn(() => child);
    const s = createWorkerSession({ spawnWorker, logger, getChildRss: () => 1 });
    expect(await s.extract(JOB)).toMatchObject({ ok: true, text: 'hello', kind: 'text' });
    expect(await s.extract(JOB)).toMatchObject({ ok: true });
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(child.postMessage.mock.calls[0][0]).toMatchObject({ id: 1, name: 'a.txt', mimetype: 'text/plain' });
    expect(child.postMessage.mock.calls[0][0].buffer).toBeInstanceOf(Uint8Array);
    s.close();
  });

  it('timeout -> kill + TOO_COMPLEX, and the next job spawns a new child', async () => {
    vi.useFakeTimers();
    const hung = H.makeFakeChild(vi, null);
    const fresh = echoChild();
    const kids = [hung, fresh];
    const s = createWorkerSession({ spawnWorker: () => kids.shift(), logger, limits: { PARSE_TIMEOUT_MS: 1000 }, getChildRss: () => 1 });
    const p = s.extract(JOB, { kind: 'pdf' });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await p).toMatchObject({ ok: false, reason: 'TOO_COMPLEX' });
    expect(hung.kill).toHaveBeenCalled();
    expect(logger.warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/\[jmctx\] worker killed pdf timeout rss=0MB \d+ms/);
    vi.useRealTimers();
    expect(await s.extract(JOB)).toMatchObject({ ok: true });
    expect(fresh.postMessage).toHaveBeenCalledTimes(1);
  });

  it('working set over the cap -> kill + TOO_COMPLEX', async () => {
    vi.useFakeTimers();
    const child = H.makeFakeChild(vi, null);
    let rss = 100 * 1024 * 1024;
    const s = createWorkerSession({ spawnWorker: () => child, logger, getChildRss: () => rss });
    const p = s.extract(JOB);
    await vi.advanceTimersByTimeAsync(260);
    expect(child.kill).not.toHaveBeenCalled();
    rss = 2 * 1024 * 1024 * 1024;
    await vi.advanceTimersByTimeAsync(260);
    expect(await p).toMatchObject({ ok: false, reason: 'TOO_COMPLEX' });
    expect(child.kill).toHaveBeenCalled();
    expect(logger.warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/worker killed file rss rss=2048MB/);
  });

  it("'exit' with a pending job -> TOO_COMPLEX", async () => {
    const child = H.makeFakeChild(vi, (m, c) => setImmediate(() => c.emit('exit', 134)));
    const s = createWorkerSession({ spawnWorker: () => child, logger, getChildRss: () => 1 });
    expect(await s.extract(JOB)).toMatchObject({ ok: false, reason: 'TOO_COMPLEX' });
  });

  it('gather abort -> kill + BUDGET; an already-aborted signal never posts', async () => {
    const child = H.makeFakeChild(vi, null);
    const s = createWorkerSession({ spawnWorker: () => child, logger, getChildRss: () => 1 });
    const ac = new AbortController();
    const p = s.extract(JOB, { signal: ac.signal });
    ac.abort();
    expect(await p).toMatchObject({ ok: false, reason: 'BUDGET' });
    expect(child.kill).toHaveBeenCalled();
    const ac2 = new AbortController(); ac2.abort();
    const before = child.postMessage.mock.calls.length;
    expect(await s.extract(JOB, { signal: ac2.signal })).toMatchObject({ reason: 'BUDGET' });
    expect(child.postMessage.mock.calls.length).toBe(before);
  });

  describe('malformed replies fail the job and replace the worker', () => {
    const bad = {
      'wrong id': (m) => ({ id: m.id + 5, ok: true, text: 'x' }),
      'non-string text': (m) => ({ id: m.id, ok: true, text: 42 }),
      'non-boolean ok': (m) => ({ id: m.id, ok: 'yes', text: 'x' }),
      'oversized image': (m) => ({ id: m.id, ok: true, text: '', needsVision: true, image: { name: 'a.jpg', mimetype: 'image/jpeg', buffer: new Uint8Array(11 * 1024 * 1024) } }),
      'bad image mimetype': (m) => ({ id: m.id, ok: true, text: '', image: { name: 'a.exe', mimetype: 'application/x-msdownload', buffer: new Uint8Array(4) } }),
      'not an object': () => 'hello',
    };
    for (const [name, make] of Object.entries(bad)) {
      it(name, async () => {
        const first = H.makeFakeChild(vi, (m, c) => setImmediate(() => c.reply(make(m))));
        const second = echoChild();
        const kids = [first, second];
        const s = createWorkerSession({ spawnWorker: () => kids.shift(), logger, getChildRss: () => 1 });
        expect(await s.extract(JOB)).toMatchObject({ ok: false, reason: 'PARSE_FAILED' });
        expect(first.kill).toHaveBeenCalled();
        expect(await s.extract(JOB)).toMatchObject({ ok: true });
        expect(second.postMessage).toHaveBeenCalledTimes(1);
      });
    }
  });

  it('unknown reason is coerced to PARSE_FAILED, a bad errCode is dropped, free-form meta is filtered', async () => {
    const child = H.makeFakeChild(vi, (m, c) => setImmediate(() => c.reply({ id: m.id, ok: false, text: '', reason: 'NOT_A_REASON', errCode: 'has spaces', meta: { pages: 3, evil: 'x', note: 'SHEET_ROWS_CUT' } })));
    const s = createWorkerSession({ spawnWorker: () => child, logger, getChildRss: () => 1 });
    const r = await s.extract(JOB);
    expect(r).toMatchObject({ ok: false, reason: 'PARSE_FAILED', meta: { pages: 3, note: 'SHEET_ROWS_CUT' } });
    expect(r.errCode).toBeUndefined();
    expect(r.meta.evil).toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('text longer than the raw cap is cut and flagged truncated', async () => {
    const child = H.makeFakeChild(vi, (m, c) => setImmediate(() => c.reply(H.okReply(m, { text: 'x'.repeat(LIMITS.RAW_TEXT_MAX_CHARS + 50) }))));
    const r = await createWorkerSession({ spawnWorker: () => child, logger, getChildRss: () => 1 }).extract(JOB);
    expect(r.text).toHaveLength(LIMITS.RAW_TEXT_MAX_CHARS);
    expect(r.truncated).toBe(true);
  });

  it('close() kills the worker and later jobs are refused', async () => {
    const child = echoChild();
    const s = createWorkerSession({ spawnWorker: () => child, logger, getChildRss: () => 1 });
    await s.extract(JOB);
    s.close();
    expect(child.kill).toHaveBeenCalled();
    expect(await s.extract(JOB)).toMatchObject({ ok: false, reason: 'READER_UNAVAILABLE' });
  });

  it('spawn throws -> READER_UNAVAILABLE, logged once, no message in the log', async () => {
    const spawnWorker = vi.fn(() => { throw Object.assign(new Error('boom SENTINEL-CONTENT-7f3a'), { code: 'ENOENT' }); });
    const s = createWorkerSession({ spawnWorker, logger });
    expect(await s.extract(JOB)).toMatchObject({ ok: false, reason: 'READER_UNAVAILABLE' });
    expect(await s.extract(JOB)).toMatchObject({ ok: false, reason: 'READER_UNAVAILABLE' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toBe('[jmctx] extract worker spawn failed: ENOENT');
    expect(H.allLogged(logger)).not.toContain('SENTINEL');
  });

  it('without electron or a spawn override the session fails closed (no in-process fallback)', async () => {
    const s = createWorkerSession({ logger });
    expect(await s.extract(JOB)).toMatchObject({ ok: false, reason: 'READER_UNAVAILABLE' });
  });
});

describe('fix 4: one fixed non-persistent partition', () => {
  it('WORKER_PARTITION is the constant "jmctx-extract" (no persist:, no random suffix)', () => {
    expect(WORKER_PARTITION).toBe('jmctx-extract');
    expect(WORKER_PARTITION.startsWith('persist:')).toBe(false);
  });
  it('every fork - first spawn, respawn after a kill, and a second session - uses it', async () => {
    vi.useFakeTimers();
    const kids = [H.makeFakeChild(vi, null), echoChild(), echoChild()];
    const electron = fakeElectron(kids);
    const logger = H.makeLogger(vi);
    const s1 = createWorkerSession({ electron, logger, limits: { PARSE_TIMEOUT_MS: 500 }, getChildRss: () => 1 });
    const p = s1.extract(JOB);
    await vi.advanceTimersByTimeAsync(600);                       // first child times out and is killed
    expect((await p).reason).toBe('TOO_COMPLEX');
    vi.useRealTimers();
    expect((await s1.extract(JOB)).ok).toBe(true);                // respawn
    const s2 = createWorkerSession({ electron, logger, getChildRss: () => 1 });
    expect((await s2.extract(JOB)).ok).toBe(true);                // second session
    expect(electron.utilityProcess.fork).toHaveBeenCalledTimes(3);
    for (const [file, args, opts] of electron.utilityProcess.fork.mock.calls) {
      expect(path.basename(file)).toBe('extract-worker.js');
      expect(args).toEqual([]);
      expect(opts.partition).toBe('jmctx-extract');
      expect(opts).toMatchObject({ serviceName: 'fleet-jmctx-extract', stdio: 'ignore', execArgv: ['--max-old-space-size=512'] });
    }
    s1.close(); s2.close();
  });
});

describe('fix 11: worker env', () => {
  const saved = {};
  beforeEach(() => { for (const k of ['FLEET_X', 'SLACK_TOKEN', 'AWS_SECRET_ACCESS_KEY']) { saved[k] = process.env[k]; process.env[k] = 'secret-value'; } });
  afterEach(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('contains only NODE_ENV, SystemRoot, windir, TEMP, TMP - no tokens or FLEET_* even when set', () => {
    const env = workerEnv();
    const allowed = new Set(['NODE_ENV', 'SystemRoot', 'windir', 'TEMP', 'TMP']);
    for (const k of Object.keys(env)) { expect(allowed.has(k)).toBe(true); expect(k).not.toMatch(/TOKEN|SLACK|AWS|FLEET_|COOKIE/i); }
    expect(env.TEMP).toBe(os.tmpdir());
    expect(env.TMP).toBe(os.tmpdir());
    expect(env.NODE_ENV).toBeTruthy();
    if (process.platform === 'win32') { expect(env.SystemRoot).toBeTruthy(); expect(env.windir).toBeTruthy(); }
    expect(Object.values(env)).not.toContain('secret-value');
  });
  it('drops undefined values and is what utilityProcess.fork receives', async () => {
    expect(workerEnv({ NODE_ENV: 'test' })).toEqual({ NODE_ENV: 'test', TEMP: os.tmpdir(), TMP: os.tmpdir() });
    const electron = fakeElectron([echoChild()]);
    const s = createWorkerSession({ electron, logger: H.makeLogger(vi), getChildRss: () => 1 });
    await s.extract(JOB);
    const env = electron.utilityProcess.fork.mock.calls[0][2].env;
    expect(Object.keys(env).sort()).toEqual(Object.keys(workerEnv()).sort());
    expect(Object.keys(env).join(',')).not.toMatch(/TOKEN|SLACK|AWS|FLEET_/i);
    s.close();
  });
});

describe('extractItem session handling', () => {
  it('creates a session lazily on ctx and reuses it; images never spawn a worker', async () => {
    const spawnWorker = vi.fn(() => echoChild());
    const bedrock = { readFileWithVision: vi.fn(async () => ({ ok: true, text: 'img text' })) };
    const ctx = { deadline: Date.now() + 120000, visionLeft: 4 };
    const deps = { spawnWorker, bedrock, logger: H.makeLogger(vi), getChildRss: () => 1 };
    await extractItem({ buffer: H.fx('tiny.png'), name: 'a.png' }, ctx, deps);
    expect(spawnWorker).not.toHaveBeenCalled();
    expect(ctx.session).toBeUndefined();
    await extractItem({ buffer: H.fx('sample.txt'), name: 'a.txt' }, ctx, deps);
    await extractItem({ buffer: H.fx('sample.txt'), name: 'b.txt' }, ctx, deps);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(ctx.session).toBeTruthy();
    ctx.session.close();
  });
  it('maps a spawn failure to a failed item with the fixed reason', async () => {
    const it_ = await extractItem({ buffer: H.fx('sample.txt'), name: 'a.txt' }, { deadline: Date.now() + 1e5 }, { spawnWorker: () => { throw new Error('x'); }, logger: H.makeLogger(vi) });
    expect(it_).toMatchObject({ status: 'failed', reason: REASONS.READER_UNAVAILABLE });
  });
  it('pdfjs unavailable is logged once per process', async () => {
    host.__test__.resetOnce();
    const logger = H.makeLogger(vi);
    const child = H.makeFakeChild(vi, (m, c) => setImmediate(() => c.reply({ id: m.id, ok: true, kind: 'pdf', text: '', truncated: false, needsVision: true, reason: 'PDFJS_UNAVAILABLE', errCode: 'ERR_MODULE_NOT_FOUND', image: { name: 'a.pdf', mimetype: 'application/pdf', buffer: new Uint8Array([1, 2, 3]) } })));
    const bedrock = { readFileWithVision: vi.fn(async () => ({ ok: true, text: 'pdf via vision' })) };
    const ctx = { deadline: Date.now() + 120000, visionLeft: 4 };
    const deps = { spawnWorker: () => child, logger, bedrock, getChildRss: () => 1 };
    const a = await extractItem({ buffer: Buffer.from('%PDF-1.4 x'), name: 'a.pdf' }, ctx, deps);
    await extractItem({ buffer: Buffer.from('%PDF-1.4 x'), name: 'b.pdf' }, ctx, deps);
    expect(a).toMatchObject({ status: 'read', text: 'pdf via vision', reason: REASONS.PDFJS_UNAVAILABLE });
    expect(logger.error.mock.calls.filter((c) => /pdfjs unavailable: ERR_MODULE_NOT_FOUND/.test(c[0]))).toHaveLength(1);
    ctx.session.close();
  });
});

describe('main process never loads a parser library', () => {
  it('requiring extract-host and vision (and detecting types) loads none of them', () => {
    const { execFileSync } = require('child_process');
    const { fileURLToPath } = require('url');
    const src = fileURLToPath(new URL('../src/justme-context', import.meta.url));
    const code = [
      'const h = require(' + JSON.stringify(path.join(src, 'extract-host.js')) + ');',
      'require(' + JSON.stringify(path.join(src, 'vision.js')) + ');',
      'h.workerEnv(); require(' + JSON.stringify(path.join(src, 'extract.js')) + ').detectType(Buffer.from("%PDF-1.4"), "a.pdf", "");',
      'console.log(JSON.stringify(Object.keys(require.cache).filter((k) => /node_modules[\\\\/](pdfjs-dist|mammoth|xlsx|mailparser|@kenjiuno|heic-convert|jszip)[\\\\/]/.test(k))));',
    ].join('\n');
    const out = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' }).trim();
    expect(JSON.parse(out)).toEqual([]);
  });
});

// ───────────────────────── T-WORKER-REAL ─────────────────────────

describe('T-WORKER-REAL (real processes)', () => {
  const tmpBomb = path.join(os.tmpdir(), 'jmctx-bomb-' + process.pid + '.pdf');
  const TIMEOUT = 2000;
  afterAll(() => { try { fs.unlinkSync(tmpBomb); } catch (_) { /* ignore */ } });

  it('an infinite-loop worker is killed at PARSE_TIMEOUT_MS and its pid is gone', async () => {
    let pid;
    const s = createWorkerSession({ spawnWorker: () => { const c = H.spawnLoopWorker(); pid = c.pid; return c; }, logger: H.makeLogger(vi), limits: { PARSE_TIMEOUT_MS: TIMEOUT }, getChildRss: () => 1 });
    const t0 = Date.now();
    const r = await s.extract(JOB);
    const dt = Date.now() - t0;
    expect(r).toMatchObject({ ok: false, reason: 'TOO_COMPLEX' });
    expect(dt).toBeGreaterThanOrEqual(TIMEOUT - 50);
    expect(dt).toBeLessThan(TIMEOUT + 1500);
    await new Promise((res) => setTimeout(res, 300));
    expect(H.pidAlive(pid)).toBe(false);
  }, 15000);

  // The timer starts when the job is posted, so a freshly (re)spawned worker's boot and
  // library load count against it. Under the full parallel suite that alone can pass 2 s,
  // so this test uses 4 s (+1 s slack); the infinite-loop test above keeps the 2 s value.
  it('cyclic msg/xls, and the PDF stream bomb, each fail or finish within the timer + 1 s and the next docx is still read', async () => {
    const TIMEOUT = 4000;
    const { makeBombPdf } = require('./fixtures/justme-context/make-fixtures.cjs');
    await makeBombPdf(tmpBomb);
    const rssBefore = process.memoryUsage().rss;
    const logger = H.makeLogger(vi);
    const ctx = { deadline: Date.now() + 10 * 60 * 1000, visionLeft: 4 };
    const deps = { spawnWorker: H.spawnRealWorker, logger, limits: { PARSE_TIMEOUT_MS: TIMEOUT }, getChildRss: () => 1, bedrock: { readFileWithVision: vi.fn() } };
    const inputs = [['cyclic.msg', 'cyclic.msg'], ['cyclic2.msg', 'cyclic2.msg'], ['cyclic.xls', 'cyclic.xls'], ['cyclic2.xls', 'cyclic2.xls']].map(([f, n]) => [n, H.fx(f)]);
    inputs.push(['bomb.pdf', fs.readFileSync(tmpBomb)]);
    for (const [name, buffer] of inputs) {
      const t0 = Date.now();
      const item = await extractItem({ buffer, name }, ctx, deps);
      expect(Date.now() - t0, name).toBeLessThan(TIMEOUT + 1000);
      // Outcome class only: either the library detected the problem, or the host killed the worker.
      expect(['failed', 'read', 'truncated']).toContain(item.status);
      if (name === 'bomb.pdf') expect(item.status).toBe('failed');
      const next = await extractItem({ buffer: H.fx('sample.docx'), name: 'sample.docx' }, ctx, deps);
      expect(next.status, 'after ' + name).toBe('read');
      expect(next.text).toContain('SENTINEL-CONTENT-7f3a');
    }
    ctx.session.close();
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(100 * 1024 * 1024);
    expect(H.allLogged(logger)).not.toContain('SENTINEL');
  }, 120000);
});
