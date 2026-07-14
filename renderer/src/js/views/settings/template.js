// settings/template.js — Settings drawer HTML template
// Extracted from settings.js

export function _html() {
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

        <!-- Row Colors -->
        <div class="sd-section">
          <div class="sd-section-title">Row Colors</div>
          <div class="sd-color-row">
            <div class="sd-color-item">
              <div class="sd-label">Available Row</div>
              <div class="sd-color-swatch-row">
                <div class="sd-swatch active" style="background:rgba(126,231,135,.06)"  title="Subtle green" data-var="--row-avail"></div>
                <div class="sd-swatch"        style="background:rgba(126,231,135,.14)"  title="Green"        data-var="--row-avail"></div>
                <div class="sd-swatch"        style="background:rgba(88,166,255,.08)"   title="Blue"         data-var="--row-avail"></div>
                <div class="sd-swatch"        style="background:transparent"            title="None"         data-var="--row-avail"></div>
                <input type="color" class="sd-color-custom" value="#7ee787" title="Custom" data-var="--row-avail"/>
              </div>
            </div>
            <div class="sd-color-item">
              <div class="sd-label">Unavailable Row</div>
              <div class="sd-color-swatch-row">
                <div class="sd-swatch active" style="background:rgba(255,123,114,.06)"  title="Subtle red"   data-var="--row-unavail"></div>
                <div class="sd-swatch"        style="background:rgba(255,123,114,.14)"  title="Red"          data-var="--row-unavail"></div>
                <div class="sd-swatch"        style="background:rgba(255,166,87,.10)"   title="Orange"       data-var="--row-unavail"></div>
                <div class="sd-swatch"        style="background:transparent"            title="None"         data-var="--row-unavail"></div>
                <input type="color" class="sd-color-custom" value="#ff7b72" title="Custom" data-var="--row-unavail"/>
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

        <!-- Fleet Intelligence (S28) -->
        <div class="sd-section">
          <div class="sd-section-title">Fleet Intelligence</div>
          <div class="sd-slider-row">
            <div class="sd-label">SLA Target (days)</div>
            <div class="sd-slider-wrap">
              <input type="range" class="sd-slider" id="sl-sla-target" min="2" max="14" value="5"/>
              <span class="sd-slider-val" id="sl-sla-target-val">5d</span>
            </div>
          </div>
          <div class="sd-toggle-row" style="margin-top:4px">
            <span class="sd-toggle-label" style="font-size:9px;color:var(--mut)">Units at vendor longer than this will trigger breach alerts</span>
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

        <!-- ═══ NEXUS THEME BUILDER (Year 3030) ═══ -->
        <div class="sd-section" id="sect-nexus-theme">
          <div class="sd-section-title" style="display:flex;align-items:center;gap:8px">
            <span style="font-size:14px">🌌</span> Nexus Theme Engine
            <span style="font-size:8px;color:var(--nx-accent,#00d4ff);font-weight:700;background:var(--nx-accent-dim,rgba(0,212,255,.1));padding:2px 6px;border-radius:8px">3030</span>
          </div>

          <!-- Presets -->
          <div class="sd-field" style="margin-bottom:12px">
            <div class="sd-label">Preset</div>
            <div class="nx-preset-grid" id="nx-preset-grid">
              <button class="nx-preset-chip nx-preset-chip--active" data-preset="default">Default</button>
              <button class="nx-preset-chip" data-preset="void">Void</button>
              <button class="nx-preset-chip" data-preset="solar">Solar</button>
              <button class="nx-preset-chip" data-preset="arctic">Arctic</button>
              <button class="nx-preset-chip" data-preset="ember">Ember</button>
            </div>
          </div>

          <!-- Custom Accent -->
          <div class="sd-field" style="margin-bottom:12px">
            <div class="sd-label">Custom Accent Color</div>
            <div style="display:flex;align-items:center;gap:10px">
              <input type="color" id="nx-accent-picker" value="#00d4ff" class="nx-theme-builder__color"/>
              <span id="nx-accent-hex" style="font-family:var(--nx-mono);font-size:10px;color:var(--nx-text2)">#00d4ff</span>
              <button class="sd-btn secondary" id="nx-accent-reset" style="font-size:9px;padding:3px 8px">Reset</button>
            </div>
          </div>

          <!-- Density -->
          <div class="sd-field" style="margin-bottom:12px">
            <div class="sd-label">Density</div>
            <div style="display:flex;gap:6px">
              <button class="nx-preset-chip" data-density="compact">Compact</button>
              <button class="nx-preset-chip nx-preset-chip--active" data-density="default">Default</button>
              <button class="nx-preset-chip" data-density="spacious">Spacious</button>
            </div>
          </div>

          <!-- Blur -->
          <div class="sd-slider-row">
            <div class="sd-label">Glass Blur</div>
            <div class="sd-slider-wrap">
              <input type="range" class="sd-slider" id="nx-blur" min="0" max="40" value="20"/>
              <span class="sd-slider-val" id="nx-blur-val">20px</span>
            </div>
          </div>

          <!-- Animation Speed -->
          <div class="sd-slider-row" style="margin-top:8px">
            <div class="sd-label">Animation Speed</div>
            <div style="display:flex;gap:6px">
              <button class="nx-preset-chip" data-anim="off">Off</button>
              <button class="nx-preset-chip" data-anim="fast">Fast</button>
              <button class="nx-preset-chip nx-preset-chip--active" data-anim="default">Default</button>
              <button class="nx-preset-chip" data-anim="slow">Slow</button>
            </div>
          </div>

          <!-- Glow Intensity -->
          <div class="sd-slider-row" style="margin-top:10px">
            <div class="sd-label">Glow Intensity</div>
            <div class="sd-slider-wrap">
              <input type="range" class="sd-slider" id="nx-glow" min="0" max="200" value="100"/>
              <span class="sd-slider-val" id="nx-glow-val">100%</span>
            </div>
          </div>

          <!-- Toggles -->
          <div style="margin-top:12px;display:flex;flex-direction:column;gap:6px">
            <div class="sd-toggle-row"><span class="sd-toggle-label">Background Gradient</span><input type="checkbox" id="nx-bg-gradient" checked/></div>
            <div class="sd-toggle-row"><span class="sd-toggle-label">Grid Lines</span><input type="checkbox" id="nx-grid-lines" checked/></div>
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
            <button class="sd-btn secondary" id="test-orcha">Test Connection</button>
          </div>
          <div id="orcha-test-status" class="sd-inline-status" style="margin-top:6px;font-size:12px;"></div>
          <div style="display:none">
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
          <!-- PACCAR -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">PACCAR (paccarpg.decisiv.net)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="paccar-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="paccar-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="paccar-save">Save</button><button class="sd-btn danger" id="paccar-clear">Clear</button></div>
            <div id="paccar-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Volvo -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Volvo (volvopg.asist.decisiv.net)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="volvo-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="volvo-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="volvo-save">Save</button><button class="sd-btn danger" id="volvo-clear">Clear</button></div>
            <div id="volvo-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Record360 -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Record360 (dashboard.record360.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Email</div><input class="sd-input" id="record360-user" placeholder="you@amazon.com"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="record360-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="record360-save">Save</button><button class="sd-btn danger" id="record360-clear">Clear</button></div>
            <div id="record360-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Aperia / Halo -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Aperia / Halo Tire (amazon.aperiatech.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Email</div><input class="sd-input" id="aperia-user" placeholder="you@amazon.com"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="aperia-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="aperia-save">Save</button><button class="sd-btn danger" id="aperia-clear">Clear</button></div>
            <div id="aperia-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Reach24 -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Reach24 (amazon.reach24.net)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Email</div><input class="sd-input" id="reach24-user" placeholder="you@amazon.com"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="reach24-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="reach24-save">Save</button><button class="sd-btn danger" id="reach24-clear">Clear</button></div>
            <div id="reach24-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- DTNA -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">DTNA Service Tracker (dtna.my.site.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="dtna-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="dtna-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="dtna-save">Save</button><button class="sd-btn danger" id="dtna-clear">Clear</button></div>
            <div id="dtna-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Road Ready -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Road Ready (roadready.fadv.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="roadready-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="roadready-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="roadready-save">Save</button><button class="sd-btn danger" id="roadready-clear">Clear</button></div>
            <div id="roadready-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Velogic -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Velogic (velogic.my.site.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="velogic-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="velogic-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="velogic-save">Save</button><button class="sd-btn danger" id="velogic-clear">Clear</button></div>
            <div id="velogic-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Access Billing Services -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Access Billing Services (access-billing-services.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="abs-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="abs-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="abs-save">Save</button><button class="sd-btn danger" id="abs-clear">Clear</button></div>
            <div id="abs-status" class="settings__status" style="display:none"></div>
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

        <!-- Partner Forms -->
        <div class="sd-section" id="sect-forms">
          <div class="sd-section-title">Partner Work Request Forms</div>
          <div class="sd-field">
            <label class="sd-label">Google Sheets ID</label>
            <input class="sd-input" id="forms-sheet-id" placeholder="Paste Sheet ID from URL..." />
            <div class="sd-hint">From: docs.google.com/spreadsheets/d/<strong>[THIS ID]</strong>/edit</div>
          </div>
          <div class="sd-field">
            <label class="sd-label">Poll Interval</label>
            <select class="sd-select" id="forms-poll-interval">
              <option value="30">Every 30 seconds</option>
              <option value="60" selected>Every 60 seconds</option>
              <option value="120">Every 2 minutes</option>
              <option value="300">Every 5 minutes</option>
            </select>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary" id="forms-save">Save Forms Config</button>
            <button class="sd-btn secondary" id="forms-poll-now">Poll Now</button>
          </div>
          <div id="forms-status" class="sd-status" style="margin-top:8px;display:none"></div>
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
        <!-- Standalone SP Workbook Config -->
        <div class="sd-section" id="sect-sp-workbooks">
          <div class="sd-section-title">SharePoint Workbooks</div>
          <div class="sd-hint" style="margin-bottom:10px">Paste a SharePoint Excel URL → Load sheets → Pick sheet + operator → Save. The app will push fleet data to these workbooks.</div>
          <div class="sd-field">
            <div class="sd-label">SharePoint Excel URL</div>
            <input class="sd-input" id="sp-wb-url" placeholder="Paste SharePoint Excel file URL here..." style="width:100%" />
          </div>
          <div class="sd-btn-row" style="margin-top:6px">
            <button class="sd-btn primary" id="sp-wb-discover">Load sheets</button>
          </div>
          <div id="sp-wb-results" style="margin-top:10px;display:none">
            <div class="sd-field">
              <div class="sd-label">Sheets found:</div>
              <div id="sp-wb-sheets-list"></div>
            </div>
          </div>
          <div id="sp-wb-saved" style="margin-top:12px"></div>
        </div>



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
