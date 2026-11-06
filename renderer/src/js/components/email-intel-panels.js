/**
 * email-intel-panels.js — shared Email Triage Intelligence UI pieces (default OFF; used only when the
 * main process reports `capture` effective through window.emailIntel.status()).
 *
 *   renderIdentityHtml(state)   "My identity" form (F-12, F2-10 hint line). Pure.
 *   renderBannersHtml(status)   auth-blocked / partial-scan / identity-not-set banners (8.6, F-12). Pure.
 *   readIdentityForm(doc)       -> patch for emailIntel:set-config (pure over element values)
 *   wireIdentityPanel(doc, deps) / wireBanners(doc, deps)   thin DOM wiring (getElementById only)
 *
 * Accessibility (NFR-11): every control is a real <button>/<input> with a visible text label; errors
 * are linked with aria-describedby; banners live in role="status" aria-live="polite" regions.
 * The username suggestion is shown as a chip the user may click; it is never applied automatically.
 * Nothing here sends, deletes or approves anything.
 */

export const FAS_HINT = 'Set your FAS name so units assigned to other FAS people at the same site are staged, not written.';
export const IDENTITY_BANNER = 'Set your name and address so the app can tell what is addressed to you.';

export function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** "a, b; c" -> ['a','b','c'] (trimmed, empties dropped, de-duplicated case-insensitively). */
export function parseList(text) {
  const out = []; const seen = new Set();
  for (const part of String(text == null ? '' : text).split(/[,;\n]/)) {
    const t = part.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase()); out.push(t);
  }
  return out;
}

const FIELDS = [
  { key: 'names', id: 'ei-id-names', label: 'Your names and aliases (comma-separated, up to 10)', field: 'me.names' },
  { key: 'addresses', id: 'ei-id-addresses', label: 'Your email addresses (comma-separated, up to 10)', field: 'me.addresses' },
  { key: 'distributionLists', id: 'ei-id-dls', label: 'Distribution lists you are on (names or addresses, up to 20)', field: 'me.distributionLists' },
];

/**
 * renderIdentityHtml({ me, suggestions:{alias}, errors:{[field]:message}, saving })
 * Fields are prefilled from the saved identity only; the suggestion is a separate chip.
 */
export function renderIdentityHtml(state) {
  const s = state || {};
  const me = s.me || {};
  const errors = s.errors || {};
  const alias = s.suggestions && s.suggestions.alias ? String(s.suggestions.alias) : '';
  const rows = FIELDS.map((f) => {
    const err = errors[f.field];
    const errId = f.id + '-err';
    const chips = (Array.isArray(me[f.key]) ? me[f.key] : []).map((v) => '<span class="ei-chip">' + esc(v) + '</span>').join('');
    return '<div class="ei-id-row">' +
      '<label for="' + f.id + '">' + esc(f.label) + '</label>' +
      (chips ? '<div class="ei-chips" aria-label="Saved ' + esc(f.key) + '">' + chips + '</div>' : '') +
      '<input id="' + f.id + '" type="text" value="' + esc((me[f.key] || []).join(', ')) + '"' + (err ? ' aria-invalid="true" aria-describedby="' + errId + '"' : '') + ' />' +
      (err ? '<div class="ei-err" id="' + errId + '" role="alert">' + esc(err) + '</div>' : '') +
      '</div>';
  }).join('');
  const fasErr = errors['me.fasName'];
  const suggestion = alias
    ? '<div class="ei-id-suggest-row">Suggestion: <button type="button" class="ei-chip-btn" id="ei-id-suggest" data-alias="' + esc(alias) + '">Add "' + esc(alias) + '" as a name</button></div>'
    : '';
  return '<section class="ei-identity" aria-labelledby="ei-id-title">' +
    '<h3 id="ei-id-title" class="ei-id-title">My identity</h3>' +
    '<p class="ei-id-help">Used to tell what is addressed to you. Kept on this computer only.</p>' +
    rows +
    '<div class="ei-id-row">' +
      '<label for="ei-id-fas">Your FAS name (as shown in the FAS roster, optional)</label>' +
      '<input id="ei-id-fas" type="text" value="' + esc(me.fasName || '') + '" aria-describedby="ei-id-fas-hint' + (fasErr ? ' ei-id-fas-err' : '') + '"' + (fasErr ? ' aria-invalid="true"' : '') + ' />' +
      '<div class="ei-hint" id="ei-id-fas-hint">' + esc(FAS_HINT) + '</div>' +
      (fasErr ? '<div class="ei-err" id="ei-id-fas-err" role="alert">' + esc(fasErr) + '</div>' : '') +
    '</div>' +
    suggestion +
    (errors.config ? '<div class="ei-err" role="alert">' + esc(errors.config) + '</div>' : '') +
    '<div class="ei-id-btns">' +
      '<button type="button" class="et-mini ei-id-save" id="ei-id-save"' + (s.saving ? ' disabled' : '') + '>' + (s.saving ? 'Saving' : 'Save identity') + '</button>' +
      '<button type="button" class="et-mini" id="ei-id-cancel">Close</button>' +
    '</div>' +
    '<div class="ei-live" id="ei-id-live" role="status" aria-live="polite"></div>' +
  '</section>';
}

