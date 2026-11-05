'use strict';
// tests/fixtures/justme-context/make-fixtures.cjs — generates the committed fixtures for
// the Just Me context reader (design §19). Run:
//   node tests/fixtures/justme-context/make-fixtures.cjs
// It is idempotent: the clock is frozen while generating, so re-running yields
// byte-identical files (sha256 values are recorded in README.md, which this script
// also rewrites). Every text-bearing fixture contains SENTINEL-CONTENT-7f3a.
//
// NOT generated here (no encoder on this machine): tiny.heic and perf-12mp.heic. HEIC
// coverage uses crafted ISOBMFF headers (big-ispe, noispe, ok-ispe) plus an injected
// heicConvert. bomb.pdf is generated at TEST time (makeBombPdf) into os.tmpdir().

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const OUT = __dirname;
const SENTINEL = 'SENTINEL-CONTENT-7f3a';

// ── helpers ──────────────────────────────────────────────────────────────

function freezeClock() {
  const Real = Date;
  const fixed = new Real('2026-01-01T00:00:00Z').getTime();
  global.Date = class extends Real {
    constructor(...a) { if (a.length) super(...a); else super(fixed); }
    static now() { return fixed; }
  };
  return () => { global.Date = Real; };
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

// ── PDF building ─────────────────────────────────────────────────────────

function buildPdf(objects, trailerExtra) {
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [];
  let pos = parts[0].length;
  objects.forEach((o, i) => {
    offsets.push(pos);
    const body = Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1');
    const b = Buffer.concat([Buffer.from((i + 1) + ' 0 obj\n', 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(b);
    pos += b.length;
  });
  const xrefPos = pos;
  let xref = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const o of offsets) xref += String(o).padStart(10, '0') + ' 00000 n \n';
  parts.push(Buffer.from(xref + 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R ' + (trailerExtra || '') + ' >>\nstartxref\n' + xrefPos + '\n%%EOF\n', 'latin1'));
  return Buffer.concat(parts);
}

const stream = (dict, data) => Buffer.concat([Buffer.from('<< ' + dict + ' /Length ' + data.length + ' >>\nstream\n', 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);

const FILLER = 'This fixture is a one page PDF used by the Just Me context reader tests. It holds enough ordinary text that it is not treated as a scanned document.';

function textPdf() {
  const content = Buffer.from('BT /F1 12 Tf 72 720 Td (' + SENTINEL + ') Tj 0 -16 Td (' + FILLER + ') Tj ET', 'latin1');
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    stream('', content),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

function scannedPdf() {
  const content = Buffer.from('q 612 0 0 792 0 0 cm /Im1 Do Q', 'latin1');
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>',
    stream('', content),
    stream('/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8', Buffer.from([0x80])),
  ]);
}

function cidPdf() {
  const content = Buffer.from('BT /F2 24 Tf 72 700 Td <4E2D6587> Tj /F1 12 Tf 0 -30 Td (' + SENTINEL + ') Tj 0 -16 Td (' + FILLER + ') Tj ET', 'latin1');
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    stream('', content),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [7 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 5 >> /FontDescriptor 8 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>',
  ]);
}

// RC4 (OpenSSL 3 in Node 24 does not ship it by default).
function rc4(key, data) {
  const S = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; [S[i], S[j]] = [S[j], S[i]]; }
  const out = Buffer.alloc(data.length);
  let a = 0, b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 255; b = (b + S[a]) & 255; [S[a], S[b]] = [S[b], S[a]];
    out[k] = data[k] ^ S[(S[a] + S[b]) & 255];
  }
  return out;
}

// Standard Security Handler, revision 2 (RC4 40-bit), non-empty user password.
// Algorithms 2, 3 and 4 of PDF 1.7 §7.6.3.
function encryptedPdf() {
  const md5 = (b) => crypto.createHash('md5').update(b).digest();
  const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
  const padU = Buffer.concat([Buffer.from('jmctx-user-password'), PAD]).subarray(0, 32);
  const O = rc4(md5(padU).subarray(0, 5), padU);                         // Alg. 3, owner pw = user pw
  const P = Buffer.alloc(4); P.writeInt32LE(-4);
  const ID = md5(Buffer.from('jmctx-fixture-id'));
  const key = md5(Buffer.concat([padU, O, P, ID])).subarray(0, 5);       // Alg. 2
  const U = rc4(key, PAD);                                               // Alg. 4
  const objKey = (n) => md5(Buffer.concat([key, Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])])).subarray(0, 10);
  const content = rc4(objKey(4), Buffer.from('BT /F1 12 Tf 72 720 Td (' + SENTINEL + ') Tj ET', 'latin1'));
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    stream('', content),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Filter /Standard /V 1 /R 2 /O <' + O.toString('hex') + '> /U <' + U.toString('hex') + '> /P -4 >>',
  ], '/Encrypt 6 0 R /ID [<' + ID.toString('hex') + '> <' + ID.toString('hex') + '>]');
}

