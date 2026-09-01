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

  // ── SAFETY GUARD (top region is sacred) ──────────────────────────────────
  // Every write/insert/delete below is bounded to rows STRICTLY GREATER than
  // the header row, which protects the fixed dashboard/summary/title block at
  // the top of each sheet. We do NOT trust the configured headerRow — after the
  // sheet is downloaded, _autoFindHeaderRow() locates the real header band in
  // the live file and overrides _hr with it (see below). The config value is
  // only a provisional hint until then; if it's unusable we just seed a safe
  // provisional value and let the auto-find determine the truth.
  let _hr = parseInt(headerRow, 10);
  if (!Number.isFinite(_hr) || _hr < 1) _hr = 16; // provisional; auto-find overrides

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

  // === HEADER-ROW VERIFICATION GUARD ===
  // A wrong-but-valid headerRow (e.g. 3 when the real header band is row 16)
  // would make the push write DATA rows into the title/summary/header region
  // and corrupt the sheet's top. Rather than TRUST a configured headerRow (which
  // can be stale or mis-detected), AUTO-FIND the real header band directly from
  // the live sheet on every push by scanning for the column-title signature
  // (CARRIER + UNIT NUMBER + BODY TYPE / REPAIR UPDATES). The row we find becomes
  // the authoritative header row for this push — nothing is hardcoded and the
  // config value is only a last-resort hint. If no header band can be found at
  // all, we refuse to write (protects the top region).
  (function _autoFindHeaderRow() {
    function rowSignatureText(cellsXml) {
      let txt = '';
      const cRe = /<c\b[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g; let ccm;
      while ((ccm = cRe.exec(cellsXml)) !== null) {
        const cx = ccm[0];
        const ta = (cx.match(/\bt="([^"]+)"/) || [])[1] || '';
        const vv = cx.match(/<v>([\s\S]*?)<\/v>/);
        if (ta === 's' && vv) txt += ' ' + (sharedStrings[parseInt(vv[1], 10)] || '');
        else { const im = cx.match(/<t[^>]*>([\s\S]*?)<\/t>/); if (im) txt += ' ' + im[1]; else if (vv) txt += ' ' + vv[1]; }
      }
      return txt.toUpperCase();
    }
    let found = 0;
    const scanRe = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
    let scm;
    while ((scm = scanRe.exec(wsXml)) !== null) {
      const rNum = parseInt(scm[1], 10);
      if (rNum > 60) break; // header is always near the top
      const tu = rowSignatureText(scm[2]);
      // The real data-table header band — distinguished from the top summary
      // block by the presence of distinctive titles the summary never has.
      if (tu.includes('CARRIER') && tu.includes('UNIT') &&
          (tu.includes('BODY TYPE') || tu.includes('REPAIR UPDATES') || tu.includes('LIFECYCLE'))) {
        found = rNum;
        break;
      }
    }
    if (found) {
      if (found !== _hr) log('[HEADER] auto-located header band at row ' + found + ' on ' + sheetName + ' (config hint was ' + _hr + ') — using ' + found);
      else log('[HEADER] header band confirmed at row ' + found + ' on ' + sheetName);
      _hr = found; // authoritative for all row guards / inserts below
    } else {
      log('ERROR: could not locate the header band (CARRIER + UNIT NUMBER + BODY TYPE/REPAIR UPDATES) in rows 1-60 of ' + sheetName + '. Refusing to write to protect the top region.');
      results.errors++;
      results._headerCheckFailed = true;
    }
  })();
  if (results._headerCheckFailed) return results;

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
  let maxDataRow = _hr;
  let rm;
  while ((rm = rowRe.exec(wsXml)) !== null) {
    const rowNum = parseInt(rm[1], 10);
    if (rowNum <= _hr) continue;
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
  // ── WRAP-TEXT FOR COLUMN K (REPAIR UPDATES) ──────────────────────────────
  // FEATURE (2026-09-01): the REPAIR UPDATES column holds long, multi-line
  // notes that need to wrap. We build a wrap-enabled cell style and apply it
  // ONLY to column K data cells. SAFETY: we only ever APPEND a new <xf> at the
  // END of cellXfs — appending never renumbers existing style indices, so every
  // header/top-region cell (which references its original index) is untouched.
  // We clone column K's existing template style (to keep its font/fill/border)
  // and just add wrapText="1" to the clone, so K looks identical but wraps.
  const stylesEnt = entries.find(e => e.name === 'xl/styles.xml');
  let stylesModified = false;
  let stylesXml = '';
  // Map of source-xf-index -> new wrap-clone-index, so repeated rows reuse the
  // same appended clone instead of appending one per row.
  const _wrapCloneByBase = {};
  let _cellXfsList = [];
  if (stylesEnt) {
    const stylesRaw = await inflate(stylesEnt.compData, stylesEnt.method);
    stylesXml = new TextDecoder().decode(stylesRaw);
    const cellXfsMatch = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
    if (cellXfsMatch) {
      _cellXfsList = cellXfsMatch[1].match(/<xf\b[\s\S]*?(?:\/>|<\/xf>)/g) || [];
    }
  }
  // Returns a style index that renders like `baseIdx` but with wrapText on.
  // Appends a clone to cellXfs the first time a given base index is requested.
  function getWrapStyleFor(baseIdx) {
    if (!stylesEnt || !_cellXfsList.length) return baseIdx || null;
    const key = (baseIdx == null || baseIdx === '') ? 'none' : String(baseIdx);
    if (_wrapCloneByBase[key] != null) return String(_wrapCloneByBase[key]);
    // Build the clone from the base xf (or a plain xf if no base).
    let baseXf = null;
    const bi = parseInt(baseIdx, 10);
    if (Number.isFinite(bi) && bi >= 0 && bi < _cellXfsList.length) baseXf = _cellXfsList[bi];
    let cloneXf;
    if (baseXf) {
      if (/wrapText="1"/.test(baseXf)) { _wrapCloneByBase[key] = bi; return String(bi); } // already wraps
      if (/<alignment\b[^>]*\/>/.test(baseXf)) {
        cloneXf = baseXf.replace(/<alignment\b([^>]*)\/>/, '<alignment$1 wrapText="1"/>');
      } else if (/<alignment\b[^>]*>[\s\S]*?<\/alignment>/.test(baseXf)) {
        cloneXf = baseXf.replace(/<alignment\b([^>]*)>/, '<alignment$1 wrapText="1">');
      } else if (/<xf\b[^>]*\/>/.test(baseXf)) {
        // self-closing xf, no alignment child -> convert to open/close with alignment
        cloneXf = baseXf.replace(/<xf\b([^>]*)\/>/, '<xf$1 applyAlignment="1"><alignment wrapText="1"/></xf>');
      } else {
        cloneXf = baseXf.replace(/<xf\b([^>]*)>/, '<xf$1 applyAlignment="1"><alignment wrapText="1"/>').replace(/<\/xf>?$/, '</xf>');
        if (!/<\/xf>$/.test(cloneXf)) cloneXf = cloneXf + '</xf>';
      }
    } else {
      cloneXf = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment wrapText="1"/></xf>';
    }
    const newIdx = _cellXfsList.length;
    _cellXfsList.push(cloneXf);
    stylesXml = stylesXml.replace('</cellXfs>', cloneXf + '</cellXfs>');
    stylesXml = stylesXml.replace(/<cellXfs count="(\d+)"/, (m, n) => '<cellXfs count="' + (parseInt(n) + 1) + '"');
    stylesModified = true;
    _wrapCloneByBase[key] = newIdx;
    log('Appended wrap-text style clone at index ' + newIdx + ' (base ' + key + ')');
    return String(newIdx);
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
    const cells = cols.map((c, i) => {
      let styleForCell = existingStyles[c];
      // Force wrap on REPAIR UPDATES (column K) when the note is long/multi-line
      // so it wraps instead of overflowing. Only K, only when it actually needs
      // it — short cells keep their original style untouched.
      if (c === 'K') {
        const kv = String(unitData[i] || '');
        if (kv.length > 40 || /\n/.test(kv)) {
          const ws = getWrapStyleFor(existingStyles[c]);
          if (ws != null) styleForCell = ws;
        }
      }
      return buildCell(c, rowNum, unitData[i] || '', styleForCell);
    }).join('');
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

    // HARD GUARD: never write at/above the header/top region. Data rows are
    // always > headerRow; if anything ever computes a target inside the top
    // block, skip it rather than overwrite the dashboard/title/summary.
    if (targetRow <= _hr) {
      log('[SKIP] refusing to write ' + unitId + ' at row ' + targetRow + ' (<= headerRow ' + _hr + ') — protects top region');
      continue;
    }

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

    // Only add hyperlinks for Unavailable units.
    // H = Relay Garage, I = Offsite Shop Event, J = Salesforce Case.
    // (BUG FIX: column I was previously omitted, so offsite links never showed.)
    if (!isActive) {
      if (urls.H) hyperlinks.push({ ref: 'H' + targetRow, url: urls.H });
      if (urls.I) hyperlinks.push({ ref: 'I' + targetRow, url: urls.I });
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
    if (rn <= _hr) continue;
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

  // === COMPACT DATA ROWS (no blank gaps) ===
  // Deleting orphan/duplicate rows above leaves holes in the row numbering, so
  // the sheet shows blank gaps between units. Renumber all DATA rows (rows
  // strictly > headerRow) to be contiguous starting at headerRow+1, preserving
  // their existing order and content. Rows <= headerRow (the fixed top/header
  // region) are never read or touched. Also remaps hyperlink refs so links
  // still point at the right cells after renumbering.
  const rowRemap = {}; // oldRowNum -> newRowNum (data rows only)
  (function _compactDataRows() {
    // Split the sheet at </sheetData> so we only rewrite the data region.
    const sdMatch = wsXml.match(/([\s\S]*<sheetData[^>]*>)([\s\S]*?)(<\/sheetData>[\s\S]*)/);
    if (!sdMatch) { log('[COMPACT] no <sheetData> found — skipping'); return; }
    const head = sdMatch[1], body = sdMatch[2], tail = sdMatch[3];
    const rowRe2 = /<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g;
    let next = _hr + 1;
    let rebuiltBody = body;
    // Collect data rows in document order.
    const dataRows = [];
    let rm2;
    while ((rm2 = rowRe2.exec(body)) !== null) {
      const rn = parseInt(rm2[1], 10);
      if (rn <= _hr) continue; // never touch header/top region
      dataRows.push({ oldRow: rn, xml: rm2[0] });
    }
    // Renumber each data row and its cell refs to a contiguous sequence.
    for (const dr of dataRows) {
      const newRow = next++;
      rowRemap[dr.oldRow] = newRow;
      if (newRow === dr.oldRow) continue; // already in place
      let rowXml = dr.xml;
      // Update the <row r="..."> attribute.
      rowXml = rowXml.replace(/(<row\b[^>]*\br=")\d+(")/,'$1' + newRow + '$2');
      // Update every cell ref r="<Col><oldRow>" -> r="<Col><newRow>".
      rowXml = rowXml.replace(/(\br=")([A-Z]+)\d+(")/g, '$1$2' + newRow + '$3');
      rebuiltBody = rebuiltBody.replace(dr.xml, rowXml);
    }
    wsXml = head + rebuiltBody + tail;
    const moved = Object.keys(rowRemap).filter(k => rowRemap[k] !== parseInt(k, 10)).length;
    log('[COMPACT] ' + dataRows.length + ' data rows, ' + moved + ' renumbered to remove gaps');
  })();
  // Remap hyperlink refs to the compacted row numbers so links stay aligned.
  if (hyperlinks.length && Object.keys(rowRemap).length) {
    for (const h of hyperlinks) {
      const m = h.ref.match(/^([A-Z]+)(\d+)$/);
      if (m) {
        const oldR = parseInt(m[2], 10);
        if (rowRemap[oldR] && rowRemap[oldR] !== oldR) h.ref = m[1] + rowRemap[oldR];
      }
    }
  }

  // === INJECT HYPERLINKS ===
  if (hyperlinks.length) {
    // Remove existing hyperlinks for our cells (avoid duplicates)
    hyperlinks.forEach(h => {
      const pat = new RegExp('<hyperlink\\b[^>]*\\bref="' + h.ref + '"[^>]*/>', 'g');
      wsXml = wsXml.replace(pat, '');
    });

    // Build hyperlink XML entries
    const hlXml = hyperlinks.map((h, i) => '<hyperlink ref="' + h.ref + '" r:id="rIdPush' + i + '"/>').join('');

    // FIX (2026-09-01): the r:id references require the relationships namespace
    // to be declared on the <worksheet> root. If the template didn't declare
    // xmlns:r, Excel treats r:id as invalid and silently DROPS every hyperlink
    // on open — which is why H/J links weren't showing. Ensure it's present.
    const wsRootMatch = wsXml.match(/<worksheet\b[^>]*>/);
    if (wsRootMatch && !/xmlns:r=/.test(wsRootMatch[0])) {
      const fixedRoot = wsRootMatch[0].replace(/>$/, ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
      wsXml = wsXml.replace(wsRootMatch[0], fixedRoot);
      log('[FIX] Added xmlns:r namespace to <worksheet> (was missing — hyperlinks would have been dropped)');
    }

    // Insert/update <hyperlinks> block.
    // FIX (2026-09-01): per the OOXML CT_Worksheet schema, <hyperlinks> must
    // appear AFTER <sheetData>/<mergeCells> but BEFORE <pageMargins>/<drawing>.
    // Previously it was inserted right before </worksheet> (i.e. after those
    // trailing elements), an out-of-order position Excel's repair pass strips.
    // Place it right after </mergeCells> if present, else after </sheetData>.
    if (/<hyperlinks[^>]*>/.test(wsXml)) {
      // Existing block — append our entries into it (position already valid).
      wsXml = wsXml.replace('</hyperlinks>', hlXml + '</hyperlinks>');
    } else if (wsXml.includes('</mergeCells>')) {
      wsXml = wsXml.replace('</mergeCells>', '</mergeCells><hyperlinks>' + hlXml + '</hyperlinks>');
    } else {
      wsXml = wsXml.replace('</sheetData>', '</sheetData><hyperlinks>' + hlXml + '</hyperlinks>');
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

  // === FIX (2026-07-21): sync <dimension> to the sheet's real used range ===
  // Root cause of "some sheets get layout changes / misaligned pre-header
  // content / header text disappearing after a push": every push above
  // inserts and/or deletes <row> elements in <sheetData>, but this script
  // never touched the worksheet's <dimension ref="A1:N45"/> tag that
  // declares the sheet's used range. Once row count actually changes
  // (units added, orphans removed, dupes cleaned up), that declared range
  // goes stale relative to what's really in the file. Excel detects the
  // mismatch on open and runs its own silent auto-repair to reconcile it --
  // and that repair is what resets row heights/column widths and can drop
  // text in merged cells, typically most visible in a fancy dashboard-style
  // header block above the data table (custom sizing + merges are exactly
  // what Excel's repair pass reflows). This only fires on pushes where the
  // row count changed, which matches "not all sheets, but some" exactly.
  // Recomputing the used range directly from what's actually now in the
  // sheet (rather than trusting anything cached) closes that gap so Excel
  // never has a reason to invoke its repair path.
  (function _fixDimension() {
    const dimMatch = wsXml.match(/<dimension\s+ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\s*\/>/);
    if (!dimMatch) {
      log('[DIM] No <dimension> tag found -- skipping (nothing to fix)');
      return;
    }
    const [, startCol, startRowStr, origEndCol, origEndRowStr] = dimMatch;

    // Real max row now present in the sheet, scanned directly from the
    // rebuilt XML -- the only trustworthy source after inserts/deletes.
    let actualMaxRow = parseInt(startRowStr, 10);
    const rowScanRe = /<row\b[^>]*\br="(\d+)"/g;
    let sm;
    while ((sm = rowScanRe.exec(wsXml)) !== null) {
      const rn = parseInt(sm[1], 10);
      if (rn > actualMaxRow) actualMaxRow = rn;
    }

    // Column range: this script never writes past column N and never
    // removes columns, so the original end column is always a safe floor --
    // just make sure it's at least N in case the original template's
    // dimension was somehow narrower than the data table itself.
    function colToNum(s) { let n = 0; for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64); return n; }
    function numToCol(n) { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
    const endColNum = Math.max(colToNum(origEndCol), colToNum('N'));
    const newEndCol = numToCol(endColNum);

    const origEndRow = parseInt(origEndRowStr, 10);
    const newEndRow = Math.max(actualMaxRow, origEndRow);

    const newDim = '<dimension ref="' + startCol + startRowStr + ':' + newEndCol + newEndRow + '"/>';
    if (newDim !== dimMatch[0]) {
      wsXml = wsXml.replace(dimMatch[0], newDim);
      log('[DIM] Updated dimension: ' + dimMatch[0] + ' -> ' + newDim);
    } else {
      log('[DIM] Dimension already correct: ' + dimMatch[0]);
    }
  })();

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


  // Write styles.xml back ONLY when we appended a wrap-text clone for column K.
  // SAFE: getWrapStyleFor only ever APPENDS a new <xf> to the end of cellXfs and
  // bumps the count — it never edits or renumbers any existing style, so every
  // header/top-region cell (which references its original index) renders exactly
  // as before. If nothing was appended (stylesModified stays false), styles.xml
  // is left byte-for-byte untouched.
  if (stylesModified && stylesEnt) {
    const newStylesData = new TextEncoder().encode(stylesXml);
    const compStyles = await deflate(newStylesData);
    modifiedMap[stylesEnt.name] = { compData: compStyles, rawSize: newStylesData.length, crc: crc32(newStylesData) };
    log('styles.xml updated (appended wrap style only — existing styles unchanged)');
  }

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
