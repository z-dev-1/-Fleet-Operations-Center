/**
 * settings.js -- Settings panel view
 *
 * Sections:
 *   - Domiciles (add/remove)
 *   - Auth (run mwinit)
 *   - Orcha config (mode, host, port)
 *   - Credentials (set/delete)         ← S10
 *   - Slack                            ← S10
 *   - Email (SMTP)                     ← S10
 *   - SharePoint                       ← S10
 *   - Asana                            ← S10
 *   - Notifications                    ← S10
 *
 * S10: wires all bridge-available integrations into the settings panel.
 */

import bus      from '../bus.js';
import {
  settings  as settingsBridge,
  auth,
  credentials,
  slack     as slackBridge,
  email     as emailBridge,
  sp        as spBridge,
  asana     as asanaBridge,
} from '../bridge.js';
import toast from '../components/toast.js';

let _el = null;

// ── HTML skeleton ──────────────────────────────────────────────────────────
function _html() {
  return `
    <div class="settings-wrap">

      <!-- Header -->
      <div class="settings-header">
        <h2>Settings</h2>
        <button id="settings-back" class="detail-panel__btn">Back to Fleet</button>
      </div>

      <!-- 1 Domiciles -->
      <section class="settings-section" id="sect-domiciles">
        <div class="settings-section__title">Domiciles</div>
        <p class="settings-hint">One domicile code per line (e.g. ABE40)</p>
        <textarea id="settings-domiciles" class="settings__textarea" rows="6"></textarea>
        <div class="settings-section__actions">
          <button id="settings-save-domiciles"  class="detail-panel__btn">Save</button>
          <button id="settings-reset-domiciles" class="detail-panel__btn detail-panel__btn--secondary">Reset to defaults</button>
        </div>
      </section>

      <!-- 2 Midway Auth -->
      <section class="settings-section" id="sect-auth">
        <div class="settings-section__title">Midway Auth</div>
        <div id="settings-auth-status" class="settings__status">Checking...</div>
        <div class="settings-section__actions">
          <button id="settings-mwinit" class="detail-panel__btn">Run mwinit</button>
          <button id="settings-recheck-auth" class="detail-panel__btn detail-panel__btn--secondary">Re-check</button>
        </div>
      </section>

      <!-- 3 Orcha Config -->
      <section class="settings-section" id="sect-orcha">
        <div class="settings-section__title">Orcha Config</div>
        <div class="settings-fields">
          <label class="settings-label">Mode
            <select id="settings-orcha-mode" class="settings__select">
              <option value="local">Local</option>
              <option value="remote">Remote</option>
              <option value="bedrock">Bedrock</option>
            </select>
          </label>
          <label class="settings-label">Host
            <input id="settings-orcha-host" class="settings__input" type="text" placeholder="localhost" />
          </label>
          <label class="settings-label">Port
            <input id="settings-orcha-port" class="settings__input" type="number" placeholder="4799" />
          </label>
        </div>
        <div class="settings-section__actions">
          <button id="settings-save-orcha" class="detail-panel__btn">Save</button>
        </div>
      </section>

      <!-- 4 Credentials (S10) -->
      <section class="settings-section" id="sect-creds">
        <div class="settings-section__title">Credentials</div>
        <p class="settings-hint">Stored encrypted via Electron safeStorage. Values are write-only — cannot be read back.</p>
        <div class="settings-fields">
          <label class="settings-label settings-label--grow">Key
            <input id="creds-key"   class="settings__input" type="text"     placeholder="e.g. aap-password" />
          </label>
          <label class="settings-label settings-label--grow">Value
            <input id="creds-val"   class="settings__input" type="password" placeholder="secret value" />
          </label>
        </div>
        <div class="settings-section__actions">
          <button id="creds-set"    class="detail-panel__btn">Save Credential</button>
          <button id="creds-delete" class="detail-panel__btn settings-btn--danger">Delete Key</button>
        </div>
        <div id="creds-list-wrap" class="settings-list-wrap">
          <div class="settings-list-label">Stored keys</div>
          <div id="creds-list" class="settings-key-list">Loading...</div>
        </div>
      </section>

      <!-- 4b Vendor Portal Auth (S25-5) -->
      <section class="settings-section" id="sect-vendor-auth">
        <div class="settings-section__title">Vendor Portal Credentials</div>
        <p class="settings-hint">Used for automated PACCAR and Volvo portal login. Stored encrypted via safeStorage. Passwords are write-only.</p>

        <!-- PACCAR -->
        <div class="vnd-auth__card" id="vnd-auth-paccar">
          <div class="vnd-auth__card-header">
            <span class="vnd-auth__label">PACCAR (paccarpg.decisiv.net)</span>
            <span class="settings__status" id="vnd-auth-paccar-status">Checking...</span>
          </div>
          <div class="settings-fields">
            <label class="settings-label">Username
              <input id="vnd-paccar-user" class="settings__input" type="text"     autocomplete="off" placeholder="portal username" />
            </label>
            <label class="settings-label">Password
              <input id="vnd-paccar-pass" class="settings__input" type="password" autocomplete="new-password" placeholder="(stored encrypted)" />
            </label>
          </div>
          <div class="settings-section__actions">
            <button id="vnd-paccar-save"  class="detail-panel__btn">Save</button>
            <button id="vnd-paccar-clear" class="detail-panel__btn settings-btn--danger">Clear</button>
          </div>
        </div>

        <!-- Volvo -->
        <div class="vnd-auth__card" id="vnd-auth-volvo" style="margin-top:12px">
          <div class="vnd-auth__card-header">
            <span class="vnd-auth__label">Volvo (volvopg.asist.decisiv.net)</span>
            <span class="settings__status" id="vnd-auth-volvo-status">Checking...</span>
          </div>
          <div class="settings-fields">
            <label class="settings-label">Username
              <input id="vnd-volvo-user" class="settings__input" type="text"     autocomplete="off" placeholder="portal username" />
            </label>
            <label class="settings-label">Password
              <input id="vnd-volvo-pass" class="settings__input" type="password" autocomplete="new-password" placeholder="(stored encrypted)" />
            </label>
          </div>
          <div class="settings-section__actions">
            <button id="vnd-volvo-save"  class="detail-panel__btn">Save</button>
            <button id="vnd-volvo-clear" class="detail-panel__btn settings-btn--danger">Clear</button>
          </div>
        </div>
      </section>

      <!-- 5 Slack (S10) -->
      <section class="settings-section" id="sect-slack">
        <div class="settings-section__title">Slack</div>
        <div id="slack-auth-status" class="settings__status settings__status--loading">Checking...</div>
        <div class="settings-section__actions">
          <button id="slack-login"       class="detail-panel__btn">Sign in to Slack</button>
          <button id="slack-recheck"     class="detail-panel__btn detail-panel__btn--secondary">Re-check</button>
        </div>
      </section>

      <!-- 6 Email / SMTP (S10) -->
      <section class="settings-section" id="sect-email">
        <div class="settings-section__title">Email (SMTP)</div>
        <div class="settings-fields">
          <label class="settings-label">Host
            <input id="email-host"     class="settings__input" type="text"   placeholder="smtp.corp.amazon.com" />
          </label>
          <label class="settings-label">Port
            <input id="email-port"     class="settings__input" type="number" placeholder="587" />
          </label>
          <label class="settings-label">From address
            <input id="email-from"     class="settings__input" type="email"  placeholder="you@amazon.com" />
          </label>
          <label class="settings-label">Username
            <input id="email-user"     class="settings__input" type="text"   placeholder="LDAP / CORP\\user" />
          </label>
          <label class="settings-label">Password
            <input id="email-pass"     class="settings__input" type="password" placeholder="(stored encrypted)" />
          </label>
          <label class="settings-label settings-label--inline">
            <input id="email-tls"      type="checkbox" /> Use TLS
          </label>
        </div>
        <div class="settings-section__actions">
          <button id="email-save"   class="detail-panel__btn">Save</button>
          <button id="email-test"   class="detail-panel__btn detail-panel__btn--secondary">Send test email</button>
        </div>
        <div id="email-test-addr-wrap" class="settings-inline-row" style="display:none">
          <input id="email-test-addr" class="settings__input" type="email" placeholder="recipient@amazon.com" />
          <button id="email-test-send" class="detail-panel__btn">Send</button>
          <button id="email-test-cancel" class="detail-panel__btn detail-panel__btn--secondary">Cancel</button>
        </div>
      </section>

      <!-- 7 SharePoint (S10) -->
      <section class="settings-section" id="sect-sp">
        <div class="settings-section__title">SharePoint</div>
        <div class="settings-fields">
          <label class="settings-label">Site URL
            <input id="sp-site-url"   class="settings__input" type="text" placeholder="https://amazon.sharepoint.com/sites/..." />
          </label>
          <label class="settings-label">List name
            <input id="sp-list-name"  class="settings__input" type="text" placeholder="Fleet Status" />
          </label>
          <label class="settings-label">Username
            <input id="sp-user"       class="settings__input" type="text" placeholder="alias@amazon.com" />
          </label>
          <label class="settings-label">Password
            <input id="sp-pass"       class="settings__input" type="password" placeholder="(stored encrypted)" />
          </label>
        </div>
        <div class="settings-section__actions">
          <button id="sp-save"   class="detail-panel__btn">Save</button>
          <button id="sp-push-now" class="detail-panel__btn detail-panel__btn--secondary">Push now</button>
        </div>
      </section>

      <!-- 8 Asana (S10) -->
      <section class="settings-section" id="sect-asana">
        <div class="settings-section__title">Asana</div>
        <div id="asana-auth-status" class="settings__status settings__status--loading">Checking...</div>
        <div class="settings-fields">
          <label class="settings-label">Personal Access Token
            <input id="asana-token"      class="settings__input" type="password" placeholder="0/xxxxxxxxxxxxxxxx" />
          </label>
          <label class="settings-label">Default workspace GID
            <input id="asana-workspace"  class="settings__input" type="text"     placeholder="1234567890" />
          </label>
          <label class="settings-label">Default project GID
            <input id="asana-project"    class="settings__input" type="text"     placeholder="1234567890" />
          </label>
        </div>
        <div class="settings-section__actions">
          <button id="asana-save"     class="detail-panel__btn">Save</button>
          <button id="asana-verify"   class="detail-panel__btn detail-panel__btn--secondary">Verify token</button>
        </div>
      </section>

      <!-- 9 Notifications (S10) -->
      <section class="settings-section" id="sect-notif">
        <div class="settings-section__title">Notifications</div>
        <div class="settings-fields">
          <label class="settings-label settings-label--inline">
            <input id="notif-auth-failure" type="checkbox" checked />
            OS notification on Midway auth failure
          </label>
          <label class="settings-label settings-label--inline">
            <input id="notif-sync-complete" type="checkbox" checked />
            OS notification on sync complete
          </label>
          <label class="settings-label settings-label--inline">
            <input id="notif-sync-error" type="checkbox" checked />
            OS notification on sync error
          </label>
        </div>
        <div class="settings-section__actions">
          <button id="notif-save" class="detail-panel__btn">Save</button>
        </div>
      </section>

    </div>
  `;
}

