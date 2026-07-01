/**
 * settings.js — Fleet Ops Settings Drawer (4-tab redesign)
 *
 * Tabs:
 *   1. UI & App        — themes, colors, font, layout, animations
 *   2. Integrations    — domiciles, midway, orcha, creds, email, slack, asana
 *   3. Operators & SP  — per-operator SharePoint config (auto-populated from sync)
 *   4. Accounts        — flat site credentials list (auto-save)
 *
 * Architecture:
 *   - Drawer mounts on document.body (fixed overlay), NOT in #views-mount
 *   - Listens for bus 'ui:view-change' → { to: 'settings' } to open
 *   - Does NOT consume the view-change — fleet view stays mounted behind
 *   - Close button / overlay click closes the drawer
 */

import bus                                         from '../bus.js';
import { settings as settingsBridge }              from '../bridge.js';
import { auth     as authBridge }                  from '../bridge.js';
import { credentials as credsBridge }              from '../bridge.js';
import { slack    as slackBridge }                 from '../bridge.js';
import { email    as emailBridge }                 from '../bridge.js';
import { sp       as spBridge }                    from '../bridge.js';
import { asana    as asanaBridge }                 from '../bridge.js';
import toast                                       from '../components/toast.js';

// ── Module state ────────────────────────────────────────────────────────────
let _drawer   = null;   // the drawer DOM element
let _overlay  = null;   // the backdrop overlay

