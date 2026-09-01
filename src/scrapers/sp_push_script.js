/**
 * sp_push_script.js
 * Injectable script that runs INSIDE the SP-authenticated BrowserWindow.
 * Downloads xlsx ONCE, modifies ALL carrier sheets in memory, re-uploads ONCE.
 *
 * FIX (2026-09-01): previously each carrier was a separate download->modify->upload
 * cycle on the same .xlsx file. SharePoint's write propagation isn't instant, so
 * the second carrier's download could grab the pre-first-carrier version and blank
 * its data on re-upload. Now: one download, one upload, all sheets in between.
 *
 * Called with: { filePath, sheets: [{sheetName, units, headerRow, carrierCode}], digest, dryRun }
 * Backward-compatible: also accepts old { filePath, sheetName, units, headerRow, digest } format.
 */

async function spPushWorksheet(config) {
  const SP = 'https://amazon.sharepoint.com';
  const results = { pushed: 0, updated: 0, removed: 0, errors: 0, log: [] };
  const log = (msg) => { results.log.push(msg); console.log('[SP Push]', msg); };

  // Backward compat: old single-sheet call -> wrap into sheets[]
  let sheets = config.sheets;
  if (!sheets && config.sheetName) {
    sheets = [{ sheetName: config.sheetName, units: config.units, headerRow: config.headerRow, carrierCode: '' }];
  }
  if (!sheets || !sheets.length) { log('No sheets to process.'); return results; }

  const { filePath, digest, dryRun } = config;

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED HELPERS (used by every sheet)
  // ═══════════════════════════════════════════════════════════════════════════

  function parseZip(buf) {
    const view = new DataView(buf);
    const entries = [];
    let idx = 0;
    while (idx < buf.byteLength - 4) {
      if (view.getUint32(idx, true) === 0x04034b50) {
        const flags = view.getUint16(idx + 6, true);
        const method = view.getUint16(idx + 8, true);
        let compSize = view.getUint32(idx + 18, true);
        const nameLen = view.getUint16(idx + 26, true);
        const extraLen = view.getUint16(idx + 28, true);
        const localHeaderSize = 30 + nameLen + extraLen;
        const nameBytes = new Uint8Array(buf, idx + 30, nameLen);
        let name = '';
        for (let n = 0; n < nameBytes.length; n++) name += String.fromCharCode(nameBytes[n]);
        const dataStart = idx + localHeaderSize;
        if ((flags & 0x08) && compSize === 0) {
          let scanIdx = dataStart;
          while (scanIdx < buf.byteLength - 4) {
            const sig = view.getUint32(scanIdx, true);
            if (sig === 0x04034b50 || sig === 0x02014b50) break;
            if (sig === 0x08074b50) { compSize = view.getUint32(scanIdx + 8, true); break; }
            scanIdx++;
          }
          if (compSize === 0) compSize = scanIdx - dataStart;
        }
        entries.push({ name, method, compSize, localHeader: new Uint8Array(buf, idx, localHeaderSize), compData: new Uint8Array(buf, dataStart, compSize) });
        idx = dataStart + compSize;
        if (flags & 0x08) {
          if (idx < buf.byteLength - 4 && view.getUint32(idx, true) === 0x08074b50) idx += 16;
          else if (idx < buf.byteLength - 12) idx += 12;
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
        parts.push(ent.localHeader); parts.push(ent.compData);
        const lhView = new DataView(ent.localHeader.buffer, ent.localHeader.byteOffset, ent.localHeader.byteLength);
        const _xLen = lhView.getUint16(28, true);
        const cd = new ArrayBuffer(46 + nameB.length + _xLen);
        const cv = new DataView(cd);
        cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true);
        cv.setUint16(6, lhView.getUint16(4, true), true); cv.setUint16(8, lhView.getUint16(6, true), true);
        cv.setUint16(10, lhView.getUint16(8, true), true); cv.setUint16(12, lhView.getUint16(10, true), true);
        cv.setUint16(14, lhView.getUint16(12, true), true); cv.setUint32(16, lhView.getUint32(14, true), true);
        cv.setUint32(20, lhView.getUint32(18, true), true); cv.setUint32(24, lhView.getUint32(22, true), true);
        cv.setUint16(28, nameB.length, true); cv.setUint16(30, _xLen, true);
        cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true);
        cv.setUint32(38, ent.externalAttrs || 0x20, true); cv.setUint32(42, offset, true);
        new Uint8Array(cd, 46).set(nameB);
        centralDir.push(new Uint8Array(cd));
        offset += ent.localHeader.length + ent.compData.length;
      } else {
        const lh = new ArrayBuffer(30 + nameB.length); const lv = new DataView(lh);
        lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
        lv.setUint16(6, 0, true); lv.setUint16(8, 8, true);
        lv.setUint16(10, 0, true); lv.setUint16(12, 0, true);
        lv.setUint32(14, mod.crc, true); lv.setUint32(18, mod.compData.length, true);
        lv.setUint32(22, mod.rawSize, true); lv.setUint16(26, nameB.length, true);
        lv.setUint16(28, 0, true);
        new Uint8Array(lh, 30).set(nameB);
        parts.push(new Uint8Array(lh)); parts.push(mod.compData);
        const cd = new ArrayBuffer(46 + nameB.length); const cv = new DataView(cd);
        cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
        cv.setUint16(8, 0, true); cv.setUint16(10, 8, true);
        cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
        cv.setUint32(16, mod.crc, true); cv.setUint32(20, mod.compData.length, true);
        cv.setUint32(24, mod.rawSize, true); cv.setUint16(28, nameB.length, true);
        cv.setUint32(42, offset, true);
        new Uint8Array(cd, 46).set(nameB);
        centralDir.push(new Uint8Array(cd));
        offset += 30 + nameB.length + mod.compData.length;
      }
    }
    let cdSize = 0; centralDir.forEach(cd => { parts.push(cd); cdSize += cd.length; });
    const eocd = new ArrayBuffer(22); const ev = new DataView(eocd);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true); ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true); parts.push(new Uint8Array(eocd));
    let totalSize = 0; parts.forEach(p => totalSize += p.length);
    const result = new Uint8Array(totalSize); let pos = 0;
    parts.forEach(p => { result.set(p, pos); pos += p.length; });
    return result;
  }

  function xmlEsc(v) { return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function normalizeId(v) { return String(v || '').replace(/[\n\r\s]+/g, '').replace(/^0+/, '').toLowerCase(); }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOWNLOAD ONCE
  // ═══════════════════════════════════════════════════════════════════════════

  log('Downloading: ' + filePath);
  const siteMatch = filePath.match(/(\/sites\/[^\/]+)/);
  const siteScope = siteMatch ? siteMatch[1] : '/sites/AFP-FAS';
  const fileUrl = SP + siteScope + "/_api/web/getfilebyserverrelativeurl('" + encodeURI(filePath).replace(/'/g, "''") + "')/$value";
  const resp = await fetch(fileUrl, { credentials: 'include' });
  if (!resp.ok) { log('ERROR: Download failed HTTP ' + resp.status); results.errors++; return results; }
  const buffer = await resp.arrayBuffer();
  log('Downloaded ' + (buffer.byteLength / 1024).toFixed(0) + ' KB');

  const entries = parseZip(buffer);
  log('ZIP entries: ' + entries.length);

  // Parse shared strings ONCE (shared across all sheets)
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

  // Styles (shared across all sheets — only appended to, never renumbered)
  const stylesEnt = entries.find(e => e.name === 'xl/styles.xml');
  let stylesModified = false;
  let stylesXml = '';
  const _wrapCloneByBase = {};
  let _cellXfsList = [];
  if (stylesEnt) {
    const stylesRaw = await inflate(stylesEnt.compData, stylesEnt.method);
    stylesXml = new TextDecoder().decode(stylesRaw);
    const cellXfsMatch = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
    if (cellXfsMatch) _cellXfsList = cellXfsMatch[1].match(/<xf\b[\s\S]*?(?:\/>|<\/xf>)/g) || [];
  }
  function getWrapStyleFor(baseIdx) {
    if (!stylesEnt || !_cellXfsList.length) return baseIdx || null;
    const key = (baseIdx == null || baseIdx === '') ? 'none' : String(baseIdx);
    if (_wrapCloneByBase[key] != null) return String(_wrapCloneByBase[key]);
    let baseXf = null;
    const bi = parseInt(baseIdx, 10);
    if (Number.isFinite(bi) && bi >= 0 && bi < _cellXfsList.length) baseXf = _cellXfsList[bi];
    let cloneXf;
    if (baseXf) {
      if (/wrapText="1"/.test(baseXf)) { _wrapCloneByBase[key] = bi; return String(bi); }
      if (/<alignment\b[^>]*\/>/.test(baseXf)) cloneXf = baseXf.replace(/<alignment\b([^>]*)\/>/, '<alignment$1 wrapText="1"/>');
      else if (/<alignment\b[^>]*>[\s\S]*?<\/alignment>/.test(baseXf)) cloneXf = baseXf.replace(/<alignment\b([^>]*)>/, '<alignment$1 wrapText="1">');
      else if (/<xf\b[^>]*\/>/.test(baseXf)) cloneXf = baseXf.replace(/<xf\b([^>]*)\/>/, '<xf$1 applyAlignment="1"><alignment wrapText="1"/></xf>');
      else { cloneXf = baseXf.replace(/<xf\b([^>]*)>/, '<xf$1 applyAlignment="1"><alignment wrapText="1"/>').replace(/<\/xf>?$/, '</xf>'); if (!/<\/xf>$/.test(cloneXf)) cloneXf += '</xf>'; }
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

  function getCellValue(cellXml) {
    const t = (cellXml.match(/\bt="([^"]+)"/) || [])[1] || '';
    if (t === 'inlineStr') {
      const ism = cellXml.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
      if (ism) return ism[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#10;/g,'\n');
      return '';
    }
    const vm = cellXml.match(/<v>([\s\S]*?)<\/v>/);
    if (!vm) {
      const fallback = cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      if (fallback) return fallback[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
      return '';
    }
    const raw = vm[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    if (t === 's') return sharedStrings[parseInt(raw, 10)] || '';
    return raw;
  }

  function buildCell(col, row, value, existingStyle) {
    const ref = col + row;
    const v = String(value || '');
    const styleAttr = existingStyle ? ' s="' + existingStyle + '"' : '';
    if (!v) return '<c r="' + ref + '"' + styleAttr + ' t="inlineStr"><is><t></t></is></c>';
    const escaped = xmlEsc(v).replace(/\n/g, '&#10;');
    return '<c r="' + ref + '"' + styleAttr + ' t="inlineStr"><is><t xml:space="preserve">' + escaped + '</t></is></c>';
  }

  function buildRow(rowNum, unitData, existingRowXml) {
    const cols = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N'];
    const existingStyles = {};
    if (existingRowXml) {
      const cellStyleRe = /<c\b[^>]*\br="([A-Z]+)\d+"[^>]*?\bs="(\d+)"[^>]*/g;
      let csm;
      while ((csm = cellStyleRe.exec(existingRowXml)) !== null) existingStyles[csm[1]] = csm[2];
    }
    let rowAttrs = 'r="' + rowNum + '" spans="1:14"';
    if (existingRowXml) {
      const attrMatch = existingRowXml.match(/<row\b([^>]*)>/);
      if (attrMatch) { let attrs = attrMatch[1]; attrs = attrs.replace(/\br="\d+"/, 'r="' + rowNum + '"'); rowAttrs = attrs; }
    }
    const cells = cols.map((c, i) => {
      let styleForCell = existingStyles[c];
      if (c === 'K') {
        const kv = String(unitData[i] || '');
        if (kv.length > 40 || /\n/.test(kv)) { const ws = getWrapStyleFor(existingStyles[c]); if (ws != null) styleForCell = ws; }
      }
      return buildCell(c, rowNum, unitData[i] || '', styleForCell);
    }).join('');
    return '<row ' + rowAttrs + '>' + cells + '</row>';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROCESS EACH SHEET (in memory, same ZIP entries)
  // ═══════════════════════════════════════════════════════════════════════════

  const modifiedMap = {};
  let anyModified = false;

  for (const sheetCfg of sheets) {
    const { sheetName, units, headerRow, carrierCode } = sheetCfg;
    const sheetLabel = (carrierCode || '') + ' ' + sheetName;

    // Find worksheet entry
    const wsName = 'xl/worksheets/' + sheetName.toLowerCase().replace('sheet', 'sheet') + '.xml';
    const wsEnt = entries.find(e => e.name.toLowerCase() === wsName.toLowerCase());
    if (!wsEnt) {
      log('[' + sheetLabel + '] ERROR: Worksheet not found: ' + wsName);
      results.errors++;
      continue;
    }
    log('[' + sheetLabel + '] Found worksheet: ' + wsEnt.name);

    const wsRaw = await inflate(wsEnt.compData, wsEnt.method);
    let wsXml = new TextDecoder().decode(wsRaw);

    // Auto-find header row from the live sheet
    let _hr = parseInt(headerRow, 10);
    if (!Number.isFinite(_hr) || _hr < 1) _hr = 16;

    (function _autoFindHeaderRow() {
      function rowSigText(cellsXml) {
        let txt = '';
        const cRe = /<c\b[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g; let ccm;
        while ((ccm = cRe.exec(cellsXml)) !== null) {
          const cx = ccm[0]; const ta = (cx.match(/\bt="([^"]+)"/) || [])[1] || '';
          const vv = cx.match(/<v>([\s\S]*?)<\/v>/);
          if (ta === 's' && vv) txt += ' ' + (sharedStrings[parseInt(vv[1], 10)] || '');
          else { const im = cx.match(/<t[^>]*>([\s\S]*?)<\/t>/); if (im) txt += ' ' + im[1]; else if (vv) txt += ' ' + vv[1]; }
        }
        return txt.toUpperCase();
      }
      let found = 0;
      const scanRe = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g; let scm;
      while ((scm = scanRe.exec(wsXml)) !== null) {
        const rNum = parseInt(scm[1], 10);
        if (rNum > 60) break;
        const tu = rowSigText(scm[2]);
        if (tu.includes('CARRIER') && tu.includes('UNIT') && (tu.includes('BODY TYPE') || tu.includes('REPAIR UPDATES') || tu.includes('LIFECYCLE'))) { found = rNum; break; }
      }
      if (found) {
        if (found !== _hr) log('[' + sheetLabel + '] [HEADER] auto-located at row ' + found + ' (config hint ' + _hr + ')');
        else log('[' + sheetLabel + '] [HEADER] confirmed at row ' + found);
        _hr = found;
      } else {
        log('[' + sheetLabel + '] ERROR: header band not found in rows 1-60. Skipping sheet.');
        results.errors++; sheetCfg._skip = true;
      }
    })();
    if (sheetCfg._skip) continue;

    // Read existing data rows
    const existingUnits = {};
    let maxDataRow = _hr;
    const rowRe = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g; let rm;
    while ((rm = rowRe.exec(wsXml)) !== null) {
      const rowNum = parseInt(rm[1], 10);
      if (rowNum <= _hr) continue;
      const cellRe = /<c\b[^>]*\br="B\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/;
      const cm = cellRe.exec(rm[2]);
      if (cm) { const val = normalizeId(getCellValue(cm[0])); if (val) { existingUnits[val] = rowNum; if (rowNum > maxDataRow) maxDataRow = rowNum; } }
    }
    log('[' + sheetLabel + '] Existing: ' + Object.keys(existingUnits).length + ' units, max row ' + maxDataRow);

    // UPDATE / INSERT
    let modified = false;
    const hyperlinks = [];

    for (const unitObj of units) {
      const unit = Array.isArray(unitObj) ? unitObj : unitObj.values;
      const urls = Array.isArray(unitObj) ? {} : (unitObj.urls || {});
      const unitId = String(unit[1] || '');
      if (!unitId) continue;
      const nid = normalizeId(unitId);
      const existingRow = existingUnits[nid];
      const isActive = String(unit[4] || '').toUpperCase() === 'ACTIVE';
      if (isActive && !existingRow) continue;
      const targetRow = existingRow || (++maxDataRow);
      if (targetRow <= _hr) { log('[' + sheetLabel + '] [SKIP] ' + unitId + ' row ' + targetRow + ' <= header ' + _hr); continue; }

      log('[' + sheetLabel + '] [ROW ' + targetRow + (existingRow ? ' UPDATE' : ' NEW') + (isActive ? ' ACTIVE' : '') + '] ' + unitId + ' | E:' + unit[4] + ' | F:' + (unit[5]||'--') + ' | L:' + (unit[11]||'--'));

      let existingRowXml = null;
      if (existingRow) {
        const rf = new RegExp('<row\\b[^>]*\\br="' + targetRow + '"[^>]*>[\\s\\S]*?<\\/row>');
        const em = wsXml.match(rf); if (em) existingRowXml = em[0];
      }
      const newRowXml = buildRow(targetRow, unit, existingRowXml);

      if (!isActive) {
        if (urls.H) hyperlinks.push({ ref: 'H' + targetRow, url: urls.H });
        if (urls.I) hyperlinks.push({ ref: 'I' + targetRow, url: urls.I });
        if (urls.J) hyperlinks.push({ ref: 'J' + targetRow, url: urls.J });
      }

      if (existingRow) {
        const rp = new RegExp('<row\\b[^>]*\\br="' + targetRow + '"[^>]*>[\\s\\S]*?<\\/row>');
        if (rp.test(wsXml)) { wsXml = wsXml.replace(rp, newRowXml); results.updated++; }
        else { wsXml = wsXml.replace('</sheetData>', newRowXml + '</sheetData>'); results.pushed++; }
      } else {
        wsXml = wsXml.replace('</sheetData>', newRowXml + '</sheetData>'); results.pushed++;
      }
      modified = true;
    }

    // ORPHAN REMOVAL
    const pushedIds = new Set(units.map(u => { const v = Array.isArray(u) ? u : u.values; return normalizeId(v[1] || ''); }));
    for (const [eid, rn] of Object.entries(existingUnits)) {
      if (!pushedIds.has(eid)) {
        const rp = new RegExp('<row\\b[^>]*\\br="' + rn + '"[^>]*>[\\s\\S]*?<\\/row>');
        if (rp.test(wsXml)) { wsXml = wsXml.replace(rp, ''); log('[' + sheetLabel + '] [DELETED] ' + eid + ' row ' + rn); results.removed++; modified = true; }
      }
    }

    // DEDUP
    const seenRows = {};
    const ddRe = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g; let ddm;
    while ((ddm = ddRe.exec(wsXml)) !== null) {
      const rn = parseInt(ddm[1], 10);
      if (rn <= _hr) continue;
      const cm2 = /<c\b[^>]*\br="B\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/.exec(ddm[2]);
      if (cm2) {
        const val = normalizeId(getCellValue(cm2[0]));
        if (val) { if (seenRows[val]) { wsXml = wsXml.replace(ddm[0], ''); log('[' + sheetLabel + '] [DEDUP] ' + val + ' row ' + rn); results.removed++; modified = true; } else seenRows[val] = rn; }
      }
    }

    if (!modified) { log('[' + sheetLabel + '] No changes.'); continue; }
    anyModified = true;
    log('[' + sheetLabel + '] Modified: ' + results.updated + ' upd, ' + results.pushed + ' new');

    // COMPACT (remove blank gaps)
    const rowRemap = {};
    (function() {
      const sdM = wsXml.match(/([\s\S]*?<sheetData[^>]*>)([\s\S]*?)(<\/sheetData>[\s\S]*)/);
      if (!sdM) { log('[' + sheetLabel + '] [COMPACT] no <sheetData> — skipping'); return; }
      const head = sdM[1], body = sdM[2], tail = sdM[3];

      // Walk the body ONCE, in document order, keeping every row token exactly
      // as-is. Rows <= headerRow (top/header region) are emitted UNCHANGED and
      // in place. Data rows (> headerRow) that actually contain a unit id in
      // column B are renumbered CONTIGUOUSLY starting at headerRow+1; empty /
      // gap rows are DROPPED (that's what removes the blank holes). Anything
      // between rows (whitespace/text) is preserved.
      //
      // IMPORTANT: this REBUILDS the body by concatenation instead of doing
      // string find-and-replace per row. The old replace approach corrupted
      // sheets where one row's XML was a substring of another's (common with
      // many near-empty rows), which is what was blanking SAPB's sheet3.
      const rowTokenRe = /<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
      let out = '';
      let lastIndex = 0;
      let next = _hr + 1;
      let dataCount = 0, dropped = 0, moved = 0;
      let mt;
      while ((mt = rowTokenRe.exec(body)) !== null) {
        // Preserve any inter-row text (whitespace) exactly.
        out += body.slice(lastIndex, mt.index);
        lastIndex = mt.index + mt[0].length;

        const rowXml = mt[0];
        const rnMatch = rowXml.match(/\br="(\d+)"/);
        const rn = rnMatch ? parseInt(rnMatch[1], 10) : 0;

        // Header/top region — emit unchanged, never touch.
        if (!rn || rn <= _hr) { out += rowXml; continue; }

        // Does this data row actually hold a unit id in column B?
        const bCell = /<c\b[^>]*\br="B\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/.exec(rowXml);
        const hasUnit = bCell && normalizeId(getCellValue(bCell[0]));
        if (!hasUnit) { dropped++; continue; } // blank/gap row -> drop it

        dataCount++;
        const nr = next++;
        rowRemap[rn] = nr;
        if (nr === rn) { out += rowXml; continue; }
        moved++;
        // Renumber the row and every cell ref inside it.
        let rx = rowXml.replace(/(<row\b[^>]*\br=")\d+(")/, '$1' + nr + '$2');
        rx = rx.replace(/(\br=")([A-Z]+)\d+(")/g, '$1$2' + nr + '$3');
        out += rx;
      }
      out += body.slice(lastIndex); // trailing text after last row
      wsXml = head + out + tail;
      log('[' + sheetLabel + '] [COMPACT] ' + dataCount + ' data rows, ' + moved + ' renumbered, ' + dropped + ' blank rows dropped');
    })();
    // Remap hyperlink refs
    if (hyperlinks.length) {
      for (const h of hyperlinks) {
        const m = h.ref.match(/^([A-Z]+)(\d+)$/);
        if (m) { const or = parseInt(m[2], 10); if (rowRemap[or] && rowRemap[or] !== or) h.ref = m[1] + rowRemap[or]; }
      }
    }

    // INJECT HYPERLINKS
    if (hyperlinks.length) {
      hyperlinks.forEach(h => { wsXml = wsXml.replace(new RegExp('<hyperlink\\b[^>]*\\bref="' + h.ref + '"[^>]*/>', 'g'), ''); });
      const hlXml = hyperlinks.map((h, i) => '<hyperlink ref="' + h.ref + '" r:id="rIdPush' + i + '"/>').join('');
      // Ensure xmlns:r
      const wrMatch = wsXml.match(/<worksheet\b[^>]*>/);
      if (wrMatch && !/xmlns:r=/.test(wrMatch[0])) {
        wsXml = wsXml.replace(wrMatch[0], wrMatch[0].replace(/>$/, ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'));
        log('[' + sheetLabel + '] [FIX] Added xmlns:r');
      }
      // Insert in correct OOXML position
      if (/<hyperlinks[^>]*>/.test(wsXml)) wsXml = wsXml.replace('</hyperlinks>', hlXml + '</hyperlinks>');
      else if (wsXml.includes('</mergeCells>')) wsXml = wsXml.replace('</mergeCells>', '</mergeCells><hyperlinks>' + hlXml + '</hyperlinks>');
      else wsXml = wsXml.replace('</sheetData>', '</sheetData><hyperlinks>' + hlXml + '</hyperlinks>');

      // Rels
      const wsFileName = wsEnt.name.split('/').pop();
      const relsName = 'xl/worksheets/_rels/' + wsFileName + '.rels';
      let relsEnt = entries.find(e => e.name === relsName);
      let relsXml = '';
      if (relsEnt) { relsXml = new TextDecoder().decode(await inflate(relsEnt.compData, relsEnt.method)); }
      else { relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'; }
      relsXml = relsXml.replace(/<Relationship\b[^>]*\bId="rIdPush\d+"[^>]*\/>/g, '');
      const newRels = hyperlinks.map((h, i) => '<Relationship Id="rIdPush' + i + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + xmlEsc(h.url) + '" TargetMode="External"/>').join('');
      relsXml = relsXml.replace('</Relationships>', newRels + '</Relationships>');
      const newRD = new TextEncoder().encode(relsXml);
      const compR = await deflate(newRD);
      if (relsEnt) { modifiedMap[relsEnt.name] = { compData: compR, rawSize: newRD.length, crc: crc32(newRD) }; }
      else { entries.push({ name: relsName, method: 8, compData: compR, compSize: compR.length, localHeader: new Uint8Array(30 + relsName.length), _new: true }); modifiedMap[relsName] = { compData: compR, rawSize: newRD.length, crc: crc32(newRD) }; }
      log('[' + sheetLabel + '] Hyperlinks: ' + hyperlinks.length + ' added');
    }

    // DIMENSION FIX
    (function() {
      const dm = wsXml.match(/<dimension\s+ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\s*\/>/);
      if (!dm) { log('[' + sheetLabel + '] [DIM] No tag — skipping'); return; }
      let actualMax = parseInt(dm[2], 10);
      const rsc = /<row\b[^>]*\br="(\d+)"/g; let sm;
      while ((sm = rsc.exec(wsXml)) !== null) { const rn = parseInt(sm[1], 10); if (rn > actualMax) actualMax = rn; }
      function c2n(s) { let n = 0; for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64); return n; }
      function n2c(n) { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
      const ec = n2c(Math.max(c2n(dm[3]), c2n('N')));
      const er = Math.max(actualMax, parseInt(dm[4], 10));
      const nd = '<dimension ref="' + dm[1] + dm[2] + ':' + ec + er + '"/>';
      if (nd !== dm[0]) { wsXml = wsXml.replace(dm[0], nd); log('[' + sheetLabel + '] [DIM] ' + dm[0] + ' -> ' + nd); }
      else log('[' + sheetLabel + '] [DIM] OK: ' + dm[0]);
    })();

    // Store modified worksheet XML
    const newWsData = new TextEncoder().encode(wsXml);
    const compWs = await deflate(newWsData);
    modifiedMap[wsEnt.name] = { compData: compWs, rawSize: newWsData.length, crc: crc32(newWsData) };
  }
  // END per-sheet loop

  if (!anyModified) { log('No changes across any sheet.'); return results; }

  // ═══════════════════════════════════════════════════════════════════════════
  // STYLES (once, if any sheet used wrap)
  // ═══════════════════════════════════════════════════════════════════════════
  if (stylesModified && stylesEnt) {
    const nsd = new TextEncoder().encode(stylesXml);
    const cs = await deflate(nsd);
    modifiedMap[stylesEnt.name] = { compData: cs, rawSize: nsd.length, crc: crc32(nsd) };
    log('styles.xml updated (appended wrap style only)');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REBUILD ZIP ONCE + UPLOAD ONCE
  // ═══════════════════════════════════════════════════════════════════════════
  const newZip = rebuildZip(entries, modifiedMap);
  log('New ZIP size: ' + (newZip.length / 1024).toFixed(0) + ' KB');

  // Validate
  const zv = new DataView(newZip.buffer || newZip);
  if (zv.getUint32(0, true) !== 0x04034b50) { log('ERROR: Invalid ZIP signature'); results.errors++; return results; }
  if (newZip.length < 1000) { log('ERROR: ZIP too small (' + newZip.length + ')'); results.errors++; return results; }
  log('ZIP validation passed: ' + newZip.length + ' bytes, starts with PK');

  if (dryRun) { log('DRY RUN — skipping upload'); return results; }

  const uploadUrl = SP + siteScope + "/_api/web/getfilebyserverrelativeurl('" + encodeURI(filePath).replace(/'/g, "''") + "')/$value";
  const upResp = await fetch(uploadUrl, {
    method: 'PUT', credentials: 'include',
    headers: { 'X-RequestDigest': digest, 'Content-Type': 'application/octet-stream', 'X-HTTP-Method': 'PUT' },
    body: newZip
  });
  if (upResp.ok) log('Upload SUCCESS');
  else { log('ERROR: Upload failed HTTP ' + upResp.status); results.errors++; }

  return results;
}
