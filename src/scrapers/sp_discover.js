'use strict';
/**
 * sp_discover.js — Discover sheets + auto-detect header row from SharePoint Excel files
 * 
 * 1. Takes a SharePoint Excel URL or path
 * 2. Downloads the .xlsx
 * 3. Parses zip → reads xl/workbook.xml for sheet names
 * 4. Scans each sheet for header row (looks for known column patterns)
 */

const { BrowserWindow, session } = require('electron');
const logger = require('../utils/logger').createLogger('sp-discover');

const SP_ORIGIN = 'https://amazon.sharepoint.com';

// The REAL data-table header signature — the exact column titles of the
// tracker's data grid. Detection scores a row by how many of these it matches,
// so the fixed dashboard/summary block at the top of the sheet (which only has
// generic words like "CARRIER" / "In Service") can never outscore the true
// header band. "Distinctive" titles are ones that only appear in the real
// header (never in the summary block) — matching several of these is a strong,
// unambiguous signal we've found the right row.
const HEADER_TITLES = [
  'carrier', 'unit number', 'body type', 'make', 'lifecycle state',
  'repair status', 'primary component', 'relay garage', 'offsite shop event',
  'salesforce case', 'repair updates', 'assigned vendor', 'date downed',
  'days unavailable',
];
// Titles that do NOT appear in the top summary/dashboard block — matching these
// is the clincher that this is the data-table header, not a summary header.
const DISTINCTIVE_TITLES = [
  'unit number', 'body type', 'lifecycle state', 'repair status',
  'primary component', 'relay garage', 'offsite shop event', 'salesforce case',
  'repair updates', 'date downed', 'days unavailable',
];

/**
 * Extract server-relative file path from various SharePoint URL formats
 */
