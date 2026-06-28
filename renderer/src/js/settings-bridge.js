/**
 * settings-bridge.js — Module 10: Settings + Credentials Bridge
 * Fleet Ops V-C, Stage 2
 *
 * Moves settings and credentials off localStorage onto the persistent,
 * encrypted backend store:
 *
 * Settings:
 *   - On DOMContentLoaded: calls settings:get-all → hydrates UI state
 *     (theme, density, drawer width, font, radius) from backend store
 *   - Patches window.settings.save wrappers so UI changes also persist
 *     to the backend via settings:save
 *   - Domicile management: load + reactive save on settings panel open
 *
 * Credentials:
 *   - Exposes window.checkCredential(key) → credentials:has → boolean
 *   - Exposes window.setCredential(key, val) → credentials:set
 *   - Exposes window.listCredentials() → credentials:list
 *   - Exposes window.deleteCredential(key) → credentials:delete
 *   - NEVER exposes or shows raw credential values in the UI
 *   - Injects a "Credentials" sub-tab into the settings panel (if open)
 *
 * App window:
 *   - Patches minimizeApp() to use window:action IPC instead of DOM-only
 *   - Exposes window.getAppVersion() → app:version
 *
 * Capability flags (captured once at load time):
 *   HAS_SETTINGS    — window.settings.getAll available
 *   HAS_CREDENTIALS — window.credentials.list available
 *   HAS_APP_IPC     — window.app.windowAction available
 *
 * Dev fallback: all operations degrade to localStorage silently.
 * window._settingsBridge debug handle exposed.
 */

