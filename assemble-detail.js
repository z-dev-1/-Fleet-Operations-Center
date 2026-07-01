/**
 * assemble-detail.js
 * Combines:
 *   1. New ES module header (imports, globals)
 *   2. Pane render functions from build-detail-js.txt
 *   3. _renderUnit + wiring
 *   4. Existing vendor/WR wiring from original unit-detail.js
 *   5. close() + init() + bus listeners
 */
const fs   = require('fs');
const path = require('path');
const outPath = path.join(__dirname, 'renderer/src/js/views/unit-detail.js');

// ── 1. Read existing file for its wiring blocks ───────────────────────────────
const existing = fs.readFileSync(outPath, 'utf8');

// Extract vendor wiring (S9 relay WOs onward through end of file)
const wiringIdx = existing.indexOf('// S9: render relay WO section');
const vendorWiring = wiringIdx > -1 ? existing.slice(wiringIdx) : '';

// ── 2. Read pane render functions (strip first 3 build-script lines) ──────────
const buildSrc = fs.readFileSync(path.join(__dirname, 'build-detail-js.txt'), 'utf8');
const paneCode = buildSrc.split('\n').slice(3).join('\n');

// ── 3. ES module header ───────────────────────────────────────────────────────
const header = `/**
 * unit-detail.js -- Command Center Unit Detail Panel v4
 * Header vitals strip + 4-tab layout: Repair | Intel | Actions | History
 * All existing vendor/WR/lifecycle/AI wiring preserved.
 */

import bus             from '../bus.js';
import state           from '../state.js';
import { notes, ai, aap, relay, vendor } from '../bridge.js';
import { open as openWRModal }     from './wr-modal.js';
import { open as openVendorReview} from './vendor-review-modal.js';
import toast           from '../components/toast.js';

let _panel        = null;
let _unit         = null;
let _allConvoMsgs = [];
let _vendorUnsubs = [];
let _notesVal     = '';

`;

