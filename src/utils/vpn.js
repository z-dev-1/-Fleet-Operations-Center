const {execFile,execSync,spawn}=require('child_process');
const fs=require('fs');

const VPNCLI_PATH='C:\\Program Files (x86)\\Cisco\\Cisco Secure Client\\vpncli.exe';
const VPNUI_PATH='C:\\Program Files (x86)\\Cisco\\Cisco Secure Client\\UI\\csc_ui.exe';
const VPN_HOST='orca.amazon.com';

// Fast state check. Short timeout so it can NEVER stall app startup — if
// vpncli hangs we just treat it as unknown and move on (the app opens anyway).
function checkVpnState(){
  if(!fs.existsSync(VPNCLI_PATH)) return Promise.resolve({connected:true,status:'not-installed',raw:'vpncli not found - skipping VPN gate'});
  return new Promise((resolve)=>{
    execFile(VPNCLI_PATH,['state'],{timeout:4000,windowsHide:true},(err,stdout)=>{
      if(err){resolve({connected:false,status:'error',raw:err.message});return;}
      const text=(stdout||'').trim();
      const matches=text.match(/state:\s*(\S+)/gi)||[];
      const last=matches.length?matches[matches.length-1]:'';
      const connected=/connected/i.test(last)&&!/disconnected/i.test(last);
      const status=connected?'connected':/disconnected/i.test(last)?'disconnected':'unknown';
      resolve({connected,status,raw:text});
    });
  });
}

// Silent connect via vpncli. NOTE: no longer kills a running vpncli — killing
// the client mid-use (taskkill /F) was disruptive and could tear down an
// active tunnel. We just spawn a connect attempt; if one is already running
// this is a harmless no-op from the user's perspective.
function connectVpn(host){
  host=host||VPN_HOST;
  if(!fs.existsSync(VPNCLI_PATH)) return Promise.resolve({success:false,raw:'vpncli not found',code:-1});
  return new Promise((resolve)=>{
    const child=spawn(VPNCLI_PATH,['-s'],{timeout:20000,windowsHide:true});
    let out='';
    child.stdout.on('data',d=>{out+=d.toString();});
    child.stderr.on('data',d=>{out+=d.toString();});
    try{
      child.stdin.write('connect '+host+'\n');
      child.stdin.write('y\n');
      child.stdin.write('quit\n');
      child.stdin.end();
    }catch(e){/* pipe may already be closed */}
    child.on('close',code=>{const raw=out.trim();resolve({success:/state:\s*Connected/i.test(raw),raw,code});});
    child.on('error',err=>resolve({success:false,raw:err.message,code:-1}));
  });
}

// Launch the Cisco Secure Client UI so the user can click Connect / complete
// the Duo/2FA tap. Fire-and-forget; safe if it's already running.
function openVpnUi(){
  if(!fs.existsSync(VPNUI_PATH)) return {ok:false,raw:'csc_ui not found'};
  try{
    const ui=spawn(VPNUI_PATH,[],{detached:true,stdio:'ignore',windowsHide:false});
    ui.unref();
    return {ok:true};
  }catch(e){
    return {ok:false,raw:e.message};
  }
}

// ── ensureVpn() — background, non-blocking auto-connect ──────────────────────
// The app NEVER waits on this. It checks state; if VPN is already up (or
// vpncli isn't installed) it does nothing. If VPN is down it kicks off a
// silent vpncli connect, and if the tunnel still isn't up a few seconds later
// it opens the Cisco Secure Client UI so the user can complete the connect /
// 2FA tap. A module-level lock prevents overlapping attempts (e.g. the startup
// call and the 5-min heartbeat both firing).
let _ensuring=false;
async function ensureVpn(log){
  const _log=(typeof log==='function')?log:function(){};
  if(_ensuring){ _log('[vpn] ensureVpn: attempt already in progress, skipping'); return {connected:false,busy:true}; }
  _ensuring=true;
  try{
    const st=await checkVpnState();
    if(st.connected){ _log('[vpn] ensureVpn: already connected ('+st.status+')'); return {connected:true,status:st.status}; }
    if(st.status==='not-installed'){ _log('[vpn] ensureVpn: vpncli not installed — skipping'); return {connected:true,status:'not-installed'}; }

    _log('[vpn] ensureVpn: VPN is '+st.status+' — attempting silent connect...');
    const attempt=await connectVpn();
    _log('[vpn] ensureVpn: silent connect '+(attempt.success?'succeeded':'did not confirm')+' ('+String(attempt.raw||'').slice(0,80)+')');

    // Re-check; if the silent connect brought it up, we're done.
    let recheck=await checkVpnState();
    if(recheck.connected){ _log('[vpn] ensureVpn: connected after silent attempt'); return {connected:true,status:recheck.status}; }

    // Still down — Cisco usually needs a Duo/2FA tap the silent path can't do.
    // Open the Cisco UI so the user can finish. Then poll briefly to detect it.
    _log('[vpn] ensureVpn: still '+recheck.status+' — opening Cisco Secure Client UI for manual connect/2FA');
    openVpnUi();

    // Light background poll (up to ~2 min) so we log when the user completes it.
    for(let i=0;i<24;i++){
      await new Promise(r=>setTimeout(r,5000));
      recheck=await checkVpnState();
      if(recheck.connected){ _log('[vpn] ensureVpn: VPN connected (user completed)'); return {connected:true,status:recheck.status}; }
    }
    _log('[vpn] ensureVpn: VPN still not connected after 2min of polling — app remains usable; will retry on next heartbeat');
    return {connected:false,status:recheck.status};
  }catch(e){
    _log('[vpn] ensureVpn error: '+e.message);
    return {connected:false,error:e.message};
  }finally{
    _ensuring=false;
  }
}

module.exports={checkVpnState,connectVpn,openVpnUi,ensureVpn,VPNCLI_PATH,VPNUI_PATH,VPN_HOST};
