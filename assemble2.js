/**
 * assemble2.js — clean build of unit-detail.js
 *
 * Layout of output file:
 *   [A] Original lines 1–610   (imports, globals, all wiring fns _esc thru _wireAsistPanel/_wireDealerWOBtn)
 *   [B] NEW renderHeader/renderTabs/renderRepairPane/renderIntelPane/renderActionsPane/renderHistoryPane
 *   [C] NEW _renderUnit         (replaces original lines 611–743)
 *   [D] Original lines 745–812  (close, init, _pendingDealerWO, bus listeners)
 *
 * Original _renderUnit (611-743) is intentionally DROPPED — replaced by [C].
 */

const fs   = require('fs');
const path = require('path');

const orig     = fs.readFileSync(path.join(__dirname, 'original-unit-detail.js'), 'utf8').split('\n');
const buildSrc = fs.readFileSync(path.join(__dirname, 'build-detail-js.txt'), 'utf8').split('\n');

// [A] Original lines 1-610 (0-indexed: 0-609). Keep EVERYTHING up to but not including _renderUnit.
const partA = orig.slice(0, 610).join('\n');

// [B] New pane renderers from build-detail-js.txt lines 4-121 (skip first 3: const fs/path/outPath)
const partB = '\n\n// ── NEW: Command Center render helpers ──────────────────────────────────────\n'
            + buildSrc.slice(3).join('\n');

// [C] New _renderUnit
const partC = `

// ── _renderUnit ──────────────────────────────────────────────────────────────
function _renderUnit(unit) {
  _unit = unit;
  if (!_panel) return;
  _teardownVendorBus();

  const isUnavail = (unit.lifecycleState||'').toLowerCase().includes('unavail');
  const risk      = parseInt(unit.riskScore, 10) || 0;

  _panel.innerHTML =
    renderHeader(unit) +
    '<div class="dp-status-band dp-status-band--loading" id="dp-status-band">' +
      '<span class="dp-status-band__icon">&#129504;</span>' +
      '<span class="dp-status-band__text">Analyzing unit status\u2026</span>' +
    '</div>' +
    renderTabs(unit) +
    '<div class="dp-body">' +
      renderRepairPane(unit) +
      renderIntelPane(unit) +
      renderActionsPane(unit) +
      renderHistoryPane(unit) +
    '</div>';

  // ── tab switching ──────────────────────────────────────────────────────────
  _panel.querySelectorAll('.dp-tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      _panel.querySelectorAll('.dp-tab').forEach(function(t){ t.classList.remove('active'); });
      _panel.querySelectorAll('.dp-pane').forEach(function(p){ p.classList.remove('active'); });
      btn.classList.add('active');
      var pane = document.getElementById('dp-pane-' + btn.dataset.tab);
      if (pane) pane.classList.add('active');
    });
  });

  // ── close ──────────────────────────────────────────────────────────────────
  var closeBtn = document.getElementById('dp-close');
  if (closeBtn) closeBtn.addEventListener('click', close);

  // ── external launchers ─────────────────────────────────────────────────────
  _panel.querySelectorAll('[data-aap-url]').forEach(function(b) {
    b.addEventListener('click', function(){ var u=b.dataset.aapUrl; if(u) window.aap && window.aap.openUrl(u); });
  });
  _panel.querySelectorAll('[data-ext-url]').forEach(function(b) {
    b.addEventListener('click', function(e){ e.preventDefault(); var u=b.dataset.extUrl||b.getAttribute('data-ext-url'); if(u&&window.files) window.files.openExternal(u).catch(function(){}); });
  });

  // ── show all convo messages ────────────────────────────────────────────────
  var moreBtn = document.getElementById('dp-convo-more');
  if (moreBtn) {
    moreBtn.addEventListener('click', function() {
      var el = document.getElementById('dp-convo');
      if (!el) return;
      el.innerHTML = _allConvoMsgs.map(function(m){
        return '<div class="dp-convo-msg dp-convo-msg--'+m.side+'">' +
          '<div class="dp-convo-av dp-convo-av--'+m.side+'">'+(m.side==='vendor'?'V':'C')+'</div>' +
          '<div><div class="dp-convo-bubble">'+esc(m.text)+'</div>' +
          '<div class="dp-convo-meta">'+esc(m.date)+'</div></div></div>';
      }).join('');
    });
  }

  // ── notes ──────────────────────────────────────────────────────────────────
  _wireNotes(unit);

  // ── action buttons ─────────────────────────────────────────────────────────
  _wireLifecycleForm(unit);
  _wireCreateWR(unit);

  var actAAP = document.getElementById('dp-act-aap');
  if (actAAP) actAAP.addEventListener('click', function(){ if(unit.assetUrl) window.aap && window.aap.openUrl(unit.assetUrl); });

  var actDealerWO = document.getElementById('dp-act-dealer-wo');
  if (actDealerWO) {
    actDealerWO.addEventListener('click', function() {
      _panel.querySelectorAll('.dp-tab').forEach(function(t){ t.classList.remove('active'); });
      _panel.querySelectorAll('.dp-pane').forEach(function(p){ p.classList.remove('active'); });
      var at = _panel.querySelector('[data-tab="actions"]');
      var ap = document.getElementById('dp-pane-actions');
      if (at) at.classList.add('active');
      if (ap) ap.classList.add('active');
      setTimeout(function(){ var s=document.getElementById('dp-vendor-section'); if(s)s.scrollIntoView({behavior:'smooth',block:'start'}); }, 100);
    });
  }

  // ── ask Orcha ──────────────────────────────────────────────────────────────
  _wireAISuggest(unit);

  // ── vendor panel ──────────────────────────────────────────────────────────
  _wireVendorPanel(unit);

  // ── status band AI brief ───────────────────────────────────────────────────
  if (window.ai && window.ai.suggest) {
    window.ai.suggest(unit).then(function(result){
      var bandEl = document.getElementById('dp-status-band');
      if (!bandEl) return;
      var text = (result && result.text) ? result.text : '';
      if (text) {
        bandEl.classList.remove('dp-status-band--loading');
        bandEl.innerHTML = '<span class="dp-status-band__icon">&#129504;</span><span class="dp-status-band__text">'+esc(text)+'</span>';
      }
    }).catch(function(){});
  }
}

// ── _wireNotes ────────────────────────────────────────────────────────────────
function _wireNotes(unit) {
  var notesEl = document.getElementById('dp-notes');
  var savedEl = document.getElementById('dp-notes-saved');
  if (!notesEl) return;
  if (window.notes) {
    window.notes.getUnit(unit.equipmentId).then(function(n){ if(n&&n.content) notesEl.value=n.content; }).catch(function(){});
  }
  async function _save() {
    if (!window.notes) return;
    try {
      await window.notes.saveUnit({ unitId: unit.equipmentId, content: notesEl.value });
      if (savedEl) { savedEl.classList.add('visible'); setTimeout(function(){ savedEl.classList.remove('visible'); }, 2000); }
    } catch(e) { console.warn('Notes save failed', e); }
  }
  notesEl.addEventListener('blur', _save);
  var saveBtn = document.getElementById('dp-save-notes');
  if (saveBtn) saveBtn.addEventListener('click', _save);
}

`;

