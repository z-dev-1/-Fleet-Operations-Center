import"./fleet-Cq-x1MBL.js";const $t=new EventTarget,r={on(e,t){const s=a=>t(a.detail);return $t.addEventListener(e,s),()=>$t.removeEventListener(e,s)},once(e,t){const s=a=>{$t.removeEventListener(e,s),t(a.detail)};$t.addEventListener(e,s)},emit(e,t){$t.dispatchEvent(new CustomEvent(e,{detail:t}))}},At={fleet:{rows:[],count:0,syncedAt:null,stale:!1},ui:{view:"fleet",selectedUnit:null,filter:{},search:"",loading:!1,sidebarOpen:!1},sync:{inProgress:!1,lastStatus:"",lastError:null,orcaProgress:{},spProgress:{},dnProgress:{}},auth:{midwayOk:null,midwayReason:""},settings:null,vendor:{active:{},lastComplete:null,lastError:null,history:{}},monitor:{results:[],summary:null},alerts:{alerts:[],counts:{critical:0,warning:0,info:0}},recommendations:{recommendations:[],summary:{total:0,byAction:{},byUrgency:{}}},tracker:{tracked:[],stuck:[],summary:{total:0,stuck:0,stageCounts:{},avgProgress:0}},health:null};function ks(e){return JSON.parse(JSON.stringify(e))}const E={get(){return ks(At)},update(e,t){if(!Object.prototype.hasOwnProperty.call(At,e)){console.warn("[state] unknown slice:",e);return}Object.assign(At[e],t),r.emit("state:"+e,ks(At[e]))},slice(e){return ks(At[e]||{})}},Ne=new Map;function hs(){E.update("vendor",{active:Object.fromEntries(Ne)})}function Kn(e){const t=e.workflowId;if(t){const s=Ne.get(t)||{};Ne.set(t,{...s,...e}),hs()}r.emit("vendor:progress",e)}function Yn(e){const t=e.workflowId;if(t){const s=Ne.get(t)||{};Ne.set(t,{...s,...e,step:"review-ready"}),hs()}r.emit("vendor:review-ready",e)}const Sa=10;function nn(e,t){if(!e)return;const a=E.slice("vendor").history||{},n=(a[e]||[]).slice();n.unshift(t),n.length>Sa&&(n.length=Sa),a[e]=n,E.update("vendor",{history:a}),window.vendor&&window.vendor.saveHistory&&window.vendor.saveHistory(a).catch(()=>{})}function Qn(e){const t=e.workflowId;t&&(Ne.delete(t),hs());const s={...e,ts:Date.now()};E.update("vendor",{lastComplete:s}),nn(e.unit,{workflowId:e.workflowId,vendor:e.vendor,outcome:"complete",caseNumber:e.caseNumber||"",caseUrl:e.caseUrl||"",dealerName:e.dealerName||"",ts:s.ts}),r.emit("vendor:complete",e)}function Zn(e){const t=e.workflowId;t&&(Ne.delete(t),hs());const s={...e,ts:Date.now()};E.update("vendor",{lastError:s}),nn(e.unit,{workflowId:e.workflowId,vendor:e.vendor,outcome:"error",error:e.error||"",ts:s.ts}),r.emit("vendor:error",e)}function ei(){if(!window.vendor){console.warn("[vendor-bridge] window.vendor not found — preload patch missing");return}window.vendor.onProgress(Kn),window.vendor.onReviewReady(Yn),window.vendor.onComplete(Qn),window.vendor.onError(Zn),window.vendor.loadHistory&&window.vendor.loadHistory().then(e=>{e&&e.history&&typeof e.history=="object"&&(E.update("vendor",{history:e.history}),console.log("[vendor-bridge] history rehydrated:",Object.keys(e.history).length,"units"))}).catch(e=>console.warn("[vendor-bridge] history load failed:",e.message))}const ne={investigate:e=>window.vendor.investigate(e),startPaccar:e=>window.vendor.startPaccar(e),startVolvo:e=>window.vendor.startVolvo(e),approve:(e,t)=>window.vendor.approve(e,t),cancel:e=>window.vendor.cancel(e),getStatus:()=>window.vendor.getStatus(),getWorkflow:e=>Ne.get(e)||null,listActive:()=>Array.from(Ne.values()),enrichAsist:e=>window.vendor.enrichAsist(e),openPortalUrl:e=>window.vendor.openPortalUrl(e).catch(()=>{})};let Bt=null;async function ln(e){if(!Bt)try{Bt=await window.vendor.getPortalUrls()}catch{Bt={}}return Bt&&e&&Bt[e]||""}function on(){window.fleet.onData(t=>{E.update("fleet",{rows:t.rows||[],count:t.count||0,syncedAt:t.syncedAt||null,stale:!!t.stale}),E.update("sync",{inProgress:!1}),r.emit("fleet:data",t)}),window.fleet.onStatus(t=>{E.update("sync",{lastStatus:t,lastError:null}),r.emit("fleet:status",t)}),window.fleet.onError(t=>{E.update("sync",{lastError:t}),r.emit("fleet:error",t)}),window.fleet.onAuthFailure&&window.fleet.onAuthFailure(t=>{r.emit("fleet:auth-failure",t)}),window.ai.onProgress(t=>{const s=E.slice("sync").orcaProgress;s[t.unitId]={step:t.step,message:t.message},E.update("sync",{orcaProgress:s}),r.emit("orcha:progress",t)}),window.ai.onDailyNotesProgress(t=>{const s=E.slice("sync").dnProgress;s[t.unitId]={step:t.step,message:t.message},E.update("sync",{dnProgress:s}),r.emit("daily-notes:progress",t)}),window.sp.onProgress(t=>{const s=E.slice("sync").spProgress;s[t.unitId]={step:t.step,message:t.message},E.update("sync",{spProgress:s}),r.emit("sp:progress",t)}),window.auth.onMwinitStatus(t=>{E.update("auth",{midwayOk:t.ok,midwayReason:t.reason||""}),r.emit("auth:mwinit-status",t)}),window.app.onNavigateUnit(t=>{r.emit("navigate:unit",t)}),window.fleet.onAutoEmail&&window.fleet.onAutoEmail(t=>{r.emit("fleet:auto-email",t)}),window.fleet.onMonitor&&window.fleet.onMonitor(t=>{E.update("monitor",t),r.emit("orcha:monitor",t)}),window.fleet.onAlerts&&window.fleet.onAlerts(t=>{E.update("alerts",t),r.emit("orcha:alerts",t)}),window.fleet.onRecommendations&&window.fleet.onRecommendations(t=>{E.update("recommendations",t),r.emit("orcha:recommendations",t)}),window.fleet.onTracker&&window.fleet.onTracker(t=>{E.update("tracker",t),r.emit("orcha:tracker",t)}),window.fleet.onDrafts&&window.fleet.onDrafts(t=>{r.emit("orcha:drafts",t)}),window.fleet.onHealth&&window.fleet.onHealth(t=>{E.update("health",t),r.emit("orcha:health",t)}),ei(),window.addEventListener("unhandledrejection",t=>{const s=t.reason&&t.reason.message?t.reason.message:String(t.reason||"Unknown error");s.includes("ResizeObserver")||s.includes("aborted")||s.includes("cancel")||(console.error("[bridge] Unhandled rejection:",s),r.emit("ui:toast",{type:"error",message:s.slice(0,120),duration:4e3}))});function e(){const s=E.slice("fleet").rows||[];if(!s.length)return;const a={};s.forEach(i=>{const l=i.operator||i.operatorCode||"",o=i.domicile||i.domicileCode||"";l&&(a[l]||(a[l]=new Set),o&&a[l].add(o))});const n=Object.keys(a).sort().map(i=>({name:i,domiciles:[...a[i]].sort().map(l=>({code:l}))}));r.emit("state:operators",n)}r.on("sp:sync-request",e),r.on("fleet:data",e),window.fleet.signalReady(),window.__fleet_bus=r}const dn={requestSync:()=>window.fleet.requestSync(),forceSync:()=>window.fleet.forceSync(),getVersion:()=>window.fleet.getVersion()},ee={getAll:()=>window.settings.getAll(),save:(e,t)=>window.settings.save(e,t),getDomiciles:()=>window.settings.getDomiciles(),saveDomiciles:e=>window.settings.saveDomiciles(e),resetDomiciles:()=>window.settings.resetDomiciles(),getOrchaConfig:()=>window.settings.getOrchaConfig(),getScheduleSlots:()=>window.settings.getScheduleSlots(),saveScheduleSlots:e=>window.settings.saveScheduleSlots(e)},ti={getUnit:e=>window.notes.getUnit(e),getAll:()=>window.notes.getAll(),saveUnit:e=>window.notes.saveUnit(e),deleteUnit:e=>window.notes.deleteUnit(e)},te={suggest:e=>window.ai.suggest(e),ask:e=>window.ai.ask(e),chat:e=>window.ai.chat(e),deepProcess:e=>window.ai.deepProcess(e),recordCorrection:e=>window.ai.recordCorrection(e),suggestVendor:e=>window.ai.suggestVendor(e),getCorrections:(e,t)=>window.ai.getCorrections(e,t),test:()=>window.ai.test(),runDailyNotes:e=>window.ai.runDailyNotes(e),getDailyNotesLog:()=>window.ai.getDailyNotesLog(),dismissAlert:e=>window.ai.dismissAlert(e),execute:e=>window.ai.execute(e),getExecutionLog:()=>window.ai.getExecutionLog(),exportExcel:e=>window.ai.exportExcel(e),inferRCA:(e,t)=>window.ai.inferRCA(e,t)},Xe={setLifecycle:(e,t,s,a)=>window.aap.setLifecycle(e,t,s,a),autofill:(e,t)=>window.aap.autofill(e,t),runAdaptive:e=>window.aap.runAdaptive(e),adaptiveExtract:e=>window.aap.adaptiveExtract(e),adaptiveScanBatch:e=>window.aap.adaptiveScanBatch(e),createWR:(e,t)=>window.aap.createWR(e,t),onWRProgress:e=>window.aap.onWRProgress(e),openUrl:e=>window.aap.openUrl(e)},ra={send:e=>window.slack.send(e),checkAuth:()=>window.slack.checkAuth(),login:()=>window.slack.login()},ie={push:e=>window.sp.push(e),pushDomicile:e=>window.sp.pushDomicile(e),onProgress:e=>window.sp.onProgress(e),getConfig:()=>window.sp.getConfig(),saveConfig:e=>window.sp.saveConfig(e),getLists:e=>window.sp.getLists(e)},pa={runMwinit:()=>window.auth.runMwinit(),checkMidway:()=>window.auth.checkMidway()},we={send:e=>window.email.send(e),getConfig:()=>window.email.getConfig(),saveConfig:e=>window.email.saveConfig(e),preview:e=>window.email.preview(e),compose:e=>window.email.compose(e),saveOpEmails:e=>window.email.saveOpEmails(e),loadOpEmails:()=>window.email.loadOpEmails(),getTestMode:()=>window.email.getTestMode(),setTestMode:e=>window.email.setTestMode(e)},si={scrape:()=>window.geofence.scrape(),getCache:()=>window.geofence.getCache()},Me={set:(e,t)=>window.credentials.set(e,t),has:e=>window.credentials.has(e),delete:e=>window.credentials.delete(e),list:()=>window.credentials.list()},Hs={openUptakeScreenshot:e=>window.files.openUptakeScreenshot(e),getLatestScreenshot:()=>window.files.getLatestScreenshot(),readAsDataUrl:e=>window.files.readAsDataUrl(e),openExternal:e=>window.files.openExternal(e),openRelayUrl:e=>window.files.openRelayUrl(e)},ai={windowAction:e=>window.app.windowAction(e),notify:(e,t)=>window.app.notify(e,t),platform:window.app.platform},js={checkAuth:()=>window.asana.checkAuth(),getConfig:()=>window.asana.getConfig(),saveConfig:e=>window.asana.saveConfig(e),getMe:()=>window.asana.getMe(),getWorkspaces:()=>window.asana.getWorkspaces(),getProjects:(e,t)=>window.asana.getProjects(e,t),getSections:e=>window.asana.getSections(e),getTasks:(e,t)=>window.asana.getTasks(e,t),getTask:e=>window.asana.getTask(e),getTaskStories:e=>window.asana.getTaskStories(e),searchTasks:(e,t)=>window.asana.searchTasks(e,t),createTask:(e,t)=>window.asana.createTask(e,t),updateTask:(e,t)=>window.asana.updateTask(e,t),addComment:(e,t)=>window.asana.addComment(e,t),moveTask:(e,t)=>window.asana.moveTask(e,t),linkUnit:(e,t)=>window.asana.linkUnit(e,t)},ni={getQR:()=>window.partner.getQR(),getQueue:()=>window.partner.getQueue(),updateJob:(e,t)=>window.partner.updateJob(e,t),onNewRequest:e=>window.partner.onNewRequest(e)},ii={getCache:()=>window.relay&&typeof window.relay.getCache=="function"?window.relay.getCache():Promise.resolve({}),getUnitCache:e=>window.relay&&typeof window.relay.getUnitCache=="function"?window.relay.getUnitCache(e):window.relay&&typeof window.relay.getCache=="function"?window.relay.getCache().then(t=>t[e]||{workOrders:[]}):Promise.resolve({workOrders:[]})},ua=Object.freeze(Object.defineProperty({__proto__:null,aap:Xe,ai:te,app:ai,asana:js,auth:pa,credentials:Me,email:we,files:Hs,fleet:dn,geofence:si,getPortalUrl:ln,init:on,notes:ti,partner:ni,relay:ii,settings:ee,slack:ra,sp:ie,vendor:ne},Symbol.toStringTag,{value:"Module"}));let dt=null;function li(){return dt||(dt=document.createElement("div"),dt.id="toast-container",dt.style.cssText="position:fixed;bottom:12px;left:12px;z-index:2000;display:flex;flex-direction:column;gap:5px;align-items:flex-start;pointer-events:none;max-width:260px;",document.body.appendChild(dt)),dt}function cn(e="info",t="",s=2500){const a=document.createElement("div");a.style.cssText="pointer-events:all;display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:6px;font-size:10px;font-family:inherit;color:#ccd6e0;background:rgba(22,34,51,0.92);border:1px solid rgba(88,166,255,0.15);box-shadow:0 2px 8px rgba(0,0,0,0.3);backdrop-filter:blur(8px);opacity:0;transform:translateX(-12px);transition:opacity 0.2s ease,transform 0.2s ease;max-width:240px;word-break:break-word;line-height:1.3;";const n={success:"#3fb950",warn:"#d29922",error:"#f85149",info:"#58a6ff"};a.style.borderLeft="2px solid "+(n[e]||n.info),a.textContent=t;const i=document.createElement("button");i.style.cssText="background:none;border:none;color:#6b7b8d;cursor:pointer;font-size:10px;padding:0 2px;margin-left:4px;line-height:1;flex-shrink:0;",i.textContent="×",i.addEventListener("click",()=>La(a)),a.appendChild(i),li().appendChild(a),requestAnimationFrame(()=>{a.style.opacity="1",a.style.transform="translateX(0)"}),s>0&&setTimeout(()=>La(a),s)}function La(e){!e||!e.parentNode||(e.style.opacity="0",e.style.transform="translateX(-12px)",setTimeout(()=>{e.parentNode&&e.remove()},300))}function oi(){r.on("ui:toast",({type:e,message:t,duration:s})=>{cn(e,t,s)})}const h={show:cn};let Tt=!1;const di={dashboard:"fleet",analytics:"analytics",vendors:"vendors",scheduler:"schedulers"};function ci(e){const t=document.createElement("div");t.id="topbar-wrap",t.innerHTML=`
    <!-- ══ TOPBAR ══ -->
    <nav id="topbar">

      <!-- Brand -->
      <div class="tb-brand">
        <div class="tb-brand-icon">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="1" width="6" height="6" rx="2" fill="#58a6ff"/>
            <rect x="9" y="1" width="6" height="6" rx="2" fill="#79c0ff" opacity=".7"/>
            <rect x="1" y="9" width="6" height="6" rx="2" fill="#79c0ff" opacity=".7"/>
            <rect x="9" y="9" width="6" height="3" rx="1.5" fill="#d2a8ff"/>
            <circle cx="12" cy="14" r="2" fill="#7ee787"/>
          </svg>
        </div>
        <span class="tb-brand-text">Fleet Ops</span>
      </div>

      <!-- Nav tabs (reduced to 4 core views) -->
      <div class="tb-nav">
        <button class="tb-tab active" data-view="dashboard">
          <span class="tb-tab-icon">⊞</span> Dashboard
        </button>
        <button class="tb-tab" data-view="analytics">
          <span class="tb-tab-icon">📊</span> Analytics
        </button>
        <button class="tb-tab" data-view="vendors">
          <span class="tb-tab-icon">🏢</span> Vendors
        </button>
        <button class="tb-tab" data-view="scheduler">
          <span class="tb-tab-icon">⏱</span> Scheduler
        </button>
      </div>

      <!-- KPI pills -->
      <div class="tb-kpi-strip">
        <div class="tb-kpi tb-kpi--unavail" id="kpi-unavail" title="Unavailable units">
          <span class="tb-kpi-num" id="kpi-unavail-num">—</span>
          <span class="tb-kpi-lbl">Unavail</span>
        </div>
        <div class="tb-kpi tb-kpi--avail" id="kpi-avail" title="Available units">
          <span class="tb-kpi-num" id="kpi-avail-num">—</span>
          <span class="tb-kpi-lbl">Avail</span>
        </div>
        <div class="tb-kpi tb-kpi--offsite" id="kpi-offsite" title="Offsite units">
          <span class="tb-kpi-num" id="kpi-offsite-num">—</span>
          <span class="tb-kpi-lbl">Offsite</span>
        </div>
        <div class="tb-kpi tb-kpi--ai" id="kpi-ai" title="AI Connection">
          <span class="tb-kpi-dot" id="kpi-ai-dot"></span>
          <span class="tb-kpi-lbl" id="kpi-ai-label">AI</span>
        </div>
      </div>

      <!-- Right side -->
      <div class="tb-right">
        <div class="tb-live"><div class="tb-live-dot"></div>Live</div>
        <span class="tb-clock" id="tb-clock">--:--:--</span>
        <button class="tb-sync-btn" id="tb-sync" title="Force sync">
          <span class="tb-sync-icon">↻</span>
        </button>
        <div class="tb-icon-btn tb-intel-btn" id="tb-intel" title="Intelligence Panel">🧠</div>
        <div class="tb-icon-btn" id="tb-notif" title="Notifications">
          🔔<span class="tb-notif-badge" id="tb-notif-badge" style="display:none">0</span>
        </div>
        <div class="tb-icon-btn" id="tb-settings" title="Settings">⚙</div>
        <button class="tb-theme-toggle" id="tb-theme-toggle" title="Toggle theme">
          <span id="tb-theme-icon">🌙</span>
        </button>
        <div class="tb-avatar" id="tb-avatar" title="Account">ZS</div>
      </div>
    </nav>

    <!-- ══ FILTER BAR (Dashboard only) ══ -->
    <div id="tb-filterbar">
      <div class="tb-search-wrap">
        <span class="tb-search-icon">🔍</span>
        <input
          id="tb-search"
          class="tb-search"
          type="search"
          placeholder="Search unit ID, vendor, domicile..."
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="tb-filters">
        <select id="tb-lifecycle" class="tb-select">
          <option value="">All States</option>
          <option value="available">Available</option>
          <option value="unavailable">Unavailable</option>
          <option value="decommissioned">Decommissioned</option>
          <option value="in_maintenance">In Maintenance</option>
        </select>
        <select id="tb-domicile" class="tb-select">
          <option value="">All Domiciles</option>
        </select>
        <select id="tb-vendor" class="tb-select">
          <option value="">All Vendors</option>
        </select>
      </div>
      <div class="tb-sep"></div>
      <div class="tb-pills" id="tb-pills">
        <button class="tb-pill active" data-filter="all">All</button>
        <button class="tb-pill" data-filter="unavailable">Unavailable</button>
        <button class="tb-pill" data-filter="offsite">Offsite</button>
        <button class="tb-pill" data-filter="high-risk">High Risk</button>
        <button class="tb-pill" data-filter="stuck">Stuck 14d+</button>
      </div>
    </div>
  `,e.appendChild(t),t.querySelectorAll(".tb-tab").forEach(c=>{c.addEventListener("click",()=>{t.querySelectorAll(".tb-tab").forEach(m=>m.classList.remove("active")),c.classList.add("active");const v=di[c.dataset.view]||"fleet";r.emit("ui:view-change",{from:"fleet",to:v})})}),document.getElementById("tb-intel").addEventListener("click",()=>{r.emit("ui:toggle-intelligence")}),document.getElementById("tb-settings").addEventListener("click",()=>{r.emit("ui:view-change",{from:"fleet",to:"settings"})});const s=document.getElementById("tb-sync");s.addEventListener("click",async()=>{s.classList.add("tb-sync-btn--spinning"),s.disabled=!0,r.emit("ui:toast",{type:"info",message:"Sync triggered...",duration:2e3});try{await dn.forceSync()}catch(c){r.emit("ui:toast",{type:"error",message:"Sync failed: "+(c.message||c),duration:4e3})}s.classList.remove("tb-sync-btn--spinning"),s.disabled=!1});function a(){const c=document.getElementById("tb-clock");c&&(c.textContent=new Date().toLocaleTimeString("en-US",{hour12:!1}))}a(),setInterval(a,1e3);const n=["dark","light","midnight"],i={dark:"🌙",light:"☀️",midnight:"✦"},l={dark:{"--bg":"#0d1117","--panel":"#161b22","--card":"#1c2128","--el":"#21262d","--txt":"#f0f6fc","--txt2":"#8b949e","--bdr":"#30363d"},light:{"--bg":"#f6f8fa","--panel":"#ffffff","--card":"#f0f2f5","--el":"#e7eaf0","--txt":"#1c2128","--txt2":"#57606a","--bdr":"#d0d7de"},midnight:{"--bg":"#050709","--panel":"#0d1117","--card":"#111418","--el":"#161b22","--txt":"#e6edf3","--txt2":"#7d8590","--bdr":"#21262d"}};let o=n.indexOf(localStorage.getItem("fleet_theme")||"dark");o<0&&(o=0);function d(c){const v=l[c]||l.dark;Object.entries(v).forEach(([g,x])=>document.documentElement.style.setProperty(g,x)),document.documentElement.setAttribute("data-theme",c),localStorage.setItem("fleet_theme",c);const m=document.getElementById("tb-theme-icon");m&&(m.textContent=i[c]||"🌙")}d(n[o]),document.getElementById("tb-theme-toggle").addEventListener("click",()=>{o=(o+1)%n.length,d(n[o]),r.emit("ui:toast",{type:"info",message:n[o].charAt(0).toUpperCase()+n[o].slice(1)+" theme",duration:1200})});let p=null;document.getElementById("tb-search").addEventListener("input",c=>{clearTimeout(p),p=setTimeout(()=>{r.emit("ui:search",{query:c.target.value.trim()})},200)}),document.getElementById("tb-lifecycle").addEventListener("change",c=>{r.emit("ui:filter-change",{field:"lifecycleState",value:c.target.value})}),document.getElementById("tb-domicile").addEventListener("change",c=>{Tt||r.emit("ui:filter-change",{field:"domicileSite",value:c.target.value})}),document.getElementById("tb-vendor").addEventListener("change",c=>{r.emit("ui:filter-change",{field:"vendor",value:c.target.value})}),r.on("state:fleet",c=>{const v=c.rows||[];let m=0,g=0,x=0;const f=new Set,w=new Set;v.forEach(P=>{const M=(P.lifecycleState||"").toLowerCase();M==="unavailable"&&m++,M==="available"&&g++,(P.isOffsite||/offsite/i.test(P.lifecycleReason||""))&&x++,P.vendor&&f.add(P.vendor),P.domicileSite&&w.add(P.domicileSite)});const b=(P,M)=>{const _=document.getElementById(P);_&&(_.textContent=M)};b("kpi-unavail-num",m),b("kpi-avail-num",g),b("kpi-offsite-num",x);const I=document.getElementById("tb-domicile");if(I){const P=I.value;Tt=!0,I.innerHTML='<option value="">All Domiciles</option>',[...w].sort().forEach(M=>{const _=document.createElement("option");_.value=M,_.textContent=M,M===P&&(_.selected=!0),I.appendChild(_)}),Tt=!1}const H=document.getElementById("tb-vendor");if(H){const P=H.value;H.innerHTML='<option value="">All Vendors</option>',[...f].sort().forEach(M=>{const _=document.createElement("option");_.value=M,_.textContent=M,M===P&&(_.selected=!0),H.appendChild(_)})}}),r.on("orcha:status",c=>{const v=document.getElementById("kpi-ai-dot"),m=document.getElementById("kpi-ai-label");v&&(c.connected?(v.className="tb-kpi-dot tb-kpi-dot--green",m&&(m.textContent="AI ✓")):(v.className="tb-kpi-dot tb-kpi-dot--red",m&&(m.textContent="AI ✗")))});const u=document.getElementById("tb-filterbar");r.on("ui:view-change",({to:c})=>{u&&(u.style.display=c==="fleet"||c==="dashboard"?"flex":"none")}),t.querySelectorAll(".tb-pill").forEach(c=>{c.addEventListener("click",()=>{t.querySelectorAll(".tb-pill").forEach(x=>x.classList.remove("active")),c.classList.add("active");const v=c.dataset.filter,m=document.getElementById("tb-lifecycle"),g=document.getElementById("tb-domicile");g&&(Tt=!0,g.value="",Tt=!1),v==="all"?(m&&(m.value=""),r.emit("ui:filter-change",{field:"lifecycleState",value:""}),r.emit("ui:filter-change",{field:"lifecycleReason",value:""}),r.emit("ui:quick-filter",{filter:"all"})):v==="unavailable"?(m&&(m.value="unavailable"),r.emit("ui:filter-change",{field:"lifecycleState",value:"unavailable"})):v==="offsite"?(m&&(m.value=""),r.emit("ui:quick-filter",{filter:"offsite"})):v==="high-risk"?(m&&(m.value=""),r.emit("ui:quick-filter",{filter:"high-risk"})):v==="stuck"&&(m&&(m.value=""),r.emit("ui:quick-filter",{filter:"stuck"}))})}),document.getElementById("kpi-unavail").addEventListener("click",()=>{t.querySelectorAll(".tb-pill").forEach(v=>{v.classList.toggle("active",v.dataset.filter==="unavailable")});const c=document.getElementById("tb-lifecycle");c&&(c.value="unavailable"),r.emit("ui:filter-change",{field:"lifecycleState",value:"unavailable"})}),document.getElementById("kpi-avail").addEventListener("click",()=>{t.querySelectorAll(".tb-pill").forEach(v=>v.classList.remove("active"));const c=document.getElementById("tb-lifecycle");c&&(c.value="available"),r.emit("ui:filter-change",{field:"lifecycleState",value:"available"})}),document.getElementById("kpi-offsite").addEventListener("click",()=>{t.querySelectorAll(".tb-pill").forEach(c=>{c.classList.toggle("active",c.dataset.filter==="offsite")}),r.emit("ui:quick-filter",{filter:"offsite"})})}const ri={"relay-done":"Relay WO ready",opening:"Opening portal...","opening-portal":"Opening portal...","filling-form":"Filling form...","awaiting-review":"Awaiting review","review-ready":"Awaiting review","review-ready:stub":"Review (stub)",approved:"Approved - submitting...",submitting:"Submitting...","polling-sr-number":"Waiting for SR #...","polling-case-number":"Waiting for case #...","sr-created":"SR created","case-created":"Case created",complete:"Complete",cancelled:"Cancelled",running:"Running..."};function rn(e){return ri[e]||(e?e.replace(/-/g," "):"Running...")}const Dt=e=>String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"),Q=new Map;let Pe=null,Rt=null;function va(e){return"vab-pill-"+e.replace(/[^a-z0-9]/gi,"_")}function pi(e){return e==="paccar"?"dp-vnd-badge--paccar":e==="volvo"?"dp-vnd-badge--volvo":"dp-vnd-badge--unknown"}function ui(e){return e==="paccar"?"PACCAR":e==="volvo"?"Volvo":(e||"?").toUpperCase()}function vi(e){const t=va(e.workflowId),s=pi(e.vendor),a=ui(e.vendor),n=rn(e.step),i=Dt(e.unit||"—"),o=(e.step||"").includes("review")||(e.step||"").includes("awaiting")?'<span class="vab__pill-review-dot" title="Awaiting operator review"></span>':'<span class="vab__pill-spinner"></span>';return`<div class="vab__pill${(e.step||"").endsWith(":stub")?" vab__pill--stub":""}" id="${t}" data-wfid="${Dt(e.workflowId)}"><span class="vab__vendor dp-vnd-badge ${s}">${Dt(a)}</span><span class="vab__unit">${i}</span><span class="vab__step">${Dt(n)}</span>`+o+`<button class="vab__cancel" title="Cancel workflow" data-wfid="${Dt(e.workflowId)}">✕</button></div>`}function et(){if(!Rt)return;if(Q.size===0){Pe.style.display="none",Rt.innerHTML="";return}Pe.style.display="";for(const[t,s]of Q.entries()){const a=va(t);let n=document.getElementById(a);if(n){const i=n.querySelector(".vab__step");i&&(i.textContent=rn(s.step));const l=(s.step||"").includes("review")||(s.step||"").includes("awaiting"),o=n.querySelector(".vab__pill-spinner, .vab__pill-review-dot");o&&(o.className=l?"vab__pill-review-dot":"vab__pill-spinner",o.title=l?"Awaiting operator review":"")}else{const i=document.createElement("div");i.innerHTML=vi(s);const l=i.firstElementChild;Rt.appendChild(l)}}Rt.querySelectorAll(".vab__pill").forEach(t=>{const s=t.dataset.wfid;s&&!Q.has(s)&&t.remove()})}function Ca(e,t){const s=va(e),a=document.getElementById(s);a?(a.classList.add(t==="ok"?"vab__pill--complete":"vab__pill--error"),setTimeout(()=>{Q.delete(e),et()},1200)):(Q.delete(e),et())}async function Ia(){try{const e=await ne.getStatus();if(!e||!Array.isArray(e.active))return;for(const s of e.active)s.workflowId&&(Q.has(s.workflowId)||Q.set(s.workflowId,{workflowId:s.workflowId,vendor:s.vendor||"",unit:s.unit||"",step:s.step||"running"}));const t=new Set(e.active.map(s=>s.workflowId));for(const s of Q.keys())t.has(s)||Q.delete(s);et()}catch{}}function mi(e){e.addEventListener("click",async t=>{const s=t.target.closest(".vab__cancel");if(!s)return;const a=s.dataset.wfid;if(a){s.disabled=!0,s.textContent="...";try{await ne.cancel(a)}catch{}}})}function fi(e){Pe=document.createElement("div"),Pe.id="vnd-activity-bar",Pe.style.display="none",Pe.innerHTML='<div class="vab__label">ACTIVE WORKFLOWS</div><div class="vab__list"></div>',e.appendChild(Pe),Rt=Pe.querySelector(".vab__list"),mi(Pe),r.on("vendor:progress",t=>{if(!t||!t.workflowId)return;const s=Q.get(t.workflowId);Q.set(t.workflowId,{workflowId:t.workflowId,vendor:t.vendor||s&&s.vendor||"",unit:t.unit||s&&s.unit||"",step:t.step||s&&s.step||"running"}),et()}),r.on("vendor:review-ready",t=>{if(!t||!t.workflowId)return;const s=Q.get(t.workflowId)||{};Q.set(t.workflowId,{workflowId:t.workflowId,vendor:t.vendor||s.vendor||"",unit:t.unit||s.unit||"",step:"awaiting-review"}),et()}),r.on("vendor:complete",t=>{if(!t||!t.workflowId)return;const s=Q.get(t.workflowId)||{};Q.set(t.workflowId,{...s,step:"complete"}),et(),Ca(t.workflowId,"ok")}),r.on("vendor:error",t=>{if(!t||!t.workflowId)return;const s=Q.get(t.workflowId)||{};Q.set(t.workflowId,{...s,step:"error"}),et(),Ca(t.workflowId,"err")}),setInterval(Ia,8e3),Ia()}let Kt=null,pn=!0,xt=[],ge=JSON.parse(localStorage.getItem("fleet_pinned_order")||"[]"),Et=new Set(JSON.parse(localStorage.getItem("fleet_pinned_ids")||"[]"));function Ws(){localStorage.setItem("fleet_pinned_ids",JSON.stringify([...Et])),localStorage.setItem("fleet_pinned_order",JSON.stringify(ge))}function gi(e){Et=new Set(e),ge=ge.filter(t=>Et.has(t)),e.forEach(t=>{ge.includes(t)||ge.push(t)}),Ws(),ds(xt)}const bi={"in progress":{cls:"tag--org",label:"In Progress"},"pending parts":{cls:"tag--org",label:"Pending Parts"},"offsite shop":{cls:"tag--red",label:"Offsite Shop"},"shop repair":{cls:"tag--red",label:"Shop Repair"},"pending diag":{cls:"tag--pur",label:"Pending Diag"},available:{cls:"tag--grn",label:"Available"},accident:{cls:"tag--mut",label:"Accident"}};function hi(e){const t=(e||"").toLowerCase();for(const[s,a]of Object.entries(bi))if(t.includes(s))return`<span class="pin-tag ${a.cls}">${a.label}</span>`;return e?`<span class="pin-tag tag--mut">${e}</span>`:""}function yi(e){return e>=70?"pin-dot--crit":e>=40?"pin-dot--watch":"pin-dot--ok"}function wi(e){return e>=70?"var(--red)":e>=40?"var(--org)":"var(--grn)"}function _i(e){const t=Object.fromEntries(e.map(n=>[n.equipmentId,n])),s=ge.filter(n=>t[n]).map(n=>({...t[n],_manual:!0})),a=[...e].filter(n=>!Et.has(n.equipmentId)&&(n.riskScore>0||(n.lifecycleState||"").toLowerCase()==="unavailable")).sort((n,i)=>(i.riskScore||0)-(n.riskScore||0)).slice(0,Math.max(0,10-s.length));return[...s,...a]}let Ye=null;function ki(e){e.querySelectorAll('.pin-item[data-manual="true"]').forEach(t=>{t.setAttribute("draggable","true"),t.addEventListener("dragstart",()=>{Ye=t,setTimeout(()=>t.classList.add("dragging"),0)}),t.addEventListener("dragend",()=>{t.classList.remove("dragging"),e.querySelectorAll(".pin-item").forEach(s=>s.classList.remove("drag-over")),Ye=null}),t.addEventListener("dragover",s=>{s.preventDefault(),Ye&&Ye!==t&&t.dataset.manual==="true"&&(e.querySelectorAll(".pin-item").forEach(a=>a.classList.remove("drag-over")),t.classList.add("drag-over"))}),t.addEventListener("drop",s=>{if(s.preventDefault(),!Ye||Ye===t)return;const a=Ye.dataset.id,n=t.dataset.id,i=ge.indexOf(a),l=ge.indexOf(n);i===-1||l===-1||(ge.splice(i,1),ge.splice(l,0,a),Ws(),ds(xt))}),t.addEventListener("contextmenu",s=>{s.preventDefault(),s.stopPropagation();const a=t.dataset.id;Et.delete(a),ge=ge.filter(n=>n!==a),Ws(),r.emit("fleet:pins-updated",{pinnedIds:[...Et]}),r.emit("ui:toast",{type:"info",message:"Unpinned "+a,duration:1800}),ds(xt)})})}function ds(e){const t=document.getElementById("pin-list");if(!t)return;const s=_i(e),a=document.getElementById("pin-count");if(a&&(a.textContent=s.length||"0"),s.length===0){t.innerHTML='<div class="pin-empty">No priority units<div class="pin-empty-hint">Right-click a row to pin</div></div>';return}t.innerHTML=s.map(n=>{const i=n.riskScore||0,l=n._manual?"true":"false",o=n._manual?'<span class="drag-handle" title="Drag to reorder">⠿</span>':'<span class="drag-handle"></span>';return`
      <div class="pin-item" data-id="${n.equipmentId}" data-manual="${l}">
        ${o}
        <div class="pin-dot ${yi(i)}"></div>
        <div class="pin-info">
          <div class="pin-id">${n.equipmentId}${n._manual?' <span class="pin-manual-badge">📌</span>':""}</div>
          <div class="pin-meta">${[n.operator,n.domicileSite].filter(Boolean).join(" · ")}</div>
          ${hi(n.lifecycleReason)}
        </div>
        <div class="pin-score" style="color:${wi(i)}">${i||"—"}</div>
      </div>`}).join(""),t.querySelectorAll(".pin-item").forEach(n=>{n.addEventListener("click",()=>{t.querySelectorAll(".pin-item").forEach(l=>l.classList.remove("active")),n.classList.add("active");const i=xt.find(l=>l.equipmentId===n.dataset.id);i&&r.emit("ui:unit-select",{unit:i})})}),ki(t)}function xi(e){pn=e;const t=document.getElementById("priority-drawer"),s=document.getElementById("pts-icon");t&&(t.classList.toggle("collapsed",!e),s&&(s.textContent=e?"◀":"▶"))}function Ei(e){Kt=document.createElement("div"),Kt.id="priority-drawer-wrap",Kt.innerHTML=`
    <div id="priority-strip" class="priority-strip" title="Toggle priority pins">
      <span id="pts-icon" class="pts-icon">◀</span>
    </div>
    <aside id="priority-drawer" class="priority-drawer">
      <div class="pd-header">
        <span class="pd-title">Priority Pins</span>
        <span class="pd-count" id="pin-count">—</span>
      </div>
      <div class="pd-list" id="pin-list">
        <div class="pin-empty">Waiting for data...<div class="pin-empty-hint">Right-click a row to pin</div></div>
      </div>
    </aside>
  `,e.appendChild(Kt),document.getElementById("priority-strip").addEventListener("click",()=>xi(!pn)),r.on("state:fleet",t=>{xt=t.rows||[],ds(xt)}),r.on("fleet:pins-updated",({pinnedIds:t})=>{gi(t)}),r.on("ui:unit-select",({unit:t})=>{const s=document.getElementById("pin-list");s&&s.querySelectorAll(".pin-item").forEach(a=>a.classList.toggle("active",a.dataset.id===t.equipmentId))}),r.on("ui:unit-deselect",()=>{const t=document.getElementById("pin-list");t&&t.querySelectorAll(".pin-item").forEach(s=>s.classList.remove("active"))})}let st=[],Ce=null;function zs(){const e=document.getElementById("notif-list");if(!e)return;const t=document.getElementById("tb-notif-badge"),s=st.filter(a=>!a.read).length;if(t&&(t.textContent=s,t.style.display=s>0?"flex":"none"),st.length===0){e.innerHTML='<div class="notif-empty">No notifications</div>';return}e.innerHTML=st.map((a,n)=>`
    <div class="notif-item ${a.read?"":"notif-item--unread"}" data-idx="${n}">
      <div class="notif-icon">${a.icon||"🔔"}</div>
      <div class="notif-body">
        <div class="notif-text">${a.body||""}</div>
        <div class="notif-time">${a.time||""}</div>
      </div>
    </div>
  `).join("")}function $a(){st.forEach(e=>e.read=!0),zs()}function Si(){Ce=document.createElement("div"),Ce.id="notif-dropdown",Ce.className="notif-dropdown",Ce.innerHTML=`
    <div class="notif-header">
      <span class="notif-title">🔔 Notifications</span>
      <button class="notif-clear" id="notif-clear">Mark all read</button>
    </div>
    <div id="notif-list"></div>
  `,document.body.appendChild(Ce),document.getElementById("notif-clear").addEventListener("click",$a),r.on("ui:notif-toggle",()=>{Ce.classList.toggle("open");const e=document.getElementById("settings-drawer-overlay");e&&e.classList.remove("open")}),r.on("ui:notif-push",e=>{st.unshift({...e,read:!1,time:e.time||"just now"}),st.length>20&&(st.length=20),zs(),Ce.classList.contains("open")&&$a()}),document.addEventListener("click",e=>{if(e.target.closest("#tb-notif")){r.emit("ui:notif-toggle");return}Ce.classList.contains("open")&&!Ce.contains(e.target)&&Ce.classList.remove("open")}),r.on("fleet:status",e=>{e&&(e.includes("✅")||e.includes("⚠")||e.includes("❌"))&&r.emit("ui:notif-push",{icon:"🔄",body:e,time:new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})})}),zs()}let Mt=!1;function xs(){Mt=!Mt;const e=document.getElementById("orcha-panel"),t=document.getElementById("orcha-fab"),s=document.getElementById("detail-panel");if(!e||!t)return;e.classList.toggle("open",Mt),t.classList.toggle("open",Mt);const a=s&&s.classList.contains("open")?"424px":"24px";e.style.right=a,t.style.right=a}function Yt(e,t){const s=document.getElementById("orcha-msgs");if(!s)return;const a=document.createElement("div");a.className="oc-msg "+e,a.textContent=t,s.appendChild(a),s.scrollTop=s.scrollHeight}function Aa(){const e=document.getElementById("orcha-input"),t=(e.value||"").trim();t&&(e.value="",Yt("oc-msg--user",t),te&&te.chat?te.chat(t).then(s=>{Yt("oc-msg--orcha",s&&s.message?s.message:"Done.")}).catch(()=>{Yt("oc-msg--orcha","AI unavailable right now.")}):setTimeout(()=>Yt("oc-msg--orcha","On it — give me a moment."),500))}function Li(){const e=document.createElement("button");e.id="orcha-fab",e.className="orcha-fab",e.title="Orcha AI",e.innerHTML="✦",e.addEventListener("click",xs),document.body.appendChild(e);const t=document.createElement("div");t.id="orcha-panel",t.className="orcha-panel",t.innerHTML=`
    <div class="orcha-panel-header" id="orcha-panel-header">
      <div class="orcha-avatar">✦</div>
      <span class="orcha-title">Orcha AI</span>
      <span class="orcha-status" id="orcha-status">● Ready</span>
      <button class="orcha-close" id="orcha-close">▼</button>
    </div>
    <div class="oc-msgs" id="orcha-msgs">
      <div class="oc-msg oc-msg--orcha">Hi — I'm watching your fleet. Ask me anything or I'll surface key issues automatically.</div>
    </div>
    <div class="oc-input-row">
      <input class="oc-input" id="orcha-input" placeholder="Ask Orcha..." autocomplete="off" spellcheck="false"/>
      <button class="oc-send" id="orcha-send">Send</button>
    </div>
  `,document.body.appendChild(t),document.getElementById("orcha-close").addEventListener("click",xs),document.getElementById("orcha-panel-header").addEventListener("click",s=>{s.target.closest("#orcha-close")||xs()}),document.getElementById("orcha-send").addEventListener("click",Aa),document.getElementById("orcha-input").addEventListener("keydown",s=>{s.key==="Enter"&&Aa()}),r.on("ui:unit-select",()=>{if(Mt){const s=document.getElementById("orcha-panel"),a=document.getElementById("orcha-fab");s&&(s.style.right="424px"),a&&(a.style.right="424px")}}),r.on("ui:unit-deselect",()=>{const s=document.getElementById("orcha-panel"),a=document.getElementById("orcha-fab");s&&(s.style.right="24px"),a&&(a.style.right="24px")}),r.on("orcha:progress",s=>{const a=document.getElementById("orcha-status");a&&(a.textContent="● "+(s.message||"Working..."))})}let xe=null,at=!1,nt=[],cs=[],We={critical:0,warning:0,info:0};const X=e=>String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");function mt(){if(!xe)return;const e=nt.length,t=cs.length;xe.innerHTML=`
    <div class="ip-panel${at?" ip-panel--open":""}">
      <div class="ip-header" id="ip-toggle">
        <div class="ip-header__left">
          <span class="ip-header__icon">🧠</span>
          <span class="ip-header__title">Orcha Intelligence</span>
          <span class="ip-header__summary">
            ${We.critical>0?'<span class="ip-badge ip-badge--crit">'+We.critical+" critical</span>":""}
            ${We.warning>0?'<span class="ip-badge ip-badge--warn">'+We.warning+" warnings</span>":""}
            ${We.info>0?'<span class="ip-badge ip-badge--info">'+We.info+" info</span>":""}
            ${t>0?'<span class="ip-badge ip-badge--rec">'+t+" actions</span>":""}
            ${e===0&&t===0?'<span class="ip-badge ip-badge--ok">All clear</span>':""}
          </span>
        </div>
        <div class="ip-header__right">
          <span class="ip-chevron${at?" ip-chevron--open":""}">▾</span>
        </div>
      </div>

      ${at?`
      <div class="ip-body">
        <div class="ip-cols">

          <!-- Alerts Column -->
          <div class="ip-col">
            <div class="ip-col-title">
              <span>Alerts</span>
              <span class="ip-col-count">${e}</span>
            </div>
            <div class="ip-col-scroll">
              ${e===0?'<div class="ip-empty">No alerts — fleet data is healthy</div>':nt.slice(0,15).map(Ci).join("")}
            </div>
          </div>

          <!-- Recommendations Column -->
          <div class="ip-col">
            <div class="ip-col-title">
              <span>Recommended Actions</span>
              <span class="ip-col-count">${t}</span>
            </div>
            <div class="ip-col-scroll">
              ${t===0?'<div class="ip-empty">No actions needed — fleet is on track</div>':cs.slice(0,15).map(Ii).join("")}
            </div>
          </div>

        </div>
      </div>
      `:""}
    </div>
  `,$i()}function Ci(e){const t=e.severity==="critical"?"🔴":e.severity==="warning"?"⚠️":"i️";return`
    <div class="ip-alert ${"ip-alert--"+e.severity}" data-alert-id="${X(e.id)}">
      <div class="ip-alert__header">
        <span class="ip-alert__sev">${t}</span>
        <span class="ip-alert__unit">${X(e.unit)}</span>
        <span class="ip-alert__op">${X(e.operator)}</span>
        <button class="ip-alert__dismiss" data-dismiss="${X(e.id)}" title="Dismiss">✕</button>
      </div>
      <div class="ip-alert__msg">${X(e.message)}</div>
      <div class="ip-alert__suggest">${X(e.suggestion)}</div>
    </div>
  `}function Ii(e){const t=e.meta||{};return`
    <div class="ip-rec" data-unit="${X(e.unit)}">
      <div class="ip-rec__header">
        <span class="ip-rec__icon">${t.icon||"💡"}</span>
        <span class="ip-rec__action">${X(t.label||e.action)}</span>
        <span class="ip-rec__conf">${e.confidence}%</span>
      </div>
      <div class="ip-rec__unit">${X(e.unit)} <span class="ip-rec__op">${X(e.operator)} · ${X(e.domicile)}</span></div>
      <div class="ip-rec__reason">${X(e.reason)}</div>
      <div class="ip-rec__footer">
        <span class="ip-rec__suggest">${X(e.suggestion)}</span>
        <button class="ip-rec__exec" data-unit="${X(e.unit)}" data-action="${X(e.action)}" data-payload='${X(JSON.stringify(e.payload||{}))}' title="Execute via Orchestrator">⚡</button>
        <button class="ip-rec__go" data-unit="${X(e.unit)}" data-action="${X(e.action)}">→ Go</button>
      </div>
    </div>
  `}function $i(){const e=document.getElementById("ip-toggle");e&&e.addEventListener("click",()=>{at=!at,mt()}),xe.querySelectorAll(".ip-alert__dismiss").forEach(t=>{t.addEventListener("click",s=>{s.stopPropagation();const a=t.dataset.dismiss;a&&(nt=nt.filter(n=>n.id!==a),We=un(nt),te.dismissAlert&&te.dismissAlert(a).catch(()=>{}),mt())})}),xe.querySelectorAll(".ip-rec__exec").forEach(t=>{t.addEventListener("click",async s=>{s.stopPropagation();const a=t.dataset.action,n=t.dataset.unit;let i={};try{i=JSON.parse(t.dataset.payload||"{}")}catch{}t.disabled=!0,t.textContent="...";try{const l=await te.execute({type:a,unitId:n,unit:n,data:i});l&&l.success?(t.textContent="✓",t.classList.add("ip-rec__exec--done"),r.emit("ui:toast",{type:"success",message:`${a} executed for ${n}`,duration:3e3})):l&&l.blocked?(t.textContent="✕",r.emit("ui:toast",{type:"warning",message:l.message||"Blocked by safety checks",duration:4e3})):(t.textContent="⚡",r.emit("ui:toast",{type:"info",message:l&&l.errors?l.errors[0]:"Action recorded",duration:3e3}))}catch(l){t.textContent="⚡",r.emit("ui:toast",{type:"error",message:"Execution error: "+(l.message||"unknown"),duration:3e3})}finally{t.disabled=!1}})}),xe.querySelectorAll(".ip-rec__go").forEach(t=>{t.addEventListener("click",s=>{s.stopPropagation();const a=t.dataset.unit;a&&(r.emit("navigate:unit",a),r.emit("ui:view-change",{from:"current",to:"fleet"}))})}),xe.querySelectorAll(".ip-rec").forEach(t=>{t.addEventListener("click",()=>{const s=t.dataset.unit;s&&r.emit("navigate:unit",s)})})}function un(e){const t={critical:0,warning:0,info:0};return e.forEach(s=>t[s.severity]++),t}function Ai(){xe=document.createElement("div"),xe.id="intelligence-panel-mount",xe.className="ip-mount";const e=document.getElementById("body-area");e&&e.parentNode?e.parentNode.insertBefore(xe,e):document.getElementById("app-shell").appendChild(xe),mt(),r.on("orcha:alerts",t=>{nt=t&&t.alerts||[],We=t&&t.counts||un(nt),mt()}),r.on("orcha:recommendations",t=>{cs=t&&t.recommendations||[],t&&t.summary||cs.length,mt()}),r.on("ui:toggle-intelligence",()=>{at=!at,mt()})}let Fe=null,it=!1,tt=[];const ct=e=>String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"),Bi={note:"📝",wr:"📋",email:"📧",sp:"📊"},vn={note:"Note Update",wr:"Work Request",email:"Email Draft",sp:"SP Push"};function ze(){if(!Fe)return;const e=tt.filter(t=>t.status==="pending");Fe.innerHTML=`
    <div class="di-panel${it?" di-panel--open":""}">
      <div class="di-header" id="di-toggle">
        <div class="di-header__left">
          <span class="di-header__icon">📦</span>
          <span class="di-header__title">Draft Inbox</span>
          ${e.length>0?'<span class="di-badge">'+e.length+" pending</span>":'<span class="di-badge di-badge--ok">Empty</span>'}
        </div>
        <span class="di-chevron${it?" di-chevron--open":""}">▾</span>
      </div>
      ${it?`
      <div class="di-body">
        ${e.length===0?'<div class="di-empty">No pending drafts — Orcha will auto-prepare items before scheduled sends</div>':'<div class="di-list">'+e.map((t,s)=>Ti(t,s)).join("")+"</div>"}
        ${e.length>1?'<div class="di-bulk"><button class="di-bulk-btn" id="di-approve-all">✓ Approve All ('+e.length+')</button><button class="di-bulk-btn di-bulk-btn--dismiss" id="di-dismiss-all">Dismiss All</button></div>':""}
      </div>
      `:""}
    </div>
  `,Di()}function Ti(e,t){const s=Bi[e.type]||"📄",a=vn[e.type]||e.type;return`
    <div class="di-draft" data-idx="${t}">
      <div class="di-draft__header">
        <span class="di-draft__icon">${s}</span>
        <span class="di-draft__type">${ct(a)}</span>
        ${e.unit?'<span class="di-draft__unit">'+ct(e.unit)+"</span>":""}
        ${e.operator?'<span class="di-draft__op">'+ct(e.operator)+"</span>":""}
      </div>
      <div class="di-draft__body">
        ${e.type==="note"?'<div class="di-draft__preview">'+ct((e.summary||"").substring(0,120))+"...</div>":""}
        ${e.type==="wr"?'<div class="di-draft__preview">Risk '+(e.riskScore||"?")+"% — "+ct((e.payload&&e.payload.description||"").substring(0,100))+"</div>":""}
        ${e.type==="email"?'<div class="di-draft__preview">Slot: '+ct(e.slot)+" — "+(e.unavailCount||0)+" unavailable / "+(e.unitCount||0)+" total</div>":""}
      </div>
      <div class="di-draft__actions">
        <button class="di-draft__approve" data-idx="${t}" title="Approve & Execute">✓ Approve</button>
        <button class="di-draft__dismiss" data-idx="${t}" title="Dismiss">✕</button>
      </div>
    </div>
  `}function Di(){const e=document.getElementById("di-toggle");e&&e.addEventListener("click",()=>{it=!it,ze()}),Fe.querySelectorAll(".di-draft__approve").forEach(a=>{a.addEventListener("click",async n=>{n.stopPropagation();const i=parseInt(a.dataset.idx,10),l=tt.filter(o=>o.status==="pending")[i];if(l){a.disabled=!0,a.textContent="...";try{const o=l.type==="note"?"update_notes":l.type==="wr"?"create_wr":l.type==="email"?"send_email":"deep_scan";await te.execute({type:o,unitId:l.unit,unit:l.unit,data:l.payload||{unitId:l.unit}}),l.status="approved",r.emit("ui:toast",{type:"success",message:`${vn[l.type]} approved for ${l.unit||"fleet"}`,duration:2500})}catch(o){r.emit("ui:toast",{type:"error",message:"Approve failed: "+(o.message||"unknown"),duration:3e3})}ze()}})}),Fe.querySelectorAll(".di-draft__dismiss").forEach(a=>{a.addEventListener("click",n=>{n.stopPropagation();const i=parseInt(a.dataset.idx,10),l=tt.filter(o=>o.status==="pending");l[i]&&(l[i].status="dismissed"),ze()})});const t=document.getElementById("di-approve-all");t&&t.addEventListener("click",async()=>{const a=tt.filter(i=>i.status==="pending");t.disabled=!0,t.textContent="Approving...";let n=0;for(const i of a)try{const l=i.type==="note"?"update_notes":i.type==="wr"?"create_wr":i.type==="email"?"send_email":"deep_scan";await te.execute({type:l,unitId:i.unit,unit:i.unit,data:i.payload||{}}),i.status="approved",n++}catch{}r.emit("ui:toast",{type:"success",message:`${n} drafts approved`,duration:2500}),ze()});const s=document.getElementById("di-dismiss-all");s&&s.addEventListener("click",()=>{tt.filter(a=>a.status==="pending").forEach(a=>{a.status="dismissed"}),ze(),r.emit("ui:toast",{type:"info",message:"All drafts dismissed",duration:2e3})})}function Pi(){Fe=document.createElement("div"),Fe.id="draft-inbox-mount",Fe.className="di-mount";const e=document.getElementById("body-area");e&&e.parentNode&&e.parentNode.insertBefore(Fe,e),ze(),r.on("orcha:drafts",t=>{if(t&&t.drafts){for(const s of t.drafts){const a=s.type+":"+(s.unit||"fleet")+":"+(s.slot||"");tt.find(i=>i._key===a&&i.status==="pending")||(s._key=a,tt.push(s))}ze()}}),r.on("ui:toggle-drafts",()=>{it=!it,ze()})}const Es=["detected","assigned","diagnosed","quoted","approved","parts","repair","qc","pickup","active"],Ba={detected:"Detect",assigned:"Assign",diagnosed:"Diagnose",quoted:"Quote",approved:"Approve",parts:"Parts",repair:"Repair",qc:"QC",pickup:"Pickup",active:"Active"},Ri={detected:"🔍",assigned:"📋",diagnosed:"🔬",quoted:"💰",approved:"✅",parts:"📦",repair:"🔧",qc:"✔️",pickup:"🚛",active:"🟢"};let qe=null,Vs=null;function Mi(e){const t=E.get("tracker");return!t||!t.tracked?null:t.tracked.find(s=>s.equipmentId===e)}function Ta(e){if(!qe)return;Vs=e;const t=Mi(e);if(!t){qe.innerHTML='<div class="wt-empty">No workflow data for this unit</div>';return}const s=Es.indexOf(t.currentStage),a=s>=0?Math.round(s/(Es.length-1)*100):0;qe.innerHTML=`
    <div class="wt-container nx-animate-in">
      <div class="wt-header">
        <span class="wt-header__title">Workflow Progress</span>
        <span class="wt-header__pct">${a}%</span>
        ${t.isStuck?'<span class="wt-header__stuck">⚠ STUCK</span>':""}
      </div>
      <div class="nx-timeline">
        <div class="nx-timeline__track"></div>
        <div class="nx-timeline__progress" style="width: ${a}%"></div>
        ${Es.map((n,i)=>{const l=i<s,o=i===s,d=l?"nx-timeline__dot--done":o?"nx-timeline__dot--current":"nx-timeline__dot--future",p=l||o?"nx-timeline__label--active":"";return`
            <div class="nx-timeline__stage" title="${Ba[n]}${o?" ("+t.timeInStageHours+"h)":""}">
              <div class="nx-timeline__dot ${d}"></div>
              <span class="nx-timeline__label ${p}">${Ri[n]}</span>
              ${o?'<span class="nx-timeline__time">'+t.timeInStageHours+"h</span>":""}
            </div>
          `}).join("")}
      </div>
      <div class="wt-meta">
        <span class="wt-meta__stage">Stage: <strong>${Ba[t.currentStage]||t.currentStage}</strong></span>
        <span class="wt-meta__time">In stage: <strong>${t.timeInStageHours}h</strong> / ${t.expectedHours}h expected</span>
        ${t.vendor?'<span class="wt-meta__vendor">Vendor: <strong>'+t.vendor+"</strong></span>":""}
      </div>
    </div>
  `}function qi(){qe=document.createElement("div"),qe.id="workflow-timeline-mount",qe.className="wt-mount",r.on("ui:unit-select",({unit:e})=>{e&&e.equipmentId&&(Oi(),Ta(e.equipmentId))}),r.on("orcha:tracker",()=>{Vs&&Ta(Vs)})}function Oi(){if(qe.parentNode)return;const e=document.getElementById("detail-panel")||document.querySelector(".detail-panel");if(e){const t=e.querySelector(".detail-panel__section, .dp-section");t?t.parentNode.insertBefore(qe,t):e.prepend(qe)}}let Je=null,ft=!1,ys="alerts";const Ui=[{id:"alerts",label:"🚨 Alerts",badge:()=>{var t;const e=E.get("alerts");return(Array.isArray(e)?e.length:(t=e==null?void 0:e.alerts)==null?void 0:t.length)||0}},{id:"actions",label:"💡 Actions",badge:()=>{var t;const e=E.get("recommendations");return(Array.isArray(e)?e.length:(t=e==null?void 0:e.recommendations)==null?void 0:t.length)||0}},{id:"drafts",label:"📦 Drafts",badge:()=>St.filter(e=>e.status==="pending").length},{id:"timeline",label:"📍 Workflow",badge:()=>""},{id:"health",label:"🏥 Health",badge:()=>""}];let St=[];function pe(e){return String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}function me(){Je&&(Je.innerHTML=`
    <div class="nx-sidebar${ft?" nx-sidebar--open":""}">
      <button class="nx-sidebar__close" id="nx-sb-close">◂</button>
      <div class="nx-sidebar__tabs">
        ${Ui.map(e=>{const t=e.badge();return`<div class="nx-sidebar__tab${ys===e.id?" nx-sidebar__tab--active":""}" data-tab="${e.id}">
            ${e.label}${t?'<span class="nx-nav__badge">'+t+"</span>":""}
          </div>`}).join("")}
      </div>
      <div class="nx-sidebar__content nx-stagger">
        ${Ni()}
      </div>
    </div>
  `,Fi())}function Ni(){switch(ys){case"alerts":return Hi();case"actions":return ji();case"drafts":return Wi();case"timeline":return zi();case"health":return Vi();default:return""}}function Hi(){const e=E.get("alerts"),t=Array.isArray(e)?e:(e==null?void 0:e.alerts)||[];return!Array.isArray(t)||t.length===0?'<div class="nx-empty">No alerts — fleet is healthy</div>':t.slice(0,20).map(s=>`
    <div class="nx-card" style="margin-bottom:8px;border-left:3px solid ${s.severity==="critical"?"var(--nx-red)":s.severity==="warning"?"var(--nx-orange)":"var(--nx-accent)"}">
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
        <span style="font-size:11px">${s.severity==="critical"?"🔴":s.severity==="warning"?"⚠️":"i️"}</span>
        <span style="font-family:var(--nx-mono);font-size:11px;font-weight:700;color:var(--nx-accent)">${pe(s.unit)}</span>
        <span style="font-size:9px;color:var(--nx-text3);margin-left:auto">${pe(s.operator)}</span>
      </div>
      <div style="font-size:10px;color:var(--nx-text)">${pe(s.message)}</div>
      <div style="font-size:9px;color:var(--nx-text3);font-style:italic;margin-top:2px">${pe(s.suggestion)}</div>
    </div>
  `).join("")}function ji(){const e=E.get("recommendations"),t=Array.isArray(e)?e:(e==null?void 0:e.recommendations)||[];return!Array.isArray(t)||t.length===0?'<div class="nx-empty">No actions needed</div>':t.slice(0,15).map(s=>`
    <div class="nx-card" style="margin-bottom:8px;cursor:pointer" data-unit="${pe(s.unit)}">
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:3px">
        <span style="font-size:10px;font-weight:700;color:var(--nx-purple);text-transform:uppercase">${pe(s.action)}</span>
        <span style="margin-left:auto;font-family:var(--nx-mono);font-size:9px;color:var(--nx-green)">${s.confidence}%</span>
      </div>
      <div style="font-family:var(--nx-mono);font-size:11px;color:var(--nx-accent);font-weight:700">${pe(s.unit)}</div>
      <div style="font-size:9px;color:var(--nx-text2);margin-top:2px">${pe(s.reason)}</div>
    </div>
  `).join("")}function Wi(){const e=St.filter(s=>s.status==="pending");if(e.length===0)return'<div class="nx-empty">No pending drafts</div>';const t={note:"📝",wr:"📋",email:"📧"};return e.map((s,a)=>{var n;return`
    <div class="nx-card" style="margin-bottom:8px">
      <div style="display:flex;gap:6px;align-items:center">
        <span>${t[s.type]||"📄"}</span>
        <span style="font-size:10px;font-weight:700;color:var(--nx-purple)">${pe(s.type).toUpperCase()}</span>
        ${s.unit?'<span style="font-family:var(--nx-mono);font-size:11px;color:var(--nx-accent)">'+pe(s.unit)+"</span>":""}
      </div>
      <div style="font-size:9px;color:var(--nx-text2);margin:4px 0">${pe((s.summary||((n=s.payload)==null?void 0:n.description)||"").substring(0,80))}</div>
      <div style="display:flex;gap:6px">
        <button class="nx-btn nx-btn--success nx-sb-approve" data-idx="${a}" style="font-size:9px;padding:4px 10px">✓ Approve</button>
        <button class="nx-btn nx-sb-dismiss" data-idx="${a}" style="font-size:9px;padding:4px 8px">✕</button>
      </div>
    </div>
  `}).join("")}function zi(){const e=E.get("tracker");if(!e||!e.summary)return'<div class="nx-empty">Waiting for tracker data...</div>';const t=["detected","assigned","diagnosed","quoted","approved","parts","repair","qc","pickup","active"],s=e.summary.stageCounts||{};return`
    <div class="nx-stat" style="margin-bottom:16px">
      <span class="nx-stat__value">${e.summary.total}</span>
      <span class="nx-stat__label">Total units tracked</span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
      <div class="nx-card"><span class="nx-stat__value" style="font-size:20px">${e.summary.stuck||0}</span><span class="nx-stat__label">Stuck</span></div>
      <div class="nx-card"><span class="nx-stat__value" style="font-size:20px">${e.summary.avgProgress||0}%</span><span class="nx-stat__label">Avg Progress</span></div>
    </div>
    <div style="font-size:9px;font-weight:700;color:var(--nx-text2);text-transform:uppercase;margin-bottom:8px">Stage Distribution</div>
    ${t.map(a=>{const n=s[a]||0,i=e.summary.total>0?Math.round(n/e.summary.total*100):0;return`<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span style="font-size:9px;width:60px;color:var(--nx-text3)">${a}</span>
        <div style="flex:1;height:6px;border-radius:3px;background:var(--nx-border);overflow:hidden">
          <div style="height:100%;width:${i}%;background:linear-gradient(90deg,var(--nx-accent),var(--nx-purple));border-radius:3px;transition:width .6s var(--nx-ease)"></div>
        </div>
        <span style="font-family:var(--nx-mono);font-size:9px;color:var(--nx-text2);width:24px;text-align:right">${n}</span>
      </div>`}).join("")}
  `}function Vi(){const e=E.get("health");if(!e)return'<div class="nx-empty">Waiting for health check...</div>';const t={green:"🟢",yellow:"🟡",red:"🔴"};return`
    <div class="nx-stat" style="margin-bottom:16px">
      <span class="nx-stat__value">${e.overallScore||0}%</span>
      <span class="nx-stat__label">System Health</span>
    </div>
    ${Object.entries(e.integrations||{}).map(([s,a])=>`
      <div class="nx-card" style="margin-bottom:6px;display:flex;align-items:center;gap:8px">
        <span>${t[a.status]||"⚪"}</span>
        <div style="flex:1">
          <div style="font-size:11px;font-weight:600;color:var(--nx-text)">${pe(a.label)}</div>
          <div style="font-size:9px;color:var(--nx-text3)">${pe(a.detail)}</div>
        </div>
      </div>
    `).join("")}
  `}function Fi(){const e=document.getElementById("nx-sb-close");e&&e.addEventListener("click",()=>{ft=!1,me()}),Je.querySelectorAll(".nx-sidebar__tab").forEach(t=>{t.addEventListener("click",()=>{ys=t.dataset.tab,me()})}),Je.querySelectorAll(".nx-sb-approve").forEach(t=>{t.addEventListener("click",async()=>{const a=St.filter(n=>n.status==="pending")[parseInt(t.dataset.idx,10)];a&&(a.status="approved",r.emit("ui:toast",{type:"success",message:"Draft approved",duration:2e3}),me())})}),Je.querySelectorAll(".nx-sb-dismiss").forEach(t=>{t.addEventListener("click",()=>{const a=St.filter(n=>n.status==="pending")[parseInt(t.dataset.idx,10)];a&&(a.status="dismissed"),me()})})}function Gi(){Je=document.createElement("div"),Je.id="nexus-sidebar-mount",document.body.appendChild(Je),me(),r.on("ui:toggle-intelligence",()=>{ft=!ft,me()}),r.on("nexus:open-sidebar",e=>{ft=!0,e&&(ys=e),me()}),r.on("nexus:close-sidebar",()=>{ft=!1,me()}),r.on("orcha:alerts",()=>me()),r.on("orcha:recommendations",()=>me()),r.on("orcha:tracker",()=>me()),r.on("orcha:drafts",e=>{if(e&&e.drafts)for(const t of e.drafts){const s=t.type+":"+(t.unit||"")+":"+(t.slot||"");St.find(a=>a._key===s&&a.status==="pending")||(t._key=s,St.push(t))}me()})}let gt=null,qt=null,rs="",mn=0,fn=0,Fs=!1;function rt(){if(!gt)return;const e=qt?Ji(qt):"never";gt.innerHTML=`
    <div class="sb-bar">
      <div class="sb-left">
        <span class="sb-item sb-sync-ago">
          <span class="sb-dot ${qt&&Date.now()-qt<6e5?"sb-dot--green":"sb-dot--amber"}"></span>
          Last sync: ${e}
        </span>
        <span class="sb-sep">│</span>
        <span class="sb-item">${mn} units</span>
        <span class="sb-sep">│</span>
        <span class="sb-item sb-unavail">${fn} unavailable</span>
        ${rs?'<span class="sb-sep">│</span><span class="sb-item sb-msg">'+Xi(rs)+"</span>":""}
      </div>
      <div class="sb-right">
        <span class="sb-item">
          <span class="sb-dot ${Fs?"sb-dot--green":"sb-dot--red"}"></span>
          AI: ${Fs?"Connected":"Disconnected"}
        </span>
        <span class="sb-sep">│</span>
        <span class="sb-item sb-version">v3.0.0</span>
      </div>
    </div>
  `}function Xi(e){return String(e||"").replace(/</g,"&lt;").replace(/>/g,"&gt;")}function Ji(e){const t=Math.round((Date.now()-e)/1e3);if(t<60)return t+"s ago";const s=Math.round(t/60);return s<60?s+"m ago":Math.round(s/60)+"h ago"}function Ki(e){e?gt=e:(gt=document.createElement("div"),gt.id="status-bar-mount",document.body.appendChild(gt)),rt(),r.on("state:fleet",t=>{qt=Date.now();const s=t.rows||[];mn=s.length,fn=s.filter(a=>/unavailable/i.test(a.lifecycleState||"")).length,rt()}),r.on("sync:status",t=>{rs=t,rt(),setTimeout(()=>{rs="",rt()},8e3)}),r.on("orcha:status",t=>{Fs=!!(t&&t.connected),rt()}),setInterval(rt,3e4)}const gn="nexus_theme",bn={preset:"default",accent:"#00d4ff",density:"default",blur:20,animSpeed:"default",glowIntensity:1,bgGradient:!0,gridLines:!0},Vt={default:{accent:"#00d4ff",purple:"#a855f7",bg:"#05080d"},void:{accent:"#ff00ff",purple:"#00ffcc",bg:"#000000"},solar:{accent:"#f59e0b",purple:"#f97316",bg:"#1a1510"},arctic:{accent:"#38bdf8",purple:"#818cf8",bg:"#020b18"},ember:{accent:"#ef4444",purple:"#f97316",bg:"#0d0506"}};let q={...bn};function Yi(){try{const e=localStorage.getItem(gn);e&&(q={...bn,...JSON.parse(e)})}catch{}}function hn(){localStorage.setItem(gn,JSON.stringify(q))}function ma(){var n;const e=document.documentElement;e.setAttribute("data-theme",q.preset),e.setAttribute("data-density",q.density),q.accent&&q.accent!==((n=Vt[q.preset])==null?void 0:n.accent)?(e.style.setProperty("--nx-accent",q.accent),e.style.setProperty("--nx-accent-dim",Ss(q.accent,.15)),e.style.setProperty("--nx-accent-glow",`0 0 20px ${Ss(q.accent,.3)}, 0 0 60px ${Ss(q.accent,.1)}`)):(e.style.removeProperty("--nx-accent"),e.style.removeProperty("--nx-accent-dim"),e.style.removeProperty("--nx-accent-glow")),e.style.setProperty("--nx-blur",q.blur+"px"),e.style.setProperty("--nx-glass-blur",q.blur+"px");const t={off:"0s",fast:".15s",default:".35s",slow:".6s"};e.style.setProperty("--nx-duration",t[q.animSpeed]||".35s");const s=q.glowIntensity;e.style.setProperty("--nx-glow-mult",String(s));const a=document.getElementById("nexus-bg");a&&(a.style.opacity=q.bgGradient?"1":"0",a.querySelector(".nx-grid")&&(a.querySelector(".nx-grid").style.opacity=q.gridLines?"1":"0")),r.emit("nexus:theme-change",q)}function Ss(e,t){const s=parseInt(e.slice(1,3),16),a=parseInt(e.slice(3,5),16),n=parseInt(e.slice(5,7),16);return`rgba(${s},${a},${n},${t})`}function Qi(){Yi(),ma()}function Da(){return{...q}}function He(e,t){q[e]=t,hn(),ma()}function Zi(e){Vt[e]&&(q.preset=e,q.accent=Vt[e].accent,hn(),ma())}const el="modulepreload",tl=function(e,t){return new URL(e,t).href},Pa={},fa=function(t,s,a){let n=Promise.resolve();if(s&&s.length>0){let l=function(u){return Promise.all(u.map(c=>Promise.resolve(c).then(v=>({status:"fulfilled",value:v}),v=>({status:"rejected",reason:v}))))};const o=document.getElementsByTagName("link"),d=document.querySelector("meta[property=csp-nonce]"),p=(d==null?void 0:d.nonce)||(d==null?void 0:d.getAttribute("nonce"));n=l(s.map(u=>{if(u=tl(u,a),u in Pa)return;Pa[u]=!0;const c=u.endsWith(".css"),v=c?'[rel="stylesheet"]':"";if(!!a)for(let x=o.length-1;x>=0;x--){const f=o[x];if(f.href===u&&(!c||f.rel==="stylesheet"))return}else if(document.querySelector(`link[href="${u}"]${v}`))return;const g=document.createElement("link");if(g.rel=c?"stylesheet":el,c||(g.as="script"),g.crossOrigin="",g.href=u,p&&g.setAttribute("nonce",p),document.head.appendChild(g),c)return new Promise((x,f)=>{g.addEventListener("load",x),g.addEventListener("error",()=>f(new Error(`Unable to preload CSS for ${u}`)))})}))}function i(l){const o=new Event("vite:preloadError",{cancelable:!0});if(o.payload=l,window.dispatchEvent(o),!o.defaultPrevented)throw l}return n.then(l=>{for(const o of l||[])o.status==="rejected"&&i(o.reason);return t().catch(i)})};let V=null,Ft=!1;function sl(){V||(V=document.createElement("div"),V.className="ctx-menu",V.setAttribute("role","menu"),document.body.appendChild(V),document.addEventListener("mousedown",e=>{Ft&&!V.contains(e.target)&&Ht()}),document.addEventListener("keydown",e=>{Ft&&e.key==="Escape"&&Ht()}),window.addEventListener("scroll",Ht,{passive:!0,capture:!0}))}function Ht(){V&&(V.classList.remove("open"),Ft=!1,setTimeout(()=>{V&&!Ft&&(V.innerHTML="")},160))}function al(e,t){e.preventDefault(),sl(),Ht();const{header:s,items:a=[]}=t;let n="";s&&(n+='<div class="ctx-head"><div class="ctx-uid">'+Ls(s.title)+"</div>"+(s.sub?'<div class="ctx-sub">'+Ls(s.sub)+"</div>":"")+"</div>"),a.forEach(c=>{c.sep?n+='<div class="ctx-sep"></div>':n+='<button class="ctx-item'+(c.danger?" danger":"")+'" role="menuitem"><span class="ctx-icon">'+(c.icon||"")+"</span>"+Ls(c.label)+"</button>"}),V.innerHTML=n;const i=Array.from(V.querySelectorAll(".ctx-item")),l=a.filter(c=>!c.sep).map(c=>c.action||null);i.forEach((c,v)=>{l[v]&&c.addEventListener("click",()=>{Ht(),l[v]()})});const o=window.innerWidth,d=window.innerHeight,p=e.clientX,u=e.clientY;V.style.left="0px",V.style.top="-9999px",V.style.display="block",V.classList.add("open"),Ft=!0,requestAnimationFrame(()=>{const c=V.offsetWidth||200,v=V.offsetHeight||150,m=p+c>o-8?p-c:p,g=u+v>d-8?u-v:u;V.style.left=m+"px",V.style.top=g+"px"})}function Ls(e){return String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}const ut={};let ps="",ts={},ht=null,jt="asc",Gs=!1,Ra=null,re=new Set,ss=!1,yt=!1,Ot=parseInt(localStorage.getItem("fleet_sla_target")||"5",10)||5;function Ma(e){if(!e||e==="--")return null;const t=String(e).toLowerCase().trim();let s=0;const a=t.match(/(\d+)\s*d/);a&&(s+=parseInt(a[1],10));const n=t.match(/(\d+)\s*h/);if(n&&(s+=parseInt(n[1],10)/24),!a&&!n){const i=parseFloat(t);isNaN(i)||(s=i)}return s||null}let Ut=new Set(JSON.parse(localStorage.getItem("fleet_pinned_ids")||"[]"));function nl(){localStorage.setItem("fleet_pinned_ids",JSON.stringify([...Ut]))}const Gt=[{key:"_select",label:"☐",width:"30px",sortable:!1,isCheckbox:!0},{key:"_health",label:"",width:"24px",sortable:!0},{key:"bodyType",label:"Body Type",width:"100px",sortable:!0},{key:"equipmentId",label:"Unit ID",width:"110px",sortable:!0},{key:"_opSite",label:"OP / Site",width:"130px",sortable:!0},{key:"lifecycleState",label:"Status",width:"110px",sortable:!0},{key:"lifecycleReason",label:"Relay Status",width:"150px",sortable:!0},{key:"riskScore",label:"Score",width:"70px",sortable:!0},{key:"_wos",label:"WOs",width:"70px",sortable:!1},{key:"_pmDates",label:"PM Dates",width:"120px",sortable:!1},{key:"duration",label:"Duration",width:"90px",sortable:!0},{key:"vendor",label:"Vendor",width:"130px",sortable:!0},{key:"geofence",label:"Location",width:"110px",sortable:!0},{key:"sla",label:"SLA",width:"80px",sortable:!0}];function il(e){if(!e)return"";const t=e.toLowerCase();return t.includes("available")&&!t.includes("un")?"lc--available":t.includes("unavailable")?"lc--unavailable":t.includes("decommission")?"lc--decommissioned":t.includes("maintenance")?"lc--maintenance":""}function ll(e){if(!e)return'<span class="lc-pill lc-pill--unknown">—</span>';const t=e.toLowerCase();return t.includes("available")&&!t.includes("un")?'<span class="lc-pill lc-pill--available">Active</span>':t.includes("unavailable")?'<span class="lc-pill lc-pill--unavailable">Unavailable</span>':t.includes("decommission")?'<span class="lc-pill lc-pill--decommissioned">Decommissioned</span>':t.includes("maintenance")?'<span class="lc-pill lc-pill--maintenance">Maintenance</span>':'<span class="lc-pill lc-pill--unknown">'+e+"</span>"}function ol(e){if(!e)return"";const t=e.toLowerCase();let s="lcr-pill--default";return t.includes("offsite shop")||t.includes("shop repair")?s="lcr-pill--offsite":t.includes("damaged")&&t.includes("moderate")?s="lcr-pill--damaged":t.includes("expired")&&t.includes("inspection")?s="lcr-pill--expired":t.includes("accident")&&(s="lcr-pill--accident"),'<span class="lcr-pill '+s+'">'+e+"</span>"}function dl(e){const t=parseInt(e,10);return isNaN(t)?"":'<span class="badge badge--'+(t>=70?"risk-high":t>=40?"risk-medium":"risk-low")+'">'+t+"</span>"}function Qt(e,t){if(!t||t==="--")return"";const s=t.toLowerCase();let a,n=null;if(s==="overdue")a="pm-pill--overdue";else{const i=new Date(t+" "+new Date().getFullYear());if(isNaN(i.getTime()))a="pm-pill--ok";else{if(n=Math.round((i-new Date().setHours(0,0,0,0))/864e5),n>60)return"";a=n<=0?"pm-pill--overdue":n<=30?"pm-pill--soon":"pm-pill--ok"}}return'<span class="pm-pill '+a+'"><span class="pm-pill__lbl">'+e+'</span><span class="pm-pill__val">'+t+"</span></span>"}function cl(e){const t=ts[e.equipmentId]||{},s=parseInt(e.openUnplanned,10)||0,a=parseInt(e.openPlanned,10)||0,n=[Qt("B",e.pmB||"--"),Qt("X",e.pmX||"--"),Qt("DOT",e.dot||"--"),Qt("Q",e.quarterlyLift||"--")].filter(Boolean),i=n.length?'<div class="pm-pills-row">'+n.join("")+"</div>":"";return Object.assign({},e,{relayVendor:t.vendor||"",vendor:t.vendor||e.vendor||"",sla:t.sla||e.sla||"--",duration:t.workDuration||e.duration||e.workDuration||"--",_opSite:[e.operator,e.domicileSite].filter(Boolean).join(" / "),_wos:s+" / "+a,_pmDates:i})}function rl(e){let t=e.filter(s=>{if(Gs&&(s.riskScore||0)<70)return!1;for(const[a,n]of Object.entries(ut)){if(!n)continue;if(!(s[a]||"").toLowerCase().includes(n.toLowerCase()))return!1}if(ps){const a=ps.toLowerCase();if(!Gt.some(i=>(s[i.key]||"").toLowerCase().includes(a)))return!1}return!0});return ht&&(t=t.slice().sort((s,a)=>{const n=ht==="_health"?"_healthScore":ht,i=String(s[n]||""),l=String(a[n]||""),o=i.localeCompare(l,void 0,{numeric:!0});return jt==="asc"?o:-o})),t}let ue=null,Xs=null,Wt=null,us=null,ve=[];function $e(e){if(ve=e,!ue)return;const t=e.map(cl),s=rl(t);if(Xs&&(Xs.textContent=s.length+" / "+e.length+" units"),e.length===0){ue.innerHTML="",qa(!0);return}if(qa(!1),s.length===0){ue.innerHTML='<tr><td colspan="'+Gt.length+'" class="fleet-table__empty">No units match the current filters.</td></tr>';return}ue.innerHTML=s.map(n=>{const i=il(n.lifecycleState),l=n.equipmentId===Ra,o=Gt.map(c=>{if(c.isCheckbox){const f=re.has(n.equipmentId)?" checked":"";return'<td style="width:'+c.width+'"><input type="checkbox" class="fleet-cb fleet-row-cb" data-id="'+n.equipmentId+'"'+f+"></td>"}let v=n[c.key]||"",m=String(v),g=!1;if(c.key==="_health"){const f=n._healthTier||"good",w=n._healthScore||100;m='<span class="health-dot '+(f==="poor"?"health-dot--poor":f==="fair"?"health-dot--fair":"health-dot--good")+'" title="Data health: '+w+'%"></span>',g=!0}if(c.key==="riskScore"&&(m=dl(v),g=!0),c.key==="_pmDates"&&(m=v||"",g=!0),c.key==="equipmentId"){let f="";if(yt){const I=(n.lifecycleState||"").toLowerCase().includes("unavail")?Ma(n.duration||n.workDuration):null;if(I!==null){const H=I/Ot;H>=1?f='<span class="breach-flag breach-flag--over" title="SLA EXCEEDED ('+Math.round(I)+"d / "+Ot+'d)">🔴</span>':H>=.6&&(f='<span class="breach-flag breach-flag--warn" title="Breach risk ('+Math.round(I)+"d / "+Ot+'d)">⚠️</span>')}}const w='<span class="uid uid--white">'+v+"</span>"+f;n.assetUrl?m='<a class="eq-link" href="#" data-url="'+n.assetUrl+'">'+w+"</a>":m=w,g=!0}return(c.key==="assetType"||c.key==="bodyType"||c.key==="vehicleType")&&(m='<span class="cell--white">'+m+"</span>",g=!0),c.key==="lifecycleState"&&(m=ll(v),g=!0),c.key==="lifecycleReason"&&(m=ol(v),g=!0),c.key==="_wos"&&(m=(parseInt(n.openUnplanned,10)||0)+(parseInt(n.openPlanned,10)||0)>0?'<span class="wo-badge wo-badge--open">'+v+"</span>":'<span class="wo-badge wo-badge--none">'+v+"</span>",g=!0),"<td"+(g?"":' title="'+m.replace(/"/g,"&quot;")+'"')+">"+m+"</td>"}).join(""),d=l?" row--selected":"";let p="";if(ss){const c=parseInt(n.riskScore,10)||0,v=(c/100*.18).toFixed(3);p=' style="background:'+(c>=75?"rgba(255,123,114,"+v+")":c>=50?"rgba(255,166,87,"+v+")":c>0?"rgba(126,231,135,"+v+")":"transparent")+'"'}let u="";if(yt&&(n.lifecycleState||"").toLowerCase().includes("unavail")){const v=Ma(n.duration||n.workDuration);if(v!==null){const m=v/Ot;m>=1?u=" row--breached":m>=.6&&(u=" row--breach-risk")}}return'<tr class="fleet-table__row'+d+u+'"'+p+' data-id="'+n.equipmentId+'" data-lc="'+i+'">'+o+"</tr>"}).join(""),ue.querySelectorAll("a.eq-link, a.wr-link").forEach(n=>{n.addEventListener("click",i=>{i.stopPropagation(),i.preventDefault();const l=n.dataset.url;if(l)try{Xe.openUrl(l)}catch{}})}),ue.querySelectorAll(".fleet-table__row").forEach(n=>{n.addEventListener("click",()=>{const i=n.dataset.id,l=s.find(o=>o.equipmentId===i);l&&(Ra=i,ue.querySelectorAll(".fleet-table__row").forEach(o=>o.classList.toggle("row--selected",o.dataset.id===i)),r.emit("ui:unit-select",{unit:l}))}),n.addEventListener("contextmenu",i=>{const l=n.dataset.id,o=s.find(p=>p.equipmentId===l);if(!o)return;const d=Ut.has(l);al(i,{header:{title:o.equipmentId,sub:[o.manufacturer,o.assetType].filter(Boolean).join(" · ")},items:[{icon:d?"📌":"📍",label:d?"Unpin from Priority":"Pin to Priority",action:()=>{d?Ut.delete(l):Ut.add(l),nl(),r.emit("fleet:pins-updated",{pinnedIds:[...Ut]}),r.emit("ui:toast",{type:"info",message:d?"Unpinned "+l:"Pinned "+l,duration:1800})}},{sep:!0},{icon:"🔧",label:"Start Dealer WO",action:()=>{r.emit("ui:unit-select",{unit:o}),r.emit("ui:dealer-wo-request",{unit:o})}},{icon:"📋",label:"Copy Equipment ID",action:()=>{navigator.clipboard.writeText(o.equipmentId).catch(()=>{}),r.emit("ui:toast",{type:"info",message:"Copied: "+o.equipmentId,duration:1800})}},{icon:"🔍",label:"View Unit Detail",action:()=>{r.emit("ui:unit-select",{unit:o})}}]})})}),ue.querySelectorAll(".fleet-row-cb").forEach(n=>{n.addEventListener("change",i=>{i.stopPropagation();const l=n.dataset.id;n.checked?re.add(l):re.delete(l),vs()})});const a=document.getElementById("fleet-select-all");a&&a.addEventListener("change",()=>{a.checked?s.forEach(n=>re.add(n.equipmentId)):re.clear(),ue.querySelectorAll(".fleet-row-cb").forEach(n=>{n.checked=a.checked}),vs()}),pl()}function pl(){us&&us.querySelectorAll("th.sortable").forEach(e=>{e.classList.remove("sort-asc","sort-desc"),e.dataset.key===ht&&e.classList.add(jt==="asc"?"sort-asc":"sort-desc")})}let je=null;function qa(e){Wt&&(e?(je||(je=document.createElement("div"),je.className="fleet-empty",je.innerHTML='<p>No fleet data yet.</p><button id="fleet-sync-now" class="detail-panel__btn">Sync Now</button>',Wt.appendChild(je),document.getElementById("fleet-sync-now").addEventListener("click",()=>{r.emit("ui:toast",{type:"info",message:"Sync triggered...",duration:2e3}),fa(async()=>{const{fleet:t}=await Promise.resolve().then(()=>ua);return{fleet:t}},void 0,import.meta.url).then(({fleet:t})=>t.forceSync()).catch(()=>{})})),je.style.display="flex"):je&&(je.style.display="none"))}function Oa(e){fa(async()=>{const{relay:t}=await Promise.resolve().then(()=>ua);return{relay:t}},void 0,import.meta.url).then(({relay:t})=>{t.getCache().then(s=>{ts=s&&s.units?s.units:{},$e(e)}).catch(()=>{ts={},$e(e)})}).catch(()=>{ts={},$e(e)})}function ul(e){const t=document.createElement("div");t.id="view-fleet",t.className="view view--fleet";const s=Gt.map(d=>d.isCheckbox?'<th style="width:'+d.width+'"><input type="checkbox" id="fleet-select-all" class="fleet-cb" title="Select all"></th>':'<th class="sortable" data-key="'+d.key+'" style="width:'+d.width+'">'+d.label+"</th>").join("");t.innerHTML=`
    <div id="fleet-table-wrap" class="fleet-table-wrap">
      <div class="fleet-table-meta">
        <span id="fleet-count" class="fleet-table__count">Loading...</span>
        <button id="fleet-heatmap-toggle" class="fleet-heatmap-btn" title="Toggle Risk Heatmap">🌡️ Heatmap</button>
        <button id="fleet-breach-toggle" class="fleet-breach-btn" title="Toggle SLA Breach Forecast">⚠️ Breach</button>
        <button id="fleet-export-csv" class="fleet-export-btn" title="Export to CSV">📥 CSV</button>
        <button id="fleet-export-xlsx" class="fleet-export-btn fleet-export-btn--xl" title="Export to Excel">📊 Excel</button>
      </div>
      <div class="fleet-table-scroll">
        <table class="fleet-table">
          <thead id="fleet-thead">
            <tr>${s}</tr>
          </thead>
          <tbody id="fleet-tbody">
            <tr><td colspan="${Gt.length}" class="fleet-table__empty">
              Waiting for fleet data...
            </td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `,e.appendChild(t),ue=document.getElementById("fleet-tbody"),Xs=document.getElementById("fleet-count"),Wt=document.getElementById("fleet-table-wrap"),us=document.getElementById("fleet-thead"),us.querySelectorAll("th.sortable").forEach(d=>{d.addEventListener("click",()=>{const p=d.dataset.key;ht===p?jt=jt==="asc"?"desc":"asc":(ht=p,jt="asc"),$e(ve)})});const a=document.getElementById("fleet-heatmap-toggle");a&&a.addEventListener("click",()=>{ss=!ss,a.classList.toggle("active",ss),$e(ve)});const n=document.getElementById("fleet-breach-toggle");n&&n.addEventListener("click",()=>{yt=!yt,n.classList.toggle("active",yt),$e(ve)}),r.on("settings:sla-target",({days:d})=>{ml(d)});const i=document.getElementById("fleet-export-csv");i&&i.addEventListener("click",()=>yn());const l=document.getElementById("fleet-export-xlsx");l&&l.addEventListener("click",async()=>{if(!ve||ve.length===0){r.emit("ui:toast",{type:"warning",message:"No data to export",duration:2e3});return}l.disabled=!0,l.textContent="...";try{const d=await te.exportExcel({rows:ve,columns:Js});d&&d.ok&&r.emit("ui:toast",{type:"success",message:`Excel saved: ${d.filename}`,duration:3e3})}catch{r.emit("ui:toast",{type:"error",message:"Excel export failed",duration:2500})}l.disabled=!1,l.textContent="📊 Excel"}),r.on("state:fleet",d=>{const p=d.rows||[];Oa(p)}),r.on("state:sync",d=>{Wt&&Wt.classList.toggle("syncing",!!d.inProgress)}),r.on("ui:filter-change",({field:d,value:p})=>{p?ut[d]=p:delete ut[d],$e(ve)}),r.on("ui:search",({query:d})=>{ps=d,$e(ve)}),r.on("ui:quick-filter",({filter:d})=>{Object.keys(ut).forEach(u=>delete ut[u]),ps="";const p=document.getElementById("tb-search");p&&(p.value=""),d==="all"||(d==="offsite"?ut.lifecycleReason="offsite":d==="high-risk"&&(Gs=!0)),d!=="high-risk"&&(Gs=!1),$e(ve)}),r.on("navigate:unit",d=>{const p=(E.slice("fleet").rows||[]).find(u=>u.equipmentId===d);p&&r.emit("ui:unit-select",{unit:p})});const o=E.slice("fleet");o.rows&&o.rows.length&&Oa(o.rows)}function vs(){let e=document.getElementById("fleet-bulk-bar");const t=re.size;if(t===0){e&&(e.style.display="none");return}if(!e){e=document.createElement("div"),e.id="fleet-bulk-bar",e.className="fleet-bulk-bar";const s=document.getElementById("fleet-table-wrap");s&&s.prepend(e)}e.style.display="flex",e.innerHTML=`
    <span class="bulk-count">${t} unit${t>1?"s":""} selected</span>
    <button class="bulk-btn bulk-btn--relay" id="bulk-relay">🔄 Bulk Relay Change</button>
    <button class="bulk-btn bulk-btn--export" id="bulk-export-csv">📥 Export Selected</button>
    <button class="bulk-btn bulk-btn--clear" id="bulk-clear">✕ Clear</button>
  `,document.getElementById("bulk-relay").addEventListener("click",()=>{vl()}),document.getElementById("bulk-export-csv").addEventListener("click",()=>{yn(!0)}),document.getElementById("bulk-clear").addEventListener("click",()=>{re.clear(),ue.querySelectorAll(".fleet-row-cb").forEach(a=>{a.checked=!1});const s=document.getElementById("fleet-select-all");s&&(s.checked=!1),vs()})}function vl(){const e=re.size;if(e===0)return;const t=document.getElementById("bulk-relay-modal");t&&t.remove();const s=document.createElement("div");s.id="bulk-relay-modal",s.className="bulk-modal-overlay",s.innerHTML=`
    <div class="bulk-modal">
      <div class="bulk-modal__header">
        <span class="bulk-modal__icon">🔄</span>
        <span class="bulk-modal__title">Bulk Relay Change</span>
        <button class="bulk-modal__close" id="bulk-modal-close">✕</button>
      </div>
      <div class="bulk-modal__body">
        <p class="bulk-modal__desc">Change relay status for <strong>${e}</strong> selected unit${e>1?"s":""}:</p>
        <div class="bulk-modal__units">${[...re].slice(0,8).join(", ")}${e>8?" + "+(e-8)+" more":""}</div>
        <div class="bulk-modal__field">
          <label class="bulk-modal__label">New Relay Status</label>
          <select id="bulk-relay-status" class="bulk-modal__select">
            <option value="">— Select Status —</option>
            <option value="Available">Available</option>
            <option value="Unavailable - Scheduled">Unavailable - Scheduled</option>
            <option value="Unavailable - Unscheduled">Unavailable - Unscheduled</option>
            <option value="In Progress">In Progress</option>
            <option value="Pending Parts">Pending Parts</option>
            <option value="Ready for Pickup">Ready for Pickup</option>
            <option value="Completed">Completed</option>
          </select>
        </div>
        <div class="bulk-modal__field">
          <label class="bulk-modal__label">Reason / Note (optional)</label>
          <input type="text" id="bulk-relay-reason" class="bulk-modal__input" placeholder="e.g. EOD fleet flip, PM complete...">
        </div>
      </div>
      <div class="bulk-modal__footer">
        <button class="bulk-modal__cancel" id="bulk-modal-cancel">Cancel</button>
        <button class="bulk-modal__submit" id="bulk-modal-submit">Apply to ${e} Units</button>
      </div>
    </div>
  `,document.body.appendChild(s);const a=()=>s.remove();document.getElementById("bulk-modal-close").addEventListener("click",a),document.getElementById("bulk-modal-cancel").addEventListener("click",a),s.addEventListener("click",n=>{n.target===s&&a()}),document.getElementById("bulk-modal-submit").addEventListener("click",async()=>{const n=document.getElementById("bulk-relay-status").value,i=document.getElementById("bulk-relay-reason").value.trim();if(!n){r.emit("ui:toast",{type:"warning",message:"Select a relay status",duration:2e3});return}const l=document.getElementById("bulk-modal-submit");l.disabled=!0,l.textContent="Processing...";const o=[...re];let d=0,p=0;for(const c of o)try{await te.execute({type:"flip_state",unitId:c,unit:c,data:{targetState:n,reason:i}}),d++}catch{p++}a(),re.clear(),ue.querySelectorAll(".fleet-row-cb").forEach(c=>{c.checked=!1});const u=document.getElementById("fleet-select-all");u&&(u.checked=!1),vs(),r.emit("ui:toast",{type:p===0?"success":"warning",message:`Bulk relay: ${d} queued${p>0?", "+p+" failed":""} — status: ${n}`,duration:3500})})}const Js=[{key:"equipmentId",header:"Unit ID"},{key:"bodyType",header:"Body Type"},{key:"operator",header:"Operator"},{key:"domicileSite",header:"Domicile"},{key:"lifecycleState",header:"Lifecycle State"},{key:"lifecycleReason",header:"Lifecycle Reason"},{key:"riskScore",header:"Risk Score"},{key:"vendor",header:"Vendor"},{key:"duration",header:"Duration"},{key:"manufacturer",header:"Make"},{key:"fuelType",header:"Fuel Type"},{key:"geofence",header:"Geofence"},{key:"openUnplanned",header:"Open Unplanned WRs"},{key:"openPlanned",header:"Open Planned WRs"},{key:"dueDate",header:"PM Due Dates"},{key:"issueSummary",header:"Issue Summary"},{key:"savedRepairStatus",header:"Repair Status"},{key:"savedPrimaryComponent",header:"Primary Component"}];function yn(e=!1){let t=ve;if(e&&re.size>0&&(t=t.filter(u=>re.has(u.equipmentId))),!t||t.length===0){r.emit("ui:toast",{type:"warning",message:"No data to export",duration:2e3});return}const s=u=>{const c=String(u||"").replace(/"/g,'""');return c.includes(",")||c.includes('"')||c.includes(`
`)?'"'+c+'"':c},a=Js.map(u=>s(u.header)).join(","),n=t.map(u=>Js.map(c=>s(u[c.key]||"")).join(",")),i=a+`
`+n.join(`
`),l=new Blob([i],{type:"text/csv;charset=utf-8;"}),o=URL.createObjectURL(l),d=document.createElement("a"),p=new Date().toISOString().slice(0,10);d.href=o,d.download=`fleet-export-${p}.csv`,d.style.display="none",document.body.appendChild(d),d.click(),setTimeout(()=>{document.body.removeChild(d),URL.revokeObjectURL(o)},200),r.emit("ui:toast",{type:"success",message:`Exported ${t.length} units to CSV`,duration:2500})}function ml(e){const t=parseInt(e,10);t&&t>0&&t<=30&&(Ot=t,localStorage.setItem("fleet_sla_target",String(t)),yt&&$e(ve))}const fl=["COX","AMERIT","Volvo (ASIST)","Kenworth (PACCAR)","Peterbilt (PACCAR)","KWNE (Kenworth NE)","Freightliner (DAIMLER)","Cummins","TA","Velociti","FleetNet (FLEETNET)","Ryder (RENTAL)","Penske (RENTAL)","GOODYEAR","KOONER"],gl=["DEA - Asset Shortage","Safety","Compliance","Customer Impact","Regulatory","Other"],bl=["ENGINE","BRAKES","TIRES/WHEELS","ELECTRICAL","HVAC","FRAME/BODY","SUSPENSION","TRANSMISSION","FUEL SYSTEM","EXHAUST"];let de=null,be=null,ga=1,le=null;const Lt=e=>String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"),Ks=e=>String(e||"").replace(/"/g,"&quot;").replace(/'/g,"&#39;"),C=e=>document.getElementById(e);function hl(e){const t=[["PM-B",e.pmB],["PM-X",e.pmX],["DOT",e.dot],["Qtrly",e.quarterlyLift]].filter(([,s])=>s&&s!=="--").map(([s,a])=>`<span class="wr-pm-pill"><span class="wr-pm-label">${s}</span><span class="wr-pm-val">${Lt(a)}</span></span>`).join("");return t?`<div class="wr-pm-banner" id="wr-pm-banner">${t}</div>`:""}function yl(e){const t=(e.insightsList||[]).slice(0,3).map(s=>`<li class="wr-insight-item">${Lt(typeof s=="object"?s.summary||s.text||"":s)}</li>`).join("");return t?`<div class="wr-insights-strip"><span class="wr-insights-label">Uptake:</span><ul class="wr-insights-list">${t}</ul></div>`:""}function wl(e){if(!e)return"";const t=e>=75?"HIGH":e>=50?"MEDIUM":"LOW";return`<span class="badge badge--risk-${t.toLowerCase()}">${t}</span>`}function wn(e,t,s){return`
    <div class="wr-area-row" id="wr-area-row-${e}">
      <input class="settings__input wr-area-input" id="wr-area-${e}" type="text"
        placeholder="Area" value="${Ks(t)}" list="wr-area-datalist" />
      <input class="settings__input wr-area-input" id="wr-sub-${e}" type="text"
        placeholder="Subcategory" value="${Ks(s)}" />
      <button class="wr-area-remove" data-idx="${e}" title="Remove">×</button>
    </div>`}function _l(e){return`
<div class="wr-modal" id="wr-modal-box" role="dialog" aria-modal="true" aria-labelledby="wr-modal-title">

  <!-- Header -->
  <div class="wr-modal__header">
    <div class="wr-modal__title-row">
      <span id="wr-modal-title" class="wr-modal__title">Create Work Request</span>
      <span class="wr-modal__unit-id">${Lt(e.id||e.equipmentId||"")}</span>
      ${wl(e.riskScore)}
    </div>
    <button id="wr-close" class="wr-modal__close" aria-label="Close">×</button>
  </div>

  ${hl(e)}
  ${yl(e)}

  <!-- Body -->
  <div class="wr-modal__body">

    <!-- Work Details -->
    <div class="wr-section">
      <div class="wr-section__title">Work Details</div>
      <label class="settings-label">WR Title
        <input id="wr-title" class="settings__input" type="text"
          placeholder="Brief description of the issue"
          value="${Ks(e.pmStatus||e.issueDetails||"")}" />
      </label>
      <label class="settings-label" style="margin-top:6px">Issue Description
        <textarea id="wr-issue" class="settings__textarea" rows="3"
          placeholder="Full defect / complaint details...">${Lt(e.issueDetails||e.pmStatus||"")}</textarea>
      </label>
    </div>

    <!-- Vendor & Urgency -->
    <div class="wr-section">
      <div class="wr-section__title">Vendor &amp; Urgency</div>
      <div class="wr-two-col">
        <label class="settings-label">Vendor
          <select id="wr-vendor" class="settings__select">
            <option value="">-- Select vendor --</option>
            ${fl.map(t=>`<option value="${t}">${t}</option>`).join("")}
          </select>
        </label>
        <label class="settings-label settings-label--inline" style="align-self:flex-end;padding-bottom:6px">
          <input id="wr-urgent" type="checkbox" />
          Urgent
        </label>
      </div>
      <div id="wr-urgency-reason-wrap" style="display:none;margin-top:6px">
        <label class="settings-label">Urgency reason
          <select id="wr-urgency-reason" class="settings__select">
            ${gl.map(t=>`<option value="${t}">${t}</option>`).join("")}
          </select>
        </label>
      </div>
    </div>

    <!-- Component Areas -->
    <div class="wr-section">
      <div class="wr-section__title">
        Component Areas
        <span class="wr-section__hint">up to 4 pairs</span>
      </div>
      <datalist id="wr-area-datalist">
        ${bl.map(t=>`<option value="${t}">`).join("")}
      </datalist>
      <div id="wr-area-rows">${wn(0,"","")}</div>
      <button id="wr-add-area" class="detail-panel__btn detail-panel__btn--secondary" style="margin-top:6px">+ Add area</button>
    </div>

    <!-- Contact -->
    <div class="wr-section">
      <div class="wr-section__title">Contact</div>
      <div class="wr-two-col">
        <label class="settings-label">Contact name
          <input id="wr-contact-name"  class="settings__input" type="text" placeholder="Driver / dispatcher name" />
        </label>
        <label class="settings-label">Phone
          <input id="wr-contact-phone" class="settings__input" type="tel"  placeholder="1-555-000-0000" />
        </label>
      </div>
    </div>

    <!-- Comments -->
    <div class="wr-section">
      <div class="wr-section__title">Comments</div>
      <label class="settings-label">
        <textarea id="wr-comments" class="settings__textarea" rows="2"
          placeholder="Additional notes for the vendor..."></textarea>
      </label>
      <label class="settings-label settings-label--inline" style="margin-top:4px">
        <input id="wr-internal" type="checkbox" />
        Internal only (not shared with vendor)
      </label>
    </div>

    <!-- Optional -->
    <div class="wr-section">
      <div class="wr-section__title">
        Optional
        <button id="wr-toggle-optional" class="wr-optional-toggle">Show</button>
      </div>
      <div id="wr-optional-fields" style="display:none">
        <div class="wr-two-col" style="margin-top:4px">
          <label class="settings-label">ARC Claim #
            <input id="wr-arc" class="settings__input" type="text" placeholder="ARC-XXXXX" />
          </label>
          <label class="settings-label">SIM #
            <input id="wr-sim" class="settings__input" type="text" placeholder="SIM-XXXXXXXX" />
          </label>
        </div>
      </div>
    </div>

    <!-- Screenshot -->
    <div class="wr-section">
      <div class="wr-section__title">Screenshot Attachment</div>
      <div class="wr-screenshot-row">
        <button id="wr-attach-screenshot" class="detail-panel__btn detail-panel__btn--secondary">Attach latest Uptake screenshot</button>
        <span id="wr-screenshot-label" class="wr-screenshot-label">None</span>
      </div>
    </div>

    <!-- Progress log -->
    <div id="wr-progress-wrap" class="wr-progress-wrap" style="display:none">
      <div class="wr-section__title">Progress</div>
      <div id="wr-progress-log" class="wr-progress-log"></div>
    </div>

    <!-- Result -->
    <div id="wr-result" class="wr-result" style="display:none"></div>

  </div><!-- /body -->

  <!-- Footer -->
  <div class="wr-modal__footer">
    <button id="wr-autofill-fallback" class="detail-panel__btn detail-panel__btn--secondary"
      title="Open AAP browser window with payload auto-filled">Open in AAP (autofill)</button>
    <div class="wr-footer-right">
      <button id="wr-cancel" class="detail-panel__btn detail-panel__btn--secondary">Cancel</button>
      <button id="wr-submit" class="detail-panel__btn wr-submit-btn">Submit WR</button>
    </div>
  </div>

</div>`}function Ys(){const e=[];for(let a=0;a<4;a++){const n=C("wr-area-"+a),i=C("wr-sub-"+a);if(!n&&!i)continue;const l=(n&&n.value||"").trim(),o=(i&&i.value||"").trim();(l||o)&&e.push({area:l,subcategory:o})}const t=C("wr-attach-screenshot"),s=t&&t._dataUrl||null;return{unit:be.id||be.equipmentId||"",title:(C("wr-title").value||"").trim(),issue:(C("wr-issue").value||"").trim(),vendor:(C("wr-vendor").value||"").trim(),urgent:C("wr-urgent").checked?"Yes":"No",urgencyReason:C("wr-urgent").checked&&C("wr-urgency-reason").value||"",areaPairs:e,contactName:(C("wr-contact-name").value||"").trim(),contactPhone:(C("wr-contact-phone").value||"").trim(),comments:(C("wr-comments").value||"").trim(),shareWith:C("wr-internal").checked?"internal":"all",arcClaim:(C("wr-arc").value||"").trim()||null,simNumber:(C("wr-sim").value||"").trim()||null,screenshotDataUrl:s,domicile:be.site||be.domicileSite||""}}function kl(e){const t=C("wr-progress-wrap"),s=C("wr-progress-log");if(!s)return;t&&(t.style.display="");const a=document.createElement("div");a.className="wr-progress-line",a.textContent=e,s.appendChild(a),s.scrollTop=s.scrollHeight}function xl(){const e=C("wr-area-rows");e&&(e.addEventListener("click",t=>{const s=t.target.closest(".wr-area-remove");if(!s)return;const a=parseInt(s.dataset.idx,10),n=C("wr-area-row-"+a);if(n)if(e.querySelectorAll(".wr-area-row").length>1)n.remove();else{const i=C("wr-area-"+a);i&&(i.value="");const l=C("wr-sub-"+a);l&&(l.value="")}}),C("wr-add-area").addEventListener("click",()=>{if(e.querySelectorAll(".wr-area-row").length>=4){h.show("warn","Maximum 4 area pairs",2e3);return}e.insertAdjacentHTML("beforeend",wn(ga++,"",""))}))}function El(){const e=C("wr-urgent"),t=C("wr-urgency-reason-wrap");e.addEventListener("change",()=>{t.style.display=e.checked?"":"none"})}function Sl(){const e=C("wr-toggle-optional"),t=C("wr-optional-fields");e.addEventListener("click",()=>{const s=t.style.display==="none";t.style.display=s?"":"none",e.textContent=s?"Hide":"Show"})}function Ll(){const e=C("wr-attach-screenshot"),t=C("wr-screenshot-label");e.addEventListener("click",async()=>{e.disabled=!0,e.textContent="Loading...";try{const s=await Hs.getLatestScreenshot();if(s&&s.path){const a=await Hs.readAsDataUrl(s.path);a?(e._dataUrl=a,t.textContent=s.path.split(/[/\\]/).pop(),t.className="wr-screenshot-label wr-screenshot-label--attached",h.show("success","Screenshot attached",2e3)):h.show("warn","Could not read screenshot file",3e3)}else h.show("info","No Uptake screenshot found — run a sync first",4e3)}catch(s){h.show("error","Screenshot load failed: "+s.message)}finally{e.disabled=!1,e.textContent="Attach latest Uptake screenshot"}})}function Cl(){const e=C("wr-submit"),t=C("wr-autofill-fallback"),s=C("wr-result");e.addEventListener("click",async()=>{const a=Ys();if(!a.vendor){h.show("warn","Select a vendor",3e3);return}if(!a.title){h.show("warn","WR title required",3e3);return}e.disabled=!0,e.textContent="Submitting...",t.disabled=!0,s.style.display="none",C("wr-progress-wrap").style.display="",C("wr-progress-log").innerHTML="",le&&(le(),le=null),le=Xe.onWRProgress(kl);try{const n=await Xe.createWR(a,be);if(le&&(le(),le=null),n&&n.ok){const i=n.workRequestId||"";s.innerHTML=`
          <div class="wr-result--success">
            <span class="wr-result__icon">✓</span>
            <span>WR created — <strong>${Lt(i)}</strong></span>
            ${be.assetUrl?'<a href="#" id="wr-open-aap" class="wr-result__link">Open in AAP</a>':""}
          </div>`,s.style.display="";const l=C("wr-open-aap");l&&l.addEventListener("click",o=>{o.preventDefault(),Xe.openUrl(be.assetUrl)}),h.show("success","WR "+i+" created",6e3),setTimeout(()=>Nt(),4e3)}else Ua(n&&n.error||"Unknown error")}catch(n){le&&(le(),le=null),Ua(n.message)}finally{e.disabled=!1,e.textContent="Submit WR",t.disabled=!1}}),t.addEventListener("click",()=>_n(Ys()))}function Ua(e){const t=C("wr-result");if(!t)return;t.innerHTML=`
    <div class="wr-result--error">
      <span class="wr-result__icon">✗</span>
      <span>Submit failed: ${Lt(e)}</span>
      <button id="wr-fallback-from-error" class="detail-panel__btn detail-panel__btn--secondary">
        Try AAP autofill instead
      </button>
    </div>`,t.style.display="";const s=C("wr-fallback-from-error");s&&s.addEventListener("click",()=>_n(Ys()))}async function _n(e){if(!be||!be.assetUrl){h.show("warn","No AAP URL for this unit — run a scan first",4e3);return}try{await Xe.autofill(be.assetUrl,e),h.show("info","Opening AAP in autofill mode...",3e3)}catch(t){h.show("error","Autofill launch failed: "+t.message)}}function Nt(){le&&(le(),le=null),de&&de.parentNode&&de.parentNode.removeChild(de),de=null,be=null,ga=1}function Il(e){de&&Nt(),be=e,ga=1,de=document.createElement("div"),de.id="wr-modal-overlay",de.className="wr-modal-overlay",de.innerHTML=_l(e),document.body.appendChild(de),de.addEventListener("click",s=>{s.target===de&&Nt()}),C("wr-close").addEventListener("click",Nt),C("wr-cancel").addEventListener("click",Nt),xl(),El(),Sl(),Ll(),Cl();const t=(e.relayVendor||e.vendor||"").toUpperCase();if(t){const s=Array.from(C("wr-vendor").options).find(a=>a.value.toUpperCase().includes(t));s&&(C("wr-vendor").value=s.value)}setTimeout(()=>{const s=C("wr-title");s&&s.focus()},50)}let Y=null,Ct={};const ae=e=>document.getElementById(e),Ie=e=>String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"),Cs=e=>String(e||"").replace(/"/g,"&quot;").replace(/'/g,"&#39;"),$l={paccar:{label:"PACCAR",portal:"PACCAR Service Portal",cls:"paccar"},volvo:{label:"Volvo/ASIST",portal:"Volvo ASIST Portal",cls:"volvo"},amerit:{label:"Amerit",portal:"Amerit Fleet Solutions",cls:"amerit"},cummins:{label:"Cummins",portal:"Cummins Care Portal",cls:"cummins"},ta:{label:"TA Fleet",portal:"TA Fleet Services",cls:"ta"},velociti:{label:"Velociti",portal:"Velociti Services Portal",cls:"velociti"},fleetnet:{label:"FleetNet",portal:"FleetNet America Portal",cls:"fleetnet"},"fleet net":{label:"FleetNet",portal:"FleetNet America Portal",cls:"fleetnet"},goodyear:{label:"Goodyear",portal:"Goodyear Commercial Tire",cls:"goodyear"},freightliner:{label:"Freightliner",portal:"DTNA Parts Portal",cls:"unknown"},kenworth:{label:"Kenworth",portal:"Kenworth Owners Portal",cls:"unknown"},peterbilt:{label:"Peterbilt",portal:"Peterbilt Owners Portal",cls:"unknown"},mack:{label:"Mack Trucks",portal:"Mack Trucks Portal",cls:"unknown"},international:{label:"International",portal:"International Truck Dealers",cls:"unknown"},navistar:{label:"Navistar",portal:"International Truck Dealers",cls:"unknown"}};function Al(e){return $l[(e||"").toLowerCase()]||{label:e||"Unknown",portal:e?e+" Portal":"Vendor Portal",cls:"unknown"}}function Bl(e,t){const s=Al(e.vendor),a=!!e.portalUrl,n=!a&&!!t,i=e.isDuplicate?'<div class="vr-dup-banner"><span class="vr-dup-banner__icon">&#9888;</span><span>Possible duplicate &mdash; case <strong>'+Ie(e.caseNumber||"")+"</strong> may already exist."+(e.caseUrl?' <a class="vr-link" id="vr-dup-case-link" href="#">View case</a>':"")+"</span></div>":"",l=e._stubbed?'<span class="vr-stub-badge">STUB</span>':"";let o="";return a?o='<div class="vr-section"><div class="vr-section__title">Portal</div><div class="vr-portal-row"><span class="vr-portal-row__label">'+Ie(s.portal)+'</span><a id="vr-portal-link" href="#" class="vr-link vr-link--portal">Open portal window &#8599;</a></div><p class="vr-portal-hint">The vendor portal window is already open. Use this link if it was closed.</p></div>':n&&(o='<div class="vr-section"><div class="vr-section__title">Portal</div><div class="vr-portal-row"><span class="vr-portal-row__label">'+Ie(s.portal)+'</span><a id="vr-portal-link-ext" href="'+Cs(t)+'" target="_blank" rel="noopener noreferrer" class="vr-link vr-link--portal vr-link--external">Open '+Ie(s.label)+' portal &#8599;</a></div><p class="vr-portal-hint">Opens in your system browser. This is an informational link &mdash; form submission is manual.</p></div>'),'<div class="vr-modal" id="vr-modal-box" role="dialog" aria-modal="true" aria-labelledby="vr-modal-title"><div class="vr-modal__header"><div class="vr-modal__title-row"><span class="vr-badge vr-badge--'+Cs(s.cls)+'">'+Ie(s.label)+'</span><span id="vr-modal-title" class="vr-modal__title">Review &amp; Approve Dealer WO</span>'+l+'</div><button id="vr-close" class="vr-modal__close" aria-label="Close">&times;</button></div><div class="vr-modal__body"><div class="vr-unit-row"><span class="vr-unit-row__label">Unit</span><span class="vr-unit-row__value">'+Ie(e.unit)+'</span><span class="vr-unit-row__wfid">'+Ie(e.workflowId)+"</span></div>"+i+'<div class="vr-section"><div class="vr-section__title">Instructions</div><p class="vr-instructions">'+Ie(e.instructions||"Review the pre-filled vendor portal. When satisfied, click Approve & Submit.")+"</p></div>"+o+'<div class="vr-section"><div class="vr-section__title">Alt ID <span class="vr-section__hint">relay reference &mdash; correct if needed</span></div><input id="vr-alt-id" class="vr-input" type="text" value="'+Cs(e.altId||"")+'" placeholder="Relay WO / reference ID" /></div><div id="vr-progress-wrap" class="vr-progress-wrap" style="display:none"><div class="vr-section__title">Progress</div><div id="vr-progress-log" class="vr-progress-log"></div></div><div id="vr-result" class="vr-result" style="display:none"></div></div><div class="vr-modal__footer"><div class="vr-footer-left"><span class="vr-footer-hint">Approve sends the pre-filled form to '+Ie(s.portal)+'.</span></div><div class="vr-footer-right"><button id="vr-cancel-btn" class="detail-panel__btn detail-panel__btn--secondary">Cancel Workflow</button><button id="vr-approve-btn" class="detail-panel__btn vr-approve-btn">Approve &amp; Submit</button></div></div></div>'}function Is(e,t){const s=ae("vr-progress-wrap"),a=ae("vr-progress-log");if(!a)return;s&&(s.style.display="");const n=document.createElement("div");n.className="vr-progress-line"+(t?" vr-progress-line--"+t:""),n.textContent=e,a.appendChild(n),a.scrollTop=a.scrollHeight}function Tl(e){const t=ae("vr-portal-link");t&&e.portalUrl&&t.addEventListener("click",a=>{a.preventDefault(),ne.openPortalUrl&&ne.openPortalUrl(e.portalUrl).catch(()=>{})});const s=ae("vr-dup-case-link");s&&e.caseUrl&&s.addEventListener("click",a=>{a.preventDefault(),ne.openPortalUrl&&ne.openPortalUrl(e.caseUrl).catch(()=>{})})}function Dl(e){const t=ae("vr-approve-btn"),s=ae("vr-cancel-btn");t&&t.addEventListener("click",async()=>{const a=ae("vr-alt-id"),n=a&&a.value.trim()||e.altId||"";t.disabled=!0,t.textContent="Submitting...",s&&(s.disabled=!0),Is("Approving -- sending to vendor portal...");try{const i=await ne.approve(e.workflowId,n);if(i&&i.ok===!1)throw new Error(i.error||"approve returned ok:false");Is("Approved -- workflow continuing...","ok");const l=ae("vr-result");l&&(l.innerHTML='<div class="vr-result--success"><span class="vr-result__icon">&#10003;</span><span>Approved &mdash; vendor portal is submitting...</span></div>',l.style.display=""),t.textContent="Approved",setTimeout(()=>{ba(),Ct.onApprove&&Ct.onApprove({workflowId:e.workflowId,altId:n})},1400)}catch(i){Is("Approve failed: "+i.message,"err");const l=ae("vr-result");l&&(l.innerHTML='<div class="vr-result--error"><span class="vr-result__icon">&#10007;</span><span>Approve failed: '+Ie(i.message)+"</span></div>",l.style.display=""),t.disabled=!1,t.textContent="Retry Approve",s&&(s.disabled=!1),h.show("error","Approve failed: "+i.message)}})}function Pl(e){const t=ae("vr-cancel-btn");t&&t.addEventListener("click",()=>as(e))}async function as(e){const t=ae("vr-cancel-btn"),s=ae("vr-approve-btn");t&&(t.disabled=!0,t.textContent="Cancelling..."),s&&(s.disabled=!0);try{await ne.cancel(e.workflowId),h.show("info","Dealer WO workflow cancelled")}catch(a){h.show("error","Cancel error: "+a.message)}finally{ba(),Ct.onCancel&&Ct.onCancel({workflowId:e.workflowId})}}function ba(){Y&&(Y._keyHandler&&document.removeEventListener("keydown",Y._keyHandler),Y.parentNode&&Y.parentNode.removeChild(Y)),Y=null,Ct={}}async function Rl(e,t={}){Y&&ba(),Ct=t;let s="";if(!e.portalUrl)try{s=await ln(e.vendor||"")}catch{}Y=document.createElement("div"),Y.id="vr-modal-overlay",Y.className="vr-modal-overlay",Y.innerHTML=Bl(e,s),document.body.appendChild(Y),Y.addEventListener("click",n=>{n.target===Y&&as(e)});const a=ae("vr-close");a&&a.addEventListener("click",()=>as(e)),Y._keyHandler=n=>{n.key==="Escape"&&as(e)},document.addEventListener("keydown",Y._keyHandler),Tl(e),Dl(e),Pl(e),setTimeout(()=>{const n=ae("vr-alt-id");n&&n.focus()},60)}let U=null,Ee=null,kn=[];function $(e){return String(e||"").replace(/</g,"&lt;").replace(/>/g,"&gt;")}function Ml(e){return e==="pass"?"Ã¢Å“â€œ":e==="warn"?"Ã¢Å¡Â ":"Ã¢Å“â€”"}function ql(e){return e==="pass"?"pass":e==="warn"?"warn":"fail"}function Ol(e){const t=document.getElementById("dp-vendor-section");if(!t)return;const{eligible:s,vendor:a,warnings:n=[],blocking:i=[],checks:l={},existingWO:o}=e,p=["unit_data","vendor","lifecycle","offsite_match","relay_wo","mileage"].filter(x=>l[x]).map(x=>{const f=l[x];return'<div class="dp-vnd-check dp-vnd-check--'+ql(f.status)+'"><span class="dp-vnd-check__icon">'+Ml(f.status)+'</span><span class="dp-vnd-check__name">'+$(f.name||x)+'</span><span class="dp-vnd-check__detail">'+$(f.detail||"")+"</span></div>"}).join(""),u=i.length?'<div class="dp-vnd-blocking">'+i.map(x=>'<div class="dp-vnd-blocking__row">Ã¢Å“â€” '+$(x)+"</div>").join("")+"</div>":"",c=n.length?'<div class="dp-vnd-warnings">'+n.map(x=>'<div class="dp-vnd-warn-row">Ã¢Å¡Â  '+$(x)+"</div>").join("")+"</div>":"",v=o?'<div class="dp-vnd-existing"><span class="dp-vnd-existing__label">Existing case:</span> '+(o.url?'<a class="dp-vnd-link" href="'+$(o.url)+'" target="_blank" rel="noreferrer">'+$(o.title||o.caseNumber||"Open")+"</a>":"<span>"+$(o.title||o.caseNumber||"")+"</span>")+"</div>":"",m=a==="paccar"?"PACCAR / Kenworth / Peterbilt":a==="volvo"?"Volvo / ASIST":a||"Unknown",g=s?'<button id="dp-vnd-start" class="detail-panel__btn detail-panel__btn--vendor" data-vendor="'+$(a)+'">Start '+$(m)+" Portal</button>":'<div class="dp-vnd-blocked">Cannot start Dealer WO. Resolve errors above.</div>';t.innerHTML='<div class="dp-vnd-header"><span class="dp-vnd-badge dp-vnd-badge--'+$(a||"unknown")+'">'+$(m)+'</span><span class="dp-vnd-status dp-vnd-status--'+(s?"eligible":"blocked")+'">'+(s?"Eligible":"Blocked")+'</span></div><div class="dp-vnd-checks">'+p+"</div>"+u+c+v+'<div id="dp-vnd-actions" class="dp-vnd-actions">'+g+'</div><div id="dp-vnd-progress" class="dp-vnd-progress" style="display:none"></div>',s&&document.getElementById("dp-vnd-start").addEventListener("click",()=>Nl(e.unit||Ee,a))}function Pt(e){const t=document.getElementById("dp-vnd-progress");if(!t)return;t.style.display="block";const s=(e.step||"").includes("error")?"dp-vnd-step--error":(e.step||"").includes("complete")?"dp-vnd-step--done":"dp-vnd-step--active";t.innerHTML+='<div class="dp-vnd-step '+s+'"><span class="dp-vnd-step__ts">'+new Date(e.ts||Date.now()).toLocaleTimeString()+'</span><span class="dp-vnd-step__label">'+$(e.step||"")+"</span>"+(e.detail?'<span class="dp-vnd-step__detail">'+$(e.detail)+"</span>":"")+"</div>",t.scrollTop=t.scrollHeight}async function Ul(e,t){const s=t||{workflowId:e,unit:Ee&&(Ee.id||Ee.equipmentId)||""};await Rl(s,{onApprove:()=>{const a=document.getElementById("dp-vnd-actions");a&&(a.innerHTML='<span class="dp-vnd-step dp-vnd-step--active">Submitting...</span>')},onCancel:()=>{const a=document.getElementById("dp-vendor-section");a&&(a.dataset.workflowId="");const n=document.getElementById("dp-vnd-actions");if(n){n.innerHTML='<button id="dp-vnd-reinvest" class="detail-panel__btn detail-panel__btn--secondary">Re-check eligibility</button>';const i=document.getElementById("dp-vnd-reinvest");i&&i.addEventListener("click",()=>ws(Ee))}}})}async function Nl(e,t){try{const n=await te.suggestVendor(e).catch(()=>null);n&&n.vendor&&n.vendor.toLowerCase()!==t.toLowerCase()&&te.recordCorrection({unitId:e.equipmentId||e.id||"",field:"vendor",orchaSuggested:n.vendor,userChose:t,context:{domicile:e.domicileSite||"",vendor:t,component:e.savedPrimaryComponent||"",make:e.manufacturer||e.make||"",issue:e.issueSummary||""}}).catch(()=>{})}catch{}const s=document.getElementById("dp-vnd-start");s&&(s.disabled=!0,s.textContent="Starting...");const a=document.getElementById("dp-vnd-progress");a&&(a.style.display="block",a.innerHTML="");try{const n=t==="paccar"?ne.startPaccar:ne.startVolvo,{workflowId:i}=await n(e),l=document.getElementById("dp-vendor-section");l&&(l.dataset.workflowId=i),h.show("info","Dealer WO workflow started — waiting for portal...",3e3)}catch(n){h.show("error","Failed to start workflow: "+n.message),s&&(s.disabled=!1,s.textContent="Retry")}}let Qs=[];function zt(){Qs.forEach(e=>e()),Qs=[]}function Hl(e,t){const s=t.caseNumber||"",a=t.caseUrl||"",n=t.altId||"";let i='<div class="dp-vnd-complete-banner">';if(i+='<span class="dp-vnd-complete-icon">Ã¢Å“â€œ</span>',i+='<div class="dp-vnd-complete-body">',i+='<span class="dp-vnd-complete-label">Dealer WO created</span>',s&&(i+='<span class="dp-vnd-complete-sr">',i+='<span class="dp-vnd-complete-sr-num">'+$(s)+"</span>",i+='<button class="dp-vnd-copy-btn" data-copy="'+$(s)+'" title="Copy SR">Ã¢Â§â€°</button>',i+="</span>"),n&&n!==s&&(i+='<span class="dp-vnd-complete-altid">'+$(n)+'<button class="dp-vnd-copy-btn" data-copy="'+$(n)+'" title="Copy ID">Ã¢Â§â€°</button></span>'),a&&(i+='<a class="dp-vnd-complete-link" data-ext-url="'+$(a)+'" href="#">Open in portal Ã¢â€ â€”</a>'),i+="</div></div>",e.innerHTML=i,e.querySelectorAll(".dp-vnd-copy-btn").forEach(l=>{l.addEventListener("click",o=>{o.preventDefault(),navigator.clipboard.writeText(l.dataset.copy).catch(()=>{}),h.show("info","Copied",1800)})}),a){const l=e.querySelector(".dp-vnd-complete-link");l&&l.addEventListener("click",o=>{o.preventDefault(),window.files.openExternal(a).catch(()=>{})})}}function jl(e,t){const s=t.error||"Unknown error";let a='<div class="dp-vnd-error-banner">';a+='<span class="dp-vnd-error-icon">Ã¢Å“â€”</span>',a+='<div class="dp-vnd-error-body">',a+='<span class="dp-vnd-error-label">Workflow error</span>',a+='<span class="dp-vnd-error-msg">'+$(s)+"</span>",a+='<button id="dp-vnd-retry" class="detail-panel__btn detail-panel__btn--secondary dp-vnd-retry-btn">Retry</button>',a+="</div></div>",e.innerHTML=a;const n=e.querySelector("#dp-vnd-retry");n&&n.addEventListener("click",()=>ws(Ee))}function Wl(e){const t=Date.now()-e;return t<6e4?"just now":t<36e5?Math.floor(t/6e4)+"m ago":t<864e5?Math.floor(t/36e5)+"h ago":Math.floor(t/864e5)+"d ago"}function $s(e){const t=document.getElementById("dp-vnd-history-strip");if(!t)return;const s=(E.slice("vendor").history||{})[e]||[];if(!s.length){t.innerHTML="";return}const a=s.map(function(n,i){const l=n.outcome==="complete",o=l?n.caseNumber||"WO":n.error?n.error.slice(0,32):"error",d=Wl(n.ts||0),p=n.vendor==="paccar"?"dp-vnd-badge--paccar":n.vendor==="volvo"?"dp-vnd-badge--volvo":"dp-vnd-badge--unknown";return'<button class="dp-vnd-hist-chip '+(l?"dp-vnd-hist-chip--ok":"dp-vnd-hist-chip--err")+' " data-idx="'+i+'"><span class="dp-vnd-hist-chip__icon">'+(l?"Ã¢Å“â€œ":"Ã¢Å“â€”")+'</span><span class="dp-vnd-hist-chip__vendor dp-vnd-badge '+p+'"></span><span class="dp-vnd-hist-chip__label">'+$(o)+'</span><span class="dp-vnd-hist-chip__rel">'+$(d)+"</span></button>"});t.innerHTML='<div class="dp-vnd-hist-label">History</div>'+a.join(""),t.querySelectorAll(".dp-vnd-hist-chip").forEach(function(n){n.addEventListener("click",function(i){i.stopPropagation();const l=parseInt(n.dataset.idx,10),o=s[l];if(!o)return;const d=t.querySelector(".dp-vnd-hist-tooltip");d&&d.remove();const p=document.createElement("div");p.className="dp-vnd-hist-tooltip";const u=o.outcome==="complete";let c="";if(u?(c+='<span class="dp-vnd-hist-tt__sr">'+$(o.caseNumber||"Ã¢â‚¬â€")+"</span>",o.caseUrl&&(c+='<a class="dp-vnd-hist-tt__link" data-url="'+$(o.caseUrl)+'" href="#">Open Ã¢â€ â€”</a>'),o.dealerName&&(c+='<span class="dp-vnd-hist-tt__dealer">'+$(o.dealerName)+"</span>")):c+='<span class="dp-vnd-hist-tt__err">'+$(o.error||"unknown")+"</span>",p.innerHTML=c,n.appendChild(p),o.caseUrl){const v=p.querySelector(".dp-vnd-hist-tt__link");v&&v.addEventListener("click",function(m){m.preventDefault(),window.files.openExternal(o.caseUrl).catch(function(){})})}document.addEventListener("click",function v(m){!p.contains(m.target)&&m.target!==n&&(p.remove(),document.removeEventListener("click",v))},!0)})})}function zl(e){const t=document.getElementById("dp-vnd-ai-suggest");if(!t)return;t.innerHTML='<div class="dp-vnd-ai-card"><div class="dp-vnd-ai-card__header"><span class="dp-vnd-ai-card__icon">🤖</span><span class="dp-vnd-ai-card__title">Orcha Vendor Intelligence</span><button id="dp-vnd-ai-run" class="dp-vnd-ai-card__btn">Analyze</button></div><div id="dp-vnd-ai-body" class="dp-vnd-ai-card__body"><span class="dp-vnd-ai-card__hint">Click Analyze for AI-powered vendor recommendation</span></div></div>';const s=document.getElementById("dp-vnd-ai-run");s&&s.addEventListener("click",async()=>{const a=document.getElementById("dp-vnd-ai-body");s.disabled=!0,s.textContent="…",a.innerHTML='<span class="dp-vnd-ai-card__loading">⚡ Orcha analyzing vendor options…</span>';try{const n=await te.suggestVendor(e),i=n&&(n.vendor||n.recommendation||n.text||""),l=n&&n.confidence?n.confidence:null,o=n&&(n.reason||n.reasoning||""),d=n&&n.alternatives?n.alternatives:[];let p="";i&&(p+='<div class="dp-vnd-ai-rec">',p+='<span class="dp-vnd-ai-rec__label">Recommended:</span>',p+='<span class="dp-vnd-ai-rec__vendor">'+$(i)+"</span>",l&&(p+='<span class="dp-vnd-ai-rec__conf">'+l+"% confidence</span>"),p+="</div>"),o&&(p+='<div class="dp-vnd-ai-reasoning">'+$(o)+"</div>"),d.length&&(p+='<div class="dp-vnd-ai-alts"><span class="dp-vnd-ai-alts__label">Alternatives:</span> '+d.map(u=>'<span class="dp-vnd-ai-alt-pill">'+$(u)+"</span>").join(" ")+"</div>"),p||(p='<span class="dp-vnd-ai-card__hint">No recommendation available for this unit.</span>'),a.innerHTML=p}catch(n){a.innerHTML='<span class="dp-vnd-ai-card__error">'+$(n.message||"AI unavailable")+"</span>"}finally{s.disabled=!1,s.textContent="Re-analyze"}})}function ws(e){const t=document.getElementById("dp-vendor-section");t&&(zt(),zl(e),t.innerHTML='<p class="dp-empty">Checking eligibility...</p>',ne.investigate(e).then(s=>{Ol(s),$s(e.equipmentId||e.id);const a=e.equipmentId||e.id||"";ne.getStatus().then(n=>{const l=(n&&n.active||[]).find(o=>o.unit===a);if(l&&t&&!t.dataset.workflowId){t.dataset.workflowId=l.workflowId;const o=document.getElementById("dp-vnd-progress");o&&(o.style.display="block"),Pt({vendor:l.vendor,step:l.step,ts:l.startedAt,detail:"Workflow reconnected (step: "+l.step+")"})}}).catch(()=>{}),Qs.push(r.on("vendor:progress",n=>{!t.dataset.workflowId||n.workflowId!==t.dataset.workflowId||Pt(n)}),r.on("vendor:review-ready",async n=>{!t.dataset.workflowId||n.workflowId!==t.dataset.workflowId||(Pt({...n,step:"review-ready",detail:"Portal ready. Review then approve."}),await Ul(t.dataset.workflowId,n))}),r.on("vendor:complete",n=>{if(!t.dataset.workflowId||n.workflowId!==t.dataset.workflowId)return;Pt({...n,step:"complete",detail:"Case: "+(n.caseNumber||"")});const i=document.getElementById("dp-vnd-actions");i&&Hl(i,n),$s(e.equipmentId||e.id),h.show("success","Dealer WO submitted successfully"),zt()}),r.on("vendor:error",n=>{if(!t.dataset.workflowId||n.workflowId!==t.dataset.workflowId)return;Pt({...n,step:"error",detail:n.error||"Unknown error"});const i=document.getElementById("dp-vnd-actions");h.show("error","Dealer WO error: "+(n.error||"unknown")),i&&jl(i,n),$s(e.equipmentId||e.id),zt()}))}).catch(s=>{t&&(t.innerHTML='<p class="dp-empty dp-empty--error">Investigation failed: '+$(s.message)+"</p>")}))}function S(e){return String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}function Vl(e){return e>=70?"red":e>=40?"org":"grn"}function Fl(e){const t=e.created;return t?Math.floor((Date.now()-new Date(t).getTime())/864e5):null}function Na(e){if(!e)return"";const t=Date.now()-new Date(e).getTime();return t<36e5?Math.floor(t/6e4)+"m ago":t<864e5?Math.floor(t/36e5)+"h ago":Math.floor(t/864e5)+"d ago"}function Ae(e){if(!e)return"";try{return new Date(e).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"2-digit"})}catch{return e}}function Gl(e){if(!e||typeof e!="string")return[];for(var t=e.split(`
`).map(function(P){return P.trim()}).filter(function(P){return P.length>0}),s=-1,d=0;d<t.length;d++)if(t[d]==="Conversation"||t[d]==="Comments can not be edited."){s=d;break}if(s===-1){var a=/^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*[-\u2013]\s*(.+)$/;return t.reduce(function(P,M){var _=M.match(a);if(_&&_[2]&&_[2].trim().length>3){var B=/amerit|freightliner|volvo|peterbilt|kenworth|ta truck|ta |tct|dealer|shop|penske|ryder|daimler|paccar|asist|navistar|international/i.test(_[2]);P.push({date:_[1],text:_[2].trim(),side:B?"vendor":"carrier"})}return P},[])}for(var n=/^((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4})\s+\d{1,2}:\d{2}(?:AM|PM)/i,i=/^(Work Request|Internal Only|Shared with|Enter Comments|DO NOT enter|Add Comment|Share Comment|Recipient|Comments can not|Conversation|Add Comment To|Share Comment With)$/i,l={Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12"},o=[],d=s+1;d<t.length;){var p=t[d];if(i.test(p)){d++;continue}var u=p.match(n);if(u){var c=u[1],v=c.replace(",","").split(/\s+/),m=l[v[0]]||"??",g=v[1].length<2?"0"+v[1]:v[1],x=m+"/"+g,f=[];for(d++;d<t.length;){var w=t[d];if(i.test(w)){d++;continue}if(n.test(w))break;if(w.length<25){for(var b=d+1;b<t.length&&i.test(t[b]);)b++;if(b<t.length&&n.test(t[b]))break}f.push(w),d++}var I=f.join(" ").trim();if(I.length>3){var H=/amerit|freightliner|volvo|peterbilt|kenworth|ta truck|ta |tct|dealer|shop|penske|ryder|daimler|paccar|asist|navistar|international|decisiv/i.test(I);o.push({date:x,text:I,side:H?"vendor":"carrier"})}}else d++}return o}function Xl(e){if(!e)return null;var t=String(e).match(/(\d+(?:\.\d+)?)/);return t?parseFloat(t[1]):null}function Jl(e){var t=e.created;if(!t)return"";var s=new Date(t).getTime();if(isNaN(s))return"";var a=Date.now(),n=Math.floor((a-s)/864e5),i=Xl(e.workDuration);if(!i){var l=n>14?"overdue":n>7?"warn":"ok";return'<div class="dp-etc-wrap"><div class="dp-etc-title"><span>Work Duration</span><span class="dp-etc-remain">'+n+'d elapsed (no ETC set)</span></div><div class="dp-etc-track"><div class="dp-etc-fill dp-etc-fill--'+l+'" style="width:100%"></div><div class="dp-etc-marker" style="left:97%"></div></div><div class="dp-etc-labels"><span>Started '+Ae(t)+"</span><span>Day "+n+"</span><span>Today "+Ae(a)+"</span></div></div>"}var o=s+i*864e5,d=Math.min(Math.round((a-s)/(o-s)*100),100),p=a>o,u=p?0:Math.ceil((o-a)/864e5),c=p?"overdue":d>75?"warn":"ok",v=p?'<span style="color:var(--red);font-weight:600">⚠ Overdue by '+Math.ceil((a-o)/864e5)+"d</span>":u+"d left of "+i+"d";return'<div class="dp-etc-wrap"><div class="dp-etc-title"><span>Work Duration</span><span class="dp-etc-remain">'+v+'</span></div><div class="dp-etc-track"><div class="dp-etc-fill dp-etc-fill--'+c+'" style="width:'+d+'%"></div><div class="dp-etc-marker" style="left:'+Math.min(d,97)+'%"></div></div><div class="dp-etc-labels"><span>Started '+Ae(t)+"</span><span>Day "+n+" / "+i+"</span><span>ETC "+Ae(o)+"</span></div></div>"}function Kl(e){var t=(e.lifecycleState||"").toLowerCase().includes("unavail"),s=parseInt(e.riskScore,10)||0,a=t?"unavailable":s>=60?"risk":"active",n=Fl(e),i=n>14?"dp-vital--red":n>7?"dp-vital--org":"dp-vital--grn",l=S(e.assetUrl||""),o=S(e.serviceUrl||e.savedOffsiteUrl||""),d=S(e.asistSrUrl||e.offsiteShopEventUrl||"");function p(x){var f=(x.assetType||"").trim().toLowerCase(),w=(x.bodyType||"").trim().toLowerCase();return f==="tractor"||w==="tractor"?w.includes("sleeper")?"Sleeper":"Day Cab":f==="standard"||w==="standard"?"Box Truck":x.assetType||x.bodyType||""}var u=[e.manufacturer||e.make,e.model,e.modelYear].filter(Boolean).join(" "),c=[u,p(e),e.fuelType,e.domicileSite||e.domicile,e.operator,e.program].filter(Boolean).map(S),v=c.join(" · "),m=[n!==null?'<span class="dp-vital '+i+'"><span class="dp-vital__icon">⏱</span>'+n+"d down</span>":"",s?'<span class="dp-vital dp-vital--'+Vl(s)+'"><span class="dp-vital__icon">⚡</span>Risk '+s+"</span>":"",e.openUnplanned>0?'<span class="dp-vital dp-vital--org"><span class="dp-vital__icon">⚠</span>'+e.openUnplanned+" WR</span>":"",e.urgent==="Yes"||e.urgent===!0?'<span class="dp-vital dp-vital--red"><span class="dp-vital__icon">🔴</span>URGENT</span>':"",e.vendor?'<span class="dp-vital dp-vital--acc"><span class="dp-vital__icon">🏢</span>'+S(e.vendor)+"</span>":"",e.workDuration?'<span class="dp-vital dp-vital--muted"><span class="dp-vital__icon">⏳</span>'+S(e.workDuration)+"</span>":""].filter(Boolean).join(""),g=[l?'<button class="dp-launcher" title="Open AAP" data-aap-url="'+l+'">🔗 AAP</button>':"",o?'<button class="dp-launcher" title="Open Relay WR" data-ext-url="'+o+'">📄 Relay</button>':"",d?'<button class="dp-launcher" title="Open Offsite Portal" data-ext-url="'+d+'">🏦 Portal</button>':""].filter(Boolean).join("");return'<div class="dp-header dp-header--'+a+'"><div class="dp-header__scan"></div><div class="dp-header__top"><span class="dp-header__id">'+S(e.equipmentId)+"</span>"+(e.vin?'<span class="dp-header__vin">'+S(e.vin)+"</span>":"")+'<span class="dp-header__state-badge dp-header__state-badge--'+(t?"unavailable":"active")+'">'+S(e.lifecycleState||"Active")+'</span><div class="dp-header__launchers">'+g+'</div><button id="dp-close" class="dp-header__close">×</button></div>'+(v?'<div class="dp-header__meta">'+v+"</div>":"")+(e.lifecycleReason?'<div class="dp-header__reason">→ '+S(e.lifecycleReason)+"</div>":"")+'<div class="dp-header__vitals">'+m+"</div></div>"}function Yl(e){var t=(e.openUnplanned||0)+(e.openPlanned||0),s=(e.insightsList||[]).length;function a(d,p){return d?'<span class="dp-tab__badge'+(p?" dp-tab__badge--red":"")+'">'+d+"</span>":""}var n=[{id:"repair",label:"Repair",b:a(t,!0)},{id:"intel",label:"Intel",b:a(s,!1)},{id:"actions",label:"Actions",b:""},{id:"history",label:"History",b:""}],i=(e.lifecycleState||"").toLowerCase().includes("unavail"),l=parseInt(e.riskScore,10)||0,o=i||t>0?"repair":l>=60?"intel":"repair";return'<div class="dp-tabs">'+n.map(function(d){return'<button class="dp-tab'+(d.id===o?" active":"")+'" data-tab="'+d.id+'">'+d.label+d.b+"</button>"}).join("")+"</div>"}function Ql(e){var t=e.relaySynced&&(e.vendor||e.issueDetails||e.workRequestId),s="";if(t){var a=e.serviceState||e.status||"",n=a.toLowerCase().includes("clos")?"closed":a.toLowerCase().includes("sour")?"sourcing":"open",i=e.created?Math.floor((Date.now()-new Date(e.created).getTime())/864e5):null,l=i>3?'<span class="dp-wo-stale">⚠ '+i+"d</span>":"",o=[e.workRequestId?["WR ID",e.workRequestId]:null,e.vendorWorkOrderId?["Vendor WO",e.vendorWorkOrderId]:null,e.salesforceCase?["SF Case",e.salesforceCase]:null,e.createdBy?["Created By",e.createdBy]:null,e.needBy?["Need By",e.needBy]:null,e.serviceCategory?["Category",e.serviceCategory]:null,e.integratedMethod?["Method",e.integratedMethod]:null,e.program?["Program",e.program]:null,e.totalCost?["Total Cost",e.totalCost]:null].filter(Boolean),d=e.cause?'<div class="dp-wo-cause"><span class="dp-wo-cause__label">Reason:</span> '+S(e.cause)+"</div>":"",p=e.correction?'<div class="dp-wo-cause"><span class="dp-wo-cause__label">Work Done:</span> '+S(e.correction)+"</div>":"";s='<div class="dp-wo-card"><div class="dp-wo-card__header"><span class="dp-wo-card__vendor">'+S(e.vendor||"Unknown Vendor")+"</span>"+(e.subVendor&&e.subVendor!==e.vendor?'<span class="dp-wo-card__subvendor">'+S(e.subVendor)+"</span>":"")+'<span class="dp-wo-card__status-pill dp-wo-card__status-pill--'+n+'">'+S(a||"Open")+"</span>"+l+"</div>"+(e.issueDetails?'<div class="dp-wo-card__desc">'+S(e.issueDetails)+"</div>":"")+d+p+(o.length?'<div class="dp-wo-card__fields">'+o.map(function(M){return'<span class="dp-wo-field"><span class="dp-wo-field__k">'+S(M[0])+'</span><span class="dp-wo-field__v">'+S(M[1])+"</span></span>"}).join("")+"</div>":"")+(e.created||e.completed?'<div class="dp-wo-card__dates">'+(e.created?"<span>Opened "+Ae(e.created)+"</span>":"")+(e.completed?"<span>Closed "+Ae(e.completed)+"</span>":"")+"</div>":"")+"</div>"}else s='<div class="dp-empty-state"><span class="dp-empty-state__icon">📂</span>No Relay WR data</div>';var u=Jl(e),c=Gl(e.savedNotes||e.fullConversation||"");kn=c;var v="";if(c.length){let M=function(_){var B=_.side==="vendor",L=B?"dp-tl3-dot--vendor":"dp-tl3-dot--carrier";return'<div class="dp-tl3-item '+L+'">'+(_.date?'<span class="dp-tl3-date">'+S(_.date)+"</span>":"")+'<span class="dp-tl3-dash"> - </span><span class="dp-tl3-text">'+S(_.text)+"</span></div>"};var m=6,g=c.slice(-m),x=c.length-g.length;v='<div class="dp-section-title">Timeline <span class="dp-section-count">'+c.length+'</span></div><div class="dp-tl3" id="dp-convo">'+(x>0?'<button class="dp-tl2-show-more" id="dp-convo-more">Ã¢â€“Â² Show '+x+" earlier</button>":"")+g.map(M).join("")+"</div>"}var f=e.asistSrUrl||e.savedOffsiteUrl||e.offsiteShopEventUrl||"",w=e.asistLabel||e.savedOffsiteEvent||e.offsiteShopEvent||f,b=e.asistSource||"",I=e.asistScrapedAt||"",H=I&&Date.now()-new Date(I).getTime()>864e5,P=f?'<div class="dp-section-title">Offsite Event</div><div class="dp-offsite-card"><div class="dp-offsite-card__header">'+(b?'<span class="dp-offsite-card__src-badge dp-offsite-card__src-badge--'+S(b)+'">'+S(b)+"</span>":"")+'<a class="dp-offsite-card__link" href="#" data-ext-url="'+S(f)+'">'+S(w||f)+" ↗</a>"+(H?'<span class="dp-offsite-card__stale">⚠ stale</span>':"")+"</div>"+(e.dealerName?'<div class="dp-offsite-card__dealer">'+S(e.dealerName)+"</div>":"")+(I?'<div class="dp-offsite-card__ts">Enriched '+Ae(I)+"</div>":"")+"</div>":"";return'<div class="dp-pane active" id="dp-pane-repair"><div class="dp-section-title">Work Request</div>'+s+u+v+P+"</div>"}function Zl(e){var t=parseInt(e.riskScore,10)||0,s=t>=70?"high":t>=40?"medium":"low",a="";if(t){var n=(2*Math.PI*28).toFixed(1),i=(n-t/100*parseFloat(n)).toFixed(1),l=t>=70?"var(--red)":t>=40?"var(--ylw)":"var(--grn)";a='<div class="dp-risk-wrap"><div class="dp-risk-dial"><svg viewBox="0 0 72 72"><circle cx="36" cy="36" r="28" fill="none" stroke="var(--el)" stroke-width="6"/><circle cx="36" cy="36" r="28" fill="none" stroke="'+l+'" stroke-width="6" stroke-dasharray="'+n+'" stroke-dashoffset="'+i+'" stroke-linecap="round" transform="rotate(-90 36 36)"/></svg><div class="dp-risk-dial__num dp-risk-dial__num--'+s+'">'+t+'</div></div><div class="dp-risk-info"><div class="dp-risk-label">Uptake Risk Score</div><div class="dp-risk-sub">'+(t>=70?"High Ã¢â‚¬â€ maintenance recommended":t>=40?"Moderate Ã¢â‚¬â€ monitor closely":"Low risk")+"</div>"+(e.riskLabel?'<div class="dp-risk-sub" style="margin-top:2px">'+S(e.riskLabel)+"</div>":"")+(e.lastDataDate?'<div class="dp-risk-sub" style="color:var(--mut);margin-top:4px">Data: '+Ae(e.lastDataDate)+"</div>":"")+"</div></div>"}var o=e.subsystems||[],d=o.length?'<div class="dp-section-title">Subsystems</div>'+o.map(function(g){var x=parseInt(g.score||g.value||g.riskScore,10)||0,f=x>=70?"var(--red)":x>=40?"var(--ylw)":"var(--grn)";return'<div class="dp-subsystem-row"><span class="dp-subsystem-name">'+S(g.name||g.system||g.subsystem||"")+'</span><div class="dp-subsystem-bar"><div class="dp-subsystem-fill" style="width:'+x+"%;background:"+f+'"></div></div><span class="dp-subsystem-val" style="color:'+f+'">'+x+"</span></div>"}).join(""):"",p=e.insightsList||[],u=p.length?'<div class="dp-section-title">Insights <span class="dp-section-count">'+p.length+"</span></div>"+p.map(function(g){var x=g.subsystem||"",f=g.type||g.insightType||"",w=g.status||"",b=g.firstSeen||g.firstDetected||"",I=g.lastSeen||g.lastDetected||"",H=g.maintenanceFactor||"";return'<div class="dp-insight-card"><div class="dp-insight-card__header">'+(x?'<span class="dp-insight-card__type">'+S(x)+"</span>":"")+(f?'<span class="dp-insight-card__sub">'+S(f)+"</span>":"")+(w?'<span class="dp-insight-card__status dp-insight-card__status--'+S(w.toLowerCase())+'">'+S(w)+"</span>":"")+(g.url?'<a class="dp-offsite-card__link" href="#" data-ext-url="'+S(g.url)+'" style="margin-left:auto">↗</a>':"")+"</div>"+(g.title?'<div class="dp-insight-card__title">'+S(g.title)+"</div>":"")+(g.summary?'<div class="dp-insight-card__summary">'+S(g.summary)+"</div>":"")+(g.guidance?'<div class="dp-insight-card__action">➡ '+S(g.guidance)+"</div>":"")+(g.recommended?'<div class="dp-insight-card__action">🔧 '+S(g.recommended)+"</div>":"")+(b||I||H?'<div class="dp-insight-card__meta">'+(b?"<span>First: "+S(b)+"</span>":"")+(I?"<span>Last: "+S(I)+"</span>":"")+(H?"<span>Factor: "+S(H)+"</span>":"")+"</div>":"")+"</div>"}).join(""):'<div class="dp-empty-state"><span class="dp-empty-state__icon">⚡</span>No Uptake insights</div>',c=(e.screenshots||[])[0],v="";c&&(v='<div class="dp-section-title">Uptake Screenshot</div><div class="dp-screenshot-wrap"><img id="dp-uptake-shot" data-path="'+S(c)+'" src="" alt="Loading..."><div class="dp-screenshot-overlay"><span class="dp-screenshot-label">Uptake Insights</span></div></div>',setTimeout(async()=>{try{const g=await window.files.readAsDataUrl(c),x=document.getElementById("dp-uptake-shot");x&&(x.src=g)}catch{}},100));var m='<div class="dp-section-title">Ask Orcha</div><div class="dp-ask-chips"><button class="dp-ask-chip" data-q="Is the ETC realistic for this unit?">ETC realistic?</button><button class="dp-ask-chip" data-q="Draft a vendor follow-up message">Draft follow-up</button><button class="dp-ask-chip" data-q="Should I escalate this unit?">Escalate?</button><button class="dp-ask-chip" data-q="Summarize current repair status">Summarize</button><button class="dp-ask-chip" data-q="What parts are likely needed?">Parts needed?</button></div><div class="dp-ask-row"><input id="dp-ask-input" class="dp-ask-input" type="text" placeholder="Ask about this unit..."/><button id="dp-ask-btn" class="detail-panel__btn">Ask</button></div><div id="dp-ai-result" style="display:none" class="dp-ai-result-box"></div>';return'<div class="dp-pane" id="dp-pane-intel">'+a+d+u+v+m+"</div>"}function eo(e){return(e.lifecycleState||"").toLowerCase().includes("unavail"),'<div class="dp-pane" id="dp-pane-actions"><div class="dp-section-title">Quick Actions</div><div class="dp-action-grid"><button class="dp-action-btn dp-action-btn--primary" id="dp-act-create-wr"><span class="dp-action-btn__icon">➕</span>Create WR<span class="dp-action-btn__sub">AAP work request</span></button><button class="dp-action-btn" id="dp-act-dealer-wo"><span class="dp-action-btn__icon">🏦</span>Dealer WO<span class="dp-action-btn__sub">PACCAR / Volvo / DTNA</span></button><button class="dp-action-btn" id="dp-act-aap"><span class="dp-action-btn__icon">🔗</span>Open AAP<span class="dp-action-btn__sub">Asset page</span></button><button class="dp-action-btn" id="dp-act-lc"><span class="dp-action-btn__icon">🔄</span>Lifecycle<span class="dp-action-btn__sub">'+S(e.lifecycleState||"")+'</span></button><button class="dp-action-btn dp-action-btn--notes" id="dp-act-daily-notes"><span class="dp-action-btn__icon">📋</span>Daily Notes<span class="dp-action-btn__sub">AI note + split view</span></button><button class="dp-action-btn dp-action-btn--orcha" id="dp-act-orcha-deep"><span class="dp-action-btn__icon">⚡</span>Orcha Scan<span class="dp-action-btn__sub">AI deep analysis</span></button></div><div id="dp-lc-form" class="dp-lc-form" style="display:none"><div class="dp-lc-row"><select id="dp-lc-state" class="detail-panel__select"><option value="Available">Available</option><option value="Unavailable">Unavailable</option></select><input id="dp-lc-reason" class="detail-panel__input" type="text" placeholder="Reason..."/></div><div class="dp-lc-row"><button id="dp-lc-confirm" class="detail-panel__btn">Confirm</button><button id="dp-lc-cancel" class="detail-panel__btn detail-panel__btn--secondary">Cancel</button></div><div class="dp-section-title" style="margin-top:10px">Dealer Work Order</div><div id="dp-vnd-ai-suggest" class="dp-vnd-ai-suggest"></div><div id="dp-vendor-section" class="dp-vendor-section"><p class="dp-empty">Loading eligibility…</p></div><div id="dp-vnd-history-strip" class="dp-vnd-history-strip"></div></div>'}function to(e){var t=[{label:"AAP",ts:e.lastDataDate,icon:"🔗"},{label:"Relay",ts:e.relaySynced?new Date().toISOString():null,icon:"📄"},{label:"Uptake",ts:e.uptakeSynced?e.lastDataDate:null,icon:"⚡"},{label:"ASIST",ts:e.asistScrapedAt,icon:"🏦"},{label:"Notes",ts:e.notesUpdatedAt,icon:"📝"}],s=t.map(function(n){var i=n.ts?Date.now()-new Date(n.ts).getTime():null,l=i===null?"none":i>864e5?"old":"ok";return'<div class="dp-sync-row"><div class="dp-sync-dot dp-sync-dot--'+l+'"></div><span class="dp-sync-icon">'+n.icon+'</span><span class="dp-sync-source">'+n.label+'</span><span class="dp-sync-time">'+(n.ts?Na(n.ts):"Never")+"</span></div>"}).join(""),a=[e.created?'<div class="dp-tl-row"><span class="dp-tl-dot dp-tl-dot--open"></span><span class="dp-tl-label">WR Opened</span><span class="dp-tl-date">'+Ae(e.created)+"</span></div>":"",e.workDuration?'<div class="dp-tl-row"><span class="dp-tl-dot dp-tl-dot--etc"></span><span class="dp-tl-label">Work Duration</span><span class="dp-tl-date">'+S(e.workDuration)+"</span></div>":"",e.needBy?'<div class="dp-tl-row"><span class="dp-tl-dot dp-tl-dot--needby"></span><span class="dp-tl-label">Need By</span><span class="dp-tl-date">'+S(e.needBy)+"</span></div>":"",e.completed?'<div class="dp-tl-row"><span class="dp-tl-dot dp-tl-dot--closed"></span><span class="dp-tl-label">Completed</span><span class="dp-tl-date">'+Ae(e.completed)+"</span></div>":"",e.notesUpdatedAt?'<div class="dp-tl-row"><span class="dp-tl-dot dp-tl-dot--note"></span><span class="dp-tl-label">Notes Updated</span><span class="dp-tl-date">'+Na(e.notesUpdatedAt)+"</span></div>":""].filter(Boolean).join("");return'<div class="dp-pane" id="dp-pane-history"><div class="dp-section-title">Data Sync</div><div class="dp-sync-panel">'+s+"</div>"+(a?'<div class="dp-section-title">Timeline</div><div class="dp-timeline">'+a+"</div>":"")+'<div class="dp-section-title">Notes</div><textarea id="dp-notes" class="dp-notes-area" placeholder="Add notes...">'+S(e.savedNotes||"")+'</textarea><div class="dp-notes-footer"><button id="dp-save-notes" class="detail-panel__btn">Save</button><span id="dp-notes-saved" class="dp-notes-saved">Saved ✓</span></div></div>'}async function so(e){if(!e)return;const t=e.equipmentId||e.id||"";if(!t){h.show("warn","No unit selected",2500);return}if(!(e.alternativeId||e.altId||"")){h.show("warn",t+" has no Alt ID",3e3);return}const a=e.serviceUrl||e.pageUrl||"";let n=e.offsiteShopEventUrl||e.savedOffsiteUrl||"";!n&&e.offsiteShopEvent&&/^\d+$/.test(String(e.offsiteShopEvent).trim())&&(n="https://aap-na.corp.amazon.com/v2/offsite-events/"+e.offsiteShopEvent.trim());const i=a&&a.startsWith("http"),l=n&&n.startsWith("http");if(!i&&!l){h.show("warn",t+" Ã¢â‚¬â€ no Relay or Offsite URLs available",3e3);return}if(window.ai&&typeof window.ai.openDailyWindows=="function")try{await window.ai.openDailyWindows({unitId:t,relayUrl:i?a:"",offsiteUrl:l?n:""}),h.show("info","Opened "+(i&&l?"Relay + Offsite":i?"Relay":"Offsite")+" for "+t,2500)}catch(o){h.show("error","Failed to open windows: "+o.message,3e3)}else h.show("warn","Split view not available",2500)}function ao(e){if(Ee=e,!U)return;zt(),(e.lifecycleState||"").toLowerCase().includes("unavail"),parseInt(e.riskScore,10),U.innerHTML=Kl(e)+'<div class="dp-status-band dp-status-band--loading" id="dp-status-band"><span class="dp-status-band__icon">&#129504;</span><span class="dp-status-band__text">Analyzing unit statusÃ¢â‚¬Â¦</span></div>'+Yl(e)+'<div class="dp-body">'+Ql(e)+Zl(e)+eo(e)+to(e)+"</div>",U.querySelectorAll(".dp-tab").forEach(function(f){f.addEventListener("click",function(){U.querySelectorAll(".dp-tab").forEach(function(b){b.classList.remove("active")}),U.querySelectorAll(".dp-pane").forEach(function(b){b.classList.remove("active")}),f.classList.add("active");var w=document.getElementById("dp-pane-"+f.dataset.tab);w&&w.classList.add("active")})});var t=document.getElementById("dp-close");t&&t.addEventListener("click",io),U.querySelectorAll("[data-aap-url]").forEach(function(f){f.addEventListener("click",function(){var w=f.dataset.aapUrl;w&&window.aap&&window.aap.openUrl(w)})}),U.querySelectorAll("[data-ext-url]").forEach(function(f){f.addEventListener("click",function(w){w.preventDefault();var b=f.dataset.extUrl||f.getAttribute("data-ext-url");b&&window.files&&window.files.openExternal(b).catch(function(){})})});var s=document.getElementById("dp-convo-more");s&&s.addEventListener("click",function(){var f=document.getElementById("dp-convo");f&&(f.innerHTML=kn.map(function(w){var b=w.side==="vendor",I=b?"dp-tl3-dot--vendor":"dp-tl3-dot--carrier";return'<div class="dp-tl3-item '+I+'">'+(w.date?'<span class="dp-tl3-date">'+S(w.date)+"</span>":"")+'<span class="dp-tl3-dash"> - </span><span class="dp-tl3-text">'+S(w.text)+"</span></div>"}).join(""))}),no(e);var a=document.getElementById("dp-act-create-wr");a&&a.addEventListener("click",function(){Il(e)});var n=document.getElementById("dp-act-aap");n&&n.addEventListener("click",function(){e.assetUrl?Xe.openUrl(e.assetUrl):h.show("warn","No AAP URL",3e3)});var i=document.getElementById("dp-act-dealer-wo");i&&i.addEventListener("click",function(){U.querySelectorAll(".dp-tab").forEach(function(b){b.classList.remove("active")}),U.querySelectorAll(".dp-pane").forEach(function(b){b.classList.remove("active")});var f=U.querySelector('[data-tab="actions"]'),w=document.getElementById("dp-pane-actions");f&&f.classList.add("active"),w&&w.classList.add("active"),setTimeout(function(){var b=document.getElementById("dp-vendor-section");b&&b.scrollIntoView({behavior:"smooth",block:"start"})},100)});var l=document.getElementById("dp-act-lc"),o=document.getElementById("dp-lc-form");l&&o&&l.addEventListener("click",function(){o.style.display=o.style.display==="none"?"flex":"none"});var d=document.getElementById("dp-lc-cancel");d&&o&&d.addEventListener("click",function(){o.style.display="none"});var p=document.getElementById("dp-lc-confirm");p&&p.addEventListener("click",async function(){if(!e.assetUrl){h.show("warn","No AAP URL",3e3);return}var f=(document.getElementById("dp-lc-state")||{}).value,w=((document.getElementById("dp-lc-reason")||{}).value||"").trim();p.disabled=!0,p.textContent="Saving...";try{await Xe.setLifecycle(e.equipmentId,e.assetUrl,f,w),h.show("success","Lifecycle changed to "+f),o&&(o.style.display="none")}catch(b){h.show("error","Lifecycle change failed: "+b.message)}finally{p.disabled=!1,p.textContent="Confirm"}});var u=document.getElementById("dp-act-daily-notes");u&&u.addEventListener("click",function(){so(e)});var c=document.getElementById("dp-act-orcha-deep");c&&c.addEventListener("click",async function(){c.disabled=!0,c.querySelector(".dp-action-btn__sub").textContent="Analyzing...";try{var f=await te.deepProcess([e.equipmentId]);if(f&&f.units&&f.units.length>0){var w=f.units[0];h.show("success","Orcha analyzed "+e.equipmentId,3e3);var b=document.getElementById("dp-ai-result");b&&w.issueSummary&&(b.style.display="block",b.innerHTML='<div class="dp-ai-text"><strong>Orcha Deep Scan:</strong><br/>'+$(w.issueSummary)+"</div>")}else h.show("info","Orcha scan complete Ã¢â‚¬â€ no new insights",2500)}catch(I){h.show("error","Orcha scan failed: "+(I.message||"unknown"),3e3)}finally{c.disabled=!1,c.querySelector(".dp-action-btn__sub").textContent="AI deep analysis"}});var v=document.getElementById("dp-ask-input"),m=document.getElementById("dp-ask-btn"),g=document.getElementById("dp-ai-result");async function x(f){if(g){g.style.display="block",g.innerHTML='<span style="color:var(--mut);font-style:italic">Ã¢Å¸Â³ Asking Orcha...</span>';try{var w=await te.ask("[Unit: "+e.equipmentId+"] "+f),b=w&&w.text?w.text:JSON.stringify(w,null,2);g.innerHTML='<div class="dp-ai-text">'+$(b)+'</div><div class="dp-ai-result-footer"><button id="dp-ai-copy" class="detail-panel__btn dp-ai-copy-btn">Copy</button></div>',document.getElementById("dp-ai-copy").addEventListener("click",function(){navigator.clipboard.writeText(b).catch(function(){}),h.show("info","Copied",2e3)})}catch(I){g.innerHTML='<span style="color:var(--red)">'+$(I.message)+"</span>"}}}m&&v&&(m.addEventListener("click",function(){var f=v.value.trim();f&&x(f)}),v.addEventListener("keydown",function(f){if(f.key==="Enter"&&!f.shiftKey){f.preventDefault();var w=v.value.trim();w&&x(w)}})),U.querySelectorAll(".dp-ask-chip").forEach(function(f){f.addEventListener("click",function(){v&&(v.value=f.dataset.q||""),x(f.dataset.q||"")})}),ws(e),window.ai&&window.ai.suggest&&window.ai.suggest(e).then(function(f){var w=document.getElementById("dp-status-band");if(w){var b=f&&f.text?f.text:"";b&&(w.classList.remove("dp-status-band--loading"),w.innerHTML='<span class="dp-status-band__icon">&#129504;</span><span class="dp-status-band__text">'+S(b)+"</span>")}}).catch(function(){})}function no(e){var t=document.getElementById("dp-notes"),s=document.getElementById("dp-notes-saved");if(!t)return;window.notes&&window.notes.getUnit(e.equipmentId).then(function(i){i&&i.content&&(t.value=i.content)}).catch(function(){});async function a(){if(window.notes)try{await window.notes.saveUnit({unitId:e.equipmentId,content:t.value}),s&&(s.classList.add("visible"),setTimeout(function(){s.classList.remove("visible")},2e3))}catch(i){console.warn("Notes save failed",i)}}t.addEventListener("blur",a);var n=document.getElementById("dp-save-notes");n&&n.addEventListener("click",a)}function io(){U&&(U.classList.remove("detail-panel--open"),setTimeout(()=>{U&&(U.innerHTML=""),Ee=null,zt()},300)),r.emit("ui:unit-deselect")}function lo(e){U=document.createElement("div"),U.id="detail-panel",U.className="detail-panel",e.appendChild(U),r.on("ui:unit-select",({unit:t})=>{ao(t),requestAnimationFrame(()=>U.classList.add("detail-panel--open"))}),r.on("ui:unit-deselect",()=>{U&&U.classList.remove("detail-panel--open")})}let fe=null;function xn(e,t){if(!Ee||Ee.equipmentId!==e.equipmentId&&Ee.id!==e.equipmentId){fe=null;return}const s=document.getElementById("dp-vendor-section");if(!s){if(t>=12){fe=null;return}fe={unit:e,attempts:t+1},requestAnimationFrame(()=>{fe&&xn(fe.unit,fe.attempts)});return}if(s.dataset.investigating===e.equipmentId){fe=null,s.scrollIntoView({behavior:"smooth",block:"nearest"});return}fe=null,s.dataset.investigating=e.equipmentId,ws(e),s.scrollIntoView({behavior:"smooth",block:"nearest"})}r.on("ui:dealer-wo-request",({unit:e})=>{fe={unit:e,attempts:0},requestAnimationFrame(()=>{fe&&xn(fe.unit,fe.attempts)})});let N=null,ms=null;function oo(){return`
  <!-- Overlay backdrop -->
  <div id="sd-overlay"></div>

  <!-- Drawer -->
  <div class="settings-drawer" id="settings-drawer">

    <!-- Header -->
    <div class="sd-header">
      <span style="font-size:16px">⚙</span>
      <span class="sd-title">Settings</span>
      <button class="sd-close" id="sd-close-btn">✕</button>
    </div>

    <!-- Tab bar -->
    <div class="sd-tabs">
      <button class="sd-tab active" data-pane="ui">UI &amp; App</button>
      <button class="sd-tab"        data-pane="integrations">Integrations</button>
      <button class="sd-tab"        data-pane="operators">Operators &amp; SP</button>
      <button class="sd-tab"        data-pane="accounts">Accounts</button>
    </div>

    <!-- Body -->
    <div class="sd-body">

      <!-- ══ TAB 1: UI & App ══════════════════════════════════════════════ -->
      <div id="sd-pane-ui">

        <!-- Templates -->
        <div class="sd-section">
          <div class="sd-section-title">Templates</div>
          <div class="sd-template-grid">
            <div class="sd-template active" data-theme="dark">
              <div class="sd-tpl-preview dark-prev"></div>
              <div class="sd-tpl-info">
                <div class="sd-tpl-name">Dark</div>
                <div class="sd-tpl-desc">Default dark theme</div>
              </div>
              <span class="sd-tpl-check">✓</span>
            </div>
            <div class="sd-template" data-theme="light">
              <div class="sd-tpl-preview light-prev"></div>
              <div class="sd-tpl-info">
                <div class="sd-tpl-name">Light</div>
                <div class="sd-tpl-desc">Light mode</div>
              </div>
              <span class="sd-tpl-check" style="display:none">✓</span>
            </div>
            <div class="sd-template" data-theme="midnight">
              <div class="sd-tpl-preview midnight-prev"></div>
              <div class="sd-tpl-info">
                <div class="sd-tpl-name">Midnight</div>
                <div class="sd-tpl-desc">Deep black</div>
              </div>
              <span class="sd-tpl-check" style="display:none">✓</span>
            </div>
            <div class="sd-template" data-theme="ocean">
              <div class="sd-tpl-preview ocean-prev"></div>
              <div class="sd-tpl-info">
                <div class="sd-tpl-name">Ocean</div>
                <div class="sd-tpl-desc">Teal accents</div>
              </div>
              <span class="sd-tpl-check" style="display:none">✓</span>
            </div>
          </div>
        </div>

        <!-- Colors -->
        <div class="sd-section">
          <div class="sd-section-title">Colors</div>
          <div class="sd-color-row">
            <div class="sd-color-item">
              <div class="sd-label">Accent Color</div>
              <div class="sd-color-swatch-row">
                <div class="sd-swatch active" style="background:#58a6ff" title="Blue"   data-var="--acc"></div>
                <div class="sd-swatch"        style="background:#d2a8ff" title="Purple" data-var="--acc"></div>
                <div class="sd-swatch"        style="background:#7ee787" title="Green"  data-var="--acc"></div>
                <div class="sd-swatch"        style="background:#ffa657" title="Orange" data-var="--acc"></div>
                <div class="sd-swatch"        style="background:#f78166" title="Red"    data-var="--acc"></div>
                <input type="color" class="sd-color-custom" value="#58a6ff" title="Custom" data-var="--acc"/>
              </div>
            </div>
            <div class="sd-color-item">
              <div class="sd-label">Background</div>
              <div class="sd-color-swatch-row">
                <div class="sd-swatch active" style="background:#0d1117" title="Default" data-var="--bg"></div>
                <div class="sd-swatch"        style="background:#080c10" title="Darker"  data-var="--bg"></div>
                <div class="sd-swatch"        style="background:#0d1b2a" title="Navy"    data-var="--bg"></div>
                <input type="color" class="sd-color-custom" value="#0d1117" title="Custom" data-var="--bg"/>
              </div>
            </div>
            <div class="sd-color-item">
              <div class="sd-label">Panel Color</div>
              <div class="sd-color-swatch-row">
                <div class="sd-swatch active" style="background:#161b22" title="Default" data-var="--panel"></div>
                <div class="sd-swatch"        style="background:#111318" title="Darker"  data-var="--panel"></div>
                <div class="sd-swatch"        style="background:#141a24" title="Navy"    data-var="--panel"></div>
                <input type="color" class="sd-color-custom" value="#161b22" title="Custom" data-var="--panel"/>
              </div>
            </div>
            <div class="sd-color-item">
              <div class="sd-label">Text Color</div>
              <div class="sd-color-swatch-row">
                <div class="sd-swatch active" style="background:#f0f6fc;border-color:#444" title="Default" data-var="--txt"></div>
                <div class="sd-swatch"        style="background:#e6edf3;border-color:#444" title="Soft"    data-var="--txt"></div>
                <div class="sd-swatch"        style="background:#cdd9e5;border-color:#444" title="Muted"   data-var="--txt"></div>
                <input type="color" class="sd-color-custom" value="#f0f6fc" title="Custom" data-var="--txt"/>
              </div>
            </div>
          </div>
        </div>

        <!-- Row Colors -->
        <div class="sd-section">
          <div class="sd-section-title">Row Colors</div>
          <div class="sd-color-row">
            <div class="sd-color-item">
              <div class="sd-label">Available Row</div>
              <div class="sd-color-swatch-row">
                <div class="sd-swatch active" style="background:rgba(126,231,135,.06)"  title="Subtle green" data-var="--row-avail"></div>
                <div class="sd-swatch"        style="background:rgba(126,231,135,.14)"  title="Green"        data-var="--row-avail"></div>
                <div class="sd-swatch"        style="background:rgba(88,166,255,.08)"   title="Blue"         data-var="--row-avail"></div>
                <div class="sd-swatch"        style="background:transparent"            title="None"         data-var="--row-avail"></div>
                <input type="color" class="sd-color-custom" value="#7ee787" title="Custom" data-var="--row-avail"/>
              </div>
            </div>
            <div class="sd-color-item">
              <div class="sd-label">Unavailable Row</div>
              <div class="sd-color-swatch-row">
                <div class="sd-swatch active" style="background:rgba(255,123,114,.06)"  title="Subtle red"   data-var="--row-unavail"></div>
                <div class="sd-swatch"        style="background:rgba(255,123,114,.14)"  title="Red"          data-var="--row-unavail"></div>
                <div class="sd-swatch"        style="background:rgba(255,166,87,.10)"   title="Orange"       data-var="--row-unavail"></div>
                <div class="sd-swatch"        style="background:transparent"            title="None"         data-var="--row-unavail"></div>
                <input type="color" class="sd-color-custom" value="#ff7b72" title="Custom" data-var="--row-unavail"/>
              </div>
            </div>
          </div>
        </div>

        <!-- Transparency -->
        <div class="sd-section">
          <div class="sd-section-title">Transparency</div>
          <div class="sd-slider-row">
            <div class="sd-label">Panel Opacity</div>
            <div class="sd-slider-wrap">
              <input type="range" class="sd-slider" id="sl-opacity" min="60" max="100" value="100"/>
              <span class="sd-slider-val" id="sl-opacity-val">100%</span>
            </div>
          </div>
          <div class="sd-slider-row">
            <div class="sd-label">Blur Intensity</div>
            <div class="sd-slider-wrap">
              <input type="range" class="sd-slider" id="sl-blur" min="0" max="20" value="4"/>
              <span class="sd-slider-val" id="sl-blur-val">4px</span>
            </div>
          </div>
        </div>

        <!-- Layout -->
        <div class="sd-section">
          <div class="sd-section-title">Layout</div>
          <div class="sd-toggle-row">
            <span class="sd-toggle-label">Compact Rows</span>
            <input type="checkbox" id="toggle-compact"/>
          </div>
        </div>

        <!-- Fleet Intelligence (S28) -->
        <div class="sd-section">
          <div class="sd-section-title">Fleet Intelligence</div>
          <div class="sd-slider-row">
            <div class="sd-label">SLA Target (days)</div>
            <div class="sd-slider-wrap">
              <input type="range" class="sd-slider" id="sl-sla-target" min="2" max="14" value="5"/>
              <span class="sd-slider-val" id="sl-sla-target-val">5d</span>
            </div>
          </div>
          <div class="sd-toggle-row" style="margin-top:4px">
            <span class="sd-toggle-label" style="font-size:9px;color:var(--mut)">Units at vendor longer than this will trigger breach alerts</span>
          </div>
        </div>

        <!-- Animations -->
        <div class="sd-section">
          <div class="sd-section-title">Animations</div>
          <div class="sd-toggle-row"><span class="sd-toggle-label">Show Animations</span><input type="checkbox" checked/></div>
          <div class="sd-toggle-row"><span class="sd-toggle-label">Scan Line Effect</span><input type="checkbox" checked/></div>
          <div class="sd-toggle-row"><span class="sd-toggle-label">Row Fade-In</span><input type="checkbox" checked/></div>
          <div class="sd-toggle-row"><span class="sd-toggle-label">KPI Pop-In</span><input type="checkbox" checked/></div>
          <div class="sd-slider-row" style="margin-top:8px">
            <div class="sd-label">Drawer Slide Speed</div>
            <div class="sd-slider-wrap">
              <input type="range" class="sd-slider" id="sl-speed" min="100" max="600" value="250"/>
              <span class="sd-slider-val" id="sl-speed-val">250ms</span>
            </div>
          </div>
        </div>

        <!-- Font -->
        <div class="sd-section">
          <div class="sd-section-title">Font</div>
          <div class="sd-font-row">
            <button class="sd-font-btn active" data-font="system">System</button>
            <button class="sd-font-btn" data-font="serif"   style="font-family:Georgia,serif">Serif</button>
            <button class="sd-font-btn" data-font="mono"    style="font-family:monospace">Mono</button>
            <button class="sd-font-btn" data-font="inter"   style="font-family:sans-serif">Inter</button>
          </div>
        </div>

        <div class="sd-section">
          <div class="sd-section-title">Border Radius</div>
          <div class="sd-slider-row">
            <div class="sd-label">Card Radius</div>
            <div class="sd-slider-wrap">
              <input type="range" class="sd-slider" id="sl-radius" min="0" max="20" value="10"/>
              <span class="sd-slider-val" id="sl-radius-val">10px</span>
            </div>
          </div>
        </div>

        <!-- ═══ NEXUS THEME BUILDER (Year 3030) ═══ -->
        <div class="sd-section" id="sect-nexus-theme">
          <div class="sd-section-title" style="display:flex;align-items:center;gap:8px">
            <span style="font-size:14px">🌌</span> Nexus Theme Engine
            <span style="font-size:8px;color:var(--nx-accent,#00d4ff);font-weight:700;background:var(--nx-accent-dim,rgba(0,212,255,.1));padding:2px 6px;border-radius:8px">3030</span>
          </div>

          <!-- Presets -->
          <div class="sd-field" style="margin-bottom:12px">
            <div class="sd-label">Preset</div>
            <div class="nx-preset-grid" id="nx-preset-grid">
              <button class="nx-preset-chip nx-preset-chip--active" data-preset="default">Default</button>
              <button class="nx-preset-chip" data-preset="void">Void</button>
              <button class="nx-preset-chip" data-preset="solar">Solar</button>
              <button class="nx-preset-chip" data-preset="arctic">Arctic</button>
              <button class="nx-preset-chip" data-preset="ember">Ember</button>
            </div>
          </div>

          <!-- Custom Accent -->
          <div class="sd-field" style="margin-bottom:12px">
            <div class="sd-label">Custom Accent Color</div>
            <div style="display:flex;align-items:center;gap:10px">
              <input type="color" id="nx-accent-picker" value="#00d4ff" class="nx-theme-builder__color"/>
              <span id="nx-accent-hex" style="font-family:var(--nx-mono);font-size:10px;color:var(--nx-text2)">#00d4ff</span>
              <button class="sd-btn secondary" id="nx-accent-reset" style="font-size:9px;padding:3px 8px">Reset</button>
            </div>
          </div>

          <!-- Density -->
          <div class="sd-field" style="margin-bottom:12px">
            <div class="sd-label">Density</div>
            <div style="display:flex;gap:6px">
              <button class="nx-preset-chip" data-density="compact">Compact</button>
              <button class="nx-preset-chip nx-preset-chip--active" data-density="default">Default</button>
              <button class="nx-preset-chip" data-density="spacious">Spacious</button>
            </div>
          </div>

          <!-- Blur -->
          <div class="sd-slider-row">
            <div class="sd-label">Glass Blur</div>
            <div class="sd-slider-wrap">
              <input type="range" class="sd-slider" id="nx-blur" min="0" max="40" value="20"/>
              <span class="sd-slider-val" id="nx-blur-val">20px</span>
            </div>
          </div>

          <!-- Animation Speed -->
          <div class="sd-slider-row" style="margin-top:8px">
            <div class="sd-label">Animation Speed</div>
            <div style="display:flex;gap:6px">
              <button class="nx-preset-chip" data-anim="off">Off</button>
              <button class="nx-preset-chip" data-anim="fast">Fast</button>
              <button class="nx-preset-chip nx-preset-chip--active" data-anim="default">Default</button>
              <button class="nx-preset-chip" data-anim="slow">Slow</button>
            </div>
          </div>

          <!-- Glow Intensity -->
          <div class="sd-slider-row" style="margin-top:10px">
            <div class="sd-label">Glow Intensity</div>
            <div class="sd-slider-wrap">
              <input type="range" class="sd-slider" id="nx-glow" min="0" max="200" value="100"/>
              <span class="sd-slider-val" id="nx-glow-val">100%</span>
            </div>
          </div>

          <!-- Toggles -->
          <div style="margin-top:12px;display:flex;flex-direction:column;gap:6px">
            <div class="sd-toggle-row"><span class="sd-toggle-label">Background Gradient</span><input type="checkbox" id="nx-bg-gradient" checked/></div>
            <div class="sd-toggle-row"><span class="sd-toggle-label">Grid Lines</span><input type="checkbox" id="nx-grid-lines" checked/></div>
          </div>
        </div>

      </div>
      <!-- end sd-pane-ui -->


      <!-- ══ TAB 2: Integrations ══════════════════════════════════════════ -->
      <div id="sd-pane-integrations" style="display:none">

        <!-- Domiciles -->
        <div class="sd-section" id="sect-domiciles">
          <div class="sd-section-title">Domiciles</div>
          <div class="sd-field">
            <div class="sd-label">Managed domiciles (comma-separated)</div>
            <textarea id="settings-domiciles" class="settings__textarea sd-input" placeholder="ABE40, AVP40, AUVTE01..."></textarea>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary" id="save-domiciles">Save</button>
            <button class="sd-btn secondary" id="reset-domiciles">Reset defaults</button>
          </div>
          <div id="domicile-status" class="settings__status" style="display:none"></div>
        </div>

        <!-- Midway Auth -->
        <div class="sd-section" id="sect-auth">
          <div class="sd-section-title">Midway Auth</div>
          <div id="auth-status" class="sd-status warn">⏳ Checking...</div>
          <div class="sd-btn-row" style="margin-top:8px">
            <button class="sd-btn primary" id="auth-mwinit">Run mwinit</button>
            <button class="sd-btn secondary" id="auth-recheck">Re-check</button>
          </div>
        </div>

        <!-- Orcha Config -->
        <div class="sd-section" id="sect-orcha">
          <div class="sd-section-title">Orcha Config</div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">Mode</div>
              <select class="sd-select" id="orcha-mode">
                <option value="local">Local</option>
                <option value="remote">Remote</option>
              </select>
            </div>
            <div class="sd-field">
              <div class="sd-label">Host</div>
              <input class="sd-input" id="orcha-host" placeholder="localhost"/>
            </div>
            <div class="sd-field">
              <div class="sd-label">Port</div>
              <input class="sd-input" id="orcha-port" type="number" placeholder="4799"/>
            </div>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary" id="save-orcha">Save</button>
          </div>
        </div>

        <!-- Notifications -->
        <div class="sd-section" id="sect-notifications">
          <div class="sd-section-title">Notifications</div>
          <div class="sd-toggle-row">
            <span class="sd-toggle-label">OS notification on Midway auth failure</span>
            <input type="checkbox" id="notif-auth-fail" checked/>
          </div>
          <div class="sd-toggle-row">
            <span class="sd-toggle-label">OS notification on sync complete</span>
            <input type="checkbox" id="notif-sync-ok" checked/>
          </div>
          <div class="sd-toggle-row">
            <span class="sd-toggle-label">OS notification on sync error</span>
            <input type="checkbox" id="notif-sync-err" checked/>
          </div>
        </div>

        <!-- Credentials (keychain) -->
        <div class="sd-section" id="sect-creds">
          <div class="sd-section-title">Credentials (keychain)</div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">Key</div>
              <input class="sd-input" id="cred-key" placeholder="e.g. aap-password"/>
            </div>
            <div class="sd-field">
              <div class="sd-label">Value</div>
              <input class="sd-input" id="cred-val" type="password" placeholder="secret"/>
            </div>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary"    id="cred-save">Save Credential</button>
            <button class="sd-btn danger"     id="cred-delete">Delete Key</button>
          </div>
          <div id="cred-status" class="settings__status" style="display:none"></div>
          <div id="cred-list-wrap" class="settings-list-wrap" style="margin-top:10px">
            <div class="settings-list-label">Stored keys:</div>
            <div id="cred-list" class="settings-key-list"></div>
          </div>
        </div>

        <!-- Schedulers Config -->
        <div class="sd-section" style="border-top:1px solid var(--bdr);padding-top:14px;margin-top:4px">
          <div class="sd-section-title">Schedulers – Config</div>
          <div class="sd-field">
            <div class="sd-label">Sync interval (minutes)</div>
            <input class="sd-input" id="sched-interval" type="number" placeholder="15"/>
          </div>
          <div class="sd-field">
            <div class="sd-label">Default scheduler endpoint</div>
            <input class="sd-input" id="sched-endpoint" placeholder="https://..."/>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary" id="save-sched">Save</button>
          </div>
        </div>

        <!-- Vendor Portal Credentials -->
        <div class="sd-section" id="sect-vendor-creds">
          <div class="sd-section-title">Vendor Portal Credentials</div>
          <!-- PACCAR -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">PACCAR (paccarpg.decisiv.net)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="paccar-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="paccar-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="paccar-save">Save</button><button class="sd-btn danger" id="paccar-clear">Clear</button></div>
            <div id="paccar-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Volvo -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Volvo (volvopg.asist.decisiv.net)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="volvo-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="volvo-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="volvo-save">Save</button><button class="sd-btn danger" id="volvo-clear">Clear</button></div>
            <div id="volvo-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Record360 -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Record360 (dashboard.record360.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Email</div><input class="sd-input" id="record360-user" placeholder="you@amazon.com"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="record360-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="record360-save">Save</button><button class="sd-btn danger" id="record360-clear">Clear</button></div>
            <div id="record360-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Aperia / Halo -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Aperia / Halo Tire (amazon.aperiatech.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Email</div><input class="sd-input" id="aperia-user" placeholder="you@amazon.com"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="aperia-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="aperia-save">Save</button><button class="sd-btn danger" id="aperia-clear">Clear</button></div>
            <div id="aperia-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Reach24 -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Reach24 (amazon.reach24.net)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Email</div><input class="sd-input" id="reach24-user" placeholder="you@amazon.com"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="reach24-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="reach24-save">Save</button><button class="sd-btn danger" id="reach24-clear">Clear</button></div>
            <div id="reach24-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- DTNA -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">DTNA Service Tracker (dtna.my.site.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="dtna-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="dtna-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="dtna-save">Save</button><button class="sd-btn danger" id="dtna-clear">Clear</button></div>
            <div id="dtna-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Road Ready -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Road Ready (roadready.fadv.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="roadready-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="roadready-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="roadready-save">Save</button><button class="sd-btn danger" id="roadready-clear">Clear</button></div>
            <div id="roadready-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Velogic -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Velogic (velogic.my.site.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="velogic-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="velogic-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="velogic-save">Save</button><button class="sd-btn danger" id="velogic-clear">Clear</button></div>
            <div id="velogic-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Access Billing Services -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Access Billing Services (access-billing-services.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="abs-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="abs-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="abs-save">Save</button><button class="sd-btn danger" id="abs-clear">Clear</button></div>
            <div id="abs-status" class="settings__status" style="display:none"></div>
          </div>
        </div>


        <!-- Email SMTP -->
        <div class="sd-section" id="sect-email">
          <div class="sd-section-title">Email (SMTP)</div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">Host</div>
              <input class="sd-input" id="email-host" placeholder="smtp.corp.amazon.com"/>
            </div>
            <div class="sd-field">
              <div class="sd-label">Port</div>
              <input class="sd-input" id="email-port" type="number" placeholder="587"/>
            </div>
          </div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">From</div>
              <input class="sd-input" id="email-from" type="email" placeholder="you@amazon.com"/>
            </div>
            <div class="sd-field">
              <div class="sd-label">Username</div>
              <input class="sd-input" id="email-user" placeholder="LDAP user"/>
            </div>
          </div>
          <div class="sd-field">
            <div class="sd-label">Password</div>
            <input class="sd-input" id="email-pass" type="password" placeholder="(encrypted)"/>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary"    id="email-save">Save</button>
            <button class="sd-btn secondary"  id="email-test">Send test</button>
          </div>
          <div id="email-status" class="settings__status" style="display:none"></div>
        </div>

        <!-- Slack -->
        <div class="sd-section" id="sect-slack">
          <div class="sd-section-title">Slack</div>
          <div id="slack-status" class="sd-status warn" style="margin-bottom:8px">⚠️ Not connected</div>
          <div class="sd-btn-row">
            <button class="sd-btn primary"   id="slack-login">Sign in to Slack</button>
            <button class="sd-btn secondary" id="slack-recheck">Re-check</button>
          </div>
        </div>

        <!-- Asana -->
        <div class="sd-section" id="sect-asana">
          <div class="sd-section-title">Asana</div>
          <div class="sd-field">
            <div class="sd-label">Personal Access Token</div>
            <input class="sd-input" id="asana-pat" type="password" placeholder="0/xxxxxxxx"/>
          </div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">Workspace GID</div>
              <input class="sd-input" id="asana-workspace" placeholder="1234567890"/>
            </div>
            <div class="sd-field">
              <div class="sd-label">Project GID</div>
              <input class="sd-input" id="asana-project" placeholder="1234567890"/>
            </div>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary"   id="asana-save">Save</button>
            <button class="sd-btn secondary" id="asana-verify">Verify token</button>
          </div>
          <div id="asana-status" class="settings__status" style="display:none"></div>
        </div>

      </div>
      <!-- end sd-pane-integrations -->

      <!-- ══ TAB 3: Operators & SP ═════════════════════════════════════════ -->
      <div id="sd-pane-operators" style="display:none">

        <!-- Pane header -->
        <div class="ops-pane-header">
          <div class="ops-pane-header-left">
            <span class="ops-pane-title">Operators &amp; SharePoint</span>
            <span class="ops-pane-sub" id="ops-sync-meta">Run a sync to load operators</span>
          </div>
          <button class="ops-sync-btn" id="ops-sync-btn">↻ Sync Now</button>
        </div>

        <!-- Global Email SMTP (in Operators tab) -->
        <div class="sd-section">
          <div class="sd-section-title">
            Email – Global SMTP
            <span class="ops-autosave-badge" id="ops-email-badge"></span>
          </div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">Host</div>
              <input class="sd-input" id="ops-email-host" placeholder="smtp.corp.amazon.com"/>
            </div>
            <div class="sd-field">
              <div class="sd-label">Port</div>
              <input class="sd-input" id="ops-email-port" type="number" placeholder="587"/>
            </div>
          </div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">From address</div>
              <input class="sd-input" id="ops-email-from" type="email" placeholder="you@amazon.com"/>
            </div>
            <div class="sd-field">
              <div class="sd-label">Username</div>
              <input class="sd-input" id="ops-email-user" placeholder="LDAP / CORP\\user"/>
            </div>
          </div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">Password</div>
              <input class="sd-input" id="ops-email-pass" type="password" placeholder="(stored encrypted)"/>
            </div>
            <div class="sd-field" style="justify-content:flex-end;padding-top:18px">
              <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--txt2);cursor:pointer">
                <input type="checkbox" id="ops-email-tls" style="accent-color:var(--acc)"/> Use TLS
              </label>
            </div>
          </div>
          <div class="sd-btn-row" style="margin-top:4px">
            <button class="sd-btn secondary" id="ops-email-test-btn">Send test email</button>
            <div id="ops-email-test-form" style="display:none;gap:6px;align-items:center">
              <input class="sd-input" id="ops-email-test-to" type="email" placeholder="recipient@amazon.com" style="width:180px"/>
              <button class="sd-btn primary" id="ops-email-test-send">Send</button>
              <button class="sd-btn secondary" id="ops-email-test-cancel">Cancel</button>
            </div>
          </div>
        </div>

        <!-- SP section header -->
        <div class="ops-sp-section-header">
          <span class="ops-sp-section-label">SharePoint – Per Operator → Per Domicile</span>
          <span class="ops-sp-section-hint">Operators and domiciles populate automatically on sync</span>
        </div>

        <!-- Operator list (dynamic) -->
        <div class="ops-list" id="ops-list">
          <div class="ops-empty-state" id="ops-empty-state">
            <div class="ops-empty-icon">📋</div>
            <div class="ops-empty-title">No operators loaded yet</div>
            <div class="ops-empty-sub">Click <strong>↻ Sync Now</strong> above to pull operators and their domiciles from the fleet data source. SharePoint config will appear here automatically for each one.</div>
          </div>
        </div>

      </div>
      <!-- end sd-pane-operators -->

      <!-- ══ TAB 4: Accounts ════════════════════════════════════════════════ -->
      <div id="sd-pane-accounts" style="display:none">

        <!-- Header -->
        <div class="ops-pane-header">
          <div class="ops-pane-header-left">
            <span class="ops-pane-title">Accounts</span>
            <span class="ops-pane-sub">Site credentials – click a site name to open it</span>
          </div>
          <button class="ops-sync-btn" id="acct-add">+ Add account</button>
        </div>

        <!-- Account rows -->
        <div class="acct-list" id="acct-list">
          <div class="acct-empty" id="acct-empty">
            <span style="font-size:28px;opacity:.5">🔑</span>
            <div class="ops-empty-title">No accounts yet</div>
            <div class="ops-empty-sub">Click <strong>+ Add account</strong> to save a site credential.</div>
          </div>
        </div>

      </div>
      <!-- end sd-pane-accounts -->

    </div>
    <!-- end sd-body -->

  </div>
  <!-- end settings-drawer -->
  `}function co(){N.querySelectorAll(".sd-tab").forEach(e=>{e.addEventListener("click",()=>{N.querySelectorAll(".sd-tab").forEach(s=>s.classList.remove("active")),e.classList.add("active");const t=e.dataset.pane;["ui","integrations","operators","accounts"].forEach(s=>{const a=document.getElementById(`sd-pane-${s}`);a&&(a.style.display=s===t?"block":"none")})})})}function ro(){N.classList.add("open"),ms.classList.add("open"),Lo()}function Ha(){N.classList.remove("open"),ms.classList.remove("open")}function po(){document.getElementById("save-domiciles").addEventListener("click",async()=>{const t=document.getElementById("settings-domiciles").value.split(",").map(a=>a.trim()).filter(Boolean);await ee.save("domiciles",t);const s=document.getElementById("domicile-status");s.textContent="✓ Saved",s.style.display="block",setTimeout(()=>{s.style.display="none"},2e3)}),document.getElementById("reset-domiciles").addEventListener("click",async()=>{await ee.save("domiciles",[]),document.getElementById("settings-domiciles").value=""})}function As(){pa.checkMidway().then(e=>{const t=document.getElementById("auth-status");t&&(e?(t.textContent="✅ Authenticated",t.className="sd-status ok"):(t.textContent="⚠️ Not authenticated",t.className="sd-status warn"))}).catch(()=>{})}function uo(){As(),document.getElementById("auth-recheck").addEventListener("click",As),document.getElementById("auth-mwinit").addEventListener("click",()=>{pa.runMwinit().then(()=>As()).catch(()=>{})})}function vo(){document.getElementById("save-orcha").addEventListener("click",async()=>{await ee.save("orcha",{mode:document.getElementById("orcha-mode").value,host:document.getElementById("orcha-host").value.trim(),port:parseInt(document.getElementById("orcha-port").value,10)||4799}),h.show("success","Orcha config saved",2e3)})}function Bs(){Me.list().then(e=>{const t=document.getElementById("cred-list");if(!t)return;t.innerHTML="",(e||[]).forEach(a=>{const n=document.createElement("span");n.className="settings-key-pill",n.textContent=a,t.appendChild(n)});const s=document.getElementById("cred-list-wrap");s&&(s.style.display=e&&e.length?"block":"none")}).catch(()=>{})}function mo(){Bs(),document.getElementById("cred-save").addEventListener("click",async()=>{const e=document.getElementById("cred-key").value.trim(),t=document.getElementById("cred-val").value;if(!e)return;await Me.set(e,t),document.getElementById("cred-key").value="",document.getElementById("cred-val").value="",Bs();const s=document.getElementById("cred-status");s.textContent="✓ Saved",s.style.display="block",setTimeout(()=>{s.style.display="none"},2e3)}),document.getElementById("cred-delete").addEventListener("click",async()=>{const e=document.getElementById("cred-key").value.trim();e&&(await Me.delete(e),document.getElementById("cred-key").value="",Bs())})}function Ts(e,t){Me.has(`vendor.${e}.username`).then(s=>{const a=document.getElementById(t);a&&(a.textContent=s?"✅ Credentials saved":"⚠️ Not configured",a.style.display="block",a.className=`settings__status settings__status--${s?"ok":"loading"}`)}).catch(()=>{})}function fo(){["paccar","volvo","record360","aperia","reach24","dtna","roadready","velogic","abs"].forEach(t=>{Ts(t,`${t}-status`),ee.getAll().then(s=>{const a=document.getElementById(`${t}-user`);a&&s&&s[`${t}_user`]&&(a.value=s[`${t}_user`])}).catch(()=>{}),document.getElementById(`${t}-save`).addEventListener("click",async()=>{const s=document.getElementById(`${t}-user`).value.trim(),a=document.getElementById(`${t}-pass`).value;!s||!a||(await Me.set(`vendor.${t}.username`,s),await Me.set(`vendor.${t}.password`,a),await ee.save(`${t}_user`,s),document.getElementById(`${t}-pass`).value="",Ts(t,`${t}-status`))}),document.getElementById(`${t}-clear`).addEventListener("click",async()=>{await Me.delete(`vendor.${t}.username`),await Me.delete(`vendor.${t}.password`),await ee.save(`${t}_user`,""),document.getElementById(`${t}-user`).value="",document.getElementById(`${t}-pass`).value="",Ts(t,`${t}-status`)})})}function Ds(){ra.checkAuth().then(e=>{const t=document.getElementById("slack-status");t&&(t.textContent=e?"✅ Connected":"⚠️ Not connected",t.className=`sd-status ${e?"ok":"warn"}`)}).catch(()=>{})}function go(){Ds(),document.getElementById("slack-recheck").addEventListener("click",Ds),document.getElementById("slack-login").addEventListener("click",()=>{ra.login().then(()=>Ds()).catch(()=>{})})}function bo(){document.getElementById("email-save").addEventListener("click",async()=>{await we.saveConfig({host:document.getElementById("email-host").value.trim(),port:parseInt(document.getElementById("email-port").value,10)||587,from:document.getElementById("email-from").value.trim(),user:document.getElementById("email-user").value.trim(),pass:document.getElementById("email-pass").value}),document.getElementById("email-pass").value="";const e=document.getElementById("email-status");e.textContent="✓ Saved",e.style.display="block",setTimeout(()=>{e.style.display="none"},2e3)}),document.getElementById("email-test").addEventListener("click",()=>{h.show("info","Send test — not yet wired in bridge",3e3)})}function ho(){document.getElementById("ops-sync-btn").addEventListener("click",()=>{r.emit("ui:toast",{type:"info",message:"Syncing operators...",duration:2e3}),r.emit("sp:sync-request")}),["ops-email-host","ops-email-port","ops-email-from","ops-email-user","ops-email-pass","ops-email-tls"].forEach(e=>{const t=document.getElementById(e);t&&(t.addEventListener("change",()=>Wa()),t.addEventListener("input",()=>Wa()))}),document.getElementById("ops-email-test-btn").addEventListener("click",()=>{document.getElementById("ops-email-test-btn").style.display="none",document.getElementById("ops-email-test-form").style.display="flex"}),document.getElementById("ops-email-test-cancel").addEventListener("click",()=>{document.getElementById("ops-email-test-btn").style.display="flex",document.getElementById("ops-email-test-form").style.display="none"}),document.getElementById("ops-email-test-send").addEventListener("click",()=>{document.getElementById("ops-email-test-to").value.trim()&&h.show("info","Send test — not yet wired in bridge",3e3)}),ie.getConfig().then(e=>{if(e){if(e.emailHost){const t=document.getElementById("ops-email-host");t&&(t.value=e.emailHost)}if(e.emailPort){const t=document.getElementById("ops-email-port");t&&(t.value=e.emailPort)}if(e.emailFrom){const t=document.getElementById("ops-email-from");t&&(t.value=e.emailFrom)}if(e.emailUser){const t=document.getElementById("ops-email-user");t&&(t.value=e.emailUser)}if(e.emailTls!=null){const t=document.getElementById("ops-email-tls");t&&(t.checked=e.emailTls)}}}).catch(()=>{}),r.on("state:operators",e=>{ie.getConfig().then(t=>{za(e,t||{});const s=document.getElementById("ops-sync-meta");s&&(s.textContent=`${e.length} operator${e.length!==1?"s":""} loaded`)}).catch(()=>{za(e,{})})})}const ja={};function Wa(){const e=document.getElementById("ops-email-badge");e&&(e.textContent="saving...",e.className="ops-autosave-badge saving"),clearTimeout(ja.main),ja.main=setTimeout(async()=>{const t=await ie.getConfig().catch(()=>({}))||{};await ie.saveConfig({...t,emailHost:document.getElementById("ops-email-host").value.trim(),emailPort:parseInt(document.getElementById("ops-email-port").value,10)||587,emailFrom:document.getElementById("ops-email-from").value.trim(),emailUser:document.getElementById("ops-email-user").value.trim(),emailPass:document.getElementById("ops-email-pass").value,emailTls:document.getElementById("ops-email-tls").checked}).catch(()=>{}),e&&(e.textContent="✓ saved",e.className="ops-autosave-badge saved",setTimeout(()=>{e.textContent="",e.className="ops-autosave-badge"},3e3))},800)}async function yo(e,t,s,a){const n=await ie.getConfig().catch(()=>({}))||{},i=n.domiciles||{},l=`${e}__${t}`;return i[l]={siteUrl:s,listName:a},ie.saveConfig({...n,domiciles:i})}function za(e,t){const s=document.getElementById("ops-list"),a=document.getElementById("ops-empty-state");if(!s)return;if(!e||e.length===0){a&&(a.style.display="flex");return}a&&(a.style.display="none"),[...s.querySelectorAll(".ops-card")].forEach(l=>l.remove());const n=t&&t.domiciles?t.domiciles:{},i=t&&t.emails?t.emails:{};e.forEach(l=>{const o=document.createElement("div");o.className="ops-card";const d=document.createElement("div");d.className="ops-card-header",d.innerHTML=`
      <div class="ops-card-dot" style="background:var(--acc)"></div>
      <span class="ops-card-name">${_e(l.name)}</span>
      <span class="ops-card-meta">${(l.domiciles||[]).length} domicile(s)</span>
      <span class="ops-card-arrow">›</span>`,o.appendChild(d);const p=document.createElement("div");p.className="ops-card-body",p.style.display="none",(l.domiciles||[]).forEach(u=>{const c=`${l.name}__${u.code}`,v=n[c]||{},m=i[c]||{},g=v.siteUrl||u.spSite||"",x=v.listName||"",f=m.to||u.emailTo||"",w=m.cc||u.emailCc||"",b=document.createElement("div");b.className="ops-domicile";const I=g?"ok":"warn",H=g?"✓ SP":"⚠ SP",P=f?"ok":"warn",M=f?"✓ Email":"⚠ Email";b.innerHTML=`
        <div class="ops-dom-header">
          <span class="ops-dom-tag">${_e(u.code)}</span>
          <span class="ops-dom-count">${u.count||0} unit(s)</span>
          <span class="ops-dom-sp-status ${I}" data-sp-status>${H}</span>
          <span class="ops-dom-sp-status ${P}" data-em-status style="margin-left:4px">${M}</span>
        </div>

        <div class="ops-sp-fields">
          <div class="sd-section-label">SharePoint</div>
          <div class="sd-field">
            <div class="sd-label">Site URL</div>
            <input class="sd-input ops-sp-site" placeholder="https://amazon.sharepoint.com/sites/..." value="${_e(g)}"/>
          </div>
          <div class="sd-field">
            <div class="sd-label-row sd-label">
              List / Sheet
              <button class="ops-load-btn" type="button">Load lists</button>
            </div>
            <select class="sd-select ops-sp-list">
              <option value="">— select list —</option>
              ${x?`<option value="${_e(x)}" selected>${_e(x)}</option>`:""}
            </select>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary ops-sp-save" type="button">Save SP</button>
            <button class="sd-btn secondary ops-sp-push" type="button">Push now</button>
            <span class="ops-autosave-badge ops-sp-badge"></span>
          </div>
        </div>

        <div class="ops-email-fields" style="margin-top:10px">
          <div class="sd-section-label">Email recipients</div>
          <div class="sd-field">
            <div class="sd-label">To <span class="sd-label-hint">(semicolon-separated)</span></div>
            <input class="sd-input ops-em-to" type="email" multiple placeholder="manager@amazon.com;dsp@email.com" value="${_e(f)}"/>
          </div>
          <div class="sd-field">
            <div class="sd-label">CC <span class="sd-label-hint">(optional)</span></div>
            <input class="sd-input ops-em-cc" type="email" multiple placeholder="cc@amazon.com" value="${_e(w)}"/>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary ops-em-save" type="button">Save email</button>
            <span class="ops-autosave-badge ops-em-badge"></span>
          </div>
        </div>`,b.querySelector(".ops-sp-save").addEventListener("click",async()=>{const _=b.querySelector(".ops-sp-badge"),B=b.querySelector(".ops-sp-site").value.trim(),L=b.querySelector(".ops-sp-list").value;_.textContent="saving...",_.className="ops-autosave-badge saving";try{await yo(l.name,u.code,B,L);const k=b.querySelector("[data-sp-status]");k&&(k.textContent=B?"✓ SP":"⚠ SP",k.className=`ops-dom-sp-status ${B?"ok":"warn"}`),_.textContent="✓ saved",_.className="ops-autosave-badge saved",setTimeout(()=>{_.textContent="",_.className="ops-autosave-badge"},2500)}catch{_.textContent="✗ error",_.className="ops-autosave-badge saving",setTimeout(()=>{_.textContent="",_.className="ops-autosave-badge"},3e3)}}),b.querySelector(".ops-sp-push").addEventListener("click",async()=>{const _=b.querySelector(".ops-sp-site").value.trim(),B=b.querySelector(".ops-sp-push"),L=b.querySelector(".ops-sp-save"),k=b.querySelector(".ops-sp-badge");if(!_){h.show("warn",`${u.code}: set a SharePoint URL before pushing`,3e3);return}B.disabled=!0,L.disabled=!0,B.textContent="Pushing...",k.textContent="connecting...",k.className="ops-autosave-badge saving";const G=r.on("sp:progress",({message:j})=>{k.textContent=j.length>38?j.slice(0,35)+"...":j});try{const j=await ie.pushDomicile({opName:l.name,domCode:u.code});if(G(),!j||j.ok===!1){const Le=j&&j.error||"Push failed";k.textContent=`✗ ${Le}`,k.className="ops-autosave-badge saving",h.show("error",`${u.code}: ${Le}`,5e3)}else{const Le=`✓ ${j.pushed||0} new · ${j.updated||0} updated`;k.textContent=Le,k.className="ops-autosave-badge saved",h.show("info",`${u.code} pushed — ${Le.replace("✓ ","")}`,4e3)}setTimeout(()=>{k.textContent="",k.className="ops-autosave-badge"},5e3)}catch(j){G(),k.textContent="✗ error",k.className="ops-autosave-badge saving",h.show("error",`${u.code} push error: ${j.message||j}`,5e3),setTimeout(()=>{k.textContent="",k.className="ops-autosave-badge"},5e3)}finally{B.disabled=!1,L.disabled=!1,B.textContent="Push now"}}),b.querySelector(".ops-load-btn").addEventListener("click",async()=>{const _=b.querySelector(".ops-sp-site").value.trim(),B=b.querySelector(".ops-load-btn"),L=b.querySelector(".ops-sp-list"),k=L.value;if(!_){h.show("warn","Enter a SharePoint Site URL first",2500);return}B.disabled=!0,B.textContent="Loading...";try{const G=await ie.getLists(_);if(!G||G.error){h.show("error",`Could not load lists: ${G&&G.error||"unknown error"}`,4e3);return}if(!G.length){h.show("warn","No lists found for this site",3e3);return}L.innerHTML='<option value="">— select list —</option>',G.forEach(({title:j})=>{const Le=document.createElement("option");Le.value=j,Le.textContent=j,j===k&&(Le.selected=!0),L.appendChild(Le)}),h.show("info",`${G.length} list${G.length!==1?"s":""} loaded`,2e3)}catch(G){h.show("error",`Load lists failed: ${G.message||G}`,4e3)}finally{B.disabled=!1,B.textContent="Load lists"}}),b.querySelector(".ops-sp-site").addEventListener("input",function(){const _=b.querySelector("[data-sp-status]");if(_){const B=!!this.value.trim();_.textContent=B?"✓ SP":"⚠ SP",_.className=`ops-dom-sp-status ${B?"ok":"warn"}`}}),b.querySelector(".ops-em-save").addEventListener("click",async()=>{const _=b.querySelector(".ops-em-badge"),B=b.querySelector(".ops-em-to").value.trim(),L=b.querySelector(".ops-em-cc").value.trim();_.textContent="saving...",_.className="ops-autosave-badge saving";try{await wo(l.name,u.code,B,L);const k=b.querySelector("[data-em-status]");k&&(k.textContent=B?"✓ Email":"⚠ Email",k.className=`ops-dom-sp-status ${B?"ok":"warn"}`),_.textContent="✓ saved",_.className="ops-autosave-badge saved",setTimeout(()=>{_.textContent="",_.className="ops-autosave-badge"},2500)}catch{_.textContent="✗ error",_.className="ops-autosave-badge saving",setTimeout(()=>{_.textContent="",_.className="ops-autosave-badge"},3e3)}}),b.querySelector(".ops-em-to").addEventListener("input",function(){const _=b.querySelector("[data-em-status]");if(_){const B=!!this.value.trim();_.textContent=B?"✓ Email":"⚠ Email",_.className=`ops-dom-sp-status ${B?"ok":"warn"}`}}),p.appendChild(b)}),o.appendChild(p),d.addEventListener("click",()=>{const u=p.style.display!=="none";p.style.display=u?"none":"block",d.querySelector(".ops-card-arrow").style.transform=u?"":"rotate(90deg)"}),s.appendChild(o)})}async function wo(e,t,s,a){const n=await ie.getConfig().catch(()=>({}))||{},i=n.emails||{},l=`${e}__${t}`;return i[l]={to:s,cc:a},ie.saveConfig({...n,emails:i})}function _o(){document.getElementById("asana-save").addEventListener("click",async()=>{await js.saveConfig({pat:document.getElementById("asana-pat").value,workspace:document.getElementById("asana-workspace").value.trim(),project:document.getElementById("asana-project").value.trim()}),document.getElementById("asana-pat").value="";const e=document.getElementById("asana-status");e.textContent="✓ Saved",e.style.display="block",setTimeout(()=>{e.style.display="none"},2e3)}),document.getElementById("asana-verify").addEventListener("click",()=>{js.checkAuth().then(e=>{const t=document.getElementById("asana-status");t.textContent=e?"✅ Token valid":"❌ Token invalid",t.style.display="block"}).catch(()=>{})})}function ko(){["notif-auth-fail","notif-sync-ok","notif-sync-err"].forEach(e=>{const t=document.getElementById(e);t&&t.addEventListener("change",()=>{ee.save("notifications",{authFail:document.getElementById("notif-auth-fail").checked,syncOk:document.getElementById("notif-sync-ok").checked,syncErr:document.getElementById("notif-sync-err").checked}).catch(()=>{})})})}function xo(){ee.getAll().then(e=>{const t=e&&Array.isArray(e.accounts)?e.accounts:[];if(t.length>0){const s=document.getElementById("acct-empty");s&&(s.style.display="none"),t.forEach(a=>Va(a))}}).catch(()=>{}),document.getElementById("acct-add").addEventListener("click",()=>{Va();const e=document.getElementById("acct-list");if(e&&e.lastElementChild){const t=e.lastElementChild.querySelector(".acct-input.acct-name");t&&t.focus()}})}function Va(e={}){const t=document.getElementById("acct-empty");t&&(t.style.display="none");const s=document.getElementById("acct-list"),a="acct-"+Date.now(),n=document.createElement("div");n.className="acct-row",n.id=a;const i=e.url||"",l=e.name||"",o=e.user||"";n.innerHTML=`
    <div class="acct-cell acct-cell-site">
      <input class="acct-input acct-url"  type="url"  placeholder="https://..."     value="${_e(i)}"  title="Site URL"/>
      <input class="acct-input acct-name" type="text" placeholder="Site name"       value="${_e(l)}" title="Display name"/>
      <a class="acct-link" href="${_e(i)||"#"}" title="Open site" style="${i?"":"display:none"}" target="_blank">🔗</a>
    </div>
    <div class="acct-cell acct-cell-user">
      <input class="acct-input" type="text" placeholder="username / email" value="${_e(o)}"/>
    </div>
    <div class="acct-cell acct-cell-pass">
      <input class="acct-input acct-pass" type="password" placeholder="password"/>
      <button class="acct-eye" type="button" title="Show/hide">👁️</button>
    </div>
    <div class="acct-cell acct-cell-actions">
      <span class="acct-save-badge" id="badge-${a}"></span>
      <button class="acct-del" type="button" title="Remove">🗑</button>
    </div>`,n.querySelector(".acct-url").addEventListener("input",function(){const d=n.querySelector(".acct-link"),p=this.value.trim();d.href=p||"#",d.style.display=p?"":"none",Ps(n)}),n.querySelectorAll(".acct-input.acct-name, .acct-cell-user .acct-input").forEach(d=>{d.addEventListener("input",()=>Ps(n))}),n.querySelector(".acct-pass").addEventListener("input",()=>Ps(n)),n.querySelector(".acct-eye").addEventListener("click",function(){const d=n.querySelector(".acct-pass");d.type=d.type==="password"?"text":"password",this.textContent=d.type==="password"?"👁️":"🙈"}),n.querySelector(".acct-del").addEventListener("click",()=>{if(n.remove(),!document.querySelectorAll("#acct-list .acct-row").length){const d=document.getElementById("acct-empty");d&&(d.style.display="flex")}En()}),s.appendChild(n)}const Fa={};function Ps(e){const t=e.querySelector(".acct-save-badge");t&&(t.textContent="saving...",t.className="acct-save-badge saving"),clearTimeout(Fa[e.id]),Fa[e.id]=setTimeout(()=>{En(),t&&(t.textContent="✅",t.className="acct-save-badge saved",setTimeout(()=>{t.textContent="",t.className="acct-save-badge"},2e3))},700)}function En(){const e=[...document.querySelectorAll("#acct-list .acct-row")].map(t=>{var s,a,n;return{name:(((s=t.querySelector(".acct-name"))==null?void 0:s.value)||"").trim(),url:(((a=t.querySelector(".acct-url"))==null?void 0:a.value)||"").trim(),user:(((n=t.querySelector(".acct-cell-user .acct-input"))==null?void 0:n.value)||"").trim()}}).filter(t=>t.name||t.url||t.user);ee.save("accounts",e).catch(()=>{})}function Eo(){N.querySelectorAll(".sd-template").forEach(n=>{n.addEventListener("click",()=>{N.querySelectorAll(".sd-template").forEach(l=>{l.classList.remove("active"),l.querySelector(".sd-tpl-check").style.display="none"}),n.classList.add("active"),n.querySelector(".sd-tpl-check").style.display="";const i=n.dataset.theme;document.body.classList.remove("light-mode","midnight-mode","ocean-mode"),i!=="dark"&&document.body.classList.add(`${i}-mode`),pt()})}),N.querySelectorAll(".sd-swatch").forEach(n=>{n.addEventListener("click",()=>{const i=n.dataset.var;i&&(N.querySelectorAll(`.sd-swatch[data-var="${i}"]`).forEach(l=>l.classList.remove("active")),n.classList.add("active"),document.documentElement.style.setProperty(i,n.style.background),pt())})}),N.querySelectorAll(".sd-color-custom").forEach(n=>{n.addEventListener("input",()=>{n.dataset.var&&document.documentElement.style.setProperty(n.dataset.var,n.value),pt()})}),[{id:"sl-opacity",valId:"sl-opacity-val",suffix:"%"},{id:"sl-blur",valId:"sl-blur-val",suffix:"px"},{id:"sl-speed",valId:"sl-speed-val",suffix:"ms",cssVar:"--sd-speed"},{id:"sl-radius",valId:"sl-radius-val",suffix:"px",cssVar:"--r"}].forEach(({id:n,valId:i,suffix:l,cssVar:o})=>{const d=document.getElementById(n),p=document.getElementById(i);!d||!p||d.addEventListener("input",()=>{p.textContent=d.value+l,o&&document.documentElement.style.setProperty(o,d.value+l),pt()})});const t=document.getElementById("sl-sla-target"),s=document.getElementById("sl-sla-target-val");if(t&&s){const n=parseInt(localStorage.getItem("fleet_sla_target")||"5",10)||5;t.value=n,s.textContent=n+"d",t.addEventListener("input",()=>{const i=parseInt(t.value,10);s.textContent=i+"d",localStorage.setItem("fleet_sla_target",String(i)),r.emit("settings:sla-target",{days:i})})}N.querySelectorAll(".sd-font-btn").forEach(n=>{n.addEventListener("click",()=>{N.querySelectorAll(".sd-font-btn").forEach(l=>l.classList.remove("active")),n.classList.add("active");const i={system:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',serif:"Georgia,serif",mono:'"SFMono-Regular",Consolas,"Liberation Mono",monospace',inter:'"Inter",sans-serif'};document.documentElement.style.setProperty("--font",i[n.dataset.font]||i.system),pt()})});const a=document.getElementById("toggle-compact");a&&a.addEventListener("change",pt),So()}function So(){const e=Da(),t=document.getElementById("nx-preset-grid");t&&t.querySelectorAll(".nx-preset-chip").forEach(c=>{c.dataset.preset===e.preset?c.classList.add("nx-preset-chip--active"):c.classList.remove("nx-preset-chip--active"),c.addEventListener("click",()=>{t.querySelectorAll(".nx-preset-chip").forEach(m=>m.classList.remove("nx-preset-chip--active")),c.classList.add("nx-preset-chip--active"),Zi(c.dataset.preset);const v=Vt[c.dataset.preset];if(v){const m=document.getElementById("nx-accent-picker"),g=document.getElementById("nx-accent-hex");m&&(m.value=v.accent),g&&(g.textContent=v.accent)}})});const s=document.getElementById("nx-accent-picker"),a=document.getElementById("nx-accent-hex");s&&(s.value=e.accent||"#00d4ff",a&&(a.textContent=e.accent||"#00d4ff"),s.addEventListener("input",()=>{He("accent",s.value),a&&(a.textContent=s.value)}));const n=document.getElementById("nx-accent-reset");n&&n.addEventListener("click",()=>{const c=Vt[Da().preset],v=c?c.accent:"#00d4ff";He("accent",v),s&&(s.value=v),a&&(a.textContent=v)}),N.querySelectorAll("[data-density]").forEach(c=>{c.dataset.density===e.density?c.classList.add("nx-preset-chip--active"):c.classList.remove("nx-preset-chip--active"),c.addEventListener("click",()=>{N.querySelectorAll("[data-density]").forEach(v=>v.classList.remove("nx-preset-chip--active")),c.classList.add("nx-preset-chip--active"),He("density",c.dataset.density)})}),N.querySelectorAll("[data-anim]").forEach(c=>{c.dataset.anim===e.animSpeed?c.classList.add("nx-preset-chip--active"):c.classList.remove("nx-preset-chip--active"),c.addEventListener("click",()=>{N.querySelectorAll("[data-anim]").forEach(v=>v.classList.remove("nx-preset-chip--active")),c.classList.add("nx-preset-chip--active"),He("animSpeed",c.dataset.anim)})});const i=document.getElementById("nx-blur"),l=document.getElementById("nx-blur-val");i&&(i.value=e.blur||20,l&&(l.textContent=(e.blur||20)+"px"),i.addEventListener("input",()=>{const c=parseInt(i.value,10);l&&(l.textContent=c+"px"),He("blur",c)}));const o=document.getElementById("nx-glow"),d=document.getElementById("nx-glow-val");o&&(o.value=(e.glowIntensity||1)*100,d&&(d.textContent=Math.round((e.glowIntensity||1)*100)+"%"),o.addEventListener("input",()=>{const c=parseInt(o.value,10);d&&(d.textContent=c+"%"),He("glowIntensity",c/100)}));const p=document.getElementById("nx-bg-gradient");p&&(p.checked=e.bgGradient!==!1,p.addEventListener("change",()=>He("bgGradient",p.checked)));const u=document.getElementById("nx-grid-lines");u&&(u.checked=e.gridLines!==!1,u.addEventListener("change",()=>He("gridLines",u.checked)))}let Ga=null;function pt(){clearTimeout(Ga),Ga=setTimeout(()=>{let e="dark";document.body.classList.contains("light-mode")&&(e="light"),document.body.classList.contains("midnight-mode")&&(e="midnight"),document.body.classList.contains("ocean-mode")&&(e="ocean");const t=["--acc","--bg","--panel","--txt","--row-avail","--row-unavail"],s={};t.forEach(p=>{const u=N.querySelector(`.sd-swatch.active[data-var="${p}"]`);u&&(s[p]=u.style.background)});const a=["sl-opacity","sl-blur","sl-speed","sl-radius"],n={};a.forEach(p=>{const u=document.getElementById(p);u&&(n[p]=u.value)});const i=N.querySelector(".sd-font-btn.active"),l=i?i.dataset.font:"system",o=document.getElementById("toggle-compact"),d=o?o.checked:!1;ee.save("ui_prefs",{theme:e,swatches:s,sliders:n,font:l,compactRows:d}).catch(()=>{})},400)}function Sn(e){if(!e)return;const t={system:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',serif:"Georgia,serif",mono:'"SFMono-Regular",Consolas,"Liberation Mono",monospace',inter:'"Inter",sans-serif'};if(e.theme&&(document.body.classList.remove("light-mode","midnight-mode","ocean-mode"),e.theme!=="dark"&&document.body.classList.add(`${e.theme}-mode`),N.querySelectorAll(".sd-template").forEach(s=>{const a=s.dataset.theme===e.theme;s.classList.toggle("active",a),s.querySelector(".sd-tpl-check").style.display=a?"":"none"})),e.swatches&&Object.entries(e.swatches).forEach(([s,a])=>{document.documentElement.style.setProperty(s,a),N.querySelectorAll(`.sd-swatch[data-var="${s}"]`).forEach(n=>{n.classList.toggle("active",n.style.background===a)})}),e.sliders&&[{id:"sl-opacity",valId:"sl-opacity-val",suffix:"%"},{id:"sl-blur",valId:"sl-blur-val",suffix:"px"},{id:"sl-speed",valId:"sl-speed-val",suffix:"ms",cssVar:"--sd-speed"},{id:"sl-radius",valId:"sl-radius-val",suffix:"px",cssVar:"--r"}].forEach(({id:a,valId:n,suffix:i,cssVar:l})=>{const o=e.sliders[a];if(o==null)return;const d=document.getElementById(a),p=document.getElementById(n);d&&(d.value=o),p&&(p.textContent=o+i),l&&document.documentElement.style.setProperty(l,o+i)}),e.font&&(N.querySelectorAll(".sd-font-btn").forEach(s=>{s.classList.toggle("active",s.dataset.font===e.font)}),document.documentElement.style.setProperty("--font",t[e.font]||t.system)),e.compactRows!=null){const s=document.getElementById("toggle-compact");s&&(s.checked=e.compactRows)}}function Lo(){ee.getAll().then(e=>{if(e){if(e.ui_prefs&&Sn(e.ui_prefs),e.domiciles){const t=document.getElementById("settings-domiciles");t&&(t.value=Array.isArray(e.domiciles)?e.domiciles.join(", "):e.domiciles)}if(e.orcha){const t=e.orcha,s=document.getElementById("orcha-mode"),a=document.getElementById("orcha-host"),n=document.getElementById("orcha-port");s&&t.mode&&(s.value=t.mode),a&&t.host&&(a.value=t.host),n&&t.port&&(n.value=t.port)}if(e.email){const t=e.email;["host","port","from","user"].forEach(s=>{const a=document.getElementById(`email-${s}`);a&&t[s]!=null&&(a.value=t[s])})}if(e.asana){const t=e.asana;if(t.workspace){const s=document.getElementById("asana-workspace");s&&(s.value=t.workspace)}if(t.project){const s=document.getElementById("asana-project");s&&(s.value=t.project)}}if(e.notifications){const t=e.notifications,s=document.getElementById("notif-auth-fail"),a=document.getElementById("notif-sync-ok"),n=document.getElementById("notif-sync-err");s&&t.authFail!=null&&(s.checked=t.authFail),a&&t.syncOk!=null&&(a.checked=t.syncOk),n&&t.syncErr!=null&&(n.checked=t.syncErr)}}}).catch(()=>{})}function Co(){ee.getAll().then(e=>{e&&e.ui_prefs&&N&&Sn(e.ui_prefs)}).catch(()=>{})}function _e(e){return String(e||"").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;")}function Io(){const e=document.createElement("div");e.id="settings-drawer-wrap",e.innerHTML=oo(),document.body.appendChild(e),N=document.getElementById("settings-drawer"),ms=document.getElementById("sd-overlay"),document.getElementById("sd-close-btn").addEventListener("click",Ha),ms.addEventListener("click",Ha),co(),Eo(),po(),uo(),vo(),mo(),fo(),go(),bo(),ho(),_o(),ko(),xo(),r.on("ui:view-change",({to:t})=>{t==="settings"&&ro()}),ee.getAll().then(t=>{var s;(s=t==null?void 0:t.ui_prefs)!=null&&s.swatches&&Object.entries(t.ui_prefs.swatches).forEach(([a,n])=>{n&&document.documentElement.style.setProperty(a,n)})}).catch(()=>{})}const $o=[{h:7,m:30,label:"07:30"},{h:15,m:30,label:"15:30"}],Ao=[{h:8,m:0,label:"08:00"},{h:15,m:15,label:"15:15"}];let Be=$o.map(e=>({...e})),Te=Ao.map(e=>({...e}));function Ln(){return[...Be.map(e=>({...e,type:"sp"})),...Te.map(e=>({...e,type:"email"}))].sort((e,t)=>e.h*60+e.m-(t.h*60+t.m))}const Zs=20,Cn="vc_scheduler_log";let F=null,ns=null,Oe=[],Ue=!1,ce=null,Re=null;function Bo(){try{Oe=JSON.parse(localStorage.getItem(Cn)||"[]")}catch{Oe=[]}}function In(){try{localStorage.setItem(Cn,JSON.stringify(Oe.slice(0,Zs)))}catch{}}function he(e){Oe.unshift({ts:Date.now(),...e}),Oe.length>Zs&&(Oe.length=Zs),In(),ka()}const fs=e=>String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");function ha(e){if(!e)return"—";const t=e instanceof Date?e:new Date(e);return t.toLocaleDateString("en-US",{month:"short",day:"numeric"})+" "+t.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:!1})}function is(){const e=new Date().getDay();return e>=1&&e<=5}function ya(e,t){const s=new Date;let a=e*60+t-(s.getHours()*60+s.getMinutes());return a<=0&&(a+=1440),a}function To(){let e=null;for(const t of Ln()){const s=ya(t.h,t.m);(!e||s<e.minsUntil)&&(e={slot:t,minsUntil:s})}return e}function wa(e){if(e<0)return"—";const t=Math.floor(e/60),s=e%60;return t>0?t+"h "+s+"m":s+"m"}function $n(e){return e==="sp"?"📤":"📧"}function An(e){return e==="sp"?"SP Push":"Auto Email"}function Bn(e){const s={ok:"ok",error:"err",running:"run",skipped:"skip"}[e]||"idle",a=(e||"idle").toUpperCase();return'<span class="sched-badge sched-badge--'+s+'">'+a+"</span>"}function Do(e,t){const s=new Date,a=s.getHours()*60+s.getMinutes(),n=e.h*60+e.m,i=n<a,l=!i&&n-a<=30,o=is()?i?"past":l?"soon":"upcoming":"weekend",d=is()?i&&t?"ok":i?"idle":l?"run":"idle":"skip",p=is()?i&&t?"DONE":i?"MISSED":l?"SOON":"PENDING":"WEEKEND";return'<div class="sched-slot sched-slot--'+o+'"><div class="sched-slot__time">'+fs(e.label)+'</div><div class="sched-slot__type">'+$n(e.type)+" "+An(e.type)+'</div><div class="sched-slot__last">Last: '+fs(t?ha(t.ts):"—")+'</div><span class="sched-badge sched-badge--'+d+'">'+p+"</span></div>"}function Po(){return`<div class="sched-view" id="sched-view"><div class="sched-header"><div class="sched-header__left"><div class="sched-title"><span>⏱</span> Schedulers</div><div class="sched-subtitle" id="sched-weekday-badge">—</div></div><div class="sched-header__right"><div class="sched-clock" id="sched-clock">—</div><button class="sched-btn sched-btn--back" id="sched-back">← Fleet</button></div></div><div class="sched-next-banner"><span class="sched-next-banner__label">Next slot:</span><span class="sched-next-banner__slot" id="sched-next-slot">—</span><span class="sched-next-banner__in">in</span><span class="sched-next-banner__countdown" id="sched-next-countdown">—</span></div><div class="sched-grid"><div class="sched-card" id="sched-card-sp"><div class="sched-card__head"><div class="sched-card__icon sched-card__icon--sp">📤</div><div><div class="sched-card__title">SharePoint Push</div><div class="sched-card__sub" id="sched-sp-sub">Weekdays —</div></div><div class="sched-card__badge" id="sched-sp-badge">—</div></div><div class="sched-card__meta"><div class="sched-card__meta-item"><span class="sched-card__meta-label">Last run</span><span class="sched-card__meta-val" id="sched-sp-last">—</span></div><div class="sched-card__meta-item"><span class="sched-card__meta-label">Next</span><span class="sched-card__meta-val" id="sched-sp-next">—</span></div><div class="sched-card__meta-item"><span class="sched-card__meta-label">Status</span><span class="sched-card__meta-val" id="sched-sp-status">—</span></div></div><div class="sched-card__progress" id="sched-sp-progress" style="display:none"><div class="sched-progress-bar" id="sched-sp-bar"></div><div class="sched-progress-msg" id="sched-sp-msg">—</div></div><div class="sched-time-editor"><span class="sched-time-editor__label">AM slot</span><input class="sched-time-input" type="time" id="sched-sp-am" /><span class="sched-time-editor__label">PM slot</span><input class="sched-time-input" type="time" id="sched-sp-pm" /><button class="sched-btn sched-btn--save" id="sched-sp-save">✓ Save times</button></div><div class="sched-card__actions"><button class="sched-btn sched-btn--primary" id="sched-sp-trigger">📤 Run SP Push Now</button><button class="sched-btn sched-btn--ghost" id="sched-sp-sync">🔄 Sync Only</button></div></div><div class="sched-card" id="sched-card-email"><div class="sched-card__head"><div class="sched-card__icon sched-card__icon--email">📧</div><div><div class="sched-card__title">Auto Email</div><div class="sched-card__sub" id="sched-em-sub">Weekdays —</div></div><div class="sched-card__badge" id="sched-em-badge">—</div></div><div class="sched-card__meta"><div class="sched-card__meta-item"><span class="sched-card__meta-label">Last run</span><span class="sched-card__meta-val" id="sched-em-last">—</span></div><div class="sched-card__meta-item"><span class="sched-card__meta-label">Next</span><span class="sched-card__meta-val" id="sched-em-next">—</span></div><div class="sched-card__meta-item"><span class="sched-card__meta-label">Status</span><span class="sched-card__meta-val" id="sched-em-status">—</span></div></div><div class="sched-time-editor"><span class="sched-time-editor__label">AM slot</span><input class="sched-time-input" type="time" id="sched-em-am" /><span class="sched-time-editor__label">PM slot</span><input class="sched-time-input" type="time" id="sched-em-pm" /><button class="sched-btn sched-btn--save" id="sched-em-save">✓ Save times</button></div><div class="sched-card__note">Auto-email fires at scheduled slots — no manual trigger needed. Use the Email Composer for ad-hoc sends.</div></div></div><div class="sched-section"><div class="sched-section__title">Today's Schedule</div><div class="sched-timeline" id="sched-timeline"></div></div><div class="sched-section"><div class="sched-section__head"><div class="sched-section__title">Run Log</div><button class="sched-btn sched-btn--ghost sched-btn--sm" id="sched-clear-log">Clear</button></div><div class="sched-log" id="sched-log"></div></div></div>`}const Ro=[".view--schedulers{flex:1;overflow-y:auto;padding:16px 20px 32px;display:flex;flex-direction:column;gap:14px}",".sched-view{display:flex;flex-direction:column;gap:14px;max-width:860px;width:100%}",".sched-header{display:flex;align-items:center;justify-content:space-between;gap:12px}",".sched-header__left,.sched-header__right{display:flex;align-items:center;gap:12px}",".sched-title{font-size:15px;font-weight:700;color:var(--txt);display:flex;align-items:center;gap:7px}",".sched-subtitle{font-family:var(--mono);font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:3px 9px;border-radius:5px;font-weight:700}",".sched-subtitle.weekday{color:var(--grn);background:var(--grnd);border:1px solid rgba(126,231,135,.2)}",".sched-subtitle.weekend{color:var(--mut);background:var(--el);border:1px solid var(--bdr)}",".sched-clock{font-family:var(--mono);font-size:13px;color:var(--txt2)}",".sched-next-banner{display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--adim);border:1px solid rgba(88,166,255,.2);border-radius:8px;font-size:11px}",".sched-next-banner__label{color:var(--txt2)}.sched-next-banner__slot{font-family:var(--mono);font-weight:700;color:var(--acc2)}",".sched-next-banner__in{color:var(--txt2)}.sched-next-banner__countdown{font-family:var(--mono);font-weight:800;font-size:13px;color:var(--acc)}",".sched-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}",".sched-card{background:var(--card);border:1px solid var(--bdr);border-radius:var(--r);padding:16px;display:flex;flex-direction:column;gap:12px;transition:border-color .2s}",".sched-card:hover{border-color:var(--bdrs)}.sched-card.running{border-color:var(--acc);box-shadow:0 0 0 2px rgba(88,166,255,.12)}",".sched-card__head{display:flex;align-items:flex-start;gap:10px}",".sched-card__icon{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}",".sched-card__icon--sp{background:var(--adim)}.sched-card__icon--email{background:rgba(126,231,135,.12)}",".sched-card__title{font-size:13px;font-weight:700;color:var(--txt)}.sched-card__sub{font-size:10px;color:var(--txt2);margin-top:2px;font-family:var(--mono)}",".sched-card__badge{margin-left:auto}",".sched-card__meta{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}",".sched-card__meta-item{display:flex;flex-direction:column;gap:2px}",".sched-card__meta-label{font-size:9px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px}",".sched-card__meta-val{font-family:var(--mono);font-size:11px;color:var(--txt2);font-weight:600}",".sched-card__progress{display:flex;flex-direction:column;gap:5px}",".sched-progress-bar{height:3px;background:var(--acc);border-radius:2px;width:0%;transition:width .4s ease;animation:sched-pulse 1.5s ease-in-out infinite}","@keyframes sched-pulse{0%,100%{opacity:1}50%{opacity:.5}}",".sched-progress-msg{font-size:10px;color:var(--acc2);font-family:var(--mono)}",".sched-card__note{font-size:10px;color:var(--txt2);line-height:1.6;padding:8px 10px;background:var(--el);border-radius:6px;border-left:3px solid var(--grn)}",".sched-card__actions{display:flex;gap:8px}",".sched-btn{padding:7px 13px;border-radius:7px;font-size:11px;font-weight:600;border:1px solid var(--bdr);background:var(--el);color:var(--txt);cursor:pointer;transition:all .2s;display:flex;align-items:center;gap:5px}",".sched-btn:hover{border-color:var(--acc);background:var(--adim)}",".sched-btn--primary{background:var(--adim);border-color:var(--acc);color:var(--acc2)}.sched-btn--primary:hover{background:rgba(88,166,255,.2)}",".sched-btn--primary:disabled{opacity:.45;cursor:not-allowed}",".sched-btn--ghost{background:transparent;color:var(--txt2)}.sched-btn--ghost:hover{color:var(--txt);background:var(--el)}",".sched-btn--back{font-size:10px;padding:5px 10px}.sched-btn--sm{font-size:9px;padding:3px 8px}",".sched-badge{font-family:var(--mono);font-size:8px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;padding:2px 7px;border-radius:4px;white-space:nowrap}",".sched-badge--ok{background:var(--grnd);color:var(--grn);border:1px solid rgba(126,231,135,.25)}",".sched-badge--err{background:var(--redd);color:var(--red);border:1px solid rgba(255,123,114,.25)}",".sched-badge--run{background:var(--adim);color:var(--acc2);border:1px solid rgba(88,166,255,.3);animation:sched-pulse 1s infinite}",".sched-badge--skip,.sched-badge--idle{background:var(--el);border:1px solid var(--bdr)}",".sched-badge--skip{color:var(--mut)}.sched-badge--idle{color:var(--txt2)}",".sched-section{display:flex;flex-direction:column;gap:8px}",".sched-section__head{display:flex;align-items:center;justify-content:space-between}",".sched-section__title{font-family:var(--mono);font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--mut);font-weight:700;display:flex;align-items:center;gap:8px}",'.sched-section__title::before{content:"";width:10px;height:1px;background:var(--acc)}',".sched-timeline{display:flex;flex-direction:column;gap:5px}",".sched-slot{display:flex;align-items:center;gap:12px;padding:9px 14px;border-radius:8px;border:1px solid var(--bdr);background:var(--card);transition:all .2s}",".sched-slot--past{opacity:.55}.sched-slot--soon{border-color:var(--acc);background:var(--adim)}",".sched-slot--upcoming{opacity:.8}.sched-slot--weekend{opacity:.4}",".sched-slot__time{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--txt);width:48px}",".sched-slot__type{font-size:11px;color:var(--txt2);flex:1}.sched-slot__last{font-family:var(--mono);font-size:9px;color:var(--mut)}",".sched-log{background:var(--card);border:1px solid var(--bdr);border-radius:var(--r);overflow:hidden;max-height:240px;overflow-y:auto}",".sched-log-empty{padding:18px;text-align:center;font-size:11px;color:var(--mut)}",".sched-log-row{display:flex;align-items:flex-start;gap:10px;padding:8px 14px;border-bottom:1px solid rgba(48,54,61,.5);font-size:11px}",".sched-log-row:last-child{border-bottom:none}.sched-log-row:hover{background:var(--hov)}",".sched-log-ts{font-family:var(--mono);font-size:9px;color:var(--mut);white-space:nowrap;width:80px}",".sched-log-icon{font-size:12px;flex-shrink:0}",".sched-log-msg{color:var(--txt2);line-height:1.4;flex:1}.sched-log-msg.ok{color:var(--grn)}.sched-log-msg.err{color:var(--red)}",".sched-time-editor{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--el);border-radius:7px;flex-wrap:wrap}",".sched-time-editor__label{font-size:9px;color:var(--mut);text-transform:uppercase;letter-spacing:.5px;font-weight:700}",".sched-time-input{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--txt);background:var(--card);border:1px solid var(--bdr);border-radius:5px;padding:4px 8px;width:90px}",".sched-time-input:focus{outline:none;border-color:var(--acc)}",".sched-btn--save{background:var(--adim);border-color:var(--acc);color:var(--acc2);margin-left:auto}",".sched-btn--save:hover{background:rgba(88,166,255,.2)}"].join(`
`);let Xa=!1;function Mo(){if(Xa)return;const e=document.createElement("style");e.textContent=Ro,document.head.appendChild(e),Xa=!0}function A(e){return F?F.querySelector("#"+e):null}function Tn(){const e=A("sched-clock"),t=A("sched-weekday-badge");if(!e||!t)return;e.textContent=new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:!1});const s=is();t.textContent=s?"● Weekday — Schedulers Active":"● Weekend — Schedulers Paused",t.className="sched-subtitle "+(s?"weekday":"weekend")}function Dn(){const e=To();if(!e)return;const t=A("sched-next-slot"),s=A("sched-next-countdown");t&&(t.textContent=$n(e.slot.type)+" "+An(e.slot.type)+" @ "+e.slot.label),s&&(s.textContent=wa(e.minsUntil))}function Xt(){const e=Be.map(l=>({...l,mu:ya(l.h,l.m)})).sort((l,o)=>l.mu-o.mu)[0],t=A("sched-sp-badge"),s=A("sched-sp-last"),a=A("sched-sp-next"),n=A("sched-sp-status");t&&(t.innerHTML=Bn(Ue?"running":ce?ce.status:null)),s&&(s.textContent=ce?ha(ce.ts):"—"),a&&(a.textContent=e.label+" (in "+wa(e.mu)+")"),n&&(n.textContent=Ue?"Running...":ce?ce.msg:"—");const i=A("sched-sp-trigger");i&&(i.disabled=Ue)}function _a(){const e=Te.map(i=>({...i,mu:ya(i.h,i.m)})).sort((i,l)=>i.mu-l.mu)[0],t=A("sched-em-badge"),s=A("sched-em-last"),a=A("sched-em-next"),n=A("sched-em-status");t&&(t.innerHTML=Bn(Re?Re.status:null)),s&&(s.textContent=Re?ha(Re.ts):"—"),a&&(a.textContent=e.label+" (in "+wa(e.mu)+")"),n&&(n.textContent=Re?Re.msg:"—")}function Pn(){const e=A("sched-timeline");e&&(e.innerHTML=Ln().map(t=>Do(t,t.type==="sp"?ce:Re)).join(""))}function ka(){const e=A("sched-log");if(e){if(!Oe.length){e.innerHTML='<div class="sched-log-empty">No runs recorded yet.</div>';return}e.innerHTML=Oe.map(t=>{const s=new Date(t.ts),a=String(s.getHours()).padStart(2,"0")+":"+String(s.getMinutes()).padStart(2,"0")+":"+String(s.getSeconds()).padStart(2,"0"),n=t.type==="sp"?"📤":t.type==="email"?"📧":"🔄",i=t.status==="ok"?"ok":t.status==="error"?"err":"";return'<div class="sched-log-row"><span class="sched-log-ts">'+fs(a)+'</span><span class="sched-log-icon">'+n+'</span><span class="sched-log-msg '+i+'">'+fs(t.msg||"")+"</span></div>"}).join("")}}function Rs(){Tn(),Dn(),Xt(),_a(),Pn(),ka()}function qo(e){const t=e.message||"",s=/complete|done|success|error|fail/i.test(t);if(!Ue){Ue=!0;const l=F&&F.querySelector("#sched-card-sp");l&&l.classList.add("running")}const a=A("sched-sp-progress"),n=A("sched-sp-bar"),i=A("sched-sp-msg");if(a&&(a.style.display="flex"),i&&(i.textContent=t),n){const l=parseFloat(n.style.width)||0;n.style.width=(s?100:Math.min(l+8,80))+"%"}if(he({type:"sp",msg:t,status:s?"ok":"running"}),s){Ue=!1,ce={ts:Date.now(),status:"ok",msg:t};const l=F&&F.querySelector("#sched-card-sp");l&&l.classList.remove("running"),setTimeout(()=>{a&&(a.style.display="none"),n&&(n.style.width="0%")},2e3)}Xt()}async function Oo(){if(!Ue){he({type:"sp",msg:"Manual SP push triggered",status:"running"});try{const e=E.slice("fleet").rows||[];if(!e.length){he({type:"sync",msg:"No fleet data — requesting sync first",status:"running"}),window.fleet&&window.fleet.requestSync&&window.fleet.requestSync();return}Ue=!0,Xt();const t=await window.sp.push(e),s=t&&t.ok!==!1;ce={ts:Date.now(),status:s?"ok":"error",msg:t&&t.message||(s?"SP push complete":"SP push failed")},he({type:"sp",msg:ce.msg,status:ce.status})}catch(e){ce={ts:Date.now(),status:"error",msg:"SP push failed: "+e.message},he({type:"sp",msg:ce.msg,status:"error"})}finally{Ue=!1,Xt()}}}function Uo(){he({type:"sync",msg:"Manual sync requested",status:"running"}),window.fleet&&window.fleet.requestSync&&window.fleet.requestSync()}function No(){Rn(),ns=setInterval(()=>{F&&F.style.display!=="none"&&(Tn(),Dn(),Xt(),_a(),Pn())},1e3)}function Rn(){ns&&(clearInterval(ns),ns=null)}async function Ja(){try{const e=await ee.getScheduleSlots();e&&Array.isArray(e.sp)&&Array.isArray(e.email)&&(Be=e.sp,Te=e.email)}catch{}}function Ka(e){const[t,s]=(e||"").split(":").map(Number);return{h:t||0,m:s||0}}function Ya(e){return String(e).padStart(2,"0")}function bt(e,t){return Ya(e)+":"+Ya(t)}function Qa(){const e=A("sched-sp-am"),t=A("sched-sp-pm"),s=A("sched-em-am"),a=A("sched-em-pm");e&&(e.value=bt(Be[0].h,Be[0].m)),t&&(t.value=bt(Be[1].h,Be[1].m)),s&&(s.value=bt(Te[0].h,Te[0].m)),a&&(a.value=bt(Te[1].h,Te[1].m))}function ea(){const e=A("sched-sp-sub"),t=A("sched-em-sub");e&&(e.textContent="Weekdays "+Be.map(s=>s.label).join(" · ")),t&&(t.textContent="Weekdays "+Te.map(s=>s.label).join(" · "))}async function Za(e){const t=e==="sp"?"sched-sp-am":"sched-em-am",s=e==="sp"?"sched-sp-pm":"sched-em-pm",a=A(t),n=A(s);if(!a||!n)return;const i=Ka(a.value),l=Ka(n.value),o=bt(i.h,i.m),d=bt(l.h,l.m),p={sp:e==="sp"?[{...i,label:o},{...l,label:d}]:Be,email:e==="email"?[{...i,label:o},{...l,label:d}]:Te},u=A(e==="sp"?"sched-sp-save":"sched-em-save");u&&(u.disabled=!0,u.textContent="Saving...");try{const c=await ee.saveScheduleSlots(p);c&&c.ok&&(e==="sp"&&(Be=p.sp),e==="email"&&(Te=p.email),ea(),he({type:"sync",msg:(e==="sp"?"SP":"Email")+" schedule updated: "+o+" · "+d,status:"ok"}))}catch(c){he({type:"sync",msg:"Save failed: "+c.message,status:"error"})}finally{u&&(u.disabled=!1,u.textContent="✓ Save times")}}function Ho(e){Mo(),Bo(),F=document.createElement("div"),F.id="view-schedulers",F.className="view view--schedulers",F.style.display="none",F.innerHTML=Po(),e.appendChild(F);const t=A("sched-back"),s=A("sched-sp-trigger"),a=A("sched-sp-sync"),n=A("sched-clear-log"),i=A("sched-sp-save"),l=A("sched-em-save");t&&t.addEventListener("click",()=>r.emit("ui:view-change",{from:"schedulers",to:"fleet"})),s&&s.addEventListener("click",Oo),a&&a.addEventListener("click",Uo),n&&n.addEventListener("click",()=>{Oe=[],In(),ka()}),i&&i.addEventListener("click",()=>Za("sp")),l&&l.addEventListener("click",()=>Za("email")),Ja().then(()=>{Qa(),ea(),Rs()}),r.on("sp:progress",o=>{F&&F.style.display!=="none"&&qo(o)}),r.on("fleet:status",o=>{if(!o)return;const d=/error|fail/i.test(o),p=/email|auto-email/i.test(o),u=/sp push|sp:/i.test(o);p?(Re={ts:Date.now(),status:d?"error":"ok",msg:o},he({type:"email",msg:o,status:Re.status}),F&&F.style.display!=="none"&&_a()):he(u?{type:"sp",msg:o,status:d?"error":"ok"}:{type:"sync",msg:o,status:d?"error":"ok"})}),r.on("fleet:data",()=>{E.slice("fleet").syncedAt&&he({type:"sync",msg:"Fleet data synced ("+(E.slice("fleet").count||0)+" units)",status:"ok"})}),r.on("ui:view-change",({to:o})=>{const d=o==="schedulers";F.style.display=d?"flex":"none",d?(Ja().then(()=>{Qa(),ea(),Rs()}),No()):Rn()}),Rs()}let J=null;const ot=e=>String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"),lt=(e,t)=>t?Math.round(e/t*100):0;function Ms(e){if(!e||e==="--")return null;const t=e.toLowerCase().trim();if(t==="overdue"||t.startsWith("overdue"))return-1;if(t==="0 days"||t==="0")return 0;const s=t.match(/^(-?\d+)/);return s?parseInt(s[1],10):null}function jo(e){const t=e.length,s={};for(const L of e){const k=(L.lifecycleState||"Unknown").trim();s[k]=(s[k]||0)+1}const a=Object.entries(s).sort((L,k)=>k[1]-L[1]),n=e.filter(L=>(L.lifecycleState||"").toLowerCase().includes("unavailable")).length,i=e.filter(L=>{const k=(L.lifecycleState||"").toLowerCase();return k.includes("available")&&!k.includes("un")}).length,l=e.filter(L=>(L.riskScore||0)>=75).length,o=e.filter(L=>{const k=L.riskScore||0;return k>=40&&k<75}).length,d=e.filter(L=>(L.riskScore||0)<40).length,p={};for(const L of e){const k=(L.operator||"Unknown").toUpperCase().trim();p[k]||(p[k]={total:0,unavail:0,highRisk:0,openWR:0}),p[k].total++,(L.lifecycleState||"").toLowerCase().includes("unavailable")&&p[k].unavail++,(L.riskScore||0)>=75&&p[k].highRisk++,(L.openUnplanned||0)>0&&p[k].openWR++}const u=Object.entries(p).sort((L,k)=>k[1].total-L[1].total),c={};for(const L of e){const k=(L.vendor||"").trim();k&&(c[k]=(c[k]||0)+1)}const v=Object.entries(c).sort((L,k)=>k[1]-L[1]).slice(0,10);let m=0,g=0,x=0,f=0,w=0,b=0;const I=14;for(const L of e){const k=Ms(L.pmB),G=Ms(L.pmX),j=Ms(L.dot);k!==null&&(k<0?m++:k<=I&&g++),G!==null&&(G<0?x++:G<=I&&f++),j!==null&&(j<0?w++:j<=I&&b++)}const H={};for(const L of e){const k=(L.assetType||L.bodyType||"Unknown").trim();H[k]=(H[k]||0)+1}const P=Object.entries(H).sort((L,k)=>k[1]-L[1]),M=E.slice("fleet"),_=M.syncedAt,B=M.stale;return{total:t,unavailCount:n,availCount:i,highRisk:l,medRisk:o,lowRisk:d,lcSorted:a,opSorted:u,vendSorted:v,pmBOver:m,pmBSoon:g,pmXOver:x,pmXSoon:f,dotOver:w,dotSoon:b,btSorted:P,syncedAt:_,stale:B}}function _s(e,t,s){const a=t?Math.min(100,Math.round(e/t*100)):0;return`<div class="an-bar-track"><div class="an-bar-fill an-bar-fill--${s}" style="width:${a}%"></div></div>`}function Wo(e){const t=lt(e.unavailCount,e.total),s=lt(e.availCount,e.total),a=lt(e.highRisk,e.total),n=e.stale?'<div class="an-stale-banner">⚠ Data may be stale — trigger a sync for current counts</div>':"",i=e.syncedAt?new Date(e.syncedAt).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"never";return`
    ${n}
    <div class="an-summary-bar">
      <div class="an-kpi an-kpi--total">
        <span class="an-kpi__val">${e.total}</span>
        <span class="an-kpi__lbl">Total units</span>
      </div>
      <div class="an-kpi an-kpi--unavail">
        <span class="an-kpi__val">${e.unavailCount} <span class="an-kpi__pct">${t}%</span></span>
        <span class="an-kpi__lbl">Unavailable</span>
      </div>
      <div class="an-kpi an-kpi--avail">
        <span class="an-kpi__val">${e.availCount} <span class="an-kpi__pct">${s}%</span></span>
        <span class="an-kpi__lbl">Available</span>
      </div>
      <div class="an-kpi an-kpi--risk">
        <span class="an-kpi__val">${e.highRisk} <span class="an-kpi__pct">${a}%</span></span>
        <span class="an-kpi__lbl">High risk (≥75)</span>
      </div>
      <div class="an-kpi an-kpi--synced">
        <span class="an-kpi__val an-kpi__val--sm">${i}</span>
        <span class="an-kpi__lbl">Last synced</span>
      </div>
    </div>`}function zo(e){if(!e.lcSorted.length)return'<span class="an-empty">No data</span>';const t=e.lcSorted[0][1];return`<div class="an-lc-chart">${e.lcSorted.map(([a,n])=>{const i=a.toLowerCase(),l=i.includes("unavailable")?"unavail":i.includes("available")?"avail":"other";return`
      <div class="an-lc-row">
        <span class="an-lc-label" title="${ot(a)}">${ot(a)}</span>
        <div class="an-lc-bar-wrap">${_s(n,t,l)}</div>
        <span class="an-lc-count">${n}</span>
        <span class="an-lc-pct">${lt(n,e.total)}%</span>
      </div>`}).join("")}</div>`}function Vo(e){const t=e.total||1;return`
    <div class="an-risk-wrap">
      ${[{label:"HIGH ≥75",count:e.highRisk,cls:"risk-high"},{label:"MED 40–74",count:e.medRisk,cls:"risk-med"},{label:"LOW <40",count:e.lowRisk,cls:"risk-low"}].map(a=>`
        <div class="an-risk-tier">
          <div class="an-risk-tier__header">
            <span class="an-risk-badge an-risk-badge--${a.cls}">${a.label}</span>
            <span class="an-risk-tier__count">${a.count}</span>
            <span class="an-risk-tier__pct">${lt(a.count,t)}%</span>
          </div>
          ${_s(a.count,t,a.cls)}
        </div>`).join("")}
    </div>`}function Fo(e){if(!e.opSorted.length)return'<span class="an-empty">No data</span>';const t=`
    <tr>
      <th>Operator</th>
      <th class="an-tbl--r">Total</th>
      <th class="an-tbl--r">Unavail</th>
      <th class="an-tbl--r">Unavail %</th>
      <th class="an-tbl--r">High risk</th>
      <th class="an-tbl--r">Open WRs</th>
    </tr>`,s=e.opSorted.map(([a,n])=>`
    <tr>
      <td class="an-op-name">${ot(a)}</td>
      <td class="an-tbl--r">${n.total}</td>
      <td class="an-tbl--r ${n.unavail>0?"an-cell--warn":""}">${n.unavail}</td>
      <td class="an-tbl--r">${lt(n.unavail,n.total)}%</td>
      <td class="an-tbl--r ${n.highRisk>0?"an-cell--danger":""}">${n.highRisk}</td>
      <td class="an-tbl--r ${n.openWR>0?"an-cell--accent":""}">${n.openWR}</td>
    </tr>`).join("");return`<table class="an-table"><thead>${t}</thead><tbody>${s}</tbody></table>`}function Go(e){if(!e.vendSorted.length)return'<span class="an-empty">No vendor data — run a relay sync first</span>';const t=e.vendSorted[0][1];return`<div class="an-vend-chart">${e.vendSorted.map(([a,n])=>`
    <div class="an-vend-row">
      <span class="an-vend-name" title="${ot(a)}">${ot(a)}</span>
      <div class="an-vend-bar-wrap">${_s(n,t,"vendor")}</div>
      <span class="an-vend-count">${n}</span>
    </div>`).join("")}</div>`}function Xo(e){return`
    <div class="an-pm-wrap">
      ${[{label:"PM B",overdue:e.pmBOver,soon:e.pmBSoon},{label:"PM X",overdue:e.pmXOver,soon:e.pmXSoon},{label:"DOT",overdue:e.dotOver,soon:e.dotSoon}].map(s=>`
        <div class="an-pm-card">
          <div class="an-pm-card__title">${s.label}</div>
          <div class="an-pm-card__rows">
            <div class="an-pm-row an-pm-row--over">
              <span class="an-pm-dot an-pm-dot--over"></span>
              <span class="an-pm-lbl">Overdue</span>
              <span class="an-pm-val ${s.overdue>0?"an-pm-val--danger":""}">${s.overdue}</span>
            </div>
            <div class="an-pm-row an-pm-row--soon">
              <span class="an-pm-dot an-pm-dot--soon"></span>
              <span class="an-pm-lbl">Due ≤14 days</span>
              <span class="an-pm-val ${s.soon>0?"an-pm-val--warn":""}">${s.soon}</span>
            </div>
          </div>
        </div>`).join("")}
    </div>`}function Jo(e){if(!e.btSorted.length)return'<span class="an-empty">No data</span>';const t=e.btSorted[0][1];return`<div class="an-bt-chart">${e.btSorted.map(([a,n])=>`
    <div class="an-bt-row">
      <span class="an-bt-label" title="${ot(a)}">${ot(a)}</span>
      <div class="an-bt-bar-wrap">${_s(n,t,"bodytype")}</div>
      <span class="an-bt-count">${n}</span>
      <span class="an-bt-pct">${lt(n,e.total)}%</span>
    </div>`).join("")}</div>`}function Ko(){return`
    <div class="an-header">
      <div class="an-header__left">
        <span class="an-title">Analytics</span>
        <span class="an-subtitle">Fleet KPI dashboard — computed from current sync data</span>
      </div>
      <div class="an-header__actions">
        <button id="an-refresh" class="detail-panel__btn detail-panel__btn--secondary">↺ Refresh</button>
        <button id="an-back"    class="detail-panel__btn">Back to Fleet</button>
      </div>
    </div>

    <div class="an-body">

      <!-- Summary bar -->
      <div id="an-summary"></div>

      <!-- Two-col grid: lifecycle + risk -->
      <div class="an-grid-2">
        <div class="an-card">
          <div class="an-card__title">Lifecycle Breakdown</div>
          <div id="an-lifecycle"></div>
        </div>
        <div class="an-card">
          <div class="an-card__title">Risk Distribution</div>
          <div id="an-risk"></div>
        </div>
      </div>

      <!-- PM health + body-type mix -->
      <div class="an-grid-2">
        <div class="an-card">
          <div class="an-card__title">PM Due Dates</div>
          <div class="an-card__hint">Computed from pmB / pmX / DOT fields</div>
          <div id="an-pm"></div>
        </div>
        <div class="an-card">
          <div class="an-card__title">Asset Type Mix</div>
          <div id="an-bodytypes"></div>
        </div>
      </div>

      <!-- Full-width: by-operator -->
      <div class="an-card">
        <div class="an-card__title">By Operator</div>
        <div id="an-operators"></div>
      </div>

      <!-- Full-width: vendor distribution -->
      <div class="an-card">
        <div class="an-card__title">Top Vendors</div>
        <div id="an-vendors"></div>
      </div>

    </div>
  `}function Zt(e){if(!J)return;const t=jo(e),s=J.querySelector("#an-summary"),a=J.querySelector("#an-lifecycle"),n=J.querySelector("#an-risk"),i=J.querySelector("#an-operators"),l=J.querySelector("#an-vendors"),o=J.querySelector("#an-pm"),d=J.querySelector("#an-bodytypes");s&&(s.innerHTML=Wo(t)),a&&(a.innerHTML=zo(t)),n&&(n.innerHTML=Vo(t)),i&&(i.innerHTML=Fo(t)),l&&(l.innerHTML=Go(t)),o&&(o.innerHTML=Xo(t)),d&&(d.innerHTML=Jo(t))}function Yo(e){J=document.createElement("div"),J.id="view-analytics",J.className="view view--analytics",J.style.display="none",J.innerHTML=Ko(),e.appendChild(J),J.querySelector("#an-back").addEventListener("click",()=>{r.emit("ui:view-change",{from:"analytics",to:"fleet"})}),J.querySelector("#an-refresh").addEventListener("click",()=>{const t=J.querySelector("#an-refresh");t.disabled=!0,t.textContent="Refreshing...",Zt(E.slice("fleet").rows||[]),t.disabled=!1,t.textContent="↺ Refresh"}),r.on("fleet:data",t=>{Zt(t&&t.rows?t.rows:[])}),r.on("ui:view-change",({to:t})=>{J.style.display=t==="analytics"?"flex":"none",t==="analytics"&&Zt(E.slice("fleet").rows||[])}),Zt(E.slice("fleet").rows||[])}let R=null,Jt="list",ta="",sa="";const z=e=>String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");function Qo(e){if(!e)return 0;const t=String(e).replace(/[$,]/g,"").match(/(\d[\d.]*)/);return t?parseFloat(t[1]):0}function Mn(e){return e?"$"+e.toLocaleString("en-US",{minimumFractionDigits:0,maximumFractionDigits:0}):"—"}function Zo(e){return e!=null?Math.round(e):"—"}function qn(e){return e>=75?"risk-high":e>=40?"risk-med":"risk-low"}function On(e){const t={};for(const s of e){const a=(s.vendor||"").trim();if(!a)continue;t[a]||(t[a]={units:[],totalCost:0,unavail:0,highRisk:0,riskSum:0,openWOs:0}),t[a].units.push(s),t[a].totalCost+=Qo(s.totalCost),(s.lifecycleState||"").toLowerCase().includes("unavailable")&&t[a].unavail++;const n=s.riskScore||0;n>=75&&t[a].highRisk++,t[a].riskSum+=n,((s.openUnplanned||0)>0||s.vendorWorkOrderId)&&t[a].openWOs++}return t}function ed(e,t){const s=Object.keys(t).length,a=e.filter(i=>(i.vendor||"").trim()).length,n=e.filter(i=>(i.vendor||"").trim()&&(i.riskScore||0)>=75).length;return`
    <div class="vm-strip">
      <div class="vm-kpi">
        <span class="vm-kpi__val">${s}</span>
        <span class="vm-kpi__lbl">Vendors</span>
      </div>
      <div class="vm-kpi">
        <span class="vm-kpi__val">${a}</span>
        <span class="vm-kpi__lbl">Units at vendors</span>
      </div>
      <div class="vm-kpi vm-kpi--risk">
        <span class="vm-kpi__val">${n}</span>
        <span class="vm-kpi__lbl">High risk at vendors</span>
      </div>
    </div>`}function td(e,t){let s=Object.entries(e).sort((i,l)=>l[1].units.length-i[1].units.length);if(t){const i=t.toLowerCase();s=s.filter(([l])=>l.toLowerCase().includes(i))}if(!s.length)return t?`<span class="vm-empty">No vendors match "${z(t)}"</span>`:'<span class="vm-empty">No vendor data — run a relay sync to populate vendors</span>';const a=`
    <tr>
      <th>Vendor</th>
      <th class="vm-tbl--r">Units</th>
      <th class="vm-tbl--r">Unavail</th>
      <th class="vm-tbl--r">High risk</th>
      <th class="vm-tbl--r">Avg risk</th>
      <th class="vm-tbl--r">Total WO cost</th>
      <th class="vm-tbl--r">Open WOs</th>
    </tr>`,n=s.map(([i,l])=>{const o=l.units.length?Math.round(l.riskSum/l.units.length):0,d=qn(o);return`
      <tr class="vm-vendor-row" data-vendor="${z(i)}">
        <td class="vm-vendor-name">${z(i)}</td>
        <td class="vm-tbl--r">${l.units.length}</td>
        <td class="vm-tbl--r ${l.unavail>0?"vm-cell--warn":""}">${l.unavail}</td>
        <td class="vm-tbl--r ${l.highRisk>0?"vm-cell--danger":""}">${l.highRisk}</td>
        <td class="vm-tbl--r">
          <span class="vm-risk-badge vm-risk-badge--${d}">${o}</span>
        </td>
        <td class="vm-tbl--r ${l.totalCost>0?"vm-cell--cost":""}">${Mn(l.totalCost)}</td>
        <td class="vm-tbl--r ${l.openWOs>0?"vm-cell--accent":""}">${l.openWOs}</td>
      </tr>`}).join("");return`
    <table class="vm-table" id="vm-vendor-table">
      <thead>${a}</thead>
      <tbody>${n}</tbody>
    </table>`}function sd(e){const t=e.units.length?Math.round(e.riskSum/e.units.length):0;return e.units.filter(s=>s.workDuration).length,`
    <div class="vm-strip">
      <div class="vm-kpi">
        <span class="vm-kpi__val">${e.units.length}</span>
        <span class="vm-kpi__lbl">Units</span>
      </div>
      <div class="vm-kpi ${e.unavail>0?"vm-kpi--warn":""}">
        <span class="vm-kpi__val">${e.unavail}</span>
        <span class="vm-kpi__lbl">Unavailable</span>
      </div>
      <div class="vm-kpi ${e.highRisk>0?"vm-kpi--risk":""}">
        <span class="vm-kpi__val">${e.highRisk}</span>
        <span class="vm-kpi__lbl">High risk (≥75)</span>
      </div>
      <div class="vm-kpi">
        <span class="vm-kpi__val">${Zo(t)}</span>
        <span class="vm-kpi__lbl">Avg risk score</span>
      </div>
      <div class="vm-kpi ${e.totalCost>0?"vm-kpi--cost":""}">
        <span class="vm-kpi__val">${Mn(e.totalCost)}</span>
        <span class="vm-kpi__lbl">Total WO cost</span>
      </div>
      <div class="vm-kpi">
        <span class="vm-kpi__val">${e.openWOs}</span>
        <span class="vm-kpi__lbl">Open WOs</span>
      </div>
    </div>`}function ad(e){if(!e.length)return'<span class="vm-empty">No units</span>';const t=`
    <tr>
      <th>ID</th>
      <th>Operator</th>
      <th>Site</th>
      <th>Lifecycle</th>
      <th>Reason</th>
      <th class="vm-tbl--r">Risk</th>
      <th>WO #</th>
      <th>Cause</th>
      <th class="vm-tbl--r">Cost</th>
      <th>SF Case</th>
      <th>Offsite</th>
      <th>Sub Vendor</th>
    </tr>`,s=e.map(a=>{const n=a.riskScore||0,i=qn(n),l=(a.lifecycleState||"").toLowerCase(),o=l.includes("unavailable")?"lc--unavailable":l.includes("available")?"lc--available":"",d=a.savedSalesforceCaseUrl||a.salesforceCaseUrl?`<a class="vm-link" href="${z(a.savedSalesforceCaseUrl||a.salesforceCaseUrl)}" target="_blank" rel="noreferrer">${z(a.savedSalesforceCase||a.salesforceCase||"SF")}</a>`:z(a.savedSalesforceCase||a.salesforceCase||"—"),p=a.savedOffsiteUrl||a.offsiteShopEventUrl||"",u=a.asistLabel||a.savedOffsiteEvent||a.offsiteShopEvent||"Link",c=a.asistSource==="estimate"?" [Est]":a.asistSource==="case"?" [Case]":"",v=p?`<a class="vm-link" href="${z(p)}" target="_blank" rel="noreferrer">${z(u+c)}</a>`:z(a.savedOffsiteEvent||a.offsiteShopEvent||"--");return`
      <tr>
        <td><span class="vm-unit-id vm-unit-link" data-unit="${z(a.equipmentId)}">${z(a.equipmentId)}</span></td>
        <td class="vm-tbl--mono">${z((a.operator||"").toUpperCase())}</td>
        <td class="vm-tbl--mono">${z(a.domicileSite||"")}</td>
        <td class="${o}">${z(a.lifecycleState||"")}</td>
        <td class="vm-tbl--reason">${z(a.lifecycleReason||"")}</td>
        <td class="vm-tbl--r"><span class="vm-risk-badge vm-risk-badge--${i}">${n}</span></td>
        <td class="vm-tbl--mono">${z(a.vendorWorkOrderId||"—")}</td>
        <td class="vm-tbl--cause" title="${z(a.cause)}">${z(a.cause?a.cause.slice(0,50)+(a.cause.length>50?"...":""):"—")}</td>
        <td class="vm-tbl--r ${a.totalCost?"vm-cell--cost":""}">${z(a.totalCost||"—")}</td>
        <td>${d}</td>
        <td>${v}</td>
        <td class="vm-tbl--subvendor">${a.subVendor||a.dealerName?`<span class="vm-sub-vendor-pill">${z(a.subVendor||a.dealerName)}</span>`:'<span class="vm-sub-vendor-none">--</span>'}</td>
      </tr>`}).join("");return`
    <div class="vm-drill-scroll">
      <table class="vm-table vm-table--drill">
        <thead>${t}</thead>
        <tbody>${s}</tbody>
      </table>
    </div>`}function nd(){return`
    <!-- LIST panel -->
    <div id="vm-list-panel" class="vm-panel">
      <div class="vm-header">
        <div class="vm-header__left">
          <span class="vm-title">Vendors</span>
          <span class="vm-subtitle">All vendors from relay-synced fleet data</span>
        </div>
        <div class="vm-header__actions">
          <input id="vm-search" class="vm-search-input" type="text" placeholder="Search vendors..." autocomplete="off" />
          <button id="vm-back-fleet" class="detail-panel__btn">Back to Fleet</button>
        </div>
      </div>
      <div id="vm-list-summary"></div>
      <div class="vm-body">
        <div id="vm-list-content"></div>
      </div>
    </div>

    <!-- DRILL panel -->
    <div id="vm-drill-panel" class="vm-panel" style="display:none">
      <div class="vm-header">
        <div class="vm-header__left">
          <span class="vm-title" id="vm-drill-title">Vendor</span>
          <span class="vm-subtitle">Units currently at this vendor</span>
        </div>
        <div class="vm-header__actions">
          <button id="vm-drill-back-list"  class="detail-panel__btn detail-panel__btn--secondary">← Vendors</button>
          <button id="vm-drill-back-fleet" class="detail-panel__btn">Back to Fleet</button>
        </div>
      </div>
      <div id="vm-drill-summary"></div>
      <div class="vm-body">
        <div id="vm-drill-content"></div>
      </div>
    </div>
  `}function aa(e){R&&(R.querySelector("#vm-list-panel").style.display=e==="list"?"flex":"none",R.querySelector("#vm-drill-panel").style.display=e==="drill"?"flex":"none")}function na(e){if(!R)return;const t=On(e),s=R.querySelector("#vm-list-summary"),a=R.querySelector("#vm-list-content");s&&(s.innerHTML=ed(e,t)),a&&(a.innerHTML=td(t,sa)),id(t)}function Un(e,t){if(!R)return;const a=On(e)[t]||{units:[],totalCost:0,unavail:0,highRisk:0,riskSum:0,openWOs:0},n=R.querySelector("#vm-drill-title"),i=R.querySelector("#vm-drill-summary"),l=R.querySelector("#vm-drill-content");n&&(n.textContent=t),i&&(i.innerHTML=sd(a)),l&&(l.innerHTML=ad(a.units)),ld()}function id(e){const t=R?R.querySelector("#vm-vendor-table"):null;t&&t.querySelectorAll("tr.vm-vendor-row").forEach(s=>{s.addEventListener("click",()=>{const a=s.dataset.vendor;!a||!e[a]||(ta=a,Jt="drill",aa("drill"),Un(E.slice("fleet").rows||[],a))})})}function ld(){const e=R?R.querySelector("#vm-drill-panel"):null;e&&e.querySelectorAll(".vm-unit-link").forEach(t=>{t.addEventListener("click",()=>{const s=t.dataset.unit;s&&(r.emit("ui:view-change",{from:"vendors",to:"fleet"}),setTimeout(()=>r.emit("navigate:unit",s),50))})})}function qs(e){Jt==="list"?na(e):Jt==="drill"&&ta&&Un(e,ta)}function od(e){R=document.createElement("div"),R.id="view-vendors",R.className="view view--vendors",R.style.display="none",R.innerHTML=nd(),e.appendChild(R),R.querySelector("#vm-search").addEventListener("input",t=>{sa=t.target.value.trim();const s=E.slice("fleet").rows||[];na(s)}),R.querySelector("#vm-back-fleet").addEventListener("click",()=>{r.emit("ui:view-change",{from:"vendors",to:"fleet"})}),R.querySelector("#vm-drill-back-list").addEventListener("click",()=>{Jt="list",aa("list"),na(E.slice("fleet").rows||[])}),R.querySelector("#vm-drill-back-fleet").addEventListener("click",()=>{r.emit("ui:view-change",{from:"vendors",to:"fleet"})}),r.on("fleet:data",t=>{qs(t&&t.rows?t.rows:[])}),r.on("ui:view-change",({to:t,from:s})=>{if(R.style.display=t==="vendors"?"flex":"none",t==="vendors"){if(s!=="vendors"){Jt="list",sa="";const a=R.querySelector("#vm-search");a&&(a.value=""),aa("list")}qs(E.slice("fleet").rows||[])}}),qs(E.slice("fleet").rows||[])}let Qe=null,De={},Se={},Nn=[];const y=e=>document.getElementById(e),K=e=>String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");function ia(){return new Date().getHours()<14?"AM":"PM"}function Hn(e,t,s){const a=new Date,n=t==="AM"?"AM":"PM",i=(a.getMonth()+1).toString().padStart(2,"0")+"/"+a.getDate().toString().padStart(2,"0")+"/"+a.getFullYear(),l=(e||"").trim().toUpperCase(),o=s&&s!=="ALL"?s.trim().toUpperCase():"";let d="";return o&&l?d=`[${o} · ${l}] `:l?d=`[${l}] `:o&&(d=`[${o}] `),`${d}Fleet Maintenance Report  -  ${i} ${n}`}function la(){return`<option value="">-- Select operator --</option>${Nn.map(t=>`<option value="${K(t)}">${K(t)}</option>`).join("")}`}function gs(e){const t=E.slice("fleet").rows||[],s=e?t.filter(a=>(a.op||a.operator||"").toUpperCase().trim()===e.toUpperCase().trim()):t;return[...new Set(s.map(a=>a.domicileSite||a.domicile||"").filter(Boolean))].sort()}function bs(e){return`<option value="ALL">ALL (no filter)</option>${(e||[]).map(s=>`<option value="${K(s)}">${K(s)}</option>`).join("")}`}function dd(){return`
    <div class="ec-wrap">

      <!-- Header -->
      <div class="ec-header">
        <div class="ec-header__left">
          <span class="ec-title">Email Composer</span>
          <span class="ec-subtitle">Build &amp; send fleet status reports</span>
        </div>
        <button id="ec-back" class="detail-panel__btn">Back to Fleet</button>
      </div>

      <!-- Two-panel layout: form left, status right -->
      <div class="ec-body">

        <!-- ── LEFT: compose form ── -->
        <div class="ec-form">

          <!-- Operator + Domicile -->
          <div class="ec-section">
            <div class="ec-section__title">Report Scope</div>
            <div class="ec-two-col">
              <label class="settings-label">Operator
                <select id="ec-operator" class="settings__select ec-select">
                  ${la()}
                </select>
              </label>
              <label class="settings-label">Domicile
                <select id="ec-domicile" class="settings__select ec-select">
                  ${bs(gs(""))}
                </select>
              </label>
            </div>
          </div>

          <!-- Slot toggle -->
          <div class="ec-section">
            <div class="ec-section__title">Slot</div>
            <div class="ec-slot-row">
              <button id="ec-slot-am" class="ec-slot-btn ${ia()==="AM"?"ec-slot-btn--active":""}" data-slot="AM">
                ☀ AM — SOS Report
              </button>
              <button id="ec-slot-pm" class="ec-slot-btn ${ia()==="PM"?"ec-slot-btn--active":""}" data-slot="PM">
                🌆 PM — EOS Report
              </button>
            </div>
          </div>

          <!-- Recipients -->
          <div class="ec-section">
            <div class="ec-section__title">
              Recipients
              <div class="ec-preset-controls">
                <button id="ec-preset-load"  class="ec-preset-btn">Load preset</button>
                <button id="ec-preset-save"  class="ec-preset-btn">Save preset</button>
              </div>
            </div>
            <label class="settings-label">To
              <input id="ec-to" class="settings__input" type="text"
                placeholder="recipient@amazon.com; other@amazon.com" />
            </label>
            <label class="settings-label" style="margin-top:6px">CC
              <input id="ec-cc" class="settings__input" type="text"
                placeholder="manager@amazon.com" />
            </label>
          </div>

          <!-- Subject -->
          <div class="ec-section">
            <div class="ec-section__title">Subject</div>
            <div class="ec-subject-row">
              <input id="ec-subject" class="settings__input ec-subject-input" type="text"
                placeholder="Auto-generated subject..." />
              <button id="ec-subject-reset" class="ec-icon-btn" title="Reset to auto-generated">↺</button>
            </div>
          </div>

          <!-- Email note -->
          <div class="ec-section">
            <div class="ec-section__title">
              Email Note
              <span class="ec-section__hint">Shown as a red banner at top of email</span>
            </div>
            <textarea id="ec-note" class="settings__textarea" rows="2"
              placeholder="Optional — e.g. 'Units at EWR45 excluded due to site freeze'"></textarea>
          </div>

          <!-- Options row -->
          <div class="ec-section">
            <div class="ec-section__title">Options</div>
            <div class="ec-options-row">
              <label class="settings-label settings-label--inline">
                <input id="ec-test-mode" type="checkbox" />
                Test mode — routes to dev email only
              </label>
            </div>
          </div>

          <!-- Actions -->
          <div class="ec-actions">
            <button id="ec-preview"  class="detail-panel__btn detail-panel__btn--secondary">Preview HTML</button>
            <button id="ec-compose"  class="detail-panel__btn ec-compose-btn">Compose in OWA</button>
            <button id="ec-send-smtp" class="detail-panel__btn detail-panel__btn--secondary" title="Send via SMTP (requires email config in Settings)">Send via SMTP</button>
          </div>

        </div><!-- /ec-form -->

        <!-- ── RIGHT: status + log ── -->
        <div class="ec-status-panel">

          <div class="ec-section__title">Status</div>

          <div id="ec-status-badge" class="ec-status-badge ec-status-badge--idle">Idle</div>

          <div id="ec-log-wrap" class="ec-log-wrap" style="display:none">
            <div id="ec-log" class="ec-log"></div>
          </div>

          <div id="ec-result" class="ec-result" style="display:none"></div>

          <!-- Preset list -->
          <div class="ec-preset-list-wrap">
            <div class="ec-section__title" style="margin-top:16px">Saved presets</div>
            <div id="ec-preset-list" class="ec-preset-list">
              <span class="ec-empty">No presets saved.</span>
            </div>
          </div>

          <!-- Unit count indicator -->
          <div class="ec-unit-count-wrap">
            <div class="ec-section__title" style="margin-top:16px">Matching units</div>
            <div id="ec-unit-count" class="ec-unit-count">—</div>
          </div>

        </div><!-- /ec-status-panel -->

      </div><!-- /ec-body -->

    </div>
  `}function Os(){const e=E.slice("fleet").rows||[];Nn=[...new Set(e.map(s=>s.op||s.operator||"").filter(Boolean).map(s=>s.toUpperCase()))].sort()}async function cd(){try{const e=await we.loadOpEmails();e&&typeof e=="object"&&(De=e)}catch{}oa()}function oa(){const e=y("ec-preset-list");if(!e)return;const t=Object.keys(Se).filter(i=>{var l;return(l=Se[i])==null?void 0:l.to}),s=Object.keys(De).filter(i=>!t.some(l=>l.startsWith(i+"__")));if(!t.length&&!s.length){e.innerHTML='<span class="ec-empty">No presets — save email recipients in Settings → Operators.</span>';return}const a=t.map(i=>{const[l,o]=i.split("__"),d=Se[i],p=o?`${K(l)} · ${K(o)}`:K(l),u=(d.to||"").slice(0,44)+((d.to||"").length>44?"...":"");return`<div class="ec-preset-row" data-key="${K(i)}" data-type="sp">
      <span class="ec-preset-op">${p}</span>
      <span class="ec-preset-addr">${K(u)}</span>
      <button class="ec-preset-load-btn" data-key="${K(i)}" data-type="sp">Load</button>
    </div>`}),n=s.map(i=>{const l=De[i],o=(l.to||"").slice(0,44)+((l.to||"").length>44?"...":"");return`<div class="ec-preset-row" data-key="${K(i)}" data-type="legacy">
      <span class="ec-preset-op">${K(i)}</span>
      <span class="ec-preset-addr">${K(o)}</span>
      <button class="ec-preset-load-btn" data-key="${K(i)}" data-type="legacy">Load</button>
      <button class="ec-preset-del-btn settings-btn--danger" data-key="${K(i)}">×</button>
    </div>`});e.innerHTML=[t.length?'<div class="ec-preset-group-label">From Settings</div>':"",...a,s.length?'<div class="ec-preset-group-label">Saved presets</div>':"",...n].join("")}function rd(){y("ec-preset-save").addEventListener("click",async()=>{const e=(y("ec-operator").value||"").trim().toUpperCase(),t=(y("ec-domicile").value||"").trim().toUpperCase();if(!e){h.show("warn","Select an operator first",3e3);return}const s=(y("ec-to").value||"").trim(),a=(y("ec-cc").value||"").trim();De[e]={to:s,cc:a};try{await we.saveOpEmails(De)}catch{}if(t&&t!=="ALL")try{const n=await ie.getConfig().catch(()=>({}))||{},i=n.emails||{},l=`${e}__${t}`;i[l]={to:s,cc:a},await ie.saveConfig({...n,emails:i}),Se=i}catch{}h.show("success",`Preset saved — ${e}${t&&t!=="ALL"?" · "+t:""}`,2500),oa()}),y("ec-preset-load").addEventListener("click",()=>{const e=(y("ec-operator").value||"").trim().toUpperCase(),t=(y("ec-domicile").value||"").trim().toUpperCase();if(!e){h.show("warn","Select an operator first",3e3);return}const s=t&&t!=="ALL"?`${e}__${t}`:null;s&&Se[s]?Us(s,"sp"):Us(e,"legacy")}),y("ec-preset-list").addEventListener("click",async e=>{const t=e.target.closest(".ec-preset-load-btn"),s=e.target.closest(".ec-preset-del-btn");if(t)Us(t.dataset.key,t.dataset.type);else if(s){const a=s.dataset.key;delete De[a];try{await we.saveOpEmails(De),oa(),h.show("info","Preset deleted: "+a,2e3)}catch(n){h.show("error","Delete failed: "+n.message)}}})}function Us(e,t){let s,a,n;if(t==="sp"){s=Se[e];const u=e.split("__");a=u[0]||"",n=u[1]||""}else s=De[e],a=e,n="";if(!s){h.show("info","No preset for "+e,2e3);return}const i=y("ec-to"),l=y("ec-cc");i&&(i.value=s.to||""),l&&(l.value=s.cc||"");const o=y("ec-operator");if(o&&a){const u=Array.from(o.options).find(c=>c.value.toUpperCase()===a.toUpperCase());u&&(o.value=u.value)}const d=y("ec-domicile");if(d&&n&&n!=="ALL"){const u=Array.from(d.options).find(c=>c.value.toUpperCase()===n.toUpperCase());u&&(d.value=u.value)}Ke(),wt();const p=n?`${a} · ${n}`:a;h.show("success","Loaded: "+p,2e3)}function jn(){const e=y("ec-slot-am");return e&&e.classList.contains("ec-slot-btn--active")?"AM":"PM"}async function pd(){try{const e=await ie.getConfig();Se=(e==null?void 0:e.emails)||{}}catch(e){console.warn("[email-composer] _loadSpEmails failed:",e),Se={}}}function en(){var p,u,c,v;const e=(((p=y("ec-operator"))==null?void 0:p.value)||"").toUpperCase().trim(),t=(((u=y("ec-domicile"))==null?void 0:u.value)||"").trim();if(!e)return;const s=t&&t!=="ALL"?`${e}__${t}`:null,a=Object.keys(Se).find(m=>m.startsWith(e+"__")),n=s&&Se[s]||a&&Se[a]||De[e];if(!n)return;const i=y("ec-to"),l=y("ec-cc"),o=!((c=i==null?void 0:i.value)!=null&&c.trim()),d=!((v=l==null?void 0:l.value)!=null&&v.trim());o&&n.to&&(i.value=n.to),d&&n.cc&&(l.value=n.cc)}function ud(){y("ec-subject-reset").addEventListener("click",()=>Ke())}function vd(){y("ec-preview").addEventListener("click",async()=>{const e=xa(),t=Ea(e);if(t){h.show("warn",t,3e3);return}const s=y("ec-preview");s.disabled=!0,s.textContent="Building...",ye("loading","Building preview...");try{const a=await we.compose(e);a&&a.success===!1?(h.show("error","Build failed: "+(a.error||"unknown"),5e3),ye("error","Build failed")):(await we.preview(e),ye("ok","Preview opened"),h.show("info","Preview window opened",2e3))}catch(a){h.show("error","Preview failed: "+a.message),ye("error","Preview failed")}finally{s.disabled=!1,s.textContent="Preview HTML"}})}function md(){y("ec-compose").addEventListener("click",async()=>{const e=xa(),t=Ea(e);if(t){h.show("warn",t,3e3);return}const s=y("ec-compose"),a=y("ec-send-smtp");s.disabled=!0,s.textContent="Composing...",a.disabled=!0,ye("loading","Building email..."),y("ec-log-wrap").style.display="",y("ec-log").innerHTML="",y("ec-result").style.display="none",Ge("Building HTML from template...");try{const n=await we.compose(e);if(n&&n.success===!1){const i=n.error||"Compose failed";Ge("✗ "+i),ye("error","Failed"),y("ec-result").innerHTML=`<div class="ec-result--error"><span class="ec-result__icon">✗</span> ${K(i)}</div>`,y("ec-result").style.display="",h.show("error",i,5e3)}else Ge("✓ OWA compose window opened — paste in progress..."),ye("ok","OWA window opened"),y("ec-result").innerHTML='<div class="ec-result--success"><span class="ec-result__icon">✓</span> Email composed in OWA — review and send.</div>',y("ec-result").style.display="",h.show("success","OWA compose window opened",4e3)}catch(n){Ge("✗ Error: "+n.message),ye("error","Error"),h.show("error","Compose failed: "+n.message)}finally{s.disabled=!1,s.textContent="Compose in OWA",a.disabled=!1}})}function fd(){y("ec-send-smtp").addEventListener("click",async()=>{const e=xa(),t=Ea(e);if(t){h.show("warn",t,3e3);return}const s=y("ec-send-smtp"),a=y("ec-compose");s.disabled=!0,s.textContent="Sending...",a.disabled=!0,ye("loading","Sending via SMTP..."),y("ec-log-wrap").style.display="",y("ec-log").innerHTML="",y("ec-result").style.display="none",Ge("Sending via SMTP...");try{const n=await we.send({to:e.to,cc:e.cc,subject:e.subject,composePayload:e});if(n&&n.ok)Ge("✓ Sent successfully"),ye("ok","Sent"),y("ec-result").innerHTML='<div class="ec-result--success"><span class="ec-result__icon">✓</span> Email sent via SMTP.</div>',y("ec-result").style.display="",h.show("success","Email sent",4e3);else{const i=n&&n.error||"SMTP send failed";Ge("✗ "+i),ye("error","Failed"),y("ec-result").innerHTML=`<div class="ec-result--error"><span class="ec-result__icon">✗</span> ${K(i)}</div>`,y("ec-result").style.display="",h.show("error",i,5e3)}}catch(n){Ge("✗ Error: "+n.message),ye("error","Error"),h.show("error","SMTP failed: "+n.message)}finally{s.disabled=!1,s.textContent="Send via SMTP",a.disabled=!1}})}function gd(){const e=y("ec-slot-am"),t=y("ec-slot-pm");!e||!t||(e.addEventListener("click",()=>{e.classList.add("ec-slot-btn--active"),t.classList.remove("ec-slot-btn--active"),Ke()}),t.addEventListener("click",()=>{t.classList.add("ec-slot-btn--active"),e.classList.remove("ec-slot-btn--active"),Ke()}))}function bd(){const e=y("ec-operator"),t=y("ec-domicile");e&&e.addEventListener("change",()=>{const s=e.value||"";t&&(t.innerHTML=bs(gs(s)),t.value="ALL"),Ke(),wt(),en()}),t&&t.addEventListener("change",()=>{Ke(),wt(),en()})}function Ke(){var i,l;const e=((i=y("ec-operator"))==null?void 0:i.value)||"",t=((l=y("ec-domicile"))==null?void 0:l.value)||"",s=jn(),a=Hn(e,s,t),n=y("ec-subject");n&&(n.value=a)}function wt(){var i,l;const e=y("ec-unit-count");if(!e)return;const t=(((i=y("ec-operator"))==null?void 0:i.value)||"").toUpperCase().trim(),s=(((l=y("ec-domicile"))==null?void 0:l.value)||"").trim(),n=(E.slice("fleet").rows||[]).filter(o=>{const d=(o.op||o.operator||"").toUpperCase().trim(),p=(o.domicileSite||o.domicile||"").trim();return(!t||d===t)&&(!s||s==="ALL"||p===s)});e.textContent=n.length?`${n.length} unit${n.length!==1?"s":""} match current scope`:"No units match current scope"}function ye(e,t){const s=y("ec-status-badge");s&&(s.className=`ec-status-badge ec-status-badge--${e}`,s.textContent=t)}function Ge(e){const t=y("ec-log");if(!t)return;const s=document.createElement("div");s.className="ec-log__line",s.textContent=e,t.appendChild(s),t.scrollTop=t.scrollHeight}function xa(){var e,t,s,a,n,i,l;return{operator:(((e=y("ec-operator"))==null?void 0:e.value)||"").trim(),domicile:(((t=y("ec-domicile"))==null?void 0:t.value)||"").trim(),slot:jn(),to:(((s=y("ec-to"))==null?void 0:s.value)||"").trim(),cc:(((a=y("ec-cc"))==null?void 0:a.value)||"").trim(),subject:(((n=y("ec-subject"))==null?void 0:n.value)||"").trim(),note:(((i=y("ec-note"))==null?void 0:i.value)||"").trim(),testMode:!!((l=y("ec-test-mode"))!=null&&l.checked)}}function Ea(e){return e.operator?e.to?e.subject?null:"Subject cannot be empty.":"Enter at least one recipient in the To field.":"Select an operator before composing."}async function hd(e){Qe=document.createElement("div"),Qe.id="view-email-composer",Qe.className="view view--email-composer",Qe.style.display="none",Os(),Qe.innerHTML=dd(),e.appendChild(Qe),y("ec-back").addEventListener("click",()=>{r.emit("ui:view-change",{from:"email-composer",to:"fleet"})}),gd(),bd(),ud(),rd(),vd(),md(),fd(),await cd(),await pd();try{const t=await we.getTestMode(),s=y("ec-test-mode");s&&(s.checked=!!t,s.addEventListener("change",async()=>{await we.setTestMode(s.checked).catch(()=>{})}))}catch{}Ke(),wt(),r.on("fleet:data",()=>{Os();const t=y("ec-operator");if(t){const s=t.value;t.innerHTML=la(),s&&(t.value=s);const a=y("ec-domicile");if(a){const n=a.value;a.innerHTML=bs(gs(s)),a.value=n||"ALL"}}wt()}),r.on("ui:view-change",({to:t})=>{if(Qe.style.display=t==="email-composer"?"flex":"none",t==="email-composer"){Os();const s=y("ec-operator");if(s){const a=s.value;s.innerHTML=la(),a&&(s.value=a);const n=y("ec-domicile");if(n){const i=n.value;n.innerHTML=bs(gs(a)),n.value=i||"ALL"}}Ke(),wt()}}),r.on("fleet:auto-email",async t=>{const{slot:s,triggeredAt:a,syncError:n}=t||{};console.log("[email-composer] Auto-email triggered: slot="+(s||"?")+" at "+(a||"unknown")),n&&console.warn("[email-composer] Auto-email sync had error:",n,"— proceeding with cached data");const i=s||ia(),l=y("ec-operator"),o=l?l.value:"",d=y("ec-domicile"),p=d?d.value:"ALL",u=Hn(o,i,p),c=o?o.toUpperCase():"",v=De[c]||{};try{const m=await we.compose({to:v.to||"",cc:v.cc||"",subject:u,label:"auto",operator:o,domicile:p,units:null,slot:i,testMode:!1,emailNote:""});console.log("[email-composer] Auto-email result:",m&&m.success?"SUCCESS":"FAILED")}catch(m){console.error("[email-composer] Auto-email compose error:",m)}})}let T=null,Z=[],ls=!1;const _t=e=>String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");function Wn(e){if(!e)return"—";const t=e instanceof Date?e:new Date(e);return t.toLocaleDateString("en-US",{month:"short",day:"numeric"})+" "+t.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:!1})}function zn(e){return e?(e instanceof Date?e:new Date(e)).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}):"—"}function yd(e){if(!e)return"";const t=Date.now()-new Date(e).getTime(),s=Math.floor(t/6e4);if(s<1)return"just now";if(s<60)return s+"m ago";const a=Math.floor(s/60);return a<24?a+"h ago":Math.floor(a/24)+"d ago"}function wd(){if(document.getElementById("dn-view-css"))return;const e=document.createElement("style");e.id="dn-view-css";const t=[];t.push(".view--daily-notes{flex:1;overflow-y:auto;padding:16px 20px 40px;display:flex;flex-direction:column;gap:14px}"),t.push(".dn-wrap{display:flex;flex-direction:column;gap:14px;max-width:900px;width:100%}"),t.push(".dn-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}"),t.push(".dn-header__left{display:flex;align-items:center;gap:10px}"),t.push(".dn-title{font-size:15px;font-weight:700;color:var(--txt);display:flex;align-items:center;gap:7px}"),t.push(".dn-badge{font-size:10px;padding:3px 8px;border-radius:20px;font-weight:600;background:rgba(63,185,80,.15);color:var(--grn,#3fb950);border:1px solid rgba(63,185,80,.3)}"),t.push(".dn-badge--warn{background:rgba(255,166,87,.15);color:var(--org,#ffa657);border-color:rgba(255,166,87,.3)}"),t.push(".dn-badge--muted{background:var(--el,rgba(255,255,255,.05));color:var(--mut,#6e7681);border-color:var(--bdr,rgba(240,246,252,.12))}"),t.push(".dn-header__right{display:flex;align-items:center;gap:8px}"),t.push(".dn-btn{padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s,opacity .15s;border:1px solid transparent}"),t.push(".dn-btn--primary{background:var(--acc,#1f6feb);border-color:var(--acc,#1f6feb);color:#fff}"),t.push(".dn-btn--primary:disabled{opacity:.45;cursor:not-allowed}"),t.push(".dn-btn--ghost{background:var(--el,rgba(255,255,255,.07));border-color:var(--bdr,rgba(240,246,252,.12));color:var(--txt2,#8b949e)}"),t.push(".dn-back{font-size:11px;color:var(--acc2,#58a6ff);cursor:pointer;display:inline-flex;align-items:center;gap:4px;margin-bottom:2px;background:none;border:none}"),t.push(".dn-back:hover{text-decoration:underline}"),t.push(".dn-stats{display:flex;gap:10px;flex-wrap:wrap}"),t.push(".dn-stat{flex:1;min-width:110px;background:var(--card,rgba(255,255,255,.04));border:1px solid var(--bdr,rgba(240,246,252,.12));border-radius:8px;padding:10px 14px;display:flex;flex-direction:column;gap:3px}"),t.push(".dn-stat__val{font-size:20px;font-weight:700;color:var(--txt,#eaeaea)}"),t.push(".dn-stat__lbl{font-size:10px;color:var(--mut,#6e7681);font-weight:500;text-transform:uppercase;letter-spacing:.04em}"),t.push(".dn-card{background:var(--card,rgba(255,255,255,.04));border:1px solid var(--bdr,rgba(240,246,252,.12));border-radius:10px;overflow:hidden}"),t.push(".dn-card__head{display:flex;align-items:center;justify-content:space-between;padding:11px 16px;border-bottom:1px solid var(--bdr,rgba(240,246,252,.08));cursor:pointer;user-select:none}"),t.push(".dn-card__head:hover{background:rgba(255,255,255,.02)}"),t.push(".dn-card__title{font-size:12px;font-weight:700;color:var(--txt,#eaeaea);display:flex;align-items:center;gap:7px}"),t.push(".dn-card__count{font-size:10px;padding:2px 8px;border-radius:20px;background:var(--el2,rgba(255,255,255,.08));color:var(--mut,#6e7681)}"),t.push(".dn-card__chev{font-size:10px;color:var(--mut,#6e7681);transition:transform .18s}"),t.push(".dn-card__chev--open{transform:rotate(180deg)}"),t.push(".dn-card__body{padding:0}"),t.push(".dn-card__body--hidden{display:none}"),t.push(".dn-result{display:flex;flex-direction:column;gap:5px;padding:10px 16px;border-bottom:1px solid rgba(240,246,252,.05)}"),t.push(".dn-result:last-child{border-bottom:none}"),t.push(".dn-result__row{display:flex;align-items:center;gap:8px}"),t.push(".dn-result__dot{font-size:11px;width:14px;flex-shrink:0;text-align:center}"),t.push(".dn-result__uid{font-size:11px;font-weight:700;color:var(--txt,#eaeaea);min-width:80px}"),t.push(".dn-result__vendor{font-size:10px;color:var(--mut,#6e7681);flex:1}"),t.push(".dn-result__dec{font-size:9px;padding:2px 7px;border-radius:20px;font-weight:600;border:1px solid transparent}"),t.push(".dn-result__dec--new{background:rgba(63,185,80,.12);color:var(--grn,#3fb950);border-color:rgba(63,185,80,.25)}"),t.push(".dn-result__dec--skip{background:var(--el,rgba(255,255,255,.05));color:var(--mut,#6e7681);border-color:var(--bdr)}"),t.push(".dn-result__dec--err{background:rgba(248,81,73,.12);color:var(--red,#f85149);border-color:rgba(248,81,73,.25)}"),t.push(".dn-result__note{font-size:11px;color:var(--txt2,#8b949e);background:var(--el,rgba(255,255,255,.04));border-radius:5px;padding:6px 10px;line-height:1.5;margin-left:22px}"),t.push(".dn-result__reason{font-size:10px;color:var(--mut,#6e7681);margin-left:22px;font-style:italic}"),t.push(".dn-run-item{display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid rgba(240,246,252,.05)}"),t.push(".dn-run-item:last-child{border-bottom:none}"),t.push(".dn-run-dot{width:8px;height:8px;border-radius:50%;background:var(--acc,#1f6feb);flex-shrink:0}"),t.push(".dn-run-date{font-size:11px;font-weight:600;color:var(--txt,#eaeaea);min-width:120px}"),t.push(".dn-run-counts{font-size:11px;color:var(--txt2,#8b949e);flex:1}"),t.push(".dn-run-rel{font-size:10px;color:var(--mut,#6e7681)}"),t.push(".dn-dec-table{width:100%;border-collapse:collapse;font-size:11px}"),t.push(".dn-dec-table th{text-align:left;padding:7px 16px;font-size:10px;font-weight:600;color:var(--mut,#6e7681);text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--bdr,rgba(240,246,252,.12))}"),t.push(".dn-dec-table td{padding:7px 16px;border-bottom:1px solid rgba(240,246,252,.04);vertical-align:top;color:var(--txt2,#8b949e)}"),t.push(".dn-dec-table tr:last-child td{border-bottom:none}"),t.push(".dn-dec-table tr:hover td{background:rgba(255,255,255,.02)}"),t.push(".dn-empty{padding:40px 20px;text-align:center;color:var(--mut,#6e7681);font-size:12px;display:flex;flex-direction:column;align-items:center;gap:10px}"),t.push(".dn-empty-icon{font-size:28px;opacity:.4}"),t.push("@keyframes dn-spin{to{transform:rotate(360deg)}}"),t.push(".dn-spin{display:inline-block;animation:dn-spin .8s linear infinite}"),e.textContent=t.join(`
`),document.head.appendChild(e)}function Vn(e){return e?e==="NEW_UPDATE"?"<span class=dn-result__dec dn-result__dec--new>New update</span>":e==="NO_ACTION_NEEDED"?"<span class=dn-result__dec dn-result__dec--skip>No action</span>":e==="NO_UPDATE_TODAY_NOT_LOGGED"?"<span class=dn-result__dec dn-result__dec--skip>No update logged</span>":e==="ERROR"?"<span class=dn-result__dec dn-result__dec--err>Error</span>":"<span class=dn-result__dec dn-result__dec--skip>"+_t(e)+"</span>":""}function _d(e){return e.decision==="ERROR"?'<span class="dn-result__dot" style="color:var(--red,#f85149)">✗</span>':e.hasChanges&&e.note?'<span class="dn-result__dot" style="color:var(--grn,#3fb950)">✓</span>':'<span class="dn-result__dot" style="color:var(--mut,#6e7681)">–</span>'}function kd(){const e=T&&T.querySelector("#dn-stats");if(!e)return;const t=Z.length,s=Z.reduce((l,o)=>l+(o.withUpdates||0),0),a=t?Z[0]:null,n=a&&a.count||0,i=a?Wn(a.timestamp):"—";e.innerHTML='<div class="dn-stat"><div class="dn-stat__val">'+t+'</div><div class="dn-stat__lbl">Total Runs</div></div><div class="dn-stat"><div class="dn-stat__val">'+s+'</div><div class="dn-stat__lbl">Notes Generated</div></div><div class="dn-stat"><div class="dn-stat__val">'+n+'</div><div class="dn-stat__lbl">Units Last Run</div></div><div class="dn-stat" style="min-width:180px"><div class="dn-stat__val" style="font-size:13px;padding-top:3px">'+i+'</div><div class="dn-stat__lbl">Last Run</div></div>'}function xd(){const e=T&&T.querySelector("#dn-lastrun-body");if(!e)return;const t=Z.length?Z[0]:null;if(!t||!Array.isArray(t.results)||!t.results.length){e.innerHTML='<div class="dn-empty"><div class="dn-empty-icon">&#128203;</div><div>No run data yet. Hit <strong>Run Now</strong> to start.</div></div>';return}e.innerHTML=t.results.map(function(s){const a=s.hasChanges&&s.note;return'<div class="dn-result"><div class="dn-result__row">'+_d(s)+'<span class="dn-result__uid">'+_t(s.unitId)+'</span><span class="dn-result__vendor">'+_t(s.vendor||"")+"</span>"+Vn(s.decision)+"</div>"+(a?'<div class="dn-result__note">'+_t(s.note)+"</div>":"")+"</div>"}).join("")}function Ed(){const e=T&&T.querySelector("#dn-runlog-body");if(e){if(!Z.length){e.innerHTML='<div class="dn-empty"><div class="dn-empty-icon">&#128200;</div><div>No run history yet.</div></div>';return}e.innerHTML=Z.map(function(t){return'<div class="dn-run-item"><div class="dn-run-dot"></div><div class="dn-run-date">'+zn(t.timestamp)+'</div><div class="dn-run-counts"><span style="color:var(--grn,#3fb950)">'+(t.withUpdates||0)+" notes</span> &middot; "+((t.count||0)-(t.withUpdates||0))+" skipped &middot; "+(t.count||0)+' units</div><div class="dn-run-rel">'+yd(t.timestamp)+"</div></div>"}).join("")}}function Sd(){const e=T&&T.querySelector("#dn-declog-body");if(!e)return;const t=[];if((Z||[]).forEach(function(a){(a.results||[]).forEach(function(n){t.push(Object.assign({},n,{runTS:a.timestamp}))})}),!t.length){e.innerHTML='<div class="dn-empty"><div class="dn-empty-icon">&#128220;</div><div>No decision data yet.</div></div>';return}const s=t.slice(0,100).map(function(a){return'<tr><td style="font-weight:600;color:var(--txt,#eaeaea)">'+_t(a.unitId)+"</td><td>"+Vn(a.decision)+'</td><td style="max-width:280px">'+_t(a.reason||"—")+'</td><td style="white-space:nowrap">'+Wn(a.runTS)+"</td></tr>"}).join("");e.innerHTML='<table class="dn-dec-table"><thead><tr><th>Unit</th><th>Decision</th><th>Reason</th><th>Run Time</th></tr></thead><tbody>'+s+"</tbody></table>"}function da(){const e=T&&T.querySelector("#dn-run-btn");e&&(ls?(e.disabled=!0,e.innerHTML='<span class="dn-spin">↻</span> Running…'):(e.disabled=!1,e.innerHTML="▶ Run Now"))}function Ld(){const e=T&&T.querySelector("#dn-last-badge");if(!e)return;const t=Z.length?Z[0]:null;if(!t){e.textContent="Never run",e.className="dn-badge dn-badge--muted";return}const s=Math.floor((Date.now()-new Date(t.timestamp).getTime())/36e5);s<1?(e.textContent="Run < 1h ago",e.className="dn-badge"):s<8?(e.textContent=s+"h ago",e.className="dn-badge"):(e.textContent="Last run: "+zn(t.timestamp),e.className="dn-badge dn-badge--warn")}function Cd(){const e=Z.length?Z[0]:null,t=T.querySelector("#dn-lastrun-count");t&&(t.textContent=e&&e.count||0);const s=T.querySelector("#dn-runlog-count");s&&(s.textContent=Z.length);const a=T.querySelector("#dn-declog-count"),n=Z.reduce((i,l)=>i+(l.results?l.results.length:0),0);a&&(a.textContent=Math.min(n,100))}function Ns(e,t,s){const a=T.querySelector("#"+e),n=T.querySelector("#"+t),i=T.querySelector("#"+s);!a||!n||a.addEventListener("click",function(){const l=n.classList.toggle("dn-card__body--hidden");i&&i.classList.toggle("dn-card__chev--open",!l)})}async function Id(){try{const e=window.ai&&typeof window.ai.getDailyNotesLog=="function"?await window.ai.getDailyNotesLog():[];Z=Array.isArray(e)?e.slice().reverse():[]}catch(e){console.warn("[daily-notes view] getDailyNotesLog error:",e),Z=[]}}function $d(){kd(),xd(),Ed(),Sd(),da(),Cd()}async function Ad(){if(ls)return;if(!window.ai||typeof window.ai.runDailyNotes!="function"){r.emit("ui:toast",{type:"warning",message:"runDailyNotes not available",duration:3e3});return}const e=E.slice("fleet"),t=Array.isArray(e.rows)?e.rows:[];if(!t.length){r.emit("ui:toast",{type:"warning",message:"No units loaded -- sync first",duration:3e3});return}ls=!0,da();try{await window.ai.runDailyNotes(t),await Id(),$d(),Ld()}catch(s){console.warn("[daily-notes view] run error:",s)}finally{ls=!1,da()}}function Bd(){T.innerHTML='<div class="dn-wrap"><button class="dn-back" id="dn-back-btn">← Fleet Table</button><div class="dn-header"><div class="dn-header__left"><div class="dn-title">&#128203; Daily Notes</div><span class="dn-badge dn-badge--muted" id="dn-last-badge">Never run</span></div><div class="dn-header__right"><button class="dn-btn dn-btn--ghost" id="dn-refresh-btn">蘵 Refresh</button><button class="dn-btn dn-btn--primary" id="dn-run-btn">▶ Run Now</button></div></div><div class="dn-stats" id="dn-stats"></div><div class="dn-card"><div class="dn-card__head" id="dn-lastrun-head"><div class="dn-card__title">&#127970; Last Run Results<span class="dn-card__count" id="dn-lastrun-count">0</span></div><span class="dn-card__chev dn-card__chev--open" id="dn-lastrun-chev">&#9660;</span></div><div class="dn-card__body" id="dn-lastrun-body"></div></div><div class="dn-card"><div class="dn-card__head" id="dn-runlog-head"><div class="dn-card__title">&#128200; Run History<span class="dn-card__count" id="dn-runlog-count">0</span></div><span class="dn-card__chev dn-card__chev--open" id="dn-runlog-chev">&#9660;</span></div><div class="dn-card__body" id="dn-runlog-body"></div></div><div class="dn-card"><div class="dn-card__head" id="dn-declog-head"><div class="dn-card__title">&#128220; Decision Log<span class="dn-card__count" id="dn-declog-count">0</span></div><span class="dn-card__chev" id="dn-declog-chev">&#9660;</span></div><div class="dn-card__body dn-card__body--hidden" id="dn-declog-body"></div></div></div>'}function Td(e){wd(),T=document.createElement("div"),T.id="view-daily-notes",T.className="view view--daily-notes",T.style.display="none",Bd(),e.appendChild(T),T.querySelector("#dn-back-btn").addEventListener("click",()=>r.emit("ui:view-change",{from:"daily-notes",to:"fleet"})),T.querySelector("#dn-run-btn").addEventListener("click",Ad);const t=T.querySelector("#dn-refresh-btn");t.addEventListener("click",async function(){t.disabled=!0,t.innerHTML="↻",await _activate(),t.disabled=!1,t.innerHTML="↻ Refresh"}),Ns("dn-lastrun-head","dn-lastrun-body","dn-lastrun-chev"),Ns("dn-runlog-head","dn-runlog-body","dn-runlog-chev"),Ns("dn-declog-head","dn-declog-body","dn-declog-chev"),r.on("ui:view-change",({to:s})=>{const a=s==="daily-notes";T.style.display=a?"flex":"none",a&&_activate()}),r.on("fleet:data",()=>{T.style.display!=="none"&&_activate()}),console.log("[daily-notes view] init complete")}const Fn="fleet-notes-links-v1";function It(){try{const e=localStorage.getItem(Fn);if(e)return JSON.parse(e)}catch{}return[]}function Gn(e){try{localStorage.setItem(Fn,JSON.stringify(e))}catch{}}function Dd(){return"nl_"+Date.now()+"_"+Math.random().toString(36).slice(2,8)}const W=e=>String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");function Pd(e){try{return`https://www.google.com/s2/favicons?sz=32&domain=${new URL(e).hostname}`}catch{return""}}function Rd(e){return(e||"?").charAt(0).toUpperCase()}function tn(e,t){const s=String(e||"").trim();if(!s||s==="--"){h.show("warn","Nothing to copy",2e3);return}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(s).then(()=>h.show("success",(t||"Value")+" copied",1800)).catch(()=>h.show("error","Copy failed",2e3));return}const a=document.createElement("textarea");a.value=s,a.style.cssText="position:fixed;left:-9999px;top:0;opacity:0;",document.body.appendChild(a),a.select();try{document.execCommand("copy"),h.show("success",(t||"Value")+" copied",1800)}catch{h.show("error","Copy failed",2e3)}a.remove()}let se=null,ca={},es=null,Ze="";function Md(e){const t=Pd(e.url),s=Rd(e.name),a=!!ca[e.id],n=e.pass?a?W(e.pass):"••••••••":'<span class="nl-cred-none">not set</span>',i=e.autofill?'<span class="nl-autofill-badge">&#9889; AUTOFILL</span>':"",l=e.pass||e.passLabel?`<div class="nl-cred-row">
        <span class="nl-cred-label">${W(e.passLabel||"Password")}</span>
        <span class="nl-cred-value${a?"":" nl-pw-hidden"}">${n}</span>
        <button class="nl-toggle-pw" data-nl-toggle="${W(e.id)}" title="${a?"Hide":"Show"} password">
          ${a?"&#128584;":"&#128065;"}
        </button>
        <button class="nl-copy-btn" data-nl-copy="pass" data-nl-id="${W(e.id)}">COPY</button>
      </div>`:"";return`
    <div class="nl-card" data-nl-card="${W(e.id)}">
      <div class="nl-site-row">
        <img class="nl-favicon" src="${W(t)}"
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" alt="">
        <div class="nl-favicon-fallback" style="display:none">${W(s)}</div>
        <div class="nl-site-info">
          <div class="nl-site-name">${W(e.name)}</div>
          <a class="nl-site-link" href="${W(e.url)}" target="_blank" rel="noopener noreferrer">${W(e.url)}</a>
        </div>
        ${i}
      </div>
      <div class="nl-cred-row">
        <span class="nl-cred-label">${W(e.userLabel||"Username")}</span>
        <span class="nl-cred-value">${e.user?W(e.user):'<span class="nl-cred-none">not set</span>'}</span>
        <button class="nl-copy-btn" data-nl-copy="user" data-nl-id="${W(e.id)}">COPY</button>
      </div>
      ${l}
      <div class="nl-card-actions">
        <button class="nl-edit-btn"   data-nl-edit="${W(e.id)}">&#9998; EDIT</button>
        <button class="nl-delete-btn" data-nl-delete="${W(e.id)}">&#10005; DELETE</button>
      </div>
    </div>`}function kt(){const e=se?se.querySelector("#nl-list"):null;if(!e)return;let t=It();if(Ze){const n=Ze.toLowerCase();t=t.filter(i=>(i.name||"").toLowerCase().includes(n)||(i.url||"").toLowerCase().includes(n)||(i.user||"").toLowerCase().includes(n))}const s=It().length,a=se.querySelector("#nl-count");if(a&&(a.textContent=Ze?`${t.length} / ${s} sites`:`${s} site${s!==1?"s":""}`),t.length===0){e.innerHTML=Ze?`<div class="nl-empty">No sites match &ldquo;<strong>${W(Ze)}</strong>&rdquo;</div>`:'<div class="nl-empty">No sites saved yet.<br>Click <strong>+ ADD SITE</strong> to get started.</div>';return}e.innerHTML=t.map(Md).join(""),qd(e)}function qd(e){e.querySelectorAll(".nl-copy-btn").forEach(t=>{t.addEventListener("click",s=>{s.stopPropagation();const a=t.dataset.nlCopy,n=t.dataset.nlId,l=It().find(o=>o.id===n);l&&(a==="user"?tn(l.user,l.userLabel||"Username"):tn(l.pass,l.passLabel||"Password"))})}),e.querySelectorAll(".nl-toggle-pw").forEach(t=>{t.addEventListener("click",s=>{s.stopPropagation();const a=t.dataset.nlToggle;ca[a]=!ca[a],kt()})}),e.querySelectorAll(".nl-edit-btn").forEach(t=>{t.addEventListener("click",s=>{s.stopPropagation(),Xn(t.dataset.nlEdit)})}),e.querySelectorAll(".nl-delete-btn").forEach(t=>{t.addEventListener("click",s=>{s.stopPropagation();const a=t.dataset.nlDelete;if(t.dataset.confirming==="1"){const n=It().filter(i=>i.id!==a);Gn(n),h.show("info","Site removed",2e3),kt();return}t.dataset.confirming="1",t.textContent="CONFIRM?",t.classList.add("nl-delete-btn--confirming"),setTimeout(()=>{t.dataset.confirming==="1"&&(t.dataset.confirming="0",t.textContent="✕ DELETE",t.classList.remove("nl-delete-btn--confirming"))},3e3)})})}function Xn(e){es=e||null;const t=It(),s=e?t.find(i=>i.id===e):null,a=document.getElementById("nl-modal-overlay");a&&a.remove();const n=document.createElement("div");n.id="nl-modal-overlay",n.className="nl-modal-overlay",n.innerHTML=`
    <div class="nl-modal-box" id="nl-modal-box">
      <div class="nl-modal-title">${s?"&#9998; EDIT SITE":"+ ADD NEW SITE"}</div>

      <div class="nl-modal-field">
        <label class="nl-modal-label">SITE NAME</label>
        <input class="nl-modal-input" id="nl-f-name" placeholder="e.g. Decisiv Volvo"
          value="${s?W(s.name):""}">
      </div>
      <div class="nl-modal-field">
        <label class="nl-modal-label">URL</label>
        <input class="nl-modal-input" id="nl-f-url" placeholder="https://..."
          value="${s?W(s.url):""}">
      </div>
      <div class="nl-modal-field">
        <label class="nl-modal-label">USERNAME LABEL</label>
        <input class="nl-modal-input" id="nl-f-userLabel" placeholder="Username"
          value="${s?W(s.userLabel||"Username"):"Username"}">
      </div>
      <div class="nl-modal-field">
        <label class="nl-modal-label">USERNAME / EMAIL / CODE</label>
        <input class="nl-modal-input" id="nl-f-user" placeholder="user@example.com"
          value="${s?W(s.user||""):""}">
      </div>
      <div class="nl-modal-field">
        <label class="nl-modal-label">PASSWORD <span class="nl-modal-label-hint">(leave blank if not needed)</span></label>
        <input class="nl-modal-input" id="nl-f-pass" type="password" placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;"
          value="${s?W(s.pass||""):""}">
      </div>
      <div class="nl-modal-field nl-modal-field--row">
        <input type="checkbox" id="nl-f-autofill" ${!s||s.autofill?"checked":""}>
        <label for="nl-f-autofill" class="nl-modal-check-label">Enable autofill when visiting this site</label>
      </div>

      <div class="nl-modal-actions">
        <button class="nl-modal-cancel" id="nl-modal-cancel">Cancel</button>
        <button class="nl-modal-save"   id="nl-modal-save">SAVE</button>
      </div>
    </div>`,document.body.appendChild(n),setTimeout(()=>{const i=document.getElementById("nl-f-name");i&&i.focus()},50),document.getElementById("nl-modal-cancel").addEventListener("click",()=>n.remove()),n.addEventListener("click",i=>{i.target===n&&n.remove()}),document.getElementById("nl-modal-save").addEventListener("click",()=>{const i=(document.getElementById("nl-f-name").value||"").trim(),l=(document.getElementById("nl-f-url").value||"").trim(),o=(document.getElementById("nl-f-userLabel").value||"").trim()||"Username",d=(document.getElementById("nl-f-user").value||"").trim(),p=document.getElementById("nl-f-pass").value||"",u=document.getElementById("nl-f-autofill").checked;if(!i){h.show("warn","Site name is required",3e3);return}if(!l){h.show("warn","URL is required",3e3);return}let c="";try{c=new URL(l).hostname}catch{c=l}const v=p?"Password":"",m=It();if(es){const g=m.findIndex(x=>x.id===es);g!==-1&&(m[g]=Object.assign(m[g],{name:i,url:l,matchPattern:c,userLabel:o,user:d,passLabel:v,pass:p,autofill:u})),h.show("success","Site updated",2e3)}else m.push({id:Dd(),name:i,url:l,matchPattern:c,userLabel:o,user:d,passLabel:v,pass:p,autofill:u,userSelector:'input[type="email"],input[type="text"],input[name*="user"],input[id*="user"]',passSelector:'input[type="password"]',submitSelector:'button[type="submit"],input[type="submit"]'}),h.show("success","Site added",2e3);Gn(m),n.remove(),es=null,kt()}),n.addEventListener("keydown",i=>{i.key==="Enter"&&i.target.tagName!=="TEXTAREA"&&document.getElementById("nl-modal-save").click(),i.key==="Escape"&&n.remove()})}function Od(){return`
    <div class="nl-wrap">
      <div class="nl-header">
        <div class="nl-header__left">
          <span class="nl-title">&#8599; Notes &amp; Links</span>
          <span class="nl-subtitle">Saved portal credentials &amp; site logins</span>
        </div>
        <div class="nl-header__actions">
          <input id="nl-search" class="nl-search-input" type="search"
            placeholder="Search sites..." autocomplete="off" spellcheck="false" />
          <button id="nl-add-btn" class="detail-panel__btn nl-add-btn">+ ADD SITE</button>
          <button id="nl-back" class="detail-panel__btn detail-panel__btn--secondary">Back to Fleet</button>
        </div>
      </div>
      <div class="nl-meta">
        <span id="nl-count" class="nl-count">0 sites</span>
      </div>
      <div class="nl-body">
        <div id="nl-list" class="nl-list"></div>
      </div>
    </div>`}function Ud(e){se=document.createElement("div"),se.id="view-notes-links",se.className="view view--notes-links",se.style.display="none",se.innerHTML=Od(),e.appendChild(se),se.querySelector("#nl-back").addEventListener("click",()=>{r.emit("ui:view-change",{from:"notes-links",to:"fleet"})}),se.querySelector("#nl-add-btn").addEventListener("click",()=>{Xn(null)});let t=null;se.querySelector("#nl-search").addEventListener("input",s=>{clearTimeout(t),t=setTimeout(()=>{Ze=s.target.value.trim(),kt()},150)}),r.on("ui:view-change",({to:s})=>{if(se.style.display=s==="notes-links"?"flex":"none",s==="notes-links"){Ze="";const a=se.querySelector("#nl-search");a&&(a.value=""),kt()}}),kt()}const Jn="fleet_rca_queue_v1";function Nd(){try{return JSON.parse(localStorage.getItem(Jn)||"[]")}catch{return[]}}function vt(e){try{localStorage.setItem(Jn,JSON.stringify(e))}catch{}}const Hd=["Engine/Motor Systems","Chassis","Electrical","Cab, Climate Control, Instrumentation","Accessories","Tires/Wheels","Brakes","Transmission/Drivetrain","Exhaust/Aftertreatment","Suspension","Cooling System","Fuel System","Body/Frame"],jd=["Normal wear","Defective part","Improper previous repair","Driver abuse","Road hazard","Environmental","Design/manufacturing defect","Improper maintenance","Corrosion/contamination","Overloading","Unknown"],Wd=["Age/mileage","Defective part/material","Driver error","Improper maintenance","Road conditions","Weather/environment","Design flaw","Installation error","Contamination","Unknown"],zd=["Replaced","Repaired","Adjusted","Cleaned","Lubricated","Welded","Recharged","Reflashed/reprogrammed","Tightened","Inspected (no action)","Pending parts","Deferred"];let ke=null,O=Nd(),oe=null,os="",sn={};const D=e=>String(e||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");function Vd(e){let t=0;for(const s of e){const a=s.equipmentId;if(!a)continue;const n=sn[a]||"",i=(s.lifecycleState||"").toLowerCase();sn[a]=i,!n.includes("unavail")&&i.includes("unavail")&&(O.find(l=>l.equipmentId===a)||(O.push({equipmentId:a,operator:s.operator||"",domicileSite:s.domicileSite||"",lifecycleReason:s.lifecycleReason||"",vendor:s.vendor||"",duration:s.duration||s.workDuration||"",addedAt:new Date().toISOString(),primaryComponent:"",failureCode:"",causeCode:"",workCode:"",maintenanceCode:"",controllable:"",notes:"",completed:!1}),t++))}t>0&&(vt(O),Ve(),r.emit("rca:count-update",{count:O.filter(s=>!s.completed).length}))}function Ve(){if(!ke)return;const e=O.filter(a=>!a.completed),t=os?e.filter(a=>(a.operator||"").toUpperCase().includes(os.toUpperCase())):e,s=[...new Set(e.map(a=>a.operator).filter(Boolean))].sort();ke.innerHTML=`
    <div class="rca-wrap">
      <div class="rca-header">
        <div class="rca-header__left">
          <span class="rca-title">🔬 RCA-Ready Queue</span>
          <span class="rca-badge">${e.length}</span>
        </div>
        <div class="rca-header__right">
          <select id="rca-op-filter" class="rca-filter-select">
            <option value="">All Operators</option>
            ${s.map(a=>'<option value="'+D(a)+'"'+(os===a?" selected":"")+">"+D(a)+"</option>").join("")}
          </select>
          <button id="rca-clear-done" class="rca-btn rca-btn--ghost">Clear Completed</button>
        </div>
      </div>

      <div class="rca-body">
        <div class="rca-list" id="rca-list">
          ${t.length===0?'<div class="rca-empty">No units awaiting RCA. Units will appear here when they transition to Unavailable.</div>':t.map(a=>Fd(a)).join("")}
        </div>
        <div class="rca-detail" id="rca-detail">
          ${oe?Gd(O.find(a=>a.equipmentId===oe)):'<div class="rca-empty">Select a unit to assign RCA codes</div>'}
        </div>
      </div>
    </div>
  `,Jd()}function Fd(e){const t=e.equipmentId===oe,s=!!(e.primaryComponent||e.failureCode);return`
    <div class="rca-item${t?" rca-item--active":""}${s?" rca-item--coded":""}" data-id="${D(e.equipmentId)}">
      <div class="rca-item__dot${s?" rca-item__dot--done":""}"></div>
      <div class="rca-item__body">
        <div class="rca-item__id">${D(e.equipmentId)}</div>
        <div class="rca-item__meta">${D(e.operator)} · ${D(e.domicileSite)} · ${D(e.lifecycleReason||"Unavailable")}</div>
        ${e.vendor?'<div class="rca-item__vendor">'+D(e.vendor)+"</div>":""}
      </div>
      <div class="rca-item__right">
        ${e.duration&&e.duration!=="--"?'<span class="rca-item__dur">'+D(e.duration)+"</span>":""}
        ${s?'<span class="rca-item__check">✓</span>':""}
      </div>
    </div>
  `}function Gd(e){return e?`
    <div class="rca-detail-inner">
      <div class="rca-detail__header">
        <span class="rca-detail__id">${D(e.equipmentId)}</span>
        <span class="rca-detail__meta">${D(e.operator)} · ${D(e.domicileSite)}</span>
      </div>
      <div class="rca-detail__info">
        <div class="rca-detail__row"><span class="rca-detail__lbl">Reason:</span> <span>${D(e.lifecycleReason||"--")}</span></div>
        <div class="rca-detail__row"><span class="rca-detail__lbl">Vendor:</span> <span>${D(e.vendor||"--")}</span></div>
        <div class="rca-detail__row"><span class="rca-detail__lbl">Duration:</span> <span>${D(e.duration||"--")}</span></div>
        <div class="rca-detail__row"><span class="rca-detail__lbl">Added:</span> <span>${Xd(e.addedAt)}</span></div>
      </div>

      <div class="rca-detail__section-title">
        Root Cause Analysis
        <button id="rca-ai-suggest" class="rca-btn rca-btn--accent" style="margin-left:auto;font-size:11px;padding:3px 10px" title="AI-infer RCA codes from lifecycle reason">⚡ Auto-detect</button>
      </div>
      <div id="rca-ai-hints" class="rca-ai-hints" style="display:none"></div>
      <div class="rca-field">
        <label class="rca-field__label">Primary Component</label>
        <select class="rca-field__select" data-field="primaryComponent">
          <option value="">— Select —</option>
          ${Hd.map(t=>'<option value="'+D(t)+'"'+(e.primaryComponent===t?" selected":"")+">"+D(t)+"</option>").join("")}
        </select>
      </div>

      <div class="rca-field">
        <label class="rca-field__label">Technician Failure Code</label>
        <select class="rca-field__select" data-field="failureCode">
          <option value="">— Select —</option>
          ${jd.map(t=>'<option value="'+D(t)+'"'+(e.failureCode===t?" selected":"")+">"+D(t)+"</option>").join("")}
        </select>
      </div>

      <div class="rca-field">
        <label class="rca-field__label">Primary Cause Code</label>
        <select class="rca-field__select" data-field="causeCode">
          <option value="">— Select —</option>
          ${Wd.map(t=>'<option value="'+D(t)+'"'+(e.causeCode===t?" selected":"")+">"+D(t)+"</option>").join("")}
        </select>
      </div>

      <div class="rca-field">
        <label class="rca-field__label">Work Accomplished</label>
        <select class="rca-field__select" data-field="workCode">
          <option value="">— Select —</option>
          ${zd.map(t=>'<option value="'+D(t)+'"'+(e.workCode===t?" selected":"")+">"+D(t)+"</option>").join("")}
        </select>
      </div>

      <div class="rca-field">
        <label class="rca-field__label">Maintenance Code</label>
        <input class="rca-field__input" type="text" data-field="maintenanceCode" value="${D(e.maintenanceCode)}" placeholder="e.g. PM-B, DOT, Unplanned"/>
      </div>

      <div class="rca-field">
        <label class="rca-field__label">Controllable?</label>
        <select class="rca-field__select" data-field="controllable">
          <option value="">— Select —</option>
          <option value="Yes"${e.controllable==="Yes"?" selected":""}>Yes — Controllable</option>
          <option value="No"${e.controllable==="No"?" selected":""}>No — Non-controllable</option>
        </select>
      </div>

      <div class="rca-field">
        <label class="rca-field__label">Notes</label>
        <textarea class="rca-field__textarea" data-field="notes" placeholder="Additional RCA notes...">${D(e.notes)}</textarea>
      </div>

      <div class="rca-detail__actions">
        <button id="rca-investigate" class="rca-btn rca-btn--accent" title="Launch vendor investigation workflow for this unit">🔍 Investigate</button>
        <button id="rca-mark-done" class="rca-btn rca-btn--primary"${e.completed?" disabled":""}>✓ Mark Complete</button>
        <button id="rca-remove" class="rca-btn rca-btn--danger">Remove</button>
      </div>
    </div>
  `:'<div class="rca-empty">Select a unit to assign RCA codes</div>'}function Xd(e){if(!e)return"--";const t=new Date(e);return t.toLocaleDateString("en-US",{month:"short",day:"numeric"})+" "+t.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:!1})}function Jd(){ke.querySelectorAll(".rca-item").forEach(l=>{l.addEventListener("click",()=>{oe=l.dataset.id,Ve()})});const e=document.getElementById("rca-op-filter");e&&e.addEventListener("change",()=>{os=e.value,Ve()});const t=document.getElementById("rca-clear-done");t&&t.addEventListener("click",()=>{O=O.filter(l=>!l.completed),vt(O),Ve(),h.show("info","Completed RCA items cleared",2e3)}),ke.querySelectorAll(".rca-field__select, .rca-field__input, .rca-field__textarea").forEach(l=>{const o=l.tagName==="TEXTAREA"?"input":"change";l.addEventListener(o,()=>{if(!oe)return;const d=O.find(u=>u.equipmentId===oe);if(!d)return;d[l.dataset.field]=l.value,vt(O);const p=ke.querySelector(`.rca-item[data-id="${oe}"]`);if(p){const u=!!(d.primaryComponent||d.failureCode);p.classList.toggle("rca-item--coded",u)}})});const s=document.getElementById("rca-ai-suggest");s&&s.addEventListener("click",async()=>{const l=O.find(d=>d.equipmentId===oe);if(!l)return;s.disabled=!0,s.textContent="⏳...";const o=document.getElementById("rca-ai-hints");try{const d=[l.lifecycleReason,l.vendor,l.notes||""].filter(Boolean).join(" "),{ai:p}=await fa(async()=>{const{ai:c}=await Promise.resolve().then(()=>ua);return{ai:c}},void 0,import.meta.url),u=await p.inferRCA(d,{vendor:l.vendor,component:l.primaryComponent});u&&u.suggestions&&u.suggestions.length?(o.style.display="block",o.innerHTML=u.suggestions.slice(0,3).map(c=>'<div class="rca-ai-hint" data-code="'+D(c.code)+'"><span class="rca-ai-hint__code">'+D(c.code)+'</span> <span class="rca-ai-hint__desc">'+D(c.desc)+'</span> <span class="rca-ai-hint__conf">'+Math.round(c.confidence)+"%</span></div>").join(""),h.show("info","AI detected "+u.suggestions.length+" possible RCA codes",2500)):(o.style.display="block",o.innerHTML='<div class="rca-ai-hint rca-ai-hint--empty">No patterns matched — assign manually</div>')}catch(d){h.show("error","RCA inference error: "+d.message,3e3)}s.disabled=!1,s.textContent="⚡ Auto-detect"});const a=document.getElementById("rca-investigate");a&&a.addEventListener("click",async()=>{const l=O.find(o=>o.equipmentId===oe);if(l){a.disabled=!0,a.textContent="⏳ Launching...";try{const o={equipmentId:l.equipmentId,operator:l.operator,domicileSite:l.domicileSite,lifecycleReason:l.lifecycleReason,vendor:l.vendor},d=await ne.investigate(o);d&&d.error?h.show("error","Investigation failed: "+d.error,3e3):(h.show("success","Vendor investigation launched for "+l.equipmentId,3e3),l.investigatedAt=new Date().toISOString(),vt(O))}catch(o){h.show("error","Investigate error: "+o.message,3e3)}a.disabled=!1,a.textContent="🔍 Investigate"}});const n=document.getElementById("rca-mark-done");n&&n.addEventListener("click",()=>{const l=O.find(o=>o.equipmentId===oe);l&&(l.completed=!0,l.completedAt=new Date().toISOString(),vt(O),oe=null,Ve(),r.emit("rca:count-update",{count:O.filter(o=>!o.completed).length}),h.show("success","RCA complete for "+l.equipmentId,2500))});const i=document.getElementById("rca-remove");i&&i.addEventListener("click",()=>{O=O.filter(l=>l.equipmentId!==oe),vt(O),oe=null,Ve(),r.emit("rca:count-update",{count:O.filter(l=>!l.completed).length}),h.show("info","Unit removed from RCA queue",2e3)})}function Kd(e){ke=document.createElement("div"),ke.id="view-rca-queue",ke.className="view view--rca-queue",ke.style.display="none",e.appendChild(ke),Ve(),r.on("fleet:data",t=>{const s=t.rows||[];Vd(s)}),r.on("ui:view-change",({to:t})=>{ke.style.display=t==="rca-queue"?"flex":"none",t==="rca-queue"&&Ve()}),r.emit("rca:count-update",{count:O.filter(t=>!t.completed).length})}function an(){const e=document.getElementById("app-loading");e&&e.remove();const t=document.getElementById("app");if(!t){console.error("[app] #app mount point not found");return}t.innerHTML=`
    <div id="app-shell">
      <div id="toolbar-mount"></div>
      <div id="vnd-activity-bar-mount"></div>
      <div id="body-area">
        <div id="priority-drawer-mount"></div>
        <div id="content-area">
          <div id="views-mount"></div>
          <div id="detail-mount"></div>
        </div>
      </div>
      <div id="status-bar-mount"></div>
    </div>
  `,oi(),ci(document.getElementById("toolbar-mount")),fi(document.getElementById("vnd-activity-bar-mount")),Ei(document.getElementById("priority-drawer-mount")),Si(),Li(),Ai(),Pi(),qi(),Gi(),Ki(document.getElementById("status-bar-mount")),Qi();const s=document.getElementById("views-mount"),a=document.getElementById("detail-mount");ul(s),lo(a),Ho(s),Yo(s),od(s),hd(s),Td(s),Ud(s),Kd(s),Io(),Co();const n=document.getElementById("view-fleet"),i=document.getElementById("view-analytics"),l=document.getElementById("view-vendors"),o=document.getElementById("view-email-composer"),d=document.getElementById("view-schedulers"),p=document.getElementById("view-daily-notes"),u=document.getElementById("view-notes-links"),c=document.getElementById("view-rca-queue");r.on("ui:view-change",({to:m})=>{m!=="settings"&&(n&&(n.style.display=m==="fleet"?"flex":"none"),i&&(i.style.display=m==="analytics"?"flex":"none"),l&&(l.style.display=m==="vendors"?"flex":"none"),o&&(o.style.display=m==="email-composer"?"flex":"none"),d&&(d.style.display=m==="schedulers"?"flex":"none"),p&&(p.style.display=m==="daily-notes"?"flex":"none"),u&&(u.style.display=m==="notes-links"?"flex":"none"),c&&(c.style.display=m==="rca-queue"?"flex":"none"))}),r.on("ui:view-change",()=>r.emit("ui:unit-deselect")),on();let v=!1;r.on("fleet:auth-failure",m=>{if(v)return;v=!0;const g=m&&m.code||"SESSION_EXPIRED",x=m&&m.message||"Your session has expired. Re-authenticate to continue.",f=document.createElement("div");f.id="auth-failure-overlay",f.style.cssText=`
      position:fixed; inset:0; z-index:99999;
      background:rgba(0,0,0,.75); backdrop-filter:blur(4px);
      display:flex; align-items:center; justify-content:center;
    `,f.innerHTML=`
      <div style="
        background:var(--bg2,#1a1a2e); border:1px solid var(--border,#333);
        border-radius:12px; padding:32px 40px; max-width:440px; width:90%;
        text-align:center; box-shadow:0 8px 32px rgba(0,0,0,.5);
      ">
        <div style="font-size:40px;margin-bottom:12px">⚠️</div>
        <h2 style="margin:0 0 8px;color:var(--fg,#eee);font-size:18px">Session Expired</h2>
        <p style="margin:0 0 20px;color:var(--fg2,#aaa);font-size:14px;line-height:1.5">
          ${x}<br><small style="opacity:.6">Code: ${g}</small>
        </p>
        <button id="auth-reauth-btn" style="
          background:var(--acc,#00d4ff); color:#000; border:none;
          padding:10px 28px; border-radius:6px; font-size:14px; font-weight:600;
          cursor:pointer; margin-right:12px;
        ">Re-authenticate</button>
        <button id="auth-dismiss-btn" style="
          background:transparent; color:var(--fg2,#aaa); border:1px solid var(--border,#444);
          padding:10px 20px; border-radius:6px; font-size:14px; cursor:pointer;
        ">Dismiss</button>
        <div id="auth-reauth-status" style="margin-top:16px;font-size:13px;color:var(--fg2,#888);display:none"></div>
      </div>
    `,document.body.appendChild(f);const w=f.querySelector("#auth-reauth-status");f.querySelector("#auth-reauth-btn").addEventListener("click",async()=>{w.style.display="block",w.textContent="Running mwinit...";try{const b=await window.auth.runMwinit();b&&b.ok?(w.textContent="✅ Authenticated! Resyncing...",setTimeout(()=>{f.remove(),v=!1,window.fleet.requestSync()},1e3)):w.textContent="❌ Failed: "+(b&&b.reason||"unknown error")}catch(b){w.textContent="❌ Error: "+b.message}}),f.querySelector("#auth-dismiss-btn").addEventListener("click",()=>{f.remove(),v=!1})}),console.log("[app] Fleet Operations boot complete")}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",an):an();
