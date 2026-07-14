// Extracted from unit-detail.js
// Function: renderIntelPane

function renderIntelPane(unit){
  var risk=parseInt(unit.riskScore,10)||0;
  var rCls=risk>=70?'high':risk>=40?'medium':'low';

  // risk dial SVG
  var dialHtml='';
  if(risk){
    var C=(2*Math.PI*28).toFixed(1);
    var offset=(C-(risk/100)*parseFloat(C)).toFixed(1);
    var sc=risk>=70?'var(--red)':risk>=40?'var(--ylw)':'var(--grn)';
    dialHtml='<div class="dp-risk-wrap">'+
      '<div class="dp-risk-dial">'+
        '<svg viewBox="0 0 72 72">'+
          '<circle cx="36" cy="36" r="28" fill="none" stroke="var(--el)" stroke-width="6"/>'+
          '<circle cx="36" cy="36" r="28" fill="none" stroke="'+sc+'" stroke-width="6" stroke-dasharray="'+C+'" stroke-dashoffset="'+offset+'" stroke-linecap="round" transform="rotate(-90 36 36)"/>'+
        '</svg>'+
        '<div class="dp-risk-dial__num dp-risk-dial__num--'+rCls+'">'+risk+'</div>'+
      '</div>'+
      '<div class="dp-risk-info">'+
        '<div class="dp-risk-label">Uptake Risk Score</div>'+
        '<div class="dp-risk-sub">'+(risk>=70?'High Ã¢â‚¬â€ maintenance recommended':risk>=40?'Moderate Ã¢â‚¬â€ monitor closely':'Low risk')+'</div>'+
        (unit.riskLabel?'<div class="dp-risk-sub" style="margin-top:2px">'+esc(unit.riskLabel)+'</div>':'')+
        (unit.lastDataDate?'<div class="dp-risk-sub" style="color:var(--mut);margin-top:4px">Data: '+fmtDate(unit.lastDataDate)+'</div>':'')+
      '</div>'+
    '</div>';
  }

  // subsystems
  var subs=unit.subsystems||[];
  var subsHtml=subs.length?
    '<div class="dp-section-title">Subsystems</div>'+
    subs.map(function(s){
      var v=parseInt(s.score||s.value||s.riskScore,10)||0;
      var c=v>=70?'var(--red)':v>=40?'var(--ylw)':'var(--grn)';
      return '<div class="dp-subsystem-row">'+
        '<span class="dp-subsystem-name">'+esc(s.name||s.system||s.subsystem||'')+'</span>'+
        '<div class="dp-subsystem-bar"><div class="dp-subsystem-fill" style="width:'+v+'%;background:'+c+'"></div></div>'+
        '<span class="dp-subsystem-val" style="color:'+c+'">'+v+'</span>'+
      '</div>';
    }).join(''):'' ;

  // insights
  var insights=unit.insightsList||[];
  var insHtml=insights.length?
    '<div class="dp-section-title">Insights <span class="dp-section-count">'+insights.length+'</span></div>'+
    insights.map(function(ins){
      var subsystem=ins.subsystem||'';
      var type=ins.type||ins.insightType||'';
      var status=ins.status||'';
      var since=ins.firstSeen||ins.firstDetected||'';
      var last=ins.lastSeen||ins.lastDetected||'';
      var mf=ins.maintenanceFactor||'';
      return '<div class="dp-insight-card">'+
        '<div class="dp-insight-card__header">'+
          (subsystem?'<span class="dp-insight-card__type">'+esc(subsystem)+'</span>':'')+
          (type?'<span class="dp-insight-card__sub">'+esc(type)+'</span>':'')+
          (status?'<span class="dp-insight-card__status dp-insight-card__status--'+esc(status.toLowerCase())+'">'+esc(status)+'</span>':'')+
          (ins.url?'<a class="dp-offsite-card__link" href="#" data-ext-url="'+esc(ins.url)+'" style="margin-left:auto">\u2197</a>':'')+
        '</div>'+
        (ins.title?'<div class="dp-insight-card__title">'+esc(ins.title)+'</div>':'')+
        (ins.summary?'<div class="dp-insight-card__summary">'+esc(ins.summary)+'</div>':'')+
        (ins.guidance?'<div class="dp-insight-card__action">\u27a1 '+esc(ins.guidance)+'</div>':'')+
        (ins.recommended?'<div class="dp-insight-card__action">\ud83d\udd27 '+esc(ins.recommended)+'</div>':'')+
        ((since||last||mf)?'<div class="dp-insight-card__meta">'+
          (since?'<span>First: '+esc(since)+'</span>':'')+
          (last?'<span>Last: '+esc(last)+'</span>':'')+
          (mf?'<span>Factor: '+esc(mf)+'</span>':'')+
        '</div>':'')+
      '</div>';
    }).join(''):
    '<div class="dp-empty-state"><span class="dp-empty-state__icon">\u26a1</span>No Uptake insights</div>';

  // screenshot
  var shot=(unit.screenshots||[])[0]; var shotHtml='';
  if(shot){
    shotHtml='<div class="dp-section-title">Uptake Screenshot</div>' +
      '<div id="dp-screenshot-card" style="position:relative;width:100%;margin:8px 0;min-height:100px;background:#1c2128;border-radius:6px;border:1px solid rgba(255,255,255,0.08);overflow:hidden;">' +
        '<img id="dp-screenshot-img" data-shot="'+esc(shot)+'" style="width:100%;height:auto;min-height:50px;display:block;border-radius:6px;" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="Uptake screenshot loading..." />' +
        '<div style="font-size:9px;color:rgba(255,255,255,0.35);margin-top:5px;text-align:right;padding:0 8px 4px;" id="dp-screenshot-meta">Loading...</div>' +
      '</div>';
  }

  // ask Orcha
  var askHtml='<div class="dp-section-title">Ask Orcha</div>'+
    '<div class="dp-ask-chips">'+
      '<button class="dp-ask-chip" data-q="Is the ETC realistic for this unit?">ETC realistic?</button>'+
      '<button class="dp-ask-chip" data-q="Draft a vendor follow-up message">Draft follow-up</button>'+
      '<button class="dp-ask-chip" data-q="Should I escalate this unit?">Escalate?</button>'+
      '<button class="dp-ask-chip" data-q="Summarize current repair status">Summarize</button>'+
      '<button class="dp-ask-chip" data-q="What parts are likely needed?">Parts needed?</button>'+
    '</div>'+
    '<div class="dp-ask-row"><input id="dp-ask-input" class="dp-ask-input" type="text" placeholder="Ask about this unit..."/><button id="dp-ask-btn" class="detail-panel__btn">Ask</button></div>'+
    '<div id="dp-ai-result" style="display:none" class="dp-ai-result-box"></div>';

  return '<div class="dp-pane" id="dp-pane-intel">'+dialHtml+subsHtml+insHtml+shotHtml+askHtml+'</div>';
}