// [D] Original lines 745-812 (0-indexed 744-811): close(), init(), bus listeners
const partD = '\n' + orig.slice(744).join('\n');

// ── Assemble & write ──────────────────────────────────────────────────────────
const final = partA + partB + partC + partD;
const outPath = path.join(__dirname, 'renderer/src/js/views/unit-detail.js');
fs.writeFileSync(outPath, final, 'utf8');

// ── Verify no duplicate declarations ─────────────────────────────────────────
var lines = final.split('\n');
var seen = {};
var dupes = [];
lines.forEach(function(l, i) {
  var m = l.match(/^(?:let|const|var) (_?\w+)/);
  if (m) { var n=m[1]; if(seen[n]) dupes.push('DUPE line '+(i+1)+': '+l.trim()+' (first at '+seen[n]+')'); else seen[n]=i+1; }
});

console.log('Written:', fs.statSync(outPath).size, 'bytes,', lines.length, 'lines');
if (dupes.length) { console.log('DUPLICATES FOUND:'); dupes.forEach(function(d){console.log(' ',d);}); }
else { console.log('No duplicate declarations — clean!'); }

// Check all key functions present
var checks = ['renderHeader','renderTabs','renderRepairPane','renderIntelPane','renderActionsPane','renderHistoryPane','_renderUnit','_wireVendorPanel','_wireLifecycleForm','_wireAISuggest','export function init','ui:dealer-wo-request'];
checks.forEach(function(k){ console.log((final.includes(k)?'PASS':'FAIL'), k); });