// ── 4. _renderUnit ─────────────────────────────────────────────────────────────
const renderUnit = `
// ── _renderUnit ──────────────────────────────────────────────────────────────
function _renderUnit(unit) {
  _unit = unit;
  if (!_panel) return;

  const isUnavail = (unit.lifecycleState||'').toLowerCase().includes('unavail');
  const risk = parseInt(unit.riskScore, 10) || 0;
  const defaultTab = isUnavail ? 'repair' : risk >= 60 ? 'intel' : 'repair';

  _panel.innerHTML =
    renderHeader(unit) +
    '<div class="dp-status-band dp-status-band--loading" id="dp-status-band"><span class="dp-status-band__icon">&#129504;</span><span class="dp-status-band__text">Analyzing unit status...</span></div>' +
    renderTabs(unit) +
    '<div class="dp-body">' +
      renderRepairPane(unit) +
      renderIntelPane(unit) +
      renderActionsPane(unit) +
      renderHistoryPane(unit) +
    '</div>';

  // tab switching
  _panel.querySelectorAll('.dp-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _panel.querySelectorAll('.dp-tab').forEach(t => t.classList.remove('active'));
      _panel.querySelectorAll('.dp-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = document.getElementById('dp-pane-' + btn.dataset.tab);
      if (pane) pane.classList.add('active');
    });
  });

  document.getElementById('dp-close').addEventListener('click', close);

  // launcher buttons
  _panel.querySelectorAll('[data-aap-url]').forEach(b => {
    b.addEventListener('click', () => { const u=b.dataset.aapUrl; if(u) aap.openUrl(u); });
  });
  _panel.querySelectorAll('[data-ext-url]').forEach(b => {
    b.addEventListener('click', e => { e.preventDefault(); const u=b.dataset.extUrl||b.getAttribute('data-ext-url'); if(u&&window.files) window.files.openExternal(u).catch(()=>{}); });
  });

  // show all convo messages
  const moreBtn = document.getElementById('dp-convo-more');
  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      const el = document.getElementById('dp-convo');
      if (!el) return;
      el.innerHTML = _allConvoMsgs.map(m =>
        '<div class="dp-convo-msg dp-convo-msg--'+m.side+'"><div class="dp-convo-av dp-convo-av--'+m.side+'">'+(m.side==='vendor'?'V':'C')+'</div><div><div class="dp-convo-bubble">'+_esc(m.text)+'</div><div class="dp-convo-meta">'+_esc(m.date)+'</div></div></div>'
      ).join('');
    });
  }

  // notes
  const notesEl  = document.getElementById('dp-notes');
  const savedEl  = document.getElementById('dp-notes-saved');
  async function _saveNotes() {
    if (!notesEl) return;
    try { await notes.saveUnit({unitId:unit.equipmentId,content:notesEl.value}); if(savedEl){savedEl.classList.add('visible');setTimeout(()=>savedEl.classList.remove('visible'),2000);} }
    catch(e) { toast.show('error','Notes save failed'); }
  }
  if (notesEl) notesEl.addEventListener('blur', _saveNotes);
  const saveBtn = document.getElementById('dp-save-notes');
  if (saveBtn) saveBtn.addEventListener('click', _saveNotes);
  notes.getUnit(unit.equipmentId).then(n => { if(notesEl&&n&&n.content) notesEl.value=n.content; }).catch(()=>{});

  // actions
  const actCreateWR = document.getElementById('dp-act-create-wr');
  if (actCreateWR) actCreateWR.addEventListener('click', () => openWRModal(unit));
  const actAAP = document.getElementById('dp-act-aap');
  if (actAAP) actAAP.addEventListener('click', () => { if(unit.assetUrl) aap.openUrl(unit.assetUrl); else toast.show('warn','No AAP URL',3000); });
  const actDealerWO = document.getElementById('dp-act-dealer-wo');
  if (actDealerWO) {
    actDealerWO.addEventListener('click', () => {
      _panel.querySelectorAll('.dp-tab').forEach(t=>t.classList.remove('active'));
      _panel.querySelectorAll('.dp-pane').forEach(p=>p.classList.remove('active'));
      const at=_panel.querySelector('[data-tab="actions"]'); const ap=document.getElementById('dp-pane-actions');
      if(at)at.classList.add('active'); if(ap)ap.classList.add('active');
      setTimeout(()=>{ const sec=document.getElementById('dp-vendor-section'); if(sec)sec.scrollIntoView({behavior:'smooth',block:'start'}); },100);
    });
  }
  const actLC  = document.getElementById('dp-act-lc');
  const lcForm = document.getElementById('dp-lc-form');
  if (actLC && lcForm) actLC.addEventListener('click', () => { lcForm.style.display = lcForm.style.display==='none'?'flex':'none'; });
  const lcCancel = document.getElementById('dp-lc-cancel');
  if (lcCancel && lcForm) lcCancel.addEventListener('click', () => { lcForm.style.display='none'; });
  const lcConfirm = document.getElementById('dp-lc-confirm');
  if (lcConfirm) {
    lcConfirm.addEventListener('click', async () => {
      if(!unit.assetUrl){toast.show('warn','No AAP URL',3000);return;}
      const lcState=(document.getElementById('dp-lc-state')||{}).value;
      const lcReason=((document.getElementById('dp-lc-reason')||{}).value||'').trim();
      lcConfirm.disabled=true; lcConfirm.textContent='Saving...';
      try{await aap.setLifecycle(unit.equipmentId,unit.assetUrl,lcState,lcReason);toast.show('success','Lifecycle changed to '+lcState);if(lcForm)lcForm.style.display='none';}
      catch(e){toast.show('error','Lifecycle change failed: '+e.message);}
      finally{lcConfirm.disabled=false;lcConfirm.textContent='Confirm';}
    });
  }

  // ask Orcha
  const askInput = document.getElementById('dp-ask-input');
  const askBtn   = document.getElementById('dp-ask-btn');
  const aiResult = document.getElementById('dp-ai-result');
  async function _runAsk(q) {
    if (!aiResult) return;
    aiResult.style.display='block';
    aiResult.innerHTML='<span style="color:var(--mut);font-style:italic">Asking Orcha...</span>';
    try {
      const result = await ai.ask('[Unit: '+unit.equipmentId+'] '+q);
      const text = (result&&result.text)?result.text:JSON.stringify(result,null,2);
      aiResult.innerHTML='<div style="white-space:pre-wrap">'+_esc(text)+'</div><div class="dp-ai-result-footer"><button id="dp-ai-copy" class="detail-panel__btn" style="font-size:9px;padding:3px 10px">Copy</button></div>';
      document.getElementById('dp-ai-copy').addEventListener('click',()=>{navigator.clipboard.writeText(text).catch(()=>{});toast.show('info','Copied',2000);});
    } catch(e) { aiResult.innerHTML='<span style="color:var(--red)">'+_esc(e.message)+'</span>'; }
  }
  if (askBtn&&askInput) {
    askBtn.addEventListener('click',()=>{const q=askInput.value.trim();if(q)_runAsk(q);});
    askInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();const q=askInput.value.trim();if(q)_runAsk(q);}});
  }
  _panel.querySelectorAll('.dp-ask-chip').forEach(chip=>{
    chip.addEventListener('click',()=>{if(askInput)askInput.value=chip.dataset.q||'';_runAsk(chip.dataset.q||'');});
  });

  // vendor panel
  _wireVendorPanel(unit);

  // status band AI brief
  ai.suggest(unit).then(result=>{
    const bandEl=document.getElementById('dp-status-band');
    if(!bandEl)return;
    const text=(result&&result.text)?result.text:'';
    if(text){bandEl.classList.remove('dp-status-band--loading');bandEl.innerHTML='<span class="dp-status-band__icon">&#129504;</span><span class="dp-status-band__text">'+_esc(text)+'</span>';}
  }).catch(()=>{});
}

`;

