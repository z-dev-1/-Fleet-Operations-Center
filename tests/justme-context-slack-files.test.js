// slack-files.js readSlackFile: round-3 fix 14 order (id first, files.info merge,
// URL validated on the MERGED record), modes, snippets, canvases/posts, preview fallback.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const H = require('./helpers/jmctx-worker.cjs');
const { readSlackFile, fileLabel, slackFileIdFromPermalink } = require('../src/justme-context/slack-files');
const { REASONS } = require('../src/justme-context/constants');

const GOOD = 'https://files.slack.com/files-pri/T1-F0ABC/download/report.pdf';
let slackSend, extractItem, logger, ctx, deps;
beforeEach(() => {
  logger = H.makeLogger(vi);
  slackSend = {
    getFileInfo: vi.fn(async () => ({ ok: false, error: 'file_not_found' })),
    downloadFileBounded: vi.fn(async (f) => ({ ok: true, buffer: Buffer.from('BYTES:' + f.name), mimetype: f.mimetype, name: f.name })),
  };
  extractItem = vi.fn(async (file) => ({ kind: 'pdf', status: 'read', text: 'TEXT ' + file.buffer.toString(), chars: 5, truncated: false, reason: '', meta: {} }));
  ctx = { deadline: Date.now() + 60000, jobId: 'jm3' };
  deps = { slackSend, extractItem, logger };
});

describe('fix 14 order', () => {
  it('check_file_info stub without a URL -> getFileInfo once, then the merged URL is downloaded', async () => {
    slackSend.getFileInfo.mockResolvedValue({ ok: true, file: { id: 'F0ABC', name: 'report.pdf', mimetype: 'application/pdf', url_private_download: GOOD, size: 100 } });
    const r = await readSlackFile({ id: 'F0ABC', file_access: 'check_file_info' }, ctx, deps);
    expect(slackSend.getFileInfo).toHaveBeenCalledTimes(1);
    expect(slackSend.getFileInfo).toHaveBeenCalledWith('F0ABC');
    expect(slackSend.downloadFileBounded).toHaveBeenCalledTimes(1);
    expect(slackSend.downloadFileBounded.mock.calls[0][0].url_private_download).toBe(GOOD);
    expect(r).toMatchObject({ status: 'read', label: 'report.pdf', text: 'TEXT BYTES:report.pdf' });
    expect(extractItem.mock.calls[0][1]).toBe(ctx);
  });
  for (const bad of ['../x', 'f0abc', 'F0abc', '', undefined, 'F0ABC/../../x', 12]) {
    it('id ' + JSON.stringify(bad) + ' -> INVALID_FILE with zero Slack calls', async () => {
      const r = await readSlackFile({ id: bad, url_private: GOOD, name: 'x.pdf' }, ctx, deps);
      expect(r).toMatchObject({ status: 'failed', reason: REASONS.INVALID_FILE });
      expect(slackSend.getFileInfo).not.toHaveBeenCalled();
      expect(slackSend.downloadFileBounded).not.toHaveBeenCalled();
    });
  }
  it('merged record URL on evil.example -> failed, no download', async () => {
    slackSend.getFileInfo.mockResolvedValue({ ok: true, file: { url_private: 'https://evil.example/f.pdf', name: 'f.pdf' } });
    const r = await readSlackFile({ id: 'F0ABC', file_access: 'check_file_info' }, ctx, deps);
    expect(r).toMatchObject({ status: 'failed', reason: REASONS.INVALID_FILE });
    expect(slackSend.downloadFileBounded).not.toHaveBeenCalled();
  });
  it('a URL valid before the merge but replaced by info.file with evil.example -> failed (validated after merge)', async () => {
    slackSend.getFileInfo.mockResolvedValue({ ok: true, file: { url_private_download: 'https://evil.example/x', url_private: 'https://evil.example/x' } });
    const r = await readSlackFile({ id: 'F0ABC', file_access: 'check_file_info', url_private: GOOD, url_private_download: GOOD, name: 'a.pdf' }, ctx, deps);
    expect(slackSend.getFileInfo).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: 'failed', reason: REASONS.INVALID_FILE });
    expect(slackSend.downloadFileBounded).not.toHaveBeenCalled();
  });
  it('http:// and slack-lookalike hosts are rejected', async () => {
    for (const u of ['http://files.slack.com/x', 'https://slack.com.evil.io/x', 'https://slack-imgs.com/x', 'https://files.slack-edge.com/x']) {
      const r = await readSlackFile({ id: 'F0ABC', url_private: u, name: 'a.pdf' }, ctx, deps);
      expect(r.reason, u).toBe(REASONS.INVALID_FILE);
    }
    expect(slackSend.downloadFileBounded).not.toHaveBeenCalled();
  });
  it('a full payload with a URL skips files.info', async () => {
    await readSlackFile({ id: 'F0ABC', url_private: GOOD, name: 'a.pdf', mimetype: 'application/pdf' }, ctx, deps);
    expect(slackSend.getFileInfo).not.toHaveBeenCalled();
    expect(slackSend.downloadFileBounded).toHaveBeenCalledTimes(1);
  });
  it('files.info failure keeps the original record and logs only the error code', async () => {
    slackSend.getFileInfo.mockResolvedValue({ ok: false, error: 'file_not_found' });
    const r = await readSlackFile({ id: 'F0ABC', file_access: 'check_file_info', url_private: GOOD, name: 'a.pdf' }, ctx, deps);
    expect(r.status).toBe('read');
    expect(H.allLogged(logger)).toContain('[jmctx] files.info failed F0ABC: file_not_found');
  });
});

