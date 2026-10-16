'use strict';
// scrapers/asist_enrich.js -- Volvo ASIST Offsite Enrichment [V-C] S25-9
//
// UPDATE (2026-07-20): added "response case" link chasing. Confirmed via a
// real recorded walkthrough (unit 321549): the Volvo ASIST SR page's
// Responses section has a "Case #: <number>" link (inside
// #service_request_responses) pointing to ANOTHER plain
// /service_requests/<id> URL -- not the /service_requests/case-<id> or
// /cases/<id> shape the old `reCase` regex required. That mismatch meant
// this link was scraped into `srLinks` but NEVER actually followed --
// srLinks was computed and returned but not read anywhere in
// enrichVolvoAsist()'s decision logic. This is the confirmed root cause of
// enrichment stalling on the shallow SR page instead of reaching the
// eventual /fleet/estimates/ link once the vendor's estimate exists.

const { BrowserWindow } = require('electron');
const { partitionForUrl, attachAutoLogin } = require('../orcha/auto-login');
const logger = require('../utils/logger')('asist-enrich');

// Both Volvo and PACCAR use the Decisiv platform with identical URL shapes:
//   Volvo:  https://volvopg.asist.decisiv.net/service_requests/<id>
//   PACCAR: https://paccarpg.decisiv.net/service_requests/<id>
// (and /fleet/estimates/<id>, /cases/<id>, /service_requests/case-<id>).
// ASIST_DOMAIN matches either host so the SR->Case->Estimate chase works for
// both. (2026-08-17: extended from Volvo-only to include PACCAR.)
const ASIST_DOMAIN = String.raw`(?:volvopg\.asist|paccarpg)\.decisiv\.net`;
const SR_RE = new RegExp('https?://' + ASIST_DOMAIN + '/service_requests/([A-Za-z0-9_-]+)', 'i');
// A direct Decisiv Fleet Estimate URL (PACCAR or Volvo). The dealer's own
// status comments ("part was damaged, waiting for a new one") are posted ON
// this estimate page and are frequently NOT mirrored into the Relay thread, so
// we must open and scrape it directly — not just record the link.
const EST_RE = new RegExp('https?://' + ASIST_DOMAIN + '/fleet/estimates/([A-Za-z0-9_-]+)', 'i');
const PAGE_LOAD_TIMEOUT = 25000; const POLL_INTERVAL = 1000; const POLL_MAX = 20;
const MAX_RESPONSE_HOPS = 3; // bounds the SR -> response-case -> response-case chase