function _plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

/**
 * renderBannersHtml(status) -> '' or banners for: Outlook sign-in needed (auth-blocked), a partial scan
 * with folder backlogs, and the first-run identity prompt. Built from enums and counts only.
 */
export function renderBannersHtml(status) {
  const s = status || {};
  if (!s.enabled) return '';
  const out = [];
  const last = s.scan && s.scan.last;
  const folders = (last && Array.isArray(last.folders)) ? last.folders : [];
  if ((s.owaAuth && s.owaAuth.state === 'blocked') || (last && last.outcome === 'auth-blocked')) {
    const read = folders.reduce((a, f) => a + (Number(f.ingested) || 0), 0);
    const readFrom = folders.filter((f) => (Number(f.ingested) || 0) > 0).length;
    const notRead = folders.filter((f) => f.status === 'not-reached' || f.status === 'partial').length;
    out.push('<div class="ei-banner ei-banner--auth" role="status" aria-live="polite">' +
      'Outlook needs sign-in. Read ' + _plural(read, 'message', 'messages') + ' from ' + _plural(readFrom, 'folder', 'folders') + '; ' + _plural(notRead, 'folder', 'folders') + ' not read. Progress is saved. ' +
      '<button type="button" class="et-mini" id="ei-scan-again">Scan again</button></div>');
  } else if (last && last.outcome === 'partial') {
    const backlog = folders.filter((f) => f.backlog && Number(f.backlogRemaining) > 0)
      .map((f) => esc(f.folder) + ': ' + _plural(Number(f.backlogRemaining), 'message', 'messages') + ' still to read');
    const missing = folders.filter((f) => f.status === 'not-found').map((f) => esc(f.folder) + ': folder not found');
    const parts = backlog.concat(missing);
    out.push('<div class="ei-banner ei-banner--partial" role="status" aria-live="polite">Partial scan. ' +
      (parts.length ? parts.join('; ') + '. ' : '') + 'The next scan continues from here.</div>');
  }
  const warnings = Array.isArray(s.warnings) ? s.warnings : [];
  if (warnings.includes('identity-not-set') || (s.identity && s.identity.set === false)) {
    out.push('<div class="ei-banner ei-banner--identity" role="status" aria-live="polite">' + esc(IDENTITY_BANNER) +
      ' <button type="button" class="et-mini" id="ei-id-setup">Set up</button></div>');
  }
  return out.join('');
}

/** readIdentityForm(doc) -> set-config patch built from the form inputs (never from the suggestion). */
export function readIdentityForm(doc) {
  const val = (id) => { const el = doc.getElementById(id); return el ? String(el.value || '') : ''; };
  return {
    me: {
      names: parseList(val('ei-id-names')),
      addresses: parseList(val('ei-id-addresses')),
      distributionLists: parseList(val('ei-id-dls')),
      fasName: val('ei-id-fas').trim(),
    },
  };
}

/**
 * wireIdentityPanel(doc, { setConfig(patch) -> Promise<result>, onSaved(result), onError(result), onClose() })
 * Suggestion chip: appends the alias to the names input (the user still has to press Save).
 */