describe('modes and sizes', () => {
  for (const mode of ['external', 'tombstone', 'hidden_by_limit']) {
    it(mode + ' -> external/deleted, no Slack call', async () => {
      const r = await readSlackFile({ id: 'F0ABC', mode, url_private: GOOD }, ctx, deps);
      expect(r).toMatchObject({ status: 'failed', reason: REASONS.FILE_EXTERNAL });
      expect(slackSend.getFileInfo).not.toHaveBeenCalled();
      expect(slackSend.downloadFileBounded).not.toHaveBeenCalled();
    });
  }
  it('declared size over the cap -> too large without a request', async () => {
    const r = await readSlackFile({ id: 'F0ABC', url_private: GOOD, size: 26 * 1024 * 1024, name: 'big.pdf' }, ctx, deps);
    expect(r).toMatchObject({ status: 'failed', reason: REASONS.TOO_LARGE });
    expect(slackSend.downloadFileBounded).not.toHaveBeenCalled();
  });
  it('download failures map to fixed reasons; abort is skipped', async () => {
    const cases = [['aborted', 'skipped', REASONS.BUDGET], ['too-large', 'failed', REASONS.TOO_LARGE],
      ['Slack file download needs re-auth', 'failed', REASONS.SLACK_REAUTH], ['HTTP 404', 'failed', REASONS.SLACK_DOWNLOAD_FAILED],
      ['redirected off Slack', 'failed', REASONS.INVALID_FILE]];
    for (const [reason, status, want] of cases) {
      slackSend.downloadFileBounded.mockResolvedValueOnce({ ok: false, reason });
      const r = await readSlackFile({ id: 'F0ABC', url_private: GOOD, name: 'a.pdf' }, ctx, deps);
      expect(r, reason).toMatchObject({ status, reason: want });
    }
  });
  it('download options carry the cap, a bounded timeout and the gather signal', async () => {
    const ac = new AbortController();
    ctx.signal = ac.signal;
    await readSlackFile({ id: 'F0ABC', url_private: GOOD, name: 'a.pdf' }, ctx, deps);
    const o = slackSend.downloadFileBounded.mock.calls[0][1];
    expect(o.maxBytes).toBe(25 * 1024 * 1024);
    expect(o.timeoutMs).toBeLessThanOrEqual(30000);
    expect(o.signal).toBe(ac.signal);
  });
});