const ASIST_SCRAPE = String.raw`
(function() {
  var body = document.body ? document.body.innerText : '';
  var hrefs = Array.from(document.querySelectorAll('a[href]')).map(function(a){return String(a.href||'');});
  var combined = hrefs.join(' ')+' '+body;
  var reEst=/https?:\/\/(?:volvopg\.asist|paccarpg)\.decisiv\.net\/fleet\/estimates\/([A-Za-z0-9_-]+)/gi;
  var reCase=/https?:\/\/(?:volvopg\.asist|paccarpg)\.decisiv\.net\/(?:service_requests\/case-|cases\/)([A-Za-z0-9_-]+)/gi;
  var reSR=/https?:\/\/(?:volvopg\.asist|paccarpg)\.decisiv\.net\/service_requests\/([A-Za-z0-9_-]+)/gi;
  var reCNum=/\bCase\s*#?\s*(\d{6,12})\b/gi; var reSRN=/\b(C-\d{6,10}|SR-\d{5,10})\b/gi;
  function collect(re,str){var f=[],m;re.lastIndex=0;while((m=re.exec(str))!==null){var url=m[0].split(/[\s<>]/)[0],id=(m[1]||'').replace(/[/?#].*$/,'');if(!f.find(function(x){return x.url===url;}))f.push({url:url,id:id});}return f;}
  var estimateLinks=collect(reEst,combined),caseLinks=collect(reCase,combined);
  var srLinks=collect(reSR,combined).filter(function(x){return !/\/fleet\/estimates\/|\/case-|\/cases\//.test(x.url);});
  // Response-case links: a link inside #service_request_responses (confirmed
  // real container from live recording) pointing to a plain /service_requests/
  // URL that is NOT this page's own URL. Falls back to scanning for any link
  // whose nearby text contains "Case #" if that container isn't present --
  // some ASIST page variants may render the Responses section differently.
  var responseCaseLinks = [];
  var respContainer = document.getElementById('service_request_responses');
  var respLinks = respContainer ? Array.from(respContainer.querySelectorAll('a[href]')) : [];
  respLinks.forEach(function(a) {
    var href = String(a.href || '');
    if (/\/service_requests\/[A-Za-z0-9_-]+/i.test(href) && href !== location.href) {
      var label = (a.innerText || a.textContent || '').trim().slice(0, 40);
      if (!responseCaseLinks.find(function(x){return x.url===href;})) responseCaseLinks.push({url: href, label: label});
    }
  });
  if (!responseCaseLinks.length) {
    Array.from(document.querySelectorAll('a[href]')).forEach(function(a) {
      var href = String(a.href || '');
      if (!/\/service_requests\/[A-Za-z0-9_-]+/i.test(href) || href === location.href) return;
      var ctx = (a.parentElement ? a.parentElement.innerText : '') || '';
      if (/case\s*#/i.test(ctx)) {
        var label = (a.innerText || a.textContent || '').trim().slice(0, 40);
        if (!responseCaseLinks.find(function(x){return x.url===href;})) responseCaseLinks.push({url: href, label: label});
      }
    });
  }
  var caseNumbers=[],m2;reCNum.lastIndex=0;while((m2=reCNum.exec(body))!==null)if(!caseNumbers.includes(m2[1]))caseNumbers.push(m2[1]);
  var srNumbers=[];reSRN.lastIndex=0;while((m2=reSRN.exec(body))!==null)if(!srNumbers.includes(m2[1]))srNumbers.push(m2[1]);
  function rf(lb){var i=body.indexOf(lb);if(i<0)return'';return body.slice(i+lb.length,i+lb.length+120).split('\n')[0].replace(/^\s*:\s*/,'').trim().slice(0,80);}
  // FIX: confirmed live (unit 321549) -- rf('Location')/rf('Service Location')/
  // rf('Shop') can grab a whole multi-field asset/unit info block instead of
  // an actual dealer name, when the real page has no newline between adjacent
  // label:value pairs (rf() only splits on '\n'). Real example captured:
  // "ABE40 @ 1132 N Irving St, Allentown PA 18109 Unit: 321549 Key location:
  // Service" was saved as dealerName and shown to the user on the offsite
  // card -- clearly not a business name. isPlausibleDealerName() rejects
  // extractions containing tell-tale field-label markers ("Unit:", "Key
  // location", "Site:") or looking like a full street address, rather than
  // guessing at the exact page layout without having seen it directly.
  function isPlausibleDealerName(s){if(!s)return false;if(/unit\s*:|key\s*location|site\s*:/i.test(s))return false;if(/\d+\s+[A-Za-z].*,\s*[A-Za-z]+\s+[A-Z]{2}\s+\d{5}/.test(s))return false;if(s.length>60)return false;return true;}
  var _dealerRaw=rf('Dealer')||rf('Location')||rf('Service Location')||rf('Shop');
  var dealerName=isPlausibleDealerName(_dealerRaw)?_dealerRaw:'';
  // STATUS/RESPONSES THREAD (2026-10): the dealer's actual status updates
  // ("Asset is Ready", "REPAIRS ARE COMPLETED", "Case status set to Asset
  // Ready", "ready to be picked up") live in the Responses section of the
  // service_request page -- NOT on the estimate page the chase ends on. The old
  // scraper only read this container for LINKS and never captured the note
  // text, so the single most important update (repairs done, come get it) never
  // reached the timeline. Capture that text explicitly here.
  var responsesText = '';
  // (a) Known container id (confirmed on some variants).
  var _respEl = document.getElementById('service_request_responses');
  if (_respEl && _respEl.innerText) responsesText = _respEl.innerText;
  // (b) WIDENED (2026-10): the dated vendor<->us RESPONSE entries (the real
  // back-and-forth: "Jose Mallen - Hunter Truck ... to Z SANTIAGO - Amazon
  // Logistics / <date> / <message>") don't always live under that id. Try a set
  // of candidate containers whose class/id looks like a responses/conversation
  // feed, and keep the richest (longest) innerText. This is what lets the
  // reconcile AI see who actually spoke last.
  if (responsesText.length < 200) {
    var _candSel = ['[id*=response]','[class*=response]','[id*=conversation]',
                    '[class*=conversation]','[class*=comment]','[class*=message]',
                    '[class*=thread]','[class*=activity]','[class*=feed]'];
    var _best = responsesText;
    for (var _ci = 0; _ci < _candSel.length; _ci++) {
      var _els = document.querySelectorAll(_candSel[_ci]);
      for (var _ei = 0; _ei < _els.length; _ei++) {
        var _t = (_els[_ei] && _els[_ei].innerText) ? _els[_ei].innerText : '';
        // Prefer blocks that actually look like a dated exchange.
        if (_t.length > _best.length &&
            /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(_t)) {
          _best = _t;
        }
      }
    }
    if (_best.length > responsesText.length) responsesText = _best;
  }
  // (c) Keyword-window fallback — status phrases, keep the note + its date.
  // WIDENED (2026-10): added common dealer-comment wording seen on PACCAR/Volvo
  // ESTIMATE pages ("part was damaged", "waiting for a new one", "part(s) came
  // in", "will update you") so a dealer status note posted only on the estimate
  // (not the SR thread) still gets captured even if tiers (a)/(b) miss its
  // container. Confirmed example (unit B62060, 10/12): "the part we received was
  // damaged - we are waiting for new one to come in".
  if (responsesText.length < 60) {
    var _statusRe = /(asset\s+is\s+ready|asset\s+ready|repairs?\s+(are\s+)?(completed|started|in\s+progress)|ready\s+to\s+be\s+picked\s+up|ready\s+for\s+pick\s*up|case\s+status\s+set\s+to|work\s+order\s+completed|unit\s+is\s+ready|freight|back\s*order|parts?\s+(on\s+order|ordered|came\s+in|arrived|received|damaged)|waiting\s+(for|on)\s+(the\s+)?(part|new)|new\s+one\s+to\s+come|will\s+update\s+you|please\s+advise|estimate\s+approved|awaiting)/i;
    if (_statusRe.test(body)) {
      var _mi = body.search(_statusRe);
      var _from = Math.max(0, _mi - 400);
      responsesText = body.slice(_from, _mi + 900);
    }
  }
  responsesText = String(responsesText || '').replace(/\s+\n/g, '\n').trim().slice(0, 6000);
  // ── OFFSITE STATUS-BAR STAGE ───────────────────────────────────────────────
  // The Decisiv SR page renders a horizontal progress tracker:
  //   Arrival → Diagnosis → Approval → Repair → Ready
  // The FURTHEST-RIGHT stage that is marked active/complete is the unit's true
  // lifecycle position per the vendor. This is a clean structured signal that
  // the free-text comment feed does NOT always carry (a unit can be truly ready
  // without a "ready" comment, or carry an OLD "will be ready" note). We capture
  // it so the assistant never claims a unit is "Ready" unless this bar actually
  // reached the Ready node (or a comment explicitly confirms it). Resilient to
  // CSS-hash churn: we match the stage LABELS by text, then look at each label's
  // own node + a few ancestors for completed/active/done markers (class, aria,
  // data-* attrs). If markers are ambiguous we fall back to the last stage whose
  // label is immediately followed (in the ordered label list) by an incomplete
  // one — i.e. the current step.
  var offsiteStage = '';
  var offsiteStageConfidence = '';
  try {
    var STAGE_ORDER = ['arrival','diagnosis','approval','repair','ready'];
    // Find a DOM node whose trimmed text is exactly one of the stage labels.
    var allEls = Array.from(document.querySelectorAll('*'));
    var stageNodes = {}; // label -> element
    for (var si = 0; si < allEls.length; si++) {
      var el = allEls[si];
      // Only consider leaf-ish nodes (few children) so we match the label chip,
      // not a big container that happens to contain the word.
      if (el.children && el.children.length > 2) continue;
      var t = (el.textContent || '').trim().toLowerCase();
      var idx = STAGE_ORDER.indexOf(t);
      if (idx >= 0 && !stageNodes[t]) stageNodes[t] = el;
    }
    function isDoneOrActive(node) {
      // Walk the label node + up to 4 ancestors; return 'done' if any marks the
      // stage complete, 'active' if current, '' otherwise.
      var n = node, best = '';
      for (var d = 0; d < 5 && n; d++) {
        var cls = String(n.className && n.className.baseVal != null ? n.className.baseVal : (n.className || '')).toLowerCase();
        var aria = String((n.getAttribute && (n.getAttribute('aria-current') || n.getAttribute('aria-selected') || n.getAttribute('data-status') || n.getAttribute('data-state'))) || '').toLowerCase();
        var blob = cls + ' ' + aria;
        if (/complete|completed|done|finished|passed|checked|fulfilled/.test(blob)) return 'done';
        if (/\bactive\b|\bcurrent\b|\bselected\b|in[-_ ]?progress|aria-current/.test(blob) || aria === 'true' || aria === 'step') best = best || 'active';
        n = n.parentElement;
      }
      return best;
    }
    var lastDoneIdx = -1, activeIdx = -1;
    for (var k = 0; k < STAGE_ORDER.length; k++) {
      var lbl = STAGE_ORDER[k];
      if (!stageNodes[lbl]) continue;
      var st = isDoneOrActive(stageNodes[lbl]);
      if (st === 'done') lastDoneIdx = k;
      else if (st === 'active' && activeIdx < 0) activeIdx = k;
    }
    var chosenIdx = -1, conf = '';
    if (activeIdx >= 0) { chosenIdx = activeIdx; conf = 'active-marker'; }
    else if (lastDoneIdx >= 0) { chosenIdx = lastDoneIdx; conf = 'completed-marker'; }
    // Last-resort: if NO markers were detected but the Ready label itself exists
    // and the body text explicitly says the asset is ready, treat it as ready.
    if (chosenIdx < 0 && stageNodes['ready'] &&
        /asset\s+is\s+ready|ready\s+to\s+be\s+picked\s+up|ready\s+for\s+pick\s*up|repairs?\s+(are\s+)?completed/i.test(body)) {
      chosenIdx = 4; conf = 'text-fallback';
    }
    if (chosenIdx >= 0) { offsiteStage = STAGE_ORDER[chosenIdx]; offsiteStageConfidence = conf; }
  } catch (_stageErr) { /* best-effort — leave offsiteStage empty */ }
  return{currentUrl:location.href,estimateLinks:estimateLinks,caseLinks:caseLinks,srLinks:srLinks,responseCaseLinks:responseCaseLinks,caseNumbers:caseNumbers,srNumbers:srNumbers,srStatus:rf('Status'),dealer:dealerName,complaint:rf('Complaint'),assetVin:rf('VIN'),unitNumber:rf('Unit Number'),responsesText:responsesText,offsiteStage:offsiteStage,offsiteStageConfidence:offsiteStageConfidence,pageText:body.substring(0,12000),pageReady:body.length>300};
})()
`;