// ── HTML ─────────────────────────────────────────────────────────────────────
function _html() {
  return `
  <!-- Overlay backdrop -->
  <div id="sd-overlay"></div>

  <!-- Drawer -->
  <div class="settings-drawer" id="settings-drawer">

    <!-- Header -->
    <div class="sd-header">
      <span style="font-size:16px">⚙</span>
      <span class="sd-title">Settings</span>
      <button class="sd-close" id="sd-close-btn">✕</button>
    </div>

    <!-- Tab bar -->
    <div class="sd-tabs">
      <button class="sd-tab active" data-pane="ui">UI &amp; App</button>
      <button class="sd-tab"        data-pane="integrations">Integrations</button>
      <button class="sd-tab"        data-pane="operators">Operators &amp; SP</button>
      <button class="sd-tab"        data-pane="accounts">Accounts</button>
    </div>

    <!-- Body -->
    <div class="sd-body">

      <!-- ══ TAB 1: UI & App ══════════════════════════════════════════════ -->
      <div id="sd-pane-ui">

        <!-- Templates -->
        <div class="sd-section">
          <div class="sd-section-title">Templates</div>
          <div class="sd-template-grid">
            <div class="sd-template active" data-theme="dark">
              <div class="sd-tpl-preview dark-prev"></div>
              <div class="sd-tpl-info">
                <div class="sd-tpl-name">Dark</div>
                <div class="sd-tpl-desc">Default dark theme</div>
              </div>
              <span class="sd-tpl-check">✓</span>
            </div>
            <div class="sd-template" data-theme="light">
              <div class="sd-tpl-preview light-prev"></div>
              <div class="sd-tpl-info">
                <div class="sd-tpl-name">Light</div>
                <div class="sd-tpl-desc">Light mode</div>
              </div>
              <span class="sd-tpl-check" style="display:none">✓</span>
            </div>
            <div class="sd-template" data-theme="midnight">
              <div class="sd-tpl-preview midnight-prev"></div>
              <div class="sd-tpl-info">
                <div class="sd-tpl-name">Midnight</div>
                <div class="sd-tpl-desc">Deep black</div>
              </div>
              <span class="sd-tpl-check" style="display:none">✓</span>
            </div>
            <div class="sd-template" data-theme="ocean">
              <div class="sd-tpl-preview ocean-prev"></div>
              <div class="sd-tpl-info">
                <div class="sd-tpl-name">Ocean</div>
                <div class="sd-tpl-desc">Teal accents</div>
              </div>
              <span class="sd-tpl-check" style="display:none">✓</span>
            </div>
          </div>
        </div>

        <!-- Colors -->
        <div class="sd-section">
          <div class="sd-section-title">Colors</div>
          <div class="sd-color-row">
            <div class="sd-color-item">
              <div class="sd-label">Accent Color</div>
              <div class="sd-color-swatch-row">
                <div class="sd-swatch active" style="background:#58a6ff" title="Blue"   data-var="--acc"></div>
                <div class="sd-swatch"        style="background:#d2a8ff" title="Purple" data-var="--acc"></div>
                <div class="sd-swatch"        style="background:#7ee787" title="Green"  data-var="--acc"></div>
                <div class="sd-swatch"        style="background:#ffa657" title="Orange" data-var="--acc"></div>
                <div class="sd-swatch"        style="background:#f78166" title="Red"    data-var="--acc"></div>
                <input type="color" class="sd-color-custom" value="#58a6ff" title="Custom" data-var="--acc"/>
              </div>
            </div>
            <div class="sd-color-item">
              <div class="sd-label">Background</div>
              <div class="sd-color-swatch-row">
                <div class="sd-swatch active" style="background:#0d1117" title="Default" data-var="--bg"></div>
                <div class="sd-swatch"        style="background:#080c10" title="Darker"  data-var="--bg"></div>
                <div class="sd-swatch"        style="background:#0d1b2a" title="Navy"    data-var="--bg"></div>
                <input type="color" class="sd-color-custom" value="#0d1117" title="Custom" data-var="--bg"/>
              </div>
            </div>
            <div class="sd-color-item">
              <div class="sd-label">Panel Color</div>
              <div class="sd-color-swatch-row">
                <div class="sd-swatch active" style="background:#161b22" title="Default" data-var="--panel"></div>
                <div class="sd-swatch"        style="background:#111318" title="Darker"  data-var="--panel"></div>
                <div class="sd-swatch"        style="background:#141a24" title="Navy"    data-var="--panel"></div>
                <input type="color" class="sd-color-custom" value="#161b22" title="Custom" data-var="--panel"/>
              </div>
            </div>
            <div class="sd-color-item">
              <div class="sd-label">Text Color</div>
              <div class="sd-color-swatch-row">
                <div class="sd-swatch active" style="background:#f0f6fc;border-color:#444" title="Default" data-var="--txt"></div>
                <div class="sd-swatch"        style="background:#e6edf3;border-color:#444" title="Soft"    data-var="--txt"></div>
                <div class="sd-swatch"        style="background:#cdd9e5;border-color:#444" title="Muted"   data-var="--txt"></div>
                <input type="color" class="sd-color-custom" value="#f0f6fc" title="Custom" data-var="--txt"/>
              </div>
            </div>
          </div>
        </div>

        <!-- Transparency -->
        <div class="sd-section">
          <div class="sd-section-title">Transparency</div>
          <div class="sd-slider-row">
            <div class="sd-label">Panel Opacity</div>
            <div class="sd-slider-wrap">
              <input type="range" class="sd-slider" id="sl-opacity" min="60" max="100" value="100"/>
              <span class="sd-slider-val" id="sl-opacity-val">100%</span>
            </div>
          </div>
          <div class="sd-slider-row">
            <div class="sd-label">Blur Intensity</div>
            <div class="sd-slider-wrap">
              <input type="range" class="sd-slider" id="sl-blur" min="0" max="20" value="4"/>
              <span class="sd-slider-val" id="sl-blur-val">4px</span>
            </div>
          </div>
        </div>

        <!-- Layout -->
        <div class="sd-section">
          <div class="sd-section-title">Layout</div>
          <div class="sd-toggle-row">
            <span class="sd-toggle-label">Compact Rows</span>
            <input type="checkbox" id="toggle-compact"/>
          </div>
        </div>

        <!-- Animations -->
        <div class="sd-section">
          <div class="sd-section-title">Animations</div>
          <div class="sd-toggle-row"><span class="sd-toggle-label">Show Animations</span><input type="checkbox" checked/></div>
          <div class="sd-toggle-row"><span class="sd-toggle-label">Scan Line Effect</span><input type="checkbox" checked/></div>
          <div class="sd-toggle-row"><span class="sd-toggle-label">Row Fade-In</span><input type="checkbox" checked/></div>
          <div class="sd-toggle-row"><span class="sd-toggle-label">KPI Pop-In</span><input type="checkbox" checked/></div>
          <div class="sd-slider-row" style="margin-top:8px">
            <div class="sd-label">Drawer Slide Speed</div>
            <div class="sd-slider-wrap">
              <input type="range" class="sd-slider" id="sl-speed" min="100" max="600" value="250"/>
              <span class="sd-slider-val" id="sl-speed-val">250ms</span>
            </div>
          </div>
        </div>

        <!-- Font -->
        <div class="sd-section">
          <div class="sd-section-title">Font</div>
          <div class="sd-font-row">
            <button class="sd-font-btn active" data-font="system">System</button>
            <button class="sd-font-btn" data-font="serif"   style="font-family:Georgia,serif">Serif</button>
            <button class="sd-font-btn" data-font="mono"    style="font-family:monospace">Mono</button>
            <button class="sd-font-btn" data-font="inter"   style="font-family:sans-serif">Inter</button>
          </div>
        </div>

        <!-- Border Radius -->
        <div class="sd-section">
          <div class="sd-section-title">Border Radius</div>
          <div class="sd-slider-row">
            <div class="sd-label">Card Radius</div>
            <div class="sd-slider-wrap">
              <input type="range" class="sd-slider" id="sl-radius" min="0" max="20" value="10"/>
              <span class="sd-slider-val" id="sl-radius-val">10px</span>
            </div>
          </div>
        </div>

      </div>
      <!-- end sd-pane-ui -->

      <!-- ══ TAB 2: Integrations ══════════════════════════════════════════ -->
      <div id="sd-pane-integrations" style="display:none">

        <!-- Domiciles -->
        <div class="sd-section" id="sect-domiciles">
          <div class="sd-section-title">Domiciles</div>
          <div class="sd-field">
            <div class="sd-label">Managed domiciles (comma-separated)</div>
            <textarea id="settings-domiciles" class="settings__textarea sd-input" placeholder="ABE40, AVP40, AUVTE01..."></textarea>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary" id="save-domiciles">Save</button>
            <button class="sd-btn secondary" id="reset-domiciles">Reset defaults</button>
          </div>
          <div id="domicile-status" class="settings__status" style="display:none"></div>
        </div>

        <!-- Midway Auth -->
        <div class="sd-section" id="sect-auth">
          <div class="sd-section-title">Midway Auth</div>
          <div id="auth-status" class="sd-status warn">⏳ Checking...</div>
          <div class="sd-btn-row" style="margin-top:8px">
            <button class="sd-btn primary" id="auth-mwinit">Run mwinit</button>
            <button class="sd-btn secondary" id="auth-recheck">Re-check</button>
          </div>
        </div>

        <!-- Orcha Config -->
        <div class="sd-section" id="sect-orcha">
          <div class="sd-section-title">Orcha Config</div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">Mode</div>
              <select class="sd-select" id="orcha-mode">
                <option value="local">Local</option>
                <option value="remote">Remote</option>
              </select>
            </div>
            <div class="sd-field">
              <div class="sd-label">Host</div>
              <input class="sd-input" id="orcha-host" placeholder="localhost"/>
            </div>
            <div class="sd-field">
              <div class="sd-label">Port</div>
              <input class="sd-input" id="orcha-port" type="number" placeholder="4799"/>
            </div>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary" id="save-orcha">Save</button>
          </div>
        </div>

        <!-- Notifications -->
        <div class="sd-section" id="sect-notifications">
          <div class="sd-section-title">Notifications</div>
          <div class="sd-toggle-row">
            <span class="sd-toggle-label">OS notification on Midway auth failure</span>
            <input type="checkbox" id="notif-auth-fail" checked/>
          </div>
          <div class="sd-toggle-row">
            <span class="sd-toggle-label">OS notification on sync complete</span>
            <input type="checkbox" id="notif-sync-ok" checked/>
          </div>
          <div class="sd-toggle-row">
            <span class="sd-toggle-label">OS notification on sync error</span>
            <input type="checkbox" id="notif-sync-err" checked/>
          </div>
        </div>

        <!-- Credentials (keychain) -->
        <div class="sd-section" id="sect-creds">
          <div class="sd-section-title">Credentials (keychain)</div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">Key</div>
              <input class="sd-input" id="cred-key" placeholder="e.g. aap-password"/>
            </div>
            <div class="sd-field">
              <div class="sd-label">Value</div>
              <input class="sd-input" id="cred-val" type="password" placeholder="secret"/>
            </div>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary"    id="cred-save">Save Credential</button>
            <button class="sd-btn danger"     id="cred-delete">Delete Key</button>
          </div>
          <div id="cred-status" class="settings__status" style="display:none"></div>
          <div id="cred-list-wrap" class="settings-list-wrap" style="margin-top:10px">
            <div class="settings-list-label">Stored keys:</div>
            <div id="cred-list" class="settings-key-list"></div>
          </div>
        </div>

        <!-- Schedulers Config -->
        <div class="sd-section" style="border-top:1px solid var(--bdr);padding-top:14px;margin-top:4px">
          <div class="sd-section-title">Schedulers – Config</div>
          <div class="sd-field">
            <div class="sd-label">Sync interval (minutes)</div>
            <input class="sd-input" id="sched-interval" type="number" placeholder="15"/>
          </div>
          <div class="sd-field">
            <div class="sd-label">Default scheduler endpoint</div>
            <input class="sd-input" id="sched-endpoint" placeholder="https://..."/>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary" id="save-sched">Save</button>
          </div>
        </div>

        <!-- Vendor Portal Credentials -->
        <div class="sd-section" id="sect-vendor-creds">
          <div class="sd-section-title">Vendor Portal Credentials</div>
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">PACCAR (paccarpg.decisiv.net)</div>
            <div class="sd-row">
              <div class="sd-field">
                <div class="sd-label">Username</div>
                <input class="sd-input" id="paccar-user" placeholder="portal username"/>
              </div>
              <div class="sd-field">
                <div class="sd-label">Password</div>
                <input class="sd-input" id="paccar-pass" type="password" placeholder="(encrypted)"/>
              </div>
            </div>
            <div class="sd-btn-row">
              <button class="sd-btn primary" id="paccar-save">Save</button>
              <button class="sd-btn danger"  id="paccar-clear">Clear</button>
            </div>
            <div id="paccar-status" class="settings__status" style="display:none"></div>
          </div>
          <div>
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Volvo (volvopg.asist.decisiv.net)</div>
            <div class="sd-row">
              <div class="sd-field">
                <div class="sd-label">Username</div>
                <input class="sd-input" id="volvo-user" placeholder="portal username"/>
              </div>
              <div class="sd-field">
                <div class="sd-label">Password</div>
                <input class="sd-input" id="volvo-pass" type="password" placeholder="(encrypted)"/>
              </div>
            </div>
            <div class="sd-btn-row">
              <button class="sd-btn primary" id="volvo-save">Save</button>
              <button class="sd-btn danger"  id="volvo-clear">Clear</button>
            </div>
            <div id="volvo-status" class="settings__status" style="display:none"></div>
          </div>
        </div>

        <!-- Email SMTP -->
        <div class="sd-section" id="sect-email">
          <div class="sd-section-title">Email (SMTP)</div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">Host</div>
              <input class="sd-input" id="email-host" placeholder="smtp.corp.amazon.com"/>
            </div>
            <div class="sd-field">
              <div class="sd-label">Port</div>
              <input class="sd-input" id="email-port" type="number" placeholder="587"/>
            </div>
          </div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">From</div>
              <input class="sd-input" id="email-from" type="email" placeholder="you@amazon.com"/>
            </div>
            <div class="sd-field">
              <div class="sd-label">Username</div>
              <input class="sd-input" id="email-user" placeholder="LDAP user"/>
            </div>
          </div>
          <div class="sd-field">
            <div class="sd-label">Password</div>
            <input class="sd-input" id="email-pass" type="password" placeholder="(encrypted)"/>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary"    id="email-save">Save</button>
            <button class="sd-btn secondary"  id="email-test">Send test</button>
          </div>
          <div id="email-status" class="settings__status" style="display:none"></div>
        </div>

        <!-- Slack -->
        <div class="sd-section" id="sect-slack">
          <div class="sd-section-title">Slack</div>
          <div id="slack-status" class="sd-status warn" style="margin-bottom:8px">⚠️ Not connected</div>
          <div class="sd-btn-row">
            <button class="sd-btn primary"   id="slack-login">Sign in to Slack</button>
            <button class="sd-btn secondary" id="slack-recheck">Re-check</button>
          </div>
        </div>

        <!-- Asana -->
        <div class="sd-section" id="sect-asana">
          <div class="sd-section-title">Asana</div>
          <div class="sd-field">
            <div class="sd-label">Personal Access Token</div>
            <input class="sd-input" id="asana-pat" type="password" placeholder="0/xxxxxxxx"/>
          </div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">Workspace GID</div>
              <input class="sd-input" id="asana-workspace" placeholder="1234567890"/>
            </div>
            <div class="sd-field">
              <div class="sd-label">Project GID</div>
              <input class="sd-input" id="asana-project" placeholder="1234567890"/>
            </div>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary"   id="asana-save">Save</button>
            <button class="sd-btn secondary" id="asana-verify">Verify token</button>
          </div>
          <div id="asana-status" class="settings__status" style="display:none"></div>
        </div>

      </div>
      <!-- end sd-pane-integrations -->

      <!-- ══ TAB 3: Operators & SP ═════════════════════════════════════════ -->
      <div id="sd-pane-operators" style="display:none">

        <!-- Pane header -->
        <div class="ops-pane-header">
          <div class="ops-pane-header-left">
            <span class="ops-pane-title">Operators &amp; SharePoint</span>
            <span class="ops-pane-sub" id="ops-sync-meta">Run a sync to load operators</span>
          </div>
          <button class="ops-sync-btn" id="ops-sync-btn">↻ Sync Now</button>
        </div>

        <!-- Global Email SMTP (in Operators tab) -->
        <div class="sd-section">
          <div class="sd-section-title">
            Email – Global SMTP
            <span class="ops-autosave-badge" id="ops-email-badge"></span>
          </div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">Host</div>
              <input class="sd-input" id="ops-email-host" placeholder="smtp.corp.amazon.com"/>
            </div>
            <div class="sd-field">
              <div class="sd-label">Port</div>
              <input class="sd-input" id="ops-email-port" type="number" placeholder="587"/>
            </div>
          </div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">From address</div>
              <input class="sd-input" id="ops-email-from" type="email" placeholder="you@amazon.com"/>
            </div>
            <div class="sd-field">
              <div class="sd-label">Username</div>
              <input class="sd-input" id="ops-email-user" placeholder="LDAP / CORP\\user"/>
            </div>
          </div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">Password</div>
              <input class="sd-input" id="ops-email-pass" type="password" placeholder="(stored encrypted)"/>
            </div>
            <div class="sd-field" style="justify-content:flex-end;padding-top:18px">
              <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--txt2);cursor:pointer">
                <input type="checkbox" id="ops-email-tls" style="accent-color:var(--acc)"/> Use TLS
              </label>
            </div>
          </div>
          <div class="sd-btn-row" style="margin-top:4px">
            <button class="sd-btn secondary" id="ops-email-test-btn">Send test email</button>
            <div id="ops-email-test-form" style="display:none;gap:6px;align-items:center">
              <input class="sd-input" id="ops-email-test-to" type="email" placeholder="recipient@amazon.com" style="width:180px"/>
              <button class="sd-btn primary" id="ops-email-test-send">Send</button>
              <button class="sd-btn secondary" id="ops-email-test-cancel">Cancel</button>
            </div>
          </div>
        </div>

        <!-- SP section header -->
        <div class="ops-sp-section-header">
          <span class="ops-sp-section-label">SharePoint – Per Operator → Per Domicile</span>
          <span class="ops-sp-section-hint">Operators and domiciles populate automatically on sync</span>
        </div>

        <!-- Operator list (dynamic) -->
        <div class="ops-list" id="ops-list">
          <div class="ops-empty-state" id="ops-empty-state">
            <div class="ops-empty-icon">📋</div>
            <div class="ops-empty-title">No operators loaded yet</div>
            <div class="ops-empty-sub">Click <strong>↻ Sync Now</strong> above to pull operators and their domiciles from the fleet data source. SharePoint config will appear here automatically for each one.</div>
          </div>
        </div>

      </div>
      <!-- end sd-pane-operators -->

      <!-- ══ TAB 4: Accounts ════════════════════════════════════════════════ -->
      <div id="sd-pane-accounts" style="display:none">

        <!-- Header -->
        <div class="ops-pane-header">
          <div class="ops-pane-header-left">
            <span class="ops-pane-title">Accounts</span>
            <span class="ops-pane-sub">Site credentials – click a site name to open it</span>
          </div>
          <button class="ops-sync-btn" id="acct-add">+ Add account</button>
        </div>

        <!-- Account rows -->
        <div class="acct-list" id="acct-list">
          <div class="acct-empty" id="acct-empty">
            <span style="font-size:28px;opacity:.5">🔑</span>
            <div class="ops-empty-title">No accounts yet</div>
            <div class="ops-empty-sub">Click <strong>+ Add account</strong> to save a site credential.</div>
          </div>
        </div>

      </div>
      <!-- end sd-pane-accounts -->

    </div>
    <!-- end sd-body -->

  </div>
  <!-- end settings-drawer -->
  `;
}

