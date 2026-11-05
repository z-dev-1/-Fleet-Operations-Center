// vision.js: budget-capped visionRead (design §8.3), fix 10 (deadline -> BUDGET),
// fix 16 (redactLog) and fix 2, vision half (T-VISION-SECRET).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const H = require('./helpers/jmctx-worker.cjs');
const { visionRead, VISION_PROMPT } = require('../src/justme-context/vision');
const { extractItem } = require('../src/justme-context/extract-host');
const { LIMITS, REASONS } = require('../src/justme-context/constants');

const PNG = { name: 'shot.png', mimetype: 'image/png', buffer: Buffer.from([1, 2, 3]) };
const FAKE_TOKEN = 'xoxc-1234567890-abcdefghij';
const FAKE_AKIA = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const SECRET_TEXTS = {
  'cookie-jar-line': 'w.amazon.com\tFALSE\t/\tTRUE\t1893456000\tsession\tvalue-123',
  'slack-token': 'Slack token: ' + FAKE_TOKEN,
  'aws-access-key': 'AWS key ' + FAKE_AKIA,
};

let logger, bedrock, ctx, deps, now;
beforeEach(() => {
  logger = H.makeLogger(vi);
  bedrock = { readFileWithVision: vi.fn(async () => ({ ok: true, text: 'transcribed text' })) };
  now = 1_000_000;
  ctx = { deadline: now + 120000, visionLeft: LIMITS.MAX_VISION, signal: undefined };
  deps = { bedrock, logger, now: () => now };
});

describe('visionRead', () => {
  it('passes the capped options to bedrock and returns the text', async () => {
    const ac = new AbortController();
    ctx.signal = ac.signal;
    const r = await visionRead(PNG, 'vision_image', ctx, deps);
    expect(r).toEqual({ ok: true, text: 'transcribed text' });
    const [file, opts] = bedrock.readFileWithVision.mock.calls[0];
    expect(file).toBe(PNG);
    expect(opts.prompt).toBe(VISION_PROMPT);
    expect(opts.prompt).toContain('./%%NAME%%');
    expect(opts).toMatchObject({ source: 'vision_image', redactLog: true, signal: ac.signal });
    expect(opts.deadline).toBe(ctx.deadline - 2000);
    expect(opts.timeoutMs).toBe(LIMITS.VISION_TIMEOUT_MS);
    expect(opts).not.toHaveProperty('confineRead');
    expect(ctx.visionLeft).toBe(LIMITS.MAX_VISION - 1);
  });
  it('timeoutMs shrinks to remaining - 2 s near the end of the budget', async () => {
    now = ctx.deadline - 20000;
    await visionRead(PNG, 'vision_image', ctx, deps);
    expect(bedrock.readFileWithVision.mock.calls[0][1].timeoutMs).toBe(18000);
  });

  it('cap: the fifth read is refused without calling bedrock', async () => {
    for (let i = 0; i < LIMITS.MAX_VISION; i++) expect((await visionRead(PNG, 's', ctx, deps)).ok).toBe(true);
    expect(await visionRead(PNG, 's', ctx, deps)).toEqual({ ok: false, reason: REASONS.VISION_CAP });
    expect(bedrock.readFileWithVision).toHaveBeenCalledTimes(LIMITS.MAX_VISION);
  });
  it('budget: under 15 s remaining is skipped without calling bedrock or spending a read', async () => {
    now = ctx.deadline - (LIMITS.VISION_MIN_REMAINING_MS - 1);
    expect(await visionRead(PNG, 's', ctx, deps)).toEqual({ ok: false, reason: REASONS.BUDGET });
    expect(bedrock.readFileWithVision).not.toHaveBeenCalled();
    expect(ctx.visionLeft).toBe(LIMITS.MAX_VISION);
  });
  it('abort while reading -> BUDGET even if bedrock never resolves', async () => {
    bedrock.readFileWithVision.mockImplementation(() => new Promise(() => {}));
    const ac = new AbortController();
    ctx.signal = ac.signal;
    const p = visionRead(PNG, 's', ctx, deps);
    await Promise.resolve();
    ac.abort();
    expect(await p).toEqual({ ok: false, reason: REASONS.BUDGET });
  });
  it('an already-aborted signal -> BUDGET', async () => {
    const ac = new AbortController(); ac.abort();
    ctx.signal = ac.signal;
    expect(await visionRead(PNG, 's', ctx, deps)).toEqual({ ok: false, reason: REASONS.BUDGET });
  });

  describe('error mapping (the bedrock error string is only pattern-matched)', () => {
    const rows = [
      ['vision deadline passed', REASONS.BUDGET],                       // fix 10: before the generic mapping
      ['claude-code not installed', REASONS.VISION_UNAVAILABLE],
      ['claude-code read timed out', REASONS.VISION_FAILED],
      ['could not read the file', REASONS.VISION_FAILED],
      ['claude-code error: SENTINEL-CONTENT-7f3a', REASONS.VISION_FAILED],
      ['', REASONS.VISION_FAILED],
    ];
    for (const [error, reason] of rows) {
      it(JSON.stringify(error) + ' -> ' + reason, async () => {
        bedrock.readFileWithVision.mockResolvedValue({ ok: false, error });
        const r = await visionRead(PNG, 's', ctx, deps);
        expect(r).toEqual({ ok: false, reason });
        expect(H.allLogged(logger)).not.toContain('SENTINEL');
      });
    }
    it('a rejection becomes VISION_FAILED', async () => {
      bedrock.readFileWithVision.mockRejectedValue(new Error('SENTINEL-CONTENT-7f3a'));
      expect(await visionRead(PNG, 's', ctx, deps)).toEqual({ ok: false, reason: REASONS.VISION_FAILED });
    });
    it('a synchronous throw becomes VISION_FAILED', async () => {
      bedrock.readFileWithVision.mockImplementation(() => { throw new Error('x'); });
      expect(await visionRead(PNG, 's', ctx, deps)).toEqual({ ok: false, reason: REASONS.VISION_FAILED });
    });
  });
});