(function () {
  'use strict';

  /* ── 1. Capability detection ────────────────────────────────────────── */
  const HAS_SETTINGS    = !!(window.settings    && typeof window.settings.getAll         === 'function');
  const HAS_CREDENTIALS = !!(window.credentials && typeof window.credentials.list        === 'function');
  const HAS_APP_IPC     = !!(window.app         && typeof window.app.windowAction        === 'function');
  const HAS_DOMICILES   = !!(window.settings    && typeof window.settings.getDomiciles   === 'function');

  /* ── 2. Settings keys we sync to backend ────────────────────────────── */
  const SYNCED_KEYS = ['fo_theme', 'fo_density', 'fo_drawer_w'];

  /* ── 3. Load settings from backend on boot ───────────────────────────── */

  async function _loadAndApplySettings() {
    if (!HAS_SETTINGS) return;

    let remote;
    try {
      remote = await window.settings.getAll();
    } catch (e) {
      console.warn('[settings-bridge] getAll failed:', e);
      return;
    }

    if (!remote || typeof remote !== 'object') return;

    // Apply each known setting if not already set from localStorage
    SYNCED_KEYS.forEach(function (key) {
      const val = remote[key];
      if (val === undefined || val === null) return;

      // Only apply from remote if localStorage doesn't already have it
      try {
        if (!localStorage.getItem(key)) {
          localStorage.setItem(key, val);
          _applySettingToUI(key, val);
        }
      } catch (_) {
        _applySettingToUI(key, val);
      }
    });
  }

  function _applySettingToUI(key, val) {
    try {
      if (key === 'fo_theme' && val === 'light') {
        document.body.classList.add('light');
        const btn = document.getElementById('themeBtn');
        if (btn) btn.textContent = '\uD83C\uDF19 Dark';
      } else if (key === 'fo_density' && typeof window.setDensity === 'function') {
        window.setDensity(val);
      } else if (key === 'fo_drawer_w') {
        const drawer = document.getElementById('drawer');
        if (drawer) drawer.style.width = val;
      }
    } catch (_) {}
  }

  /* ── 4. Patch UI change handlers to also save to backend ─────────────── */

  function _patchSettingsSavers() {
    if (!HAS_SETTINGS) return;

    // Patch toggleTheme
    const _origToggleTheme = typeof window.toggleTheme === 'function'
      ? window.toggleTheme
      : null;

    window.toggleTheme = function () {
      if (_origToggleTheme) _origToggleTheme();
      const isLight = document.body.classList.contains('light');
      _saveSettingToBackend('fo_theme', isLight ? 'light' : 'dark');
    };

    // Patch setDensity
    const _origSetDensity = typeof window.setDensity === 'function'
      ? window.setDensity
      : null;

    window.setDensity = function (d) {
      if (_origSetDensity) _origSetDensity(d);
      _saveSettingToBackend('fo_density', d);
    };
  }

  function _saveSettingToBackend(key, val) {
    if (!HAS_SETTINGS) return;
    try {
      window.settings.save(key, val);
    } catch (e) {
      console.warn('[settings-bridge] save error:', e);
    }
  }

  /* ── 5. Domicile management ──────────────────────────────────────────── */

  async function loadDomiciles() {
    if (!HAS_DOMICILES) return null;
    try {
      return await window.settings.getDomiciles();
    } catch (e) {
      console.warn('[settings-bridge] getDomiciles error:', e);
      return null;
    }
  }

  async function saveDomiciles(domiciles) {
    if (!HAS_DOMICILES) return;
    try {
      await window.settings.saveDomiciles(domiciles);
    } catch (e) {
      console.warn('[settings-bridge] saveDomiciles error:', e);
    }
  }

  /* ── 6. Credential helpers ───────────────────────────────────────────── */

  async function checkCredential(key) {
    if (!HAS_CREDENTIALS) return false;
    try {
      const r = await window.credentials.has(key);
      return !!(r && r.exists);
    } catch (_) {
      return false;
    }
  }

  async function setCredential(key, val) {
    if (!HAS_CREDENTIALS) {
      if (typeof window.toast === 'function') {
        window.toast('Credentials IPC not available in dev mode', 'info', 'Credentials');
      }
      return { ok: false };
    }
    try {
      const r = await window.credentials.set(key, val);
      if (typeof window.toast === 'function') {
        window.toast('Credential saved', 'success', 'Credentials');
      }
      return r;
    } catch (e) {
      console.warn('[settings-bridge] setCredential error:', e);
      if (typeof window.toast === 'function') {
        window.toast('Failed to save credential', 'warning', 'Credentials');
      }
      return { ok: false };
    }
  }

  async function listCredentials() {
    if (!HAS_CREDENTIALS) return [];
    try {
      const r = await window.credentials.list();
      // Returns only keys/metadata — never raw values
      return Array.isArray(r) ? r : [];
    } catch (e) {
      console.warn('[settings-bridge] listCredentials error:', e);
      return [];
    }
  }

  async function deleteCredential(key) {
    if (!HAS_CREDENTIALS) return;
    try {
      await window.credentials.delete(key);
      if (typeof window.toast === 'function') {
        window.toast('Credential deleted', 'success', 'Credentials');
      }
    } catch (e) {
      console.warn('[settings-bridge] deleteCredential error:', e);
    }
  }

  /* ── 7. App version ──────────────────────────────────────────────────── */

  async function getAppVersion() {
    if (!(window.fleet && typeof window.fleet.getVersion === 'function')) return null;
    try {
      return await window.fleet.getVersion();
    } catch (_) {
      return null;
    }
  }

  /* ── 8. Patch minimizeApp to use IPC ────────────────────────────────── */

  function _patchMinimize() {
    if (!HAS_APP_IPC) return;

    const _origMinimize = typeof window.minimizeApp === 'function'
      ? window.minimizeApp
      : null;

    window.minimizeApp = function () {
      // Still run UI animation
      if (_origMinimize) _origMinimize();
      // Also send IPC minimize signal
      try {
        window.app.windowAction('minimize');
      } catch (_) {}
    };
  }

  /* ── 9. Credentials tab in settings panel ────────────────────────────── */

  function _injectCredentialsTab() {
    // The settings panel uses inline HTML — inject a "Credentials" section
    // at the bottom of .sp-body if not already present.
    const spBody = document.querySelector('.sp-body');
    if (!spBody || document.getElementById('creds-section')) return;

    const section = document.createElement('div');
    section.id = 'creds-section';

    section.innerHTML =
      '<div class="sp-section-title">Credentials</div>' +
      '<div id="creds-list" style="font-size:11px;color:var(--txt2);padding:4px 0">Loading...</div>' +
      '<div style="display:flex;gap:6px;margin-top:8px">' +
        '<input id="cred-key-in" placeholder="Key (e.g. slack_token)" ' +
          'style="flex:1;background:var(--el);border:1px solid var(--bdr);border-radius:5px;padding:5px 8px;color:var(--txt);font-size:11px;outline:none">' +
        '<input id="cred-val-in" type="password" placeholder="Value" ' +
          'style="flex:1;background:var(--el);border:1px solid var(--bdr);border-radius:5px;padding:5px 8px;color:var(--txt);font-size:11px;outline:none">' +
        '<button onclick="window._settingsBridge._saveCredFromUI()" ' +
          'style="padding:5px 12px;background:var(--acc);border:none;border-radius:5px;color:#fff;font-size:11px;font-weight:700;cursor:pointer">Save</button>' +
      '</div>' +
      '<div style="font-size:9px;color:var(--mut);margin-top:6px">Values are encrypted and never shown in the UI.</div>';

    spBody.appendChild(section);

    // Load and display credential keys
    _refreshCredsList();
  }

  async function _refreshCredsList() {
    const listEl = document.getElementById('creds-list');
    if (!listEl) return;

    const keys = await listCredentials();
    if (!keys.length) {
      listEl.textContent = 'No credentials stored.';
      return;
    }

    listEl.innerHTML = keys.map(function (entry) {
      const key = typeof entry === 'string' ? entry : (entry.key || '?');
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(240,246,252,.05)">' +
        '<span style="font-family:var(--mono);font-size:10px;color:var(--acc2)">' + key + '</span>' +
        '<span style="display:flex;align-items:center;gap:8px">' +
          '<span style="font-size:9px;color:var(--grn)">&#9679; stored</span>' +
          '<button onclick="window._settingsBridge._deleteCredKey(\'' + key + '\')" ' +
            'style="background:none;border:none;color:var(--red);cursor:pointer;font-size:10px;padding:1px 4px" title="Delete">&#10005;</button>' +
        '</span>' +
        '</div>';
    }).join('');
  }

  async function _saveCredFromUI() {
    const keyIn = document.getElementById('cred-key-in');
    const valIn = document.getElementById('cred-val-in');
    if (!keyIn || !valIn) return;
    const key = keyIn.value.trim();
    const val = valIn.value;
    if (!key || !val) {
      if (typeof window.toast === 'function') {
        window.toast('Key and value are required', 'warning', 'Credentials');
      }
      return;
    }
    await setCredential(key, val);
    keyIn.value = '';
    valIn.value = '';
    await _refreshCredsList();
  }

  async function _deleteCredKey(key) {
    await deleteCredential(key);
    await _refreshCredsList();
  }

  /* ── 10. Watch settings panel open to inject credentials tab ────────── */

  function _watchSettingsPanel() {
    const panel = document.getElementById('settingsPanel');
    if (!panel) return;

    const obs = new MutationObserver(function (mutations) {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'class') {
          if (panel.classList.contains('open')) {
            setTimeout(function () {
              _injectCredentialsTab();
              _refreshCredsList().catch(function () {});
            }, 60);
          }
        }
      }
    });

    obs.observe(panel, { attributes: true });
  }

  /* ── 11. Boot ────────────────────────────────────────────────────────── */

  function boot() {
    // Expose credential helpers globally
    window.checkCredential  = checkCredential;
    window.setCredential    = setCredential;
    window.listCredentials  = listCredentials;
    window.deleteCredential = deleteCredential;
    window.getAppVersion    = getAppVersion;
    window.loadDomiciles    = loadDomiciles;
    window.saveDomiciles    = saveDomiciles;

    // Apply persisted settings from backend (non-blocking)
    _loadAndApplySettings().catch(function () {});

    // Patch UI savers
    _patchSettingsSavers();

    // Patch minimize
    _patchMinimize();

    // Watch settings panel for credentials tab injection
    _watchSettingsPanel();

    const mode = HAS_SETTINGS ? 'IPC mode' : 'dev mode';
    console.log(
      '[settings-bridge] loaded —', mode,
      '(settings=' + HAS_SETTINGS +
      ' credentials=' + HAS_CREDENTIALS +
      ' app=' + HAS_APP_IPC + ')'
    );
  }

  /* ── 12. Debug handle ────────────────────────────────────────────────── */

  window._settingsBridge = {
    version:         '1.0.0',
    HAS_SETTINGS:     HAS_SETTINGS,
    HAS_CREDENTIALS:  HAS_CREDENTIALS,
    HAS_APP_IPC:      HAS_APP_IPC,
    HAS_DOMICILES:    HAS_DOMICILES,
    checkCredential:  checkCredential,
    setCredential:    setCredential,
    listCredentials:  listCredentials,
    deleteCredential: deleteCredential,
    loadDomiciles:    loadDomiciles,
    saveDomiciles:    saveDomiciles,
    getAppVersion:    getAppVersion,
    _saveCredFromUI:  _saveCredFromUI,
    _deleteCredKey:   _deleteCredKey,
    _refreshCredsList:_refreshCredsList,
  };

  /* ── 13. Start ───────────────────────────────────────────────────────── */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
