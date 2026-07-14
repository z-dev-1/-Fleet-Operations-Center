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
import { setPreset, setTheme, getThemeConfig, resetTheme, PRESETS } from '../nexus-theme.js';

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
    await settingsBridge.saveDomiciles(codes);
    const st = document.getElementById('domicile-status');
    st.textContent = '✓ Saved'; st.style.display = 'block';
    setTimeout(() => { st.style.display = 'none'; }, 2000);
  });
  document.getElementById('reset-domiciles').addEventListener('click', async () => {
    await settingsBridge.saveDomiciles([]);
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


  // Test Orcha connection
  document.getElementById('test-orcha').addEventListener('click', async () => {
    const statusEl = document.getElementById('orcha-test-status');
    const btn = document.getElementById('test-orcha');
    btn.disabled = true;
    btn.textContent = 'Testing...';
    statusEl.textContent = '\u23F3 Connecting to Orcha...';
    statusEl.style.color = '#94a3b8';
    try {
      const result = await window.ai.test();
      if (result && result.ok) {
        const model = (result.model || '').split('/').pop().split(':')[0];
        statusEl.textContent = '\u2705 Connected \u2014 Response: "' + (result.response || 'OK').substring(0, 30) + '" | Model: ' + model + ' | Requests: ' + (result.requestCount || 0);
        statusEl.style.color = '#22c55e';
      } else {
        statusEl.textContent = '\u274C Connection failed: ' + (result.lastError || result.status || 'No response');
        statusEl.style.color = '#ef4444';
      }
    } catch (e) {
      statusEl.textContent = '\u274C Error: ' + e.message;
      statusEl.style.color = '#ef4444';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test Connection';
    }
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
  credsBridge.has(`vendor.${vendor}.username`).then((has) => {
    const st = document.getElementById(statusId);
    if (!st) return;
    st.textContent = has ? `✅ Credentials saved` : '⚠️ Not configured';
    st.style.display = 'block';
    st.className = `settings__status settings__status--${has ? 'ok' : 'loading'}`;
  }).catch(() => {});
}

function _wireVendorAuth() {
  const ALL_VENDORS = ['paccar', 'volvo', 'record360', 'aperia', 'reach24', 'dtna', 'roadready', 'velogic', 'abs'];
  ALL_VENDORS.forEach((v) => {
    _checkVendorCred(v, `${v}-status`);

    // Repopulate username field (password never retrieved — encrypted only)
    settingsBridge.getAll().then((all) => {
      const userEl = document.getElementById(`${v}-user`);
      if (userEl && all && all[`${v}_user`]) userEl.value = all[`${v}_user`];
    }).catch(() => {});

    document.getElementById(`${v}-save`).addEventListener('click', async () => {
      const user = document.getElementById(`${v}-user`).value.trim();
      const pass = document.getElementById(`${v}-pass`).value;
      if (!user || !pass) return;
      await credsBridge.set(`vendor.${v}.username`, user);
      await credsBridge.set(`vendor.${v}.password`, pass);
      await settingsBridge.save(`${v}_user`, user);
      document.getElementById(`${v}-pass`).value = '';
      _checkVendorCred(v, `${v}-status`);
    });

    document.getElementById(`${v}-clear`).addEventListener('click', async () => {
      await credsBridge.delete(`vendor.${v}.username`);
      await credsBridge.delete(`vendor.${v}.password`);
      await settingsBridge.save(`${v}_user`, '');
      document.getElementById(`${v}-user`).value = '';
      document.getElementById(`${v}-pass`).value = '';
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

function _wireEmail() {
  var saveBtn = document.getElementById('email-save');
  var testBtn = document.getElementById('email-test');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    await emailBridge.saveConfig({
      host: document.getElementById('email-host').value.trim(),
      port: parseInt(document.getElementById('email-port').value, 10) || 587,
      from: document.getElementById('email-from').value.trim(),
      user: document.getElementById('email-user').value.trim(),
      pass: document.getElementById('email-pass').value,
    });
    document.getElementById('email-pass').value = '';
  });
  if (testBtn) testBtn.addEventListener('click', () => {});
}

function _wireSlack() {
  _checkSlack();
  var recheckBtn = document.getElementById('slack-recheck');
  var loginBtn = document.getElementById('slack-login');
  if (recheckBtn) recheckBtn.addEventListener('click', _checkSlack);
  if (loginBtn) loginBtn.addEventListener('click', () => {
    slackBridge.login().then(() => _checkSlack()).catch(() => {});
  });
}

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
async function _spSaveDomicile(opName, domCode, siteUrl, listName, headerRow) {
  const existing = await spBridge.getConfig().catch(() => ({})) || {};
  const domiciles = existing.domiciles || {};
  const key = `${opName}__${domCode}`;
  domiciles[key] = { siteUrl, listName, headerRow: headerRow || 16 };

  // Update workbooks array for SP push engine
  const workbooks = existing.workbooks || [];
  const wbIdx = workbooks.findIndex(wb => wb.domicile === domCode);
  if (siteUrl) {
    const carrier = { code: opName, sheet: listName || "sheet2" };
    if (wbIdx > -1) {
      const wb = workbooks[wbIdx];
      wb.path = siteUrl;
      wb.headerRow = headerRow || wb.headerRow || 16;
      if (!wb.carriers.find(c => c.code === opName)) wb.carriers.push(carrier);
      else wb.carriers = wb.carriers.map(c => c.code === opName ? carrier : c);
    } else {
      workbooks.push({ name: domCode, domicile: domCode, path: siteUrl, carriers: [carrier], headerRow: headerRow || 16 });
    }
  }

  return spBridge.saveConfig({ ...existing, domiciles, workbooks });
}

// ── SP: render operator accordion cards ──────────────────────────────────────

// Lookup SP config from workbooks array (fallback when domiciles config is empty)
function _wbLookup(spCfg, opName, domCode) {
  const wbs = (spCfg && spCfg.workbooks) || [];
  const wb = wbs.find(w => w.domicile === domCode);
  if (!wb) return null;
  const carrier = wb.carriers && wb.carriers.find(c => c.code === opName);
  return { siteUrl: wb.path || "", listName: (carrier && carrier.sheet) || "", headerRow: wb.headerRow || 16 };
}

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

    
    // ── "ALL" entry — email for all domiciles combined ──
    const allKey = op.name + '__ALL';
    const allSavedEmail = savedEmails[allKey] || {};
    const allTo = allSavedEmail.to || '';
    const allCc = allSavedEmail.cc || '';
    const allEmStatus = allTo ? 'ok' : 'warn';
    const allEmTxt = allTo ? '✓ Email' : '⚠ Email';

  // ── Partner Forms (moved outside operator loop) ────────────────────────
  const _formsSheetInput = document.getElementById('forms-sheet-id');
  const _formsPollSelect = document.getElementById('forms-poll-interval');
  const _formsStatus = document.getElementById('forms-status');
  
  // Load saved config
  const _formsConfig = JSON.parse(localStorage.getItem('fleet_forms_config') || '{}');
  if (_formsSheetInput && _formsConfig.sheetId) _formsSheetInput.value = _formsConfig.sheetId;
  if (_formsPollSelect && _formsConfig.pollInterval) _formsPollSelect.value = _formsConfig.pollInterval;

  document.getElementById('forms-save').addEventListener('click', () => {
    const cfg = {
      sheetId: (_formsSheetInput.value || '').trim(),
      pollInterval: parseInt(_formsPollSelect.value || '60', 10)
    };
    bus.emit('config:forms-changed'); localStorage.setItem('fleet_forms_config', JSON.stringify(cfg));
    // Also save to main process store
    if (window.partner && window.partner.pollForms) {
      window.partner.pollForms({ sheetId: cfg.sheetId }).catch(() => {});
    }
    if (_formsStatus) { _formsStatus.textContent = '\u2705 Saved — polling will start automatically'; _formsStatus.style.display = ''; _formsStatus.className = 'sd-status ok'; }
  });

  document.getElementById('forms-poll-now').addEventListener('click', async () => {
    console.log('[FORMS] Poll Now clicked');
    let rawId = (_formsSheetInput.value || '').trim();
    console.log('[FORMS] rawId:', rawId);
    if (!rawId) { if (_formsStatus) { _formsStatus.textContent = '\u26a0 Enter a Sheet ID first'; _formsStatus.style.display = ''; _formsStatus.className = 'sd-status warn'; } return; }
    if (_formsStatus) { _formsStatus.textContent = '\u{1F504} Polling...'; _formsStatus.style.display = ''; _formsStatus.className = 'sd-status'; }
    
    // Extract gid and clean sheet ID
    let gid = '0';
    const gidMatch = rawId.match(/gid=(\d+)/);
    if (gidMatch) gid = gidMatch[1];
    let sheetId = rawId.replace(/\/edit.*$/, '').replace(/[?#].*$/, '').replace(/\/+$/, '').trim();
    if (sheetId.includes('spreadsheets/d/')) sheetId = sheetId.split('spreadsheets/d/')[1].split('/')[0];
    if (sheetId.includes('/')) sheetId = sheetId.split('/')[0];
    
    const csvUrl = gid !== '0'
      ? 'https://docs.google.com/spreadsheets/d/' + sheetId + '/export?format=csv&gid=' + gid
      : 'https://docs.google.com/spreadsheets/d/' + sheetId + '/gviz/tq?tqx=out:csv';
    
    try {
      const resp = await fetch(csvUrl);
      if (!resp.ok) { _formsStatus.textContent = '\u274c HTTP ' + resp.status; _formsStatus.className = 'sd-status err'; _formsStatus.style.display = ''; return; }
      const csv = await resp.text();
      const rows = csv.split('\n').filter(r => r.trim());
      _formsStatus.textContent = '\u2705 Connected! ' + (rows.length - 1) + ' row(s) found';
      _formsStatus.className = 'sd-status ok';
      _formsStatus.style.display = '';
      
      // Send to main for AI processing
      const result = await window.partner.pollForms({ csvText: csv });
      if (result && result.newCount > 0) {
        _formsStatus.textContent = '\u2705 ' + result.newCount + ' new request(s) — AI classifying...';
      }
    } catch(e) {
      _formsStatus.textContent = '\u274c ' + e.message;
      _formsStatus.className = 'sd-status err';
      _formsStatus.style.display = '';
    }
  });



    const allEl = document.createElement('div');
    allEl.className = 'ops-domicile ops-domicile--all';
    allEl.innerHTML = `
      <div class="ops-dom-header">
        <span class="ops-dom-tag" style="background:var(--acc);color:#fff;font-weight:700">ALL</span>
        <span class="ops-dom-count">All domiciles combined</span>
        <span class="ops-dom-sp-status ${allEmStatus}" data-em-status>${allEmTxt}</span>
      </div>
      <div class="ops-email-fields" style="margin-top:6px">
        <div class="sd-section-label">Email recipients (all domiciles)</div>
        <div class="sd-field">
          <div class="sd-label">To <span class="sd-label-hint">(semicolon-separated)</span></div>
          <input class="sd-input ops-em-to" type="email" multiple placeholder="manager@amazon.com" value="${_esc(allTo)}"/>
        </div>
        <div class="sd-field">
          <div class="sd-label">CC</div>
          <input class="sd-input ops-em-cc" type="email" multiple placeholder="cc@amazon.com" value="${_esc(allCc)}"/>
        </div>
        <div class="sd-btn-row">
          <button class="sd-btn primary ops-em-save" type="button">Save email</button>
        </div>
      </div>`;
    body.appendChild(allEl);

    // Wire ALL email save
    allEl.querySelector('.ops-em-save').addEventListener('click', async () => {
      const to = allEl.querySelector('.ops-em-to').value.trim();
      const cc = allEl.querySelector('.ops-em-cc').value.trim();
      await _spSaveEmail(op.name, 'ALL', to, cc);
      const pill = allEl.querySelector('[data-em-status]');
      if (pill) { pill.textContent = to ? '✓ Email' : '⚠ Email'; pill.className = 'ops-dom-sp-status ' + (to ? 'ok' : 'warn'); }
      toast.show('success', 'Email saved for ' + op.name + ' (ALL)', 2000);
    });

    (op.domiciles || []).forEach((d) => {
      const key        = `${op.name}__${d.code}`;
      const savedSP    = savedDoms[key]   || _wbLookup(spCfg, op.name, d.code) || {};
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
            <div class="sd-label">SharePoint Excel URL or Path</div>
            <input class="sd-input ops-sp-site" placeholder="https://amazon.sharepoint.com/sites/..." value="${_esc(siteVal)}"/>
          </div>
          <div class="sd-field">
            <div class="sd-label-row sd-label">
              List / Sheet
              <button class="ops-load-btn" type="button">Load sheets</button>
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
        const listName = (domEl.querySelector('.ops-sp-list').value || '').trim();
        badge.textContent = 'saving...'; badge.className = 'ops-autosave-badge saving';
        try {
          const headerRow = parseInt(domEl.querySelector('.ops-sp-header')?.value || '16', 10);
          await _spSaveDomicile(op.name, d.code, siteUrl, listName, headerRow);
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

      // ── SP: Load sheets from Excel URL ──
      domEl.querySelector('.ops-load-btn').addEventListener('click', async () => {
        const siteUrl = domEl.querySelector('.ops-sp-site').value.trim();
        const loadBtn = domEl.querySelector('.ops-load-btn');
        const select  = domEl.querySelector('.ops-sp-list');
        const curVal  = select.value;

        if (!siteUrl) { toast.show('warn', 'Paste a SharePoint Excel URL or path first', 2500); return; }

        loadBtn.disabled = true;
        loadBtn.textContent = 'Discovering...';
        try {
          const result = await spBridge.discoverSheets(siteUrl);
          if (!result || result.error) {
            toast.show('error', result.error || 'Could not discover sheets', 4000);
            return;
          }
          if (!result.sheets || !result.sheets.length) {
            toast.show('warn', 'No sheets found in workbook', 3000);
            return;
          }
          select.innerHTML = '<option value="">— select sheet —</option>';
          result.sheets.forEach(({ name, headerRow }) => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name + ' (header row: ' + headerRow + ')';
            opt.dataset.headerRow = headerRow;
            if (name === curVal) opt.selected = true;
            select.appendChild(opt);
          });
          // Auto-set header row from selected sheet
          select.addEventListener('change', () => {
            const sel = select.options[select.selectedIndex];
            if (sel && sel.dataset.headerRow) {
              const hrInput = domEl.querySelector('.ops-sp-header');
              if (hrInput) hrInput.value = sel.dataset.headerRow;
            }
          });
          // Store the file path for push
          if (result.filePath) {
            domEl.querySelector('.ops-sp-site').dataset.filePath = result.filePath;
          }
          toast.show('success', result.sheets.length + ' sheet(s) found — header rows auto-detected', 3000);
        } catch (e) {
          toast.show('error', 'Discover failed: ' + (e.message || e), 4000);
        } finally {
          loadBtn.disabled = false;
          loadBtn.textContent = 'Load sheets';
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
function _wireSP() { /* SP wiring handled in operators tab */ }

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
    { id: 'sl-opacity', valId: 'sl-opacity-val', suffix: '%', cssVar: '--panel-opacity' },
    { id: 'sl-blur',    valId: 'sl-blur-val',    suffix: 'px', cssVar: '--panel-blur' },
    { id: 'sl-speed',   valId: 'sl-speed-val',   suffix: 'ms', cssVar: '--drawer-speed' },
    { id: 'sl-radius',  valId: 'sl-radius-val',  suffix: 'px', cssVar: '--card-radius' },
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

  // ── S28: SLA Target slider ─────────────────────────────────────────────────
  const slaSl = document.getElementById('sl-sla-target');
  const slaVl = document.getElementById('sl-sla-target-val');
  if (slaSl && slaVl) {
    // Load saved value
    const saved = parseInt(localStorage.getItem('fleet_sla_target') || '5', 10) || 5;
    slaSl.value = saved;
    slaVl.textContent = saved + 'd';
    slaSl.addEventListener('input', () => {
      const val = parseInt(slaSl.value, 10);
      slaVl.textContent = val + 'd';
      localStorage.setItem('fleet_sla_target', String(val));
      bus.emit('settings:sla-target', { days: val });
    });
  }

  // ── Font buttons ───────────────────────────────────────────────────────────
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

  // ── NEXUS THEME BUILDER WIRING ─────────────────────────────────────────────
  _wireNexusThemeBuilder();
}

function _wireNexusThemeBuilder() {
  // Uses top-level imports: setPreset, setTheme, getThemeConfig, resetTheme, PRESETS


  // Load current config and set initial UI state
  const cfg = getThemeConfig();

  // Presets
  const presetGrid = document.getElementById('nx-preset-grid');
  if (presetGrid) {
    presetGrid.querySelectorAll('.nx-preset-chip').forEach(chip => {
      if (chip.dataset.preset === cfg.preset) chip.classList.add('nx-preset-chip--active');
      else chip.classList.remove('nx-preset-chip--active');
      chip.addEventListener('click', () => {
        presetGrid.querySelectorAll('.nx-preset-chip').forEach(c => c.classList.remove('nx-preset-chip--active'));
        chip.classList.add('nx-preset-chip--active');
        setPreset(chip.dataset.preset);
        // Update accent picker to match preset
        const p = PRESETS[chip.dataset.preset];
        if (p) {
          const picker = document.getElementById('nx-accent-picker');
          const hex = document.getElementById('nx-accent-hex');
          if (picker) picker.value = p.accent;
          if (hex) hex.textContent = p.accent;
        }
      });
    });
  }

  // Accent color picker
  const accentPicker = document.getElementById('nx-accent-picker');
  const accentHex = document.getElementById('nx-accent-hex');
  if (accentPicker) {
    accentPicker.value = cfg.accent || '#00d4ff';
    if (accentHex) accentHex.textContent = cfg.accent || '#00d4ff';
    accentPicker.addEventListener('input', () => {
      setTheme('accent', accentPicker.value);
      if (accentHex) accentHex.textContent = accentPicker.value;
    });
  }
  const accentReset = document.getElementById('nx-accent-reset');
  if (accentReset) {
    accentReset.addEventListener('click', () => {
      const p = PRESETS[getThemeConfig().preset];
      const color = p ? p.accent : '#00d4ff';
      setTheme('accent', color);
      if (accentPicker) accentPicker.value = color;
      if (accentHex) accentHex.textContent = color;
    });
  }

  // Density buttons
  _drawer.querySelectorAll('[data-density]').forEach(chip => {
    if (chip.dataset.density === cfg.density) chip.classList.add('nx-preset-chip--active');
    else chip.classList.remove('nx-preset-chip--active');
    chip.addEventListener('click', () => {
      _drawer.querySelectorAll('[data-density]').forEach(c => c.classList.remove('nx-preset-chip--active'));
      chip.classList.add('nx-preset-chip--active');
      setTheme('density', chip.dataset.density);
    });
  });

  // Animation speed buttons
  _drawer.querySelectorAll('[data-anim]').forEach(chip => {
    if (chip.dataset.anim === cfg.animSpeed) chip.classList.add('nx-preset-chip--active');
    else chip.classList.remove('nx-preset-chip--active');
    chip.addEventListener('click', () => {
      _drawer.querySelectorAll('[data-anim]').forEach(c => c.classList.remove('nx-preset-chip--active'));
      chip.classList.add('nx-preset-chip--active');
      setTheme('animSpeed', chip.dataset.anim);
    });
  });

  // Blur slider
  const blurSl = document.getElementById('nx-blur');
  const blurVal = document.getElementById('nx-blur-val');
  if (blurSl) {
    blurSl.value = cfg.blur || 20;
    if (blurVal) blurVal.textContent = (cfg.blur || 20) + 'px';
    blurSl.addEventListener('input', () => {
      const v = parseInt(blurSl.value, 10);
      if (blurVal) blurVal.textContent = v + 'px';
      setTheme('blur', v);
    });
  }

  // Glow slider
  const glowSl = document.getElementById('nx-glow');
  const glowVal = document.getElementById('nx-glow-val');
  if (glowSl) {
    glowSl.value = (cfg.glowIntensity || 1) * 100;
    if (glowVal) glowVal.textContent = Math.round((cfg.glowIntensity || 1) * 100) + '%';
    glowSl.addEventListener('input', () => {
      const v = parseInt(glowSl.value, 10);
      if (glowVal) glowVal.textContent = v + '%';
      setTheme('glowIntensity', v / 100);
    });
  }

  // Toggle: background gradient
  const bgGrad = document.getElementById('nx-bg-gradient');
  if (bgGrad) {
    bgGrad.checked = cfg.bgGradient !== false;
    bgGrad.addEventListener('change', () => setTheme('bgGradient', bgGrad.checked));
  }

  // Toggle: grid lines
  const gridLines = document.getElementById('nx-grid-lines');
  if (gridLines) {
    gridLines.checked = cfg.gridLines !== false;
    gridLines.addEventListener('change', () => setTheme('gridLines', gridLines.checked));
  }
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
    const swatchVars = ['--acc', '--bg', '--panel', '--txt', '--row-avail', '--row-unavail'];
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
      { id: 'sl-opacity', valId: 'sl-opacity-val', suffix: '%', cssVar: '--panel-opacity' },
      { id: 'sl-blur',    valId: 'sl-blur-val',    suffix: 'px', cssVar: '--panel-blur' },
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
  
  // ── Partner Forms (top-level, always registers) ─────────────────────────
  (function _wireFormsTopLevel() {
    const sheetInput = document.getElementById('forms-sheet-id');
    const pollSelect = document.getElementById('forms-poll-interval');
    const statusEl = document.getElementById('forms-status');
    const savedCfg = JSON.parse(localStorage.getItem('fleet_forms_config') || '{}');
    if (sheetInput && savedCfg.sheetId) sheetInput.value = savedCfg.sheetId;
    if (pollSelect && savedCfg.pollInterval) pollSelect.value = savedCfg.pollInterval;

    const saveBtn = document.getElementById('forms-save');
    if (saveBtn) saveBtn.addEventListener('click', () => {
      const cfg = { sheetId: (sheetInput.value || '').trim(), pollInterval: parseInt(pollSelect.value || '60', 10) };
      localStorage.setItem('fleet_forms_config', JSON.stringify(cfg));
      if (statusEl) { statusEl.textContent = '\u2705 Saved'; statusEl.style.display = ''; statusEl.className = 'sd-status ok'; }
    });

    const pollBtn = document.getElementById('forms-poll-now');
    if (pollBtn) pollBtn.addEventListener('click', async () => {
      let rawId = (sheetInput.value || '').trim();
      if (!rawId) { if (statusEl) { statusEl.textContent = '\u26a0 Enter a Sheet ID first'; statusEl.style.display = ''; statusEl.className = 'sd-status warn'; } return; }
      if (statusEl) { statusEl.textContent = '\u{1F504} Polling...'; statusEl.style.display = ''; statusEl.className = 'sd-status'; }
      let gid = '0';
      const gidMatch = rawId.match(/gid=(\d+)/);
      if (gidMatch) gid = gidMatch[1];
      let sheetId = rawId.replace(/\/edit.*$/, '').replace(/[?#].*$/, '').replace(/\/+$/, '').trim();
      if (sheetId.includes('spreadsheets/d/')) sheetId = sheetId.split('spreadsheets/d/')[1].split('/')[0];
      if (sheetId.includes('/')) sheetId = sheetId.split('/')[0];
      const csvUrl = 'https://docs.google.com/spreadsheets/d/' + sheetId + '/export?format=tsv';
      try {
        const resp = await fetch(csvUrl);
        if (!resp.ok) { statusEl.textContent = '\u274c HTTP ' + resp.status; statusEl.className = 'sd-status err'; statusEl.style.display = ''; return; }
        const csv = await resp.text();
        const rows = csv.split('\n').filter(r => r.trim());
        statusEl.textContent = '\u2705 Connected! ' + (rows.length - 1) + ' row(s) found';
        statusEl.className = 'sd-status ok'; statusEl.style.display = '';
        const result = await window.partner.pollForms({ csvText: csv });
        if (result && result.newCount > 0) { statusEl.textContent = '\u2705 ' + result.newCount + ' new request(s) — AI classifying...'; }
      } catch(e) { statusEl.textContent = '\u274c ' + e.message; statusEl.className = 'sd-status err'; statusEl.style.display = ''; }
    });
  })();

  // ── SP Workbook Discover ────────────────────────────────────────────────
  document.getElementById('sp-wb-discover').addEventListener('click', async () => {
    console.log('[SP Discover] Button clicked');
    const urlInput = document.getElementById('sp-wb-url');
    const url = (urlInput.value || '').trim();
    console.log('[SP Discover] URL:', url);
    console.log('[SP Discover] spBridge:', typeof spBridge.discoverSheets);
    if (!url) { toast.show('warn', 'Paste a SharePoint Excel URL first', 2500); return; }
    
    const btn = document.getElementById('sp-wb-discover');
    const resultsDiv = document.getElementById('sp-wb-results');
    const sheetsDiv = document.getElementById('sp-wb-sheets-list');
    
    btn.disabled = true; btn.textContent = 'Discovering...';
    try {
      console.log('[SP Discover] Calling discoverSheets...');
      let result;
      try {
        result = await spBridge.discoverSheets(url);
      } catch(err) {
        console.error('[SP Discover] IPC Error:', err);
        toast.show('error', 'IPC Error: ' + (err.message || err), 4000);
        return;
      }
      console.log('[SP Discover] Result:', JSON.stringify(result));
      if (!result || !result.ok) {
        toast.show('error', (result && result.error) || 'Could not discover sheets', 4000);
        return;
      }
      resultsDiv.style.display = '';
      sheetsDiv.innerHTML = result.sheets.map((s, i) => `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:#161b22;border:1px solid #21262d;border-radius:4px;margin-bottom:4px;">
          <input type="checkbox" id="sp-sh-${i}" data-sheet="${s.xmlFile || s.name}" data-name="${s.name}" data-header="${s.headerRow}" />
          <label for="sp-sh-${i}" style="font-size:11px;color:#c9d1d9;flex:1;cursor:pointer;">
            <strong>${s.name}</strong> <span style="color:#6e7681;">(${s.xmlFile || '?'})</span> <span style="color:#8b949e;">header: ${s.headerRow}</span>
          </label>
          <input style="width:60px;background:#0d1117;border:1px solid #30363d;border-radius:3px;padding:3px 6px;font-size:10px;color:#c9d1d9;" placeholder="Operator" id="sp-op-${i}" />
        </div>
      `).join('');
      
      sheetsDiv.innerHTML += `<div style="margin-top:8px;display:flex;gap:8px;align-items:center;"><input class="sd-input" id="sp-wb-domicile" placeholder="Domicile (ABE40, AVP40...)" style="width:140px;" /><button class="sd-btn primary" id="sp-wb-save">Save workbook config</button></div>`;
      
      // Save handler
      document.getElementById('sp-wb-save').addEventListener('click', async () => {
        const checks = sheetsDiv.querySelectorAll('input[type=checkbox]:checked');
        if (!checks.length) { toast.show('warn', 'Select at least one sheet', 2000); return; }
        
        const carriers = [];
        checks.forEach((cb, idx) => {
          const sheet = cb.dataset.sheet;
          const headerRow = parseInt(cb.dataset.header || '16');
          const opInput = cb.closest('div').querySelector('input[placeholder="Operator"]');
          const operator = opInput ? opInput.value.trim().toUpperCase() : '';
          carriers.push({ code: (operator || cb.dataset.name || 'DEFAULT').toUpperCase(), sheet: sheet, sheetName: cb.dataset.name || sheet, headerRow });
        });
        
        const domicileInput = document.getElementById('sp-wb-domicile');
        const workbook = {
          name: url.split('file=')[1] ? decodeURIComponent(url.split('file=')[1].split('&')[0]) : 'Workbook',
          domicile: (domicileInput ? domicileInput.value.trim().toUpperCase() : '') || '',
          path: result.filePath || url,
          carriers,
          headerRow: carriers[0].headerRow
        };
        
        // Load existing config and add
        const existing = await spBridge.getConfig();
        const workbooks = (existing && existing.workbooks) || [];
        workbooks.push(workbook);
        await spBridge.saveConfig({ ...existing, workbooks });
        toast.show('success', 'Workbook saved: ' + workbook.name, 3000);
        _renderSavedWorkbooks();
      });
      
      toast.show('success', result.sheets.length + ' sheet(s) found', 2500);
    } catch(e) {
      toast.show('error', 'Failed: ' + (e.message || e), 4000);
    } finally {
      btn.disabled = false; btn.textContent = 'Load sheets';
    }
  });

  // Render saved workbooks
  async function _renderSavedWorkbooks() {
    const cfg = await spBridge.getConfig();
    const workbooks = (cfg && cfg.workbooks) || [];
    const div = document.getElementById('sp-wb-saved');
    if (!div) return;
    if (!workbooks.length) { div.innerHTML = '<div style="font-size:10px;color:#484f58;">No workbooks configured yet.</div>'; return; }
    div.innerHTML = '<div style="font-size:10px;font-weight:700;color:#8b949e;margin-bottom:6px;">SAVED WORKBOOKS</div>' +
      workbooks.map((wb, i) => `
        <div style="background:#161b22;border:1px solid #21262d;border-radius:4px;padding:8px 10px;margin-bottom:4px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div style="font-size:11px;font-weight:600;color:#c9d1d9;">${wb.name}</div>
            <button onclick="window._removeWB(${i})" style="background:none;border:none;color:#f85149;cursor:pointer;font-size:11px;">✕</button>
          </div>
          <div style="font-size:9px;color:#6e7681;margin-top:2px;">${(wb.carriers||[]).map(c => c.code + ' → ' + (c.sheetName || c.sheet)).join(' | ')}</div>
        </div>
      `).join('');
  }
  window._removeWB = async (idx) => {
    const cfg = await spBridge.getConfig();
    const workbooks = (cfg && cfg.workbooks) || [];
    workbooks.splice(idx, 1);
    await spBridge.saveConfig({ ...cfg, workbooks });
    _renderSavedWorkbooks();
  };
  _renderSavedWorkbooks();


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

  // ── Apply saved CSS vars immediately on startup (don't wait for drawer open) ──
  settingsBridge.getAll().then((all) => {
    if (!all?.ui_prefs?.swatches) return;
    Object.entries(all.ui_prefs.swatches).forEach(([cssVar, color]) => {
      if (color) document.documentElement.style.setProperty(cssVar, color);
    });
  }).catch(() => {});
}
