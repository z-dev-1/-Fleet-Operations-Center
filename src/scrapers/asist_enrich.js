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

const SR_RE = /https?:\/\/volvopg\.asist\.decisiv\.net\/service_requests\/([A-Za-z0-9_-]+)/i;
const PAGE_LOAD_TIMEOUT = 25000; const POLL_INTERVAL = 1000; const POLL_MAX = 20;
const MAX_RESPONSE_HOPS = 3; // bounds the SR -> response-case -> response-case chase

const ASIST_SCRAPE = String.raw`
(function() {
  var body = document.body ? document.body.innerText : '';
  var hrefs = Array.from(document.querySelectorAll('a[href]')).map(function(a){return String(a.href||'');});
  var combined = hrefs.join(' ')+' '+body;
  var reEst=/https?:\/\/volvopg\.asist\.decisiv\.net\/fleet\/estimates\/([A-Za-z0-9_-]+)/gi;
  var reCase=/https?:\/\/volvopg\.asist\.decisiv\.net\/(?:service_requests\/case-|cases\/)([A-Za-z0-9_-]+)/gi;
  var reSR=/https?:\/\/volvopg\.asist\.decisiv\.net\/service_requests\/([A-Za-z0-9_-]+)/gi;
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
  return{currentUrl:location.href,estimateLinks:estimateLinks,caseLinks:caseLinks,srLinks:srLinks,responseCaseLinks:responseCaseLinks,caseNumbers:caseNumbers,srNumbers:srNumbers,srStatus:rf('Status'),dealer:dealerName,complaint:rf('Complaint'),assetVin:rf('VIN'),unitNumber:rf('Unit Number'),pageText:body.substring(0,12000),pageReady:body.length>300};
})()
`;

function _empty(srUrl,err){return{ok:false,srUrl:srUrl||'',srNumber:'',caseNumber:'',caseUrl:'',estimateUrl:'',bestUrl:srUrl||'',bestLabel:srUrl?'Service Request':'N/A',source:srUrl?'service_request':'none',scrapedAt:new Date().toISOString(),dealer:'',error:err||null};}

async function pollScrape(win){for(let i=0;i<POLL_MAX;i++){await new Promise(r=>setTimeout(r,POLL_INTERVAL));if(!win||win.isDestroyed())return null;try{const d=await win.webContents.executeJavaScript('(function(){try{return '+ASIST_SCRAPE.trim()+'}catch(e){return{pageReady:false};}})()');if(d&&d.pageReady)return d;}catch(_){}}return null;}

async function openAndScrape(url,partition){return new Promise(resolve=>{const win=new BrowserWindow({show:false,webPreferences:{partition,nodeIntegration:false,contextIsolation:true,webSecurity:true}});let res=false;const done=v=>{if(!res){res=true;resolve(v);}};const t=setTimeout(()=>{logger.warn('[ae] timeout',url.slice(0,60));if(!win.isDestroyed())win.destroy();done(null);},PAGE_LOAD_TIMEOUT+POLL_MAX*POLL_INTERVAL);attachAutoLogin(win,url,{maxRetries:2});win.webContents.once('did-finish-load',async()=>{try{const d=await pollScrape(win);clearTimeout(t);if(!win.isDestroyed())win.destroy();done(d);}catch(e){clearTimeout(t);if(!win.isDestroyed())win.destroy();done(null);}});win.webContents.on('did-fail-load',((_,c)=>{if(c!==-3){clearTimeout(t);if(!win.isDestroyed())win.destroy();done(null);}}));win.loadURL(url);});}

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
  if(!srUrl||!SR_RE.test(srUrl))return _empty(srUrl,'not a Volvo ASIST SR URL');
  const part=partitionForUrl(srUrl);
  if(!part)return _empty(srUrl,'no partition found');
  logger.info('[ae] START',srUrl.slice(0,80));
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
  logger.info('[ae] DONE | src:',src,'case:',caseNum,'bestUrl:',bUrl.slice(0,80));
  // Combine all scraped page text for timeline building
  const offsiteText = (sr.pageText || '').trim();
  return{ok:true,srUrl,srNumber:srNum,caseNumber:caseNum,caseUrl,estimateUrl:estUrl,bestUrl:bUrl,bestLabel:bLabel,source:src,scrapedAt:new Date().toISOString(),error:null,srStatus:sr.srStatus||'',dealer:sr.dealer||'',complaint:sr.complaint||'',assetVin:sr.assetVin||'',unitNumber:sr.unitNumber||'',offsiteText};
}

const SOURCE_RANK={estimate:3,case:2,service_request:1,none:0};
function isUpgrade(es,ns){return(SOURCE_RANK[ns]||0)>(SOURCE_RANK[es]||0);}

module.exports={enrichVolvoAsist,isUpgrade,SOURCE_RANK};
