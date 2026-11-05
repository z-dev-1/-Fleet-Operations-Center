'use strict';
// tests/smoke/justme-libs-main.cjs — T-SMOKE-ELECTRON (design §19, AC-34; round-3 fixes 4, 12, 13).
// Run: npm run test:smoke:electron   (electron tests/smoke/justme-libs-main.cjs, as its own app)
// It does not touch the Fleet app: userData goes to a temp dir and no window is opened.
// Vision is stubbed (never spawns claude). Exits 0 only if every assertion holds.
//
// Checks, in the Electron 42 main process:
//  - process.versions; the real worker forked with utilityProcess.fork exactly as production
//  - app.getAppMetrics() lists the worker pid as type 'Utility' with a numeric workingSetSize
//  - every fixture through two consecutive "gathers" (two worker sessions); both forks use the
//    fixed partition 'jmctx-extract' and session.fromPartition returns the same object (fix 4)
//  - cid.pdf yields 中文 (CMap options work inside the utility process)
//  - bomb.pdf is stopped by the RSS cap, the timer, or an OOM exit (production limits)
//  - heap hog with the production execArgv dies of a V8 heap OOM before 1 GB (fix 12), else
//    HEAP_CAP_NOT_HONORED is printed and the check becomes "killed by RSS cap or timer"
//  - PDF text extraction with require('@napi-rs/canvas') forced to throw (fix 13)
//  - perf: 10 MB XLSX and 20 MB DOCX parse time and peak worker working set

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, utilityProcess, session } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'justme-context');
const SENTINEL = 'SENTINEL-CONTENT-7f3a';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jmctx-smoke-userdata-'));
app.setPath('userData', userData);

const host = require(path.join(ROOT, 'src', 'justme-context', 'extract-host.js'));
const { LIMITS } = require(path.join(ROOT, 'src', 'justme-context', 'constants.js'));
const { makeBombPdf } = require(path.join(FIX, 'make-fixtures.cjs'));

