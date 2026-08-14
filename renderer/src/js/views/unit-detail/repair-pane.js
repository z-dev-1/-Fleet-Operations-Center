// Extracted from unit-detail.js
// Function: renderRepairPane

function renderRepairPane(unit){
  // ── WR summary card ────────────────────────────────────────────────────────
  var hasRelay=unit.relaySynced&&(unit.vendor||unit.issueDetails||unit.workRequestId);
  var woCard='';
  if(hasRelay){
    var statusRaw=unit.serviceState||unit.status||'';
    var statusKey=statusRaw.toLowerCase().includes('clos')?'closed':statusRaw.toLowerCase().includes('sour')?'sourcing':'open';
    var wrAge=unit.created?Math.floor((Date.now()-new Date(unit.created).getTime())/86400000):null;
    var stale=wrAge>3?'<span class="dp-wo-stale">\u26a0 '+wrAge+'d</span>':'';

    var fields=[
      unit.workRequestId?['WR ID',unit.workRequestId]:null,
      unit.vendorWorkOrderId?['Vendor WO',unit.vendorWorkOrderId]:null,
      unit.salesforceCase?['SF Case',unit.salesforceCase,unit.salesforceCaseUrl||'']:null,
      unit.createdBy?['Created By',unit.createdBy]:null,
      unit.needBy?['Need By',unit.needBy]:null,
      unit.serviceCategory?['Category',unit.serviceCategory]:null,
      unit.integratedMethod?['Method',unit.integratedMethod]:null,
      unit.program?['Program',unit.program]:null,
      unit.totalCost?['Total Cost',unit.totalCost]:null,
    ].filter(Boolean);

    var cause=unit.cause?'<div class="dp-wo-cause"><span class="dp-wo-cause__label">Reason:</span> '+esc(unit.cause)+'</div>':'';
    var correction=unit.correction?'<div class="dp-wo-cause"><span class="dp-wo-cause__label">Work Done:</span> '+esc(unit.correction)+'</div>':'';

    woCard='<div class="dp-wo-card">'+
      '<div class="dp-wo-card__header">'+
        '<span class="dp-wo-card__vendor">'+esc(unit.vendor||'Unknown Vendor')+'</span>'+
        (unit.subVendor&&unit.subVendor!==unit.vendor?'<span class="dp-wo-card__subvendor">'+esc(unit.subVendor)+'</span>':'')+
        '<span class="dp-wo-card__status-pill dp-wo-card__status-pill--'+statusKey+'">'+esc(statusRaw||'Open')+'</span>'+
        stale+
      '</div>'+
      ((unit.savedRepairStatus||unit.savedPrimaryComponent)?'<div class="dp-wo-card__ai-tags">'+
        (unit.savedRepairStatus?'<span class="dp-ai-tag dp-ai-tag--status">\uD83D\uDD27 '+esc(unit.savedRepairStatus)+'</span>':'')+
        (unit.savedPrimaryComponent?'<span class="dp-ai-tag dp-ai-tag--component">\u2699\uFE0F '+esc(unit.savedPrimaryComponent)+'</span>':'')+
      '</div>':'')+
      ((unit.issueSummary||unit.issueDetails)?'<div class="dp-wo-card__desc">'+(unit.issueSummary?'<span class="dp-orcha-badge">\uD83E\uDDE0</span> '+esc((unit.issueSummary||'').split('TIMELINE:')[0].split('\\n')[0].substring(0,200)):esc(unit.issueDetails))+'</div>':'')+
      cause+correction+
      (fields.length?'<div class="dp-wo-card__fields">'+fields.map(function(f){return'<span class="dp-wo-field"><span class="dp-wo-field__k">'+esc(f[0])+'</span><span class="dp-wo-field__v">'+(f[2]?'<a href="'+f[2]+'" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;cursor:pointer;">'+esc(f[1])+'</a>':esc(f[1]))+'</span></span>';}).join('')+'</div>':'')+
      (unit.created||unit.completed?'<div class="dp-wo-card__dates">'+
        (unit.created?'<span>Opened '+fmtDate(unit.created)+'</span>':'')+
        (unit.completed?'<span>Closed '+fmtDate(unit.completed)+'</span>':'')+
      '</div>':'')+
    '</div>';
  } else {
    woCard='<div class="dp-empty-state"><span class="dp-empty-state__icon">\ud83d\udcc2</span>No Relay WR data</div>';
  }

  // ── work duration bar ──────────────────────────────────────────────────────
  var durBar=workDurationBar(unit);

  // ── Conversation → vertical timeline ──────────────────────────────────────
  // parseConvo removed — AI timeline is the only source of truth
  _allConvoMsgs = [];
  // === ORCHA REPAIR TIMELINE (Source of Truth) ===
  var aiTimeline = unit.repairTimeline || '';
  var orchaNote = unit.savedNotes || '';
  var timelineHtml = '';

  if (aiTimeline && aiTimeline.length > 20) {
    // AI-generated timeline is the Source of Truth
    var tlEntries = aiTimeline.split('\n').filter(function(l){ return l.trim().length > 5; });
    timelineHtml =
      '<div class="dp-section-title">\uD83E\uDDE0 Repair Timeline <span class="dp-section-count">' + tlEntries.length + ' events</span></div>' +
      '<div class="dp-orcha-timeline">' +
        tlEntries.map(function(entry) {
          var m = entry.trim().match(/^(\d{2}\/\d{2})\s*[-\u2013]\s*(.+)$/);
          if (m) {
            return '<div class="dp-tl3-item dp-tl3-dot--ai">' +
              '<span class="dp-tl3-date">' + esc(m[1]) + '</span>' +
              '<span class="dp-tl3-dash"> \u2014 </span>' +
              '<span class="dp-tl3-text">' + esc(m[2]) + '</span></div>';
          }
          return '<div class="dp-tl3-item dp-tl3-dot--ai"><span class="dp-tl3-text">' + esc(entry.trim()) + '</span></div>';
        }).join('') +
      '</div>';
    // Current Status removed - timeline is the source of truth
  } else {
    // No AI timeline yet — just show pending
    timelineHtml = '<div class="dp-empty-state"><span class="dp-empty-state__icon">\uD83E\uDDE0</span>Repair timeline generating — available after next sync cycle.</div>';
  }

  var offsiteUrl=unit.asistSrUrl||unit.savedOffsiteUrl||unit.offsiteShopEventUrl||'';

  // Split-view button (Relay + Offsite side by side)
  var splitViewBtn = '';
  var relayUrl = unit.serviceUrl || '';
  if (relayUrl || offsiteUrl) {
    splitViewBtn = '<div class="dp-split-view-row"><button class="dp-split-view-btn" id="dp-split-open" title="Open Relay Garage and Offsite side by side">\u{1F50D} Open Split View</button></div>';
  }
  var offsiteLabel=unit.asistLabel||unit.savedOffsiteEvent||unit.offsiteShopEvent||offsiteUrl;
  var src=unit.asistSource||'';
  var scrapedAt=unit.asistScrapedAt||'';
  var staleOffsite=scrapedAt&&(Date.now()-new Date(scrapedAt).getTime())>86400000;
  var offsiteHtml=offsiteUrl?
    '<div class="dp-section-title">Offsite Event</div>'+
    '<div class="dp-offsite-card">'+
      '<div class="dp-offsite-card__header">'+
        (src?'<span class="dp-offsite-card__src-badge dp-offsite-card__src-badge--'+esc(src)+'">'+esc(src)+'</span>':'')+
        '<a class="dp-offsite-card__link" href="#" data-ext-url="'+esc(offsiteUrl)+'">'+esc(offsiteLabel||offsiteUrl)+' \u2197</a>'+
        (staleOffsite?'<span class="dp-offsite-card__stale">\u26a0 stale</span>':'')+
      '</div>'+
      (unit.dealerName?'<div class="dp-offsite-card__dealer">'+esc(unit.dealerName)+'</div>':'')+
      (scrapedAt?'<div class="dp-offsite-card__ts">Enriched '+fmtDate(scrapedAt)+'</div>':'')+
    '</div>':'';

  
  // Wire split-view button — opens inline webviews in main content area
  setTimeout(function() {
    var btn = document.getElementById('dp-split-open');
    if (btn) btn.addEventListener('click', function() {
      var rUrl = unit.serviceUrl || '';
      var oUrl = offsiteUrl || '';
      window.__splitUnit = unit; _openInlineSplit(rUrl, oUrl, unit.equipmentId);
    });
  }, 100);

  return '<div class="dp-pane active" id="dp-pane-repair">'+
    '<div class="dp-section-title">Work Request</div>'+woCard+splitViewBtn+durBar+timelineHtml+offsiteHtml+
  '</div>';
}