function _empty(srUrl,err){return{ok:false,srUrl:srUrl||'',srNumber:'',caseNumber:'',caseUrl:'',estimateUrl:'',bestUrl:srUrl||'',bestLabel:srUrl?'Service Request':'N/A',source:srUrl?'service_request':'none',scrapedAt:new Date().toISOString(),dealer:'',statusText:'',estimateComments:'',offsiteText:'',offsiteStage:'',error:err||null};}

async function pollScrape(win){for(let i=0;i<POLL_MAX;i++){await new Promise(r=>setTimeout(r,POLL_INTERVAL));if(!win||win.isDestroyed())return null;try{const d=await win.webContents.executeJavaScript('(function(){try{return '+ASIST_SCRAPE.trim()+'}catch(e){return{pageReady:false};}})()');if(d&&d.pageReady)return d;}catch(_){}}return null;}

async function openAndScrape(url,partition){return new Promise(resolve=>{const win=new BrowserWindow({show:false,webPreferences:{partition,nodeIntegration:false,contextIsolation:true,webSecurity:true}});let res=false;const done=v=>{if(!res){res=true;resolve(v);}};const t=setTimeout(()=>{logger.warn('[ae] timeout',url.slice(0,60));if(!win.isDestroyed())win.destroy();done(null);},PAGE_LOAD_TIMEOUT+POLL_MAX*POLL_INTERVAL);attachAutoLogin(win,url,{maxRetries:2});win.webContents.once('did-finish-load',async()=>{try{const d=await pollScrape(win);clearTimeout(t);if(!win.isDestroyed())win.destroy();done(d);}catch(e){clearTimeout(t);if(!win.isDestroyed())win.destroy();done(null);}});win.webContents.on('did-fail-load',((_,c)=>{if(c!==-3){clearTimeout(t);if(!win.isDestroyed())win.destroy();done(null);}}));win.loadURL(url);});}