// ── Tab switching ────────────────────────────────────────────────────────────
function _wireTabSwitching() {
  _drawer.querySelectorAll('.sd-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      _drawer.querySelectorAll('.sd-tab').forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      const pane = btn.dataset.pane;
      ['ui', 'integrations', 'operators', 'accounts'].forEach((p) => {
        const el = document.getElementById(`sd-pane-${p}`);
        if (el) el.style.display = p === pane ? 'block' : 'none';
      });
    });
  });
}

// ── Open / close ─────────────────────────────────────────────────────────────
function _open() {
  _drawer.classList.add('open');
  _overlay.classList.add('open');
  _populate();
}

function _close() {
  _drawer.classList.remove('open');
  _overlay.classList.remove('open');
}

// ── Section: Domiciles ───────────────────────────────────────────────────────
function _wireDomiciles() {
  document.getElementById('save-domiciles').addEventListener('click', async () => {
    const raw = document.getElementById('settings-domiciles').value;
    const codes = raw.split(',').map((s) => s.trim()).filter(Boolean);
    await settingsBridge.save('domiciles', codes);
    const st = document.getElementById('domicile-status');
    st.textContent = '✓ Saved'; st.style.display = 'block';
    setTimeout(() => { st.style.display = 'none'; }, 2000);
  });
  document.getElementById('reset-domiciles').addEventListener('click', async () => {
    await settingsBridge.save('domiciles', []);
    document.getElementById('settings-domiciles').value = '';
  });
}

