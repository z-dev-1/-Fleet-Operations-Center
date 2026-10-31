'use strict';
/**
 * orcha/fas/link-research.js — Digital FAS Stage 3: approved-link research.
 *
 * When a Slack message contains a link, we:
 *   1. Parse + normalize the URL.
 *   2. Check the host against the fasConfig approved-domain ALLOWLIST.
 *   3. Open ONLY approved links via the app's existing authenticated Electron
 *      session (hidden BrowserWindow, same pattern as setLifecycle/sp_push).
 *   4. Extract relevant text safely, cap its size, and treat it as UNTRUSTED.
 *   5. Return evidence: { url, title, retrievedAt, text } — or a refusal.
 *
 * HARD SECURITY (enforced in code, not by the model):
 *   - Only https + an allowlisted host is ever opened. http, file:, data:,
 *     localhost/loopback/private IPs, and any non-allowlisted host are refused.
 *   - Arbitrary Slack content can never direct the browser to an unapproved
 *     domain, credentials, or local files.
 *   - Extracted content runs through the injection guard before it can reach
 *     the model.
 */

const config = require('./config');
const guard = require('./injection-guard');
let logger; try { logger = require('../../utils/logger').createLogger('fas-link'); } catch (_) { logger = { info(){}, warn(){} }; }

const MAX_TEXT = 6000;
const FETCH_TIMEOUT_MS = 20000;

// AAP service/asset deep-links are a client-side SPA: a hidden-window DOM scrape
// reads innerText BEFORE the page's own API fetch renders the work order, so it
// comes back as an empty "AAP: --" shell (confirmed root cause of FAS replies
// that say "link resolved to a blank/untitled record"). Instead, resolve these
// URLs via the AAP JSON API we already have (aap_api.getService / getAsset) —
// real data, no render race. These regexes pull the id out of the link.
const AAP_SERVICE_RE = /aap-na\.corp\.amazon\.com\/v2\/service\/([0-9a-f-]{8,})/i;
const AAP_ASSET_RE   = /aap-na\.corp\.amazon\.com\/v2\/asset\/(?:aaid_)?([0-9a-f-]{8,})/i;

// Resolve an AAP service/asset URL to a compact, readable fact blob via the
// JSON API. Returns { ok, title, text } or null if it's not an AAP deep-link.
async function _resolveAapUrl(url) {
  const svc = url.match(AAP_SERVICE_RE);
  const ast = url.match(AAP_ASSET_RE);
  if (!svc && !ast) return null;
  let api, mapper;
  try { api = require('../../scrapers/aap_api'); } catch (_) { return null; }
  try { mapper = require('../../scrapers/aap_api_mapper'); } catch (_) { mapper = null; }
  try {
    if (svc) {
      const full = await api.getService(svc[1]);
      if (!full) return { ok: false, reason: 'AAP getService returned nothing' };
      // The mapper knows how to turn a serviceaggregate into the app's fleet-row
      // shape — unit id, lifecycle, vendor, AND the full comment thread
      // (fullConversation). Use it so a shared AAP link yields the SAME rich
      // data the app shows in unit detail, including the conversation.
      let row = null;
      try { if (mapper && typeof mapper.toFleetRow === 'function') row = mapper.toFleetRow(full.workOrder || full, full, full); } catch (_) {}
      const s = (full.workOrder || full.service || full) || {};
      const unit = (row && row.equipmentId) || s.equipmentId || s.assetId || (full.asset && full.asset.equipmentId) || '';
      const bits = [];
      if (unit) bits.push('Unit: ' + unit);
      const lc = (row && row.lifecycleState) || s.lifecycleState;
      const lr = (row && row.lifecycleReason) || s.lifecycleStateReason;
      if (lc) bits.push('Lifecycle: ' + lc + (lr ? ' / ' + lr : ''));
      const vendor = (row && row.vendor) || (s.vendor && (s.vendor.name || s.vendor.displayName)) || s.vendor;
      if (vendor) bits.push('Vendor: ' + vendor);
      const wr = (row && row.workRequestId) || s.workRequestId || s.id;
      if (wr) bits.push('WR: ' + wr);
      const issue = (row && (row.issueDetails || row.issueSummary)) || s.damageDescription;
      if (issue) bits.push('Issue: ' + String(issue).slice(0, 400));
      // The comment/conversation thread — this is what the user wants read.
      const convo = (row && row.fullConversation) || '';
      if (convo) bits.push('\n--- Conversation ---\n' + String(convo).slice(0, 3500));
      const text = bits.length ? bits.join('\n') : JSON.stringify(s).slice(0, MAX_TEXT);
      return { ok: true, unit: unit || null, title: 'AAP Work Order' + (unit ? ' — ' + unit : ''), text: text.slice(0, MAX_TEXT) };
    }
    const asset = await api.getAsset(ast[1]);
    if (!asset) return { ok: false, reason: 'AAP getAsset returned nothing' };
    const a = asset.asset || asset;
    const unit = a.equipmentId || '';
    const bits = [];
    if (unit) bits.push('Unit: ' + unit);
    if (a.vin) bits.push('VIN: ' + a.vin);
    if (a.make || a.manufacturer) bits.push('Make: ' + (a.make || a.manufacturer));
    if (a.model) bits.push('Model: ' + a.model);
    if (a.lifecycleState) bits.push('Lifecycle: ' + a.lifecycleState);
    if (a.domicileSite || a.domicile) bits.push('Domicile: ' + (a.domicileSite || a.domicile));
    const text = bits.join('\n') || JSON.stringify(a).slice(0, MAX_TEXT);
    return { ok: true, unit: unit || null, title: 'AAP Asset' + (unit ? ' — ' + unit : ''), text: text.slice(0, MAX_TEXT) };
  } catch (e) {
    return { ok: false, reason: 'AAP API resolve failed: ' + e.message };
  }
}