// ── Decisiv FLEET ESTIMATE page — Notes/comment thread scrape ───────────────
// The estimate page (PACCAR Insite / Volvo ASIST) renders tabs:
//   Notes | Attachments | Case Info (VMRS) | Inspections
// The dealer's status comments ("part was damaged, waiting for a new one") live
// under the NOTES tab, which LAZY-LOADS ("Loading..."). The generic ASIST_SCRAPE
// returned pageReady as soon as the estimate STRUCTURE (pricing/operations/asset
// specs) rendered — before Notes loaded — so commentThread came back 0ch and
// asistNotes was 10k of pricing noise. This dedicated script (a) clicks the
// Notes tab, (b) reports whether the Notes COMMENT TEXT has actually rendered
// (notesReady), and (c) extracts ONLY the Notes section — not the whole page.

// Clicks the "Notes" tab by visible text (resilient to CSS-hash class churn).
const ESTIMATE_CLICK_NOTES = String.raw`
(function(){
  // The estimate page is AngularJS; the Notes tab is #toolbutton_notes and its
  // content lazy-renders into #notes_workspace via a renderNotes() call. Click
  // by id first (most reliable), then fall back to text match.
  var btn = document.getElementById('toolbutton_notes');
  if(btn){ try{ btn.click(); return "clicked#toolbutton_notes"; }catch(e){} }
  var els=[].slice.call(document.querySelectorAll("a,button,li,[role=tab],[class*=tab],[class*=Tab],span,div"));
  for(var i=0;i<els.length;i++){
    var t=(els[i].textContent||"").trim();
    // Exact "Notes" (avoid "Attachments"/"Case Info"); the tab label is short.
    if(/^notes$/i.test(t)){ try{ els[i].click(); return "clicked"; }catch(e){} }
  }
  return "no-notes-tab";
})()
`;