function extractFilePath(url) {
  // Format: https://amazon.sharepoint.com/:x:/r/sites/AFP-FAS/_layouts/15/Doc.aspx?sourcedoc=...&file=Name.xlsx
  const fileMatch = url.match(/[&?]file=([^&]+)/i);
  const siteMatch = url.match(/\/sites\/([^/]+)/);
  
  if (fileMatch && siteMatch) {
    const fileName = decodeURIComponent(fileMatch[1]);
    const site = siteMatch[1];
    // Try to extract folder from URL
    const folderMatch = url.match(/sourcedoc=%7B[^}]+%7D/i);
    // We need the actual path — try common locations
    return { site: '/sites/' + site, fileName, needsSearch: true };
  }

  // Format: /sites/AFP-FAS/Shared Documents/folder/file.xlsx
  if (url.includes('/sites/') && url.endsWith('.xlsx')) {
    const sitePart = url.match(/(\/sites\/[^/]+)/);
    return { site: sitePart ? sitePart[1] : '/sites/AFP-FAS', filePath: url, fileName: url.split('/').pop() };
  }

  // Format: full URL with path
  const pathMatch = url.match(/sharepoint\.com(\/sites\/[^?#]+\.xlsx)/i);
  if (pathMatch) {
    const fullPath = decodeURIComponent(pathMatch[1]);
    const sitePart = fullPath.match(/(\/sites\/[^/]+)/);
    return { site: sitePart ? sitePart[1] : '/sites/AFP-FAS', filePath: fullPath, fileName: fullPath.split('/').pop() };
  }

  return { error: 'Could not parse SharePoint URL. Paste a direct link to an .xlsx file.' };
}

/**
 * Search for a file by name on the SharePoint site
 */
async function findFileOnSite(win, site, fileName) {
  const searchUrl = SP_ORIGIN + site + "/_api/web/GetFolderByServerRelativeUrl('" + site + "/Shared Documents')/Files?$filter=Name eq '" + fileName.replace(/'/g, "''") + "'&$select=ServerRelativeUrl,Name";
  
  let result = await win.webContents.executeJavaScript(`
    fetch("${searchUrl}", { credentials: 'include', headers: { 'Accept': 'application/json;odata=verbose' } })
      .then(r => r.json())
      .then(d => d.d && d.d.results ? d.d.results.map(f => f.ServerRelativeUrl) : [])
      .catch(e => ({ error: e.message }))
  `);

  if (result && result.length) return result[0];

  // Try recursive search
  const searchUrl2 = SP_ORIGIN + site + "/_api/search/query?querytext='" + encodeURIComponent(fileName) + "'&selectproperties='Path,Title'&rowlimit=5";
  result = await win.webContents.executeJavaScript(`
    fetch("${searchUrl2}", { credentials: 'include', headers: { 'Accept': 'application/json;odata=verbose' } })
      .then(r => r.json())
      .then(d => {
        const rows = d.d && d.d.query && d.d.query.PrimaryQueryResult && d.d.query.PrimaryQueryResult.RelevantResults && d.d.query.PrimaryQueryResult.RelevantResults.Table && d.d.query.PrimaryQueryResult.RelevantResults.Table.Rows && d.d.query.PrimaryQueryResult.RelevantResults.Table.Rows.results;
        if (!rows) return [];
        return rows.map(r => {
          const cells = r.Cells && r.Cells.results;
          const pathCell = cells && cells.find(c => c.Key === 'Path');
          return pathCell ? pathCell.Value : null;
        }).filter(Boolean);
      })
      .catch(e => ({ error: e.message }))
  `);

  if (result && result.length) {
    const match = result.find(p => p.includes('.xlsx'));
    if (match) {
      const relative = match.replace(SP_ORIGIN, '');
      return relative;
    }
  }

  return null;
}

/**
 * Download xlsx and extract sheet names
 */
async function discoverSheets(win, filePath) {
  // Extract site from filePath (e.g. /sites/AFP-FAS/...) for proper API scope
  const siteMatch = filePath.match(/(\/sites\/[^/]+)/);
  const siteScope = siteMatch ? siteMatch[1] : '';
  const fileUrl = SP_ORIGIN + siteScope + "/_api/web/getfilebyserverrelativeurl('" + encodeURI(filePath).replace(/'/g, "''") + "')/$value";
  
  // Download as base64
  const b64 = await win.webContents.executeJavaScript(`
    fetch("${fileUrl}", { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(buf => {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      })
      .catch(e => ({ error: e.message }))
  `);

  if (b64 && b64.error) return { error: b64.error };
  if (!b64 || typeof b64 !== 'string') return { error: 'Download returned empty' };

  // Parse xlsx (zip) to find sheet names from xl/workbook.xml
  const buf = Buffer.from(b64, 'base64');
  const sheets = parseXlsxSheets(buf);
  
  if (!sheets.length) return { error: 'No sheets found in workbook' };

  // For each sheet, try to detect header row
  const sheetDetails = [];
  for (const sheet of sheets) {
    const headerRow = detectHeaderRow(buf, sheet.sheetId);
    sheetDetails.push({ name: sheet.name, sheetId: sheet.sheetId, xmlFile: sheet.xmlFile, headerRow });
  }

  return { ok: true, sheets: sheetDetails, filePath };
}

/**
 * Parse xlsx zip → extract sheet names from xl/workbook.xml
 */
function parseXlsxSheets(buf) {
  const entries = unzipEntries(buf);
  const wbEntry = entries.find(e => e.name === 'xl/workbook.xml');
  if (!wbEntry) return [];

  const xml = wbEntry.data.toString('utf8');
  const sheets = [];
  
  // Parse sheet elements
  const regex = /<sheet\s+name="([^"]+)"[^>]*sheetId="(\d+)"[^>]*r:id="([^"]+)"/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    sheets.push({ name: m[1], sheetId: m[2], rId: m[3] });
  }
  
  if (!sheets.length) {
    const simpleRegex = /<sheet[^>]+name="([^"]+)"/g;
    let idx = 1;
    while ((m = simpleRegex.exec(xml)) !== null) {
      sheets.push({ name: m[1], sheetId: String(idx), rId: 'rId' + idx });
      idx++;
    }
  }

  // Parse relationships to map rId → actual XML filename
  const relsEntry = entries.find(e => e.name === 'xl/_rels/workbook.xml.rels');
  const relsMap = {};
  if (relsEntry) {
    const relsXml = relsEntry.data.toString('utf8');
    const relRegex = /<Relationship\s+Id="([^"]+)"[^>]*Target="([^"]+)"/g;
    while ((m = relRegex.exec(relsXml)) !== null) {
      relsMap[m[1]] = m[2]; // e.g. rId1 → worksheets/sheet1.xml
    }
  }

  // Map each sheet to its XML file
  sheets.forEach((s, i) => {
    const target = relsMap[s.rId];
    if (target && target.includes('worksheets/')) {
      // Extract "sheet1", "sheet2" etc from "worksheets/sheet1.xml"
      const match = target.match(/worksheets\/(sheet\d+)\.xml/i);
      s.xmlFile = match ? match[1] : 'sheet' + (i + 1);
    } else {
      s.xmlFile = 'sheet' + (i + 1);
    }
  });

  return sheets;
}


/**
 * Detect header row by scanning shared strings for known keywords
 */
