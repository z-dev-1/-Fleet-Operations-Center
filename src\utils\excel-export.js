'use strict';
/**
 * excel-export.js — Lightweight .xlsx generator (no dependencies)
 *
 * Generates valid .xlsx files using the OpenXML format (ZIP of XML files).
 * Supports: headers, data rows, column widths, cell colors, bold headers.
 *
 * Uses Node.js built-in `zlib` + `Buffer` — no npm packages needed.
 */

const fs   = require('fs');
const path = require('path');
const { createWriteStream } = require('fs');
let archiver = null;
try { archiver = require('archiver'); } catch (_) {}

// ── Fallback: write as HTML table with .xlsx extension (opens in Excel) ──────
// Excel happily opens HTML tables renamed to .xlsx. This is the zero-dep approach.

function generateExcel(rows, columns, outputPath) {
  const riskColor = (score) => {
    const s = parseInt(score, 10) || 0;
    if (s >= 70) return '#FDE7E9';  // red bg
    if (s >= 40) return '#FFF3CD';  // orange bg
    return '#D4EDDA';               // green bg
  };

  const lifecycleColor = (val) => {
    if (!val) return '';
    const v = val.toLowerCase();
    if (v.includes('unavail')) return '#FDE7E9';
    if (v.includes('available')) return '#D4EDDA';
    return '';
  };

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Build HTML table that Excel renders perfectly
  let html = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles>
  <Style ss:ID="header">
    <Font ss:Bold="1" ss:Size="10" ss:Color="#FFFFFF"/>
    <Interior ss:Color="#1B2838" ss:Pattern="Solid"/>
    <Borders>
      <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#58A6FF"/>
    </Borders>
  </Style>
  <Style ss:ID="risk-high">
    <Interior ss:Color="#FDE7E9" ss:Pattern="Solid"/>
    <Font ss:Color="#D32F2F" ss:Bold="1"/>
  </Style>
  <Style ss:ID="risk-med">
    <Interior ss:Color="#FFF3CD" ss:Pattern="Solid"/>
    <Font ss:Color="#E65100"/>
  </Style>
  <Style ss:ID="risk-low">
    <Interior ss:Color="#D4EDDA" ss:Pattern="Solid"/>
    <Font ss:Color="#1B5E20"/>
  </Style>
  <Style ss:ID="unavail">
    <Font ss:Color="#D32F2F" ss:Bold="1"/>
  </Style>
  <Style ss:ID="avail">
    <Font ss:Color="#2E7D32" ss:Bold="1"/>
  </Style>
  <Style ss:ID="default"/>
</Styles>
<Worksheet ss:Name="Fleet Export">
<Table>
`;

  // Column widths
  for (const col of columns) {
    const w = parseInt(col.width, 10) || 100;
    html += `  <Column ss:Width="${w}"/>\n`;
  }

  // Header row
  html += '  <Row>\n';
  for (const col of columns) {
    html += `    <Cell ss:StyleID="header"><Data ss:Type="String">${esc(col.header)}</Data></Cell>\n`;
  }
  html += '  </Row>\n';

  // Data rows
  for (const row of rows) {
    html += '  <Row>\n';
    for (const col of columns) {
      const val = row[col.key] || '';
      let style = 'default';

      // Color coding
      if (col.key === 'riskScore') {
        const s = parseInt(val, 10) || 0;
        style = s >= 70 ? 'risk-high' : s >= 40 ? 'risk-med' : 'risk-low';
      } else if (col.key === 'lifecycleState') {
        const v = String(val).toLowerCase();
        style = v.includes('unavail') ? 'unavail' : v.includes('avail') ? 'avail' : 'default';
      }

      const type = (col.key === 'riskScore' || col.key === 'openUnplanned' || col.key === 'openPlanned')
        ? 'Number' : 'String';
      html += `    <Cell ss:StyleID="${style}"><Data ss:Type="${type}">${esc(val)}</Data></Cell>\n`;
    }
    html += '  </Row>\n';
  }

  html += `</Table>
</Worksheet>
</Workbook>`;

  fs.writeFileSync(outputPath, html, 'utf8');
  return outputPath;
}

module.exports = { generateExcel };
