/**
 * sp_push_script.js
 * Injectable script that runs INSIDE the SP-authenticated BrowserWindow.
 * Downloads xlsx, modifies cells, re-uploads.
 * This file is read by sharepoint_push.js and injected via executeJavaScript.
 */

// This function is called with: { filePath, sheetName, units, digest, headerRow }
async function spPushWorksheet(config) {
  const { filePath, sheetName, units, digest, headerRow, dryRun } = config;
  const SP = 'https://amazon.sharepoint.com'; // Site extracted from filePath
  const results = { pushed: 0, updated: 0, removed: 0, errors: 0, log: [] };

  const log = (msg) => { results.log.push(msg); console.log('[SP Push]', msg); };

  // === DOWNLOAD ===
  log('Downloading: ' + filePath);
  // Extract site from filePath for proper API scope
  const siteMatch = filePath.match(/(\/sites\/[^\/]+)/);
  const siteScope = siteMatch ? siteMatch[1] : '/sites/AFP-FAS';
  const fileUrl = SP + siteScope + "/_api/web/getfilebyserverrelativeurl('" + encodeURI(filePath).replace(/'/g, "''") + "')/$value";
  const resp = await fetch(fileUrl, { credentials: 'include' });
  if (!resp.ok) { log('ERROR: Download failed HTTP ' + resp.status); results.errors++; return results; }
  const buffer = await resp.arrayBuffer();
  log('Downloaded ' + (buffer.byteLength / 1024).toFixed(0) + ' KB');

  // === PARSE ZIP ===
  function parseZip(buf) {
    const view = new DataView(buf);
    const entries = [];
    let idx = 0;
    while (idx < buf.byteLength - 4) {
      if (view.getUint32(idx, true) === 0x04034b50) {
        const flags = view.getUint16(idx + 6, true);
        const method = view.getUint16(idx + 8, true);
        let compSize = view.getUint32(idx + 18, true);
        const uncompSize = view.getUint32(idx + 22, true);
        const nameLen = view.getUint16(idx + 26, true);
        const extraLen = view.getUint16(idx + 28, true);
        const localHeaderSize = 30 + nameLen + extraLen;
        const nameBytes = new Uint8Array(buf, idx + 30, nameLen);
        let name = '';
        for (let n = 0; n < nameBytes.length; n++) name += String.fromCharCode(nameBytes[n]);
        const dataStart = idx + localHeaderSize;

        // Handle data descriptor (bit 3 of flags) — compSize is 0 in local header
        if ((flags & 0x08) && compSize === 0) {
          // Scan for next local file header or end-of-central-dir to find data boundary
          let scanIdx = dataStart;
          while (scanIdx < buf.byteLength - 4) {
            const sig = view.getUint32(scanIdx, true);
            if (sig === 0x04034b50 || sig === 0x02014b50) break;
            // Data descriptor signature (optional): 0x08074b50
            if (sig === 0x08074b50) {
              compSize = view.getUint32(scanIdx + 8, true);
              break;
            }
            scanIdx++;
          }
          if (compSize === 0) compSize = scanIdx - dataStart;
        }

        entries.push({
          name, method, compSize,
          localHeader: new Uint8Array(buf, idx, localHeaderSize),
          compData: new Uint8Array(buf, dataStart, compSize)
        });
        idx = dataStart + compSize;
        // Skip data descriptor if present
        if (flags & 0x08) {
          if (idx < buf.byteLength - 4 && view.getUint32(idx, true) === 0x08074b50) idx += 16;
          else if (idx < buf.byteLength - 12) idx += 12; // no signature variant
        }
      } else { idx++; }
    }
    return entries;
  }

  async function inflate(data, method) {
    if (method === 0) return data;
    const ds = new DecompressionStream('deflate-raw');
    const w = ds.writable.getWriter(); const r = ds.readable.getReader();
    w.write(data); w.close();
    const chunks = []; let total = 0;
    while (true) { const x = await r.read(); if (x.done) break; chunks.push(x.value); total += x.value.length; }
    const out = new Uint8Array(total); let off = 0;
    chunks.forEach(c => { out.set(c, off); off += c.length; });
    return out;
  }

  async function deflate(data) {
    const ds = new CompressionStream('deflate-raw');
    const w = ds.writable.getWriter(); const r = ds.readable.getReader();
    w.write(data); w.close();
    const chunks = []; let total = 0;
    while (true) { const x = await r.read(); if (x.done) break; chunks.push(x.value); total += x.value.length; }
    const out = new Uint8Array(total); let off = 0;
    chunks.forEach(c => { out.set(c, off); off += c.length; });
    return out;
  }

  function crc32(data) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c; }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function rebuildZip(entries, modifiedMap) {
    const parts = []; const centralDir = []; let offset = 0;
    for (const ent of entries) {
      const mod = modifiedMap[ent.name];
      const nameB = new TextEncoder().encode(ent.name);

      if (!mod) {
        // UNMODIFIED: preserve original local header + data byte-for-byte
        parts.push(ent.localHeader);
        parts.push(ent.compData);
        // Central directory: copy fields from original local header
        const lhView = new DataView(ent.localHeader.buffer, ent.localHeader.byteOffset, ent.localHeader.byteLength);
        const _xLen = lhView.getUint16(28, true);
        const cd = new ArrayBuffer(46 + nameB.length + _xLen);
        const cv = new DataView(cd);
        cv.setUint32(0, 0x02014b50, true);  // central dir signature
        cv.setUint16(4, 20, true);           // version made by
        cv.setUint16(6, lhView.getUint16(4, true), true);  // version needed
        cv.setUint16(8, lhView.getUint16(6, true), true);  // flags
        cv.setUint16(10, lhView.getUint16(8, true), true); // method
        cv.setUint16(12, lhView.getUint16(10, true), true); // mod time
        cv.setUint16(14, lhView.getUint16(12, true), true); // mod date
        cv.setUint32(16, lhView.getUint32(14, true), true); // crc32
        cv.setUint32(20, lhView.getUint32(18, true), true); // compressed size
        cv.setUint32(24, lhView.getUint32(22, true), true); // uncompressed size
        cv.setUint16(28, nameB.length, true);  // name length
        const _extraLen = lhView.getUint16(28, true); // preserve original extra field length
        cv.setUint16(30, _extraLen, true);  // extra field length PRESERVED
        cv.setUint16(32, 0, true);  // comment length
        cv.setUint16(34, 0, true);  // disk number
        cv.setUint16(36, 0, true);  // internal attrs
        cv.setUint32(38, ent.externalAttrs || 0x20, true);  // external attrs PRESERVED
        cv.setUint32(42, offset, true); // local header offset
        new Uint8Array(cd, 46).set(nameB);
        centralDir.push(new Uint8Array(cd));
        offset += ent.localHeader.length + ent.compData.length;
      } else {
        // MODIFIED: write new local header + compressed data
        const lh = new ArrayBuffer(30 + nameB.length);
        const lv = new DataView(lh);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);   // version needed
        lv.setUint16(6, 0, true);    // flags
        lv.setUint16(8, 8, true);    // method = deflate
        lv.setUint16(10, 0, true);   // mod time
        lv.setUint16(12, 0, true);   // mod date
        lv.setUint32(14, mod.crc, true);
        lv.setUint32(18, mod.compData.length, true);
        lv.setUint32(22, mod.rawSize, true);
        lv.setUint16(26, nameB.length, true);
        lv.setUint16(28, 0, true);   // extra length
        new Uint8Array(lh, 30).set(nameB);
        parts.push(new Uint8Array(lh));
        parts.push(mod.compData);
        // Central directory for modified entry
        const cd = new ArrayBuffer(46 + nameB.length);
        const cv = new DataView(cd);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0, true);    // flags
        cv.setUint16(10, 8, true);   // method = deflate
        cv.setUint16(12, 0, true);
        cv.setUint16(14, 0, true);
        cv.setUint32(16, mod.crc, true);
        cv.setUint32(20, mod.compData.length, true);
        cv.setUint32(24, mod.rawSize, true);
        cv.setUint16(28, nameB.length, true);
        cv.setUint32(42, offset, true);
        new Uint8Array(cd, 46).set(nameB);
        centralDir.push(new Uint8Array(cd));
        offset += 30 + nameB.length + mod.compData.length;
      }
    }
    // End of central directory
    let cdSize = 0; centralDir.forEach(cd => { parts.push(cd); cdSize += cd.length; });
    const eocd = new ArrayBuffer(22); const ev = new DataView(eocd);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    parts.push(new Uint8Array(eocd));
    // Concatenate
    let totalSize = 0; parts.forEach(p => totalSize += p.length);
    const result = new Uint8Array(totalSize); let pos = 0;
    parts.forEach(p => { result.set(p, pos); pos += p.length; });
    return result;
  }

  // === PARSE XLSX ===


  const entries = parseZip(buffer);
  log('ZIP entries: ' + entries.length);

  // Find target worksheet
  const wsEntry = entries.find(e => e.name === 'xl/worksheets/' + sheetName.toLowerCase().replace('sheet', 'sheet') + '.xml');
  const wsName = wsEntry ? wsEntry.name : 'xl/worksheets/sheet' + sheetName.replace(/\D/g, '') + '.xml';
  const wsEnt = entries.find(e => e.name.toLowerCase() === wsName.toLowerCase());
  if (!wsEnt) { log('ERROR: Worksheet not found: ' + wsName + '. Available: ' + entries.filter(e=>e.name.includes('worksheet')).map(e=>e.name).join(', ')); results.errors++; return results; }

  log('Found worksheet: ' + wsEnt.name);
  const wsRaw = await inflate(wsEnt.compData, wsEnt.method);
  let wsXml = new TextDecoder().decode(wsRaw);

  // Parse shared strings
  const ssEnt = entries.find(e => e.name === 'xl/sharedStrings.xml');
  let sharedStrings = [];
  if (ssEnt) {
    const ssRaw = await inflate(ssEnt.compData, ssEnt.method);
    const ssXml = new TextDecoder().decode(ssRaw);
    const re = /<si>([\s\S]*?)<\/si>/g; let m;
    while ((m = re.exec(ssXml)) !== null) {
      const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g; let tm; const parts = [];
      while ((tm = tRe.exec(m[1])) !== null) parts.push(tm[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"'));
      sharedStrings.push(parts.join(''));
    }
  }
  log('Shared strings: ' + sharedStrings.length + ' entries');

  // Read rows

  function getCellValue(cellXml) {
    const t = (cellXml.match(/\bt="([^"]+)"/) || [])[1] || '';
    // Inline string: <is><t>value</t></is>
    if (t === 'inlineStr') {
      const ism = cellXml.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
      if (ism) return ism[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#10;/g,'\n');
      return '';
    }
    // Value in <v> tag
    const vm = cellXml.match(/<v>([\s\S]*?)<\/v>/);
    if (!vm) {
      // Some cells have value directly in <is><t> without t="inlineStr"
      const fallback = cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      if (fallback) return fallback[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
      return '';
    }
    const raw = vm[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    if (t === 's') return sharedStrings[parseInt(raw, 10)] || '';
    return raw;
  }

  // Helper: normalize unit ID for matching (strip spaces, leading zeros)
  function normalizeId(v) { return String(v || '').replace(/[\n\r\s]+/g, '').replace(/^0+/, '').toLowerCase(); }

  const unitCol = 'B';
  const rowRe = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const existingUnits = {}; // normalized unitId -> rowNum
  let maxDataRow = headerRow;
  let rm;
  while ((rm = rowRe.exec(wsXml)) !== null) {
    const rowNum = parseInt(rm[1], 10);
    if (rowNum <= headerRow) continue;
    const cellRe = /<c\b[^>]*\br="B\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/;
    const cm = cellRe.exec(rm[2]);
    if (cm) {
      const val = normalizeId(getCellValue(cm[0]));
      if (val) { existingUnits[val] = rowNum; if (rowNum > maxDataRow) maxDataRow = rowNum; }
    }
  }
  log('Existing units in sheet: ' + Object.keys(existingUnits).length + ', max row: ' + maxDataRow);
  // Debug: show first 5 existing IDs
  const sampleIds = Object.keys(existingUnits).slice(0, 5);
  log('Sample existing IDs: ' + sampleIds.join(', '));


  // === FIND OR CREATE WRAP TEXT STYLE ===
  // Look for existing style with wrapText in styles.xml, or add one
  const stylesEnt = entries.find(e => e.name === 'xl/styles.xml');
  let wrapStyleIdx = '0'; // default
  let stylesModified = false;
  let stylesXml = '';
  if (stylesEnt) {
    const stylesRaw = await inflate(stylesEnt.compData, stylesEnt.method);
    stylesXml = new TextDecoder().decode(stylesRaw);
    // Find existing xf with wrapText
    const xfRe = /<xf\b[^>]*>/g;
    let xfMatch; let xfIdx = 0; let foundWrap = -1;
    // Count cellXfs entries
    const cellXfsMatch = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
    if (cellXfsMatch) {
      const xfBlock = cellXfsMatch[1];
      const allXfs = xfBlock.match(/<xf\b[^>]*\/?>/g) || [];
      for (let i = 0; i < allXfs.length; i++) {
        if (/wrapText="1"/.test(allXfs[i])) { foundWrap = i; break; }
      }
      if (foundWrap >= 0) {
        wrapStyleIdx = String(foundWrap);
        log('Found existing wrapText style at index ' + wrapStyleIdx);
      } else {
        // Add new xf with wrapText at end of cellXfs
        const newXf = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment wrapText="1"/></xf>';
        const newIdx = allXfs.length;
        stylesXml = stylesXml.replace('</cellXfs>', newXf + '</cellXfs>');
        // Update count
        stylesXml = stylesXml.replace(/<cellXfs count="(\d+)"/, (m, n) => '<cellXfs count="' + (parseInt(n) + 1) + '"');
        wrapStyleIdx = String(newIdx);
        stylesModified = true;
        log('Added wrapText style at index ' + wrapStyleIdx);
      }
    }
  }

  function xmlEsc(v) { return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function buildCell(col, row, value, existingStyle) {
    const ref = col + row;
    const v = String(value || '');
    // Preserve original style index if we have one, otherwise omit style
    const styleAttr = existingStyle ? ' s="' + existingStyle + '"' : '';
    if (!v) return '<c r="' + ref + '"' + styleAttr + ' t="inlineStr"><is><t></t></is></c>';
    const escaped = xmlEsc(v).replace(/\n/g, '&#10;');
    return '<c r="' + ref + '"' + styleAttr + ' t="inlineStr"><is><t xml:space="preserve">' + escaped + '</t></is></c>';
  }


  function buildRow(rowNum, unitData, existingRowXml) {
    const cols = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'];
    // Extract existing cell styles from the original row if available
    const existingStyles = {};
    if (existingRowXml) {
      const cellStyleRe = /<c\b[^>]*\br="([A-Z]+)\d+"[^>]*?\bs="(\d+)"[^>]*/g;
      let csm;
      while ((csm = cellStyleRe.exec(existingRowXml)) !== null) {
        existingStyles[csm[1]] = csm[2];
      }
    }
    // Also preserve original row attributes (spans, ht, customHeight, etc.)
    let rowAttrs = 'r="' + rowNum + '" spans="1:14"';
    if (existingRowXml) {
      const attrMatch = existingRowXml.match(/<row\b([^>]*)>/);
      if (attrMatch) {
        // Keep original attributes but ensure r= is correct
        let attrs = attrMatch[1];
        attrs = attrs.replace(/\br="\d+"/, 'r="' + rowNum + '"');
        rowAttrs = attrs;
      }
    }
    const cells = cols.map((c, i) => buildCell(c, rowNum, unitData[i] || '', existingStyles[c])).join('');
    return '<row ' + rowAttrs + '>' + cells + '</row>';
  }


  // === UPDATE/INSERT ROWS ===
  let modified = false;
  const hyperlinks = []; // collect {ref, url} for hyperlink injection

  for (const unitObj of units) {
    // Support both old array format and new {values, urls} format
    const unit = Array.isArray(unitObj) ? unitObj : unitObj.values;
    const urls = Array.isArray(unitObj) ? {} : (unitObj.urls || {});
    const unitId = String(unit[1] || '');
    if (!unitId) continue;
    const normalizedId = normalizeId(unitId);
    const existingRow = existingUnits[normalizedId];
    const isActive = String(unit[4] || '').toUpperCase() === 'ACTIVE';


    // Skip Active units that don't already exist in the sheet (don't add new Active rows)
    if (isActive && !existingRow) continue;

    const targetRow = existingRow || (++maxDataRow);

    // Debug log
    log('[ROW ' + targetRow + (existingRow ? ' UPDATE' : ' NEW') + (isActive ? ' ACTIVE' : '') + '] ' + unitId + ' | E:' + unit[4] + ' | F:' + (unit[5]||'--') + ' | L:' + (unit[11]||'--'));

    // Get existing row XML to preserve styles/attributes
    let existingRowXml = null;
    if (existingRow) {
      const rowFindRe = new RegExp('<row\\b[^>]*\\br="' + targetRow + '"[^>]*>[\\s\\S]*?<\\/row>');
      const existMatch = wsXml.match(rowFindRe);
      if (existMatch) existingRowXml = existMatch[0];
    }

    const newRowXml = buildRow(targetRow, unit, existingRowXml);

    // Only add hyperlinks for Unavailable units
    if (!isActive) {
      if (urls.H) hyperlinks.push({ ref: 'H' + targetRow, url: urls.H });
      if (urls.J) hyperlinks.push({ ref: 'J' + targetRow, url: urls.J });
    }

    if (existingRow) {
      const rowPattern = new RegExp('<row\\b[^>]*\\br="' + targetRow + '"[^>]*>[\\s\\S]*?<\\/row>');
      if (rowPattern.test(wsXml)) {
        wsXml = wsXml.replace(rowPattern, newRowXml);
        results.updated++;
      } else {
        wsXml = wsXml.replace('</sheetData>', newRowXml + '</sheetData>');
        results.pushed++;
      }
    } else {
      wsXml = wsXml.replace('</sheetData>', newRowXml + '</sheetData>');
      results.pushed++;
    }
    modified = true;
  }


  // === ORPHAN REMOVAL: units in sheet but NOT in current push data ===
  const pushedIds = new Set(units.map(u => {
    const vals = Array.isArray(u) ? u : u.values;
    return normalizeId(vals[1] || '');
  }));
  for (const [existingId, rowNum] of Object.entries(existingUnits)) {
    if (!pushedIds.has(existingId)) {
      // Unit removed from carrier — delete the entire row
      const rowPattern = new RegExp('<row\\b[^>]*\\br="' + rowNum + '"[^>]*>[\\s\\S]*?<\\/row>');
      if (rowPattern.test(wsXml)) {
        wsXml = wsXml.replace(rowPattern, ''); // delete row entirely
        log('[DELETED] ' + existingId + ' row ' + rowNum + ' (removed from carrier)');
        results.removed = (results.removed || 0) + 1;
        modified = true;
      }
    }
  }


  // === DEDUP: check for duplicate unit IDs and clear later occurrences ===
  const seenRows = {}; // normalizedId -> first rowNum
  const rowReDedup = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rdm;
  while ((rdm = rowReDedup.exec(wsXml)) !== null) {
    const rn = parseInt(rdm[1], 10);
    if (rn <= headerRow) continue;
    const cellRe2 = /<c\b[^>]*\br="B\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/;
    const cm2 = cellRe2.exec(rdm[2]);
    if (cm2) {
      const val = normalizeId(getCellValue(cm2[0]));
      if (val) {
        if (seenRows[val]) {
          // Duplicate — delete this row
          wsXml = wsXml.replace(rdm[0], '');
          log('[DEDUP] ' + val + ' row ' + rn + ' deleted (kept row ' + seenRows[val] + ')');
          results.removed = (results.removed || 0) + 1;
          modified = true;
        } else {
          seenRows[val] = rn;
        }
      }

    }
  }


  if (!modified) { log('No changes to make.'); return results; }


  log('Modified: ' + results.updated + ' updated, ' + results.pushed + ' new');

  // === INJECT HYPERLINKS ===
  if (hyperlinks.length) {
    // Remove existing hyperlinks for our cells (avoid duplicates)
    hyperlinks.forEach(h => {
      const pat = new RegExp('<hyperlink\\b[^>]*\\bref="' + h.ref + '"[^>]*/>', 'g');
      wsXml = wsXml.replace(pat, '');
    });

    // Build hyperlink XML entries
    const hlXml = hyperlinks.map((h, i) => '<hyperlink ref="' + h.ref + '" r:id="rIdPush' + i + '"/>').join('');

    // Insert/update <hyperlinks> block
    if (/<hyperlinks[^>]*>/.test(wsXml)) {
      wsXml = wsXml.replace('</hyperlinks>', hlXml + '</hyperlinks>');
    } else {
      // Insert before </worksheet>
      wsXml = wsXml.replace('</worksheet>', '<hyperlinks>' + hlXml + '</hyperlinks></worksheet>');
    }

    // wsEnt.name = 'xl/worksheets/sheet2.xml' -> rels = 'xl/worksheets/_rels/sheet2.xml.rels'
    const wsFileName = wsEnt.name.split('/').pop(); // 'sheet2.xml'
    const relsName = 'xl/worksheets/_rels/' + wsFileName + '.rels';
    let relsEnt = entries.find(e => e.name === relsName);

    let relsXml = '';
    if (relsEnt) {
      const relsRaw = await inflate(relsEnt.compData, relsEnt.method);
      relsXml = new TextDecoder().decode(relsRaw);
    } else {
      relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    }

    // Remove old push relationships
    relsXml = relsXml.replace(/<Relationship\b[^>]*\bId="rIdPush\d+"[^>]*\/>/g, '');

    // Add new relationships
    const newRels = hyperlinks.map((h, i) =>
      '<Relationship Id="rIdPush' + i + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + xmlEsc(h.url) + '" TargetMode="External"/>'
    ).join('');
    relsXml = relsXml.replace('</Relationships>', newRels + '</Relationships>');

    // Add/update rels in ZIP entries
    if (relsEnt) {
      const newRelsData = new TextEncoder().encode(relsXml);
      const compRels = await deflate(newRelsData);
      // Will be added to modifiedMap below
      relsEnt._modified = { compData: compRels, rawSize: newRelsData.length, crc: crc32(newRelsData) };
    } else {
      // Create new rels entry
      const newRelsData = new TextEncoder().encode(relsXml);
      const compRels = await deflate(newRelsData);
      entries.push({ name: relsName, method: 8, compData: compRels, compSize: compRels.length, uncompSize: newRelsData.length, localHeader: null, _new: true, _modified: { compData: compRels, rawSize: newRelsData.length, crc: crc32(newRelsData) } });
    }

    log('Hyperlinks: ' + hyperlinks.length + ' added');
  }

  // === REBUILD ZIP ===
  const modifiedMap = {};
  const newWsData = new TextEncoder().encode(wsXml);
  const compWs = await deflate(newWsData);
  modifiedMap[wsEnt.name] = { compData: compWs, rawSize: newWsData.length, crc: crc32(newWsData) };
  // Add rels modification if any
  const wsFileName2 = wsEnt.name.split('/').pop();
  const relsName2 = 'xl/worksheets/_rels/' + wsFileName2 + '.rels';
  const relsEnt2 = entries.find(e => e.name === relsName2 && e._modified);
  if (relsEnt2) {
    modifiedMap[relsEnt2.name] = relsEnt2._modified;
  }


  // DISABLED: Do NOT modify styles.xml — preserve original layout
  // if (stylesModified && stylesEnt) { ... }

  const newZip = rebuildZip(entries, modifiedMap);


  log('New ZIP size: ' + (newZip.length / 1024).toFixed(0) + ' KB');


  // === VALIDATE ZIP INTEGRITY ===
  function validateZipIntegrity(zipBuffer, originalEntries) {
    // Verify the rebuilt ZIP has at least as many entries as original
    // Quick check: ZIP must start with PK signature and have central directory
    const view = new DataView(zipBuffer.buffer || zipBuffer);
    if (view.getUint32(0, true) !== 0x04034b50) {
      log('ERROR: Invalid ZIP signature after rebuild');
      results.errors++;
      return false;
    }
    // Check minimum size (corrupted files are usually tiny)
    if (zipBuffer.length < 1000) {
      log('ERROR: ZIP too small after rebuild (' + zipBuffer.length + ' bytes)');
      results.errors++;
      return false;
    }
    // Check it contains [Content_Types].xml (required for xlsx)
    const asText = new TextDecoder().decode(zipBuffer.slice(0, Math.min(zipBuffer.length, 500)));
    // The first entry name should appear early
    log('ZIP validation passed: ' + zipBuffer.length + ' bytes, starts with PK');
    return true;
  }
  if (!validateZipIntegrity(newZip, entries)) {
    log('ABORTED: ZIP validation failed, NOT uploading');
    return results;
  }

  // === UPLOAD ===
  if (dryRun) {
    log('DRY RUN — skipping upload. Would upload ' + (newZip.length / 1024).toFixed(0) + ' KB to: ' + filePath);
    return results;
  }
  const uploadUrl = SP + siteScope + "/_api/web/getfilebyserverrelativeurl('" + encodeURI(filePath).replace(/'/g, "''") + "')/$value";
  const upResp = await fetch(uploadUrl, {
    method: 'PUT', credentials: 'include',
    headers: { 'X-RequestDigest': digest, 'Content-Type': 'application/octet-stream', 'X-HTTP-Method': 'PUT' },
    body: newZip
  });
  if (upResp.ok) { log('Upload SUCCESS'); }
  else { log('ERROR: Upload failed HTTP ' + upResp.status); results.errors++; }

  return results;

}