// Reads the Notes/comment thread from the estimate page's #notes_workspace
// container specifically. Confirmed via live DOM diagnostic: the dealer's
// Notes render (lazy, via an AngularJS renderNotes() AJAX call) into
// #notes_workspace, which initially shows "Loading..." then populates with the
// dated comment entries. The old heuristic mis-grabbed the status metadata
// panel because it rejected the still-"Loading..." notes container. Fix: read
// #notes_workspace directly and treat "Loading..." (or the inlined renderNotes
// function source) as NOT ready, so the poller keeps waiting until it fills in.
const ESTIMATE_SCRAPE = String.raw`
(function(){
  var body = document.body ? document.body.innerText : '';
  function clean(s){return (s||'').replace(/[\t ]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();}
  // The Notes feed container (confirmed id from live DOM).
  var ws = document.getElementById('notes_workspace');
  var wsTxt = ws ? clean(ws.innerText || '') : '';
  // "not loaded yet" = empty, the Loading placeholder, or the renderNotes()
  // JS source that sits in the container before the AJAX content replaces it.
  var stillLoading = !wsTxt
    || /^\s*loading/i.test(wsTxt)
    || /function\s+renderNotes\s*\(/.test(wsTxt)
    || wsTxt.length < 40;
  var best = stillLoading ? '' : wsTxt;
  // Fallback: some estimate variants render notes into a sibling container.
  if(!best){
    var alt = document.querySelector('[id*=notes][id*=workspace], .notes-list, #notes_list, [class*=note-list]');
    var altTxt = alt ? clean(alt.innerText || '') : '';
    if(altTxt && !/^\s*loading/i.test(altTxt) && !/function\s+renderNotes/.test(altTxt) && altTxt.length>=40) best = altTxt;
  }
  var ready = best.length>=40;
  return { commentThread: best.slice(0,6000), notesReady: ready, bodyLen: body.length,
           wsFound: !!ws, wsLen: wsTxt.length, stillLoading: stillLoading };
})()
`;

