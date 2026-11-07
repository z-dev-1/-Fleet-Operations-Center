/**
 * ai-pref-logic.js — pure helpers for Settings → AI Config → "Active AI".
 *
 * No imports and no DOM globals, so tests/ai-pref-settings.test.js can import
 * it directly (no jsdom in this repo). settings.js renders the HTML strings and
 * calls applyChipStyles(document, pref) / readAkiForm / mergeAiSettings.
 *
 * Preference values must match src/orcha/relay.js VALID_PREFERENCES.
 * Aki settings persist to settings.ai.aki (read by perf-flags loadAiAki).
 */

export const AI_PREF_MODES = Object.freeze([
  { value: 'auto',       id: 'ai-chip-auto',       label: 'Auto (fallback chain)',     accent: '#58a6ff',
    hint: 'Auto: tries Orcha first, falls back to Claude Code if quota is exceeded.' },
  { value: 'orcha',      id: 'ai-chip-orcha',      label: 'Orcha only',                accent: '#22c55e',
    hint: 'Orcha only: no Claude fallback. AI is unavailable if Orcha quota runs out.' },
  { value: 'claude',     id: 'ai-chip-claude',     label: 'Claude Code only',          accent: '#818cf8',
    hint: 'Claude Code only: skips Orcha, uses Cecelia shared Bedrock via claude -p.' },
  { value: 'balanced',   id: 'ai-chip-balanced',   label: 'Balanced (Orcha + Claude)', accent: '#f0a800',
    hint: 'Balanced: runs Orcha + Claude as two lanes — when one is busy the next request uses the other, so work goes faster. If one is down, everything uses the other automatically.' },
  { value: 'balanced3',  id: 'ai-chip-balanced3',  label: 'Balanced (all 3)',          accent: '#f0a800',
    hint: 'Balanced (all 3): runs Orcha, Claude and Aki as three lanes — each request goes to the least-busy healthy lane, and if it fails the other two are tried in turn.' },
  { value: 'aki',        id: 'ai-chip-aki',        label: 'Aki only',                  accent: '#f472b6',
    hint: 'Aki only: every request goes to Aki. No fallback — AI is unavailable if Aki is down. If the Aki lane is turned off below, the Auto chain is used instead.' },
  { value: 'aki-orcha',  id: 'ai-chip-aki-orcha',  label: 'Dual: Aki + Orcha',         accent: '#f472b6',
    hint: 'Dual: Aki + Orcha: two lanes — the least-busy one answers and the other takes over if it fails. If both fail, Claude Code is tried once as a safety net.' },
  { value: 'aki-claude', id: 'ai-chip-aki-claude', label: 'Dual: Aki + Claude',        accent: '#f472b6',
    hint: 'Dual: Aki + Claude: two lanes — the least-busy one answers and the other takes over if it fails. If both fail, Orcha is tried as a safety net.' },
]);

export const AKI_MODES = Object.freeze(['balanced3', 'aki', 'aki-orcha', 'aki-claude']);

export function modeIncludesAki(pref) {
  return AKI_MODES.indexOf(pref) !== -1;
}

export function prefHint(pref) {
  const m = AI_PREF_MODES.find((x) => x.value === pref);
  return m ? m.hint : '';
}

// Same inline chip style as the original four hard-coded <label>s.
const CHIP_STYLE = 'display:flex;align-items:center;gap:5px;cursor:pointer;padding:5px 10px;border-radius:6px;border:1px solid var(--bdr);font-size:11px;transition:border-color .2s';

export function activeAiChipsHtml() {
  return AI_PREF_MODES.map((m) =>
    `<label style="${CHIP_STYLE}" id="${m.id}">\n` +
    `                <input type="radio" name="ai-pref" value="${m.value}" style="accent-color:${m.accent}"> ${m.label}\n` +
    `              </label>`
  ).join('\n              ');
}

export const AKI_UNTRUSTED_LABEL = 'Allow emails, attachments and links to go to Aki';
export const AKI_UNTRUSTED_HINT = 'Used only when an Aki mode is selected. Aki may run tools on this content; app actions still need your typed command.';

export function akiUntrustedHtml() {
  return `<label for="ai-aki-untrusted" style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:11px;cursor:pointer">
              <input type="checkbox" id="ai-aki-untrusted"> ${AKI_UNTRUSTED_LABEL}
            </label>
            <div id="ai-aki-untrusted-hint" style="margin-top:3px;font-size:10px;color:#6e7681;font-style:italic">${AKI_UNTRUSTED_HINT}</div>`;
}