// ── Section: Auth ────────────────────────────────────────────────────────────
function _checkAuth() {
  authBridge.checkMidway().then((ok) => {
    const el = document.getElementById('auth-status');
    if (!el) return;
    if (ok) {
      el.textContent = '✅ Authenticated';
      el.className = 'sd-status ok';
    } else {
      el.textContent = '⚠️ Not authenticated';
      el.className = 'sd-status warn';
    }
  }).catch(() => {});
}

function _wireAuth() {
  _checkAuth();
  document.getElementById('auth-recheck').addEventListener('click', _checkAuth);
  document.getElementById('auth-mwinit').addEventListener('click', () => {
    authBridge.runMwinit().then(() => _checkAuth()).catch(() => {});
  });
}

// ── Section: Orcha ───────────────────────────────────────────────────────────
function _wireOrcha() {
  document.getElementById('save-orcha').addEventListener('click', async () => {
    await settingsBridge.save('orcha', {
      mode: document.getElementById('orcha-mode').value,
      host: document.getElementById('orcha-host').value.trim(),
      port: parseInt(document.getElementById('orcha-port').value, 10) || 4799,
    });
    toast.show('success', 'Orcha config saved', 2000);
  });
}

// ── Section: Credentials ─────────────────────────────────────────────────────
function _loadCredsList() {
  credsBridge.list().then((keys) => {
    const el = document.getElementById('cred-list');
    if (!el) return;
    el.innerHTML = '';
    (keys || []).forEach((k) => {
      const pill = document.createElement('span');
      pill.className = 'settings-key-pill';
      pill.textContent = k;
      el.appendChild(pill);
    });
    const wrap = document.getElementById('cred-list-wrap');
    if (wrap) wrap.style.display = (keys && keys.length) ? 'block' : 'none';
  }).catch(() => {});
}

function _wireCreds() {
  _loadCredsList();
  document.getElementById('cred-save').addEventListener('click', async () => {
    const k = document.getElementById('cred-key').value.trim();
    const v = document.getElementById('cred-val').value;
    if (!k) return;
    await credsBridge.set(k, v);
    document.getElementById('cred-key').value = '';
    document.getElementById('cred-val').value = '';
    _loadCredsList();
    const st = document.getElementById('cred-status');
    st.textContent = '✓ Saved'; st.style.display = 'block';
    setTimeout(() => { st.style.display = 'none'; }, 2000);
  });
  document.getElementById('cred-delete').addEventListener('click', async () => {
    const k = document.getElementById('cred-key').value.trim();
    if (!k) return;
    await credsBridge.delete(k);
    document.getElementById('cred-key').value = '';
    _loadCredsList();
  });
}

// ── Section: Vendor Auth ─────────────────────────────────────────────────────
function _checkVendorCred(vendor, statusId) {
  settingsBridge.getAll().then((all) => {
    const st = document.getElementById(statusId);
    if (!st) return;
    const has = all && all[`${vendor}_user`];
    st.textContent = has ? `✅ Credentials saved` : '⚠️ Not configured';
    st.style.display = 'block';
    st.className = `settings__status settings__status--${has ? 'ok' : 'loading'}`;
  }).catch(() => {});
}

function _wireVendorAuth() {
  ['paccar', 'volvo'].forEach((v) => {
    _checkVendorCred(v, `${v}-status`);
    document.getElementById(`${v}-save`).addEventListener('click', async () => {
      await settingsBridge.save(`${v}_user`, document.getElementById(`${v}-user`).value.trim());
      await settingsBridge.save(`${v}_pass`, document.getElementById(`${v}-pass`).value);
      document.getElementById(`${v}-pass`).value = '';
      _checkVendorCred(v, `${v}-status`);
    });
    document.getElementById(`${v}-clear`).addEventListener('click', async () => {
      await settingsBridge.save(`${v}_user`, '');
      await settingsBridge.save(`${v}_pass`, '');
      document.getElementById(`${v}-user`).value = '';
      _checkVendorCred(v, `${v}-status`);
    });
  });
}

// ── Section: Slack ───────────────────────────────────────────────────────────
function _checkSlack() {
  slackBridge.checkAuth().then((ok) => {
    const el = document.getElementById('slack-status');
    if (!el) return;
    el.textContent = ok ? '✅ Connected' : '⚠️ Not connected';
    el.className = `sd-status ${ok ? 'ok' : 'warn'}`;
  }).catch(() => {});
}

function _wireSlack() {
  _checkSlack();
  document.getElementById('slack-recheck').addEventListener('click', _checkSlack);
  document.getElementById('slack-login').addEventListener('click', () => {
    slackBridge.login().then(() => _checkSlack()).catch(() => {});
  });
}

// ── Section: Email ───────────────────────────────────────────────────────────
function _wireEmail() {
  document.getElementById('email-save').addEventListener('click', async () => {
    await emailBridge.saveConfig({
      host: document.getElementById('email-host').value.trim(),
      port: parseInt(document.getElementById('email-port').value, 10) || 587,
      from: document.getElementById('email-from').value.trim(),
      user: document.getElementById('email-user').value.trim(),
      pass: document.getElementById('email-pass').value,
    });
    document.getElementById('email-pass').value = '';
    const st = document.getElementById('email-status');
    st.textContent = '✓ Saved'; st.style.display = 'block';
    setTimeout(() => { st.style.display = 'none'; }, 2000);
  });
  document.getElementById('email-test').addEventListener('click', () => {
    toast.show('info', 'Send test — not yet wired in bridge', 3000);
  });
}

// ── Section: SharePoint ───────────────────────────────────────────────────────
function _wireSP() {
  // Operators tab sync button
  document.getElementById('ops-sync-btn').addEventListener('click', () => {
    bus.emit('ui:toast', { type: 'info', message: 'Syncing operators...', duration: 2000 });
    bus.emit('sp:sync-request');
  });

  // Ops email auto-save fields
  ['ops-email-host','ops-email-port','ops-email-from','ops-email-user','ops-email-pass','ops-email-tls'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => _opsEmailAutoSave());
    el.addEventListener('input',  () => _opsEmailAutoSave());
  });

  // Test email inline form
  document.getElementById('ops-email-test-btn').addEventListener('click', () => {
    document.getElementById('ops-email-test-btn').style.display = 'none';
    document.getElementById('ops-email-test-form').style.display = 'flex';
  });
  document.getElementById('ops-email-test-cancel').addEventListener('click', () => {
    document.getElementById('ops-email-test-btn').style.display = 'flex';
    document.getElementById('ops-email-test-form').style.display = 'none';
  });
  document.getElementById('ops-email-test-send').addEventListener('click', () => {
    const to = document.getElementById('ops-email-test-to').value.trim();
    if (!to) return;
    toast.show('info', 'Send test — not yet wired in bridge', 3000);
  });

  // Pre-populate ops-email fields from saved config
  spBridge.getConfig().then((cfg) => {
    if (!cfg) return;
    if (cfg.emailHost) { const el = document.getElementById('ops-email-host'); if (el) el.value = cfg.emailHost; }
    if (cfg.emailPort) { const el = document.getElementById('ops-email-port'); if (el) el.value = cfg.emailPort; }
    if (cfg.emailFrom) { const el = document.getElementById('ops-email-from'); if (el) el.value = cfg.emailFrom; }
    if (cfg.emailUser) { const el = document.getElementById('ops-email-user'); if (el) el.value = cfg.emailUser; }
    if (cfg.emailTls  != null) { const el = document.getElementById('ops-email-tls');  if (el) el.checked = cfg.emailTls; }
  }).catch(() => {});

  // Listen for operators data pushed from main process
  bus.on('state:operators', (data) => {
    // Load SP config first, then render with saved values pre-filled
    spBridge.getConfig().then((cfg) => {
      _renderOperators(data, cfg || {});
      const meta = document.getElementById('ops-sync-meta');
      if (meta) meta.textContent = `${data.length} operator${data.length !== 1 ? 's' : ''} loaded`;
    }).catch(() => {
      _renderOperators(data, {});
    });
  });
}