// Used by tests at run time (not committed): one page whose content stream inflates
// to `bytes` of spaces. Streaming deflate keeps the generator small.
// One 16 MB block of spaces is deflated once with a FULL flush (byte aligned, no
// back-references across blocks), repeated, closed with an empty final block, and
// given the zlib header and the Adler-32 of the whole run (computed in closed form).
// That keeps generation well under a second instead of deflating 3 GB.
const BOMB_BLOCK = 16 * 1024 * 1024;
function bombStream(blocks) {
  const piece = zlib.deflateRawSync(Buffer.alloc(BOMB_BLOCK, 0x20), { finishFlush: zlib.constants.Z_FULL_FLUSH });
  const n = BigInt(blocks) * BigInt(BOMB_BLOCK), c = 0x20n, M = 65521n;
  const a = (1n + n * c) % M;
  const b = (n + c * ((n * (n + 1n)) / 2n)) % M;
  const adler = Buffer.alloc(4); adler.writeUInt32BE(Number((b << 16n) | a));
  const parts = [Buffer.from([0x78, 0x9c])];
  for (let i = 0; i < blocks; i++) parts.push(piece);
  parts.push(Buffer.from([0x03, 0x00]), adler);
  return Buffer.concat(parts);
}

async function makeBombPdf(outPath, bytes) {
  const total = bytes || 3 * 1024 * 1024 * 1024;
  const data = bombStream(Math.max(1, Math.round(total / BOMB_BLOCK)));
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>',
    stream('/Filter /FlateDecode', data),
  ];
  fs.writeFileSync(outPath, buildPdf(objs));
  return outPath;
}

// ── ZIP / Office ─────────────────────────────────────────────────────────

// Hand-written zip so the crafted (hostile) variants can lie about sizes.
// entries: [{ name, comp:Buffer, method, size:declared uncompressed, flags?, crc? }]
function rawZip(entries, opts) {
  opts = opts || {};
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'latin1');
    const lh = Buffer.concat([u32(0x04034b50), u16(20), u16(e.flags || 0), u16(e.method), u16(0), u16(0x21), u32(e.crc || 0), u32(e.comp.length), u32(e.size), u16(name.length), u16(0), name, e.comp]);
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(e.flags || 0), u16(e.method), u16(0), u16(0x21), u32(e.crc || 0), u32(e.comp.length), u32(e.size), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off), name]));
    locals.push(lh);
    off += lh.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(opts.zip64 ? 0xffff : entries.length), u16(opts.zip64 ? 0xffff : entries.length), u32(opts.zip64 ? 0xffffffff : cd.length), u32(opts.zip64 ? 0xffffffff : off), u16(0)]);
  return Buffer.concat([...locals, cd, eocd]);
}

const deflateRaw = (b) => zlib.deflateRawSync(b);
const ctypes = (extra) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + extra + '</Types>';

async function docx() {
  const JSZip = require('jszip');
  const z = new JSZip();
  z.file('[Content_Types].xml', ctypes('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'));
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  z.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + SENTINEL + '</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph of the sample document.</w:t></w:r></w:p></w:body></w:document>');
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' });
}

async function pptx() {
  const JSZip = require('jszip');
  const z = new JSZip();
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  z.file('[Content_Types].xml', ctypes('<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'));
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');
  z.file('ppt/presentation.xml', '<?xml version="1.0" encoding="UTF-8"?><p:presentation ' + A + '/>');
  z.file('ppt/slides/slide1.xml', '<?xml version="1.0" encoding="UTF-8"?><p:sld ' + A + '><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>' + SENTINEL + '</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');
  z.file('ppt/slides/slide2.xml', '<?xml version="1.0" encoding="UTF-8"?><p:sld ' + A + '><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Second slide &amp; more</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');
  z.file('ppt/notesSlides/notesSlide1.xml', '<?xml version="1.0" encoding="UTF-8"?><p:notes ' + A + '><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>speaker note text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>');
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' });
}

function sheets() {
  const XLSX = require('xlsx');
  const mk = () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['unit', 'note'], ['320160', SENTINEL], ['208336', 'second row']]), 'Fleet');
    return wb;
  };
  return {
    xlsx: XLSX.write(mk(), { type: 'buffer', bookType: 'xlsx' }),
    xls: XLSX.write(mk(), { type: 'buffer', bookType: 'biff8' }),
    ods: XLSX.write(mk(), { type: 'buffer', bookType: 'ods' }),
  };
}