const summary = { versions: {}, checks: {}, failures: [], workerMetric: null, perf: {}, heapCap: null, noCanvas: {}, partition: {} };
const check = (name, ok, detail) => { summary.checks[name] = ok ? 'pass' : 'FAIL' + (detail ? ': ' + detail : ''); if (!ok) summary.failures.push(name); };
const logLines = [];
const logger = { info: (s) => logLines.push(s), warn: (s) => logLines.push(s), error: (s) => logLines.push(s), debug() {} };
const noVision = { readFileWithVision: async () => ({ ok: false, error: 'claude-code not installed' }) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const metricFor = (pid) => app.getAppMetrics().find((m) => m.pid === pid);

// Production fork, wrapped only to record the options and the child.
const forks = [];
const recElectron = {
  app,
  utilityProcess: { fork(file, args, opts) { const child = utilityProcess.fork(file, args, opts); forks.push({ file, opts, child }); return child; } },
};

function peakTracker() {
  let peak = 0;
  const get = (pid) => { const m = metricFor(pid); const v = m && m.memory ? m.memory.workingSetSize * 1024 : undefined; if (v > peak) peak = v; return v; };
  return { get, peak: () => peak };
}

const READABLE = ['text.pdf', 'cid.pdf', 'sample.docx', 'sample.pptx', 'sample.xlsx', 'sample.xls', 'sample.ods', 'sample.csv', 'sample.txt',
  'sample.md', 'sample.json', 'sample.log', 'sample.js', 'sample.html', 'sample.eml', 'sample.msg'];

async function gather(label) {
  const ctx = { deadline: Date.now() + 10 * 60 * 1000, visionLeft: 4 };
  const deps = { electron: recElectron, logger, bedrock: noVision };
  const bad = [];
  try {
    for (const name of READABLE) {
      const item = await host.extractItem({ buffer: fs.readFileSync(path.join(FIX, name)), name }, ctx, deps);
      if (item.status !== 'read' || !item.text.includes(SENTINEL)) bad.push(name + '=' + item.status + '/' + item.reason);
      if (name === 'cid.pdf' && !item.text.includes('中文')) bad.push('cid.pdf missing CJK');
      if (label === 'gather1' && !summary.workerMetric && forks.length) {
        const m = metricFor(forks[forks.length - 1].child.pid);
        summary.workerMetric = m ? { pid: m.pid, type: m.type, name: m.name, serviceName: m.serviceName, workingSetSizeKB: m.memory && m.memory.workingSetSize } : { missing: true, pid: forks[forks.length - 1].child.pid };
      }
    }
    for (const [name, status] of [['encrypted.pdf', 'failed'], ['liar.docx', 'failed'], ['big-ispe.heic', 'failed'], ['tiny.avif', 'unsupported'], ['scanned.pdf', 'failed']]) {
      const item = await host.extractItem({ buffer: fs.readFileSync(path.join(FIX, name)), name }, ctx, deps);
      if (item.status !== status) bad.push(name + '=' + item.status);
    }
  } finally { if (ctx.session) ctx.session.close(); }
  return bad;
}

async function bombRun() {
  const file = path.join(os.tmpdir(), 'jmctx-smoke-bomb-' + process.pid + '.pdf');
  await makeBombPdf(file);
  const ctx = { deadline: Date.now() + 10 * 60 * 1000, visionLeft: 0 };
  const before = logLines.length;
  const t0 = Date.now();
  try {
    const item = await host.extractItem({ buffer: fs.readFileSync(file), name: 'bomb.pdf' }, ctx, { electron: recElectron, logger, bedrock: noVision });
    const killLine = logLines.slice(before).find((l) => /worker killed/.test(l)) || '';
    const how = (killLine.match(/worker killed \S+ (\S+)/) || [])[1] || 'none';
    summary.bomb = { status: item.status, reason: item.reason, killedBy: how, ms: Date.now() - t0 };
    check('bomb.pdf stopped by RSS cap / timer / OOM exit', item.status === 'failed' && ['rss', 'timeout', 'exit'].includes(how), JSON.stringify(summary.bomb));
  } finally { if (ctx.session) ctx.session.close(); try { fs.unlinkSync(file); } catch (_) { /* ignore */ } }
}

function heapHog() {
  return new Promise((resolve) => {
    const child = utilityProcess.fork(path.join(__dirname, 'heap-hog-worker.cjs'), [], {
      serviceName: 'jmctx-heap-hog', execArgv: ['--max-old-space-size=' + LIMITS.WORKER_MAX_HEAP_MB], stdio: 'ignore',
      partition: host.WORKER_PARTITION, env: host.workerEnv(),
    });
    let lastWs = 0, peakWs = 0, killedBy = null;
    const t0 = Date.now();
    const poll = setInterval(() => {
      const m = child.pid && metricFor(child.pid);
      if (m && m.memory) { lastWs = m.memory.workingSetSize * 1024; peakWs = Math.max(peakWs, lastWs); }
      if (lastWs > LIMITS.WORKER_MAX_RSS_BYTES && !killedBy) { killedBy = 'rss'; child.kill(); }
      if (Date.now() - t0 > LIMITS.PARSE_TIMEOUT_MS && !killedBy) { killedBy = 'timer'; child.kill(); }
    }, 100);
    child.on('exit', (code) => {
      clearInterval(poll);
      resolve({ code, killedBy, lastWsMB: Math.round(lastWs / 1048576), peakWsMB: Math.round(peakWs / 1048576), ms: Date.now() - t0 });
    });
  });
}

// Fork the real worker with execArgv --require no-canvas.cjs; return the cid.pdf result + marker.
async function noCanvasRun(mode) {
  const marker = path.join(os.tmpdir(), 'jmctx-no-canvas-' + mode + '-' + process.pid + '.txt');
  try { fs.unlinkSync(marker); } catch (_) { /* ignore */ }
  const execArgv = ['--max-old-space-size=' + LIMITS.WORKER_MAX_HEAP_MB, '--require', path.join(__dirname, 'no-canvas.cjs')];
  const env = Object.assign(host.workerEnv(), { JMCTX_NO_CANVAS_MARKER: marker });
  const workerFile = path.join(ROOT, 'src', 'justme-context', 'extract-worker.js');
  const spawnWorker = mode === 'utility'
    ? () => utilityProcess.fork(workerFile, [], { serviceName: 'jmctx-no-canvas', execArgv, stdio: 'ignore', partition: host.WORKER_PARTITION, env })
    : () => require('child_process').fork(workerFile, [], { execPath: process.execPath, execArgv, env: Object.assign({ ELECTRON_RUN_AS_NODE: '1' }, env), serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const s = host.createWorkerSession({ spawnWorker, logger, getChildRss: () => 1 });
  try {
    const out = {};
    for (const name of ['text.pdf', 'cid.pdf']) {
      const r = await s.extract({ name, mimetype: 'application/pdf', buffer: fs.readFileSync(path.join(FIX, name)) });
      out[name] = { ok: r.ok, needsVision: !!r.needsVision, reason: r.reason || '', hasSentinel: (r.text || '').includes(SENTINEL), hasCjk: (r.text || '').includes('中文') };
    }
    let m = '';
    try { m = fs.readFileSync(marker, 'utf8'); } catch (_) { /* hook not loaded */ }
    out.hookLoaded = m.includes('loaded');
    out.canvasRequireBlocked = m.includes('blocked');
    out.textOk = out['text.pdf'].ok && out['text.pdf'].hasSentinel && !out['text.pdf'].needsVision && out['cid.pdf'].hasCjk;
    return out;
  } finally { s.close(); try { fs.unlinkSync(marker); } catch (_) { /* ignore */ } }
}

async function perf() {
  const XLSX = require('xlsx');
  const JSZip = require('jszip');
  const crypto = require('crypto');
  const xlsxFile = path.join(os.tmpdir(), 'jmctx-perf-' + process.pid + '.xlsx');
  const docxFile = path.join(os.tmpdir(), 'jmctx-perf-' + process.pid + '.docx');
  try {
    const rows = [['a', 'b', 'c', 'd', 'e']];
    for (let i = 0; i < 34000; i++) rows.push([0, 1, 2, 3, 4].map(() => crypto.randomBytes(8).toString('hex')));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Big');
    fs.writeFileSync(xlsxFile, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    const z = new JSZip();
    z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    z.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
    const paras = [];
    let len = 0;
    while (len < 8 * 1024 * 1024) { const t = crypto.randomBytes(600).toString('base64'); paras.push('<w:p><w:r><w:t>' + t + '</w:t></w:r></w:p>'); len += t.length + 40; }
    z.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paras.join('') + '</w:body></w:document>');
    z.file('word/media/blob.bin', crypto.randomBytes(13 * 1024 * 1024), { compression: 'STORE' });
    fs.writeFileSync(docxFile, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    for (const [label, file, name] of [['xlsx10MB', xlsxFile, 'big.xlsx'], ['docx20MB', docxFile, 'big.docx']]) {
      const tr = peakTracker();
      const s = host.createWorkerSession({ electron: recElectron, logger, getChildRss: tr.get });
      const buf = fs.readFileSync(file);
      const t0 = Date.now();
      const r = await s.extract({ name, mimetype: '', buffer: buf });
      summary.perf[label] = { bytes: buf.length, ms: Date.now() - t0, ok: r.ok, reason: r.reason || '', errCode: r.errCode || '', chars: (r.text || '').length, peakWorkingSetMB: Math.round(tr.peak() / 1048576) };
      s.close();
    }
    summary.perf.heic = 'skipped (no HEIC encoder on this machine; see fixtures README)';
  } finally { for (const f of [xlsxFile, docxFile]) { try { fs.unlinkSync(f); } catch (_) { /* ignore */ } } }
}

async function main() {
  summary.versions = { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, v8: process.versions.v8 };

  // Fix 4: two consecutive gathers, same fixed partition, same Session object.
  const s1 = session.fromPartition(host.WORKER_PARTITION);
  const bad1 = await gather('gather1');
  const bad2 = await gather('gather2');
  const s2 = session.fromPartition(host.WORKER_PARTITION);
  check('gather 1: every fixture read in the utility process', bad1.length === 0, bad1.join(', '));
  check('gather 2: every fixture read in the utility process', bad2.length === 0, bad2.join(', '));
  summary.partition = { forks: forks.length, partitions: [...new Set(forks.map((f) => f.opts.partition))], sameSessionObject: s1 === s2 };
  check('fix 4: every fork used partition jmctx-extract', forks.length >= 2 && forks.every((f) => f.opts.partition === 'jmctx-extract'), JSON.stringify(summary.partition));
  check('fix 4: session.fromPartition returns the same object', s1 === s2);
  check('fork options match production', forks.every((f) => f.opts.serviceName === 'fleet-jmctx-extract' && f.opts.stdio === 'ignore' &&
    JSON.stringify(f.opts.execArgv) === JSON.stringify(['--max-old-space-size=512']) && !Object.keys(f.opts.env).some((k) => /TOKEN|SLACK|AWS|FLEET_/i.test(k))));
  const wm = summary.workerMetric || {};
  check('getAppMetrics lists the worker pid as Utility with a numeric workingSetSize', wm.type === 'Utility' && Number.isFinite(wm.workingSetSizeKB), JSON.stringify(wm));

  await bombRun();

  // Fix 12.
  const hog = await heapHog();
  const honored = hog.killedBy === null && hog.code !== 0 && hog.lastWsMB < 1024;
  summary.heapCap = Object.assign({ honored }, hog);
  if (honored) check('fix 12: heap OOM exit before the RSS cap', true);
  else {
    console.log('HEAP_CAP_NOT_HONORED ' + JSON.stringify(hog));
    check('fix 12 fallback: killed by RSS cap or timer', hog.killedBy === 'rss' || hog.killedBy === 'timer', JSON.stringify(hog));
  }

  // Fix 13.
  summary.noCanvas.utility = await noCanvasRun('utility');
  summary.noCanvas.runAsNode = await noCanvasRun('runAsNode');
  check('fix 13: PDF text without @napi-rs/canvas (utilityProcess)', summary.noCanvas.utility.textOk, JSON.stringify(summary.noCanvas.utility));
  check('fix 13: PDF text without @napi-rs/canvas (Node mode, canvas require blocked)', summary.noCanvas.runAsNode.textOk && summary.noCanvas.runAsNode.canvasRequireBlocked, JSON.stringify(summary.noCanvas.runAsNode));

  await perf();
}

const hardStop = setTimeout(() => { console.log('SMOKE TIMEOUT'); console.log(JSON.stringify(summary, null, 2)); app.exit(1); }, 5 * 60 * 1000);

app.whenReady().then(main).then(() => {
  clearTimeout(hardStop);
  console.log('JMCTX_SMOKE_SUMMARY ' + JSON.stringify(summary, null, 2));
  console.log(summary.failures.length ? 'SMOKE FAILED: ' + summary.failures.join('; ') : 'SMOKE OK');
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  app.exit(summary.failures.length ? 1 : 0);
}).catch((e) => {
  console.log('SMOKE ERROR ' + (e && (e.code || e.name)) + ' ' + (e && e.stack));
  console.log(JSON.stringify(summary, null, 2));
  app.exit(1);
});
