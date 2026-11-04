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
      const last=(matches.length?matches[matches.length-1]:'').toLowerCase();
      // Classify PRECISELY. The old code lumped everything that wasn't
      // "connected" into disconnected/unknown, so a TRANSITIONAL state
      // (Connecting / Reconnecting / SSO/auth pending) looked "disconnected"
      // and triggered a connect mid-handshake — which reset the tunnel. Now we
      // distinguish: only a clean "Disconnected" is safe to auto-connect.
      let status;
      if(/\bconnected\b/.test(last)&&!/disconnected/.test(last)){
        status='connected';
      } else if(/disconnected/.test(last)){
        status='disconnected';
      } else if(/connecting|reconnect|authenticat|sso|pending|establish|connect in progress/.test(last)){
        status='connecting';           // transitional — do NOT touch
      } else {
        status='unknown';              // ambiguous — do NOT auto-connect
      }
      const connected=status==='connected';
      // Only a confirmed clean Disconnected is safe to issue a connect against.
      const safeToConnect=status==='disconnected';
      resolve({connected,status,safeToConnect,raw:text});
    });
  });
}

// Silent connect via vpncli — but ONLY when the tunnel is confirmed cleanly
// Disconnected. The bug that disconnected the user was issuing `connect` while
// already connected or mid-handshake (Cisco then RESETS the session to start a
// new one). Guards here make that impossible:
//   1. Re-check state immediately before connecting; bail unless safeToConnect
//      (status === 'disconnected'). If connected -> no-op success. If
//      connecting/unknown -> skip (let the in-flight handshake finish).
//   2. Do NOT blindly send `y`. A bare `connect` prompts only for connect-flow
//      input; we no longer answer a "disconnect existing session?" prompt.
function connectVpn(host){
  host=host||VPN_HOST;
  if(!fs.existsSync(VPNCLI_PATH)) return Promise.resolve({success:false,raw:'vpncli not found',code:-1});
  return checkVpnState().then((st)=>{
    if(st.connected){
      return {success:true,skipped:true,raw:'already connected — no connect issued ('+st.status+')',code:0};
    }
    if(!st.safeToConnect){
      // connecting / reconnecting / unknown — do NOT interfere with a tunnel
      // that is already establishing (this was the disconnect-on-connect bug).
      return {success:false,skipped:true,raw:'state is "'+st.status+'" (not a clean Disconnected) — skipping connect to avoid resetting an in-progress tunnel',code:0};
    }
    // Confirmed cleanly Disconnected — safe to connect.
    return new Promise((resolve)=>{
      const child=spawn(VPNCLI_PATH,['-s'],{timeout:20000,windowsHide:true});
      let out='';
      child.stdout.on('data',d=>{out+=d.toString();});
      child.stderr.on('data',d=>{out+=d.toString();});
      try{
        child.stdin.write('connect '+host+'\n');
        child.stdin.write('quit\n');
        child.stdin.end();
      }catch(e){/* pipe may already be closed */}
      child.on('close',code=>{const raw=out.trim();resolve({success:/state:\s*Connected/i.test(raw),raw,code});});
      child.on('error',err=>resolve({success:false,raw:err.message,code:-1}));
    });
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

    // If the tunnel is already ESTABLISHING (connecting/reconnecting/auth),
    // do NOT issue a connect — that reset the handshake and disconnected the
    // user. Just wait and let it finish; poll below detects completion.
    if(st.status==='connecting'){
      _log('[vpn] ensureVpn: VPN is handshaking ('+st.status+') — NOT connecting, waiting for it to finish');
    } else if(st.safeToConnect){
      // Confirmed cleanly Disconnected — this is the case where we SHOULD
      // click connect for the user. Issue a guarded silent connect.
      _log('[vpn] ensureVpn: VPN is disconnected — issuing silent connect...');
      const attempt=await connectVpn();
      _log('[vpn] ensureVpn: silent connect '+(attempt.success?'succeeded':(attempt.skipped?'skipped ('+attempt.raw+')':'did not confirm'))+' ('+String(attempt.raw||'').slice(0,80)+')');
      const after=await checkVpnState();
      if(after.connected){ _log('[vpn] ensureVpn: connected after silent attempt'); return {connected:true,status:after.status}; }
      // Still not up — Cisco usually needs a Duo/2FA tap the silent path can't
      // do. Open the Cisco UI so the user completes it.
      _log('[vpn] ensureVpn: still '+after.status+' after silent connect — opening Cisco Secure Client UI for the 2FA tap');
      openVpnUi();
    } else {
      // unknown/error state — don't risk a connect against an ambiguous state;
      // surface the UI so the user can act.
      _log('[vpn] ensureVpn: VPN state '+st.status+' (ambiguous) — opening Cisco Secure Client UI, not auto-connecting');
      openVpnUi();
    }
    let recheck=st;

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