// ── CFB (.msg) ───────────────────────────────────────────────────────────

const utf16 = (s) => Buffer.from(s, 'utf16le');

function sampleMsg() {
  const XLSX = require('xlsx');
  const C = XLSX.CFB;
  const cfb = C.utils.cfb_new();
  C.utils.cfb_add(cfb, '/__properties_version1.0', Buffer.alloc(32));
  C.utils.cfb_add(cfb, '/__substg1.0_0037001F', utf16('Sample subject'));
  C.utils.cfb_add(cfb, '/__substg1.0_1000001F', utf16('Body text ' + SENTINEL));
  C.utils.cfb_add(cfb, '/__substg1.0_0C1A001F', utf16('Sender Name'));
  C.utils.cfb_add(cfb, '/__substg1.0_0042001F', utf16('Sender Name'));
  return Buffer.from(C.write(cfb, { type: 'buffer' }));
}

// Patch the FAT so the first directory sector points at itself (cycle 1) or at the
// next sector which points back (cycle 2). Sector size 512 (CFB v3) assumed.
function cyclicCfb(src, variant) {
  const b = Buffer.from(src);
  if (b.readUInt16LE(0x1e) !== 9) throw new Error('expected 512-byte sectors');
  const fatSect = b.readUInt32LE(0x4c);                     // DIFAT[0]
  const dirStart = b.readUInt32LE(0x30);
  const fatAt = (sect) => (fatSect + 1) * 512 + sect * 4;
  if (variant === 1) b.writeUInt32LE(dirStart, fatAt(dirStart));
  else { b.writeUInt32LE(dirStart + 1, fatAt(dirStart)); b.writeUInt32LE(dirStart, fatAt(dirStart + 1)); }
  return b;
}

// ── ISOBMFF / images ─────────────────────────────────────────────────────

const box = (type, ...payload) => { const p = Buffer.concat(payload); return Buffer.concat([be32(8 + p.length), Buffer.from(type, 'latin1'), p]); };
const fullBox = (type, ...payload) => box(type, be32(0), ...payload);
const ftyp = (major, compat) => box('ftyp', Buffer.from(major, 'latin1'), be32(0), ...compat.map((c) => Buffer.from(c, 'latin1')));
const heicWith = (w, h) => Buffer.concat([ftyp('heic', ['mif1', 'heic']), box('meta', be32(0), box('iprp', box('ipco', fullBox('ispe', be32(w), be32(h)))))]);

const B64 = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  jpg: '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  gif: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  webp: 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
};

// ── main ─────────────────────────────────────────────────────────────────

