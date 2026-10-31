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
import state                                        from '../state.js';
import { settings as settingsBridge }              from '../bridge.js';
import { credentials as credsBridge }              from '../bridge.js';
import { auth     as authBridge }                  from '../bridge.js';
import { slack    as slackBridge }                 from '../bridge.js';
import { sp       as spBridge }                    from '../bridge.js';
import { asana    as asanaBridge }                 from '../bridge.js';
import toast                                       from '../components/toast.js';
import { setPreset, setTheme, getThemeConfig, resetTheme, PRESETS } from '../nexus-theme.js';
import { initFasSettings } from './fas-settings.js';

// ── Module state ────────────────────────────────────────────────────────────
let _drawer   = null;   // the drawer DOM element
let _overlay  = null;   // the backdrop overlay

// Font size → UI zoom scale. The UI is px-based, so zoom (not root font-size)
// is what scales the whole interface proportionally.
//
// IMPORTANT: the app shell is a fixed 100vh flex column with overflow:hidden
// and a bottom status bar. Zooming the body alone makes its 100vh content
// render taller than the real window, so overflow:hidden clips the BOTTOM
// (the status bar disappears). Fix: zoom #app AND shrink its height by the same
// factor (height = 100vh / scale) so that AFTER the zoom it renders at exactly
// one real viewport — everything, including the status bar, stays on screen.
const FONT_SIZE_SCALE = { small: 0.9, normal: 1, large: 1.12, xlarge: 1.25 };
function _applyFontSize(size) {
  const scale = FONT_SIZE_SCALE[size] || 1;
  try {
    const app = document.getElementById('app');
    if (app) {
      app.style.zoom = String(scale);
      app.style.height = scale === 1 ? '' : `calc(100vh / ${scale})`;
    } else {
      // Fallback if #app isn't present yet.
      document.body.style.zoom = String(scale);
    }
  } catch (_) {}
  // CSS `zoom` does NOT fire a window 'resize', so views that size themselves to
  // the viewport (e.g. the Long Dwell CSV table's scroll box) can't react to a
  // font-size change on their own. Broadcast it so they can re-fit. Deferred a
  // frame so layout reflects the new zoom before listeners measure.
  try {
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('fleet:font-size-changed', { detail: { size, scale } }));
    });
  } catch (_) {}
}

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
          <div class="sd-section-title">Table Background</div>
          <div class="sd-color-row">
            <div class="sd-color-item">
              <div class="sd-label">Table BG</div>
              <div class="sd-color-swatch-row">
                <div class="sd-swatch active" style="background:var(--card)"             title="Default (card)" data-var="--table-bg"></div>
                <div class="sd-swatch"        style="background:#0d1117"                 title="Dark"           data-var="--table-bg"></div>
                <div class="sd-swatch"        style="background:#000000"                 title="Black"          data-var="--table-bg"></div>
                <div class="sd-swatch"        style="background:#161b22"                 title="Panel"          data-var="--table-bg"></div>
                <div class="sd-swatch"        style="background:#1c2128"                 title="Card"           data-var="--table-bg"></div>
                <div class="sd-swatch"        style="background:#0e2a3a"                 title="Ocean"          data-var="--table-bg"></div>
                <div class="sd-swatch"        style="background:#ffffff"                 title="White"          data-var="--table-bg"></div>
                <input type="color" class="sd-color-custom" value="#1c2128" title="Custom" data-var="--table-bg"/>
              </div>
            </div>
          </div>
        </div>

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
          <div class="sd-slider-row">
            <div class="sd-label">Chat Floater Opacity</div>
            <div class="sd-slider-wrap">
              <input type="range" class="sd-slider" id="sl-bubble-opacity" min="40" max="100" value="100"/>
              <span class="sd-slider-val" id="sl-bubble-opacity-val">100%</span>
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
          <div class="sd-section-title">Font Size</div>
          <div class="sd-font-row">
            <button class="sd-fontsize-btn" data-fontsize="small"  style="font-size:10px">Small</button>
            <button class="sd-fontsize-btn active" data-fontsize="normal" style="font-size:12px">Normal</button>
            <button class="sd-fontsize-btn" data-fontsize="large"  style="font-size:14px">Large</button>
            <button class="sd-fontsize-btn" data-fontsize="xlarge" style="font-size:16px">X-Large</button>
          </div>
          <div class="sd-hint" style="margin-top:6px">Scales the entire app interface.</div>
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

        <!-- Chat Floater -->
        <div class="sd-section" id="sect-chat-floater">
          <div class="sd-section-title">Chat Floater</div>
          <div class="sd-hint" style="margin-bottom:10px">Customize the Orcha AI panel — size, bubble colors, border, and FAB accent.</div>

          <!-- Size presets -->
          <div class="sd-field" style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px">Panel Size</div>
            <div style="display:flex;gap:6px">
              <button class="sd-font-btn" id="chat-size-compact" data-chat-size="compact">Compact</button>
              <button class="sd-font-btn active" id="chat-size-normal" data-chat-size="normal">Normal</button>
              <button class="sd-font-btn" id="chat-size-wide" data-chat-size="wide">Wide</button>
              <button class="sd-font-btn" id="chat-size-tall" data-chat-size="tall">Tall</button>
            </div>
          </div>

          <!-- AI bubble color -->
          <div class="sd-color-row" style="margin-bottom:10px">
            <div class="sd-color-item">
              <div class="sd-label">AI Bubble</div>
              <div class="sd-color-swatch-row">
                <div class="sd-swatch active" style="background:rgba(88,166,255,.08)"  title="Blue (default)" data-var="--chat-bubble-ai"></div>
                <div class="sd-swatch"        style="background:rgba(210,168,255,.10)" title="Purple"        data-var="--chat-bubble-ai"></div>
                <div class="sd-swatch"        style="background:rgba(126,231,135,.08)" title="Green"         data-var="--chat-bubble-ai"></div>
                <div class="sd-swatch"        style="background:rgba(255,166,87,.08)"  title="Orange"        data-var="--chat-bubble-ai"></div>
                <div class="sd-swatch"        style="background:rgba(255,255,255,.05)" title="Subtle"        data-var="--chat-bubble-ai"></div>
                <input type="color" class="sd-color-custom" value="#58a6ff" title="Custom" data-var="--chat-bubble-ai"/>
              </div>
            </div>
            <div class="sd-color-item">
              <div class="sd-label">User Bubble</div>
              <div class="sd-color-swatch-row">
                <div class="sd-swatch active" style="background:rgba(88,166,255,.08)"  title="Blue (default)" data-var="--chat-bubble-user"></div>
                <div class="sd-swatch"        style="background:rgba(210,168,255,.14)" title="Purple"        data-var="--chat-bubble-user"></div>
                <div class="sd-swatch"        style="background:rgba(88,166,255,.18)"  title="Blue bold"     data-var="--chat-bubble-user"></div>
                <div class="sd-swatch"        style="background:rgba(255,255,255,.06)" title="Subtle"        data-var="--chat-bubble-user"></div>
                <input type="color" class="sd-color-custom" value="#58a6ff" title="Custom" data-var="--chat-bubble-user"/>
              </div>
            </div>
          </div>

          <!-- Panel border color -->
          <div class="sd-color-row" style="margin-bottom:10px">
            <div class="sd-color-item">
              <div class="sd-label">Panel Border</div>
              <div class="sd-color-swatch-row">
                <div class="sd-swatch active" style="background:rgba(88,166,255,.25)"  title="Blue (default)" data-var="--chat-border"></div>
                <div class="sd-swatch"        style="background:rgba(210,168,255,.30)" title="Purple"        data-var="--chat-border"></div>
                <div class="sd-swatch"        style="background:rgba(48,54,61,.80)"    title="Subtle"        data-var="--chat-border"></div>
                <div class="sd-swatch"        style="background:rgba(126,231,135,.25)" title="Green"         data-var="--chat-border"></div>
              </div>
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

        <!-- Domiciles section moved (2026-08-14) to the 👤 User Profile popover
             (toolbar avatar) as a chip editor. Same settings:save/reset-domiciles
             backend (triggers a rescan). -->

        <!-- Midway Auth section removed (2026-08-14): run mwinit via Ctrl+M
             (keyboard-shortcuts.js); session-expiry surfaces its own re-auth
             modal (app.js fleet:auth-failure) + status-bar indicator. -->

        <!-- Auth Health (Phase E) — the single Midway/AAP self-healing
             supervisor. Health = verified authenticated access to the REAL AAP
             target, not VPN state and not cookie existence. -->
        <div class="sd-section" id="sect-auth-health">
          <div class="sd-section-title">Midway / AAP Auth Health</div>
          <div id="auth-health-state" class="sd-status warn" style="margin-bottom:8px">\u2139\uFE0F Not checked yet</div>
          <div id="auth-health-grid" class="sd-hint" style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin-bottom:8px"></div>
          <div class="sd-hint" style="margin-bottom:8px">VPN is <b>not required</b> for Midway/AAP auth. Health is verified by a real authenticated call to the AAP target.</div>
          <div class="sd-btn-row">
            <button class="sd-btn secondary" id="auth-health-refresh">Refresh</button>
            <button class="sd-btn primary"   id="auth-health-retry">Retry now</button>
            <button class="sd-btn secondary" id="auth-health-mwinit">Run mwinit</button>
          </div>
          <div id="auth-health-history" class="sd-hint" style="margin-top:10px"></div>
        </div>

        <!-- AI Config moved (2026-08-14) to #ai-config-overlay opened from
             the toolbar AI status pill (#tb-ai-status). -->

        <!-- Notifications section moved (2026-08-14) to the 🔔 notification
             dropdown's ⚙ gear (renderer/src/js/components/notif-dropdown.js):
             OS-notification toggles + sound on/off/volume + per-category sound
             pickers. Persists to the same settings.notifications object. -->

        <!-- Email SMTP + Auto-Email Note sections removed (2026-08-14):
             user sends via OWA only, so the SMTP config is unused and the
             send pipeline (src/ipc/ai.js) already falls through to OWA when
             no SMTP password is set. The Auto-Email Note now lives in a gear
             overlay on the Scheduler view's Email card. -->

        <!-- Slack -->
        <div class="sd-section" id="sect-slack">
          <div class="sd-section-title">Slack</div>
          <div id="slack-status" class="sd-status warn" style="margin-bottom:8px">⚠️ Not connected</div>
          <div class="sd-btn-row">
            <button class="sd-btn primary"   id="slack-login">Sign in to Slack</button>
            <button class="sd-btn secondary" id="slack-recheck">Re-check</button>
            <button class="sd-btn secondary" id="slack-logout">Sign out</button>
          </div>
        </div>

        <!-- Microsoft Graph / Outlook sign-in was removed (2026-09-02).
             Email uses SMTP or the authenticated OWA browser session only. -->

        <!-- Partner Auto-Reply (AI) -- 2026-07-21. AI reads new messages in
             the configured Slack Connect channels and ALWAYS replies with a
             professional message -- the real answer if confident, or a
             warm holding reply otherwise. Out-of-scope requests are also
             logged to the Orcha floater's Review tab (🚨 Alerts / 💡 Actions
             / 📍 Workflow) for follow-up. See src/scrapers/slack_channel_watch.js
             for the full design + safety writeup. -->
        <div class="sd-section" id="sect-partner-autoreply">
          <div class="sd-section-title">
            <span style="font-size:11px">🤖</span> Partner Auto-Reply
            <span style="font-size:8px;color:var(--acc2);font-weight:700;background:var(--adim);padding:2px 6px;border-radius:8px;letter-spacing:1px">AI</span>
          </div>
          <div class="sd-hint" style="margin-bottom:10px">Watches your Slack Connect partner channels and replies automatically — confident answer when it has one, warm holding reply otherwise. Out-of-scope messages are also logged for review in Orcha.</div>
          <div class="sd-toggle-row">
            <span class="sd-toggle-label">Enable</span>
            <input type="checkbox" id="par-enabled"/>
          </div>
          <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
            <button class="sd-btn secondary" id="par-scan-btn" type="button">Scan my channels</button>
            <button class="sd-btn secondary" id="par-add-dm-btn" type="button">+ Use My DM</button>
            <button class="sd-btn secondary" id="par-add-manual-toggle" type="button">+ Add by ID</button>
          </div>
          <div id="par-add-manual" style="display:none;margin-top:8px">
            <div style="display:flex;gap:6px">
              <input id="par-add-id" class="sd-input" style="flex:1;font-size:11px" type="text" placeholder="e.g. C0A8WSPA4R3" />
              <button class="sd-btn secondary" id="par-add-btn" type="button">Add</button>
            </div>
          </div>
          <div id="par-channel-list" style="margin-top:10px;display:flex;flex-direction:column;gap:6px"></div>
          <div class="sd-btn-row" style="margin-top:10px">
            <button class="sd-btn primary" id="par-save">Save</button>
          </div>
          <div id="par-status" class="sd-status" style="display:none;margin-top:8px"></div>
        </div>

        <div class="sd-section" id="sect-operator-channels">
          <div class="sd-section-title">
            <span style="font-size:11px">📣</span> Operator Channels
            <span style="font-size:8px;color:var(--acc2);font-weight:700;background:var(--adim);padding:2px 6px;border-radius:8px;letter-spacing:1px">PM ALERTS</span>
          </div>
          <div class="sd-hint" style="margin-bottom:10px">When a Predictive Maintenance alert you're tagged in is handled, the app also posts a top-level message to the matching operator's carrier channel (tagging the owner) with the alert document attached. Map each operator to its Slack channel and owner here.</div>
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
            <button class="sd-btn secondary" id="opc-populate-btn" type="button">Populate from fleet</button>
            <button class="sd-btn secondary" id="opc-add-btn" type="button">+ Add operator</button>
          </div>
          <div id="opc-list" style="margin-top:10px;display:flex;flex-direction:column;gap:8px"></div>
          <div class="sd-btn-row" style="margin-top:10px">
            <button class="sd-btn primary" id="opc-save">Save</button>
          </div>
          <div id="opc-status" class="sd-status" style="display:none;margin-top:8px"></div>
        </div>

        <div class="sd-section" id="sect-dm-autoreply">
          <div class="sd-section-title">
            <span style="font-size:11px">💬</span> DM Auto-Reply
            <span style="font-size:8px;color:var(--acc2);font-weight:700;background:var(--adim);padding:2px 6px;border-radius:8px;letter-spacing:1px">AI</span>
          </div>
          <div class="sd-hint" style="margin-bottom:10px">Replies to your personal Slack DMs as you — adapts tone per-message (casual, professional, supportive), uses live fleet data for unit questions. Holds anything it's not confident about for your review in Orcha.</div>
          <div class="sd-toggle-row">
            <span class="sd-toggle-label">Enable</span>
            <input type="checkbox" id="dm-ar-enabled"/>
          </div>
          <div id="dm-ar-thread-list" style="margin-top:10px;display:flex;flex-direction:column;gap:6px"></div>
          <div class="sd-btn-row" style="margin-top:10px">
            <button class="sd-btn primary" id="dm-ar-save">Save</button>
          </div>
          <div id="dm-ar-status" class="sd-status" style="display:none;margin-top:8px"></div>
        </div>

        <!-- Digital Fleet Asset Specialist (FAS) -->
        <div class="sd-section" id="sect-fas">
          <div class="sd-section-title">
            <span style="font-size:11px">🤖</span> Digital Fleet Asset Specialist
            <span style="font-size:8px;color:var(--acc2);font-weight:700;background:var(--adim);padding:2px 6px;border-radius:8px;letter-spacing:1px">AGENT</span>
          </div>
          <div class="sd-hint" style="margin-bottom:10px">The single Slack reasoning agent: researches scoped fleet data, applies FAS judgment, decides whether/where to reply, and drafts or sends replies per mode. <strong>Approval</strong> is the default — FAS drafts and queues for your approval; <strong>Shadow</strong> drafts and compares only (sends nothing); <strong>Autonomous</strong> auto-sends verified low-risk answers.</div>
          <div class="sd-toggle-row">
            <span class="sd-toggle-label">Enable FAS agent</span>
            <input type="checkbox" id="fas-enabled"/>
          </div>
          <div class="sd-field" style="margin-top:8px">
            <label class="sd-label">Mode</label>
            <select class="sd-select" id="fas-mode">
              <option value="shadow">Shadow — draft &amp; compare, send nothing (legacy still replies)</option>
              <option value="approval">Approval — FAS drafts, you approve each send (legacy retired)</option>
              <option value="autonomous">Autonomous — auto-send verified low-risk (legacy retired)</option>
            </select>
            <div class="sd-hint">Default: Approval. Shadow keeps the legacy auto-reply live for parity comparison; Approval/Autonomous make FAS the only reasoning engine.</div>
          </div>
          <div class="sd-toggle-row" style="margin-top:8px">
            <span class="sd-toggle-label">Retire legacy reasoning<span class="sd-hint" style="display:block;opacity:.6;font-weight:400">When on (recommended), the old DM/partner persona reply engines never answer on their own — a FAS failure goes to manual review, not a legacy auto-reply. Turn off only as a temporary rollback.</span></span>
            <input type="checkbox" id="fas-retire-legacy"/>
          </div>
          <div class="sd-field">
            <label class="sd-label">Max agent steps</label>
            <input class="sd-input" id="fas-max-steps" type="number" min="1" max="20" />
          </div>
          <div class="sd-field">
            <label class="sd-label">Max runtime (seconds)</label>
            <input class="sd-input" id="fas-max-runtime" type="number" min="5" max="180" />
          </div>
          <div class="sd-btn-row" style="margin-top:10px">
            <button class="sd-btn primary" id="fas-save">Save FAS Config</button>
            <button class="sd-btn secondary" id="fas-refresh-audit">Refresh Shadow Log</button>
          </div>
          <div id="fas-status" class="sd-status" style="display:none;margin-top:8px"></div>
          <div class="sd-section-title" style="margin-top:14px;font-size:11px">Replies awaiting approval</div>
          <div class="sd-hint" style="margin-bottom:6px">Slack replies the FAS agent prepared (Approval/Autonomous mode). Review the request, proposed reply, evidence and reason, then Approve to send it (and run any proposed actions, verified) or Reject to send nothing.</div>
          <div id="fas-reply-approval-list" style="display:flex;flex-direction:column;gap:8px;max-height:320px;overflow:auto"></div>

          <div class="sd-section-title" style="margin-top:14px;font-size:11px">Automatic actions (Autonomous mode)</div>
          <div class="sd-hint" style="margin-bottom:6px">Choose which low-risk actions FAS may run automatically in Autonomous mode. Lifecycle changes, work requests and outbound messages always require approval and cannot be automated. Everything defaults to off.</div>
          <div id="fas-autoaction-list" style="display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto"></div>
          <div class="sd-btn-row" style="margin-top:6px"><button class="sd-btn secondary" id="fas-autoaction-reset">Reset to safe defaults (all off)</button></div>

          <div class="sd-section-title" style="margin-top:14px;font-size:11px">Due follow-ups</div>
          <div class="sd-hint" style="margin-bottom:6px">Commitments/promises whose follow-up time has arrived. FAS never contacts anyone automatically — snooze, complete, dismiss, or open the conversation to respond yourself.</div>
          <div id="fas-followup-list" style="display:flex;flex-direction:column;gap:8px;max-height:280px;overflow:auto"></div>

          <div class="sd-section-title" style="margin-top:14px;font-size:11px">Actions awaiting approval</div>
          <div class="sd-hint" style="margin-bottom:6px">Actions the FAS agent proposed that require your approval. Approving runs the real action and verifies the result before marking it done.</div>
          <div id="fas-approval-list" style="display:flex;flex-direction:column;gap:8px;max-height:260px;overflow:auto"></div>

          <div class="sd-section-title" style="margin-top:14px;font-size:11px">Sender permissions (from the Contact Book)</div>
          <div class="sd-hint" style="margin-bottom:6px">Identity and FAS permissions come from the Contact Book — the single source of truth. Edit a person's identity type, operator/domicile scope, and data/request permissions on their contact. For external (carrier/vendor/unknown) contacts, an EMPTY operator/domicile scope means NO fleet-scoped access (not full-fleet). This list is read-only.</div>
          <div class="sd-btn-row" style="margin-bottom:6px"><button class="sd-btn secondary" id="fas-migrate-profiles">Migrate legacy profiles → Contact Book</button></div>
          <div id="fas-profile-list" style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow:auto;margin-top:6px"></div>

          <div class="sd-section-title" style="margin-top:14px;font-size:11px">Knowledge drafts (from AITeammate)</div>
          <div class="sd-hint" style="margin-bottom:6px">Internal guidance the agent gathered. Approve to fold into the FAS playbook; reject to discard. Nothing becomes policy automatically.</div>
          <div id="fas-drafts-list" style="display:flex;flex-direction:column;gap:8px;max-height:220px;overflow:auto"></div>

          <div class="sd-section-title" style="margin-top:14px;font-size:11px">FAS playbook (current rules)</div>
          <div id="fas-playbook-list" style="display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto"></div>

          <div class="sd-section-title" style="margin-top:14px;font-size:11px">Shadow comparisons (FAS draft vs. what was sent)</div>
          <div class="sd-hint" style="margin-bottom:6px">Highest-divergence first. Nothing here was sent — this is evaluation only.</div>
          <div id="fas-audit-list" style="display:flex;flex-direction:column;gap:8px;max-height:340px;overflow:auto"></div>

          <div class="sd-section-title" style="margin-top:14px;font-size:11px">Channel roles (conversation vs data feed)</div>
          <div class="sd-hint" style="margin-bottom:6px">Classify channels FAS watches. <strong>Feed</strong> channels (vendor/alert/system/info) are read silently — FAS ingests the data and only replies when directly @-mentioned. <strong>Conversational</strong> channels get normal replies. Auto-detected roles are suggestions until you confirm them here.</div>
          <div class="sd-row" style="gap:6px;align-items:flex-end;flex-wrap:wrap">
            <div class="sd-field" style="flex:1;min-width:120px"><div class="sd-label">Channel ID</div><input class="sd-input" id="fas-chan-id" placeholder="C0123ABCD"/></div>
            <div class="sd-field" style="flex:1;min-width:120px"><div class="sd-label">Name</div><input class="sd-input" id="fas-chan-name" placeholder="vendor-repair-feed"/></div>
            <div class="sd-field" style="flex:1;min-width:140px"><div class="sd-label">Mode</div>
              <select class="sd-select" id="fas-chan-mode">
                <option value="CONVERSATIONAL">Conversational</option>
                <option value="OPERATIONAL">Operational</option>
                <option value="INFORMATION_FEED">Information feed</option>
                <option value="ALERT_FEED">Alert feed</option>
                <option value="VENDOR_FEED">Vendor feed</option>
                <option value="SYSTEM_FEED">System feed</option>
                <option value="MIXED">Mixed</option>
              </select>
            </div>
            <div class="sd-field" style="flex:1;min-width:150px"><div class="sd-label">Reply policy</div>
              <select class="sd-select" id="fas-chan-reply">
                <option value="normal">Normal</option>
                <option value="only_if_directly_mentioned">Only if @-mentioned</option>
                <option value="never">Never</option>
              </select>
            </div>
            <div class="sd-btn-row"><button class="sd-btn secondary" id="fas-chan-detect">Auto-detect</button><button class="sd-btn primary" id="fas-chan-save">Save channel</button></div>
          </div>
          <div id="fas-chan-list" style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow:auto;margin-top:6px"></div>

          <div class="sd-section-title" style="margin-top:14px;font-size:11px">Identity domain mappings (auto-classification)</div>
          <div class="sd-hint" style="margin-bottom:6px">Map an email domain to a carrier (with SCAC) or vendor so FAS classifies new senders from that domain automatically. @amazon.com is always internal. One mapping per line as <code>domain = SCAC</code> (carrier) or <code>domain = vendorName</code> (vendor).</div>
          <div class="sd-field"><div class="sd-label">Carrier domains (domain = SCAC)</div><textarea class="sd-input" id="fas-map-carrier" rows="3" placeholder="examplecarrier.com = TUZR" style="resize:vertical"></textarea></div>
          <div class="sd-field"><div class="sd-label">Vendor domains (domain = vendor name)</div><textarea class="sd-input" id="fas-map-vendor" rows="3" placeholder="amerit.com = Amerit Fleet" style="resize:vertical"></textarea></div>
          <div class="sd-btn-row"><button class="sd-btn primary" id="fas-map-save">Save mappings</button></div>

          <div class="sd-section-title" style="margin-top:14px;font-size:11px">Identity change log (auto-maintenance)</div>
          <div class="sd-hint" style="margin-bottom:6px">Every automatic identity/permission change FAS made, with the evidence and confidence that drove it. Read-only audit trail.</div>
          <div id="fas-identity-log" style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow:auto"></div>

          <div class="sd-section-title" style="margin-top:14px;font-size:11px">FAS Roster</div>
          <div class="sd-hint" style="margin-bottom:6px">The full FAS personnel roster (FAS Name, Site Code, Email, Phone, Uptime Manager, Program, SCAC), pulled directly from the FAS roster page — every entry, not just the first 100. Filter any column and copy to Excel/SharePoint.</div>
          <div id="fas-roster-host"></div>
        </div>

        <!-- Partner Work Request Forms section moved (2026-08-14) to the
             Incoming Work Requests overlay (📋 toolbar) ⚙ gear. -->

        <!-- Asana -->
        <div class="sd-section" id="sect-asana">
          <div class="sd-section-title">Asana</div>

          <!-- PRIMARY: Amazon Midway SSO. No PAT/OAuth needed — rides the same
               Midway session as AAP/Uptake. Requires a healthy AEA session. -->
          <div class="sd-hint" style="margin-bottom:8px">Asana connects through your Amazon Midway SSO session — the same login as AAP/Uptake. No token needed. First time: click Connect, enter your Asana email in the window that opens, and complete SSO once. After that it logs in automatically.</div>
          <div class="sd-btn-row">
            <button class="sd-btn primary"   id="asana-midway-connect">Connect to Asana</button>
            <button class="sd-btn secondary" id="asana-midway-check">Check connection</button>
          </div>
          <div id="asana-midway-status" class="sd-status warn" style="margin-top:6px">\u2139\uFE0F Not checked yet</div>

          <div class="sd-divider" style="margin:14px 0;border-top:1px solid var(--line,#2a3344)"></div>

          <!-- FALLBACK: Multi-user PAT manager (only works if your org allows
               Personal Access Tokens; many Amazon-managed workspaces don't). -->
          <div class="sd-hint" style="margin-bottom:8px">Fallback (only if PATs are allowed): add a teammate by alias + PAT. Auto-discovers their IDs; token stored encrypted.</div>
          <div class="sd-row">
            <div class="sd-field">
              <div class="sd-label">Alias</div>
              <input class="sd-input" id="asana-user-alias" placeholder="gbates"/>
            </div>
            <div class="sd-field">
              <div class="sd-label">Personal Access Token</div>
              <input class="sd-input" id="asana-user-pat" type="password" placeholder="0/xxxxxxxx"/>
            </div>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary" id="asana-user-add">Add / Set up user</button>
          </div>
          <div id="asana-user-status" class="sd-status warn" style="margin-top:6px">\u26A0\uFE0F No Asana users configured</div>
          <div class="sd-field" style="margin-top:10px">
            <div class="sd-label">Configured users</div>
            <div id="asana-user-list" style="font-size:13px"></div>
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

        <!-- Fleet Ops Companion — removed (feature discontinued) -->

      </div>
      <!-- end sd-pane-integrations -->

      <!-- Scheduler settings tab removed (2026-08-14): everything moved to the
           Scheduler VIEW (renderer/src/js/views/schedulers.js).
           - Sync interval + freshness -> the ⚙ gear overlay on that page.
           - Daily Carrier Briefing -> the 📅 Briefing header button overlay.
           The dead "Default scheduler endpoint" field was dropped entirely. -->

      <!-- Operators & SP tab removed (2026-08-14): its only live content (the
           SharePoint Workbooks config) moved to the Scheduler view's SP Push
           gear overlay. Domiciles config lives in the Integrations tab. -->

      <!-- ══ TAB 4: Accounts ════════════════════════════════════════════════ -->
      <div id="sd-pane-accounts" style="display:none">

        <!-- Header -->
        <div class="ops-pane-header">
          <div class="ops-pane-header-left">
            <span class="ops-pane-title">Accounts</span>
            <span class="ops-pane-sub">Every login in one place — edit, reveal, test, or add new</span>
          </div>
          <button class="ops-sync-btn" id="acct-add">+ Add account</button>
        </div>

        <!-- One unified, editable list (vendor portals seeded + any site you add) -->
        <div class="acct-list" id="acct-list">
          <div class="acct-empty" id="acct-empty" style="display:none">
            <span style="font-size:28px;opacity:.5">🔑</span>
            <div class="ops-empty-title">No accounts yet</div>
            <div class="ops-empty-sub">Click <strong>+ Add account</strong> to save a login.</div>
          </div>
        </div>

      </div>
      <!-- end sd-pane-accounts -->

    </div>
    <!-- end sd-body -->

  </div>
  <!-- end settings-drawer -->

  <!-- AI Config overlay (opened from the toolbar AI status pill) -->
  <div id="ai-config-overlay" class="ai-config-overlay">
    <div class="ai-config-panel">
      <button class="ai-config-close" id="ai-config-close" title="Close">✕</button>
        <!-- AI Config -->
        <div class="sd-section" id="sect-ai-config">
          <div class="sd-section-title" style="display:flex;align-items:center;gap:8px">
            🤖 AI Config
            <span id="ai-config-live-status" style="font-size:10px;padding:2px 10px;border-radius:10px;background:#21262d;color:#8b949e;font-weight:500">⏳ checking...</span>
          </div>

          <!-- Preference selector -->
          <div class="sd-field" style="margin-bottom:14px">
            <div class="sd-label" style="margin-bottom:8px">Active AI</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <label style="display:flex;align-items:center;gap:5px;cursor:pointer;padding:5px 10px;border-radius:6px;border:1px solid var(--bdr);font-size:11px;transition:border-color .2s" id="ai-chip-auto">
                <input type="radio" name="ai-pref" value="auto" style="accent-color:#58a6ff"> Auto (fallback chain)
              </label>
              <label style="display:flex;align-items:center;gap:5px;cursor:pointer;padding:5px 10px;border-radius:6px;border:1px solid var(--bdr);font-size:11px;transition:border-color .2s" id="ai-chip-orcha">
                <input type="radio" name="ai-pref" value="orcha" style="accent-color:#22c55e"> Orcha only
              </label>
              <label style="display:flex;align-items:center;gap:5px;cursor:pointer;padding:5px 10px;border-radius:6px;border:1px solid var(--bdr);font-size:11px;transition:border-color .2s" id="ai-chip-claude">
                <input type="radio" name="ai-pref" value="claude" style="accent-color:#818cf8"> Claude Code only
              </label>
              <label style="display:flex;align-items:center;gap:5px;cursor:pointer;padding:5px 10px;border-radius:6px;border:1px solid var(--bdr);font-size:11px;transition:border-color .2s" id="ai-chip-balanced">
                <input type="radio" name="ai-pref" value="balanced" style="accent-color:#f0a800"> Balanced (Orcha + Claude)
              </label>
            </div>
            <div id="ai-pref-hint" style="margin-top:5px;font-size:10px;color:#6e7681;font-style:italic">Auto: tries Orcha first, falls back to Claude Code if quota is exceeded.</div>
          </div>

          <!-- Orcha subsection -->
          <div style="border:1px solid var(--bdr);border-radius:6px;padding:10px 12px;margin-bottom:10px">
            <div style="font-size:9px;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">⚡ Orcha</div>
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
            <div class="sd-field" style="margin-top:8px">
              <div class="sd-label" style="display:flex;align-items:center;justify-content:space-between">
                <span>Orcha Agent (model)</span>
                <button class="sd-btn secondary" id="refresh-orcha-agents" style="font-size:10px;padding:2px 8px">Refresh list</button>
              </div>
              <select class="sd-select" id="orcha-agent" style="font-size:11px">
                <!-- Fallback defaults, shown until live discovery replaces them
                     with the real per-agent model read from ~/.orcha/agents. -->
                <option value="orcha_default">Orcha — Claude Opus 4.6</option>
                <option value="migration">Migration — Claude Opus 4.6</option>
                <option value="moon">Moon — Claude Sonnet 4.6</option>
                <option value="mirror">Mirror — Claude Sonnet 4.6</option>
                <option value="otter">Otter — Claude Sonnet 4.6</option>
                <option value="tides_workflow_runner">Tides Workflow Runner — Claude Sonnet 4.6</option>
              </select>
              <div id="orcha-agent-hint" style="margin-top:4px;font-size:10px;color:#6e7681;font-style:italic">The Orcha agent that answers AI requests (FAS, Fleet Chat, auto-reply). The model is chosen server-side by the agent. This list is discovered live from your Orcha toolbox.</div>
            </div>
            <div class="sd-field" style="margin-top:8px">
              <div class="sd-label">Fallback Model ID (Bedrock)</div>
              <input class="sd-input" id="ai-model-id" placeholder="us.amazon.nova-pro-v1:0" style="font-family:monospace;font-size:10px"/>
              <div style="margin-top:4px;font-size:10px;color:#6e7681;font-style:italic">Bedrock model used only when Orcha WS is down and the app calls Bedrock directly. Leave blank to use the app default.</div>
            </div>
            <div class="sd-btn-row" style="margin-top:8px">
              <button class="sd-btn secondary" id="test-orcha" style="font-size:11px">Test Orcha</button>
            </div>
            <div id="orcha-test-status" style="margin-top:4px;font-size:11px;min-height:14px"></div>
          </div>

          <!-- Claude Code subsection -->
          <div style="border:1px solid var(--bdr);border-radius:6px;padding:10px 12px;margin-bottom:12px">
            <div style="font-size:9px;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">🧠 Claude Code</div>
            <div class="sd-field">
              <div class="sd-label">Binary (auto-detected)</div>
              <input class="sd-input" id="claude-bin-path" placeholder="(auto)" readonly style="color:#6e7681;font-size:10px;font-family:monospace"/>
            </div>
            <div class="sd-field" style="margin-top:6px">
              <div class="sd-label" style="display:flex;align-items:center;justify-content:space-between">
                <span>Model</span>
                <button class="sd-btn secondary" id="detect-claude-model" style="font-size:10px;padding:2px 8px">Detect current</button>
              </div>
              <select class="sd-select" id="claude-model" style="font-size:11px">
                <option value="">Default (let Claude Code decide)</option>
                <option value="claude-opus-5-5">Opus 5.5 — smartest, slow</option>
                <option value="claude-sonnet-5-5">Sonnet 5.5 — balanced (recommended)</option>
                <option value="claude-haiku-5-5">Haiku 5.5 — fastest</option>
                <option value="claude-fable-5-1">Fable 5.1</option>
              </select>
              <div id="claude-model-hint" style="margin-top:4px;font-size:10px;color:#6e7681;font-style:italic">Model for the Claude Code lane (fallback AI + attachment/screenshot reading). Blank = Claude Code's own default.</div>
            </div>
            <div class="sd-field" style="margin-top:6px">
              <div class="sd-label">Timeout (seconds)</div>
              <input class="sd-input" id="claude-timeout" type="number" placeholder="60" style="width:80px"/>
            </div>
            <div class="sd-field" style="margin-top:6px">
              <div class="sd-label">Parallel workers</div>
              <select class="sd-input" id="claude-pool" style="width:80px">
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="5">5</option>
              </select>
              <div id="claude-pool-hint" style="margin-top:4px;font-size:10px;color:#6e7681;font-style:italic">How many Claude Code processes run at once. 1 (recommended) avoids a startup file-lock race that caused intermittent timeouts; higher = more concurrency if your machine handles it.</div>
            </div>
            <div class="sd-btn-row">
              <button class="sd-btn secondary" id="test-claude" style="font-size:11px">Test Claude</button>
            </div>
            <div id="claude-test-status" style="margin-top:4px;font-size:11px;min-height:14px"></div>
          </div>

          <div class="sd-btn-row">
            <button class="sd-btn primary" id="save-ai-config">Save AI Config</button>
          </div>
        </div>
    </div>
  </div>
  `;
}

// ── Tab switching ────────────────────────────────────────────────────────────
function _wireTabSwitching() {
  _drawer.querySelectorAll('.sd-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      _drawer.querySelectorAll('.sd-tab').forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      const pane = btn.dataset.pane;
      ['ui', 'integrations', 'accounts'].forEach((p) => {
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

// AI Config overlay (toolbar AI pill). Separate from the settings drawer so it
// can open standalone. Reuses the #sect-ai-config form + its existing wiring.
function _openAIConfig() {
  const ov = document.getElementById('ai-config-overlay');
  if (!ov) return;
  ov.classList.add('open');
  // _loadAIConfig lives inside _wireAIConfig's scope; trigger a reload so the
  // form reflects current config/live status when opened on its own.
  bus.emit('ui:ai-config-reload');
}
function _closeAIConfigOverlay() {
  const ov = document.getElementById('ai-config-overlay');
  if (ov) ov.classList.remove('open');
}

// _wireDomiciles() removed (2026-08-14): Domiciles editor moved to the 👤 User
// Profile popover (toolbar.js). Same settings:save/reset-domiciles backend.

// _checkAuth()/_wireAuth() removed (2026-08-14): Midway Auth section moved out
// of Settings — run mwinit via Ctrl+M; re-auth modal handles session expiry.

// ── Section: Orcha ───────────────────────────────────────────────────────────
function _wireOrcha() { _wireAIConfig(); }

function _wireAIConfig() {
  // ── Load current config into form fields ──────────────────────────────
  async function _loadAIConfig() {
    // Live status badge
    if (window.ai && window.ai.status) {
      window.ai.status().then(_updateLiveStatus).catch(() => _updateLiveStatus(null));
    }
    if (!window.ai || !window.ai.getAIConfig) return;
    const cfg = await window.ai.getAIConfig().catch(() => null);
    if (!cfg) return;
    // Preference radio
    const radio = document.querySelector('input[name="ai-pref"][value="' + (cfg.aiPreference || 'auto') + '"]');
    if (radio) { radio.checked = true; _updateChipStyles(cfg.aiPreference || 'auto'); }
    _updatePrefHint(cfg.aiPreference || 'auto');
    // Orcha fields
    const modeEl = document.getElementById('orcha-mode');
    const hostEl = document.getElementById('orcha-host');
    const portEl = document.getElementById('orcha-port');
    if (modeEl) modeEl.value = cfg.mode || 'local';
    if (hostEl) hostEl.value = cfg.host || '';
    if (portEl) portEl.value = cfg.port || 4799;
    // Orcha agent (selects the server-side model) — defaults to orcha_default.
    // Populate the dropdown LIVE from `orcha --list-agents` so it always shows
    // exactly the agents this machine can call (the hardcoded <option>s are
    // just a fallback shown until/unless discovery succeeds).
    const agentEl = document.getElementById('orcha-agent');
    const wanted = cfg.orchaAgentId || 'orcha_default';
    if (agentEl) agentEl.value = wanted;
    _populateOrchaAgents(wanted);
    // Model ID (Bedrock fallback leg) — blank field means "use app default"
    const modelEl = document.getElementById('ai-model-id');
    if (modelEl) modelEl.value = cfg.modelId || '';
    // Claude fields
    const binEl  = document.getElementById('claude-bin-path');
    const toEl   = document.getElementById('claude-timeout');
    if (binEl) binEl.value = cfg.claudeBin || '(auto)';
    if (toEl)  toEl.value  = Math.round((cfg.claudeTimeoutMs || 60000) / 1000);
    const poolEl = document.getElementById('claude-pool');
    if (poolEl) poolEl.value = String(Math.min(5, Math.max(1, cfg.claudePoolSize || 1)));
    // Claude-lane model. If the saved id isn't one of the known options, add it
    // so the selection is never silently lost.
    const cmEl = document.getElementById('claude-model');
    if (cmEl) {
      const saved = cfg.claudeModelId || '';
      if (saved && !Array.from(cmEl.options).some(o => o.value === saved)) {
        const opt = document.createElement('option');
        opt.value = saved; opt.textContent = saved; cmEl.appendChild(opt);
      }
      cmEl.value = saved;
    }
  }

  // Replace the Orcha-agent dropdown's options with the LIVE discovered list,
  // including the REAL model each agent maps to (read from the agent's config
  // file, not a hardcoded guess). Keeps `selected` chosen even if it isn't in
  // the discovered set (so a saved agent id is never silently lost), and falls
  // back to the hardcoded options already in the DOM if discovery is unavailable.
  async function _populateOrchaAgents(selected, opts) {
    const agentEl = document.getElementById('orcha-agent');
    const hintEl = document.getElementById('orcha-agent-hint');
    if (!agentEl || !window.ai || !window.ai.listOrchaAgents) return;
    let res = null;
    try { res = await window.ai.listOrchaAgents(opts || {}); } catch (_) { res = null; }
    if (!res || !res.ok || !Array.isArray(res.agents) || !res.agents.length) {
      if (hintEl && res && res.error) {
        hintEl.textContent = 'Could not discover agents live (' + res.error + ') — showing built-in defaults.';
      }
      return; // keep the hardcoded fallback options already in the DOM
    }
    const want = selected || agentEl.value || 'orcha_default';
    const agents = res.agents.slice();
    // Ensure the currently-selected agent is present even if discovery omitted it.
    if (want && !agents.some(a => a.id === want)) agents.unshift({ id: want, name: want });
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    agentEl.innerHTML = agents.map(a => {
      // Prefer the live-discovered model label; fall back to nothing if unknown.
      const label = a.name + (a.modelLabel ? ' — ' + a.modelLabel : '');
      const sel = a.id === want ? ' selected' : '';
      return '<option value="' + esc(a.id) + '"' + sel + '>' + esc(label) + '</option>';
    }).join('');
    agentEl.value = want;
    if (hintEl) {
      const picked = agents.find(a => a.id === want);
      const pickedModel = picked && picked.modelLabel ? (' Current: ' + picked.modelLabel + '.') : '';
      hintEl.textContent = 'The Orcha agent that answers AI requests (FAS, Fleet Chat, auto-reply); the model shown is ' +
        'what each agent maps to server-side. ' + agents.length + ' agent(s) discovered live' +
        (res.cached ? ' (cached)' : '') + '.' + pickedModel;
    }
  }

  function _updateLiveStatus(st) {
    const el = document.getElementById('ai-config-live-status');
    if (!el) return;
    const s = st && st.status;
    const MAP = {
      'connected':         { text: '🟢 Orcha connected',  bg: '#1a2f1a', color: '#22c55e' },
      'connected-claude':  { text: '🔵 Claude active',    bg: '#1c1c30', color: '#818cf8' },
      'connected-bedrock': { text: '🟠 Bedrock active',   bg: '#2a1e0a', color: '#f59e0b' },
      'error':             { text: '🔴 AI offline',       bg: '#2f1a1a', color: '#f85149' },
      'unknown':           { text: '⏳ Checking...',      bg: '#21262d', color: '#8b949e' },
    };
    const d = MAP[s] || MAP.unknown;
    el.textContent = d.text; el.style.background = d.bg; el.style.color = d.color;
  }

  function _updatePrefHint(pref) {
    const hints = {
      auto:     'Auto: tries Orcha first, falls back to Claude Code if quota is exceeded.',
      orcha:    'Orcha only: no Claude fallback. AI is unavailable if Orcha quota runs out.',
      claude:   'Claude Code only: skips Orcha, uses Cecelia shared Bedrock via claude -p.',
      balanced: 'Balanced: runs Orcha + Claude as two lanes — when one is busy the next request uses the other, so work goes faster. If one is down, everything uses the other automatically.',
    };
    const el = document.getElementById('ai-pref-hint');
    if (el) el.textContent = hints[pref] || '';
  }

  function _updateChipStyles(pref) {
    ['auto', 'orcha', 'claude', 'balanced'].forEach(p => {
      const chip = document.getElementById('ai-chip-' + p);
      if (!chip) return;
      chip.style.borderColor = p === pref ? 'var(--acc)' : 'var(--bdr)';
      chip.style.background  = p === pref ? 'rgba(88,166,255,.08)' : '';
    });
  }

  // ── Preference radio change ────────────────────────────────────────────
  document.querySelectorAll('input[name="ai-pref"]').forEach(radio => {
    radio.addEventListener('change', () => {
      _updatePrefHint(radio.value);
      _updateChipStyles(radio.value);
    });
  });

  // ── Save ──────────────────────────────────────────────────────────────
  const saveBtn = document.getElementById('save-ai-config');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const pref    = (document.querySelector('input[name="ai-pref"]:checked') || {}).value || 'auto';
    const toSecs  = parseInt((document.getElementById('claude-timeout') || {}).value, 10) || 60;
    const poolN   = parseInt((document.getElementById('claude-pool') || {}).value, 10) || 1;
    await window.ai.saveAIConfig({
      aiPreference:    pref,
      mode:            (document.getElementById('orcha-mode') || {}).value || 'local',
      host:            ((document.getElementById('orcha-host') || {}).value || '').trim(),
      port:            parseInt((document.getElementById('orcha-port') || {}).value, 10) || 4799,
      orchaAgentId:    (document.getElementById('orcha-agent') || {}).value || 'orcha_default',
      modelId:         ((document.getElementById('ai-model-id') || {}).value || '').trim(),
      claudeModelId:   ((document.getElementById('claude-model') || {}).value || '').trim(),
      claudeTimeoutMs: toSecs * 1000,
      claudePoolSize:  Math.min(5, Math.max(1, poolN)),
    });
    toast.show('success', 'AI config saved — active: ' + pref, 2500);
    window.ai.status().then(_updateLiveStatus).catch(() => {});
  });

  // ── Test Orcha ────────────────────────────────────────────────────────
  const testOrchaBtn = document.getElementById('test-orcha');
  if (testOrchaBtn) testOrchaBtn.addEventListener('click', async () => {
    const statusEl = document.getElementById('orcha-test-status');
    testOrchaBtn.disabled = true; testOrchaBtn.textContent = 'Testing...';
    if (statusEl) { statusEl.textContent = '⏳ Connecting to Orcha...'; statusEl.style.color = '#94a3b8'; }
    try {
      const result = await window.ai.test();
      if (result && result.ok) {
        const model = (result.model || '').split('/').pop().split(':')[0];
        if (statusEl) { statusEl.textContent = '✅ Connected — "' + (result.response || 'OK').slice(0, 40) + '" | ' + model; statusEl.style.color = '#22c55e'; }
      } else {
        if (statusEl) { statusEl.textContent = '❌ ' + (result.lastError || result.status || 'No response'); statusEl.style.color = '#ef4444'; }
      }
    } catch (e) {
      if (statusEl) { statusEl.textContent = '❌ ' + e.message; statusEl.style.color = '#ef4444'; }
    } finally { testOrchaBtn.disabled = false; testOrchaBtn.textContent = 'Test Orcha'; }
  });

  // ── Refresh Orcha agent list (live discovery via `orcha --list-agents`) ──
  const refreshAgentsBtn = document.getElementById('refresh-orcha-agents');
  if (refreshAgentsBtn) refreshAgentsBtn.addEventListener('click', async () => {
    const agentEl = document.getElementById('orcha-agent');
    const keep = agentEl ? agentEl.value : null;
    refreshAgentsBtn.disabled = true; refreshAgentsBtn.textContent = 'Refreshing...';
    try { await _populateOrchaAgents(keep, { force: true }); }
    finally { refreshAgentsBtn.disabled = false; refreshAgentsBtn.textContent = 'Refresh list'; }
  });

  // ── Detect the Claude Code lane's current model ─────────────────────────
  const detectClaudeBtn = document.getElementById('detect-claude-model');
  if (detectClaudeBtn) detectClaudeBtn.addEventListener('click', async () => {
    const hintEl = document.getElementById('claude-model-hint');
    detectClaudeBtn.disabled = true; detectClaudeBtn.textContent = 'Detecting...';
    if (hintEl) hintEl.textContent = '⏳ Asking Claude Code what it is running on...';
    try {
      const r = await window.ai.detectClaudeModel();
      if (r && r.ok && r.model) {
        if (hintEl) hintEl.textContent = 'Currently running on: ' + r.model + '. (This is the model when "Default" is selected; pick a specific one above to pin it.)';
      } else {
        if (hintEl) hintEl.textContent = 'Could not detect the current model' + (r && r.error ? ' (' + r.error + ')' : '') + '.';
      }
    } catch (e) {
      if (hintEl) hintEl.textContent = 'Detection failed: ' + e.message;
    } finally { detectClaudeBtn.disabled = false; detectClaudeBtn.textContent = 'Detect current'; }
  });

  // ── Test Claude ───────────────────────────────────────────────────────
  const testClaudeBtn = document.getElementById('test-claude');
  if (testClaudeBtn) testClaudeBtn.addEventListener('click', async () => {
    const statusEl = document.getElementById('claude-test-status');
    testClaudeBtn.disabled = true; testClaudeBtn.textContent = 'Testing...';
    if (statusEl) { statusEl.textContent = '⏳ Calling claude -p...'; statusEl.style.color = '#94a3b8'; }
    try {
      const result = await window.ai.testClaude();
      if (result && result.ok) {
        if (statusEl) { statusEl.textContent = '✅ Online — "' + (result.response || '').slice(0, 60) + '"'; statusEl.style.color = '#818cf8'; }
      } else {
        if (statusEl) { statusEl.textContent = '❌ ' + (result.error || 'Failed'); statusEl.style.color = '#ef4444'; }
      }
    } catch (e) {
      if (statusEl) { statusEl.textContent = '❌ ' + e.message; statusEl.style.color = '#ef4444'; }
    } finally { testClaudeBtn.disabled = false; testClaudeBtn.textContent = 'Test Claude'; }
  });

  // Load config when drawer opens
  _loadAIConfig();
  bus.on('ui:view-change', ({ to }) => { if (to === 'settings') setTimeout(_loadAIConfig, 150); });
  // Reload when the standalone AI Config overlay is opened from the toolbar.
  bus.on('ui:ai-config-reload', () => setTimeout(_loadAIConfig, 50));
}

// ── Known vendor portals (for the unified Accounts list) ─────────────────────
// Each known vendor portal that the background scraper can auto-login to. These
// are SEEDED as rows in the one Accounts list so they're always present. A row
// is recognized as a vendor by matching its URL host against `host` here. The
// `id` is the vendorId used by the keychain (vendor.<id>.username/password) and
// by credentials:test-login — so saving a vendor row MIRRORS its user/pass into
// the keychain to keep auto-login (getForHostname) working unchanged. 'sso'
// vendors (Uptake) use Amazon Midway, no stored password — just a Test/Sign-in.
const _VENDORS = [
  { id: 'paccar',    name: 'PACCAR',                  host: 'paccarpg.decisiv.net' },
  { id: 'volvo',     name: 'Volvo',                   host: 'volvopg.asist.decisiv.net' },
  { id: 'record360', name: 'Record360',               host: 'dashboard.record360.com' },
  { id: 'aperia',    name: 'Aperia / Halo Tire',      host: 'amazon.aperiatech.com' },
  { id: 'reach24',   name: 'Reach24',                 host: 'amazon.reach24.net' },
  { id: 'dtna',      name: 'DTNA Service Tracker',    host: 'dtna.my.site.com' },
  { id: 'roadready', name: 'Road Ready',              host: 'roadready.fadv.com' },
  { id: 'velogic',   name: 'Velogic',                 host: 'velogic.my.site.com' },
  { id: 'abs',       name: 'Access Billing Services', host: 'access-billing-services.com' },
  { id: 'uptake',    name: 'Uptake',                  host: 'fleet.uptake.com', sso: true },
];
const _VENDOR_BY_ID = Object.fromEntries(_VENDORS.map(v => [v.id, v]));

// Resolve a row's URL/host string to a known vendor (or null). Matches on
// hostname substring so 'https://paccarpg.decisiv.net/x' maps to paccar.
function _vendorForUrl(urlOrHost) {
  const s = String(urlOrHost || '').toLowerCase();
  if (!s) return null;
  for (const v of _VENDORS) { if (s.indexOf(v.host) !== -1) return v; }
  return null;
}

// ── Section: Slack ───────────────────────────────────────────────────────────
function _checkSlack() {
  // BUG FIX (2026-07-16): was checkAuth().then((ok) => ...) — checkAuth()
  // resolves to an OBJECT ({ authenticated: bool }), not a boolean. Since a
  // non-null object is always truthy, `ok ? 'Connected' : 'Not connected'`
  // showed "Connected" every single time the promise resolved, regardless
  // of actual auth state — this status indicator has never once correctly
  // shown "Not connected." Also switched to checkLiveAuth(), which confirms
  // the token still actually works (Slack sessions can be revoked without
  // the local token file changing) rather than just checking a file exists.
  slackBridge.checkLiveAuth().then((res) => {
    const ok = !!(res && res.authenticated);
    const el = document.getElementById('slack-status');
    if (!el) return;
    el.textContent = ok ? '✅ Connected' : '⚠️ Not connected';
    el.className = `sd-status ${ok ? 'ok' : 'warn'}`;
  }).catch(() => {});
}

// _wireEmail() removed (2026-08-14): Email (SMTP) settings section deleted —
// user sends via OWA only. Send pipeline falls through to OWA automatically.

// FEATURE (2026-07-16): persisted note for scheduled auto-sends (08:00 /
// 15:15). Stored via the generic settings:save IPC under keys
// `autoEmailNote` / `autoEmailNoteOneShot` — read fresh by the scheduler in
// src/app.js on every fire, so edits here take effect on the very next slot.
// _wireAutoNote() removed (2026-08-14): the Auto-Email Note moved to a gear
// overlay on the Scheduler view's Email card (renderer/src/js/views/schedulers.js).
// Same storage keys (autoEmailNote / autoEmailNoteOneShot) so behavior is
// unchanged — the scheduler reads them fresh on every auto-send.

// _wireSchedulerConfig() removed (2026-08-14): the Schedulers-Config section
// (sync interval) moved to the Scheduler view's ⚙ gear overlay. The dead
// "Default scheduler endpoint" field was dropped. Sync interval is still
// backed by settings:get/save-sync-interval, now driven from that overlay.

function _wireSlack() {
  _checkSlack();
  var recheckBtn = document.getElementById('slack-recheck');
  var loginBtn = document.getElementById('slack-login');
  if (recheckBtn) recheckBtn.addEventListener('click', _checkSlack);
  if (loginBtn) loginBtn.addEventListener('click', () => {
    // BUG FIX (2026-07-16): was .catch(() => {}) -- swallowed every login
    // failure silently, with no feedback at all if the popup window was
    // closed before sign-in completed or any other error occurred.
    loginBtn.disabled = true;
    const originalText = loginBtn.textContent;
    loginBtn.textContent = 'Signing in\u2026';
    slackBridge.login().then((result) => {
      if (result && result.ok) {
        toast.show('success', 'Signed in to Slack', 3000);
      } else {
        toast.show('warn', (result && result.error) || 'Sign-in was not completed', 4000);
      }
      _checkSlack();
    }).catch((e) => {
      toast.show('error', 'Slack sign-in failed: ' + e.message, 4000);
    }).finally(() => {
      loginBtn.disabled = false;
      loginBtn.textContent = originalText;
    });
  });

  // FEATURE (2026-07-16): lets the user cleanly reset a stuck/stale Slack
  // session instead of having no way to force a fresh sign-in.
  var logoutBtn = document.getElementById('slack-logout');
  if (logoutBtn) logoutBtn.addEventListener('click', () => {
    slackBridge.logout().then(() => {
      toast.show('info', 'Signed out of Slack', 2500);
      _checkSlack();
    }).catch((e) => toast.show('error', 'Sign-out failed: ' + e.message, 3000));
  });
}

// Microsoft Graph mail section was removed (2026-09-02). Email uses SMTP or
// the authenticated OWA browser session only; there is no Outlook sign-in UI.

// -- Section: Partner Auto-Reply (AI) (2026-07-21, extended 2026-07-22) --
// see src/scrapers/slack_channel_watch.js for the full design/safety
// writeup. Master on/off + per-channel toggles + add-by-ID.
//
// FEATURE (2026-07-22): channel list is no longer a fixed set of 4 --
// users can add any channel by ID. Slack's conversations.list /
// users.conversations are both hard-blocked on this Enterprise Grid
// workspace (enterprise_is_restricted, confirmed live), so a real browse
// list isn't possible here; ID entry + a live conversations.info
// membership check (also confirmed live, unrestricted) is the safe
// alternative -- it verifies the user is actually a member before the
// channel is ever added to the watch list, and is simpler/less
// error-prone than name search per the user's own request.
// Operator codes from the latest fleet scan, for per-channel data-scope pickers.
function _parFleetOperators() {
  try {
    const rows = (state.slice('fleet').rows) || [];
    const set = {};
    rows.forEach(function(r){ const o=(r.operator||'').trim(); if(o) set[o.toUpperCase()]=true; });
    return Object.keys(set).sort();
  } catch(e){ return []; }
}
function _parOperatorOptions(selected) {
  const sel = (selected||[]).map(function(s){ return String(s||'').toUpperCase(); });
  return _parFleetOperators().map(function(op){
    const s = sel.indexOf(op)!==-1 ? ' selected' : '';
    return '<option value="' + _esc(op) + '"' + s + '>' + _esc(op) + '</option>';
  }).join('');
}
// Checkbox list for per-channel operator scope — clearer than a native
// multi-select (no Ctrl+click needed, no accidental single-select reset).
function _parOperatorCheckboxes(idx, selected) {
  const sel = (selected||[]).map(function(s){ return String(s||'').toUpperCase(); });
  const ops = _parFleetOperators();
  if (!ops.length) return '<div style="font-size:9px;color:var(--mut)">No operators yet — waiting for fleet data…</div>';
  return '<div style="display:flex;flex-wrap:wrap;gap:6px">' + ops.map(function(op){
    const chk = sel.indexOf(op)!==-1 ? ' checked' : '';
    return '<label style="display:inline-flex;align-items:center;gap:3px;font-size:10px;color:var(--txt);cursor:pointer">' +
      '<input type="checkbox" class="par-ch-op" data-idx="' + idx + '" value="' + _esc(op) + '"' + chk + ' style="margin:0"/>' + _esc(op) +
      '</label>';
  }).join('') + '</div>';
}
function _wirePartnerAutoReply() {
  const enabledEl       = document.getElementById('par-enabled');
  const listEl          = document.getElementById('par-channel-list');
  const saveBtn         = document.getElementById('par-save');
  const statusEl        = document.getElementById('par-status');
  const addIdEl         = document.getElementById('par-add-id');
  const addBtn          = document.getElementById('par-add-btn');
  const scanBtn         = document.getElementById('par-scan-btn');
  const addManualToggle = document.getElementById('par-add-manual-toggle');
  const addManualEl     = document.getElementById('par-add-manual');
  if (!enabledEl || !listEl || !saveBtn) return;

  function showStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'sd-status ' + (cls || '');
    statusEl.style.display = '';
  }

  function _relTime(ms) {
    if (!ms) return 'never';
    const diff = Date.now() - ms;
    if (diff < 60000)    return 'just now';
    if (diff < 3600000)  return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  let _currentConfig = null;
  let _replyCounts   = {};

  async function _autoSave() {
    if (!_currentConfig) return;
    _currentConfig.enabled = !!enabledEl.checked;
    try {
      await slackBridge.saveChannelWatchConfig(_currentConfig);
    } catch (e) {
      showStatus('Auto-save failed: ' + e.message, 'err');
    }
  }

  function render(config) {
    _currentConfig = config;
    enabledEl.checked = !!config.enabled;
    const channels = config.channels || [];
    if (!channels.length) {
      listEl.innerHTML = '<div class="sd-hint">No channels yet — click "Scan my channels" to discover all channels you are in, or use "+ Add by ID" to add one manually.</div>';
      return;
    }
    listEl.innerHTML = channels.map((ch, i) => {
      const chMode   = ch.replyMode || config.replyMode || 'mentions';
      const lastSeen = _relTime(ch.lastSeenTs ? parseFloat(ch.lastSeenTs) * 1000 : 0);
      const count    = _replyCounts[ch.id] || 0;
      const modeDesc = chMode === 'occasional'
        ? 'Replies to @mentions, thread follow-ups, and relevant messages'
        : chMode === 'justme'
        ? 'Personal channel: every message treated as a direct question or command'
        : 'Replies to @mentions and messages clearly directed at you';
      return `<div style="background:var(--el);border:1px solid var(--bdr);border-radius:8px;padding:10px 12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-size:11px;color:var(--txt2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            <span style="color:var(--acc2)">#</span>${_esc(ch.name)}
            <span style="color:var(--mut);font-size:9px;margin-left:4px">${_esc(ch.id)}</span>
          </span>
          <input type="checkbox" id="par-ch-${i}" ${ch.enabled !== false ? 'checked' : ''}/>
          <button class="sd-btn danger par-ch-remove" data-idx="${i}" type="button" style="padding:2px 8px;font-size:10px;border-radius:5px">&#x2715;</button>
        </div>
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
          <button class="sd-font-btn par-mode-btn ${chMode === 'mentions'   ? 'active' : ''}" data-idx="${i}" data-mode="mentions"   type="button" style="font-size:9px;padding:3px 10px">Mentions</button>
          <button class="sd-font-btn par-mode-btn ${chMode === 'occasional' ? 'active' : ''}" data-idx="${i}" data-mode="occasional" type="button" style="font-size:9px;padding:3px 10px">Occasional</button>
          <button class="sd-font-btn par-mode-btn ${chMode === 'justme'     ? 'active' : ''}" data-idx="${i}" data-mode="justme"     type="button" style="font-size:9px;padding:3px 10px">Just Me</button>
          <span style="margin-left:auto;font-size:9px;color:var(--mut)">${count ? count + ' ' + (count === 1 ? 'reply' : 'replies') + ' \u00b7 ' : ''}${lastSeen}</span>
        </div>
        <div style="font-size:9px;color:var(--mut);margin-top:6px;padding-top:5px;border-top:1px solid rgba(48,54,61,.6)">${modeDesc}</div>
        <label style="display:flex;align-items:flex-start;gap:6px;font-size:9px;color:var(--txt2);margin-top:6px;padding-top:5px;border-top:1px solid rgba(48,54,61,.6);cursor:pointer">
          <input type="checkbox" class="par-pmalert" data-idx="${i}" ${ch.pmAlertAutoReply === true ? 'checked' : ''} style="margin-top:1px"/>
          <span>Predictive Maintenance alerts: when I'm tagged (message or thread reply), auto-reply in-thread using fleet data &mdash; cites the existing work order (AMZ) + Relay link if the unit is already down, else acknowledges.</span>
        </label>
        ${chMode !== 'justme' ? `<div style="margin-top:6px;padding-top:5px;border-top:1px solid rgba(48,54,61,.6)">
          <div style="font-size:9px;color:var(--mut);margin-bottom:3px">Operators (data scope) &mdash; empty = full fleet</div>
          ${_parOperatorCheckboxes(i, ch.operators || [])}
        </div>` : ''}
      </div>`;
    }).join('');

    listEl.querySelectorAll('.par-ch-op').forEach((box) => {
      box.addEventListener('change', () => {
        const i = parseInt(box.getAttribute('data-idx'), 10);
        if (_currentConfig && _currentConfig.channels[i]) {
          const checked = Array.from(listEl.querySelectorAll('.par-ch-op[data-idx="' + i + '"]'))
            .filter(function(b){ return b.checked; })
            .map(function(b){ return b.value; });
          _currentConfig.channels[i].operators = checked;
          _autoSave();
        }
      });
    });

    listEl.querySelectorAll('.par-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx  = parseInt(btn.getAttribute('data-idx'), 10);
        const mode = btn.getAttribute('data-mode');
        _currentConfig.channels[idx].replyMode = mode;
        render(_currentConfig);
        _autoSave();
      });
    });

    listEl.querySelectorAll('input[id^="par-ch-"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const i = parseInt(cb.id.replace('par-ch-', ''), 10);
        if (_currentConfig && _currentConfig.channels[i]) {
          _currentConfig.channels[i].enabled = cb.checked;
        }
        _autoSave();
      });
    });

    // PM Alert auto-reply per-channel toggle (additive; separate from replyMode).
    listEl.querySelectorAll('.par-pmalert').forEach((cb) => {
      cb.addEventListener('change', () => {
        const idx = parseInt(cb.getAttribute('data-idx'), 10);
        if (_currentConfig && _currentConfig.channels[idx]) {
          _currentConfig.channels[idx].pmAlertAutoReply = cb.checked;
        }
        _autoSave();
      });
    });

    listEl.querySelectorAll('.par-ch-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx'), 10);
        _currentConfig.channels.splice(idx, 1);
        render(_currentConfig);
        _autoSave();
      });
    });
  }

  // Main enable toggle auto-saves
  enabledEl.addEventListener('change', () => _autoSave());

  Promise.all([
    slackBridge.getChannelWatchConfig(),
    slackBridge.getReplyLog(500),
  ]).then(([config, replyLog]) => {
    _replyCounts = {};
    (replyLog || []).forEach((e) => {
      _replyCounts[e.channelId] = (_replyCounts[e.channelId] || 0) + 1;
    });
    render(config);
  }).catch((e) => {
    showStatus('\u274c Failed to load config: ' + e.message, 'err');
  });

  // Re-render the channel list when fleet data arrives, so the per-channel
  // operator dropdowns populate. This section wires ONCE at app startup —
  // before fleet data is loaded into state — so the first render has no
  // operator options. Repainting on fleet:data (guarded on _currentConfig)
  // backfills the options once a scan lands. Cheap: only rebuilds the list HTML.
  bus.on('fleet:data', () => {
    // Only repaint if the operator options are currently empty (i.e. the first
    // render happened before fleet data existed). Avoids wiping an in-progress
    // selection on every routine sync push once options are already populated.
    if (!_currentConfig) return;
    // Backfill only when operator checkboxes are absent but fleet data now exists
    // (first render happened before fleet data loaded). Avoids wiping edits later.
    const _hasCheckboxes = listEl && listEl.querySelector('.par-ch-op');
    const _hasScopedChannel = (_currentConfig.channels || []).some(function(ch){ return ch.replyMode !== 'justme'; });
    if (!_hasCheckboxes && _hasScopedChannel && _parFleetOperators().length > 0) render(_currentConfig);
  });

  // Scan channels button
  if (scanBtn) {
    scanBtn.addEventListener('click', async () => {
      scanBtn.disabled = true;
      const origText = scanBtn.textContent;
      scanBtn.textContent = 'Scanning...';
      try {
        const channels = await slackBridge.getChannels();
        const eligible = (channels || []).filter(ch => !ch.isIm && !ch.isMpim);
        if (!eligible.length) {
          toast.show('warn', 'No channels found', 3000);
          return;
        }
        if (!_currentConfig) _currentConfig = { enabled: true, channels: [] };
        const existing = new Set(_currentConfig.channels.map(c => c.id));
        let added = 0;
        eligible.forEach(ch => {
          if (!existing.has(ch.id)) {
            _currentConfig.channels.push({ id: ch.id, name: ch.name, enabled: false, lastSeenTs: null, replyMode: 'mentions' });
            added++;
          }
        });
        render(_currentConfig);
        if (added > 0) {
          await _autoSave();
          toast.show('success', 'Found ' + added + ' new channel' + (added === 1 ? '' : 's') + ' \u2014 enable the ones you want, changes save automatically', 5000);
        } else {
          toast.show('info', 'All channels already in the list', 3000);
        }
      } catch (e) {
        toast.show('error', 'Scan failed: ' + e.message, 4000);
      } finally {
        scanBtn.disabled = false;
        scanBtn.textContent = origText;
      }
    });
  }

  // "Add by ID" collapsible toggle
  if (addManualToggle && addManualEl) {
    addManualToggle.addEventListener('click', () => {
      const open = addManualEl.style.display !== 'none';
      addManualEl.style.display = open ? 'none' : '';
      addManualToggle.textContent = open ? '+ Add by ID' : '\u2212 Add by ID';
    });
  }

  if (addBtn && addIdEl) {
    addBtn.addEventListener('click', async () => {
      const id = (addIdEl.value || '').trim();
      if (!id) { toast.show('warn', 'Enter a channel ID first', 2500); return; }
      if (_currentConfig && _currentConfig.channels.some(ch => ch.id === id)) {
        toast.show('warn', 'That channel is already in the list', 2500);
        return;
      }
      addBtn.disabled = true;
      const originalText = addBtn.textContent;
      addBtn.textContent = 'Checking...';
      try {
        const result = await slackBridge.checkChannelMembership(id);
        if (!result.ok) {
          toast.show('error', 'Could not find that channel: ' + (result.error || 'unknown error'), 4000);
          return;
        }
        if (!result.isMember) {
          toast.show('error', 'Found #' + result.name + ', but you are not a member of it \u2014 join it in Slack first, then add it here.', 5000);
          return;
        }
        if (!_currentConfig) _currentConfig = { enabled: true, channels: [] };
        _currentConfig.channels.push({ id, name: result.name, enabled: true, lastSeenTs: null, replyMode: 'mentions' });
        render(_currentConfig);
        addIdEl.value = '';
        await _autoSave();
        toast.show('success', 'Added #' + result.name, 3000);
      } catch (e) {
        toast.show('error', 'Lookup failed: ' + e.message, 4000);
      } finally {
        addBtn.disabled = false;
        addBtn.textContent = originalText;
      }
    });
    addIdEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } });
  }

  // "Use My DM" button — finds user's self-DM and adds it as a Just Me channel
  const addDmBtn = document.getElementById('par-add-dm-btn');
  if (addDmBtn) {
    addDmBtn.addEventListener('click', async () => {
      addDmBtn.disabled = true;
      addDmBtn.textContent = 'Finding...';
      try {
        // Open a conversation with yourself (Slack's conversations.open with no users = self-DM)
        const result = await slackBridge.openConversation({ userId: 'self' });
        if (!result || !result.channelId) {
          toast.show('error', 'Could not find your self-DM. Make sure Slack is authenticated.', 4000);
          return;
        }
        const dmId = result.channelId;
        if (_currentConfig && _currentConfig.channels.some(ch => ch.id === dmId)) {
          toast.show('info', 'Your DM is already in the list', 2500);
          return;
        }
        if (!_currentConfig) _currentConfig = { enabled: true, channels: [] };
        _currentConfig.channels.push({ id: dmId, name: 'My DM (self)', enabled: true, lastSeenTs: null, replyMode: 'justme' });
        render(_currentConfig);
        await _autoSave();
        toast.show('success', 'Added your self-DM as Just Me channel', 3000);
      } catch (e) {
        toast.show('error', 'Failed: ' + e.message, 4000);
      } finally {
        addDmBtn.disabled = false;
        addDmBtn.textContent = '+ Use My DM';
      }
    });
  }

  saveBtn.addEventListener('click', async () => {
    if (!_currentConfig) return;
    await _autoSave();
    showStatus('\u2705 Saved', 'ok');
    toast.show('success', 'Partner Auto-Reply settings saved', 2500);
  });
}

// FEATURE (2026-07-22): _opsEmailAutoSave() removed -- it was dead code
// with no caller (its "Global SMTP" HTML panel was removed above for the
// same reason) and would have thrown ReferenceError on _opsEmailTimers
// (never declared anywhere in this codebase) had it ever actually run.
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

// ── Operator Channels (PM-alert carrier fan-out mapping) ──────────────────────
function _wireOperatorChannels() {
  const listEl     = document.getElementById('opc-list');
  const populateBtn= document.getElementById('opc-populate-btn');
  const addBtn     = document.getElementById('opc-add-btn');
  const saveBtn    = document.getElementById('opc-save');
  const statusEl   = document.getElementById('opc-status');
  if (!listEl || !saveBtn) return;

  let _cfg = { operators: [] };
  // Track owner-search timers per-row so we debounce directory lookups.
  const _ownerTimers = {};

  function showStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'sd-status ' + (cls || '');
    statusEl.style.display = '';
  }
  const _esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function _save() {
    try { await slackBridge.saveOperatorChannels(_cfg); }
    catch (e) { showStatus('Auto-save failed: ' + e.message, 'err'); }
  }

  function render() {
    if (!_cfg.operators.length) {
      listEl.innerHTML = '<div class="sd-hint">No operators yet — click "Populate from fleet" to load your operators, then set each one\'s channel + owner.</div>';
      return;
    }
    listEl.innerHTML = _cfg.operators.map((o, i) => `
      <div style="background:var(--el);border:1px solid var(--bdr);border-radius:8px;padding:10px 12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <input class="sd-input opc-operator" data-idx="${i}" value="${_esc(o.operator)}" placeholder="Operator (e.g. TUZR)" style="flex:1;font-size:11px;font-weight:600"/>
          <button class="sd-btn danger opc-remove" data-idx="${i}" type="button" style="padding:2px 8px;font-size:10px;border-radius:5px">&#x2715;</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <input class="sd-input opc-channel" data-idx="${i}" value="${_esc(o.channelId)}" placeholder="Carrier channel ID (e.g. C0B4H2JJS06)" style="font-size:11px"/>
          <div style="position:relative">
            <input class="sd-input opc-owner" data-idx="${i}" value="${_esc(o.ownerName)}" placeholder="Operator owner — search Slack contacts to tag" style="font-size:11px"/>
            <div class="opc-owner-results" data-idx="${i}" style="display:none;position:absolute;left:0;right:0;top:100%;z-index:20;background:var(--el);border:1px solid var(--bdr);border-radius:6px;margin-top:2px;max-height:160px;overflow:auto"></div>
          </div>
          <div style="font-size:9px;color:var(--mut)">${o.ownerId ? 'Owner tag: &lt;@' + _esc(o.ownerId) + '&gt;' : 'No owner selected — carrier message will post without a tag'}</div>
        </div>
      </div>`).join('');

    // Operator code edits
    listEl.querySelectorAll('.opc-operator').forEach((el) => {
      el.addEventListener('change', () => {
        const i = parseInt(el.getAttribute('data-idx'), 10);
        _cfg.operators[i].operator = el.value.trim();
        _save();
      });
    });
    // Channel id edits
    listEl.querySelectorAll('.opc-channel').forEach((el) => {
      el.addEventListener('change', () => {
        const i = parseInt(el.getAttribute('data-idx'), 10);
        _cfg.operators[i].channelId = el.value.trim();
        _save();
      });
    });
    // Remove row
    listEl.querySelectorAll('.opc-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.getAttribute('data-idx'), 10);
        _cfg.operators.splice(i, 1);
        render();
        _save();
      });
    });
    // Owner search (debounced directory lookup)
    listEl.querySelectorAll('.opc-owner').forEach((el) => {
      const i = parseInt(el.getAttribute('data-idx'), 10);
      const resultsEl = listEl.querySelector('.opc-owner-results[data-idx="' + i + '"]');
      el.addEventListener('input', () => {
        // Typing a fresh name invalidates the previously-picked owner id until
        // they select one from the results.
        const q = el.value.trim();
        clearTimeout(_ownerTimers[i]);
        if (!q || q.length < 2) { if (resultsEl) resultsEl.style.display = 'none'; return; }
        _ownerTimers[i] = setTimeout(async () => {
          try {
            const results = await slackBridge.searchDirectory({ query: q, limit: 6 });
            const people = (results || []).filter((r) => r.type === 'user');
            if (!people.length) { resultsEl.innerHTML = '<div style="padding:6px 8px;font-size:10px;color:var(--mut)">No matches</div>'; resultsEl.style.display = ''; return; }
            resultsEl.innerHTML = people.map((p) =>
              `<div class="opc-owner-pick" data-idx="${i}" data-id="${_esc(p.id)}" data-name="${_esc(p.name)}" style="padding:6px 8px;font-size:11px;cursor:pointer;border-bottom:1px solid rgba(48,54,61,.5)">${_esc(p.name)}</div>`
            ).join('');
            resultsEl.style.display = '';
            resultsEl.querySelectorAll('.opc-owner-pick').forEach((row) => {
              row.addEventListener('click', () => {
                const idx = parseInt(row.getAttribute('data-idx'), 10);
                _cfg.operators[idx].ownerId = row.getAttribute('data-id');
                _cfg.operators[idx].ownerName = row.getAttribute('data-name');
                render();
                _save();
              });
            });
          } catch (e) {
            if (resultsEl) { resultsEl.innerHTML = '<div style="padding:6px 8px;font-size:10px;color:var(--err,#f66)">Search failed</div>'; resultsEl.style.display = ''; }
          }
        }, 350);
      });
    });
  }

  // Resolve any owner whose stored name is missing or is just the raw Slack id
  // (e.g. "U0A8X5TTANR") into a real display name, then persist + re-render.
  async function _resolveOwnerNames() {
    let changed = false;
    for (const o of _cfg.operators) {
      const looksLikeId = o.ownerName && /^U[A-Z0-9]{6,}$/.test(o.ownerName.trim());
      if (o.ownerId && (!o.ownerName || looksLikeId || o.ownerName === o.ownerId)) {
        try {
          const res = await slackBridge.resolveUserName(o.ownerId);
          const name = res && res.name;
          if (name && name !== o.ownerName) { o.ownerName = name; changed = true; }
        } catch (_) { /* leave as-is on failure */ }
      }
    }
    if (changed) { render(); _save(); }
  }

  slackBridge.getOperatorChannels().then((cfg) => {
    _cfg = (cfg && Array.isArray(cfg.operators)) ? cfg : { operators: [] };
    render();
    _resolveOwnerNames();
  }).catch(() => { _cfg = { operators: [] }; render(); });

  if (populateBtn) {
    populateBtn.addEventListener('click', async () => {
      populateBtn.disabled = true;
      const orig = populateBtn.textContent;
      populateBtn.textContent = 'Loading...';
      try {
        const ops = await slackBridge.listFleetOperators();
        const existing = new Set(_cfg.operators.map((o) => o.operator.toLowerCase()));
        let added = 0;
        (ops || []).forEach((op) => {
          if (op && !existing.has(op.toLowerCase())) {
            _cfg.operators.push({ operator: op, channelId: '', ownerId: '', ownerName: '' });
            added++;
          }
        });
        _cfg.operators.sort((a, b) => a.operator.localeCompare(b.operator));
        render();
        await _save();
        showStatus(added > 0 ? ('Added ' + added + ' operator' + (added === 1 ? '' : 's')) : 'All fleet operators already listed', 'ok');
      } catch (e) {
        showStatus('Populate failed: ' + e.message, 'err');
      } finally {
        populateBtn.disabled = false;
        populateBtn.textContent = orig;
      }
    });
  }

  if (addBtn) {
    addBtn.addEventListener('click', () => {
      _cfg.operators.push({ operator: '', channelId: '', ownerId: '', ownerName: '' });
      render();
    });
  }

  saveBtn.addEventListener('click', async () => {
    await _save();
    showStatus('\u2705 Saved', 'ok');
  });
}

// _wireCarrierBriefing() + _populateCbTestOperators() removed (2026-08-14):
// Daily Carrier Briefing moved to the Scheduler view header button overlay
// (renderer/src/js/views/schedulers.js), same slackBridge briefing config.

// ── SP: render operator accordion cards ──────────────────────────────────────

function _wireDMAutoReply() {
  const enabledEl  = document.getElementById('dm-ar-enabled');
  const saveBtn    = document.getElementById('dm-ar-save');
  const statusEl   = document.getElementById('dm-ar-status');
  const listEl     = document.getElementById('dm-ar-thread-list');
  if (!enabledEl || !saveBtn) return;

  function showStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'sd-status ' + (cls || '');
    statusEl.style.display = '';
  }

  // Preserve threads on every save — saveDMAutoReplyConfig returns { ok: true },
  // not the saved config, so drive UI from local state only.
  let _currentConfig = { enabled: false, threads: {} };

  function _relTime(ms) {
    if (!ms) return 'never';
    const diff = Date.now() - ms;
    if (diff < 60000)    return 'just now';
    if (diff < 3600000)  return Math.floor(diff / 60000)   + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  function _renderThreadList(config, replyLog) {
    if (!listEl) return;
    const threads = config.threads || {};
    const ids = Object.keys(threads);
    if (!ids.length) {
      listEl.innerHTML = '<div style="color:var(--mut);font-size:10px;padding:4px 0">No monitored DM threads yet. Threads are added automatically when the poller first sees a DM.</div>';
      return;
    }

    // Build reply-count map from log
    const countMap = {};
    (replyLog || []).forEach(r => {
      if (r.channelId) countMap[r.channelId] = (countMap[r.channelId] || 0) + 1;
    });

    listEl.innerHTML = ids.map(id => {
      const t = threads[id];
      const name = t.name || id;
      const count = countMap[id] || 0;
      const lastTs = t.lastSeenTs ? t.lastSeenTs * 1000 : null;
      const rel = _relTime(lastTs);

      return `<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--el);border:1px solid var(--bdr);border-radius:6px">
        <span style="flex:1;font-size:11px;font-weight:600;color:var(--txt2)">${name}</span>
        ${t.isGroup ? '<span style="font-size:9px;font-weight:700;color:var(--txt2);background:var(--bdr);padding:1px 6px;border-radius:10px">Group</span>' : ''}
        ${count ? `<span style="font-size:9px;font-weight:700;color:var(--acc2);background:var(--adim);padding:1px 6px;border-radius:10px">${count} repl${count === 1 ? 'y' : 'ies'}</span>` : ''}
        <span style="font-size:9px;color:var(--mut)">last seen ${rel}</span>
      </div>`;
    }).join('');
  }

  Promise.all([
    slackBridge.getDMAutoReplyConfig(),
    slackBridge.getDMReplyLog ? slackBridge.getDMReplyLog(200) : Promise.resolve([])
  ]).then(([config, replyLog]) => {
    _currentConfig = config || _currentConfig;
    enabledEl.checked = !!_currentConfig.enabled;
    _renderThreadList(_currentConfig, replyLog);
  }).catch(e => {
    showStatus('Failed to load config: ' + e.message, 'err');
  });

  // Auto-save the enable toggle so it persists without clicking Save
  enabledEl.addEventListener('change', async () => {
    const updated = { ..._currentConfig, enabled: !!enabledEl.checked };
    try {
      await slackBridge.saveDMAutoReplyConfig(updated);
      _currentConfig = updated;
    } catch (e) {
      showStatus('Auto-save failed: ' + e.message, 'err');
    }
  });

  saveBtn.addEventListener('click', async () => {
    const updated = { ..._currentConfig, enabled: !!enabledEl.checked };
    try {
      await slackBridge.saveDMAutoReplyConfig(updated);
      _currentConfig = updated;
      enabledEl.checked = !!_currentConfig.enabled;
      showStatus('Saved', 'ok');
      toast.show('success', 'DM Auto-Reply settings saved', 2500);
    } catch (e) {
      showStatus('Save failed: ' + e.message, 'err');
      toast.show('error', 'Save failed: ' + e.message, 4000);
    }
  });
}

// Lookup SP config from workbooks array (fallback when domiciles config is empty)
function _wbLookup(spCfg, opName, domCode) {
  const wbs = (spCfg && spCfg.workbooks) || [];
  const wb = wbs.find(w => w.domicile === domCode);
  if (!wb) return null;
  const carrier = wb.carriers && wb.carriers.find(c => c.code === opName);
  return { siteUrl: wb.path || "", listName: (carrier && carrier.sheet) || "", headerRow: wb.headerRow || 16 };
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
  // Midway SSO one-time interactive sign-in (opens a visible Asana login window).
  const connectBtn = document.getElementById('asana-midway-connect');
  if (connectBtn) connectBtn.addEventListener('click', () => {
    const el = document.getElementById('asana-user-status');
    connectBtn.disabled = true;
    const original = connectBtn.textContent;
    connectBtn.textContent = 'Opening sign-in\u2026';
    if (el) { el.textContent = '\u23F3 Complete sign-in in the Asana window\u2026'; el.className = 'sd-status'; }
    asanaBridge.signIn().then((res) => {
      if (res && res.ok) {
        toast.show('success', 'Connected to Asana' + (res.user ? ' as ' + res.user : ''), 3000);
        if (el) { el.textContent = '\u2705 Connected via Amazon SSO' + (res.user ? ' as ' + res.user : ''); el.className = 'sd-status ok'; }
      } else {
        toast.show('warn', (res && res.error) || 'Sign-in was not completed', 4000);
        if (el) { el.textContent = '\u26A0\uFE0F ' + ((res && res.error) || 'Sign-in not completed'); el.className = 'sd-status warn'; }
      }
    }).catch((e) => {
      toast.show('error', 'Asana sign-in failed: ' + e.message, 4000);
    }).finally(() => {
      connectBtn.disabled = false;
      connectBtn.textContent = original;
    });
  });

  // Midway SSO connection check (primary path — no token).
  const midwayBtn = document.getElementById('asana-midway-check');
  if (midwayBtn) midwayBtn.addEventListener('click', () => {
    const el = document.getElementById('asana-midway-status');
    midwayBtn.disabled = true;
    const original = midwayBtn.textContent;
    midwayBtn.textContent = 'Checking\u2026';
    if (el) { el.textContent = '\u23F3 Checking via Amazon SSO\u2026'; el.className = 'sd-status'; }
    asanaBridge.checkAuth().then((res) => {
      const ok = !!(res && res.ok);
      if (el) {
        el.textContent = ok
          ? ('\u2705 Connected via Amazon SSO as ' + (res.user || res.email || 'you'))
          : ('\u26A0\uFE0F Not connected: ' + ((res && res.error) || 'session unavailable') + ' — run mwinit / check AEA');
        el.className = 'sd-status ' + (ok ? 'ok' : 'warn');
      }
      if (ok) toast.show('success', 'Asana connected via SSO', 2500);
    }).catch((e) => {
      if (el) { el.textContent = '\u26A0\uFE0F Check failed: ' + e.message; el.className = 'sd-status warn'; }
    }).finally(() => {
      midwayBtn.disabled = false;
      midwayBtn.textContent = original;
    });
  });

  // Default workspace/project (shared config, no secret here).
  const saveBtn = document.getElementById('asana-save');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    await asanaBridge.saveConfig({
      workspace: document.getElementById('asana-workspace').value.trim(),
      project:   document.getElementById('asana-project').value.trim(),
    });
    const st = document.getElementById('asana-status');
    st.textContent = '✓ Saved'; st.style.display = 'block';
    setTimeout(() => { st.style.display = 'none'; }, 2000);
  });
  const verifyBtn = document.getElementById('asana-verify');
  if (verifyBtn) verifyBtn.addEventListener('click', () => {
    // checkAuth() resolves to an object ({ ok: bool, ... }); verify the ACTIVE
    // user's PAT actually works, not just that a token exists.
    asanaBridge.checkAuth().then((res) => {
      const ok = !!(res && res.ok);
      const st = document.getElementById('asana-status');
      st.textContent = ok ? ('✅ Valid — ' + (res.user || 'connected')) : '❌ Token invalid';
      st.style.display = 'block';
    }).catch(() => {});
  });

  // ── Multi-user PAT manager ──────────────────────────────────────────────────
  _refreshAsanaUsers();

  const addBtn = document.getElementById('asana-user-add');
  if (addBtn) addBtn.addEventListener('click', () => {
    const alias = document.getElementById('asana-user-alias').value.trim();
    const pat   = document.getElementById('asana-user-pat').value.trim();
    if (!alias || !pat) { toast.show('warn', 'Enter both an alias and a PAT', 3000); return; }
    addBtn.disabled = true;
    const original = addBtn.textContent;
    addBtn.textContent = 'Setting up\u2026';
    asanaBridge.setupUser(alias, pat).then((res) => {
      if (res && res.ok) {
        document.getElementById('asana-user-pat').value = '';   // never keep the PAT in the field
        document.getElementById('asana-user-alias').value = '';
        toast.show('success', 'Added ' + (res.name || alias) + ' to Asana', 3000);
      } else {
        toast.show('warn', (res && res.error) || 'Setup failed', 4000);
      }
      _refreshAsanaUsers();
    }).catch((e) => {
      toast.show('error', 'Setup failed: ' + e.message, 4000);
    }).finally(() => {
      addBtn.disabled = false;
      addBtn.textContent = original;
    });
  });
}

// Render the configured-user list + active badge. Never receives a PAT value —
// listUsers() returns only { alias, name, email, active }.
function _refreshAsanaUsers() {
  if (!window.asana || !window.asana.listUsers) return;
  asanaBridge.listUsers().then((res) => {
    const badge = document.getElementById('asana-user-status');
    const list  = document.getElementById('asana-user-list');
    const users = (res && res.users) || [];
    if (badge) {
      if (!users.length) {
        badge.textContent = '\u26A0\uFE0F No Asana users configured';
        badge.className = 'sd-status warn';
      } else {
        const active = users.find((u) => u.active);
        badge.textContent = active
          ? ('\u2705 Active: ' + (active.name || active.alias))
          : ('\u2139\uFE0F ' + users.length + ' user(s) configured — none active');
        badge.className = 'sd-status ' + (active ? 'ok' : 'warn');
      }
    }
    if (list) {
      if (!users.length) { list.innerHTML = '<span style="color:var(--mut,#8794a6)">None yet.</span>'; return; }
      list.innerHTML = users.map((u) => {
        const name = u.name || u.alias;
        const act  = u.active ? ' <strong style="color:var(--ok,#1b7f3b)">(active)</strong>' : '';
        const sw   = u.active ? '' : '<button class="sd-btn secondary" data-asana-switch="' + u.alias + '" style="padding:2px 8px;font-size:11px">Switch</button>';
        const rm   = '<button class="sd-btn secondary" data-asana-remove="' + u.alias + '" style="padding:2px 8px;font-size:11px">Remove</button>';
        return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0">'
          + '<span style="flex:1">' + name + act + ' <span style="color:var(--mut,#8794a6)">(' + u.alias + ')</span></span>'
          + sw + rm + '</div>';
      }).join('');
      list.querySelectorAll('[data-asana-switch]').forEach((b) => b.addEventListener('click', () => {
        asanaBridge.switchUser(b.getAttribute('data-asana-switch'))
          .then(() => { toast.show('info', 'Switched active user', 2000); _refreshAsanaUsers(); })
          .catch((e) => toast.show('error', 'Switch failed: ' + e.message, 3000));
      }));
      list.querySelectorAll('[data-asana-remove]').forEach((b) => b.addEventListener('click', () => {
        asanaBridge.removeUser(b.getAttribute('data-asana-remove'))
          .then(() => { toast.show('info', 'Removed user', 2000); _refreshAsanaUsers(); })
          .catch((e) => toast.show('error', 'Remove failed: ' + e.message, 3000));
      }));
    }
  }).catch(() => {});
}

// ── Section: Fleet Ops Companion — removed (feature discontinued) ────────────

// _wireNotifications() removed (2026-08-14): Notifications settings moved to
// the 🔔 dropdown ⚙ gear (notif-dropdown.js). Same settings.notifications keys.


// ── Section Accordion (Integrations tab) ─────────────────────────────────────
// CLEANUP (2026-07-23): the Integrations tab had grown to 15 always-expanded
// sections (Domiciles, AI Config, Credentials, Schedulers, Vendor Portal
// Credentials, Email, etc.) stacked in one long scroll. Collapsed them into
// an accordion -- click a section title to open it, which closes whichever
// other section was open. Purely a display toggle (CSS `.collapsed` hides
// everything in a section except its title); no data/wiring changes.
function _wireSectionAccordion(paneId) {
  const pane = document.getElementById(paneId);
  if (!pane) return;
  const sections = Array.from(pane.children).filter((el) => el.classList && el.classList.contains('sd-section'));
  if (sections.length < 2) return; // nothing to collapse against
  sections.forEach((sec) => {
    const title = sec.querySelector('.sd-section-title');
    if (!title) return;
    sec.classList.add('collapsed');
    title.classList.add('sd-section-title--toggle');
    if (!title.querySelector('.sd-chevron')) {
      const chevron = document.createElement('span');
      chevron.className = 'sd-chevron';
      chevron.textContent = '\u25BE';
      title.appendChild(chevron);
    }
    title.addEventListener('click', () => {
      const wasOpen = !sec.classList.contains('collapsed');
      sections.forEach((s) => s.classList.add('collapsed'));
      if (!wasOpen) sec.classList.remove('collapsed');
    });
  });
}

// ── Section: Accounts — ONE unified editable list ────────────────────────────
// Every login (seeded vendor portals + any site you add) is one editable card:
// name, url, username, password (+eye reveal), 🔗 open, 🗑 remove, and — for a
// row whose URL matches a known vendor portal — a "Test login" button + a 🔐
// badge. The list persists to settings.accounts (plaintext, so the eye-reveal
// works for everything). CRITICAL: a vendor row ALSO mirrors its user/pass into
// the encrypted keychain (vendor.<id>.username/password) on save, so the
// background auto-login (getForHostname) keeps working byte-for-byte unchanged.
// Vendor ids the user has explicitly deleted from the Accounts list. Persisted
// in settings (accountsRemovedVendors) so a deleted vendor stays gone instead
// of being re-seeded every time Settings opens. Re-adding its URL via + Add
// un-removes it. Loaded in _wireAccounts.
let _removedVendors = [];

function _wireAccounts() {
  settingsBridge.getAll().then((all) => {
    const saved = (all && Array.isArray(all.accounts)) ? all.accounts : [];
    _removedVendors = (all && Array.isArray(all.accountsRemovedVendors)) ? all.accountsRemovedVendors.slice() : [];

    // Seed the known vendor portals so they're always in the one list. A saved
    // row already covering a vendor host wins (keeps the user's edits); any
    // vendor not yet present is added, prefilled with its known name/url + the
    // keychain username mirror (<id>_user). Passwords are never prefilled (the
    // keychain copy isn't retrievable) — the plaintext copy fills in once saved.
    // A vendor the user has explicitly DELETED is NOT re-seeded.
    const rows = saved.slice();
    _VENDORS.forEach((v) => {
      if (_removedVendors.indexOf(v.id) !== -1) return; // user deleted this one — stay gone
      const already = rows.some((r) => _vendorForUrl(r.url || r.name) && _vendorForUrl(r.url || r.name).id === v.id);
      if (!already) {
        rows.push({ name: v.name, url: 'https://' + v.host + '/', user: (all && all[`${v.id}_user`]) || '', pass: '' });
      }
    });

    const empty = document.getElementById('acct-empty');
    if (rows.length) { if (empty) empty.style.display = 'none'; rows.forEach((r) => _acctAddRow(r)); }
    else if (empty) empty.style.display = 'flex';
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
  const id   = 'acct-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const row  = document.createElement('div');
  row.className = 'acct-card acct-row';
  row.id = id;

  const url  = prefill.url  || '';
  const name = prefill.name || '';
  const user = prefill.user || '';
  const pass = prefill.pass || '';
  const vendor = _vendorForUrl(url || name);

  const testBtn = vendor
    ? '<button class="sd-btn secondary acct-test" type="button">' + (vendor.sso ? 'Sign in' : 'Test login') + '</button>'
    : '';
  const vendorBadge = vendor ? '<span class="acct-vendor-tag" title="Auto-login portal — syncs to secure keychain">🔐 ' + _esc(vendor.name) + '</span>' : '';

  row.innerHTML =
    '<div class="acct-card-row1">' +
      '<input class="acct-input acct-name" type="text" placeholder="Account name" value="' + _esc(name) + '" title="Display name"/>' +
      vendorBadge +
      '<a class="acct-link" href="' + (_esc(url) || '#') + '" title="Open site" style="' + (url ? '' : 'display:none') + '" target="_blank">🔗</a>' +
      '<span class="acct-save-badge" id="badge-' + id + '"></span>' +
      '<button class="acct-del" type="button" title="Remove">🗑</button>' +
    '</div>' +
    '<input class="acct-input acct-url" type="url" placeholder="https://..." value="' + _esc(url) + '" title="Site URL"/>' +
    '<div class="acct-card-row2">' +
      '<input class="acct-input acct-user" type="text" placeholder="username / email" value="' + _esc(user) + '"/>' +
      '<span class="acct-pass-wrap' + (vendor && vendor.sso ? ' acct-hide' : '') + '">' +
        '<input class="acct-input acct-pass" type="password" placeholder="password" value="' + _esc(pass) + '"/>' +
        '<button class="acct-eye" type="button" title="Show/hide">👁️</button>' +
      '</span>' +
    '</div>' +
    (testBtn ? '<div class="acct-card-actions">' + testBtn + '<span class="acct-test-status settings__status" style="display:none"></span></div>' : '');

  // URL change: update the open-link + re-detect vendor (so pasting a vendor
  // URL turns a plain row into a recognized portal row on next render).
  row.querySelector('.acct-url').addEventListener('input', function () {
    const link = row.querySelector('.acct-link');
    const v = this.value.trim();
    if (link) { link.href = v || '#'; link.style.display = v ? '' : 'none'; }
    _acctAutoSave(row);
  });
  row.querySelector('.acct-name').addEventListener('input', () => _acctAutoSave(row));
  row.querySelector('.acct-user').addEventListener('input', () => _acctAutoSave(row));
  row.querySelector('.acct-pass').addEventListener('input', () => _acctAutoSave(row));
  row.querySelector('.acct-eye').addEventListener('click', function () {
    const inp = row.querySelector('.acct-pass');
    inp.type = inp.type === 'password' ? 'text' : 'password';
    this.textContent = inp.type === 'password' ? '👁️' : '🙈';
  });
  row.querySelector('.acct-del').addEventListener('click', async () => {
    const vend = _vendorForUrl((row.querySelector('.acct-url')?.value || '') || (row.querySelector('.acct-name')?.value || ''));
    if (vend) {
      // Remember this vendor as removed so it is NOT re-seeded next open, and
      // (for non-sso) clear its keychain keys so auto-login drops the stale creds.
      if (_removedVendors.indexOf(vend.id) === -1) _removedVendors.push(vend.id);
      try { await settingsBridge.save('accountsRemovedVendors', _removedVendors); } catch (_) {}
      if (!vend.sso) {
        try { await credsBridge.delete('vendor.' + vend.id + '.username'); await credsBridge.delete('vendor.' + vend.id + '.password'); await settingsBridge.save(vend.id + '_user', ''); } catch (_) {}
      }
    }
    row.remove();
    if (!document.querySelectorAll('#acct-list .acct-row').length) {
      const e = document.getElementById('acct-empty');
      if (e) e.style.display = 'flex';
    }
    _acctPersist();
  });

  // Test login (vendor rows only) — opens the real portal + runs the same
  // auto-login pass the scraper uses. Saves first so it tests current creds.
  const tb = row.querySelector('.acct-test');
  if (tb && vendor) tb.addEventListener('click', async () => {
    const st = row.querySelector('.acct-test-status');
    if (st) { st.textContent = '⏳ Opening portal…'; st.style.display = 'inline'; st.className = 'acct-test-status settings__status settings__status--loading'; }
    try {
      await _acctMirrorVendor(row, vendor);               // ensure latest creds are in the keychain
      const r = await credsBridge.testLogin(vendor.id);
      if (st) {
        if (r && r.ok && r.attempted) { st.textContent = '✅ Attempted — check the window'; st.className = 'acct-test-status settings__status settings__status--ok'; }
        else if (r && r.closedByUser) { st.textContent = 'Window closed'; st.className = 'acct-test-status settings__status'; }
        else { st.textContent = vendor.sso ? '⚠️ Requires Midway SSO' : '⚠️ Save a username + password first'; st.className = 'acct-test-status settings__status settings__status--loading'; }
      }
    } catch (e) {
      if (st) { st.textContent = '❌ ' + e.message; st.className = 'acct-test-status settings__status settings__status--err'; }
    }
  });

  list.appendChild(row);
}

// Mirror a vendor row's user/pass into the encrypted keychain + username mirror,
// so the background auto-login (getForHostname) uses the current credentials.
async function _acctMirrorVendor(row, vendor) {
  if (!vendor || vendor.sso) return;
  const user = (row.querySelector('.acct-user')?.value || '').trim();
  const pass = (row.querySelector('.acct-pass')?.value || '');
  try {
    if (user) { await credsBridge.set('vendor.' + vendor.id + '.username', user); await settingsBridge.save(vendor.id + '_user', user); }
    if (pass) { await credsBridge.set('vendor.' + vendor.id + '.password', pass); }
  } catch (_) {}
}

const _acctTimers = {};
function _acctAutoSave(row) {
  const badge = row.querySelector('.acct-save-badge');
  if (badge) { badge.textContent = 'saving…'; badge.className = 'acct-save-badge saving'; }
  clearTimeout(_acctTimers[row.id]);
  _acctTimers[row.id] = setTimeout(async () => {
    _acctPersist();
    // If this row is a known vendor, keep the keychain copy in sync too, and
    // un-mark it as "removed" (the user re-added it by entering its URL).
    const vend = _vendorForUrl((row.querySelector('.acct-url')?.value || '') || (row.querySelector('.acct-name')?.value || ''));
    if (vend) {
      const ri = _removedVendors.indexOf(vend.id);
      if (ri !== -1) { _removedVendors.splice(ri, 1); try { await settingsBridge.save('accountsRemovedVendors', _removedVendors); } catch (_) {} }
      if (!vend.sso) { await _acctMirrorVendor(row, vend); }
    }
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
    user: (r.querySelector('.acct-user')?.value || '').trim(),
    // Password NOT trimmed: leading/trailing spaces can be intentional.
    pass: (r.querySelector('.acct-pass')?.value || ''),
  })).filter((r) => r.name || r.url || r.user);
  settingsBridge.save('accounts', rows).catch(() => {});
}

// ── UI Tab: theme / color / font / slider wiring ─────────────────────────────
// ── Theme token tables — applied directly to documentElement so all CSS vars ─
// update atomically regardless of cascade order or inline-style conflicts.
const _THEMES = {
  dark: {
    '--bg': '#0d1117', '--panel': '#161b22', '--card': '#1c2128',
    '--el': '#21262d', '--bdr': '#30363d', '--bdrs': '#444c56',
    '--txt': '#e6edf3', '--txt2': '#8b949e', '--mut': '#484f58',
    '--acc': '#58a6ff', '--acc2': '#79c0ff', '--adim': 'rgba(88,166,255,.08)',
    '--hov': 'rgba(255,255,255,.04)',
    '--grn': '#7ee787', '--grnd': 'rgba(126,231,135,.08)',
    '--red': '#ff7b72', '--redd': 'rgba(255,123,114,.08)',
    '--org': '#ffa657', '--orgd': 'rgba(255,166,87,.08)',
    '--ylw': '#e3b341', '--pur': '#d2a8ff', '--purd': 'rgba(210,168,255,.08)',
    '--fg': '#e6edf3', '--fg2': '#8b949e', '--fg3': '#484f58',
    '--table-bg': '#1c2128',
  },
  light: {
    '--bg': '#f6f8fa', '--panel': '#ffffff', '--card': '#f0f2f5',
    '--el': '#e8eaed', '--bdr': '#d0d7de', '--bdrs': '#b0b7c0',
    '--txt': '#1f2328', '--txt2': '#57606a', '--mut': '#8c959f',
    '--acc': '#0969da', '--acc2': '#0550ae', '--adim': 'rgba(9,105,218,.08)',
    '--hov': 'rgba(0,0,0,.04)',
    '--grn': '#1a7f37', '--grnd': 'rgba(26,127,55,.08)',
    '--red': '#cf222e', '--redd': 'rgba(207,34,46,.08)',
    '--org': '#bc4c00', '--orgd': 'rgba(188,76,0,.08)',
    '--ylw': '#9a6700', '--pur': '#8250df', '--purd': 'rgba(130,80,223,.08)',
    '--fg': '#1f2328', '--fg2': '#57606a', '--fg3': '#8c959f',
    '--table-bg': '#ffffff',
  },
  midnight: {
    '--bg': '#000000', '--panel': '#0a0a0a', '--card': '#111111',
    '--el': '#181818', '--bdr': '#222222', '--bdrs': '#333333',
    '--txt': '#f0f6fc', '--txt2': '#8b949e', '--mut': '#484f58',
    '--acc': '#58a6ff', '--acc2': '#79c0ff', '--adim': 'rgba(88,166,255,.08)',
    '--hov': 'rgba(255,255,255,.02)',
    '--grn': '#7ee787', '--grnd': 'rgba(126,231,135,.08)',
    '--red': '#ff7b72', '--redd': 'rgba(255,123,114,.08)',
    '--org': '#ffa657', '--orgd': 'rgba(255,166,87,.08)',
    '--ylw': '#e3b341', '--pur': '#d2a8ff', '--purd': 'rgba(210,168,255,.08)',
    '--fg': '#f0f6fc', '--fg2': '#8b949e', '--fg3': '#484f58',
    '--table-bg': '#000000',
  },
  ocean: {
    '--bg': '#0d1f2d', '--panel': '#0e2a3a', '--card': '#0f3040',
    '--el': '#0e4d4d', '--bdr': '#1a5c5c', '--bdrs': '#2a7070',
    '--txt': '#e0f4f4', '--txt2': '#7db8b8', '--mut': '#4a8888',
    '--acc': '#2dd4bf', '--acc2': '#5eead4', '--adim': 'rgba(45,212,191,.12)',
    '--hov': 'rgba(255,255,255,.04)',
    '--grn': '#2dd4bf', '--grnd': 'rgba(45,212,191,.08)',
    '--red': '#ff7b72', '--redd': 'rgba(255,123,114,.08)',
    '--org': '#ffa657', '--orgd': 'rgba(255,166,87,.08)',
    '--ylw': '#e3b341', '--pur': '#a5b4fc', '--purd': 'rgba(165,180,252,.08)',
    '--fg': '#e0f4f4', '--fg2': '#7db8b8', '--fg3': '#4a8888',
    '--table-bg': '#0f3040',
  },
};

function _applyThemeVars(theme) {
  const tokens = _THEMES[theme] || _THEMES.dark;
  Object.entries(tokens).forEach(([k, v]) => {
    document.documentElement.style.setProperty(k, v);
  });
  // Keep body class for any external CSS that targets it (e.g. body.light-mode)
  document.body.classList.remove('light-mode', 'midnight-mode', 'ocean-mode');
  if (theme !== 'dark') document.body.classList.add(theme + '-mode');
}

// ── Exported theme API (used by toolbar and boot) ────────────────────────────
export const THEME_NAMES = Object.keys(_THEMES); // ['dark','light','midnight','ocean']
export function applyTheme(theme) {
  _applyThemeVars(theme);
  _saveUI();
}


function _syncSwatchesToTheme(theme) {
  if (!_drawer) return;
  const tokens = _THEMES[theme] || _THEMES.dark;
  _drawer.querySelectorAll('.sd-swatch').forEach(sw => sw.classList.remove('active'));
  ['--acc','--bg','--panel','--txt','--table-bg','--row-avail','--row-unavail',
   '--chat-bubble-ai','--chat-bubble-user','--chat-border'].forEach(varName => {
    const themeVal = tokens[varName];
    const swatches = _drawer.querySelectorAll(`.sd-swatch[data-var="${varName}"]`);
    if (!swatches.length) return;
    let matched = false;
    swatches.forEach(sw => {
      if (!matched && themeVal && sw.style.background === themeVal) {
        sw.classList.add('active');
        matched = true;
      }
    });
    if (!matched && swatches[0]) swatches[0].classList.add('active');
  });
}

// ── Section: Auth Health (Phase E) ───────────────────────────────────────────
// Renders the single Midway/AAP self-healing supervisor's live state. Health is
// defined by a VERIFIED authenticated call to the real AAP target — not VPN,
// not cookie existence. The panel is read-only except for three actions:
// Refresh (re-read snapshot), Retry now (silent convergence), Run mwinit
// (interactive escalation).
function _fmtMin(m) {
  if (typeof m !== 'number' || !isFinite(m)) return '—';
  if (m <= 0) return 'expired';
  if (m < 60) return Math.round(m) + ' min';
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  return r ? `${h}h ${r}m` : `${h}h`;
}

function _authHealthStateClass(state) {
  switch (state) {
    case 'HEALTHY':          return 'ok';
    case 'DEGRADED':
    case 'RECOVERING':
    case 'COOLDOWN':
    case 'UNKNOWN':          return 'warn';
    case 'WAITING_FOR_USER':
    case 'OFFLINE':
    case 'FAILED':           return 'err';
    default:                 return 'warn';
  }
}

function _authHealthLabel(state) {
  const map = {
    HEALTHY:          '\u2705 Healthy — AAP target verified',
    DEGRADED:         '\u26A0\uFE0F Degraded — auto-recovery armed',
    RECOVERING:       '\u231B Recovering…',
    COOLDOWN:         '\u23F3 Cooldown — waiting before next retry',
    WAITING_FOR_USER: '\uD83D\uDD11 Waiting for you — run mwinit (PIN + YubiKey)',
    OFFLINE:          '\uD83D\uDCF6 Offline — will re-verify on reconnect',
    FAILED:           '\u274C Failed — manual mwinit required',
    UNKNOWN:          '\u2139\uFE0F Not checked yet',
  };
  return map[state] || ('\u2139\uFE0F ' + (state || 'Unknown'));
}

function _renderAuthHealth(res) {
  const stateEl = document.getElementById('auth-health-state');
  const gridEl  = document.getElementById('auth-health-grid');
  const histEl  = document.getElementById('auth-health-history');
  if (!stateEl || !gridEl) return;

  if (!res || !res.ok) {
    stateEl.className = 'sd-status err';
    stateEl.textContent = '\u274C Auth supervisor unavailable' + (res && res.error ? ' (' + res.error + ')' : '');
    gridEl.innerHTML = '';
    if (histEl) histEl.innerHTML = '';
    return;
  }

  const state = res.state || (res.snapshot && res.snapshot.state) || 'UNKNOWN';
  stateEl.className = 'sd-status ' + _authHealthStateClass(state);
  stateEl.textContent = _authHealthLabel(state);

  const s = res.snapshot || {};
  const smoke = s.aapApiSmokeTest || null;
  const verified = !!(smoke && smoke.ok);
  const rows = [
    ['AAP target verified', verified ? 'yes' : 'no' + (smoke && smoke.class ? ' (' + smoke.class + ')' : '')],
    ['Internet', s.internet && s.internet.online ? 'online' : 'offline'],
    ['VPN', (s.vpn && s.vpn.connected === true ? 'connected' : s.vpn && s.vpn.connected === false ? 'not connected' : 'unknown') + ' — not required'],
    ['Midway session', s.diskSession ? _fmtMin(s.diskSession.expiresInMin) + ' left' : '—'],
    ['AEA cookie', s.diskAea ? _fmtMin(s.diskAea.expiresInMin) + ' left' : '—'],
    ['Next auto-retry', s.nextRetryAt ? new Date(s.nextRetryAt).toLocaleTimeString() : '—'],
    ['Checked', s.at ? new Date(s.at).toLocaleTimeString() : '—'],
  ];
  gridEl.innerHTML = rows.map(([k, v]) =>
    `<div style="opacity:.75">${k}</div><div><b>${v}</b></div>`
  ).join('');

  if (histEl) {
    const hist = Array.isArray(res.history) ? res.history.slice(-5).reverse() : [];
    if (!hist.length) { histEl.innerHTML = ''; }
    else {
      histEl.innerHTML = '<div style="opacity:.75;margin-bottom:4px">Recent recovery attempts</div>' +
        hist.map((h) => {
          const when = h.at ? new Date(h.at).toLocaleTimeString() : '';
          const outcome = h.result || (h.recovered ? 'recovered' : 'failed');
          const note = h.note || h.reason || '';
          return `<div style="font-size:11px;opacity:.85">• ${when} — ${outcome}${note ? ' (' + note + ')' : ''}</div>`;
        }).join('');
    }
  }
}

function _loadAuthHealth() {
  if (!authBridge.healthGet) return;
  const stateEl = document.getElementById('auth-health-state');
  if (stateEl) { stateEl.className = 'sd-status warn'; stateEl.textContent = '\u231B Checking…'; }
  authBridge.healthGet().then(_renderAuthHealth).catch((e) => {
    _renderAuthHealth({ ok: false, error: e && e.message });
  });
}

function _wireAuthHealth() {
  const refreshBtn = document.getElementById('auth-health-refresh');
  const retryBtn   = document.getElementById('auth-health-retry');
  const mwinitBtn  = document.getElementById('auth-health-mwinit');
  if (!refreshBtn) return; // section not present

  refreshBtn.addEventListener('click', _loadAuthHealth);

  if (retryBtn) retryBtn.addEventListener('click', () => {
    if (!authBridge.healthRetry) return;
    retryBtn.disabled = true;
    const orig = retryBtn.textContent;
    retryBtn.textContent = 'Retrying…';
    authBridge.healthRetry().then((r) => _renderAuthHealth(r && r.snapshot ? { ok: true, state: r.state, snapshot: r.snapshot, history: [] } : null) || _loadAuthHealth())
      .catch(() => {})
      .finally(() => { retryBtn.disabled = false; retryBtn.textContent = orig; _loadAuthHealth(); });
  });

  if (mwinitBtn) mwinitBtn.addEventListener('click', () => {
    if (!authBridge.healthRunMwinit) return;
    mwinitBtn.disabled = true;
    const orig = mwinitBtn.textContent;
    mwinitBtn.textContent = 'Running mwinit…';
    authBridge.healthRunMwinit().catch(() => {})
      .finally(() => { mwinitBtn.disabled = false; mwinitBtn.textContent = orig; _loadAuthHealth(); });
  });

  // Live update when the supervisor pushes an mwinit status change.
  try { bus.on('auth:mwinit-status', () => _loadAuthHealth()); } catch (_) {}

  _loadAuthHealth();
}

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
      _applyThemeVars(theme);
      _syncSwatchesToTheme(theme);
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

  // ── Font size chips ─────────────────────────────────────────────────────
  // The app's UI is px-based (not rem), so a root font-size change wouldn't
  // cascade. Scale the whole interface with body zoom instead — the same thing
  // browser zoom does — which scales text AND layout proportionally.
  _drawer.querySelectorAll('.sd-fontsize-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      _drawer.querySelectorAll('.sd-fontsize-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      _applyFontSize(btn.dataset.fontsize);
      _saveUI();
    });
  });

  // ── Chat floater size chips ─────────────────────────────────────────────
  const CHAT_SIZES = {
    compact: { w: '300px', h: '360px' },
    normal:  { w: '360px', h: '480px' },
    wide:    { w: '440px', h: '480px' },
    tall:    { w: '360px', h: '620px' },
  };
  _drawer.querySelectorAll('[data-chat-size]').forEach((btn) => {
    btn.addEventListener('click', () => {
      _drawer.querySelectorAll('[data-chat-size]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const s = CHAT_SIZES[btn.dataset.chatSize] || CHAT_SIZES.normal;
      document.documentElement.style.setProperty('--chat-w', s.w);
      document.documentElement.style.setProperty('--chat-h', s.h);
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
  // Nexus → Fleet theme bridge mapping
  const NEXUS_TO_FLEET = { default: 'dark', void: 'midnight', solar: 'dark', arctic: 'ocean', ember: 'midnight' };



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
        // Bridge: update fleet CSS vars to match nexus preset
        const mappedTheme = NEXUS_TO_FLEET[chip.dataset.preset] || 'dark';
        _applyThemeVars(mappedTheme);
        _syncSwatchesToTheme(mappedTheme);
        // Sync fleet template card active state
        if (_drawer) _drawer.querySelectorAll('.sd-template').forEach(card => {
          const active = card.dataset.theme === mappedTheme;
          card.classList.toggle('active', active);
          const chk = card.querySelector('.sd-tpl-check');
          if (chk) chk.style.display = active ? '' : 'none';
        });
        _saveUI();
        // Update accent picker to match preset
        const p = PRESETS[chip.dataset.preset];
        if (p) {
          const picker = document.getElementById('nx-accent-picker');
          const hex = document.getElementById('nx-accent-hex');
          if (picker) picker.value = p.accent;
          if (hex) hex.textContent = p.accent;
          // Also update fleet accent var
          document.documentElement.style.setProperty('--acc', p.accent);
          document.documentElement.style.setProperty('--adim', p.accent.replace(/^#/, '') ? 'rgba(' + parseInt(p.accent.slice(1,3),16) + ',' + parseInt(p.accent.slice(3,5),16) + ',' + parseInt(p.accent.slice(5,7),16) + ',.08)' : 'rgba(88,166,255,.08)');
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
      // Bridge: also update fleet accent var
      document.documentElement.style.setProperty('--acc', accentPicker.value);
      const r = parseInt(accentPicker.value.slice(1,3),16);
      const g = parseInt(accentPicker.value.slice(3,5),16);
      const b = parseInt(accentPicker.value.slice(5,7),16);
      document.documentElement.style.setProperty('--adim', `rgba(${r},${g},${b},.08)`);
      document.documentElement.style.setProperty('--acc2', accentPicker.value);
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
    const swatchVars = ['--acc', '--bg', '--panel', '--txt', '--table-bg', '--row-avail', '--row-unavail', '--chat-bubble-ai', '--chat-bubble-user', '--chat-border'];
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
    const fontBtn = _drawer.querySelector('[data-font].active');
    const font = fontBtn ? fontBtn.dataset.font : 'system';

    // Active font size
    const fontSizeBtn = _drawer.querySelector('[data-fontsize].active');
    const fontSize = fontSizeBtn ? fontSizeBtn.dataset.fontsize : 'normal';

    // Chat floater size
    const chatSizeBtn = _drawer.querySelector('[data-chat-size].active');
    const chatSize = chatSizeBtn ? chatSizeBtn.dataset.chatSize : 'normal';

    // Compact toggle
    const compact = document.getElementById('toggle-compact');
    const compactRows = compact ? compact.checked : false;

    settingsBridge.save('ui_prefs', { theme, swatches, sliders, font, fontSize, compactRows, chatSize })
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

  // Theme — apply ALL token vars so there's no cascade conflict with swatches
  if (prefs.theme) {
    _applyThemeVars(prefs.theme);
    // Sync active card in drawer
    if (_drawer) _drawer.querySelectorAll('.sd-template').forEach((card) => {
      const active = card.dataset.theme === prefs.theme;
      card.classList.toggle('active', active);
      if (card.querySelector('.sd-tpl-check'))
        card.querySelector('.sd-tpl-check').style.display = active ? '' : 'none';
    });
  }

  // Color swatches + CSS vars
  if (prefs.swatches) {
    const themeTokens = _THEMES[prefs.theme] || {};
    Object.entries(prefs.swatches).forEach(([cssVar, color]) => {
      // Skip stale swatches: if theme controls this var and saved value doesn't match
      // the saved theme's token, it was set while on a different theme — ignore it.
      const expected = themeTokens[cssVar];
      if (expected !== undefined && expected !== color) return;
      document.documentElement.style.setProperty(cssVar, color);
      // Mark matching swatch active
      if (_drawer) _drawer.querySelectorAll(`.sd-swatch[data-var="${cssVar}"]`).forEach((sw) => {
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

  // Font size
  {
    const size = prefs.fontSize || 'normal';
    _drawer.querySelectorAll('.sd-fontsize-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.fontsize === size);
    });
    _applyFontSize(size);
  }

  // Compact toggle
  if (prefs.compactRows != null) {
    const compact = document.getElementById('toggle-compact');
    if (compact) compact.checked = prefs.compactRows;
  }

  // Chat floater size
  if (prefs.chatSize) {
    const CHAT_SIZES = { compact: { w: '300px', h: '360px' }, normal: { w: '360px', h: '480px' }, wide: { w: '440px', h: '480px' }, tall: { w: '360px', h: '620px' } };
    const s = CHAT_SIZES[prefs.chatSize] || CHAT_SIZES.normal;
    document.documentElement.style.setProperty('--chat-w', s.w);
    document.documentElement.style.setProperty('--chat-h', s.h);
    if (_drawer) _drawer.querySelectorAll('[data-chat-size]').forEach((b) => {
      b.classList.toggle('active', b.dataset.chatSize === prefs.chatSize);
    });
  }
}

// ── Populate fields on open ──────────────────────────────────────────────────
function _populate() {
  settingsBridge.getAll().then((all) => {
    if (!all) return;

    // UI prefs (theme, colors, sliders, font)
    if (all.ui_prefs) _applyUI(all.ui_prefs);

    // Domiciles populate removed (2026-08-14): editor moved to the 👤 User
    // Profile popover, which loads from settings.getDomiciles() itself.
    if (all.orcha) {
      const o = all.orcha;
      const mode = document.getElementById('orcha-mode');
      const host = document.getElementById('orcha-host');
      const port = document.getElementById('orcha-port');
      if (mode && o.mode) mode.value = o.mode;
      if (host && o.host) host.value = o.host;
      if (port && o.port) port.value = o.port;
    }
    // Email SMTP populate removed (2026-08-14): OWA-only, section deleted.
    if (all.asana) {
      const a = all.asana;
      if (a.workspace) { const el = document.getElementById('asana-workspace'); if (el) el.value = a.workspace; }
      if (a.project)   { const el = document.getElementById('asana-project');   if (el) el.value = a.project;   }
    }
    // Notifications populate removed (2026-08-14): the Notifications UI moved
    // to the 🔔 dropdown ⚙ gear, which reads settings.notifications itself.
  }).catch(() => {});
}

// ── Apply saved UI prefs on cold boot (before drawer ever opens) ─────────────
export function applyBootPrefs() {
  settingsBridge.getAll().then((all) => {
    if (all && all.ui_prefs) {
      // Always apply theme vars on boot — doesn't require _drawer to exist
      if (all.ui_prefs.theme) _applyThemeVars(all.ui_prefs.theme);
      // Full UI sync (swatches, sliders, font) only if drawer is mounted
      if (_drawer) _applyUI(all.ui_prefs);
    }
  }).catch(() => {});
}

// ── Escape HTML attr values ──────────────────────────────────────────────────
function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

// ── Chat Floater (desktop bubble) opacity control ───────────────────────────
function _wireChatFloaterSection() {
  const slider = document.getElementById('sl-bubble-opacity');
  const valEl  = document.getElementById('sl-bubble-opacity-val');
  if (!slider || !valEl || !window.bubble || !window.bubble.getOpacity) return;

  window.bubble.getOpacity().then((v) => {
    const val = Number(v) || 100;
    slider.value = String(val);
    valEl.textContent = val + '%';
  }).catch(() => {});

  slider.addEventListener('input', () => {
    const val = Number(slider.value);
    valEl.textContent = val + '%';
    window.bubble.setOpacity(val);
  });
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

  // AI Config overlay (opened from the toolbar AI status pill #tb-ai-status
  // via the ui:ai-config-toggle bus event). Shares all #sect-ai-config IDs,
  // so _wireAIConfig()/_loadAIConfig() operate on it unchanged.
  const _aiOv = document.getElementById('ai-config-overlay');
  const _aiClose = document.getElementById('ai-config-close');
  if (_aiClose) _aiClose.addEventListener('click', _closeAIConfigOverlay);
  if (_aiOv) _aiOv.addEventListener('click', (e) => { if (e.target === _aiOv) _closeAIConfigOverlay(); });
  bus.on('ui:ai-config-toggle', () => {
    if (_aiOv && _aiOv.classList.contains('open')) _closeAIConfigOverlay();
    else _openAIConfig();
  });

  // Wire tabs
  _wireTabSwitching();

  // Wire UI tab controls
  _wireUITab();

  // Wire Chat Floater opacity control (IPC-backed, separate from the
  // localStorage-based UI theme sliders above, since it must reach the
  // bubble BrowserWindow's own separate renderer process).
  _wireChatFloaterSection();

  // Wire the Digital Fleet Asset Specialist section (mode toggles + shadow log).
  try { initFasSettings(); } catch (_) { /* non-fatal */ }

  // Wire all integration sections
  
  // Partner Work Request Forms config moved (2026-08-14) to the Incoming Work
  // Requests overlay (📋 toolbar) ⚙ gear. localStorage fleet_forms_config +
  // config:forms-changed are unchanged; draft-inbox.js owns the wiring now.

  // SP Workbook Discover/config wiring moved (2026-08-14) to the Scheduler
  // view's SharePoint Push gear overlay (renderer/src/js/views/schedulers.js).

  _wireOrcha();
  _wireSlack();
  _wirePartnerAutoReply();
  _wireOperatorChannels();
  _wireDMAutoReply();
  _wireSP();
  _wireAsana();

  _wireAccounts();
  _wireAuthHealth();
  _wireSectionAccordion('sd-pane-integrations');
  _wireSectionAccordion('sd-pane-ui');

  // Listen for settings open request
  bus.on('ui:view-change', ({ to }) => {
    if (to === 'settings') _open();
  });

  // ── Apply saved theme + CSS vars immediately on startup (before drawer opens) ──
  settingsBridge.getAll().then((all) => {
    if (!all?.ui_prefs) return;
    if (all.ui_prefs.theme) _applyThemeVars(all.ui_prefs.theme);
    if (all.ui_prefs.swatches) {
      Object.entries(all.ui_prefs.swatches).forEach(([cssVar, color]) => {
        if (color) document.documentElement.style.setProperty(cssVar, color);
      });
    }
    // Font family + size on boot (not just when the drawer opens).
    const _fontMap = {
      system: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      serif:  'Georgia,serif',
      mono:   '"SFMono-Regular",Consolas,"Liberation Mono",monospace',
      inter:  '"Inter",sans-serif',
    };
    if (all.ui_prefs.font) {
      document.documentElement.style.setProperty('--font', _fontMap[all.ui_prefs.font] || _fontMap.system);
    }
    if (all.ui_prefs.fontSize) _applyFontSize(all.ui_prefs.fontSize);
  }).catch(() => {});
}