// ── SP: ops-email auto-save ───────────────────────────────────────────────────
const _opsEmailTimers = {};
function _opsEmailAutoSave() {
  const badge = document.getElementById('ops-email-badge');
  if (badge) { badge.textContent = 'saving...'; badge.className = 'ops-autosave-badge saving'; }
  clearTimeout(_opsEmailTimers.main);
  _opsEmailTimers.main = setTimeout(async () => {
    // Merge email fields into existing SP config so we don't clobber domicile entries
    const existing = await spBridge.getConfig().catch(() => ({})) || {};
    await spBridge.saveConfig({
      ...existing,
      emailHost: document.getElementById('ops-email-host').value.trim(),
      emailPort: parseInt(document.getElementById('ops-email-port').value, 10) || 587,
      emailFrom: document.getElementById('ops-email-from').value.trim(),
      emailUser: document.getElementById('ops-email-user').value.trim(),
      emailPass: document.getElementById('ops-email-pass').value,
      emailTls:  document.getElementById('ops-email-tls').checked,
    }).catch(() => {});
    if (badge) {
      badge.textContent = '✓ saved'; badge.className = 'ops-autosave-badge saved';
      setTimeout(() => { badge.textContent = ''; badge.className = 'ops-autosave-badge'; }, 3000);
    }
  }, 800);
}

// ── SP: per-domicile save helper ──────────────────────────────────────────────
// cfg shape: { domiciles: { [opName_domCode]: { siteUrl, listName } }, emailHost, ... }
async function _spSaveDomicile(opName, domCode, siteUrl, listName) {
  const existing = await spBridge.getConfig().catch(() => ({})) || {};
  const domiciles = existing.domiciles || {};
  const key = `${opName}__${domCode}`;
  domiciles[key] = { siteUrl, listName };
  return spBridge.saveConfig({ ...existing, domiciles });
}