// ── Section: Domiciles ─────────────────────────────────────────────────────
function _wireDomiciles() {
  settingsBridge.getDomiciles().then((d) => {
    const ta = document.getElementById('settings-domiciles');
    if (ta && d) ta.value = Array.isArray(d) ? d.join('\n') : d;
  }).catch(() => {});

  document.getElementById('settings-save-domiciles').addEventListener('click', async () => {
    const ta = document.getElementById('settings-domiciles');
    if (!ta) return;
    const arr = ta.value.split(/[\n,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    try {
      await settingsBridge.saveDomiciles(arr);
      toast.show('success', 'Domiciles saved');
    } catch (e) {
      toast.show('error', 'Save failed: ' + e.message);
    }
  });

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
}

// ── Section: Midway Auth ───────────────────────────────────────────────────
function _checkAuth() {
  const el = document.getElementById('settings-auth-status');
  if (!el) return;
  el.textContent = 'Checking...';
  el.className = 'settings__status settings__status--loading';
  auth.checkMidway().then((result) => {
    if (!el) return;
    if (result && result.ok) {
      el.textContent = '✓ Midway authenticated';
      el.className = 'settings__status settings__status--ok';
    } else {
      el.textContent = '✗ Not authenticated: ' + (result && result.reason || 'unknown');
      el.className = 'settings__status settings__status--error';
    }
  }).catch(() => {
    if (el) { el.textContent = 'Check failed'; el.className = 'settings__status settings__status--error'; }
  });
}

function _wireAuth() {
  _checkAuth();

  document.getElementById('settings-mwinit').addEventListener('click', async () => {
    toast.show('info', 'Running mwinit...', 2000);
    try {
      const r = await auth.runMwinit();
      toast.show(r && r.ok ? 'success' : 'error',
        r && r.ok ? 'mwinit succeeded' : ('mwinit failed: ' + (r && r.reason || '')), 5000);
      if (r && r.ok) _checkAuth();
    } catch (e) {
      toast.show('error', 'mwinit error: ' + e.message);
    }
  });

  document.getElementById('settings-recheck-auth').addEventListener('click', () => _checkAuth());
}

// ── Section: Orcha Config ──────────────────────────────────────────────────
function _wireOrcha() {
  settingsBridge.getOrchaConfig().then((cfg) => {
    if (!cfg) return;
    const m = document.getElementById('settings-orcha-mode');
    const h = document.getElementById('settings-orcha-host');
    const p = document.getElementById('settings-orcha-port');
    if (m && cfg.mode) m.value = cfg.mode;
    if (h && cfg.host) h.value = cfg.host;
    if (p && cfg.port) p.value = cfg.port;
  }).catch(() => {});

  document.getElementById('settings-save-orcha').addEventListener('click', async () => {
    const mode = document.getElementById('settings-orcha-mode').value;
    const host = (document.getElementById('settings-orcha-host').value || '').trim();
    const port = parseInt(document.getElementById('settings-orcha-port').value, 10) || 4799;
    try {
      await settingsBridge.save('orchaConfig', { mode, host, port });
      toast.show('success', 'Orcha config saved');
    } catch (e) {
      toast.show('error', 'Save failed: ' + e.message);
    }
  });
}

// ── Section: Credentials (S10) ────────────────────────────────────────────
function _loadCredsList() {
  const listEl = document.getElementById('creds-list');
  if (!listEl) return;
  credentials.list().then((keys) => {
    if (!listEl) return;
    if (!keys || keys.length === 0) {
      listEl.innerHTML = '<span class="settings-list-empty">No credentials stored.</span>';
      return;
    }
    listEl.innerHTML = keys.map((k) =>
      '<span class="settings-key-pill">' + k + '</span>'
    ).join('');
  }).catch(() => {
    if (listEl) listEl.innerHTML = '<span class="settings-list-empty">Could not load keys.</span>';
  });
}

function _wireCreds() {
  _loadCredsList();

  document.getElementById('creds-set').addEventListener('click', async () => {
    const key = (document.getElementById('creds-key').value || '').trim();
    const val = document.getElementById('creds-val').value || '';
    if (!key) { toast.show('warn', 'Key name required', 3000); return; }
    if (!val)  { toast.show('warn', 'Value required', 3000); return; }
    try {
      await credentials.set(key, val);
      document.getElementById('creds-key').value = '';
      document.getElementById('creds-val').value = '';
      toast.show('success', 'Credential saved: ' + key);
      _loadCredsList();
    } catch (e) {
      toast.show('error', 'Save failed: ' + e.message);
    }
  });

  document.getElementById('creds-delete').addEventListener('click', async () => {
    const key = (document.getElementById('creds-key').value || '').trim();
    if (!key) { toast.show('warn', 'Enter the key name to delete', 3000); return; }
    try {
      await credentials.delete(key);
      document.getElementById('creds-key').value = '';
      toast.show('info', 'Deleted: ' + key);
      _loadCredsList();
    } catch (e) {
      toast.show('error', 'Delete failed: ' + e.message);
    }
  });
}

// ── Section: Vendor Portal Auth (S25-5) ─────────────────────────────────────
const _VENDOR_CRED_KEYS = {
  paccar: { user: 'vendor.paccar.username', pass: 'vendor.paccar.password' },
  volvo:  { user: 'vendor.volvo.username',  pass: 'vendor.volvo.password'  },
};

async function _checkVendorCred(vendor) {
  const keys = _VENDOR_CRED_KEYS[vendor];
  const el   = document.getElementById('vnd-auth-' + vendor + '-status');
  if (!el) return;
  el.textContent = 'Checking...';
  el.className   = 'settings__status settings__status--loading';
  try {
    const hasUser = await credentials.has(keys.user);
    const hasPass = await credentials.has(keys.pass);
    if (hasUser && hasPass) {
      el.textContent = '✓ Credentials saved';
      el.className   = 'settings__status settings__status--ok';
    } else {
      el.textContent = '✗ Not configured';
      el.className   = 'settings__status settings__status--error';
    }
  } catch (_) {
    el.textContent = 'Check failed';
    el.className   = 'settings__status settings__status--error';
  }
}

function _wireVendorAuth() {
  ['paccar', 'volvo'].forEach((vendor) => {
    _checkVendorCred(vendor);

    document.getElementById('vnd-' + vendor + '-save').addEventListener('click', async () => {
      const user = (document.getElementById('vnd-' + vendor + '-user').value || '').trim();
      const pass = document.getElementById('vnd-' + vendor + '-pass').value || '';
      if (!user) { toast.show('warn', 'Username required', 3000); return; }
      if (!pass) { toast.show('warn', 'Password required', 3000); return; }
      const btn = document.getElementById('vnd-' + vendor + '-save');
      btn.disabled = true; btn.textContent = 'Saving...';
      try {
        const keys = _VENDOR_CRED_KEYS[vendor];
        await credentials.set(keys.user, user);
        await credentials.set(keys.pass, pass);
        document.getElementById('vnd-' + vendor + '-user').value = '';
        document.getElementById('vnd-' + vendor + '-pass').value = '';
        toast.show('success', vendor.charAt(0).toUpperCase() + vendor.slice(1) + ' credentials saved');
        _checkVendorCred(vendor);
      } catch (e) {
        toast.show('error', 'Save failed: ' + e.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Save';
      }
    });

    document.getElementById('vnd-' + vendor + '-clear').addEventListener('click', async () => {
      const btn = document.getElementById('vnd-' + vendor + '-clear');
      btn.disabled = true; btn.textContent = 'Clearing...';
      try {
        const keys = _VENDOR_CRED_KEYS[vendor];
        await credentials.delete(keys.user);
        await credentials.delete(keys.pass);
        toast.show('info', vendor.charAt(0).toUpperCase() + vendor.slice(1) + ' credentials cleared');
        _checkVendorCred(vendor);
      } catch (e) {
        toast.show('error', 'Clear failed: ' + e.message);
      } finally {
        btn.disabled = false; btn.textContent = 'Clear';
      }
    });
  });
}

// ── Section: Slack (S10) ──────────────────────────────────────────────────
function _checkSlack() {
  const el = document.getElementById('slack-auth-status');
  if (!el) return;
  el.textContent = 'Checking...';
  el.className = 'settings__status settings__status--loading';
  slackBridge.checkAuth().then((r) => {
    if (!el) return;
    if (r && r.authenticated) {
      el.textContent = '✓ Slack authenticated';
      el.className = 'settings__status settings__status--ok';
    } else {
      el.textContent = '✗ Not signed in';
      el.className = 'settings__status settings__status--error';
    }
  }).catch(() => {
    if (el) { el.textContent = 'Check failed'; el.className = 'settings__status settings__status--error'; }
  });
}

function _wireSlack() {
  _checkSlack();

  document.getElementById('slack-login').addEventListener('click', async () => {
    toast.show('info', 'Opening Slack login...', 3000);
    try {
      await slackBridge.login();
      _checkSlack();
      toast.show('success', 'Slack sign-in complete');
    } catch (e) {
      toast.show('error', 'Slack login failed: ' + e.message);
    }
  });

  document.getElementById('slack-recheck').addEventListener('click', () => _checkSlack());
}

// ── Section: Email / SMTP (S10) ───────────────────────────────────────────
function _wireEmail() {
  emailBridge.getConfig().then((cfg) => {
    if (!cfg) return;
    const fields = {
      'email-host': cfg.host,
      'email-port': cfg.port,
      'email-from': cfg.from,
      'email-user': cfg.user || cfg.username,
    };
    Object.entries(fields).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (el && val) el.value = val;
    });
    const tlsEl = document.getElementById('email-tls');
    if (tlsEl) tlsEl.checked = !!cfg.tls;
  }).catch(() => {});

  document.getElementById('email-save').addEventListener('click', async () => {
    const config = {
      host: (document.getElementById('email-host').value || '').trim(),
      port: parseInt(document.getElementById('email-port').value, 10) || 587,
      from: (document.getElementById('email-from').value || '').trim(),
      user: (document.getElementById('email-user').value || '').trim(),
      tls:  document.getElementById('email-tls').checked,
    };
    const pass = document.getElementById('email-pass').value;
    if (pass) config.pass = pass; // only include if user typed a new password
    if (!config.host) { toast.show('warn', 'SMTP host required', 3000); return; }
    try {
      await emailBridge.saveConfig(config);
      document.getElementById('email-pass').value = '';
      toast.show('success', 'Email config saved');
    } catch (e) {
      toast.show('error', 'Save failed: ' + e.message);
    }
  });

  document.getElementById('email-test').addEventListener('click', () => {
    const wrap = document.getElementById('email-test-addr-wrap');
    if (wrap) wrap.style.display = wrap.style.display === 'none' ? 'flex' : 'none';
  });

  document.getElementById('email-test-cancel').addEventListener('click', () => {
    const wrap = document.getElementById('email-test-addr-wrap');
    if (wrap) wrap.style.display = 'none';
  });

  document.getElementById('email-test-send').addEventListener('click', async () => {
    const to = (document.getElementById('email-test-addr').value || '').trim();
    if (!to) { toast.show('warn', 'Recipient address required', 3000); return; }
    const btn = document.getElementById('email-test-send');
    btn.disabled = true; btn.textContent = 'Sending...';
    try {
      await emailBridge.send({ to, subject: 'Fleet Ops test email', body: 'Test from Fleet Ops V-C settings.' });
      toast.show('success', 'Test email sent to ' + to, 5000);
      document.getElementById('email-test-addr-wrap').style.display = 'none';
    } catch (e) {
      toast.show('error', 'Send failed: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Send';
    }
  });
}

// ── Section: SharePoint (S10) ─────────────────────────────────────────────
function _wireSP() {
  spBridge.getConfig().then((cfg) => {
    if (!cfg) return;
    const fields = { 'sp-site-url': cfg.siteUrl, 'sp-list-name': cfg.listName, 'sp-user': cfg.user || cfg.username };
    Object.entries(fields).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (el && val) el.value = val;
    });
  }).catch(() => {});

  document.getElementById('sp-save').addEventListener('click', async () => {
    const config = {
      siteUrl:  (document.getElementById('sp-site-url').value  || '').trim(),
      listName: (document.getElementById('sp-list-name').value || '').trim(),
      user:     (document.getElementById('sp-user').value      || '').trim(),
    };
    const pass = document.getElementById('sp-pass').value;
    if (pass) config.pass = pass;
    if (!config.siteUrl) { toast.show('warn', 'Site URL required', 3000); return; }
    try {
      await spBridge.saveConfig(config);
      document.getElementById('sp-pass').value = '';
      toast.show('success', 'SharePoint config saved');
    } catch (e) {
      toast.show('error', 'Save failed: ' + e.message);
    }
  });

  document.getElementById('sp-push-now').addEventListener('click', async () => {
    const btn = document.getElementById('sp-push-now');
    btn.disabled = true; btn.textContent = 'Pushing...';
    try {
      const rows = (window.__fleet_bus && window.__fleet_state)
        ? window.__fleet_state.rows
        : [];
      await spBridge.push(rows);
      toast.show('success', 'SharePoint push triggered');
    } catch (e) {
      toast.show('error', 'Push failed: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Push now';
    }
  });
}

// ── Section: Asana (S10) ─────────────────────────────────────────────────
function _checkAsana() {
  const el = document.getElementById('asana-auth-status');
  if (!el) return;
  el.textContent = 'Checking...';
  el.className = 'settings__status settings__status--loading';
  asanaBridge.checkAuth().then((r) => {
    if (!el) return;
    if (r && r.ok) {
      el.textContent = '✓ Asana authenticated' + (r.name ? ' (' + r.name + ')' : '');
      el.className = 'settings__status settings__status--ok';
    } else {
      el.textContent = '✗ Not authenticated: ' + (r && r.reason || 'no token');
      el.className = 'settings__status settings__status--error';
    }
  }).catch(() => {
    if (el) { el.textContent = 'Check failed'; el.className = 'settings__status settings__status--error'; }
  });
}

function _wireAsana() {
  _checkAsana();

  asanaBridge.getConfig().then((cfg) => {
    if (!cfg) return;
    const fields = {
      'asana-workspace': cfg.defaultWorkspace || cfg.workspaceGid,
      'asana-project':   cfg.defaultProject   || cfg.projectGid,
    };
    Object.entries(fields).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (el && val) el.value = val;
    });
  }).catch(() => {});

  document.getElementById('asana-save').addEventListener('click', async () => {
    const token = (document.getElementById('asana-token').value || '').trim();
    const workspaceGid = (document.getElementById('asana-workspace').value || '').trim();
    const projectGid   = (document.getElementById('asana-project').value   || '').trim();
    const config = { workspaceGid, projectGid };
    if (token) config.token = token;
    if (!workspaceGid) { toast.show('warn', 'Workspace GID required', 3000); return; }
    try {
      await asanaBridge.saveConfig(config);
      document.getElementById('asana-token').value = '';
      toast.show('success', 'Asana config saved');
      if (token) _checkAsana();
    } catch (e) {
      toast.show('error', 'Save failed: ' + e.message);
    }
  });

  document.getElementById('asana-verify').addEventListener('click', async () => {
    const btn = document.getElementById('asana-verify');
    btn.disabled = true; btn.textContent = 'Verifying...';
    try {
      const me = await asanaBridge.getMe();
      toast.show('success', 'Asana OK — ' + (me && me.name || 'authenticated'), 4000);
      _checkAsana();
    } catch (e) {
      toast.show('error', 'Verify failed: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Verify token';
    }
  });
}