// ── 5. close + init + bus listeners ──────────────────────────────────────────
const footer = `
function close() {
  if (_panel) {
    _panel.classList.remove('detail-panel--open');
    setTimeout(() => { if (_panel) _panel.innerHTML = ''; _unit = null; _teardownVendorBus(); }, 300);
  }
  bus.emit('ui:unit-deselect');
}

export function init(container) {
  _panel = document.createElement('div');
  _panel.id = 'detail-panel';
  _panel.className = 'detail-panel';
  container.appendChild(_panel);

  bus.on('ui:unit-select', ({ unit }) => {
    _renderUnit(unit);
    requestAnimationFrame(() => _panel.classList.add('detail-panel--open'));
  });
  bus.on('ui:unit-deselect', () => {
    if (_panel) _panel.classList.remove('detail-panel--open');
  });
}

// S23-12: Race-guarded handler for context-menu Dealer WO shortcut
let _pendingDealerWO = null;
function _tryDealerWO(unit, attempts) {
  if (!_unit || (_unit.equipmentId !== unit.equipmentId && _unit.id !== unit.equipmentId)) { _pendingDealerWO=null; return; }
  const sec = document.getElementById('dp-vendor-section');
  if (!sec) {
    if (attempts >= 12) { _pendingDealerWO=null; return; }
    _pendingDealerWO = { unit, attempts: attempts+1 };
    requestAnimationFrame(() => { if(_pendingDealerWO) _tryDealerWO(_pendingDealerWO.unit, _pendingDealerWO.attempts); });
    return;
  }
  if (sec.dataset.investigating === unit.equipmentId) { _pendingDealerWO=null; sec.scrollIntoView({behavior:'smooth',block:'nearest'}); return; }
  _pendingDealerWO=null;
  sec.dataset.investigating = unit.equipmentId;
  _wireVendorPanel(unit);
  sec.scrollIntoView({behavior:'smooth',block:'nearest'});
}
bus.on('ui:dealer-wo-request', ({ unit }) => {
  _pendingDealerWO = { unit, attempts: 0 };
  requestAnimationFrame(() => { if(_pendingDealerWO) _tryDealerWO(_pendingDealerWO.unit, _pendingDealerWO.attempts); });
});
`;

// ── Assemble & write ──────────────────────────────────────────────────────────
const final = header + paneCode + renderUnit + vendorWiring + footer;
fs.writeFileSync(outPath, final, 'utf8');
console.log('SUCCESS — unit-detail.js written, size:', fs.statSync(outPath).size, 'bytes');
