/**
 * fleet-bridge.js  --  Module 1: Fleet Data Bridge
 * Connects the new UI to the V-C Electron backend.
 *
 * IN  -> window.fleet.onData(cb)    pushed by main after scrape
 * IN  -> window.fleet.onStatus(cb)  sync progress
 * IN  -> window.fleet.onError(cb)   sync errors
 * OUT -> window.fleet.signalReady() tells main to push cached data
 * OUT -> window.fleet.requestSync() user-triggered re-scan
 *
 * Fallback: if window.fleet absent (browser dev), static UNITS intact
 * and a DEV badge shows in topbar.
 *
 * Version: 1.0.0  --  Stage 1, Module 1
 */

(function () {
  'use strict';

  var RELAY_CLS = {
    'Pending Parts':  'orange',
    'Offsite Shop':   'red',
    'In Progress':    'blue',
    'Available':      'green',
    'Pending Diag':   'purple',
    'Accident':       'gray',
    'Pending Repair': 'orange'
  };

  var ATS_CLS = {
    'Available':   'green',
    'Unavailable': 'red'
  };

  function slaPct(ms, targetDays) {
    if (!ms || !targetDays) return 0;
    return Math.min(100, Math.round((ms / 1000 / 3600 / 24 / targetDays) * 100));
  }

  function fmtDuration(ms) {
    if (!ms || ms <= 0) return '--';
    var h = Math.floor(ms / 3600000);
    var d = Math.floor(h / 24);
    return d > 0 ? d + 'd ' + (h % 24) + 'h' : h + 'h';
  }

  function slaColor(pct) {
    if (pct >= 80) return 'var(--red)';
    if (pct >= 50) return 'var(--org)';
    if (pct >= 30) return 'var(--ylw)';
    return 'var(--grn)';
  }

  function riskCls(n) {
    return n >= 80 ? 'vh' : n >= 60 ? 'hi' : n >= 40 ? 'md' : 'lo';
  }

  function rowToUnit(row) {
    var id    = row.equipmentId || row.id || '?';
    var risk  = parseInt(row.riskScore || row.risk) || 0;
    var relay = row.relayStatus || row.relay || 'Unknown';
    var ats   = row.lifecycleState || row.atsState || 'Unknown';
    var ms    = row.durationMs || row.elapsedMs || 0;
    var slaT  = row.slaTarget || 5;
    var pct   = slaPct(ms, slaT);

    return {
      id:          id,
      risk:        risk,
      riskCls:     riskCls(risk),
      year:        String(row.year || row.modelYear || '--'),
      make:        row.model || row.manufacturer || '--',
      op:          row.operator || row.op || '--',
      site:        row.domicileSite || row.site || '--',
      sf:          row.workRequestId || row.sf || '--',
      relay:       relay,
      relayCls:    RELAY_CLS[relay] || 'gray',
      ats:         ats,
      atsCls:      ATS_CLS[ats] || 'gray',
      vendor:      row.vendor || '--',
      duration:    fmtDuration(ms),
      wrs:         parseInt(row.openUnplanned || row.wrs) || 0,
      sla:         pct + '% (' + slaT + 'd target)',
      slaPct:      pct,
      slaClr:      slaColor(pct),
      sub:         Array.isArray(row.sub) ? row.sub : [],
      intel:       row.aiSummary || row.savedNotes || '',
      next:        row.aiNextAction || '',
      confidence:  row.aiConfidence || 'PENDING',
      tl:          Array.isArray(row.tl) ? row.tl : [],
      riskHistory: (Array.isArray(row.riskHistory) && row.riskHistory.length >= 2)
                     ? row.riskHistory.slice(-7)
                     : [risk, risk, risk, risk, risk, risk, risk],
      elapsedMs:   ms,
      assetUrl:    row.assetUrl || '',
      bodyType:    row.bodyType || row.assetType || '--',
      fuelType:    row.fuelType || '--',
      aapId:       (row.assetUrl || '').replace(/.*\/v2\/asset\//, '').split('?')[0] || '',
      _raw:        row
    };
  }

  function buildRelaySelect(uid, cur) {
    var opts = ['Pending Parts','Offsite Shop','In Progress','Available','Pending Diag','Accident'];
    return '<select class="relay-sel" style="display:none"'
      + ' onchange="commitRelay(this,\'' + uid + '\')"'
      + ' onblur="cancelRelay(this)">'
      + opts.map(function(o){ return '<option' + (o===cur?' selected':'') + '>' + o + '</option>'; }).join('')
      + '</select>';
  }

  function renderTable() {
    var tbody = document.querySelector('tbody');
    if (!tbody) return;
    var units = Object.values(window.UNITS).sort(function(a,b){ return b.risk - a.risk; });
    tbody.innerHTML = units.map(function(u) {
      var slaHtml = u.slaPct > 0
        ? '<div class="sla"><div class="sla-bar"><div class="sla-fill'
            + (u.slaPct>=75?' sla-urgent':'')
            + '" style="width:' + u.slaPct + '%;background:' + u.slaClr + '"></div></div>'
            + '<span class="sla-pct" style="color:' + u.slaClr + '">' + u.slaPct + '%</span></div>'
        : '<span class="sla-pct" style="color:var(--mut)">--</span>';
      var wClr = u.wrs>=4?'var(--red)':u.wrs>=2?'var(--org)':'inherit';
      var rfBg = u.risk>=75?'var(--red)':u.risk>=50?'var(--org)':'var(--grn)';
      return '<tr'
        + ' onclick="openDrawerByUid(\'' + u.id + '\')"'
        + ' oncontextmenu="showCtx(event,\'' + u.id + '\',\'' + u.op + ' / ' + u.site + '\')">'
        + '<td><span class="uid">' + u.id + '</span></td>'
        + '<td>' + u.op + ' / ' + u.site + '</td>'
        + '<td><span class="tag ' + u.relayCls + '" onclick="editRelay(this)" style="cursor:pointer" title="Click to edit">'
            + u.relay + '</span>' + buildRelaySelect(u.id, u.relay) + '</td>'
        + '<td><span class="tag ' + u.atsCls + '">' + u.ats + '</span></td>'
        + '<td><div class="risk-cell"><span class="rs ' + u.riskCls + '">' + u.risk + '</span>'
            + '<div class="rt"><div class="rf" style="width:' + u.risk + '%;background:' + rfBg + '"></div></div></div></td>'
        + '<td style="color:' + wClr + ';font-weight:700;font-family:var(--mono)">' + u.wrs + '</td>'
        + '<td>' + u.duration + '</td>'
        + '<td>' + u.vendor + '</td>'
        + '<td>' + u.bodyType + '</td>'
        + '<td>' + u.fuelType + '</td>'
        + '<td>' + slaHtml + '</td>'
        + '</tr>';
    }).join('');
  }

  function renderQueue() {
    var list = document.getElementById('priorityList');
    if (!list) return;
    var saved = [];
    try { saved = JSON.parse(localStorage.getItem('fo_queue_order')||'[]'); } catch(_){}
    var units = Object.values(window.UNITS).filter(function(u){ return u.ats==='Unavailable'; });
    units.sort(function(a,b){
      var ai=saved.indexOf(a.id), bi=saved.indexOf(b.id);
      if (ai>=0&&bi>=0) return ai-bi;
      if (ai>=0) return -1;
      if (bi>=0) return 1;
      return b.risk-a.risk;
    });
    var dotCls = function(r){ return r>=75?'action':r>=50?'watch':'track'; };
    list.innerHTML = units.map(function(u){
      var rColor = u.risk>=80?'var(--red)':u.risk>=60?'var(--org)':'var(--ylw)';
      var vendorPart = (u.vendor && u.vendor !== '--') ? ' \u00b7 ' + u.vendor : '';
      var meta = u.op + ' \u00b7 ' + u.site + vendorPart;
      return '<div draggable="true" class="pri-item"'
        + ' onclick="selectQ(this);openDrawerByUid(\'' + u.id + '\')"'
        + ' oncontextmenu="showQCtx(event,\'' + u.id + '\')">'
        + '<span class="drag-handle">\u22ee\u22ee</span>'
        + '<div class="pri-dot ' + dotCls(u.risk) + '"></div>'
        + '<div style="flex:1">'
          + '<div class="pri-id">' + u.id + '</div>'
          + '<div class="pri-meta">' + meta + '</div>'
          + '<div class="pri-tag"><span class="tag ' + u.relayCls + '">' + u.relay + '</span></div>'
        + '</div>'
        + '<span style="font-family:var(--mono);font-size:11px;font-weight:800;color:' + rColor + '">' + u.risk + '</span>'
        + '</div>';
    }).join('') + '<div class="pri-no-match" id="qNoMatch">No units match this filter</div>';
    var badge = document.querySelector('.lp-count');
    if (badge) badge.textContent = units.length;
  }

  function rebuildKpis() {
    var all      = Object.values(window.UNITS);
    var unavail  = all.filter(function(u){ return u.ats==='Unavailable'; }).length;
    var offsite  = all.filter(function(u){ return u.relay==='Offsite Shop'; }).length;
    var highRisk = all.filter(function(u){ return u.risk>=75; }).length;
    var avail    = all.filter(function(u){ return u.ats==='Available'; }).length;
    function set(kpi, val) {
      var c = document.querySelector('.kpi-card[data-kpi="' + kpi + '"]');
      if (c) { var n=c.querySelector('.kpi-num'); if(n) n.textContent=val; }
    }
    set('unavailable', unavail);
    set('offsite',     offsite);
    set('highrisk',    highRisk);
    set('available',   avail);
  }

  function renderFromData(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      if (typeof toast==='function') toast('No units returned from sync','warning','Fleet Sync');
      return;
    }
    if (typeof window.UNITS !== 'undefined') {
      Object.keys(window.UNITS).forEach(function(k){ delete window.UNITS[k]; });
    } else {
      window.UNITS = {};
    }
    rows.forEach(function(row){ var u=rowToUnit(row); window.UNITS[u.id]=u; });
    renderTable();
    renderQueue();
    rebuildKpis();
    if (typeof buildShiftSummary  === 'function') buildShiftSummary();
    if (typeof buildAvgAge        === 'function') buildAvgAge();
    if (typeof buildKpiQueueCounts=== 'function') buildKpiQueueCounts();
    if (typeof injectCheckboxes   === 'function') injectCheckboxes();
    if (typeof injectPinButtons   === 'function') injectPinButtons();
    if (typeof initDrag           === 'function') initDrag();
    if (typeof restoreFilterState === 'function') restoreFilterState();
    var brand = document.querySelector('.brand-text');
    if (brand) brand.title = 'Last sync: ' + new Date().toLocaleTimeString();
    if (typeof toast==='function'&&!window._fleetPartial) toast(rows.length+' units loaded','success','Fleet Sync');window._fleetPartial=false;
  }

  function patchLiveMode() {
    var orig = window.toggleLiveMode;
    window.toggleLiveMode = function() {
      if (typeof window.fleet !== 'undefined' && typeof window.fleet.requestSync === 'function') {
        var btn = document.getElementById('liveToggleBtn');
        if (!window._liveBridgeInterval) {
          window._liveBridgeInterval = setInterval(function(){ window.fleet.requestSync(); }, 30000);
          if (btn){ btn.textContent='Live On'; btn.classList.add('active'); }
          if (typeof toast==='function') toast('Live mode on -- syncing every 30s','success','Live Mode');
        } else {
          clearInterval(window._liveBridgeInterval);
          window._liveBridgeInterval = null;
          if (btn){ btn.textContent='Live Off'; btn.classList.remove('active'); }
          if (typeof toast==='function') toast('Live mode off','info');
        }
      } else if (typeof orig === 'function') {
        orig();
      }
    };
  }

  function showDevBadge() {
    var tr = document.querySelector('.topbar-right');
    if (!tr) return;
    var b = document.createElement('span');
    b.style.cssText = 'font-family:var(--mono);font-size:9px;background:rgba(255,166,87,.15);'
      + 'color:var(--org);border:1px solid rgba(255,166,87,.3);'
      + 'padding:2px 8px;border-radius:4px;letter-spacing:1px;cursor:default';
    b.textContent = 'DEV';
    b.title = 'Browser mode -- window.fleet not present';
    tr.insertBefore(b, tr.firstChild);
  }

  function boot() {
    patchLiveMode();

    if (typeof window.fleet === 'undefined') {
      showDevBadge();
      console.log('[fleet-bridge] DEV mode -- static UNITS active');
      return;
    }

    console.log('[fleet-bridge] Electron mode -- attaching IPC listeners');

    window.fleet.onData(function(data){var partial=data&&data.partial;console.log("[fleet-bridge] fleet:data partial="+partial+" rows="+(data.rows||[]).length);if(partial){window._fleetPartial=true;var tbody=document.querySelector("tbody");if(tbody)tbody.style.opacity="0.6";renderFromData(data.rows||[]);if(tbody)setTimeout(function(){tbody.style.opacity="1";},200);}else{window._fleetPartial=false;var tbody2=document.querySelector("tbody");if(tbody2)tbody2.style.opacity="1";renderFromData(data.rows||[]);}});

    window.fleet.onStatus(function(msg) {
      console.log('[fleet-bridge] fleet:status', msg);
      var li = document.querySelector('.live-ind');
      if (li) li.title = msg;
    });

    window.fleet.onError(function(err) {
      console.error('[fleet-bridge] fleet:error', err);
      if (typeof toast==='function') toast('Sync error: ' + err,'error','Fleet Sync');
    });

    window.fleet.signalReady();
    console.log('[fleet-bridge] signalReady() sent');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window._fleetBridge = { renderFromData: renderFromData, rowToUnit: rowToUnit, version: '1.0.0' };

}());
