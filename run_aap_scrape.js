'use strict';
const {app}=require('electron');
const path=require('path');
const fs=require('fs');
const SRC=path.join(__dirname,'src');
const domiciles=process.argv.slice(2).filter(a=>!a.startsWith('--'));
const OUT='/tmp/aap_scrape_result.json';
const LOG='/tmp/aap_scrape.log';
const log=function(){var m=new Date().toISOString()+' '+Array.from(arguments).join(' ')+'\n';process.stdout.write(m);try{fs.appendFileSync(LOG,m);}catch(e){}};
app.requestSingleInstanceLock();
app.whenReady().then(async function(){
  log('START domiciles='+JSON.stringify(domiciles));
  try{
    var auth=require(path.join(SRC,'scrapers/auth'));
    var mw=auth.checkMwinit();
    if(!mw.ok)throw new Error(mw.reason);
    log('cookie age='+mw.ageHours+'h');
    var inj=await auth.injectCookies();
    log('injected='+inj);
    var aap=require(path.join(SRC,'scrapers/aap'));
    log('calling scrapeAAP...');
    var result=await aap.scrapeAAP(domiciles);
    var out={ts:new Date().toISOString(),domiciles:domiciles,total:result?result.length:0,data:result};
    fs.writeFileSync(OUT,JSON.stringify(out,null,2));
    log('SUCCESS total='+out.total);
    app.exit(0);
  }catch(err){
    log('ERROR: '+err.message);
    fs.writeFileSync(OUT,JSON.stringify({error:err.message,ts:new Date().toISOString()}));
    app.exit(1);
  }
});
app.on('window-all-closed',function(){});