export function wireIdentityPanel(doc, deps) {
  const d = deps || {};
  const live = doc.getElementById('ei-id-live');
  const sug = doc.getElementById('ei-id-suggest');
  if (sug) {
    sug.addEventListener('click', () => {
      const names = doc.getElementById('ei-id-names');
      const alias = sug.getAttribute('data-alias') || '';
      if (names && alias) {
        const list = parseList(names.value);
        if (!list.some((x) => x.toLowerCase() === alias.toLowerCase())) list.push(alias);
        names.value = list.join(', ');
        if (live) live.textContent = 'Added the suggestion to your names. Press Save identity to keep it.';
      }
    });
  }
  const save = doc.getElementById('ei-id-save');
  if (save) {
    save.addEventListener('click', async () => {
      const patch = readIdentityForm(doc);
      save.disabled = true;
      let r = null;
      try { r = d.setConfig ? await d.setConfig(patch) : null; } catch (e) { r = { ok: false, code: 'IPC_ERROR', field: 'config' }; }
      save.disabled = false;
      if (r && r.ok) { if (live) live.textContent = 'Identity saved.'; if (d.onSaved) d.onSaved(r); }
      else { if (live) live.textContent = 'Not saved. Check the highlighted field.'; if (d.onError) d.onError(r || { ok: false }); }
    });
  }
  const close = doc.getElementById('ei-id-cancel');
  if (close && d.onClose) close.addEventListener('click', () => d.onClose());
}

/** wireBanners(doc, { onScanAgain(), onSetup() }) */
export function wireBanners(doc, deps) {
  const d = deps || {};
  const again = doc.getElementById('ei-scan-again');
  if (again && d.onScanAgain) again.addEventListener('click', () => d.onScanAgain());
  const setup = doc.getElementById('ei-id-setup');
  if (setup && d.onSetup) setup.addEventListener('click', () => d.onSetup());
}

/** Field-level error map from a set-config BAD_ARG result. */
export function errorsFromResult(r) {
  if (!r || r.ok) return {};
  const field = r.field || 'config';
  const msg = field === 'me.addresses' ? 'Enter valid email addresses (name@domain).'
    : field === 'me.names' ? 'Names must be 2 to 60 characters, without control characters.'
    : field === 'me.fasName' ? 'Enter the FAS name as text.'
    : 'These settings could not be saved.';
  return { [field]: msg };
}

export const PANEL_CSS = `
  #email-triage .ei-identity { padding:10px 18px; border-bottom:1px solid #161b22; font-size:12px; color:#c9d1d9; }
  #email-triage .ei-id-title { font-size:13px; margin:0 0 4px; color:#e6edf3; }
  #email-triage .ei-id-row { display:flex; flex-direction:column; gap:3px; margin:6px 0; }
  #email-triage .ei-identity input[type="text"] { background:#0d1117; border:1px solid #30363d; border-radius:5px; color:#c9d1d9; font-size:12px; padding:6px 8px; }
  #email-triage .ei-hint, #email-triage .ei-id-help { font-size:11px; color:#8b949e; }
  #email-triage .ei-err { font-size:11px; color:#ff7b72; }
  #email-triage .ei-chip { font-size:10px; background:#21262d; border:1px solid #30363d; border-radius:10px; padding:1px 7px; margin-right:4px; }
  #email-triage .ei-chip-btn { font-size:11px; background:transparent; border:1px dashed #58a6ff; color:#58a6ff; border-radius:10px; padding:2px 8px; cursor:pointer; }
  #email-triage .ei-id-btns { display:flex; gap:6px; margin-top:6px; }
  #email-triage .ei-banner { margin:8px 18px 0; padding:8px 12px; border-radius:8px; font-size:12px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  #email-triage .ei-banner--auth { color:#ffa198; background:rgba(248,81,73,.08); border:1px solid rgba(248,81,73,.3); }
  #email-triage .ei-banner--partial { color:#e3b341; background:rgba(210,153,34,.08); border:1px solid rgba(210,153,34,.3); }
  #email-triage .ei-banner--identity { color:#79c0ff; background:rgba(56,139,253,.08); border:1px solid rgba(56,139,253,.3); }
  #email-triage .ei-gear { background:#30363d; padding:7px 10px; }
`;
