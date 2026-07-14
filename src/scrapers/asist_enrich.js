'use strict';
// scrapers/asist_enrich.js -- Volvo ASIST Offsite Enrichment [V-C] S25-9

const { BrowserWindow } = require('electron');
const { partitionForUrl, attachAutoLogin } = require('../orcha/auto-login');
const logger = require('../utils/logger')('asist-enrich');

const SR_RE = /https?:\/\/volvopg\.asist\.decisiv\.net\/service_requests\/([A-Za-z0-9_-]+)/i;
const PAGE_LOAD_TIMEOUT = 25000; const POLL_INTERVAL = 1000; const POLL_MAX = 20;

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
  var caseNumbers=[],m2;reCNum.lastIndex=0;while((m2=reCNum.exec(body))!==null)if(!caseNumbers.includes(m2[1]))caseNumbers.push(m2[1]);
  var srNumbers=[];reSRN.lastIndex=0;while((m2=reSRN.exec(body))!==null)if(!srNumbers.includes(m2[1]))srNumbers.push(m2[1]);
  function rf(lb){var i=body.indexOf(lb);if(i<0)return'';return body.slice(i+lb.length,i+lb.length+120).split('\n')[0].replace(/^\s*:\s*/,'').trim().slice(0,80);}
  return{currentUrl:location.href,estimateLinks:estimateLinks,caseLinks:caseLinks,srLinks:srLinks,caseNumbers:caseNumbers,srNumbers:srNumbers,srStatus:rf('Status'),dealer:(rf('Dealer')||rf('Location')||rf('Service Location')||rf('Shop')),complaint:rf('Complaint'),assetVin:rf('VIN'),unitNumber:rf('Unit Number'),pageText:body.substring(0,12000),pageReady:body.length>300};
})()
`;

function _empty(srUrl,err){return{ok:false,srUrl:srUrl||'',srNumber:'',caseNumber:'',caseUrl:'',estimateUrl:'',bestUrl:srUrl||'',bestLabel:srUrl?'Service Request':'N/A',source:srUrl?'service_request':'none',scrapedAt:new Date().toISOString(),dealer:'',error:err||null};}

async function pollScrape(win){for(let i=0;i<POLL_MAX;i++){await new Promise(r=>setTimeout(r,POLL_INTERVAL));if(!win||win.isDestroyed())return null;try{const d=await win.webContents.executeJavaScript('(function(){try{return '+ASIST_SCRAPE.trim()+'}catch(e){return{pageReady:false};}})()');if(d&&d.pageReady)return d;}catch(_){}}return null;}

async function openAndScrape(url,partition){return new Promise(resolve=>{const win=new BrowserWindow({show:false,webPreferences:{partition,nodeIntegration:false,contextIsolation:true,webSecurity:true}});let res=false;const done=v=>{if(!res){res=true;resolve(v);}};const t=setTimeout(()=>{logger.warn('[ae] timeout',url.slice(0,60));if(!win.isDestroyed())win.destroy();done(null);},PAGE_LOAD_TIMEOUT+POLL_MAX*POLL_INTERVAL);attachAutoLogin(win,url,{maxRetries:2});win.webContents.once('did-finish-load',async()=>{try{const d=await pollScrape(win);clearTimeout(t);if(!win.isDestroyed())win.destroy();done(d);}catch(e){clearTimeout(t);if(!win.isDestroyed())win.destroy();done(null);}});win.webContents.on('did-fail-load',((_,c)=>{if(c!==-3){clearTimeout(t);if(!win.isDestroyed())win.destroy();done(null);}}));win.loadURL(url);});}

async function enrichVolvoAsist(srUrl){
  if(!srUrl||!SR_RE.test(srUrl))return _empty(srUrl,'not a Volvo ASIST SR URL');
  const part=partitionForUrl(srUrl);
  if(!part)return _empty(srUrl,'no partition found');
  logger.info('[ae] START',srUrl.slice(0,80));
  let srNum='',caseNum='',caseUrl='',estUrl='';
  const sr=await openAndScrape(srUrl,part);
  if(!sr){logger.warn('[ae] SR page failed');return _empty(srUrl,'SR page failed');}
  srNum=(sr.srNumbers&&sr.srNumbers[0])||'';
  logger.info('[ae] SR scraped | srNum:',srNum,'caseLinks:',sr.caseLinks.length,'estLinks:',sr.estimateLinks.length);
  if(sr.estimateLinks&&sr.estimateLinks.length){estUrl=sr.estimateLinks[0].url;caseNum=sr.caseNumbers[0]||sr.estimateLinks[0].id||'';logger.info('[ae] est on SR page');}
  if(!estUrl&&sr.caseLinks&&sr.caseLinks.length){
    caseUrl=sr.caseLinks[0].url;caseNum=sr.caseNumbers[0]||sr.caseLinks[0].id||'';
    logger.info('[ae] following case:',caseUrl.slice(0,80));
    const cs=await openAndScrape(caseUrl,part);
    if(cs){logger.info('[ae] case scraped | estLinks:',cs.estimateLinks.length);if(cs.estimateLinks&&cs.estimateLinks.length){estUrl=cs.estimateLinks[0].url;if(!caseNum)caseNum=cs.caseNumbers[0]||cs.estimateLinks[0].id||'';logger.info('[ae] est on case page');}if(!caseNum&&cs.caseNumbers&&cs.caseNumbers[0])caseNum=cs.caseNumbers[0];}else{logger.warn('[ae] case page failed');}
  }else if(!estUrl){caseNum=sr.caseNumbers[0]||'';}
  let bUrl='',bLabel='',src='none';
  if(estUrl){bUrl=estUrl;src='estimate';bLabel=caseNum?'Fleet Estimate | Case #'+caseNum:'Fleet Estimate';}
  else if(caseUrl){bUrl=caseUrl;src='case';bLabel=caseNum?'ASIST Case #'+caseNum:'ASIST Case';}
  else{bUrl=srUrl;src='service_request';bLabel=srNum?'ASIST SR '+srNum:'Service Request';}
  logger.info('[ae] DONE | src:',src,'case:',caseNum);
  // Combine all scraped page text for timeline building
  const offsiteText = (sr.pageText || '').trim();
  return{ok:true,srUrl,srNumber:srNum,caseNumber:caseNum,caseUrl,estimateUrl:estUrl,bestUrl:bUrl,bestLabel:bLabel,source:src,scrapedAt:new Date().toISOString(),error:null,srStatus:sr.srStatus||'',dealer:sr.dealer||'',complaint:sr.complaint||'',assetVin:sr.assetVin||'',unitNumber:sr.unitNumber||'',offsiteText};
}

const SOURCE_RANK={estimate:3,case:2,service_request:1,none:0};
function isUpgrade(es,ns){return(SOURCE_RANK[ns]||0)>(SOURCE_RANK[es]||0);}

module.exports={enrichVolvoAsist,isUpgrade,SOURCE_RANK};
