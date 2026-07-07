import"./fleet-Cq-x1MBL.js";const r=[{id:"profile",title:"Your Profile",html:`
      <label>Full Name <input id="sw-name" type="text" class="setup__input" placeholder="Jane Smith" /></label>
      <label>Amazon Email <input id="sw-email" type="email" class="setup__input" placeholder="jansmith@amazon.com" /></label>
      <label>Phone (optional) <input id="sw-phone" type="tel" class="setup__input" placeholder="+1 555 0100" /></label>
    `,collect:()=>({userName:document.getElementById("sw-name").value.trim(),userEmail:document.getElementById("sw-email").value.trim(),userPhone:document.getElementById("sw-phone").value.trim()})},{id:"domiciles",title:"Your Domicile Sites",html:`
      <p class="setup__hint">Enter your domicile site codes, one per line (e.g. ABE40).</p>
      <textarea id="sw-domiciles" class="setup__textarea" rows="5" placeholder="ABE40&#10;EWR45&#10;PHL40"></textarea>
    `,collect:()=>({domiciles:document.getElementById("sw-domiciles").value})},{id:"midway",title:"Midway Authentication",html:`
      <p class="setup__hint">Fleet Operations requires Midway (mwinit) for internal tool access.</p>
      <div id="sw-midway-status" class="setup__status">Not checked yet</div>
      <button id="sw-run-mwinit" class="setup__btn">Check / Run mwinit</button>
    `,collect:()=>({}),afterMount:()=>{document.getElementById("sw-run-mwinit").addEventListener("click",async()=>{document.getElementById("sw-midway-status").textContent="Running mwinit...";try{const t=await window.auth.runMwinit();document.getElementById("sw-midway-status").textContent=t&&t.ok?"Midway OK":"Failed: "+(t&&t.reason||"unknown")}catch(t){document.getElementById("sw-midway-status").textContent="Error: "+t.message}})}},{id:"sharepoint",title:"SharePoint (Optional)",html:`
      <p class="setup__hint">Fleet Operations can auto-push unit data to your SharePoint workbooks. You can skip this and configure later in Settings &rarr; Operators &amp; SP.</p>
      <label>SP Site URL
        <input id="sw-sp-site" type="text" class="setup__input" placeholder="https://amazon.sharepoint.com/sites/AFP-FAS" />
      </label>
      <label>Workbook Path (primary)
        <input id="sw-sp-workbook" type="text" class="setup__input" placeholder="/sites/AFP-FAS/Shared Documents/..." />
      </label>
      <div id="sw-sp-status" class="setup__status setup__status--info">Optional &mdash; skip if not ready</div>
      <button id="sw-sp-skip" class="setup__btn setup__btn--secondary" style="margin-top:8px">Skip for now</button>
    `,collect:()=>({spSiteUrl:document.getElementById("sw-sp-site").value.trim(),spWorkbook:document.getElementById("sw-sp-workbook").value.trim()}),afterMount:()=>{document.getElementById("sw-sp-skip").addEventListener("click",()=>{document.getElementById("sw-sp-status").textContent="Skipped — configure later in Settings",document.getElementById("sw-next").click()})}},{id:"orcha",title:"Orcha AI Config",html:`
      <label>Mode
        <select id="sw-orcha-mode" class="setup__select">
          <option value="local">Local (Ollama)</option>
          <option value="remote">Remote host</option>
          <option value="bedrock">Amazon Bedrock</option>
        </select>
      </label>
      <label>Host (if remote) <input id="sw-orcha-host" class="setup__input" type="text" placeholder="localhost" /></label>
      <label>Port <input id="sw-orcha-port" class="setup__input" type="number" placeholder="4799" /></label>
    `,collect:()=>({orchaMode:document.getElementById("sw-orcha-mode").value,orchaHost:document.getElementById("sw-orcha-host").value.trim(),orchaPort:parseInt(document.getElementById("sw-orcha-port").value,10)||4799})},{id:"confirm",title:"Review & Complete",html:'<div id="sw-confirm-summary" class="setup__summary">Loading summary...</div>',afterMount:t=>{const l=document.getElementById("sw-confirm-summary");if(!l)return;function i(o,e){if(e==null||e==="")return'<em class="sw-empty">not set</em>';if(typeof e!="object")return String(e);if(o==="profile")return[e.userName,e.userEmail,e.userPhone].filter(Boolean).join(" | ")||"<em>empty</em>";if(o==="domiciles")return e.domiciles?e.domiciles.replace(/\n/g,", "):"<em>none</em>";if(o==="midway")return"checked ✓";if(o==="sharepoint")return e.spSiteUrl?e.spSiteUrl+" → "+(e.spWorkbook||"not set"):"skipped";if(o==="orcha")return(e.orchaMode||"local")+" @ "+(e.orchaHost||"localhost")+":"+(e.orchaPort||4799);if(o==="confirm")return"ready";const u=Object.entries(e).filter(([,a])=>a&&typeof a!="object").map(([,a])=>a);return u.length?u.join(" | "):JSON.stringify(e).slice(0,80)}const s={userName:"Name",userEmail:"Email",userPhone:"Phone",profile:"Profile",domiciles:"Domiciles",midway:"Midway",sharepoint:"SharePoint",spSiteUrl:"SP Site",spWorkbook:"SP Workbook",orchaMode:"Orcha Mode",orchaHost:"Orcha Host",orchaPort:"Orcha Port",orcha:"Orcha",confirm:"Status"};l.innerHTML=Object.entries(t).filter(([,o])=>o!=null).map(([o,e])=>'<div class="sw-review-row"><span class="sw-review-key">'+(s[o]||o)+'</span><span class="sw-review-val">'+i(o,e)+"</span></div>").join("")},collect:()=>({}),collect:()=>({})}];let n=0;const c={},m=document.getElementById("setup-mount"),p=document.querySelector(".setup-header .setup-version");function d(){const t=r[n];if(!m||!t)return;p&&(p.textContent="Step "+(n+1)+" of "+r.length+": "+t.title),m.innerHTML=`
    <div class="setup-step">
      <div class="setup-step__body">${t.html}</div>
      <div class="setup-step__footer">
        ${n>0?'<button id="sw-back" class="setup__btn setup__btn--secondary">Back</button>':""}
        <button id="sw-next" class="setup__btn">
          ${n<r.length-1?"Next":"Complete Setup"}
        </button>
      </div>
    </div>
  `;const l=c[t.id]||{};Object.entries(l).forEach(([i,s])=>{const o=document.getElementById("sw-"+i.replace(/([A-Z])/g,e=>"-"+e.toLowerCase()));o&&(o.value=s)}),t.afterMount&&t.afterMount(c),n>0&&document.getElementById("sw-back").addEventListener("click",()=>{n--,d()}),document.getElementById("sw-next").addEventListener("click",async()=>{const i=t.collect?t.collect():{};Object.assign(c,i),c[t.id]=i;try{t.id!=="confirm"&&await window.setup.saveStep(t.id,i)}catch(s){console.error("saveStep failed:",t.id,s)}if(n<r.length-1)n++,d();else{const s=document.getElementById("sw-next");s&&(s.disabled=!0,s.textContent="Setting up...");try{const o=await window.setup.complete();if(o&&!o.ok){s&&(s.disabled=!1,s.textContent="Complete Setup");const e=document.getElementById("sw-confirm-summary");e&&(e.innerHTML+='<div class="sw-review-row sw-review-error">Setup incomplete: not all required steps saved. Check console.</div>')}}catch(o){console.error("Setup complete error:",o),s&&(s.disabled=!1,s.textContent="Complete Setup")}}})}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",d):d();