// Slack wraps links as <url> or <url|label>. Pull raw https URLs.
function extractUrls(messageText) {
  const out = [];
  const s = String(messageText || '');
  const wrapped = s.match(/<(https?:[^|>]+)(?:\|[^>]+)?>/g) || [];
  wrapped.forEach(w => { const u = w.replace(/^</, '').replace(/>$/, '').split('|')[0]; if (u) out.push(u); });
  // Also catch bare URLs not wrapped.
  const bare = s.match(/\bhttps?:\/\/[^\s<>|]+/g) || [];
  bare.forEach(u => out.push(u));
  return [...new Set(out)];
}

function _isPrivateHost(host) {
  const h = (host || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  // IPv4 loopback/private ranges + IPv6 loopback.
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '::1' || h === '[::1]') return true;
  return false;
}

/**
 * classify(url, approvedDomains) -> { ok, host, reason }
 * Deterministic allowlist decision. ok=false means DO NOT fetch.
 */
function classify(url, approvedDomains) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return { ok: false, reason: 'unparseable URL' }; }
  if (parsed.protocol !== 'https:') return { ok: false, host: parsed.host, reason: 'non-https refused (' + parsed.protocol + ')' };
  const host = parsed.hostname.toLowerCase();
  if (_isPrivateHost(host)) return { ok: false, host, reason: 'private/loopback host refused' };
  const allow = (approvedDomains || []).map(d => String(d).toLowerCase());
  const allowed = allow.some(d => host === d || host.endsWith('.' + d));
  if (!allowed) return { ok: false, host, reason: 'host not on approved-domain allowlist' };
  return { ok: true, host, reason: 'approved' };
}

// In-page extractor: title + visible text, trimmed. Runs in the fetched page.
const EXTRACT_JS = `(function(){
  try {
    var title = document.title || '';
    // Prefer main/article content; fall back to body.
    var root = document.querySelector('main, article, [role="main"]') || document.body;
    var text = (root ? root.innerText : '') || '';
    return { title: title, text: text.slice(0, 20000) };
  } catch(e) { return { title: '', text: '', error: e.message }; }
})()`;

/**
 * fetchApproved(url) -> Promise<{ ok, url, title, text, retrievedAt } | { ok:false, refused, reason }>
 * Opens an approved https link in a hidden authenticated window and extracts text.
 */