// ── SP: render operator accordion cards ──────────────────────────────────────
function _renderOperators(data, spCfg) {
  const list  = document.getElementById('ops-list');
  const empty = document.getElementById('ops-empty-state');
  if (!list) return;

  if (!data || data.length === 0) {
    if (empty) empty.style.display = 'flex';
    return;
  }
  if (empty) empty.style.display = 'none';

  // Clear existing cards, keep empty-state node
  [...list.querySelectorAll('.ops-card')].forEach((c) => c.remove());

  const savedDoms   = (spCfg && spCfg.domiciles) ? spCfg.domiciles : {};
  const savedEmails = (spCfg && spCfg.emails)    ? spCfg.emails    : {};

  data.forEach((op) => {
    const card = document.createElement('div');
    card.className = 'ops-card';

    // ── Header ──
    const header = document.createElement('div');
    header.className = 'ops-card-header';
    header.innerHTML = `
      <div class="ops-card-dot" style="background:var(--acc)"></div>
      <span class="ops-card-name">${_esc(op.name)}</span>
      <span class="ops-card-meta">${(op.domiciles || []).length} domicile(s)</span>
      <span class="ops-card-arrow">›</span>`;
    card.appendChild(header);

    // ── Body ──
    const body = document.createElement('div');
    body.className = 'ops-card-body';
    body.style.display = 'none';

    (op.domiciles || []).forEach((d) => {
      const key        = `${op.name}__${d.code}`;
      const savedSP    = savedDoms[key]   || {};
      const savedEmail = savedEmails[key] || {};

      const siteVal    = savedSP.siteUrl  || d.spSite || '';
      const listVal    = savedSP.listName || '';
      const toVal      = savedEmail.to    || d.emailTo  || '';
      const ccVal      = savedEmail.cc    || d.emailCc  || '';

      const domEl = document.createElement('div');
      domEl.className = 'ops-domicile';

      // Status pills
      const spStatusCls = siteVal ? 'ok'   : 'warn';
      const spStatusTxt = siteVal ? '✓ SP' : '⚠ SP';
      const emStatusCls = toVal   ? 'ok'   : 'warn';
      const emStatusTxt = toVal   ? '✓ Email' : '⚠ Email';

      domEl.innerHTML = `
        <div class="ops-dom-header">
          <span class="ops-dom-tag">${_esc(d.code)}</span>
          <span class="ops-dom-count">${d.count || 0} unit(s)</span>
          <span class="ops-dom-sp-status ${spStatusCls}" data-sp-status>${spStatusTxt}</span>
          <span class="ops-dom-sp-status ${emStatusCls}" data-em-status style="margin-left:4px">${emStatusTxt}</span>
        </div>

        <div class="ops-sp-fields">
          <div class="sd-section-label">SharePoint</div>
          <div class="sd-field">
            <div class="sd-label">Site URL</div>
            <input class="sd-input ops-sp-site" placeholder="https://amazon.sharepoint.com/sites/..." value="${_esc(siteVal)}"/>
          </div>
          <div class="sd-field">
            <div class="sd-label-row sd-label">
              List / Sheet
              <button class="ops-load-btn" type="button">Load lists</button>
            </div>
            <select class="sd-select ops-sp-list">
              <option value="">— select list —</option>
              ${listVal ? `<option value="${_esc(listVal)}" selected>${_esc(listVal)}</option>` : ''}
            </select>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary ops-sp-save" type="button">Save SP</button>
            <button class="sd-btn secondary ops-sp-push" type="button">Push now</button>
            <span class="ops-autosave-badge ops-sp-badge"></span>
          </div>
        </div>

        <div class="ops-email-fields" style="margin-top:10px">
          <div class="sd-section-label">Email recipients</div>
          <div class="sd-field">
            <div class="sd-label">To <span class="sd-label-hint">(semicolon-separated)</span></div>
            <input class="sd-input ops-em-to" type="email" multiple placeholder="manager@amazon.com;dsp@email.com" value="${_esc(toVal)}"/>
          </div>
          <div class="sd-field">
            <div class="sd-label">CC <span class="sd-label-hint">(optional)</span></div>
            <input class="sd-input ops-em-cc" type="email" multiple placeholder="cc@amazon.com" value="${_esc(ccVal)}"/>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary ops-em-save" type="button">Save email</button>
            <span class="ops-autosave-badge ops-em-badge"></span>
          </div>
        </div>`;

      // ── SP: Save button ──
      domEl.querySelector('.ops-sp-save').addEventListener('click', async () => {
        const badge    = domEl.querySelector('.ops-sp-badge');
        const siteUrl  = domEl.querySelector('.ops-sp-site').value.trim();
        const listName = domEl.querySelector('.ops-sp-list').value;
        badge.textContent = 'saving...'; badge.className = 'ops-autosave-badge saving';
        try {
          await _spSaveDomicile(op.name, d.code, siteUrl, listName);
          const pill = domEl.querySelector('[data-sp-status]');
          if (pill) {
            pill.textContent = siteUrl ? '✓ SP' : '⚠ SP';
            pill.className   = `ops-dom-sp-status ${siteUrl ? 'ok' : 'warn'}`;
          }
          badge.textContent = '✓ saved'; badge.className = 'ops-autosave-badge saved';
          setTimeout(() => { badge.textContent = ''; badge.className = 'ops-autosave-badge'; }, 2500);
        } catch (e) {
          badge.textContent = '✗ error'; badge.className = 'ops-autosave-badge saving';
          setTimeout(() => { badge.textContent = ''; badge.className = 'ops-autosave-badge'; }, 3000);
        }
      });

      // ── SP: Push now button ──
      domEl.querySelector('.ops-sp-push').addEventListener('click', async () => {
        const siteUrl = domEl.querySelector('.ops-sp-site').value.trim();
        const pushBtn = domEl.querySelector('.ops-sp-push');
        const saveBtn = domEl.querySelector('.ops-sp-save');
        const badge   = domEl.querySelector('.ops-sp-badge');

        if (!siteUrl) {
          toast.show('warn', `${d.code}: set a SharePoint URL before pushing`, 3000);
          return;
        }

        pushBtn.disabled = true;
        saveBtn.disabled = true;
        pushBtn.textContent = 'Pushing...';
        badge.textContent = 'connecting...';
        badge.className = 'ops-autosave-badge saving';

        const unsubProgress = bus.on('sp:progress', ({ message }) => {
          badge.textContent = message.length > 38 ? message.slice(0, 35) + '...' : message;
        });

        try {
          const result = await spBridge.pushDomicile({ opName: op.name, domCode: d.code });
          unsubProgress();
          if (!result || result.ok === false) {
            const msg = (result && result.error) || 'Push failed';
            badge.textContent = `✗ ${msg}`; badge.className = 'ops-autosave-badge saving';
            toast.show('error', `${d.code}: ${msg}`, 5000);
          } else {
            const summary = `✓ ${result.pushed || 0} new · ${result.updated || 0} updated`;
            badge.textContent = summary; badge.className = 'ops-autosave-badge saved';
            toast.show('info', `${d.code} pushed — ${summary.replace('✓ ', '')}`, 4000);
          }
          setTimeout(() => { badge.textContent = ''; badge.className = 'ops-autosave-badge'; }, 5000);
        } catch (e) {
          unsubProgress();
          badge.textContent = '✗ error'; badge.className = 'ops-autosave-badge saving';
          toast.show('error', `${d.code} push error: ${e.message || e}`, 5000);
          setTimeout(() => { badge.textContent = ''; badge.className = 'ops-autosave-badge'; }, 5000);
        } finally {
          pushBtn.disabled = false;
          saveBtn.disabled = false;
          pushBtn.textContent = 'Push now';
        }
      });

      // ── SP: Load lists button ──
      domEl.querySelector('.ops-load-btn').addEventListener('click', async () => {
        const siteUrl = domEl.querySelector('.ops-sp-site').value.trim();
        const loadBtn = domEl.querySelector('.ops-load-btn');
        const select  = domEl.querySelector('.ops-sp-list');
        const curVal  = select.value;

        if (!siteUrl) { toast.show('warn', 'Enter a SharePoint Site URL first', 2500); return; }

        loadBtn.disabled = true;
        loadBtn.textContent = 'Loading...';
        try {
          const lists = await spBridge.getLists(siteUrl);
          if (!lists || lists.error) {
            toast.show('error', `Could not load lists: ${(lists && lists.error) || 'unknown error'}`, 4000);
            return;
          }
          if (!lists.length) { toast.show('warn', 'No lists found for this site', 3000); return; }
          select.innerHTML = '<option value="">— select list —</option>';
          lists.forEach(({ title }) => {
            const opt = document.createElement('option');
            opt.value = title; opt.textContent = title;
            if (title === curVal) opt.selected = true;
            select.appendChild(opt);
          });
          toast.show('info', `${lists.length} list${lists.length !== 1 ? 's' : ''} loaded`, 2000);
        } catch (e) {
          toast.show('error', `Load lists failed: ${e.message || e}`, 4000);
        } finally {
          loadBtn.disabled = false;
          loadBtn.textContent = 'Load lists';
        }
      });

      // ── SP: Site URL pill update live ──
      domEl.querySelector('.ops-sp-site').addEventListener('input', function () {
        const pill = domEl.querySelector('[data-sp-status]');
        if (pill) {
          const has = !!this.value.trim();
          pill.textContent = has ? '✓ SP' : '⚠ SP';
          pill.className   = `ops-dom-sp-status ${has ? 'ok' : 'warn'}`;
        }
      });

      // ── Email: Save button ──
      domEl.querySelector('.ops-em-save').addEventListener('click', async () => {
        const badge = domEl.querySelector('.ops-em-badge');
        const to    = domEl.querySelector('.ops-em-to').value.trim();
        const cc    = domEl.querySelector('.ops-em-cc').value.trim();
        badge.textContent = 'saving...'; badge.className = 'ops-autosave-badge saving';
        try {
          await _spSaveEmail(op.name, d.code, to, cc);
          const pill = domEl.querySelector('[data-em-status]');
          if (pill) {
            pill.textContent = to ? '✓ Email' : '⚠ Email';
            pill.className   = `ops-dom-sp-status ${to ? 'ok' : 'warn'}`;
          }
          badge.textContent = '✓ saved'; badge.className = 'ops-autosave-badge saved';
          setTimeout(() => { badge.textContent = ''; badge.className = 'ops-autosave-badge'; }, 2500);
        } catch (e) {
          badge.textContent = '✗ error'; badge.className = 'ops-autosave-badge saving';
          setTimeout(() => { badge.textContent = ''; badge.className = 'ops-autosave-badge'; }, 3000);
        }
      });

      // ── Email: To input pill update live ──
      domEl.querySelector('.ops-em-to').addEventListener('input', function () {
        const pill = domEl.querySelector('[data-em-status]');
        if (pill) {
          const has = !!this.value.trim();
          pill.textContent = has ? '✓ Email' : '⚠ Email';
          pill.className   = `ops-dom-sp-status ${has ? 'ok' : 'warn'}`;
        }
      });

      body.appendChild(domEl);
    });

    card.appendChild(body);

    // ── Accordion toggle ──
    header.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      header.querySelector('.ops-card-arrow').style.transform = open ? '' : 'rotate(90deg)';
    });

    list.appendChild(card);
  });
}

// ── SP: per-domicile email save helper ───────────────────────────────────────
async function _spSaveEmail(opName, domCode, to, cc) {
  const existing = await spBridge.getConfig().catch(() => ({})) || {};
  const emails   = existing.emails || {};
  const key      = `${opName}__${domCode}`;
  emails[key]    = { to, cc };
  return spBridge.saveConfig({ ...existing, emails });
}


// ── Section: Asana ───────────────────────────────────────────────────────────
function _wireAsana() {
  document.getElementById('asana-save').addEventListener('click', async () => {
    await asanaBridge.saveConfig({
      pat:       document.getElementById('asana-pat').value,
      workspace: document.getElementById('asana-workspace').value.trim(),
      project:   document.getElementById('asana-project').value.trim(),
    });
    document.getElementById('asana-pat').value = '';
    const st = document.getElementById('asana-status');
    st.textContent = '✓ Saved'; st.style.display = 'block';
    setTimeout(() => { st.style.display = 'none'; }, 2000);
  });
  document.getElementById('asana-verify').addEventListener('click', () => {
    asanaBridge.checkAuth().then((ok) => {
      const st = document.getElementById('asana-status');
      st.textContent = ok ? '✅ Token valid' : '❌ Token invalid';
      st.style.display = 'block';
    }).catch(() => {});
  });
}