// ── Section: Notifications (S10) ─────────────────────────────────────────
function _wireNotifications() {
  // Load saved prefs
  settingsBridge.getAll().then((all) => {
    const prefs = (all && all.notifications) || {};
    const set = (id, key, def) => {
      const el = document.getElementById(id);
      if (el) el.checked = key in prefs ? !!prefs[key] : def;
    };
    set('notif-auth-failure',  'authFailure',   true);
    set('notif-sync-complete', 'syncComplete',  true);
    set('notif-sync-error',    'syncError',     true);
  }).catch(() => {});

  document.getElementById('notif-save').addEventListener('click', async () => {
    const prefs = {
      authFailure:  document.getElementById('notif-auth-failure').checked,
      syncComplete: document.getElementById('notif-sync-complete').checked,
      syncError:    document.getElementById('notif-sync-error').checked,
    };
    try {
      await settingsBridge.save('notifications', prefs);
      toast.show('success', 'Notification preferences saved');
    } catch (e) {
      toast.show('error', 'Save failed: ' + e.message);
    }
  });
}

// -- S22: Populate all fields from saved config ---
function _populate() {
  // Orcha config
  settingsBridge.getOrchaConfig().then((cfg) => {
    if (!cfg) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
    set('settings-orcha-mode', cfg.mode);
    set('settings-orcha-host', cfg.host);
    set('settings-orcha-port', cfg.port);
  }).catch(() => {});

  // Email config -- password intentionally never populated
  if (window.email && typeof window.email.getConfig === "function") {
    window.email.getConfig().then((cfg) => {
      if (!cfg) return;
      const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
      set('email-host', cfg.host); set('email-port', cfg.port);
      set('email-from', cfg.from); set('email-user', cfg.user || cfg.username);
      const tlsEl = document.getElementById('email-tls'); if (tlsEl) tlsEl.checked = !!cfg.tls;
    }).catch(() => {}); }

  // SharePoint config
  if (window.sp && typeof window.sp.getConfig === "function") {
    window.sp.getConfig().then((cfg) => {
      if (!cfg) return;
      const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
      set('sp-site-url',  cfg.siteUrl || cfg.site);
      set('sp-list-name', cfg.listName || cfg.list);
      set('sp-user',      cfg.user || cfg.username);
    }).catch(() => {}); }

  // Asana config
  if (window.asana && typeof window.asana.getConfig === "function") {
    window.asana.getConfig().then((cfg) => {
      if (!cfg) return;
      const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
      set('asana-workspace', cfg.defaultWorkspace || cfg.workspaceGid);
      set('asana-project',   cfg.defaultProject   || cfg.projectGid);
      const tokEl = document.getElementById('asana-token');
      if (tokEl && (cfg.token || cfg.hasToken)) tokEl.placeholder = "••••••••  (saved)";
    }).catch(() => {}); }

  // Notifications
  settingsBridge.getAll().then((all) => {
    const prefs = (all && all.notifications) || {};
    const chk = (id, key, def) => { const el = document.getElementById(id); if (el) el.checked = key in prefs ? !!prefs[key] : def; };
    chk('notif-auth-failure',  'authFailure',  true);
    chk('notif-sync-complete', 'syncComplete', true);
    chk('notif-sync-error',    'syncError',    true);
  }).catch(() => {});

  // Domiciles
  settingsBridge.getDomiciles().then((d) => {
    const ta = document.getElementById('settings-domiciles');
    if (ta && d) ta.value = Array.isArray(d) ? d.join('\n') : d;
  }).catch(() => {});

  _checkSlack();  // re-check Slack auth
  // S25-5: re-check vendor portal cred status
  ['paccar', 'volvo'].forEach(_checkVendorCred);
  _checkAuth();   // re-check Midway
}

