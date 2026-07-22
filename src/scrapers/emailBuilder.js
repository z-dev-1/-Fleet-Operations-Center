'use strict';
/**
 * emailBuilder.js — Universal table-based fleet email (v5 color scheme)
 * Light content area + dark text = works in both light and dark mode
 * Uses <font> tags to survive OWA paste sanitizer
 */
const fs   = require('fs');
const path = require('path');
const logger = require('../utils/logger').createLogger('emailBuilder');
const TEMPLATE_PATH = path.join(__dirname, 'email_template.html');

function ft(color, text, extra) {
  return `<font color="${color}" face="Arial,sans-serif"${extra ? ' style="'+extra+'"' : ''}>${text}</font>`;
}
function buildEmail(opts) {
  const { operator, domicile, units, slot, testMode, relayCache, notesStore, emailNote } = opts;
  let template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  // Merge relay cache + notes into units (fills in altId, vendor, duration etc. from cache)
  const allUnits = (units || []).map(u => {
    const rc = (relayCache && relayCache[u.id]) || {};
    const ns = (notesStore && notesStore[u.id]) || {};

    // Model/Make: prefer relay cache (FREIGHTLINER, VOLVO etc.) over Uptake (MODEL YEAR 2021)
    let model = u.model || '';
    if (rc.model && !rc.model.match(/^MODEL YEAR/i)) model = rc.model;
    else if (model.match(/^MODEL YEAR/i) && rc.model) model = rc.model;
    // If still "MODEL YEAR..." check relay cache make field
    if (model.match(/^MODEL YEAR/i) && rc.make) model = rc.make;

    return {
      ...u,
      model: model,

      altId: u.altId || rc.altId || ns.altId || '',
      serviceUrl: u.serviceUrl || rc.serviceUrl || '',
      vendor: u.vendor || rc.vendor || ns.vendor || '',
      created: u.created || rc.created || ns.created || '',
      duration: u.duration || rc.duration || ns.duration || '',
      issue: u.issue || rc.issue || ns.issue || '',
      offsiteShopEvent: u.offsiteShopEvent || rc.offsiteShopEvent || ns.savedOffsiteEvent || '',
      offsiteShopEventUrl: u.offsiteShopEventUrl || rc.offsiteShopEventUrl || ns.savedOffsiteUrl || '',
      savedSalesforceCase: u.savedSalesforceCase || ns.savedSalesforceCase || '',
      issueSummary: u.issueSummary || ns.issueSummary || '',
      repairTimeline: u.repairTimeline || ns.timeline || '',
      savedTimeline: ns.timeline || '',
      savedSalesforceCaseUrl: u.savedSalesforceCaseUrl || ns.savedSalesforceCaseUrl || '',
      dealerName:             u.dealerName || rc.dealerName || ns.dealerName || '',
      subVendor:              u.subVendor || u.dealerName || rc.dealerName || ns.subVendor || ((/offsite/i.test(u.relayStatus||'')) ? (u.geofence||'') : '') || '',
    };
  });



  const now = new Date();
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const h = now.getHours(), m = now.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const mm = m < 10 ? '0' + m : '' + m;
  const datetime = days[now.getDay()] + ', ' + months[now.getMonth()] + ' ' + now.getDate() + ', ' + now.getFullYear() + ' \u2014 ' + h12 + ':' + mm + ' ' + ampm + ' EDT';

  const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const slotLabel = slot || (h < 14 ? 'AM' : 'PM');
  const site = domicile || 'ALL';
  const op = (operator || '').toUpperCase();

  // Slot badge colors (solid hex — Outlook doesn't render rgba)
  const slotBg = slotLabel === 'AM' ? '#e0eeff' : '#fff4d9';
  const slotBorder = slotLabel === 'AM' ? '#7ab3f0' : '#e6b84d';
  const slotColor = slotLabel === 'AM' ? '#1a56db' : '#b87a00';
  const slotIcon = slotLabel === 'AM' ? '\u2600' : '\uD83C\uDF06';
  const slotDisplayLabel = slotLabel === 'AM' ? 'SOS REPORT' : 'EOS REPORT';

  // Filter units
  let filteredUnits;

  if (domicile && domicile !== 'ALL') {
    filteredUnits = allUnits.filter(u => (u.op || '').toUpperCase() === op && (u.site || '').toUpperCase() === domicile.toUpperCase());
  } else {
    filteredUnits = allUnits.filter(u => (u.op || '').toUpperCase() === op);
  }

  const unavailUnits = filteredUnits.filter(u => (u.atsState||u.lifecycleState) && (u.atsState||u.lifecycleState).toLowerCase().indexOf('unavail') > -1);
  const totalUnits = filteredUnits.length;
  const inService = totalUnits - unavailUnits.length;

  // Accent bar text — DESIGN UPDATE (2026-07-21): the bar itself is now a
  // permanent part of the template shell (always rendered, see
  // email_template.html), not conditional. Only the text inside it is
  // conditional: blank by default, "TEST" only during an actual test send.
  const testBanner = testMode ? 'TEST' : '&nbsp;';

  // KPI strip — DESIGN ADD (2026-07-21): quick-glance totals row.
  const inServicePct = totalUnits > 0 ? Math.round((inService / totalUnits) * 100) : 0;
  const kpiStrip = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
<td width="33%" style="padding:10px;text-align:center;background-color:#f3f6fa;border-radius:8px 0 0 8px;">${ft('#0f1b2d','<b>'+totalUnits+'</b>','font-size:20px')}<br>${ft('#64748a','TOTAL UNITS','font-size:9px;letter-spacing:0.05em')}</td>
<td width="33%" style="padding:10px;text-align:center;background-color:#fdeceb;">${ft('#b91c1c','<b>'+unavailUnits.length+'</b>','font-size:20px')}<br>${ft('#64748a','UNAVAILABLE','font-size:9px;letter-spacing:0.05em')}</td>
<td width="34%" style="padding:10px;text-align:center;background-color:#eaf7ef;border-radius:0 8px 8px 0;">${ft('#15803d','<b>'+inServicePct+'%</b>','font-size:20px')}<br>${ft('#64748a','FLEET IN-SERVICE','font-size:9px;letter-spacing:0.05em')}</td>
</tr></table>`;

  // Vendor chips — DESIGN ADD (2026-07-21): quick vendor-load-at-a-glance,
  // counted from currently unavailable units only (active vendor workload).
  const vendorCounts = {};
  unavailUnits.forEach(u => { const v = (u.vendor || '').trim(); if (v) vendorCounts[v] = (vendorCounts[v] || 0) + 1; });
  const vendorNames = Object.keys(vendorCounts);
  let vendorChips = '';
  if (vendorNames.length) {
    vendorChips = ft('#64748a', 'ACTIVE VENDORS:&nbsp;', 'font-size:9px;letter-spacing:0.05em') +
      vendorNames.map(v => `<table cellpadding="0" cellspacing="0" border="0" style="display:inline;"><tr><td style="background-color:#eef2f7;border-radius:10px;padding:3px 10px;">${ft('#334155','<b>'+v.toUpperCase()+': '+vendorCounts[v]+'</b>','font-size:9px')}</td></tr></table>&nbsp;`).join('');
  }

  const noteBar = emailNote
    ? `<tr><td style="padding:10px 16px;"><font color="#dc2626" face="Arial,sans-serif" style="font-size:12px;font-weight:bold;">NOTE: ${emailNote.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</font></td></tr>`
    : '';

  // Fleet summary — split by body type (Day Cab + Sleeper side by side)
  function buildSummaryCard(title, units) {
    const total = units.length;
    const oos = units.filter(u => (u.atsState||u.lifecycleState) && (u.atsState||u.lifecycleState).toLowerCase().indexOf('unavail') > -1).length;
    const svc = total - oos;
    const pct = total > 0 ? Math.round((svc / total) * 100) : 0;
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block;vertical-align:top;min-width:380px;margin-right:16px;margin-bottom:12px;border:1px solid #dde1e6;border-radius:6px;overflow:hidden;">
<tr><td bgcolor="#00a3bf" style="background-color:#00a3bf;padding:7px 12px;text-align:center;">${ft('#ffffff', '<b>' + title + ' &#8212; ' + op + '</b>', 'font-size:11px;letter-spacing:0.05em')}</td></tr>
<tr><td style="padding:0;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
<tr bgcolor="#e8edf3">
<th style="padding:5px 10px;text-align:center;border-bottom:1px solid #e0e4ea;border-right:1px solid #e8ebef;">${ft('#333333','<b>CARRIER</b>','font-size:9px')}</th>
<th style="padding:5px 10px;text-align:center;border-bottom:1px solid #e0e4ea;border-right:1px solid #e8ebef;">${ft('#333333','<b>OUT OF SERVICE</b>','font-size:9px')}</th>
<th style="padding:5px 10px;text-align:center;border-bottom:1px solid #e0e4ea;border-right:1px solid #e8ebef;">${ft('#333333','<b>IN SERVICE</b>','font-size:9px')}</th>
<th style="padding:5px 10px;text-align:center;border-bottom:1px solid #e0e4ea;border-right:1px solid #e8ebef;">${ft('#333333','<b>TOTAL</b>','font-size:9px')}</th>
<th style="padding:5px 10px;text-align:center;border-bottom:1px solid #e0e4ea;">${ft('#333333','<b>IN-SVC %</b>','font-size:9px')}</th>
</tr>
<tr>
<td style="padding:6px 10px;text-align:center;border-bottom:1px solid #eaecef;border-right:1px solid #eaecef;">${ft('#1e2d3d','<b>'+op+'</b>','font-size:11px')}</td>
<td bgcolor="#fecaca" style="background-color:#fecaca;padding:6px 10px;text-align:center;border-bottom:1px solid #eaecef;border-right:1px solid #eaecef;">${ft('#991b1b','<b>'+oos+'</b>','font-size:11px')}</td>
<td bgcolor="#bbf7d0" style="background-color:#bbf7d0;padding:6px 10px;text-align:center;border-bottom:1px solid #eaecef;border-right:1px solid #eaecef;">${ft('#166534','<b>'+svc+'</b>','font-size:11px')}</td>
<td style="padding:6px 10px;text-align:center;border-bottom:1px solid #eaecef;border-right:1px solid #eaecef;">${ft('#1e2d3d','<b>'+total+'</b>','font-size:11px')}</td>
<td style="padding:6px 10px;text-align:center;border-bottom:1px solid #eaecef;">${ft('#1a56db','<b>'+pct+'%</b>','font-size:11px')}</td>
</tr>
<tr bgcolor="#00a3bf">
<td style="padding:6px 10px;text-align:center;border-right:1px solid #33a8cc;">${ft('#ffffff','<b>Total</b>','font-size:11px')}</td>
<td style="padding:6px 10px;text-align:center;border-right:1px solid #33a8cc;">${ft('#ffffff','<b>'+oos+'</b>','font-size:11px')}</td>
<td style="padding:6px 10px;text-align:center;border-right:1px solid #33a8cc;">${ft('#ffffff','<b>'+svc+'</b>','font-size:11px')}</td>
<td style="padding:6px 10px;text-align:center;border-right:1px solid #33a8cc;">${ft('#ffffff','<b>'+total+'</b>','font-size:11px')}</td>
<td style="padding:6px 10px;text-align:center;">${ft('#ffffff','<b>'+pct+'%</b>','font-size:11px')}</td>
</tr>
</table>
</td></tr>
</table>`;
  }
  const dayCabs = filteredUnits.filter(u => /day\s*cab|tractor/i.test(u.bodyType || ''));
  const sleepers = filteredUnits.filter(u => /sleeper/i.test(u.bodyType || ''));
  const boxTrucks = filteredUnits.filter(u => /box/i.test(u.bodyType || ''));
  const others = filteredUnits.filter(u => !dayCabs.includes(u) && !sleepers.includes(u) && !boxTrucks.includes(u));

  // Build cards array
  let cards = [];
  if (dayCabs.length) cards.push(buildSummaryCard('DAY CAB', dayCabs));
  if (sleepers.length) cards.push(buildSummaryCard('SLEEPER', sleepers));
  if (boxTrucks.length) cards.push(buildSummaryCard('BOX TRUCK', boxTrucks));
  if (others.length) cards.push(buildSummaryCard('OTHER', others));
  if (!cards.length) cards.push(buildSummaryCard('ALL UNITS', filteredUnits));

  // Wrap in a table layout so they sit side by side (email clients ignore inline-block)
  let fleetSummary = '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>';
  cards.forEach(card => { fleetSummary += '<td valign="top" style="padding-right:12px;">' + card + '</td>'; });
  fleetSummary += '</tr></table>';


  let unavailTable = '';
  if (unavailUnits.length) {
    const hdrTh = (text) => `<th bgcolor="#475569" style="background-color:#475569;padding:6px 8px;text-align:left;border-bottom:1px solid #dde1e6;border-right:1px solid #e8ebef;white-space:nowrap;">${ft('#f1f5f9','<b>'+text+'</b>','font-size:9px;letter-spacing:0.07em')}</th>`;

    let rows = '';
    unavailUnits.forEach((u, i) => {
      const bg = '#fff5f5'; // light pink for unavail rows
      const makeRaw = (u.model || '').toLowerCase();
      let makeBg = '#f3f4f6', makeLbl = u.model || '--', makeColor = '#374151';
      if (makeRaw.includes('freightliner')) { makeBg = '#e5e7eb'; makeLbl = 'FREIGHTLINER'; makeColor = '#1f2937'; }
      else if (makeRaw.includes('volvo'))   { makeBg = '#dbeafe'; makeLbl = 'VOLVO'; makeColor = '#1e3a5f'; }
      else if (makeRaw.includes('peterbilt')){ makeBg = '#fee2e2'; makeLbl = 'PETERBILT'; makeColor = '#7f1d1d'; }
      else if (makeRaw.includes('kenworth')) { makeBg = '#fef3c7'; makeLbl = 'KENWORTH'; makeColor = '#78350f'; }
      else if (makeRaw.includes('mack'))    { makeBg = '#fed7aa'; makeLbl = 'MACK'; makeColor = '#78350f'; }

      const repairStatus = u.savedRepairStatus || u.relayStatus || '--';
      let rsColor = '#555555';
      if (/repairs in progress/i.test(repairStatus)) rsColor = '#d97706';
      else if (/amerit/i.test(repairStatus)) rsColor = '#7c3aed';
      else if (/done|complete/i.test(repairStatus)) rsColor = '#16a34a';

      const vendor = u.vendor || '';
      const created = u.created || '';
      const duration = u.duration || '';
      const issue = u.issue || '';
      const timeline = u.repairTimeline || u.savedTimeline || '';
      // BUG FIX (2026-07-16): previously fell back to u.savedNotes (the
      // free-text "Add notes..." field on the unit detail panel -- a
      // personal/internal scratchpad, NOT the repair timeline) whenever a
      // unit had no timeline yet. That meant private notes could go out
      // in the business-partner-facing status email. User confirmed:
      // timeline content is fine to send, but savedNotes should stay
      // internal-only, always -- never fall back to it here.
      const notes = timeline ? timeline.split('\n').filter(l => l.trim().length > 5).map(l => l.trim()).join('<br>') : '\u2014';

      // Case / Offsite: Alt ID + Offsite Event + Salesforce Case (all hyperlinked)
      let caseHtml = '';
      const altId = u.altId || '';
      const offsiteEvent = u.offsiteShopEvent || u.savedOffsiteEvent || '';
      const offsiteUrl = u.offsiteShopEventUrl || u.savedOffsiteUrl || '';
      const sfCase = u.savedSalesforceCase || '';
      const sfUrl = u.savedSalesforceCaseUrl || '';

      const serviceUrl = u.serviceUrl || '';
      if (altId) {
        if (serviceUrl) caseHtml += ft('#555555', 'Alt ID: ', 'font-size:9px') + '<a href="' + serviceUrl + '" style="color:#1a56db;font-size:9px;font-weight:bold;text-decoration:underline;">' + altId + '</a><br>';
        else caseHtml += ft('#555555', 'Alt ID: ', 'font-size:9px') + ft('#1a56db', '<b>' + altId + '</b>', 'font-size:9px') + '<br>';
      }
      if (offsiteEvent) {
        if (offsiteUrl) caseHtml += ft('#555555', 'Offsite: ', 'font-size:9px') + '<a href="' + offsiteUrl + '" style="color:#1a56db;font-size:9px;font-weight:bold;text-decoration:underline;">' + offsiteEvent + '</a><br>';
        else caseHtml += ft('#555555', 'Offsite: ', 'font-size:9px') + ft('#1a56db', '<b>' + offsiteEvent + '</b>', 'font-size:9px') + '<br>';
      }
      if (sfCase) {
        if (sfUrl) caseHtml += ft('#555555', 'Case: ', 'font-size:9px') + '<a href="' + sfUrl + '" style="color:#1a56db;font-size:9px;font-weight:bold;text-decoration:underline;">' + sfCase + '</a>';
        else caseHtml += ft('#555555', 'Case: ', 'font-size:9px') + ft('#1a56db', '<b>' + sfCase + '</b>', 'font-size:9px');
      }
      if (!caseHtml) caseHtml = ft('#bbbbbb', '\u2014', 'font-size:10px');

      // Relay Garage
      let rgHtml = ft('#bbbbbb', '\u2014', 'font-size:10px');
      if (/offsite/i.test(u.relayStatus || '') && vendor) {
        rgHtml = ft('#1e2d3d', '<b>' + vendor + '</b>', 'font-size:10px');
        const _subV = u.subVendor || u.dealerName || '';
        if (_subV && _subV !== vendor) rgHtml += '<br>' + ft('#7c3aed', _subV, 'font-size:9px');
        if (u.geofence) rgHtml += '<br>' + ft('#7c3aed', '\uD83D\uDCCD ' + u.geofence, 'font-size:9px');
        if (duration) {
          let dColor = '#16a34a';
          const dayMatch = duration.match(/(\d+)\s*day/);
          if (dayMatch) {
            const days = parseInt(dayMatch[1]);
            if (days >= 7) dColor = '#dc2626';
            else if (days >= 3) dColor = '#d97706';
          }
          rgHtml += '<br>' + ft(dColor, '<b>Down: ' + duration + '</b>', 'font-size:9px');
        }
        const aiIssue = u.issueSummary || u.issue || '';
        if (aiIssue) rgHtml += '<br>' + ft('#555555', '<i>' + aiIssue.substring(0, 120) + '</i>', 'font-size:9px');
      }

      const td = (content) => `<td bgcolor="${bg}" style="background-color:${bg};padding:7px 8px;border-bottom:1px solid #eaecef;border-right:1px solid #eaecef;vertical-align:top;">${content}</td>`;

      rows += `<tr>
${td(ft('#1e2d3d', u.site || '--', 'font-size:10px'))}
${td(ft('#1e2d3d', u.op || '--', 'font-size:10px'))}
${td(ft('#1a56db', '<b>' + (u.id || '--') + '</b>', 'font-size:11px'))}
${td(`<table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${makeBg}" style="background-color:${makeBg};padding:2px 6px;border-radius:3px;">${ft(makeColor,'<b>'+makeLbl+'</b>','font-size:9px')}</td></tr></table>`)}
${td(`<table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#dc2626" style="background-color:#dc2626;padding:2px 7px;border-radius:12px;">${ft('#ffffff','<b>UNAVAILABLE</b>','font-size:9px')}</td></tr></table>`)}
${td(ft('#1e2d3d', u.relayStatus || '--', 'font-size:10px'))}
${td(ft(rsColor, '<b>' + repairStatus + '</b>', 'font-size:10px'))}
${td(ft('#1e2d3d', u.savedPrimaryComponent || '--', 'font-size:10px'))}
${td(caseHtml)}
${td(rgHtml)}
<td bgcolor="${bg}" style="background-color:${bg};padding:7px 8px;border-bottom:1px solid #eaecef;vertical-align:top;"><table cellpadding="0" cellspacing="0" border="0" width="350"><tr><td width="350" style="width:350px;"><div style="background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:8px 10px;font-size:10px;color:#374151;line-height:1.5;width:330px;max-width:330px;word-wrap:break-word;overflow:hidden;">${notes}</div></td></tr></table></td>
</tr>`;

    });

    unavailTable = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid #dde1e6;border-top:none;">
<tr>
${hdrTh('DOMICILE')}${hdrTh('OPERATOR')}${hdrTh('UNIT ID')}${hdrTh('MAKE')}${hdrTh('STATE')}${hdrTh('REASON')}${hdrTh('REPAIR STATUS')}${hdrTh('PRIMARY COMP')}${hdrTh('CASE/OFFSITE')}${hdrTh('RELAY GARAGE')}<th bgcolor="#475569" width="350" style="background-color:#475569;padding:6px 8px;text-align:left;border-bottom:1px solid #dde1e6;width:350px;white-space:nowrap;"><font color="#f1f5f9" face="Arial,sans-serif" style="font-size:9px;letter-spacing:0.07em"><b>NOTES</b></font></th>
</tr>
${rows}
</table>`;
  } else {
    unavailTable = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #dde1e6;border-top:none;"><tr><td style="text-align:center;padding:14px;">${ft('#bbbbbb','No unavailable units &#10003;','font-size:12px')}</td></tr></table>`;
  }

  // PM Due Dates table
  const _hasBoxTrucks = filteredUnits.some(u => /box/i.test(u.bodyType || ''));
  let pmTable = '';
  if (filteredUnits.length) {

    const pmHdr = (text) => `<th bgcolor="#d1fae5" style="background-color:#d1fae5;padding:6px 8px;text-align:left;border-bottom:1px solid #dde1e6;border-right:1px solid #e8ebef;white-space:nowrap;">${ft('#14532d','<b>'+text+'</b>','font-size:9px;letter-spacing:0.07em')}</th>`;

    let pmRows = '';
    filteredUnits.forEach((u, i) => {
      const isUnavail = (u.atsState||u.lifecycleState) && (u.atsState||u.lifecycleState).toLowerCase().indexOf('unavail') > -1;
      const bg = isUnavail ? '#fff5f5' : (i % 2 === 0 ? '#ffffff' : '#f9fbf9');
      const makeRaw = (u.model || '').toLowerCase();
      let makeBg = '#f3f4f6', makeLbl = u.model || '--', makeColor = '#374151';
      if (makeRaw.includes('freightliner')) { makeBg = '#e5e7eb'; makeLbl = 'FREIGHTLINER'; makeColor = '#1f2937'; }
      else if (makeRaw.includes('volvo'))   { makeBg = '#dbeafe'; makeLbl = 'VOLVO'; makeColor = '#1e3a5f'; }
      else if (makeRaw.includes('peterbilt')){ makeBg = '#fee2e2'; makeLbl = 'PETERBILT'; makeColor = '#7f1d1d'; }
      else if (makeRaw.includes('kenworth')) { makeBg = '#fef3c7'; makeLbl = 'KENWORTH'; makeColor = '#78350f'; }
      else if (makeRaw.includes('mack'))    { makeBg = '#fed7aa'; makeLbl = 'MACK'; makeColor = '#78350f'; }

      const statusBg = isUnavail ? '#dc2626' : '#16a34a';
      const statusLbl = isUnavail ? 'UNAVAILABLE' : 'IN SERVICE';

      function pmColor(val) {
        if (!val || val === '--') return '#bbbbbb';
        const d = new Date(val);
        if (isNaN(d.getTime())) return '#222222';
        const diff = (d - now) / (1000*60*60*24);
        if (diff < 0) return '#dc2626';
        if (diff < 31) return '#d97706';
        return '#16a34a';
      }

      const pmB = u.pmB || '--';
      const pmX = u.pmX || '--';
      const dot = u.dot || '--';
      const qlft = u.quarterlyLift || '--';
      const bodyType = u.bodyType || (makeRaw.includes('box') ? 'Box Truck' : (op === 'AUVTE' ? 'Box Truck' : 'Day Cab'));

      const td = (content, align) => `<td bgcolor="${bg}" style="background-color:${bg};padding:7px 8px;border-bottom:1px solid #eaecef;border-right:1px solid #eaecef;${align?'text-align:'+align+';':''}vertical-align:middle;">${content}</td>`;

      pmRows += `<tr>
${td(ft('#1a56db', '<b>' + (u.id || '--') + '</b>', 'font-size:11px'))}
${td(ft('#1e2d3d', u.site || '--', 'font-size:10px'), 'center')}
${td(`<table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${makeBg}" style="background-color:${makeBg};padding:2px 6px;border-radius:3px;">${ft(makeColor,'<b>'+makeLbl+'</b>','font-size:9px')}</td></tr></table>`, 'center')}
${td(ft('#555555', bodyType, 'font-size:10px'), 'center')}
${td(ft(pmColor(pmB), '<b>' + pmB + '</b>', 'font-size:10px'), 'center')}
${td(ft(pmColor(pmX), '<b>' + pmX + '</b>', 'font-size:10px'), 'center')}
${td(ft(pmColor(dot), '<b>' + dot + '</b>', 'font-size:10px'), 'center')}
${_hasBoxTrucks ? td(ft(pmColor(qlft), '<b>' + qlft + '</b>', 'font-size:10px'), 'center') : ''}
${td(`<table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${statusBg}" style="background-color:${statusBg};padding:2px 7px;border-radius:12px;">${ft('#ffffff','<b>'+statusLbl+'</b>','font-size:9px')}</td></tr></table>`, 'center')}
</tr>`;
    });

    pmTable = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid #dde1e6;border-top:none;">
<tr>
${pmHdr('UNIT ID')}${pmHdr('DOMICILE')}${pmHdr('MAKE')}${pmHdr('BODY TYPE')}${pmHdr('PM-B DUE')}${pmHdr('PM-X DUE')}${pmHdr('DOT DUE')}${_hasBoxTrucks ? pmHdr('QUARTERLY') : ''}${pmHdr('STATUS')}
</tr>
${pmRows}
</table>`;
  } else {
    pmTable = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #dde1e6;border-top:none;"><tr><td style="text-align:center;padding:14px;">${ft('#bbbbbb','No PM data','font-size:12px')}</td></tr></table>`;
  }

  // Replace placeholders
  template = template.replace(/\{\{TEST_BANNER\}\}/g, testBanner);
  template = template.replace(/\{\{DATETIME\}\}/g, datetime);
  template = template.replace(/\{\{SITE\}\}/g, site);
  template = template.replace(/\{\{OPERATOR\}\}/g, op);
  template = template.replace(/\{\{GREETING\}\}/g, greeting);
  // Dynamic greeting body based on site content
  const hasUptake = filteredUnits.some(u => u.riskScore && u.riskScore >= 60);
  let pmList = 'PM-B / PM-X / DOT' + (_hasBoxTrucks ? ' / Quarterly Lift' : '');

  let greetBody = 'Below is the <b>' + slotDisplayLabel.replace(' REPORT','') + ' fleet maintenance update</b> for <b>' + op + '</b>. This report covers unavailable units, ' + pmList + ' due dates, relay garage events';
  if (hasUptake) greetBody += ', and <b>high-risk predictive maintenance insights (Uptake)</b>';
  greetBody += '.';

  template = template.replace(/\{\{GREETING_BODY\}\}/g, greetBody);

  template = template.replace(/\{\{SLOT\}\}/g, slotLabel);
  template = template.replace(/\{\{SLOT_LABEL\}\}/g, slotDisplayLabel);
  template = template.replace(/\{\{SLOT_BG\}\}/g, slotBg);
  template = template.replace(/\{\{SLOT_BORDER\}\}/g, slotBorder);
  template = template.replace(/\{\{SLOT_COLOR\}\}/g, slotColor);
  template = template.replace(/\{\{SLOT_ICON\}\}/g, slotIcon);
  template = template.replace(/\{\{NOTE_BAR\}\}/g, noteBar);
  template = template.replace(/\{\{KPI_STRIP\}\}/g, kpiStrip);
  template = template.replace(/\{\{FLEET_SUMMARY\}\}/g, fleetSummary);
  template = template.replace(/\{\{VENDOR_CHIPS\}\}/g, vendorChips);
  template = template.replace(/\{\{UNAVAIL_COUNT\}\}/g, String(unavailUnits.length));
  template = template.replace(/\{\{UNAVAIL_TABLE\}\}/g, unavailTable);
  template = template.replace(/\{\{PM_TABLE\}\}/g, pmTable);

  // Uptake Predictive Insights (score >= 60)
  let uptakeTable = '';
  const riskUnits = filteredUnits.filter(u => u.riskScore && u.riskScore >= 60)
    .sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));

  if (riskUnits.length) {
    let uptakeRows = '';
    riskUnits.forEach(u => {
      const score = u.riskScore || 0;
      const scoreColor = score >= 75 ? '#dc2626' : '#d97706';
      const tier = u.riskTier || (score >= 75 ? 'Very High' : score >= 50 ? 'High' : 'Medium');
      const tierColor = /very\s*high/i.test(tier) ? '#dc2626' : /high/i.test(tier) ? '#d97706' : '#6b7280';
      let insight = '';
      if (u.insightsList && u.insightsList.length) {
        const active = u.insightsList.filter(i => i.stillActive);
        insight = active.length ? active.map(i => i.title || i.description || '').join('; ') : (u.insightsList[0].title || '');
      } else if (u.insights) { insight = u.insights; }

      // Auto-determine PM status
      const issueText = ((u.savedNotes || '') + ' ' + (u.issue || '')).toLowerCase();
      const hasPM = issueText.includes('predictive maintenance') || issueText.includes('predictive maint');
      const isActive = (u.atsState||u.lifecycleState) && (u.atsState||u.lifecycleState).toLowerCase() === 'available';
      let pmStatus = u.pmStatus || '';
      if (!pmStatus) {
        if (hasPM && isActive) pmStatus = 'Completed';
        else if (hasPM) pmStatus = 'In Progress';
        else if (score >= 80) pmStatus = 'In Review';
        else pmStatus = 'Opened';
      }
      const pmColors = { 'Opened': '#6b7280', 'In Review': '#d97706', 'In Progress': '#2563eb', 'Completed': '#16a34a' };
      const pmColor = pmColors[pmStatus] || '#6b7280';

      uptakeRows += `<tr>
<td style="padding:8px;border-bottom:1px solid #eaecef;vertical-align:top;text-align:center;">
<table cellpadding="0" cellspacing="0" border="0"><tr><td style="border:2px solid ${scoreColor};border-radius:50%;padding:3px 6px;text-align:center;">${ft(scoreColor, '<b>' + score + '</b>', 'font-size:11px')}</td></tr></table>
</td>
<td style="padding:8px;border-bottom:1px solid #eaecef;vertical-align:top;">${ft('#1a56db', '<b>' + (u.id || '--') + '</b>', 'font-size:11px')}</td>
<td style="padding:8px;border-bottom:1px solid #eaecef;vertical-align:top;">${ft('#1e2d3d', u.op || '--', 'font-size:10px')}</td>
<td style="padding:8px;border-bottom:1px solid #eaecef;vertical-align:top;">${ft('#555555', u.site || '--', 'font-size:10px')}</td>
<td style="padding:8px;border-bottom:1px solid #eaecef;vertical-align:top;">${ft(tierColor, '<b>' + tier + '</b>', 'font-size:10px')}</td>
<td style="padding:8px;border-bottom:1px solid #eaecef;vertical-align:top;">${ft('#333333', insight || '\u2014', 'font-size:10px')}</td>
<td style="padding:8px;border-bottom:1px solid #eaecef;vertical-align:top;">${ft(pmColor, '<b>' + pmStatus + '</b>', 'font-size:10px')}</td>
</tr>`;
    });

    uptakeTable = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border:1px solid #dde1e6;border-top:none;">
<tr bgcolor="#f5f0ff">
<th style="padding:6px 8px;text-align:center;border-bottom:1px solid #dde1e6;border-right:1px solid #e8ebef;">${ft('#444444','<b>SCORE</b>','font-size:9px')}</th>
<th style="padding:6px 8px;text-align:left;border-bottom:1px solid #dde1e6;border-right:1px solid #e8ebef;">${ft('#444444','<b>UNIT ID</b>','font-size:9px')}</th>
<th style="padding:6px 8px;text-align:left;border-bottom:1px solid #dde1e6;border-right:1px solid #e8ebef;">${ft('#444444','<b>OPERATOR</b>','font-size:9px')}</th>
<th style="padding:6px 8px;text-align:left;border-bottom:1px solid #dde1e6;border-right:1px solid #e8ebef;">${ft('#444444','<b>DOMICILE</b>','font-size:9px')}</th>
<th style="padding:6px 8px;text-align:left;border-bottom:1px solid #dde1e6;border-right:1px solid #e8ebef;">${ft('#444444','<b>RISK</b>','font-size:9px')}</th>
<th style="padding:6px 8px;text-align:left;border-bottom:1px solid #dde1e6;border-right:1px solid #e8ebef;">${ft('#444444','<b>ACTIVE INSIGHT</b>','font-size:9px')}</th>
<th style="padding:6px 8px;text-align:left;border-bottom:1px solid #dde1e6;">${ft('#444444','<b>STATUS</b>','font-size:9px')}</th>
</tr>
${uptakeRows}
</table>`;
  } else {
    uptakeTable = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #dde1e6;border-top:none;"><tr><td style="text-align:center;padding:14px;">${ft('#bbbbbb','No active predictive insights (score &lt; 60)','font-size:12px')}</td></tr></table>`;
  }


  template = template.replace(/\{\{UPTAKE_TABLE\}\}/g, uptakeTable);

  return template;
}

module.exports = { buildEmail };