// ── Section: Notifications ───────────────────────────────────────────────────
function _wireNotifications() {
  // No-op on change — preferences stored in _populate / settingsBridge
  ['notif-auth-fail','notif-sync-ok','notif-sync-err'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      settingsBridge.save('notifications', {
        authFail:  document.getElementById('notif-auth-fail').checked,
        syncOk:    document.getElementById('notif-sync-ok').checked,
        syncErr:   document.getElementById('notif-sync-err').checked,
      }).catch(() => {});
    });
  });
}

// ── Section: Accounts (S11) ──────────────────────────────────────────────────
function _wireAccounts() {
  settingsBridge.getAll().then((all) => {
    const rows = (all && Array.isArray(all.accounts)) ? all.accounts : [];
    if (rows.length > 0) {
      const empty = document.getElementById('acct-empty');
      if (empty) empty.style.display = 'none';
      rows.forEach((r) => _acctAddRow(r));
    }
  }).catch(() => {});

  document.getElementById('acct-add').addEventListener('click', () => {
    _acctAddRow();
    const list = document.getElementById('acct-list');
    if (list && list.lastElementChild) {
      const inp = list.lastElementChild.querySelector('.acct-input.acct-name');
      if (inp) inp.focus();
    }
  });
}

function _acctAddRow(prefill = {}) {
  const empty = document.getElementById('acct-empty');
  if (empty) empty.style.display = 'none';

  const list = document.getElementById('acct-list');
  const id   = 'acct-' + Date.now();
  const row  = document.createElement('div');
  row.className = 'acct-row';
  row.id = id;

  const url  = prefill.url  || '';
  const name = prefill.name || '';
  const user = prefill.user || '';

  row.innerHTML = `
    <div class="acct-cell acct-cell-site">
      <input class="acct-input acct-url"  type="url"  placeholder="https://..."     value="${_esc(url)}"  title="Site URL"/>
      <input class="acct-input acct-name" type="text" placeholder="Site name"       value="${_esc(name)}" title="Display name"/>
      <a class="acct-link" href="${_esc(url) || '#'}" title="Open site" style="${url ? '' : 'display:none'}" target="_blank">🔗</a>
    </div>
    <div class="acct-cell acct-cell-user">
      <input class="acct-input" type="text" placeholder="username / email" value="${_esc(user)}"/>
    </div>
    <div class="acct-cell acct-cell-pass">
      <input class="acct-input acct-pass" type="password" placeholder="password"/>
      <button class="acct-eye" type="button" title="Show/hide">👁️</button>
    </div>
    <div class="acct-cell acct-cell-actions">
      <span class="acct-save-badge" id="badge-${id}"></span>
      <button class="acct-del" type="button" title="Remove">🗑</button>
    </div>`;

  row.querySelector('.acct-url').addEventListener('input', function () {
    const link = row.querySelector('.acct-link');
    const v = this.value.trim();
    link.href = v || '#';
    link.style.display = v ? '' : 'none';
    _acctAutoSave(row);
  });
  row.querySelectorAll('.acct-input.acct-name, .acct-cell-user .acct-input').forEach((inp) => {
    inp.addEventListener('input', () => _acctAutoSave(row));
  });
  row.querySelector('.acct-pass').addEventListener('input', () => _acctAutoSave(row));
  row.querySelector('.acct-eye').addEventListener('click', function () {
    const inp = row.querySelector('.acct-pass');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    this.textContent = inp.type === 'password' ? '👁️' : '🙈';
  });
  row.querySelector('.acct-del').addEventListener('click', () => {
    row.remove();
    if (!document.querySelectorAll('#acct-list .acct-row').length) {
      const e = document.getElementById('acct-empty');
      if (e) e.style.display = 'flex';
    }
    _acctPersist();
  });

  list.appendChild(row);
}

const _acctTimers = {};
function _acctAutoSave(row) {
  const badge = row.querySelector('.acct-save-badge');
  if (badge) { badge.textContent = 'saving...'; badge.className = 'acct-save-badge saving'; }
  clearTimeout(_acctTimers[row.id]);
  _acctTimers[row.id] = setTimeout(() => {
    _acctPersist();
    if (badge) {
      badge.textContent = '✅'; badge.className = 'acct-save-badge saved';
      setTimeout(() => { badge.textContent = ''; badge.className = 'acct-save-badge'; }, 2000);
    }
  }, 700);
}

function _acctPersist() {
  const rows = [...document.querySelectorAll('#acct-list .acct-row')].map((r) => ({
    name: (r.querySelector('.acct-name')?.value || '').trim(),
    url:  (r.querySelector('.acct-url')?.value  || '').trim(),
    user: (r.querySelector('.acct-cell-user .acct-input')?.value || '').trim(),
  })).filter((r) => r.name || r.url || r.user);
  settingsBridge.save('accounts', rows).catch(() => {});
}

// ── UI Tab: theme / color / font / slider wiring ─────────────────────────────
function _wireUITab() {
  // ── Template cards ──────────────────────────────────────────────────────
  _drawer.querySelectorAll('.sd-template').forEach((card) => {
    card.addEventListener('click', () => {
      _drawer.querySelectorAll('.sd-template').forEach((c) => {
        c.classList.remove('active');
        c.querySelector('.sd-tpl-check').style.display = 'none';
      });
      card.classList.add('active');
      card.querySelector('.sd-tpl-check').style.display = '';
      const theme = card.dataset.theme;
      document.body.classList.remove('light-mode','midnight-mode','ocean-mode');
      if (theme !== 'dark') document.body.classList.add(`${theme}-mode`);
      _saveUI();
    });
  });

  // ── Color swatches ──────────────────────────────────────────────────────
  _drawer.querySelectorAll('.sd-swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      const cssVar = sw.dataset.var;
      if (!cssVar) return;
      _drawer.querySelectorAll(`.sd-swatch[data-var="${cssVar}"]`).forEach((s) => s.classList.remove('active'));
      sw.classList.add('active');
      document.documentElement.style.setProperty(cssVar, sw.style.background);
      _saveUI();
    });
  });

  // ── Custom color pickers ────────────────────────────────────────────────
  _drawer.querySelectorAll('.sd-color-custom').forEach((inp) => {
    inp.addEventListener('input', () => {
      if (inp.dataset.var) document.documentElement.style.setProperty(inp.dataset.var, inp.value);
      _saveUI();
    });
  });

  // ── Sliders ─────────────────────────────────────────────────────────────
  const sliders = [
    { id: 'sl-opacity', valId: 'sl-opacity-val', suffix: '%' },
    { id: 'sl-blur',    valId: 'sl-blur-val',    suffix: 'px' },
    { id: 'sl-speed',   valId: 'sl-speed-val',   suffix: 'ms', cssVar: '--sd-speed' },
    { id: 'sl-radius',  valId: 'sl-radius-val',  suffix: 'px', cssVar: '--r' },
  ];
  sliders.forEach(({ id, valId, suffix, cssVar }) => {
    const el = document.getElementById(id);
    const vl = document.getElementById(valId);
    if (!el || !vl) return;
    el.addEventListener('input', () => {
      vl.textContent = el.value + suffix;
      if (cssVar) document.documentElement.style.setProperty(cssVar, el.value + suffix);
      _saveUI();
    });
  });

  // ── Font buttons ────────────────────────────────────────────────────────
  _drawer.querySelectorAll('.sd-font-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      _drawer.querySelectorAll('.sd-font-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const fontMap = {
        system: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        serif:  'Georgia,serif',
        mono:   '"SFMono-Regular",Consolas,"Liberation Mono",monospace',
        inter:  '"Inter",sans-serif',
      };
      document.documentElement.style.setProperty('--font', fontMap[btn.dataset.font] || fontMap.system);
      _saveUI();
    });
  });

  // ── Compact toggle ──────────────────────────────────────────────────────
  const compact = document.getElementById('toggle-compact');
  if (compact) compact.addEventListener('change', _saveUI);
}

