/**
 * settings.js -- Settings panel view
 *
 * Sections:
 *   - Domiciles (add/remove)
 *   - Auth (run mwinit)
 *   - Orcha config (mode, host, port)
 *   - Credentials (set/delete)
 */

import bus           from '../bus.js';
import { settings as settingsBridge, auth, credentials } from '../bridge.js';
import toast         from '../components/toast.js';

let _el = null;

export function init(container) {
  _el = document.createElement('div');
  _el.id = 'view-settings';
  _el.className = 'view view--settings';
  _el.style.display = 'none';

  _el.innerHTML = `
    <div class="settings-wrap">
      <div class="settings-header">
        <h2>Settings</h2>
        <button id="settings-back" class="detail-panel__btn">Back to Fleet</button>
      </div>

      <section class="settings-section">
        <h3>Domiciles</h3>
        <p class="settings-hint">One domicile code per line (e.g. ABE40)</p>
        <textarea id="settings-domiciles" class="settings__textarea" rows="6"></textarea>
        <div class="settings-section__actions">
          <button id="settings-save-domiciles" class="detail-panel__btn">Save</button>
          <button id="settings-reset-domiciles" class="detail-panel__btn detail-panel__btn--secondary">Reset to defaults</button>
        </div>
      </section>

      <section class="settings-section">
        <h3>Midway Auth</h3>
        <div id="settings-auth-status" class="settings__status">Checking...</div>
        <button id="settings-mwinit" class="detail-panel__btn">Run mwinit</button>
      </section>

      <section class="settings-section">
        <h3>Orcha Config</h3>
        <label>Mode
          <select id="settings-orcha-mode" class="toolbar__select">
            <option value="local">Local</option>
            <option value="remote">Remote</option>
            <option value="bedrock">Bedrock</option>
          </select>
        </label>
        <label>Host <input id="settings-orcha-host" class="settings__input" type="text" placeholder="localhost" /></label>
        <label>Port <input id="settings-orcha-port" class="settings__input" type="number" placeholder="4799" /></label>
        <button id="settings-save-orcha" class="detail-panel__btn">Save Orcha Config</button>
      </section>
    </div>
  `;
  container.appendChild(_el);

  // Back button
  document.getElementById('settings-back').addEventListener('click', () => {
    bus.emit('ui:view-change', { from: 'settings', to: 'fleet' });
  });

  // Load current domiciles
  settingsBridge.getDomiciles().then((d) => {
    const ta = document.getElementById('settings-domiciles');
    if (ta && d) ta.value = Array.isArray(d) ? d.join('\n') : d;
  }).catch(() => {});

  // Save domiciles
  document.getElementById('settings-save-domiciles').addEventListener('click', async () => {
    const ta = document.getElementById('settings-domiciles');
    if (!ta) return;
    const arr = ta.value.split(/[\\n,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    try {
      await settingsBridge.saveDomiciles(arr);
      toast.show('success', 'Domiciles saved');
    } catch (e) {
      toast.show('error', 'Save failed: ' + e.message);
    }
  });

  // Reset domiciles
  document.getElementById('settings-reset-domiciles').addEventListener('click', async () => {
    try {
      const d = await settingsBridge.resetDomiciles();
      const ta = document.getElementById('settings-domiciles');
      if (ta && d) ta.value = Array.isArray(d) ? d.join('\n') : '';
      toast.show('info', 'Domiciles reset to defaults');
    } catch (e) {
      toast.show('error', 'Reset failed: ' + e.message);
    }
  });

  // Auth status
  auth.checkMidway().then((result) => {
    const el = document.getElementById('settings-auth-status');
    if (el) el.textContent = result && result.ok
      ? 'Midway authenticated'
      : ('Not authenticated: ' + (result && result.reason || 'unknown'));
  }).catch(() => {});

  // Run mwinit
  document.getElementById('settings-mwinit').addEventListener('click', async () => {
    toast.show('info', 'Running mwinit...', 2000);
    try {
      const r = await auth.runMwinit();
      toast.show(r && r.ok ? 'success' : 'error',
        r && r.ok ? 'mwinit succeeded' : ('mwinit failed: ' + (r && r.reason || '')),
        5000);
    } catch (e) {
      toast.show('error', 'mwinit error: ' + e.message);
    }
  });

  // Load orcha config
  settingsBridge.getOrchaConfig().then((cfg) => {
    if (!cfg) return;
    const modeEl = document.getElementById('settings-orcha-mode');
    const hostEl = document.getElementById('settings-orcha-host');
    const portEl = document.getElementById('settings-orcha-port');
    if (modeEl && cfg.mode) modeEl.value = cfg.mode;
    if (hostEl && cfg.host) hostEl.value = cfg.host;
    if (portEl && cfg.port) portEl.value = cfg.port;
  }).catch(() => {});

  // Save orcha config
  document.getElementById('settings-save-orcha').addEventListener('click', async () => {
    const mode = document.getElementById('settings-orcha-mode').value;
    const host = document.getElementById('settings-orcha-host').value.trim();
    const port = parseInt(document.getElementById('settings-orcha-port').value, 10) || 4799;
    try {
      await settingsBridge.save('orchaConfig', { mode, host, port });
      toast.show('success', 'Orcha config saved');
    } catch (e) {
      toast.show('error', 'Save failed: ' + e.message);
    }
  });

  // Show/hide based on view
  bus.on('ui:view-change', ({ to }) => {
    _el.style.display = to === 'settings' ? 'flex' : 'none';
  });
}