// -- S22: Section collapse/expand ---
const _COLLAPSE_KEY = 'settings_collapsed';
function _getCollapsed() { try { return JSON.parse(localStorage.getItem(_COLLAPSE_KEY) || '{}'); } catch (_) { return {}; } }
function _saveCollapsed(state) { try { localStorage.setItem(_COLLAPSE_KEY, JSON.stringify(state)); } catch (_) {} }
function _initCollapse() {
  const state = _getCollapsed();
  _el.querySelectorAll('.settings__section-toggle').forEach((toggle) => {
    const sec = toggle.closest('.settings__section'); if (!sec) return;
    const key = sec.dataset.section;
    const body = sec.querySelector('.settings__section-body'); if (!body) return;
    if (state[key]) { body.style.display = 'none'; toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = '▶'; }
    toggle.addEventListener('click', () => {
      const open = body.style.display === 'none';
      body.style.display = open ? '' : 'none';
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? '▼' : '▶';
      const cur = _getCollapsed(); if (open) { delete cur[key]; } else { cur[key] = true; } _saveCollapsed(cur);
    });
  });
}


// ── Init ───────────────────────────────────────────────────────────────────
export function init(container) {
  _el = document.createElement('div');
  _el.id = 'view-settings';
  _el.className = 'view view--settings';
  _el.style.display = 'none';
  _el.innerHTML = _html();
  container.appendChild(_el);

  // Back button
  document.getElementById('settings-back').addEventListener('click', () => {
    bus.emit('ui:view-change', { from: 'settings', to: 'fleet' });
  });

  // Wire all sections
  _wireDomiciles();
  _wireAuth();
  _wireOrcha();
  _wireCreds();        // S10
  _wireVendorAuth();   // S25-5
  _wireSlack();        // S10
  _wireEmail();        // S10
  _wireSP();           // S10
  _wireAsana();        // S10
  _wireNotifications();// S10

  // S22: init collapse + populate on first load
  _initCollapse();
  _populate();

  // Show/hide; re-populate on every open (S22)
  bus.on('ui:view-change', ({ to }) => {
    _el.style.display = to === 'settings' ? 'flex' : 'none';
    if (to === 'settings') _populate();
  });
}
