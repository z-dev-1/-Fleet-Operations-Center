/** daily-notes.js -- Daily Notes view (Stage 20) */
import bus from '../bus.js';
let _el = null; let _lastLog = []; let _running = false;
const _safe = (s) => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function _fmtDT(ts){ if(!ts)return'—'; const d=ts instanceof Date?ts:new Date(ts); return d.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' '+d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}); }
function _fmtDate(ts){ if(!ts)return'—'; const d=ts instanceof Date?ts:new Date(ts); return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
function _relTime(ts){ if(!ts)return''; const diff=Date.now()-new Date(ts).getTime(); const m=Math.floor(diff/60000); if(m<1)return'just now'; if(m<60)return m+'m ago'; const h=Math.floor(m/60); if(h<24)return h+'h ago'; return Math.floor(h/24)+'d ago'; }
function _injectCss(){ if(document.getElementById('dn-view-css'))return; const s=document.createElement('style'); s.id='dn-view-css'; const R=[];
R.push('.view--daily-notes{flex:1;overflow-y:auto;padding:16px 20px 40px;display:flex;flex-direction:column;gap:14px}');
R.push('.dn-wrap{display:flex;flex-direction:column;gap:14px;max-width:900px;width:100%}');
R.push('.dn-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}');
R.push('.dn-header__left{display:flex;align-items:center;gap:10px}');
R.push('.dn-title{font-size:15px;font-weight:700;color:var(--txt);display:flex;align-items:center;gap:7px}');
R.push('.dn-badge{font-size:10px;padding:3px 8px;border-radius:20px;font-weight:600;background:rgba(63,185,80,.15);color:var(--grn,#3fb950);border:1px solid rgba(63,185,80,.3)}');
R.push('.dn-badge--warn{background:rgba(255,166,87,.15);color:var(--org,#ffa657);border-color:rgba(255,166,87,.3)}');
R.push('.dn-badge--muted{background:var(--el,rgba(255,255,255,.05));color:var(--mut,#6e7681);border-color:var(--bdr,rgba(240,246,252,.12))}');
R.push('.dn-header__right{display:flex;align-items:center;gap:8px}');
R.push('.dn-btn{padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s,opacity .15s;border:1px solid transparent}');
R.push('.dn-btn--primary{background:var(--acc,#1f6feb);border-color:var(--acc,#1f6feb);color:#fff}');
R.push('.dn-btn--primary:disabled{opacity:.45;cursor:not-allowed}');
R.push('.dn-btn--ghost{background:var(--el,rgba(255,255,255,.07));border-color:var(--bdr,rgba(240,246,252,.12));color:var(--txt2,#8b949e)}');
R.push('.dn-back{font-size:11px;color:var(--acc2,#58a6ff);cursor:pointer;display:inline-flex;align-items:center;gap:4px;margin-bottom:2px;background:none;border:none}');
R.push('.dn-back:hover{text-decoration:underline}');
R.push('.dn-stats{display:flex;gap:10px;flex-wrap:wrap}');
R.push('.dn-stat{flex:1;min-width:110px;background:var(--card,rgba(255,255,255,.04));border:1px solid var(--bdr,rgba(240,246,252,.12));border-radius:8px;padding:10px 14px;display:flex;flex-direction:column;gap:3px}');
R.push('.dn-stat__val{font-size:20px;font-weight:700;color:var(--txt,#eaeaea)}');
R.push('.dn-stat__lbl{font-size:10px;color:var(--mut,#6e7681);font-weight:500;text-transform:uppercase;letter-spacing:.04em}');
R.push('.dn-card{background:var(--card,rgba(255,255,255,.04));border:1px solid var(--bdr,rgba(240,246,252,.12));border-radius:10px;overflow:hidden}');
R.push('.dn-card__head{display:flex;align-items:center;justify-content:space-between;padding:11px 16px;border-bottom:1px solid var(--bdr,rgba(240,246,252,.08));cursor:pointer;user-select:none}');
R.push('.dn-card__head:hover{background:rgba(255,255,255,.02)}');
R.push('.dn-card__title{font-size:12px;font-weight:700;color:var(--txt,#eaeaea);display:flex;align-items:center;gap:7px}');
R.push('.dn-card__count{font-size:10px;padding:2px 8px;border-radius:20px;background:var(--el2,rgba(255,255,255,.08));color:var(--mut,#6e7681)}');
R.push('.dn-card__chev{font-size:10px;color:var(--mut,#6e7681);transition:transform .18s}');
R.push('.dn-card__chev--open{transform:rotate(180deg)}');
R.push('.dn-card__body{padding:0}');
R.push('.dn-card__body--hidden{display:none}');
R.push('.dn-result{display:flex;flex-direction:column;gap:5px;padding:10px 16px;border-bottom:1px solid rgba(240,246,252,.05)}');
R.push('.dn-result:last-child{border-bottom:none}');
R.push('.dn-result__row{display:flex;align-items:center;gap:8px}');
R.push('.dn-result__dot{font-size:11px;width:14px;flex-shrink:0;text-align:center}');
R.push('.dn-result__uid{font-size:11px;font-weight:700;color:var(--txt,#eaeaea);min-width:80px}');
R.push('.dn-result__vendor{font-size:10px;color:var(--mut,#6e7681);flex:1}');
R.push('.dn-result__dec{font-size:9px;padding:2px 7px;border-radius:20px;font-weight:600;border:1px solid transparent}');
R.push('.dn-result__dec--new{background:rgba(63,185,80,.12);color:var(--grn,#3fb950);border-color:rgba(63,185,80,.25)}');
R.push('.dn-result__dec--skip{background:var(--el,rgba(255,255,255,.05));color:var(--mut,#6e7681);border-color:var(--bdr)}');
R.push('.dn-result__dec--err{background:rgba(248,81,73,.12);color:var(--red,#f85149);border-color:rgba(248,81,73,.25)}');
R.push('.dn-result__note{font-size:11px;color:var(--txt2,#8b949e);background:var(--el,rgba(255,255,255,.04));border-radius:5px;padding:6px 10px;line-height:1.5;margin-left:22px}');
R.push('.dn-result__reason{font-size:10px;color:var(--mut,#6e7681);margin-left:22px;font-style:italic}');
R.push('.dn-run-item{display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid rgba(240,246,252,.05)}');
R.push('.dn-run-item:last-child{border-bottom:none}');
R.push('.dn-run-dot{width:8px;height:8px;border-radius:50%;background:var(--acc,#1f6feb);flex-shrink:0}');
R.push('.dn-run-date{font-size:11px;font-weight:600;color:var(--txt,#eaeaea);min-width:120px}');
R.push('.dn-run-counts{font-size:11px;color:var(--txt2,#8b949e);flex:1}');
R.push('.dn-run-rel{font-size:10px;color:var(--mut,#6e7681)}');
R.push('.dn-dec-table{width:100%;border-collapse:collapse;font-size:11px}');
R.push('.dn-dec-table th{text-align:left;padding:7px 16px;font-size:10px;font-weight:600;color:var(--mut,#6e7681);text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--bdr,rgba(240,246,252,.12))}');
R.push('.dn-dec-table td{padding:7px 16px;border-bottom:1px solid rgba(240,246,252,.04);vertical-align:top;color:var(--txt2,#8b949e)}');
R.push('.dn-dec-table tr:last-child td{border-bottom:none}');
R.push('.dn-dec-table tr:hover td{background:rgba(255,255,255,.02)}');
R.push('.dn-empty{padding:40px 20px;text-align:center;color:var(--mut,#6e7681);font-size:12px;display:flex;flex-direction:column;align-items:center;gap:10px}');
R.push('.dn-empty-icon{font-size:28px;opacity:.4}');
R.push('@keyframes dn-spin{to{transform:rotate(360deg)}}');
R.push('.dn-spin{display:inline-block;animation:dn-spin .8s linear infinite}');
s.textContent=R.join('
'); document.head.appendChild(s); }
function _decLabel(d){
  if(!d)return '';
  if(d==='NEW_UPDATE')return'<span class=dn-result__dec dn-result__dec--new>New update</span>';
  if(d==='NO_ACTION_NEEDED')return'<span class=dn-result__dec dn-result__dec--skip>No action</span>';
  if(d==='NO_UPDATE_TODAY_NOT_LOGGED')return'<span class=dn-result__dec dn-result__dec--skip>No update logged</span>';
  if(d==='ERROR')return'<span class=dn-result__dec dn-result__dec--err>Error</span>';
  return '<span class=dn-result__dec dn-result__dec--skip>'+_safe(d)+'</span>';
}
function _resultDot(r){
  if(r.decision==='ERROR')return'<span class="dn-result__dot" style="color:var(--red,#f85149)">✗</span>';
  if(r.hasChanges&&r.note)return'<span class="dn-result__dot" style="color:var(--grn,#3fb950)">✓</span>';
  return'<span class="dn-result__dot" style="color:var(--mut,#6e7681)">–</span>';
}
function _renderStats(){
  const el=_el&&_el.querySelector('#dn-stats'); if(!el)return;
  const totalRuns=_lastLog.length;
  const totalNotes=_lastLog.reduce((a,r)=>a+(r.withUpdates||0),0);
  const last=totalRuns?_lastLog[0]:null;
  const lru=last?(last.count||0):0;
  const lrts=last?_fmtDT(last.timestamp):'—';
  el.innerHTML='<div class="dn-stat"><div class="dn-stat__val">'+totalRuns+'</div><div class="dn-stat__lbl">Total Runs</div></div>'+
  '<div class="dn-stat"><div class="dn-stat__val">'+totalNotes+'</div><div class="dn-stat__lbl">Notes Generated</div></div>'+
  '<div class="dn-stat"><div class="dn-stat__val">'+lru+'</div><div class="dn-stat__lbl">Units Last Run</div></div>'+
  '<div class="dn-stat" style="min-width:180px"><div class="dn-stat__val" style="font-size:13px;padding-top:3px">'+lrts+'</div><div class="dn-stat__lbl">Last Run</div></div>';
}
function _renderLastRun(){
  const el=_el&&_el.querySelector('#dn-lastrun-body'); if(!el)return;
  const last=_lastLog.length?_lastLog[0]:null;
  if(!last||!Array.isArray(last.results)||!last.results.length){
    el.innerHTML='<div class="dn-empty"><div class="dn-empty-icon">&#128203;</div><div>No run data yet. Hit <strong>Run Now</strong> to start.</div></div>'; return; }
  el.innerHTML=last.results.map(function(r){
    const hn=r.hasChanges&&r.note;
    return'<div class="dn-result"><div class="dn-result__row">'+_resultDot(r)+
    '<span class="dn-result__uid">'+_safe(r.unitId)+'</span>'+
    '<span class="dn-result__vendor">'+_safe(r.vendor||'')+'</span>'+_decLabel(r.decision)+'</div>'+
    (hn?'<div class="dn-result__note">'+_safe(r.note)+'</div>':'')+'</div>';
  }).join('');
}
function _renderRunLog(){
  const el=_el&&_el.querySelector('#dn-runlog-body'); if(!el)return;
  if(!_lastLog.length){el.innerHTML='<div class="dn-empty"><div class="dn-empty-icon">&#128200;</div><div>No run history yet.</div></div>';return;}
  el.innerHTML=_lastLog.map(function(run){
    return'<div class="dn-run-item"><div class="dn-run-dot"></div>'+
    '<div class="dn-run-date">'+_fmtDate(run.timestamp)+'</div>'+
    '<div class="dn-run-counts"><span style="color:var(--grn,#3fb950)">'+(run.withUpdates||0)+' notes</span> &middot; '+((run.count||0)-(run.withUpdates||0))+' skipped &middot; '+(run.count||0)+' units</div>'+
    '<div class="dn-run-rel">'+_relTime(run.timestamp)+'</div></div>';
  }).join('');
}
function _renderDecisionLog(){
  const el=_el&&_el.querySelector('#dn-declog-body'); if(!el)return;
  const all=[];(_lastLog||[]).forEach(function(run){(run.results||[]).forEach(function(r){all.push(Object.assign({},r,{runTS:run.timestamp}));});});
  if(!all.length){el.innerHTML='<div class="dn-empty"><div class="dn-empty-icon">&#128220;</div><div>No decision data yet.</div></div>';return;}
  const rows=all.slice(0,100).map(function(r){return'<tr><td style="font-weight:600;color:var(--txt,#eaeaea)">'+_safe(r.unitId)+'</td><td>'+_decLabel(r.decision)+'</td><td style="max-width:280px">'+_safe(r.reason||'—')+'</td><td style="white-space:nowrap">'+_fmtDT(r.runTS)+'</td></tr>';}).join('');
  el.innerHTML='<table class="dn-dec-table"><thead><tr><th>Unit</th><th>Decision</th><th>Reason</th><th>Run Time</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
function _updateRunBtn(){
  const btn=_el&&_el.querySelector('#dn-run-btn'); if(!btn)return;
  if(_running){btn.disabled=true;btn.innerHTML='<span class="dn-spin">↻</span> Running…';}else{btn.disabled=false;btn.innerHTML='▶ Run Now';}
}
function _updateHeaderBadge(){
  const badge=_el&&_el.querySelector('#dn-last-badge'); if(!badge)return;
  const last=_lastLog.length?_lastLog[0]:null;
  if(!last){badge.textContent='Never run';badge.className='dn-badge dn-badge--muted';return;}
  const h=Math.floor((Date.now()-new Date(last.timestamp).getTime())/3600000);
  if(h<1){badge.textContent='Run < 1h ago';badge.className='dn-badge';}
  else if(h<8){badge.textContent=h+'h ago';badge.className='dn-badge';}
  else{badge.textContent='Last run: '+_fmtDate(last.timestamp);badge.className='dn-badge dn-badge--warn';}
}
function _updateCounts(){
  const last=_lastLog.length?_lastLog[0]:null;
  const lrc=_el.querySelector('#dn-lastrun-count'); if(lrc)lrc.textContent=last?(last.count||0):0;
  const rlc=_el.querySelector('#dn-runlog-count'); if(rlc)rlc.textContent=_lastLog.length;
  const dlc=_el.querySelector('#dn-declog-count');
  const dc=_lastLog.reduce((n,r)=>n+(r.results?r.results.length:0),0); if(dlc)dlc.textContent=Math.min(dc,100);
}
function _wireToggle(headId,bodyId,chevId){
  const head=_el.querySelector('#'+headId); const body=_el.querySelector('#'+bodyId); const chev=_el.querySelector('#'+chevId);
  if(!head||!body)return;
  head.addEventListener('click',function(){const hidden=body.classList.toggle('dn-card__body--hidden'); if(chev)chev.classList.toggle('dn-card__chev--open',!hidden);});
}
async function _loadLog(){
  try{
    const log=typeof window.getDailyNotesLog==='function'?await window.getDailyNotesLog():[];
    _lastLog=Array.isArray(log)?log.slice().reverse():[];
  }catch(e){console.warn('[daily-notes view] getDailyNotesLog error:',e);_lastLog=[];}
}
function _rAll(){_renderStats();_renderLastRun();_renderRunLog();_renderDecisionLog();_updateRunBtn();_updateCounts();}
async function _activate(){ await _loadLog(); _rAll(); _updateHeaderBadge(); }
async function _doRun(){
  if(_running)return;
  if(typeof window.runDailyNotes!=='function'){bus.emit('ui:toast',{type:'warning',message:'runDailyNotes not available',duration:3000});return;}
  const units=window.UNITS?Object.values(window.UNITS):[];
  if(!units.length){bus.emit('ui:toast',{type:'warning',message:'No units loaded -- sync first',duration:3000});return;}
  _running=true; _updateRunBtn();
  try{await window.runDailyNotes(units);await _loadLog();_rAll();_updateHeaderBadge();}catch(e){console.warn('[daily-notes view] run error:',e);}finally{_running=false;_updateRunBtn();}
}
function _buildScaffold(){
  _el.innerHTML=
    '<div class="dn-wrap">'+
    '<button class="dn-back" id="dn-back-btn">← Fleet Table</button>'+
    '<div class="dn-header"><div class="dn-header__left"><div class="dn-title">&#128203; Daily Notes</div><span class="dn-badge dn-badge--muted" id="dn-last-badge">Never run</span></div>'+
    '<div class="dn-header__right"><button class="dn-btn dn-btn--ghost" id="dn-refresh-btn">蘵 Refresh</button><button class="dn-btn dn-btn--primary" id="dn-run-btn">▶ Run Now</button></div></div>'+
    '<div class="dn-stats" id="dn-stats"></div>'+
    '<div class="dn-card"><div class="dn-card__head" id="dn-lastrun-head"><div class="dn-card__title">&#127970; Last Run Results<span class="dn-card__count" id="dn-lastrun-count">0</span></div><span class="dn-card__chev dn-card__chev--open" id="dn-lastrun-chev">&#9660;</span></div><div class="dn-card__body" id="dn-lastrun-body"></div></div>'+
    '<div class="dn-card"><div class="dn-card__head" id="dn-runlog-head"><div class="dn-card__title">&#128200; Run History<span class="dn-card__count" id="dn-runlog-count">0</span></div><span class="dn-card__chev dn-card__chev--open" id="dn-runlog-chev">&#9660;</span></div><div class="dn-card__body" id="dn-runlog-body"></div></div>'+
    '<div class="dn-card"><div class="dn-card__head" id="dn-declog-head"><div class="dn-card__title">&#128220; Decision Log<span class="dn-card__count" id="dn-declog-count">0</span></div><span class="dn-card__chev" id="dn-declog-chev">&#9660;</span></div><div class="dn-card__body dn-card__body--hidden" id="dn-declog-body"></div></div>'+
    '</div>';
}
export function init(container){
  _injectCss();
  _el=document.createElement('div');
  _el.id='view-daily-notes';
  _el.className='view view--daily-notes';
  _el.style.display='none';
  _buildScaffold();
  container.appendChild(_el);
  _el.querySelector('#dn-back-btn').addEventListener('click',()=>bus.emit('ui:view-change',{from:'daily-notes',to:'fleet'}));
  _el.querySelector('#dn-run-btn').addEventListener('click',_doRun);
  const refBtn=_el.querySelector('#dn-refresh-btn'); refBtn.addEventListener('click',async function(){refBtn.disabled=true; refBtn.innerHTML='↻'; await _activate(); refBtn.disabled=false; refBtn.innerHTML='↻ Refresh';});
  _wireToggle('dn-lastrun-head','dn-lastrun-body','dn-lastrun-chev');
  _wireToggle('dn-runlog-head','dn-runlog-body','dn-runlog-chev');
  _wireToggle('dn-declog-head','dn-declog-body','dn-declog-chev');
  bus.on('ui:view-change',({to})=>{
    const vis=to==='daily-notes';
    _el.style.display=vis?'flex':'none';
    if(vis)_activate();
  });
  bus.on('fleet:data',()=>{if(_el.style.display!=='none')_activate();});
  console.log('[daily-notes view] init complete');
}