export function akiSettingsHtml() {
  const opts = [1, 2, 3, 4].map((n) => `<option value="${n}">${n}</option>`).join('');
  return `<!-- Aki subsection -->
          <div style="border:1px solid var(--bdr);border-radius:6px;padding:10px 12px;margin-bottom:12px">
            <div style="font-size:9px;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">🦊 Aki</div>
            <label for="ai-aki-enabled" style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer">
              <input type="checkbox" id="ai-aki-enabled"> Aki lane enabled
            </label>
            <div class="sd-row" style="margin-top:6px">
              <div class="sd-field">
                <label class="sd-label" for="ai-aki-profile">Profile</label>
                <input class="sd-input" id="ai-aki-profile" placeholder="(Aki default)"/>
              </div>
              <div class="sd-field">
                <label class="sd-label" for="ai-aki-model">Model</label>
                <input class="sd-input" id="ai-aki-model" placeholder="(Aki default)"/>
              </div>
            </div>
            <div class="sd-row" style="margin-top:6px">
              <div class="sd-field">
                <label class="sd-label" for="ai-aki-concurrency">Parallel workers</label>
                <select class="sd-input" id="ai-aki-concurrency" style="width:80px">${opts}</select>
              </div>
              <div class="sd-field">
                <label class="sd-label" for="ai-aki-timeout">Timeout (seconds)</label>
                <input class="sd-input" id="ai-aki-timeout" type="number" min="10" max="600" placeholder="120" style="width:80px"/>
              </div>
            </div>
            <div style="margin-top:4px;font-size:10px;color:#6e7681;font-style:italic">Runs aki --cli one request at a time per worker. Blank profile/model = Aki's own defaults.</div>
          </div>`;
}

export function applyChipStyles(doc, pref) {
  AI_PREF_MODES.forEach((m) => {
    const chip = doc && doc.getElementById(m.id);
    if (!chip) return;
    chip.style.borderColor = m.value === pref ? 'var(--acc)' : 'var(--bdr)';
    chip.style.background  = m.value === pref ? 'rgba(88,166,255,.08)' : '';
  });
}

// Same validation as src/config/perf-flags.js resolveAiAkiFlags.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const AKI_FORM_DEFAULTS = Object.freeze({
  enabled: true, allowUntrusted: false, profile: '', model: '', concurrency: 2, timeoutSec: 120,
});

function _name(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return NAME_RE.test(s) ? s : '';
}
function _intIn(v, lo, hi, dflt) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
}

function _normForm(f) {
  const o = f || {};
  return {
    enabled: o.enabled !== false,
    allowUntrusted: o.allowUntrusted === true,
    profile: _name(o.profile),
    model: _name(o.model),
    concurrency: _intIn(o.concurrency, 1, 4, AKI_FORM_DEFAULTS.concurrency),
    timeoutSec: _intIn(o.timeoutSec, 10, 600, AKI_FORM_DEFAULTS.timeoutSec),
  };
}

/** settings.getAll() result → Aki form values (seconds for the timeout). */
export function readAkiForm(settingsAll) {
  const ai = (settingsAll && typeof settingsAll.ai === 'object' && settingsAll.ai) || {};
  const a = (typeof ai.aki === 'object' && ai.aki) || {};
  const sec = typeof a.timeoutMs === 'number' ? Math.round(a.timeoutMs / 1000) : undefined;
  return _normForm({ ...a, timeoutSec: sec });
}

/** New settings.ai object: every existing ai key kept, ai.aki replaced from the form. */
export function mergeAiSettings(settingsAll, form) {
  const prev = (settingsAll && typeof settingsAll.ai === 'object' && settingsAll.ai) || {};
  const f = _normForm(form);
  return {
    ...prev,
    aki: {
      enabled: f.enabled,
      allowUntrusted: f.allowUntrusted,
      profile: f.profile,
      model: f.model,
      concurrency: f.concurrency,
      timeoutMs: f.timeoutSec * 1000,
    },
  };
}

/** Picking an Aki mode ticks "Allow emails…"; other picks leave it as it was. */
export function allowUntrustedAfterPick(prevChecked, pref) {
  return modeIncludesAki(pref) ? true : !!prevChecked;
}