// Open an estimate page, settle past any auth redirect, click Notes, and poll
// until the comment thread actually renders.
//
// ROOT CAUSE (confirmed 2026-10 via live DOM diag + comparison with Split
// View): the dealer Notes render lazily into #notes_workspace via an AngularJS
// renderNotes() call that only fires when the page has a REAL, PAINTED
// viewport. Split View works because it shows the estimate URL in a visible,
// CSS-sized <webview>. The old scraper used `new BrowserWindow({show:false})`
// with NO size — an unpainted, zero-ish surface — so renderNotes() never fired
// and #notes_workspace stayed stuck on "Loading...". Fix: give the window a
// real size (1400x900, like Split View) and force it to paint even while
// hidden (paintWhenInitiallyHidden + backgroundThrottling:false), positioned
// far offscreen so it never flashes in front of the user.
async function openAndScrapeEstimate(url, partition){
  return new Promise(resolve=>{
    const win=new BrowserWindow({
      show:false,
      width:1400, height:900, x:-4000, y:-4000, // offscreen so it never flashes
      paintWhenInitiallyHidden:true,
      webPreferences:{ partition, nodeIntegration:false, contextIsolation:true, webSecurity:true, backgroundThrottling:false, offscreen:false },
    });
    let res=false; const done=v=>{ if(!res){res=true;resolve(v);} };
    const t=setTimeout(()=>{ logger.warn('[ae] estimate timeout', url.slice(0,60)); if(!win.isDestroyed())win.destroy(); done(null); }, PAGE_LOAD_TIMEOUT + (POLL_MAX+16)*POLL_INTERVAL);
    attachAutoLogin(win,url,{maxRetries:2});
    win.webContents.once('did-finish-load', async ()=>{
      try{
        // 1) Settle: wait until we're actually ON the estimate page (not mid
        //    login redirect) and the estimate structure has rendered.
        let settled=false;
        for(let i=0;i<10;i++){
          await new Promise(r=>setTimeout(r,800));
          if(win.isDestroyed()) return done(null);
          const u = win.webContents.getURL();
          const onEst = /\/fleet\/estimates\//i.test(u);
          const bodyLen = await win.webContents.executeJavaScript('document.body?document.body.innerText.length:0').catch(()=>0);
          if(onEst && bodyLen>600){ settled=true; break; }
        }
        if(!settled) logger.warn('[ae] estimate did not settle (login/redirect?)', url.slice(0,60));
        // 2) Click the Notes tab to trigger the renderNotes() AJAX.
        const clickRes = await win.webContents.executeJavaScript('(function(){try{return '+ESTIMATE_CLICK_NOTES.trim()+'}catch(e){return "err";}})()').catch(()=>'err');
        logger.info('[ae] estimate Notes tab:', clickRes);
        // 3) Poll until #notes_workspace fills in (notesReady). Generous budget;
        //    re-click Notes periodically in case the first activation dropped.
        let out=null;
        const EST_POLL_MAX = 30;
        for(let i=0;i<EST_POLL_MAX;i++){
          await new Promise(r=>setTimeout(r,POLL_INTERVAL));
          if(win.isDestroyed()) return done(null);
          const d = await win.webContents.executeJavaScript('(function(){try{return '+ESTIMATE_SCRAPE.trim()+'}catch(e){return{notesReady:false,commentThread:"",bodyLen:0};}})()').catch(()=>null);
          if(d){ out=d; if(d.notesReady) break; }
          if(i===2||i===6||i===12) await win.webContents.executeJavaScript('(function(){try{return '+ESTIMATE_CLICK_NOTES.trim()+'}catch(e){return "err";}})()').catch(()=>{});
        }
        if(out) logger.info('[ae] estimate scrape | wsFound:',out.wsFound,'| wsLen:',out.wsLen,'| stillLoading:',out.stillLoading,'| commentThread:',(out.commentThread||'').length+'ch');
        clearTimeout(t); if(!win.isDestroyed())win.destroy();
        done(out);
      }catch(e){ clearTimeout(t); if(!win.isDestroyed())win.destroy(); done(null); }
    });
    win.webContents.on('did-fail-load',((_,c)=>{ if(c!==-3){ clearTimeout(t); if(!win.isDestroyed())win.destroy(); done(null); } }));
    win.loadURL(url);
  });
}

// Bounded chase through response-case links (SR -> Case# response -> maybe
// another response -> ...) looking for an estimate link at each hop. Never
// revisits a URL (visited Set) and stops after MAX_RESPONSE_HOPS regardless
// of outcome -- each hop opens a real BrowserWindow, so this is intentionally
// capped to stay fast and avoid infinite chains on unusual page shapes.
async function _chaseResponseLinks(startPage, partition, visited) {
  let page = startPage;
  let hops = 0;
  let lastCaseUrl = '', lastCaseLabel = '';
  while (page && page.responseCaseLinks && page.responseCaseLinks.length && hops < MAX_RESPONSE_HOPS) {
    const next = page.responseCaseLinks.find(x => !visited.has(x.url));
    if (!next) break;
    visited.add(next.url);
    lastCaseUrl = next.url;
    lastCaseLabel = next.label;
    logger.info('[ae] following response-case link (hop ' + (hops + 1) + '):', next.url.slice(0, 80), '| label:', next.label);
    const hopPage = await openAndScrape(next.url, partition);
    hops++;
    if (!hopPage) { logger.warn('[ae] response-case page failed:', next.url.slice(0, 80)); break; }
    if (hopPage.estimateLinks && hopPage.estimateLinks.length) {
      return { estUrl: hopPage.estimateLinks[0].url, caseUrl: lastCaseUrl, caseLabel: lastCaseLabel, page: hopPage };
    }
    page = hopPage; // keep chasing if this hop has its own response-case link
  }
  return { estUrl: '', caseUrl: lastCaseUrl, caseLabel: lastCaseLabel, page };
}