async function fetchApproved(url) {
  const cfg = config.get();
  const decision = classify(url, cfg.approvedLinkDomains);
  if (!decision.ok) {
    logger.warn('[fas-link] refused ' + url + ' — ' + decision.reason);
    return { ok: false, refused: true, url, reason: decision.reason };
  }
  // AAP service/asset deep-links: resolve via the JSON API (real data) instead
  // of DOM-scraping the SPA shell (which returns an empty "AAP: --" page).
  const aap = await _resolveAapUrl(url);
  if (aap) {
    if (aap.ok) {
      logger.info('[fas-link] resolved AAP link via API: ' + url + (aap.unit ? ' (unit ' + aap.unit + ')' : ''));
      return { ok: true, url, title: aap.title, text: guard.neutralize(aap.text).slice(0, MAX_TEXT), unit: aap.unit || null, retrievedAt: new Date().toISOString() };
    }
    logger.warn('[fas-link] AAP API resolve failed for ' + url + ' — ' + aap.reason + ' (falling back to page scrape)');
    // fall through to the browser scrape as a last resort
  }
  let BrowserWindow, session;
  try { ({ BrowserWindow, session } = require('electron')); }
  catch (_) { return { ok: false, url, reason: 'electron unavailable (non-app context)' }; }

  return new Promise((resolve) => {
    let settled = false;
    const win = new BrowserWindow({ show: false, skipTaskbar: true, width: 1200, height: 900,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession } });
    const done = (res) => { if (settled) return; settled = true; try { win.destroy(); } catch (_) {} resolve(res); };
    const timer = setTimeout(() => done({ ok: false, url, reason: 'timeout' }), FETCH_TIMEOUT_MS);

    // SECURITY: block any navigation away from the approved host (a page could
    // try to redirect to an unapproved domain). Re-classify every navigation.
    win.webContents.on('will-navigate', (e, navUrl) => {
      if (!classify(navUrl, cfg.approvedLinkDomains).ok) { e.preventDefault(); done({ ok: false, url, reason: 'blocked redirect to unapproved host' }); }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    win.webContents.on('did-finish-load', async () => {
      try {
        const cur = win.webContents.getURL();
        if (!classify(cur, cfg.approvedLinkDomains).ok) { clearTimeout(timer); return done({ ok: false, url, reason: 'landed on unapproved host' }); }
        const r = await win.webContents.executeJavaScript(EXTRACT_JS);
        clearTimeout(timer);
        const rawText = (r && r.text) || '';
        // UNTRUSTED: run through the injection guard + cap size before returning.
        const safeText = guard.neutralize(rawText).slice(0, MAX_TEXT);
        const inj = guard.detectInjection(rawText);
        done({ ok: true, url, title: (r && r.title) || '', text: safeText,
          injectionFlagged: inj.suspicious, injectionMatches: inj.matches, retrievedAt: new Date().toISOString() });
      } catch (e) { clearTimeout(timer); done({ ok: false, url, reason: 'extract failed: ' + e.message }); }
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => { if (code !== -3) { clearTimeout(timer); done({ ok: false, url, reason: 'load failed: ' + desc }); } });

    try { win.loadURL(url); } catch (e) { clearTimeout(timer); done({ ok: false, url, reason: 'loadURL failed: ' + e.message }); }
  });
}

/**
 * researchLinks(messageText) -> Promise<{ evidence: [...], refused: [...] }>
 * Fetches every approved link in the message; records refusals for audit.
 */
async function researchLinks(messageText) {
  const urls = extractUrls(messageText);
  const evidence = [];
  const refused = [];
  const units = [];   // unit ids discovered from AAP links, for follow-on research
  for (const u of urls.slice(0, 3)) { // cap link fetches per message
    const r = await fetchApproved(u);
    if (r.ok) {
      // Give the AAP WO conversation more room (3500 chars) than a generic web
      // page excerpt — the comment thread is the whole point of resolving it.
      const isAap = /aap-na\.corp\.amazon\.com/i.test(u);
      evidence.push({ field: 'linkContent', value: { title: r.title, excerpt: r.text.slice(0, isAap ? 4000 : 1200), unit: r.unit || undefined, injectionFlagged: r.injectionFlagged }, source: r.url, retrievedAt: r.retrievedAt });
      if (r.unit) units.push(r.unit);
    } else refused.push({ url: u, reason: r.reason });
  }
  return { evidence, refused, units: [...new Set(units)] };
}

module.exports = { extractUrls, classify, fetchApproved, researchLinks };
