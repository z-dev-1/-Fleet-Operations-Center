'use strict';
const {execFile,execSync,spawn}=require('child_process');
const fs=require('fs');

const VPNCLI_PATH='C:\\Program Files (x86)\\Cisco\\Cisco Secure Client\\vpncli.exe';
const VPNUI_PATH='C:\\Program Files (x86)\\Cisco\\Cisco Secure Client\\UI\\csc_ui.exe';
const VPN_HOST='orca.amazon.com';

function checkVpnState(){
  if(!fs.existsSync(VPNCLI_PATH)) return Promise.resolve({connected:true,status:'not-installed',raw:'vpncli not found - skipping VPN gate'});
  return new Promise((resolve)=>{
    execFile(VPNCLI_PATH,['state'],{timeout:6000,windowsHide:true},(err,stdout)=>{
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

function connectVpn(host){
  host=host||VPN_HOST;
  if(!fs.existsSync(VPNCLI_PATH)) return Promise.resolve({success:false,raw:'vpncli not found',code:-1});
  return new Promise((resolve)=>{
    try{execSync('taskkill /F /IM vpncli.exe',{windowsHide:true,stdio:'ignore'});}catch(e){}
    setTimeout(()=>{
      const child=spawn(VPNCLI_PATH,['-s'],{timeout:20000,windowsHide:true});
      let out='';
      child.stdout.on('data',d=>{out+=d.toString();});
      child.stderr.on('data',d=>{out+=d.toString();});
      child.stdin.write('connect '+host+'\n');
      child.stdin.write('y\n');
      child.stdin.write('quit\n');
      child.stdin.end();
      child.on('close',code=>{const raw=out.trim();resolve({success:/state:\s*Connected/i.test(raw),raw,code});});
      child.on('error',err=>resolve({success:false,raw:err.message,code:-1}));
    },800);
  });
}

module.exports={checkVpnState,connectVpn,VPNCLI_PATH,VPNUI_PATH,VPN_HOST};