async function enrichVolvoAsist(srUrl){
  const _isDirectEstimate = srUrl && EST_RE.test(srUrl);
  if(!srUrl||(!SR_RE.test(srUrl)&&!_isDirectEstimate))return _empty(srUrl,'not a Volvo/PACCAR ASIST SR or estimate URL');
  const part=partitionForUrl(srUrl);
  if(!part)return _empty(srUrl,'no partition found');
  logger.info('[ae] START',srUrl.slice(0,80),_isDirectEstimate?'(direct estimate)':'(service request)');

  // ── Direct estimate URL path ────────────────────────────────────────────
  // The offsite link is ALREADY a Fleet Estimate (common for PACCAR, where
  // Relay stores the estimate URL directly). Skip the SR->Case->Estimate chase
  // and scrape the estimate page's comment/activity thread straight away — that
  // is exactly where dealer status updates live that never reach Relay.
  if(_isDirectEstimate){
    const estId=(srUrl.match(EST_RE)||[])[1]||'';
    // Use the Notes-tab-aware estimate scraper (waits for the lazy-loaded Notes
    // comment thread; extracts ONLY the comments, not the pricing/specs body).
    const est=await openAndScrapeEstimate(srUrl,part);
    if(!est){logger.warn('[ae] estimate page failed (direct)');return _empty(srUrl,'estimate page failed');}
    const estComments=(est.commentThread||'').trim();
    // offsiteText is the COMMENT THREAD only — not the estimate structure — so
    // the AI timeline / card sees the dealer's actual status, not pricing noise.
    const offsiteText=estComments.slice(0,6000);
    logger.info('[ae] DONE (direct estimate) | est:',estId,'| commentThread:',estComments.length+'ch | notesReady:',!!est.notesReady);
    // Direct-estimate path never opens the SR page, so no status-bar stage is
    // available; infer 'ready' ONLY if the estimate comments explicitly say so.
    var _directStage = /asset\s+is\s+ready|ready\s+to\s+be\s+picked\s+up|ready\s+for\s+pick\s*up|repairs?\s+(are\s+)?completed/i.test(estComments) ? 'ready' : '';
    return{ok:true,srUrl,srNumber:'',caseNumber:estId,caseUrl:'',estimateUrl:srUrl,bestUrl:srUrl,
      bestLabel:estId?'Fleet Estimate | '+estId:'Fleet Estimate',source:'estimate',
      scrapedAt:new Date().toISOString(),error:null,srStatus:'',dealer:'',
      complaint:'',assetVin:'',unitNumber:'',offsiteStage:_directStage,
      statusText:estComments,estimateComments:estComments,offsiteText};
  }

  let srNum='',caseNum='',caseUrl='',estUrl='';
  const sr=await openAndScrape(srUrl,part);
  if(!sr){logger.warn('[ae] SR page failed');return _empty(srUrl,'SR page failed');}
  srNum=(sr.srNumbers&&sr.srNumbers[0])||'';
  logger.info('[ae] SR scraped | srNum:',srNum,'caseLinks:',sr.caseLinks.length,'estLinks:',sr.estimateLinks.length,'responseCaseLinks:',(sr.responseCaseLinks||[]).length);
  if(sr.estimateLinks&&sr.estimateLinks.length){estUrl=sr.estimateLinks[0].url;caseNum=sr.caseNumbers[0]||sr.estimateLinks[0].id||'';logger.info('[ae] est on SR page');}
  if(!estUrl&&sr.caseLinks&&sr.caseLinks.length){
    caseUrl=sr.caseLinks[0].url;caseNum=sr.caseNumbers[0]||sr.caseLinks[0].id||'';
    logger.info('[ae] following case:',caseUrl.slice(0,80));
    const cs=await openAndScrape(caseUrl,part);
    if(cs){logger.info('[ae] case scraped | estLinks:',cs.estimateLinks.length);if(cs.estimateLinks&&cs.estimateLinks.length){estUrl=cs.estimateLinks[0].url;if(!caseNum)caseNum=cs.caseNumbers[0]||cs.estimateLinks[0].id||'';logger.info('[ae] est on case page');}if(!caseNum&&cs.caseNumbers&&cs.caseNumbers[0])caseNum=cs.caseNumbers[0];}else{logger.warn('[ae] case page failed');}
  }else if(!estUrl&&sr.responseCaseLinks&&sr.responseCaseLinks.length){
    // NEW: the real-world path confirmed by recording -- plain
    // /service_requests/<id> "Case #:" link in the Responses section.
    const visited = new Set([srUrl]);
    const chased = await _chaseResponseLinks(sr, part, visited);
    if (chased.estUrl) {
      estUrl = chased.estUrl;
      caseNum = chased.caseLabel || sr.caseNumbers[0] || '';
      logger.info('[ae] est found via response-case chase | case:', caseNum);
    } else if (chased.caseUrl) {
      caseUrl = chased.caseUrl;
      caseNum = chased.caseLabel || sr.caseNumbers[0] || '';
      logger.info('[ae] no estimate yet -- advancing to response-case page:', caseUrl.slice(0,80));
    }
  }else if(!estUrl){caseNum=sr.caseNumbers[0]||'';}
  let bUrl='',bLabel='',src='none';
  if(estUrl){bUrl=estUrl;src='estimate';bLabel=caseNum?'Fleet Estimate | Case #'+caseNum:'Fleet Estimate';}
  else if(caseUrl){bUrl=caseUrl;src='case';bLabel=caseNum?'ASIST Case #'+caseNum:'ASIST Case';}
  else{bUrl=srUrl;src='service_request';bLabel=srNum?'ASIST SR '+srNum:'Service Request';}

  // ── Scrape the Fleet Estimate page's comment thread ─────────────────────
  // Once the chase resolves an estimate URL, OPEN it and read its dealer
  // comment/activity feed. Previously the chase stopped at discovering the URL
  // and never opened it, so dealer comments posted only on the estimate (not
  // mirrored to the SR Responses thread) were lost. Non-fatal: on failure we
  // fall back to the SR status thread exactly as before.
  let estimateComments = '';
  if (estUrl) {
    try {
      // Notes-tab-aware scrape: waits for the lazy-loaded Notes comment thread
      // and extracts ONLY the comments (not the pricing/specs estimate body).
      const est = await openAndScrapeEstimate(estUrl, part);
      if (est) {
        estimateComments = (est.commentThread || '').trim();
        logger.info('[ae] estimate page scraped | commentThread:', estimateComments.length + 'ch | notesReady:', !!est.notesReady);
      } else {
        logger.warn('[ae] estimate page open failed (chase):', estUrl.slice(0, 80));
      }
    } catch (_ee) { logger.warn('[ae] estimate page scrape CATCH:', _ee.message); }
  }

  logger.info('[ae] DONE | src:',src,'case:',caseNum,'bestUrl:',bUrl.slice(0,80),'| srThread:',(sr.responsesText||'').length+'ch | estThread:',estimateComments.length+'ch');
  // Build offsite text for the timeline. Lead with the ESTIMATE comment thread
  // (newest dealer status lives here) then the SR Responses thread for context.
  // Drop the estimate STRUCTURE (pricing/specs/version) — that is noise that
  // crowds the AI timeline. estimateComments is returned separately for the UI.
  const statusText = estimateComments || (sr.responsesText || '').trim();
  const srStatusThread = (sr.responsesText || '').trim();
  const srBody = (sr.pageText || '').trim();
  const parts = [];
  if (estimateComments) parts.push('--- Estimate page comments ---\n' + estimateComments);
  if (srStatusThread && srStatusThread !== estimateComments) parts.push('--- Service Request responses ---\n' + srStatusThread);
  if (!estimateComments && srBody) parts.push('--- Service Request page ---\n' + srBody);
  const offsiteText = parts.join('\n\n').slice(0, 8000) || srBody;
  // Prefer the SR page's structured status-bar stage; if that bar wasn't present
  // but the resolved comment thread explicitly says ready, treat it as 'ready'.
  let offsiteStage = sr.offsiteStage || '';
  if (!offsiteStage && /asset\s+is\s+ready|ready\s+to\s+be\s+picked\s+up|ready\s+for\s+pick\s*up|repairs?\s+(are\s+)?completed/i.test(statusText)) offsiteStage = 'ready';
  logger.info('[ae] DONE | offsiteStage:', offsiteStage || '(none)', '| stageConf:', sr.offsiteStageConfidence || '-');
  return{ok:true,srUrl,srNumber:srNum,caseNumber:caseNum,caseUrl,estimateUrl:estUrl,bestUrl:bUrl,bestLabel:bLabel,source:src,scrapedAt:new Date().toISOString(),error:null,srStatus:sr.srStatus||'',dealer:sr.dealer||'',complaint:sr.complaint||'',assetVin:sr.assetVin||'',unitNumber:sr.unitNumber||'',offsiteStage,statusText,estimateComments,offsiteText};
}

const SOURCE_RANK={estimate:3,case:2,service_request:1,none:0};
function isUpgrade(es,ns){return(SOURCE_RANK[ns]||0)>(SOURCE_RANK[es]||0);}

// enrichVolvoAsist kept as the name for back-compat with existing callers;
// enrichAsist is the accurate alias now that it handles Volvo AND PACCAR.
module.exports={enrichVolvoAsist,enrichAsist:enrichVolvoAsist,isUpgrade,SOURCE_RANK,SR_RE,openAndScrape,openAndScrapeEstimate};