// ── Collect UI prefs and persist (debounced 400ms) ──────────────────────────
let _saveUITimer = null;
function _saveUI() {
  clearTimeout(_saveUITimer);
  _saveUITimer = setTimeout(() => {
    // Theme: which body class is active
    let theme = 'dark';
    if (document.body.classList.contains('light-mode'))    theme = 'light';
    if (document.body.classList.contains('midnight-mode')) theme = 'midnight';
    if (document.body.classList.contains('ocean-mode'))    theme = 'ocean';

    // Active swatch per CSS var (store the background color value)
    const swatchVars = ['--acc', '--bg', '--panel', '--txt'];
    const swatches = {};
    swatchVars.forEach((v) => {
      const active = _drawer.querySelector(`.sd-swatch.active[data-var="${v}"]`);
      if (active) swatches[v] = active.style.background;
    });

    // Slider values
    const sliderIds = ['sl-opacity', 'sl-blur', 'sl-speed', 'sl-radius'];
    const sliders = {};
    sliderIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) sliders[id] = el.value;
    });

    // Active font
    const fontBtn = _drawer.querySelector('.sd-font-btn.active');
    const font = fontBtn ? fontBtn.dataset.font : 'system';

    // Compact toggle
    const compact = document.getElementById('toggle-compact');
    const compactRows = compact ? compact.checked : false;

    settingsBridge.save('ui_prefs', { theme, swatches, sliders, font, compactRows })
      .catch(() => {});
  }, 400);
}

// ── Apply saved UI prefs to DOM + CSS vars ───────────────────────────────────
function _applyUI(prefs) {
  if (!prefs) return;

  const fontMap = {
    system: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    serif:  'Georgia,serif',
    mono:   '"SFMono-Regular",Consolas,"Liberation Mono",monospace',
    inter:  '"Inter",sans-serif',
  };

  // Theme class on body
  if (prefs.theme) {
    document.body.classList.remove('light-mode','midnight-mode','ocean-mode');
    if (prefs.theme !== 'dark') document.body.classList.add(`${prefs.theme}-mode`);
    // Sync active card in drawer
    _drawer.querySelectorAll('.sd-template').forEach((card) => {
      const active = card.dataset.theme === prefs.theme;
      card.classList.toggle('active', active);
      card.querySelector('.sd-tpl-check').style.display = active ? '' : 'none';
    });
  }

  // Color swatches + CSS vars
  if (prefs.swatches) {
    Object.entries(prefs.swatches).forEach(([cssVar, color]) => {
      document.documentElement.style.setProperty(cssVar, color);
      // Mark matching swatch active
      _drawer.querySelectorAll(`.sd-swatch[data-var="${cssVar}"]`).forEach((sw) => {
        sw.classList.toggle('active', sw.style.background === color);
      });
    });
  }

  // Sliders
  if (prefs.sliders) {
    const sliderMeta = [
      { id: 'sl-opacity', valId: 'sl-opacity-val', suffix: '%' },
      { id: 'sl-blur',    valId: 'sl-blur-val',    suffix: 'px' },
      { id: 'sl-speed',   valId: 'sl-speed-val',   suffix: 'ms', cssVar: '--sd-speed' },
      { id: 'sl-radius',  valId: 'sl-radius-val',  suffix: 'px', cssVar: '--r' },
    ];
    sliderMeta.forEach(({ id, valId, suffix, cssVar }) => {
      const val = prefs.sliders[id];
      if (val == null) return;
      const el = document.getElementById(id);
      const vl = document.getElementById(valId);
      if (el) el.value = val;
      if (vl) vl.textContent = val + suffix;
      if (cssVar) document.documentElement.style.setProperty(cssVar, val + suffix);
    });
  }

  // Font
  if (prefs.font) {
    _drawer.querySelectorAll('.sd-font-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.font === prefs.font);
    });
    document.documentElement.style.setProperty('--font', fontMap[prefs.font] || fontMap.system);
  }

  // Compact toggle
  if (prefs.compactRows != null) {
    const compact = document.getElementById('toggle-compact');
    if (compact) compact.checked = prefs.compactRows;
  }
}

// ── Populate fields on open ──────────────────────────────────────────────────
function _populate() {
  settingsBridge.getAll().then((all) => {
    if (!all) return;

    // UI prefs (theme, colors, sliders, font)
    if (all.ui_prefs) _applyUI(all.ui_prefs);

    if (all.domiciles) {
      const el = document.getElementById('settings-domiciles');
      if (el) el.value = Array.isArray(all.domiciles) ? all.domiciles.join(', ') : all.domiciles;
    }
    if (all.orcha) {
      const o = all.orcha;
      const mode = document.getElementById('orcha-mode');
      const host = document.getElementById('orcha-host');
      const port = document.getElementById('orcha-port');
      if (mode && o.mode) mode.value = o.mode;
      if (host && o.host) host.value = o.host;
      if (port && o.port) port.value = o.port;
    }
    if (all.email) {
      const e = all.email;
      ['host','port','from','user'].forEach((f) => {
        const el = document.getElementById(`email-${f}`);
        if (el && e[f] != null) el.value = e[f];
      });
    }
    if (all.asana) {
      const a = all.asana;
      if (a.workspace) { const el = document.getElementById('asana-workspace'); if (el) el.value = a.workspace; }
      if (a.project)   { const el = document.getElementById('asana-project');   if (el) el.value = a.project;   }
    }
    if (all.notifications) {
      const n = all.notifications;
      const af = document.getElementById('notif-auth-fail');
      const so = document.getElementById('notif-sync-ok');
      const se = document.getElementById('notif-sync-err');
      if (af && n.authFail != null) af.checked = n.authFail;
      if (so && n.syncOk   != null) so.checked = n.syncOk;
      if (se && n.syncErr  != null) se.checked = n.syncErr;
    }
  }).catch(() => {});
}

// ── Apply saved UI prefs on cold boot (before drawer ever opens) ─────────────
export function applyBootPrefs() {
  settingsBridge.getAll().then((all) => {
    if (all && all.ui_prefs && _drawer) _applyUI(all.ui_prefs);
  }).catch(() => {});
}

// ── Escape HTML attr values ──────────────────────────────────────────────────
function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

// ── Export: init ──────────────────────────────────────────────────────────────
export function init() {
  // Inject drawer HTML into body
  const wrap = document.createElement('div');
  wrap.id = 'settings-drawer-wrap';
  wrap.innerHTML = _html();
  document.body.appendChild(wrap);

  _drawer  = document.getElementById('settings-drawer');
  _overlay = document.getElementById('sd-overlay');

  // Wire close
  document.getElementById('sd-close-btn').addEventListener('click', _close);
  _overlay.addEventListener('click', _close);

  // Wire tabs
  _wireTabSwitching();

  // Wire UI tab controls
  _wireUITab();

  // Wire all integration sections
  _wireDomiciles();
  _wireAuth();
  _wireOrcha();
  _wireCreds();
  _wireVendorAuth();
  _wireSlack();
  _wireEmail();
  _wireSP();
  _wireAsana();
  _wireNotifications();
  _wireAccounts();

  // Listen for settings open request
  bus.on('ui:view-change', ({ to }) => {
    if (to === 'settings') _open();
  });
}