async function generate() {
  const restore = freezeClock();
  const files = {};
  try {
    files['text.pdf'] = textPdf();
    files['scanned.pdf'] = scannedPdf();
    files['encrypted.pdf'] = encryptedPdf();
    files['cid.pdf'] = cidPdf();
    files['sample.docx'] = await docx();
    files['sample.pptx'] = await pptx();
    const s = sheets();
    files['sample.xlsx'] = s.xlsx; files['sample.xls'] = s.xls; files['sample.ods'] = s.ods;
    files['sample.csv'] = Buffer.from('unit,note\n320160,' + SENTINEL + '\n208336,second row\n');
    files['sample.txt'] = Buffer.from('Plain text fixture ' + SENTINEL + '\n');
    files['sample.md'] = Buffer.from('# Heading\n\n' + SENTINEL + '\n');
    files['sample.json'] = Buffer.from('{"note":"' + SENTINEL + '"}\n');
    files['sample.log'] = Buffer.from('2026-01-01 INFO ' + SENTINEL + '\n');
    files['sample.js'] = Buffer.from('// ' + SENTINEL + '\nmodule.exports = 1;\n');
    files['sample.html'] = Buffer.from('<!DOCTYPE html><html><head><title>Fixture page</title><meta name="description" content="Short description"><style>p{color:red}</style><script>var hidden="not text";</script></head><body><h1>Heading</h1><p>' + SENTINEL + ' &amp; more</p><!-- comment --></body></html>');
    files['sample.eml'] = Buffer.from([
      'From: Sender Example <sender@example.com>', 'To: Recipient <recipient@example.com>', 'Subject: Sample email', 'Date: Thu, 01 Jan 2026 00:00:00 +0000',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="BOUND"', '',
      '--BOUND', 'Content-Type: text/plain; charset=utf-8', '', 'Body text ' + SENTINEL, '',
      '--BOUND', 'Content-Type: text/plain; name="note.txt"', 'Content-Disposition: attachment; filename="note.txt"', 'Content-Transfer-Encoding: base64', '', Buffer.from('attachment body').toString('base64'), '',
      '--BOUND--', ''].join('\r\n'));
    for (const k of Object.keys(B64)) files['tiny.' + k] = Buffer.from(B64[k], 'base64');
    // Hostile / crafted containers.
    const xml = Buffer.from('<?xml version="1.0"?><w:document xmlns:w="x"><w:body/></w:document>');
    const okEntry = { name: 'word/document.xml', comp: deflateRaw(xml), method: 8, size: xml.length };
    files['bomb.docx'] = rawZip([{ name: 'word/document.xml', comp: deflateRaw(Buffer.from('x')), method: 8, size: 200 * 1024 * 1024 }]);
    files['liar.docx'] = rawZip([{ name: 'word/document.xml', comp: deflateRaw(Buffer.alloc(200 * 1024 * 1024)), method: 8, size: 1024 }]);
    files['zip64.docx'] = rawZip([okEntry], { zip64: true });
    files['dupe.docx'] = rawZip([okEntry, okEntry]);
    files['badmethod.docx'] = rawZip([{ name: 'word/document.xml', comp: Buffer.from('x'), method: 12, size: 1 }]);
    // HEIC / AVIF headers (no image data).
    files['big-ispe.heic'] = heicWith(8064, 6048);
    files['ok-ispe.heic'] = heicWith(100, 100);
    files['noispe.heic'] = Buffer.concat([ftyp('heic', ['mif1', 'heic']), box('meta', be32(0), box('iprp', box('ipco')))]);
    files['tiny.avif'] = Buffer.concat([ftyp('avif', ['mif1', 'avif', 'miaf']), box('meta', be32(0))]);
    files['unknown.bin'] = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x7f, 0x00, 0x10, 0x20, 0x00]);
    // Outlook message and cyclic variants.
    const msg = sampleMsg();
    files['sample.msg'] = msg;
    files['cyclic.msg'] = cyclicCfb(msg, 1);
    files['cyclic2.msg'] = cyclicCfb(msg, 2);
    files['cyclic.xls'] = cyclicCfb(s.xls, 1);
    files['cyclic2.xls'] = cyclicCfb(s.xls, 2);
  } finally { restore(); }
  return files;
}

async function main() {
  const files = await generate();
  const lines = [];
  for (const name of Object.keys(files).sort()) {
    fs.writeFileSync(path.join(OUT, name), files[name]);
    lines.push('| `' + name + '` | ' + files[name].length + ' | `' + crypto.createHash('sha256').update(files[name]).digest('hex') + '` |');
  }
  const readme = [
    '# Just Me context reader fixtures',
    '',
    'Generated by `node tests/fixtures/justme-context/make-fixtures.cjs` (idempotent: the clock is frozen, so a re-run reproduces these bytes).',
    'Every text-bearing fixture contains `' + SENTINEL + '`. All files are our own synthetic data; there is no third-party content.',
    '',
    '## Not committed',
    '',
    '- `bomb.pdf`: generated at test time into `os.tmpdir()` by `makeBombPdf` (exported from `make-fixtures.cjs`).',
    '- `tiny.heic`, `perf-12mp.heic`: no HEIC encoder exists on the build machine (no `magick`, `heif-enc`, `ffmpeg`, `python`). HEIC coverage uses the crafted',
    '  ISOBMFF headers below plus an injected `heicConvert`. The real HEIC decode-to-JPEG check is part of the manual live check.',
    '',
    '## Crafted fixtures',
    '',
    '- `bomb.docx`: central directory declares a 200 MB XML entry. `liar.docx`: declares 1 KB, inflates to 200 MB of zeros (~200 KB compressed).',
    '  `zip64.docx`: ZIP64 markers. `dupe.docx`: duplicate entry names. `badmethod.docx`: compression method 12.',
    '- `big-ispe.heic` (8064x6048 `ispe`), `ok-ispe.heic` (100x100), `noispe.heic`, `tiny.avif`: headers only, no image data.',
    '- `cyclic.msg`/`cyclic.xls` (FAT self-loop on the first directory sector) and `cyclic2.*` (two-sector cycle).',
    '- `encrypted.pdf`: Standard Security Handler R2 (RC4 40-bit), user password set, so pdfjs throws `PasswordException`.',
    '- `cid.pdf`: Type0 font, predefined CMap `UniGB-UCS2-H`, no embedded font; text `中文` must come out (proves the CMap options).',
    '',
    '## sha256',
    '',
    '| file | bytes | sha256 |',
    '|---|---|---|',
    ...lines,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'README.md'), readme);
  console.log('wrote ' + lines.length + ' fixtures + README.md');
}

module.exports = { makeBombPdf, bombStream, generate, SENTINEL };

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