function detectHeaderRow(buf, sheetId) {
  try {
    const entries = unzipEntries(buf);

    // Shared strings (index -> lowercased text).
    const strings = [];
    const ssEntry = entries.find(e => e.name === 'xl/sharedStrings.xml');
    if (ssEntry) {
      const ssXml = ssEntry.data.toString('utf8');
      // Each <si> may hold a single <t> or multiple <r><t> runs — join runs.
      const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
      let sm;
      while ((sm = siRegex.exec(ssXml)) !== null) {
        const parts = [];
        const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g; let tm;
        while ((tm = tRe.exec(sm[1])) !== null) parts.push(tm[1]);
        strings.push(parts.join('')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .toLowerCase().replace(/\s+/g, ' ').trim());
      }
    }

    const sheetFile = 'xl/worksheets/sheet' + sheetId + '.xml';
    const sheetEntry = entries.find(e => e.name === sheetFile);
    if (!sheetEntry) return 16;
    const sheetXml = sheetEntry.data.toString('utf8');

    // Resolve every cell's text in a row, whether it's a shared string
    // (t="s" -> <v>index</v>) or an inline string (<is><t>..</t></is>). The
    // OLD detector only read shared strings, so inline-string header rows (like
    // this tracker's real header band) scored 0 and the summary row won.
    function rowTexts(cellsXml) {
      const out = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      while ((cm = cellRe.exec(cellsXml)) !== null) {
        const attrs = cm[1] || '';
        const inner = cm[2] || '';
        const t = (attrs.match(/\bt="([^"]+)"/) || [])[1] || '';
        if (t === 's') {
          const vm = inner.match(/<v>(\d+)<\/v>/);
          if (vm) out.push(strings[parseInt(vm[1], 10)] || '');
        } else {
          // inline string or plain: gather any <t> text
          const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g; let tm; const parts = [];
          while ((tm = tRe.exec(inner)) !== null) parts.push(tm[1]);
          if (parts.length) {
            out.push(parts.join('')
              .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
              .toLowerCase().replace(/\s+/g, ' ').trim());
          }
        }
      }
      return out;
    }

    const rowRegex = /<row\s+r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
    let bestRow = -1, bestScore = 0, bestDistinct = 0;
    let m;
    while ((m = rowRegex.exec(sheetXml)) !== null) {
      const rowNum = parseInt(m[1], 10);
      if (rowNum > 40) break; // headers are always near the top
      const cellText = rowTexts(m[2]);

      // Score: count matched column titles. A title matches if any cell text
      // equals it or contains it (handles "# DAYS UNAVAILABLE" vs "days unavailable").
      let score = 0, distinct = 0;
      for (const title of HEADER_TITLES) {
        if (cellText.some(v => v === title || v.includes(title))) score++;
      }
      for (const title of DISTINCTIVE_TITLES) {
        if (cellText.some(v => v === title || v.includes(title))) distinct++;
      }

      // Prefer the row with the most DISTINCTIVE matches (tie-break on total).
      // Distinctive titles never appear in the top summary block, so this is
      // what separates the true data-table header from the dashboard header.
      if (distinct > bestDistinct || (distinct === bestDistinct && score > bestScore)) {
        bestDistinct = distinct;
        bestScore = score;
        bestRow = rowNum;
      }
    }

    // Only trust the detection if we matched several distinctive titles — that
    // confirms it's the real header band. Otherwise fall back to the common
    // default (16) rather than risk picking a summary row.
    if (bestRow > 0 && bestDistinct >= 3) {
      logger.info('[sp-discover] header row for sheet' + sheetId + ' = ' + bestRow + ' (matched ' + bestScore + '/' + HEADER_TITLES.length + ' titles, ' + bestDistinct + ' distinctive)');
      return bestRow;
    }
    logger.warn('[sp-discover] no confident header match for sheet' + sheetId + ' (best distinctive=' + bestDistinct + ') — defaulting to 16');
    return 16;
  } catch (e) {
    return 16; // safe default
  }
}

/**
 * Simple zip parser for xlsx (stored + deflate entries)
 */
function unzipEntries(buf) {
  const entries = [];
  let offset = 0;
  const zlib = require('zlib');

  while (offset < buf.length - 4) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) break;
    
    const method = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const uncompSize = buf.readUInt32LE(offset + 22);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.slice(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    const rawData = buf.slice(dataStart, dataStart + compSize);

    let data;
    if (method === 0) {
      data = rawData; // stored
    } else if (method === 8) {
      try { data = zlib.inflateRawSync(rawData); } catch (e) { data = Buffer.alloc(0); }
    } else {
      data = Buffer.alloc(0);
    }

    entries.push({ name, data });
    offset = dataStart + compSize;
  }

  return entries;
}

module.exports = { extractFilePath, discoverSheets, findFileOnSite };