describe('canvas, post, snippet, preview fallback', () => {
  it('canvas -> files.info plain text, no download', async () => {
    slackSend.getFileInfo.mockResolvedValue({ ok: true, file: { plain_text: 'Canvas body SENTINEL', title: 'Team canvas' } });
    const r = await readSlackFile({ id: 'F0CAN', filetype: 'quip', mode: 'canvas', title: 'Team canvas' }, ctx, deps);
    expect(slackSend.getFileInfo).toHaveBeenCalledTimes(1);
    expect(slackSend.downloadFileBounded).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: 'read', text: 'Canvas body SENTINEL', reason: REASONS.SLACK_PREVIEW, meta: { via: 'slack-preview' }, label: 'Team canvas' });
  });
  it('post without readable text -> SLACK_NO_TEXT', async () => {
    slackSend.getFileInfo.mockResolvedValue({ ok: true, file: { title: 'Post' } });
    const r = await readSlackFile({ id: 'F0POST', filetype: 'post', mode: 'post', url_private: GOOD }, ctx, deps);
    expect(r).toMatchObject({ status: 'failed', reason: REASONS.SLACK_NO_TEXT });
    expect(slackSend.downloadFileBounded).not.toHaveBeenCalled();
  });
  it('snippet -> downloaded as text with the 5 MB cap', async () => {
    const r = await readSlackFile({ id: 'F0SNIP', mode: 'snippet', filetype: 'javascript', name: 'untitled', url_private: GOOD }, ctx, deps);
    const o = slackSend.downloadFileBounded.mock.calls[0][1];
    expect(o.maxBytes).toBe(5 * 1024 * 1024);
    expect(extractItem.mock.calls[0][0].mimetype).toBe('text/plain');
    expect(r.status).toBe('read');
  });
  it('unsupported file with a Slack preview -> preview text used and noted', async () => {
    extractItem.mockResolvedValueOnce({ kind: 'doc', status: 'unsupported', text: '', chars: 0, truncated: false, reason: "I can't read .doc files", meta: {} });
    const r = await readSlackFile({ id: 'F0DOC', url_private: GOOD, name: 'old.doc', preview: 'Preview SENTINEL' }, ctx, deps);
    expect(r).toMatchObject({ status: 'read', text: 'Preview SENTINEL', meta: { via: 'slack-preview' } });
    expect(r.reason).toContain("I can't read .doc files");
  });
  it('download failure with a preview -> preview fallback', async () => {
    slackSend.downloadFileBounded.mockResolvedValueOnce({ ok: false, reason: 'HTTP 500' });
    const r = await readSlackFile({ id: 'F0ABC', url_private: GOOD, name: 'a.pdf', preview_plain_text: 'pv' }, ctx, deps);
    expect(r).toMatchObject({ status: 'read', text: 'pv', reason: REASONS.SLACK_PREVIEW });
  });
  it('logs id, status, bytes and ms only', async () => {
    await readSlackFile({ id: 'F0ABC', url_private: GOOD + '?t=SECRETQ', name: 'secret-name.pdf' }, ctx, deps);
    const all = H.allLogged(logger);
    expect(all).toMatch(/\[jmctx\]\[jm3\] file F0ABC read \d+B \d+ms/);
    expect(all).not.toContain('SECRETQ');
    expect(all).not.toContain('secret-name');
    expect(all).not.toContain('TEXT');
  });
});

describe('helpers', () => {
  it('fileLabel strips backticks, control chars and <>|, caps at 80', () => {
    expect(fileLabel('a`b<c>|d\n.pdf')).toBe('abcd.pdf');
    expect(fileLabel('x'.repeat(100))).toHaveLength(80);
    expect(fileLabel('')).toBe('file');
  });
  it('slackFileIdFromPermalink is re-exported', () => {
    expect(slackFileIdFromPermalink('https://a.slack.com/files/U1/F9Z/x')).toBe('F9Z');
  });
});
