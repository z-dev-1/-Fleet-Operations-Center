/** slack-inbox.js  S22 -- Slack inbox + context bridge */
(function () {
'use strict';
  var POLL_MS=30000,MAX_MSGS=50,MAX_DM=10;
  var _s={dms:[],all:[],timer:null,running:false};
  window._slackInbox={
    recentForUnit:function(uid,n){
      n=n||3; if(!uid)return[];
      var p=uid.toString().toLowerCase();
      return _s.all.filter(function(m){return m.text&&m.text.toLowerCase().indexOf(p)>=0;}).slice(-n).map(function(m){return{time:m.ts?new Date(parseFloat(m.ts)*1000).toLocaleTimeString():"?",text:m.text};});
    },
    refresh:function(){_poll();},getDMs:function(){return _s.dms.slice(0,MAX_DM);},isRunning:function(){return _s.running;}
  };
  async function _poll(){
    if(!window.slack)return;
    try{
      var dms=await window.slack.readDMs();
      if(Array.isArray(dms)){_s.dms=dms;dms.forEach(function(m){_merge(m);});}
      var chs=await window.slack.getChannels();
      if(Array.isArray(chs)){for(var i=0;i<Math.min(chs.length,5);i++){try{var ms=await window.slack.read({channelId:chs[i].id,limit:10});if(Array.isArray(ms))ms.forEach(function(m){_merge(Object.assign({},m,{channelName:chs[i].name}));});}catch(_){}}}
      if(_s.all.length>MAX_MSGS)_s.all=_s.all.slice(-MAX_MSGS);
      _render();window.dispatchEvent(new CustomEvent("slack:inbox-updated",{detail:{dms:_s.dms,all:_s.all}}));
    }catch(e){console.warn("[slack-inbox] poll:",e.message);}
  }
  function _merge(m){if(!m||!m.ts)return;var ok=_s.all.some(function(x){return x.ts===m.ts&&x.channelId===m.channelId;});if(!ok)_s.all.push(m);}
  function _esc(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
  function _render(){
    var c=document.getElementById("slackInboxList");if(!c)return;
    var ms=_s.dms.slice(0,MAX_DM);
    if(!ms.length){c.innerHTML="<p class='inbox-empty'>No recent messages</p>";return;}
    c.innerHTML=ms.map(function(m){
      var t=m.ts?new Date(parseFloat(m.ts)*1000).toLocaleTimeString():"";
      var u=m.userId||"?";
      var ch=m.channelName?"#"+m.channelName:"DM";
      var p=(m.text||"").slice(0,120);
      return "<div class=\"inbox-msg\">"+u+" "+ch+" "+t+" "+_esc(p)+"</div>";
    }).join("");
  }
  function _start(){
    if(_s.running)return;_s.running=true;
    _poll();_s.timer=setInterval(_poll,POLL_MS);
    console.log("[slack-inbox] started");
  }
  function _stop(){clearInterval(_s.timer);_s.running=false;}
  if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",_start);}else{_start();}
  window._slackInbox.start=_start;window._slackInbox.stop=_stop;
}());
