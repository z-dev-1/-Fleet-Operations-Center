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

// Known header keywords to detect the header row
const HEADER_KEYWORDS = [
  'unit', 'equipment', 'asset', 'vendor', 'status', 'domicile',
  'operator', 'carrier', 'issue', 'notes', 'duration', 'created',
  'wr', 'work request', 'lifecycle', 'make', 'model', 'vin'
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
    
    // Get shared strings
    const ssEntry = entries.find(e => e.name === 'xl/sharedStrings.xml');
    if (!ssEntry) return 16; // default
    const ssXml = ssEntry.data.toString('utf8');
    const strings = [];
    const siRegex = /<si[^>]*>(?:<t[^>]*>([^<]*)<\/t>|<r>.*?<t[^>]*>([^<]*)<\/t>.*?<\/r>)/gs;
    let m;
    while ((m = siRegex.exec(ssXml)) !== null) {
      strings.push((m[1] || m[2] || '').toLowerCase());
    }

    // Get the sheet xml
    const sheetFile = 'xl/worksheets/sheet' + sheetId + '.xml';
    const sheetEntry = entries.find(e => e.name === sheetFile);
    if (!sheetEntry) return 16;
    const sheetXml = sheetEntry.data.toString('utf8');

    // Find rows and check which one has the most header keyword matches
    const rowRegex = /<row\s+r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
    let bestRow = 16;
    let bestScore = 0;

    while ((m = rowRegex.exec(sheetXml)) !== null) {
      const rowNum = parseInt(m[1]);
      if (rowNum > 25) break; // Don't scan past row 25
      const cells = m[2];
      
      // Count keyword matches in this row's cell values
      const vRegex = /<v>(\d+)<\/v>/g;
      let score = 0;
      let vm;
      while ((vm = vRegex.exec(cells)) !== null) {
        const strIdx = parseInt(vm[1]);
        if (strings[strIdx]) {
          const val = strings[strIdx];
          if (HEADER_KEYWORDS.some(kw => val.includes(kw))) score++;
        }
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestRow = rowNum;
      }
    }

    return bestRow;
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
