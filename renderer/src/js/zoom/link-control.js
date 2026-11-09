/**
 * zoom/link-control.js -- link a meeting / recording to fleet units and carriers (design §13, A2).
 *
 * Kind select (Unit / Carrier), a search input debounced 200 ms -> zoomHub.linkTargets({kind, q}),
 * a result list with Add -> zoomHub.link({key, kind, id}), and removable chips -> zoomHub.unlink.
 * Every call passes ONE object payload. All HTML comes from data-logic.js render functions.
 */
import { renderLinkChips, renderLinkResults, resultMessage } from './data-logic.js';

export const SEARCH_DEBOUNCE_MS = 200;

function _actionTarget(e) {
  const t = e && e.target;
  if (!t) return null;
  const btn = typeof t.closest === 'function' ? t.closest('[data-action]') : t;
  return btn && btn.dataset && btn.dataset.action ? btn : null;
}

/**
 * createLinkControl(host, {zoomHub, document, onChange}) -> {setItem(key, link), clear(), destroy(), search()}
 */
export function createLinkControl(host, opts = {}) {
  const zoomHub = opts.zoomHub;
  const doc = opts.document || host.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

  const wrap = doc.createElement('div');
  wrap.className = 'zh-link';
  wrap.setAttribute('aria-label', 'Link to unit or carrier');

  const chips = doc.createElement('div');
  chips.className = 'zh-link-chips';
  wrap.appendChild(chips);

  const row = doc.createElement('div');
  row.className = 'zh-link-row';
  wrap.appendChild(row);

  const select = doc.createElement('select');
  select.className = 'zh-link-kind';
  select.setAttribute('aria-label', 'Link kind');
  select.innerHTML = '<option value="unit">Unit</option><option value="carrier">Carrier</option>';
  select.value = 'unit';
  row.appendChild(select);

  const input = doc.createElement('input');
  input.className = 'zh-link-q';
  input.type = 'search';
  input.maxLength = 40;
  input.placeholder = 'Search units or carriers';
  input.setAttribute('aria-label', 'Search units or carriers');
  row.appendChild(input);

  const results = doc.createElement('ul');
  results.className = 'zh-link-results';
  results.setAttribute('aria-label', 'Matching units or carriers');
  wrap.appendChild(results);

  const status = doc.createElement('div');
  status.className = 'zh-link-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  wrap.appendChild(status);

  host.appendChild(wrap);

  let key = null;
  let link = null;
  let timer = null;
  let seq = 0;

  function kind() { return select.value === 'carrier' ? 'carrier' : 'unit'; }

  function renderChips() { chips.innerHTML = renderLinkChips(link, { removable: true }); }

  async function search() {
    if (!key) return;
    const my = ++seq;
    let r;
    try { r = await zoomHub.linkTargets({ kind: kind(), q: String(input.value || '').slice(0, 40) }); } catch (_) { r = { ok: false, code: 'INTERNAL' }; }
    if (my !== seq) return;
    if (r && r.ok) { results.innerHTML = renderLinkResults(r.items); status.textContent = ''; } else { results.innerHTML = ''; status.textContent = resultMessage(r); }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; search(); }, SEARCH_DEBOUNCE_MS);
  }

  async function add(id) {
    if (!key || !id) return;
    let r;
    try { r = await zoomHub.link({ key, kind: kind(), id }); } catch (_) { r = { ok: false, code: 'INTERNAL' }; }
    if (r && r.ok) { link = r.link || null; renderChips(); status.textContent = 'Linked.'; onChange(key, link); } else status.textContent = resultMessage(r);
  }

  async function remove(k, id) {
    if (!key || !id) return;
    let r;
    try { r = await zoomHub.unlink({ key, kind: k === 'carrier' ? 'carrier' : 'unit', id }); } catch (_) { r = { ok: false, code: 'INTERNAL' }; }
    if (r && r.ok) { link = r.link || null; renderChips(); status.textContent = 'Link removed.'; onChange(key, link); } else status.textContent = resultMessage(r);
  }

  const onInput = () => schedule();
  const onKind = () => { search(); };
  const onResults = (e) => { const b = _actionTarget(e); if (b && b.dataset.action === 'add') add(b.dataset.id); };
  const onChips = (e) => { const b = _actionTarget(e); if (b && b.dataset.action === 'unlink') remove(b.dataset.kind, b.dataset.id); };
  input.addEventListener('input', onInput);
  select.addEventListener('change', onKind);
  results.addEventListener('click', onResults);
  chips.addEventListener('click', onChips);

  function setItem(k, l) {
    key = k || null;
    link = l || null;
    input.value = '';
    results.innerHTML = '';
    status.textContent = '';
    renderChips();
    if (key) search();
  }

  function clear() { setItem(null, null); }

  function destroy() {
    if (timer) clearTimeout(timer);
    timer = null;
    input.removeEventListener('input', onInput);
    select.removeEventListener('change', onKind);
    results.removeEventListener('click', onResults);
    chips.removeEventListener('click', onChips);
    try { if (typeof wrap.remove === 'function') wrap.remove(); } catch (_) {}
  }

  renderChips();
  return { setItem, clear, destroy, search, get el() { return wrap; }, get input() { return input; }, get select() { return select; }, get results() { return results; }, get chips() { return chips; } };
}