describe('T-VISION-SECRET (vision half, fix 2)', () => {
  for (const [name, text] of Object.entries(SECRET_TEXTS)) {
    it(name + ': the item fails, has no text, and no log line contains the secret', async () => {
      bedrock.readFileWithVision.mockResolvedValue({ ok: true, text });
      const r = await visionRead(PNG, 'vision_image', ctx, deps);
      expect(r).toEqual({ ok: false, reason: REASONS.SECRET_LIKE });
      const logged = H.allLogged(logger);
      expect(logged).toContain('[jmctx] vision text withheld: ' + name);
      expect(logged).not.toContain(FAKE_TOKEN);
      expect(logged).not.toContain(FAKE_AKIA);
      expect(logged).not.toContain('value-123');
    });
    it(name + ': through extractItem the item is failed with SECRET_LIKE and no text', async () => {
      bedrock.readFileWithVision.mockResolvedValue({ ok: true, text });
      const item = await extractItem({ buffer: H.fx('tiny.png'), name: 'shot.png' }, ctx, deps);
      expect(item).toMatchObject({ status: 'failed', reason: REASONS.SECRET_LIKE, text: '', chars: 0 });
      expect(JSON.stringify(item)).not.toContain(FAKE_TOKEN);
    });
  }
  it('a scanned PDF whose transcription holds a secret is also withheld', async () => {
    bedrock.readFileWithVision.mockResolvedValue({ ok: true, text: SECRET_TEXTS['slack-token'] });
    const child = H.makeFakeChild(vi, (m, c) => setImmediate(() => c.reply({ id: m.id, ok: true, kind: 'pdf', text: '', truncated: false, needsVision: true, reason: 'SCANNED_PDF_UNAVAILABLE', image: { name: 's.pdf', mimetype: 'application/pdf', buffer: new Uint8Array([1]) } })));
    const c2 = { ...ctx };
    const item = await extractItem({ buffer: Buffer.from('%PDF-1.4 x'), name: 's.pdf' }, c2, { ...deps, spawnWorker: () => child, getChildRss: () => 1 });
    expect(item).toMatchObject({ status: 'failed', reason: REASONS.SECRET_LIKE, text: '' });
    c2.session.close();
  });
  it('benign transcriptions pass', async () => {
    bedrock.readFileWithVision.mockResolvedValue({ ok: true, text: 'Unit 320160 at ABE40, password reset done' });
    expect((await visionRead(PNG, 's', ctx, deps)).ok).toBe(true);
  });
});
