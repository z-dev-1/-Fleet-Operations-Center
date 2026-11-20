// renderer/src/js/views/id-links.js — pure in-app ID-link helpers (no imports).
// Moved out of unit-detail.js so relay-actions.js (imported BY unit-detail.js) can
// use them without an import cycle; unit-detail.js re-exports the moved names.
//
// Links open one in-app zoomable window through wireIdLinks(root, openFn) with
// openFn = (u, o) => window.aap.openUrl(u, o) -> preload -> 'aap:open-url'
// (partition-aware BrowserWindow). Never the external browser.

// Only https URLs on the AAP / Decisiv / DTNA hosts may reach the split view
// (_openInlineSplit writes src unescaped).
export function isSafeHistoryUrl(url) {
  if (typeof url !== 'string' || !url || /[\s"'<>]/.test(url)) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'aap-na.corp.amazon.com' || h.endsWith('.decisiv.net') || h === 'dtna.my.site.com';
  } catch (_) { return false; }
}

export function isAmazonHost(url) {
  try { return /(^|\.)amazon\.(com|dev)$/i.test(new URL(url).hostname); } catch (_) { return false; }
}

// ── Clickable WR ID fields (pure) ───────────────────────────────────────────
// SF Case / AMZ ID / WR ID / Vendor WO open one in-app zoomable window
// (window.aap.openUrl(url, { zoom: true }) -> aap:open-url). A field is only
// linked when a URL resolves AND passes these host checks.
const _SF_HOSTS = new Set(['amazonfreightpartner.lightning.force.com', 'amazonfreightpartner.my.salesforce.com']);
export function isSafeIdLinkUrl(url) {
  if (isSafeHistoryUrl(url)) return true;
  if (typeof url !== 'string' || !url || /[\s"'<>]/.test(url)) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return isAmazonHost(url) || _SF_HOSTS.has(u.hostname.toLowerCase());
  } catch (_) { return false; }
}

// Click / Enter / Space on a [data-id-link] chip -> openFn(url, { zoom: true }).
export function wireIdLinks(root, openFn) {
  if (!root || typeof root.querySelectorAll !== 'function' || typeof openFn !== 'function') return;
  root.querySelectorAll('[data-id-link]').forEach(function (el) {
    const go = function (e) {
      if (e) { if (typeof e.preventDefault === 'function') e.preventDefault(); if (typeof e.stopPropagation === 'function') e.stopPropagation(); }
      const url = el.getAttribute('data-id-link');
      if (!isSafeIdLinkUrl(url)) return;
      try { Promise.resolve(openFn(url, { zoom: true })).catch(function () {}); } catch (_) { /* opener unavailable */ }
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', function (e) { if (e && (e.key === 'Enter' || e.key === ' ')) go(e); });
  });
}

// ── Vendor WO (universal) ───────────────────────────────────────────────────
// Same regex as src/scrapers/decisiv_case_page.js EST_RE (Volvo / PACCAR only; '' for DTNA).
const _EST_RE = /https?:\/\/(?:volvopg\.asist|pssmfleet|paccarpg)\.decisiv\.net\/fleet\/estimates\/(\d+)/i;
export function estimateIdFromUrl(url) {
  const m = _EST_RE.exec(String(url || ''));
  return m ? m[1] : '';
}
function _isDecisivHost(url) {
  try { return new URL(url).hostname.toLowerCase().endsWith('.decisiv.net'); } catch (_) { return false; }
}

// Vendor WO of WO object `o` (unit, or planned/secondary WR of `unit`):
// owned Decisiv estimate URL -> { id: estimate id, url, kind: 'decisiv' };
// else vendorWorkOrderId -> { id, url: first safe owned offsite URL or '', kind: 'rg' }; else null.
// "Owned" keeps the _offsiteWrId rule; a planned/secondary WR owns the unit's offsite
// when unit._offsiteWrId === its workRequestId. Mirrored main-side in relay-action-draft.js.
export function vendorWoOf(o, unit) {
  const w = o || {};
  const owned = !(w._offsiteWrId && w.workRequestId && String(w._offsiteWrId) !== String(w.workRequestId));
  const cands = owned ? [w.offsiteShopEventUrl, w.savedOffsiteUrl, w.asistSrUrl] : [];
  const u = unit || null;
  if (u && u !== w && u._offsiteWrId && w.workRequestId && String(u._offsiteWrId) === String(w.workRequestId)) {
    cands.push(u.offsiteShopEventUrl, u.savedOffsiteUrl, u.asistSrUrl);
  }
  const list = cands.filter((c) => typeof c === 'string' && c);
  for (const c of list) {
    const id = estimateIdFromUrl(c);
    if (id && isSafeIdLinkUrl(c) && _isDecisivHost(c)) return { id, url: c, kind: 'decisiv' };
  }
  const vwo = String(w.vendorWorkOrderId == null ? '' : w.vendorWorkOrderId).trim();
  if (vwo) return { id: vwo, url: list.find((c) => isSafeIdLinkUrl(c)) || '', kind: 'rg' };
  return null;
}

function _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function _escAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The unit-detail woFieldHtml chip for key 'vendor-wo': linked when vw.url is safe,
// plain chip otherwise, '' for no Vendor WO.
export function vendorWoChipHtml(vw) {
  if (!vw || !vw.id) return '';
  const inner = '<span class="dp-wo-field__k">Vendor WO</span><span class="dp-wo-field__v">' + _esc(vw.id) + '</span>';
  if (!vw.url || !isSafeIdLinkUrl(vw.url)) return '<span class="dp-wo-field">' + inner + '</span>';
  return '<span class="dp-wo-field dp-wo-field--link" role="link" tabindex="0" data-id-link="' + _escAttr(vw.url) + '"'
    + ' data-id-link-field="vendor-wo" title="Open in app window">' + inner + '</span>';
}
