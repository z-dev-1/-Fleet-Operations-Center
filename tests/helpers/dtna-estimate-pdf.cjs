'use strict';
// A one-page text PDF built in memory for the DTNA estimate tests (same approach as
// tests/fixtures/justme-context/make-fixtures.cjs buildPdf: Helvetica, one Tj per line).
// Lines are escaped for a PDF string literal; keep the total text over 100 chars so it is not "scanned".

function buildPdf(objects) {
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
  parts.push(Buffer.from(xref + 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n', 'latin1'));
  return Buffer.concat(parts);
}

const stream = (data) => Buffer.concat([Buffer.from('<< /Length ' + data.length + ' >>\nstream\n', 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

const DEFAULT_LINES = [
  'Dealer estimate E101048154',
  'Freightliner of Testville - repair estimate for unit 122269',
  'Brake chamber 30/30 P/N K123-456  $245.10',
  'Slack adjuster P/N SA-7781  $120.00',
  'Labor 2.5 hrs  $312.50',
  'Shop supplies  $25.00',
  'Parts Total  $365.10',
  'Labor Total  $312.50',
  'Grand Total  $1,234.56',
];

const PAGE_LINES = 40;

/** makeEstimatePdf(lines?) -> Buffer (one page per PAGE_LINES lines) */
function makeEstimatePdf(lines) {
  const ls = Array.isArray(lines) && lines.length ? lines : DEFAULT_LINES;
  const pages = [];
  for (let i = 0; i < ls.length; i += PAGE_LINES) pages.push(ls.slice(i, i + PAGE_LINES));
  // Objects: 1 catalog, 2 pages, 3 font, then per page: page object + content stream.
  const kids = pages.map((_, p) => (4 + p * 2) + ' 0 R').join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [' + kids + '] /Count ' + pages.length + ' >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((pl, p) => {
    const ops = ['BT /F1 11 Tf 72 740 Td'];
    pl.forEach((l, i) => { ops.push((i ? '0 -18 Td ' : '') + '(' + esc(l) + ') Tj'); });
    ops.push('ET');
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ' + (5 + p * 2) + ' 0 R /Resources << /Font << /F1 3 0 R >> >> >>');
    objects.push(stream(Buffer.from(ops.join('\n'), 'latin1')));
  });
  return buildPdf(objects);
}

module.exports = { makeEstimatePdf, DEFAULT_LINES };
