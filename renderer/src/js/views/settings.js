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
import * as notifSounds                            from '../notif-sounds.js';
import { settings as settingsBridge }              from '../bridge.js';
import { auth     as authBridge }                  from '../bridge.js';
import { credentials as credsBridge }              from '../bridge.js';
import { slack    as slackBridge }                 from '../bridge.js';
import { email    as emailBridge }                 from '../bridge.js';
import { sp       as spBridge }                    from '../bridge.js';
import { asana    as asanaBridge }                 from '../bridge.js';
import { graphMail as graphMailBridge }            from '../bridge.js';
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

        <!-- Domiciles -->
        <div class="sd-section" id="sect-domiciles">
          <div class="sd-section-title">Domiciles</div>
          <div class="sd-field">
            <div class="sd-label">Managed domiciles (one per line, or comma-separated)</div>
            <textarea id="settings-domiciles" class="settings__textarea sd-input" placeholder="ABE40&#10;AVP40&#10;AUVTE01"></textarea>
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
              <div class="sd-label">Orcha Agent (model)</div>
              <select class="sd-select" id="orcha-agent" style="font-size:11px">
                <option value="orcha_default">Orcha — Claude Opus 4.6</option>
                <option value="moon">Moon — Claude Sonnet 4.6</option>
                <option value="mirror">Mirror — Claude Sonnet 4.6</option>
                <option value="otter">Otter — Claude Sonnet 4.6</option>
                <option value="tides_workflow_runner">Tides Workflow Runner — Claude Sonnet 4.6</option>
              </select>
              <div style="margin-top:4px;font-size:10px;color:#6e7681;font-style:italic">The Orcha agent that answers AI requests. The model is chosen server-side by the agent (Orcha = Opus 4.6, others = Sonnet 4.6).</div>
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
              <div class="sd-label">Timeout (seconds)</div>
              <input class="sd-input" id="claude-timeout" type="number" placeholder="60" style="width:80px"/>
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
          <!-- FEATURE (2026-07-22): sound notifications -- synthesized
               tones (no audio asset files), a distinct pattern per
               notification type, inferred automatically from each
               notification's existing icon field. See
               renderer/src/js/notif-sounds.js for the full design. -->
          <div class="sd-toggle-row">
            <span class="sd-toggle-label">Sound notifications</span>
            <input type="checkbox" id="notif-sounds-enabled" checked/>
          </div>
          <div class="sd-field">
            <div class="sd-label">Volume</div>
            <input type="range" id="notif-sounds-volume" min="0" max="100" value="50" style="width:100%"/>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn secondary" id="notif-sounds-test" type="button">Test sounds</button>
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
            <input class="sd-input" id="sched-interval" type="number" min="1" max="360" placeholder="5"/>
            <div id="sched-status" class="sd-inline-status" style="margin-top:4px;font-size:11px;"></div>
          </div>
          <div class="sd-field">
            <div class="sd-label">Default scheduler endpoint</div>
            <input class="sd-input" id="sched-endpoint" placeholder="https://..."/>
            <div class="sd-hint" style="margin-top:4px">Reserved for a future remote-scheduler integration — not yet functional.</div>
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
            <div class="sd-btn-row"><button class="sd-btn primary" id="paccar-save">Save</button><button class="sd-btn secondary" id="paccar-test">Test login</button><button class="sd-btn danger" id="paccar-clear">Clear</button></div>
            <div id="paccar-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Volvo -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Volvo (volvopg.asist.decisiv.net)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="volvo-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="volvo-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="volvo-save">Save</button><button class="sd-btn secondary" id="volvo-test">Test login</button><button class="sd-btn danger" id="volvo-clear">Clear</button></div>
            <div id="volvo-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Record360 -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Record360 (dashboard.record360.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Email</div><input class="sd-input" id="record360-user" placeholder="you@amazon.com"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="record360-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="record360-save">Save</button><button class="sd-btn secondary" id="record360-test">Test login</button><button class="sd-btn danger" id="record360-clear">Clear</button></div>
            <div id="record360-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Aperia / Halo -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Aperia / Halo Tire (amazon.aperiatech.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Email</div><input class="sd-input" id="aperia-user" placeholder="you@amazon.com"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="aperia-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="aperia-save">Save</button><button class="sd-btn secondary" id="aperia-test">Test login</button><button class="sd-btn danger" id="aperia-clear">Clear</button></div>
            <div id="aperia-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Reach24 -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Reach24 (amazon.reach24.net)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Email</div><input class="sd-input" id="reach24-user" placeholder="you@amazon.com"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="reach24-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="reach24-save">Save</button><button class="sd-btn secondary" id="reach24-test">Test login</button><button class="sd-btn danger" id="reach24-clear">Clear</button></div>
            <div id="reach24-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- DTNA -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">DTNA Service Tracker (dtna.my.site.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="dtna-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="dtna-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="dtna-save">Save</button><button class="sd-btn secondary" id="dtna-test">Test login</button><button class="sd-btn danger" id="dtna-clear">Clear</button></div>
            <div id="dtna-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Road Ready -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Road Ready (roadready.fadv.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="roadready-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="roadready-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="roadready-save">Save</button><button class="sd-btn secondary" id="roadready-test">Test login</button><button class="sd-btn danger" id="roadready-clear">Clear</button></div>
            <div id="roadready-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Velogic -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Velogic (velogic.my.site.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="velogic-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="velogic-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="velogic-save">Save</button><button class="sd-btn secondary" id="velogic-test">Test login</button><button class="sd-btn danger" id="velogic-clear">Clear</button></div>
            <div id="velogic-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Access Billing Services -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Access Billing Services (access-billing-services.com)</div>
            <div class="sd-row">
              <div class="sd-field"><div class="sd-label">Username</div><input class="sd-input" id="abs-user" placeholder="portal username"/></div>
              <div class="sd-field"><div class="sd-label">Password</div><input class="sd-input" id="abs-pass" type="password" placeholder="(encrypted)"/></div>
            </div>
            <div class="sd-btn-row"><button class="sd-btn primary" id="abs-save">Save</button><button class="sd-btn secondary" id="abs-test">Test login</button><button class="sd-btn danger" id="abs-clear">Clear</button></div>
            <div id="abs-status" class="settings__status" style="display:none"></div>
          </div>
          <!-- Uptake -- Amazon SSO, no password needed (FEATURE 2026-07-22) -->
          <div style="margin-bottom:10px">
            <div class="sd-label" style="margin-bottom:6px;color:var(--txt)">Uptake (fleet.uptake.com) -- Amazon SSO, no password needed</div>
            <div class="sd-btn-row"><button class="sd-btn secondary" id="uptake-test">Sign in to Uptake</button></div>
            <div id="uptake-status" class="settings__status" style="display:none"></div>
          </div>
        </div>


        <!-- Email SMTP -->
        <div class="sd-section" id="sect-email">
          <div class="sd-section-title">Email</div>
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
          <div class="sd-field" style="margin-top:8px">
            <div class="sd-label">Send Method</div>
            <select class="sd-input" id="email-method">
              <option value="auto">Auto (Graph → SMTP → OWA)</option>
              <option value="graph">Microsoft Graph (no VPN needed)</option>
              <option value="smtp">SMTP (VPN required)</option>
              <option value="owa">OWA (in-app compose window)</option>
            </select>
          </div>
          <div class="sd-btn-row">
            <button class="sd-btn primary"    id="email-save">Save</button>
            <button class="sd-btn secondary"  id="email-test">Send test</button>
          </div>
          <div id="email-status" class="settings__status" style="display:none"></div>
        </div>

        <!-- Auto-Email Note -->
        <div class="sd-section" id="sect-auto-note">
          <div class="sd-section-title">Auto-Email Note</div>
          <div class="sd-hint" style="margin-bottom:10px">Optional note included as a red banner at the top of every scheduled auto-send (08:00 / 15:15) until cleared.</div>
          <textarea class="sd-input" id="auto-note-text" rows="2" placeholder="e.g. 'Units at EWR45 excluded due to site freeze'" style="width:100%;resize:vertical;"></textarea>
          <div class="sd-toggle-row" style="margin-top:8px">
            <span class="sd-toggle-label">Clear automatically after next auto-send</span>
            <input type="checkbox" id="auto-note-oneshot"/>
          </div>
          <div class="sd-btn-row" style="margin-top:8px">
            <button class="sd-btn primary" id="auto-note-save">Save note</button>
            <button class="sd-btn secondary" id="auto-note-clear">Clear note</button>
          </div>
          <div id="auto-note-status" class="sd-status" style="display:none;margin-top:8px"></div>
          <div id="auto-note-preview" style="display:none;margin-top:10px;padding:10px 16px;color:#dc2626;font-weight:bold;font-family:Arial,sans-serif;font-size:12px;background:#fef2f2;border:1px solid #fca5a5;border-radius:4px;word-break:break-word;">NOTE: </div>
        </div>

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

        <!-- Outlook (Microsoft Graph) — 2026-07-21. Replaces the need for
             SMTP (requires VPN) or pasting into OWA's compose editor
             (strips colors via its own sanitizer -- see src/graph/client.js
             for the full writeup). Sign in once, like Slack above; stays
             signed in silently after that via a background token refresh. -->
        <div class="sd-section" id="sect-graph">
          <div class="sd-section-title">Outlook (Microsoft Graph)</div>
          <div class="sd-hint" style="margin-bottom:8px">Sends fleet reports directly via Microsoft Graph -- no VPN needed, and colors/formatting always render correctly (unlike pasting into Outlook Web).</div>
          <div id="graph-status" class="sd-status warn" style="margin-bottom:8px">Not connected</div>
          <div class="sd-btn-row">
            <button class="sd-btn primary"   id="graph-login">Sign in to Outlook</button>
            <button class="sd-btn secondary" id="graph-recheck">Re-check</button>
            <button class="sd-btn secondary" id="graph-logout">Sign out</button>
          </div>
        </div>

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

        <!-- Fleet Ops Companion — removed (feature discontinued) -->

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
          </div>
        </div>
        <!-- FEATURE (2026-07-23): removed the dead "Sync Now" button and its
             "Run a sync to load operators" label that used to live in the
             pane header above. Neither one was ever wired up: the button
             had no click listener anywhere, the label was never updated by
             any code, and the one function that looked like it populated a
             list here (_renderOperators, removed below) was never called
             and referenced DOM ids (#ops-list, #ops-empty-state) that don't
             exist in this template. The Operators tab's real data (the
             per-operator SharePoint workbook cards above) is populated by a
             separate, live mechanism, not by this button. -->
        <!-- FEATURE (2026-07-22): removed the duplicate "Email — Global
             SMTP" panel that lived here. It was 100% dead/broken: no event
             listener ever wired the inputs or the "Send test email"
             button, nothing populated the fields on load, and the one
             function that referenced them (_opsEmailAutoSave) called an
             undeclared variable (_opsEmailTimers) that would have thrown a
             ReferenceError the instant it ran. Even setting that aside, it
             saved into spConfig.email* fields that nothing else in the
             codebase ever reads back -- a second, disconnected config that
             could never actually be used to send mail.
             The single real SMTP config is "Email (SMTP)" above (id
             sect-email, wired by _wireEmail()) -- it writes to
             email_config.json via emailBridge.saveConfig(), which is what
             sendFleetEmail() (src/scrapers/email_sender.js) actually reads
             from when sending a report over SMTP. -->
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
    // BUG FIX (2026-07-22): only split on commas -- a newline-separated
    // list (one code per line, which is how the textarea's own
    // placeholder now shows it, and how most people naturally type a
    // list of site codes) collapsed into ONE array entry containing
    // literal embedded newlines, e.g. ["ABE40\nAVP40\nAUVTE01"] instead
    // of ["ABE40","AVP40","AUVTE01"]. Confirmed live in this exact
    // installation's real settings.json before this fix. Any code
    // downstream that expects individual clean domicile codes (the AAP
    // scan URL builder, the sync engine) would silently fail to match
    // anything against a single garbled multi-line string -- producing
    // exactly the "I entered domiciles and it did nothing" symptom.
    // Backend settings:save-domiciles (src/ipc/settings.js) already
    // splits on /[\n,]+/ -- this now matches it exactly.
    const codes = raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    const st = document.getElementById('domicile-status');
    if (!codes.length) {
      st.textContent = '\u26A0\uFE0F Enter at least one domicile code first'; st.style.display = 'block';
      return;
    }
    try {
      await settingsBridge.saveDomiciles(codes);
      st.textContent = '\u2705 Saved'; st.style.display = 'block';
      setTimeout(() => { st.style.display = 'none'; }, 2000);
    } catch (e) {
      st.textContent = '\u274C ' + (e.message || 'Save failed'); st.style.display = 'block';
    }
  });
  document.getElementById('reset-domiciles').addEventListener('click', async () => {
    // BUG FIX (2026-07-22): this called saveDomiciles([]) -- but the
    // backend handler THROWS on an empty list ("domicile list cannot be
    // empty", src/ipc/settings.js) and this had no .catch() anywhere, so
    // "Reset defaults" has never once actually worked; it silently threw
    // an unhandled promise rejection with zero visible feedback. The
    // backend already has a dedicated, correct handler for exactly this
    // (settings:reset-domiciles, returns DEFAULTS.DEFAULT_DOMICILES) --
    // switched to that instead of trying to save an empty list.
    try {
      const result = await settingsBridge.resetDomiciles();
      const codes = (result && result.domiciles) || [];
      document.getElementById('settings-domiciles').value = codes.join('\n');
      const st = document.getElementById('domicile-status');
      st.textContent = '\u2705 Reset to defaults'; st.style.display = 'block';
      setTimeout(() => { st.style.display = 'none'; }, 2000);
    } catch (e) {
      const st = document.getElementById('domicile-status');
      st.textContent = '\u274C ' + (e.message || 'Reset failed'); st.style.display = 'block';
    }
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
    // Orcha agent (selects the server-side model) — defaults to orcha_default (Opus 4.6)
    const agentEl = document.getElementById('orcha-agent');
    if (agentEl) agentEl.value = cfg.orchaAgentId || 'orcha_default';
    // Model ID (Bedrock fallback leg) — blank field means "use app default"
    const modelEl = document.getElementById('ai-model-id');
    if (modelEl) modelEl.value = cfg.modelId || '';
    // Claude fields
    const binEl  = document.getElementById('claude-bin-path');
    const toEl   = document.getElementById('claude-timeout');
    if (binEl) binEl.value = cfg.claudeBin || '(auto)';
    if (toEl)  toEl.value  = Math.round((cfg.claudeTimeoutMs || 60000) / 1000);
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
      auto:   'Auto: tries Orcha first, falls back to Claude Code if quota is exceeded.',
      orcha:  'Orcha only: no Claude fallback. AI is unavailable if Orcha quota runs out.',
      claude: 'Claude Code only: skips Orcha, uses Cecelia shared Bedrock via claude -p.',
    };
    const el = document.getElementById('ai-pref-hint');
    if (el) el.textContent = hints[pref] || '';
  }

  function _updateChipStyles(pref) {
    ['auto', 'orcha', 'claude'].forEach(p => {
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
    await window.ai.saveAIConfig({
      aiPreference:    pref,
      mode:            (document.getElementById('orcha-mode') || {}).value || 'local',
      host:            ((document.getElementById('orcha-host') || {}).value || '').trim(),
      port:            parseInt((document.getElementById('orcha-port') || {}).value, 10) || 4799,
      orchaAgentId:    (document.getElementById('orcha-agent') || {}).value || 'orcha_default',
      modelId:         ((document.getElementById('ai-model-id') || {}).value || '').trim(),
      claudeTimeoutMs: toSecs * 1000,
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

    // FEATURE (2026-07-22): opens the real vendor portal and attempts the
    // exact same auto-login pass (src/orcha/auto-login.js) the background
    // AAP/Relay scraper already uses in production for this host -- see
    // src/ipc/credentials.js (credentials:test-login) for the full design.
    const testBtn = document.getElementById(`${v}-test`);
    if (testBtn) testBtn.addEventListener('click', async () => {
      const st = document.getElementById(`${v}-status`);
      if (st) { st.textContent = '\u23F3 Opening portal...'; st.style.display = 'block'; st.className = 'settings__status settings__status--loading'; }
      try {
        const r = await credsBridge.testLogin(v);
        if (st) {
          if (r && r.ok && r.attempted) { st.textContent = '\u2705 Login attempted -- check the window that opened'; st.className = 'settings__status settings__status--ok'; }
          else if (r && r.closedByUser) { st.textContent = 'Window closed'; st.className = 'settings__status'; }
          else { st.textContent = '\u26A0\uFE0F No saved credentials to try -- save above first'; st.className = 'settings__status settings__status--loading'; }
        }
      } catch (e) {
        if (st) { st.textContent = '\u274C ' + e.message; st.className = 'settings__status settings__status--err'; st.style.display = 'block'; }
      }
    });
  });

  // Uptake -- Amazon SSO, no credentials to save/clear, just a sign-in test
  const uptakeBtn = document.getElementById('uptake-test');
  if (uptakeBtn) uptakeBtn.addEventListener('click', async () => {
    const st = document.getElementById('uptake-status');
    if (st) { st.textContent = '\u23F3 Opening Uptake...'; st.style.display = 'block'; st.className = 'settings__status settings__status--loading'; }
    try {
      const r = await credsBridge.testLogin('uptake');
      if (st) {
        if (r && r.ok && r.attempted) { st.textContent = '\u2705 SSO attempted -- check the window that opened'; st.className = 'settings__status settings__status--ok'; }
        else if (r && r.closedByUser) { st.textContent = 'Window closed'; st.className = 'settings__status'; }
        else { st.textContent = '\u26A0\uFE0F Could not sign in automatically -- requires Midway'; st.className = 'settings__status settings__status--loading'; }
      }
    } catch (e) {
      if (st) { st.textContent = '\u274C ' + e.message; st.className = 'settings__status settings__status--err'; st.style.display = 'block'; }
    }
  });
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

function _wireEmail() {
  var saveBtn   = document.getElementById('email-save');
  var testBtn   = document.getElementById('email-test');
  var statusEl  = document.getElementById('email-status');
  function showEmailStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'settings__status ' + (cls || '');
    statusEl.style.display = '';
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
  }
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const methodEl = document.getElementById('email-method');
    await emailBridge.saveConfig({
      host:        document.getElementById('email-host').value.trim(),
      port:        parseInt(document.getElementById('email-port').value, 10) || 587,
      from:        document.getElementById('email-from').value.trim(),
      user:        document.getElementById('email-user').value.trim(),
      pass:        document.getElementById('email-pass').value,
      emailMethod: methodEl ? methodEl.value : 'auto',
    });
    document.getElementById('email-pass').value = '';
    const methodLabel = { auto: 'Auto', graph: 'Microsoft Graph', smtp: 'SMTP', owa: 'OWA' };
    const sel = methodEl ? (methodLabel[methodEl.value] || methodEl.value) : 'Auto';
    showEmailStatus('Saved — send method: ' + sel, 'ok');
  });
  if (testBtn) testBtn.addEventListener('click', () => {});
}

// FEATURE (2026-07-16): persisted note for scheduled auto-sends (08:00 /
// 15:15). Stored via the generic settings:save IPC under keys
// `autoEmailNote` / `autoEmailNoteOneShot` — read fresh by the scheduler in
// src/app.js on every fire, so edits here take effect on the very next slot.
function _wireAutoNote() {
  var textEl    = document.getElementById('auto-note-text');
  var oneShotEl = document.getElementById('auto-note-oneshot');
  var saveBtn   = document.getElementById('auto-note-save');
  var clearBtn  = document.getElementById('auto-note-clear');
  var statusEl  = document.getElementById('auto-note-status');
  var previewEl = document.getElementById('auto-note-preview');
  if (!textEl || !saveBtn) return;

  function _updateNotePreview() {
    if (!previewEl) return;
    var txt = (textEl.value || '').trim();
    if (txt) { previewEl.textContent = 'NOTE: ' + txt; previewEl.style.display = ''; }
    else { previewEl.style.display = 'none'; }
  }
  textEl.addEventListener('input', _updateNotePreview);

  function showStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'sd-status ' + (cls || '');
    statusEl.style.display = '';
  }

  // Populate current state on load
  settingsBridge.getAll().then((all) => {
    var s = all || {};
    textEl.value = s.autoEmailNote || '';
    if (oneShotEl) oneShotEl.checked = !!s.autoEmailNoteOneShot;
    _updateNotePreview();
    if (s.autoEmailNote) {
      showStatus('✅ Active — will be included in the next scheduled auto-send' + (s.autoEmailNoteOneShot ? ' (one-time only)' : ''), 'ok');
    }
  }).catch(() => {});

  saveBtn.addEventListener('click', async () => {
    var note = (textEl.value || '').trim();
    if (!note) { showStatus('⚠️ Enter a note first, or use "Clear note" to remove an existing one', 'warn'); return; }
    await settingsBridge.save('autoEmailNote', note);
    await settingsBridge.save('autoEmailNoteOneShot', !!(oneShotEl && oneShotEl.checked));
    showStatus('✅ Saved — will be included in the next scheduled auto-send' + (oneShotEl && oneShotEl.checked ? ' (one-time only)' : ''), 'ok');
    toast.show('success', 'Auto-email note saved', 2500);
  });

  clearBtn.addEventListener('click', async () => {
    textEl.value = '';
    if (oneShotEl) oneShotEl.checked = false;
    await settingsBridge.save('autoEmailNote', '');
    await settingsBridge.save('autoEmailNoteOneShot', false);
    showStatus('Note cleared — future auto-sends will not include a note', '');
    toast.show('info', 'Auto-email note cleared', 2500);
  });
}

// FEATURE (2026-07-16): "Schedulers – Config → Sync interval (minutes)" had
// zero wiring anywhere -- no click handler, no IPC handler, no read path.
// The main data sync (AAP/Uptake/Relay) ran on a hardcoded 5-minute timer
// (DEFAULTS.SYNC_INTERVAL_MS in src/config/defaults.js) with no way to
// change it from the UI. Now backed by settings:get-sync-interval /
// settings:save-sync-interval (src/ipc/settings.js), which persist to the
// settings store and immediately restart the live timer in src/app.js via
// ctx.reloadSyncInterval -- no app restart required.
// Note: the "Default scheduler endpoint" field in this same section maps
// to no existing concept in the codebase and remains intentionally
// unwired -- flagged with an in-UI hint rather than silently left broken.
function _wireSchedulerConfig() {
  var intervalEl = document.getElementById('sched-interval');
  var saveBtn    = document.getElementById('save-sched');
  var statusEl   = document.getElementById('sched-status');
  if (!intervalEl || !saveBtn) return;

  function showStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = 'sd-inline-status' + (cls ? ' ' + cls : '');
    statusEl.style.color = cls === 'err' ? '#ef4444' : cls === 'warn' ? '#eab308' : cls === 'ok' ? '#22c55e' : '#8b949e';
  }

  settingsBridge.getSyncInterval().then((res) => {
    var effective = (res && res.effectiveMinutes) || 5;
    if (res && res.minutes) {
      intervalEl.value = res.minutes;
      showStatus('Currently syncing every ' + res.minutes + ' min (custom)', 'ok');
    } else {
      showStatus('Currently syncing every ' + effective + ' min (default)', '');
    }
  }).catch(() => {});

  saveBtn.addEventListener('click', async () => {
    var raw = (intervalEl.value || '').trim();
    var minutes = parseInt(raw, 10);
    if (!raw || isNaN(minutes)) { showStatus('⚠️ Enter a number of minutes first', 'warn'); return; }
    try {
      var result = await settingsBridge.saveSyncInterval(minutes);
      if (result && result.ok) {
        showStatus('✅ Saved — now syncing every ' + result.minutes + ' min (applied immediately)', 'ok');
        toast.show('success', 'Sync interval updated to ' + result.minutes + ' min', 3000);
      } else {
        showStatus('❌ ' + ((result && result.error) || 'Save failed'), 'err');
      }
    } catch (e) {
      showStatus('❌ ' + (e.message || 'Save failed'), 'err');
      toast.show('error', 'Save failed: ' + e.message, 4000);
    }
  });
}

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

// -- Section: Microsoft Graph mail (2026-07-21) -- see src/graph/client.js
// for the full "why" this exists. Mirrors _wireSlack()/_checkSlack() above
// exactly -- same interactive-sign-in UX pattern, different backend.
function _checkGraphMail() {
  graphMailBridge.checkAuth().then((res) => {
    const el = document.getElementById('graph-status');
    if (!el) return;
    if (!res || !res.configured) {
      el.textContent = '\u26A0\uFE0F Not yet configured (needs a Client ID -- see Settings help)';
      el.className = 'sd-status warn';
      return;
    }
    const ok = !!res.signedIn;
    el.textContent = ok ? '\u2705 Connected' : '\u26A0\uFE0F Not connected';
    el.className = `sd-status ${ok ? 'ok' : 'warn'}`;
  }).catch(() => {});
}

function _wireGraphMail() {
  _checkGraphMail();
  var recheckBtn = document.getElementById('graph-recheck');
  var loginBtn = document.getElementById('graph-login');
  if (recheckBtn) recheckBtn.addEventListener('click', _checkGraphMail);
  if (loginBtn) loginBtn.addEventListener('click', () => {
    loginBtn.disabled = true;
    const originalText = loginBtn.textContent;
    loginBtn.textContent = 'Signing in\u2026';
    graphMailBridge.signIn().then((result) => {
      if (result && result.ok) {
        toast.show('success', 'Signed in to Outlook (' + (result.account || '') + ')', 3000);
      } else {
        toast.show('warn', (result && result.error) || 'Sign-in was not completed', 4000);
      }
      _checkGraphMail();
    }).catch((e) => {
      toast.show('error', 'Outlook sign-in failed: ' + e.message, 4000);
    }).finally(() => {
      loginBtn.disabled = false;
      loginBtn.textContent = originalText;
    });
  });

  var logoutBtn = document.getElementById('graph-logout');
  if (logoutBtn) logoutBtn.addEventListener('click', () => {
    graphMailBridge.signOut().then(() => {
      toast.show('info', 'Signed out of Outlook', 2500);
      _checkGraphMail();
    }).catch((e) => toast.show('error', 'Sign-out failed: ' + e.message, 3000));
  });
}

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
        ${chMode !== 'justme' ? `<div style="margin-top:6px;padding-top:5px;border-top:1px solid rgba(48,54,61,.6)">
          <div style="font-size:9px;color:var(--mut);margin-bottom:3px">Operators (data scope) &mdash; empty = full fleet</div>
          <select class="par-ch-ops" data-idx="${i}" multiple size="3" style="width:100%;font-size:10px;background:var(--el);color:var(--txt);border:1px solid var(--bdr);border-radius:5px">${_parOperatorOptions(ch.operators || [])}</select>
        </div>` : ''}
      </div>`;
    }).join('');

    listEl.querySelectorAll('.par-ch-ops').forEach((sel) => {
      sel.addEventListener('change', () => {
        const i = parseInt(sel.getAttribute('data-idx'), 10);
        if (_currentConfig && _currentConfig.channels[i]) {
          _currentConfig.channels[i].operators = Array.from(sel.selectedOptions || []).map(function(o){ return o.value; });
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
    const _firstSel = listEl && listEl.querySelector('.par-ch-ops');
    const _needsBackfill = _firstSel && _firstSel.options.length === 0 && _parFleetOperators().length > 0;
    if (_needsBackfill) render(_currentConfig);
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
    // BUG FIX (2026-07-16): identical defect to the Slack status check
    // above -- checkAuth() resolves to an object ({ ok: bool, ... }), not a
    // boolean, so this always showed "Token valid" once the promise
    // resolved regardless of actual state.
    asanaBridge.checkAuth().then((res) => {
      const ok = !!(res && res.ok);
      const st = document.getElementById('asana-status');
      st.textContent = ok ? '✅ Token valid' : '❌ Token invalid';
      st.style.display = 'block';
    }).catch(() => {});
  });
}

// ── Section: Fleet Ops Companion — removed (feature discontinued) ────────────

// ── Section: Notifications ───────────────────────────────────────────────────
function _wireNotifications() {
  // BUG-AWARE (2026-07-22): settings:save fully REPLACES whatever value
  // is stored under a key (confirmed in src/ipc/settings.js -- `s[key] =
  // value`, not a merge) -- so every save here must include ALL fields
  // under 'notifications', not just the one that changed, or the other
  // toggles would silently get wiped back to undefined.
  function _saveAll() {
    const soundsEnabledEl = document.getElementById('notif-sounds-enabled');
    const volumeEl = document.getElementById('notif-sounds-volume');
    const volume = volumeEl ? (parseInt(volumeEl.value, 10) || 0) / 100 : 0.5;
    const soundsEnabled = soundsEnabledEl ? !!soundsEnabledEl.checked : true;
    settingsBridge.save('notifications', {
      authFail:     document.getElementById('notif-auth-fail').checked,
      syncOk:       document.getElementById('notif-sync-ok').checked,
      syncErr:      document.getElementById('notif-sync-err').checked,
      soundsEnabled,
      soundVolume:  volume,
    }).catch(() => {});
    // FEATURE (2026-07-22): live-update the already-running notif sound
    // module immediately -- no restart needed to see/hear the change.
    bus.emit('notif-sounds:config', { enabled: soundsEnabled, volume });
  }

  ['notif-auth-fail', 'notif-sync-ok', 'notif-sync-err', 'notif-sounds-enabled'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', _saveAll);
  });

  const volumeEl = document.getElementById('notif-sounds-volume');
  if (volumeEl) volumeEl.addEventListener('input', _saveAll);

  const testBtn = document.getElementById('notif-sounds-test');
  if (testBtn) testBtn.addEventListener('click', () => {
    // Briefly force-enable playback for the test regardless of the
    // current checkbox state, using whatever volume is currently set,
    // so "Test sounds" always audibly demonstrates all 4 types even if
    // the user is mid-way through deciding whether to enable them.
    const volumeEl2 = document.getElementById('notif-sounds-volume');
    const volume = volumeEl2 ? (parseInt(volumeEl2.value, 10) || 0) / 100 : 0.5;
    const prevConfig = notifSounds.getConfig();
    notifSounds.configure({ enabled: true, volume });
    ['success', 'error', 'alert', 'message'].forEach((type, i) => {
      setTimeout(() => notifSounds.play(type), i * 700);
    });
    setTimeout(() => notifSounds.configure(prevConfig), 4 * 700 + 300);
  });
}


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
  const pass = prefill.pass || '';

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
      <input class="acct-input acct-pass" type="password" placeholder="password" value="${_esc(pass)}"/>
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
    // BUG FIX (2026-07-23): password was never included here, so it was
    // never persisted -- every reload silently wiped it, which is why the
    // eye/show-password toggle appeared "broken" (there was nothing saved
    // to reveal). Not trimmed: leading/trailing spaces can be intentional
    // in a password.
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

    // Chat floater size
    const chatSizeBtn = _drawer.querySelector('[data-chat-size].active');
    const chatSize = chatSizeBtn ? chatSizeBtn.dataset.chatSize : 'normal';

    // Compact toggle
    const compact = document.getElementById('toggle-compact');
    const compactRows = compact ? compact.checked : false;

    settingsBridge.save('ui_prefs', { theme, swatches, sliders, font, compactRows, chatSize })
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

    if (all.domiciles) {
      const el = document.getElementById('settings-domiciles');
      if (el) el.value = Array.isArray(all.domiciles) ? all.domiciles.join('\n') : all.domiciles;
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
      // Restore saved send method
      if (e.emailMethod) {
        const mEl = document.getElementById('email-method');
        if (mEl) mEl.value = e.emailMethod;
      }
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
      const sndEn = document.getElementById('notif-sounds-enabled');
      const sndVol = document.getElementById('notif-sounds-volume');
      if (af && n.authFail != null) af.checked = n.authFail;
      if (so && n.syncOk   != null) so.checked = n.syncOk;
      if (se && n.syncErr  != null) se.checked = n.syncErr;
      if (sndEn) sndEn.checked = n.soundsEnabled !== false; // default ON if never set
      if (sndVol && typeof n.soundVolume === 'number') sndVol.value = Math.round(n.soundVolume * 100);
    }
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

  // Wire tabs
  _wireTabSwitching();

  // Wire UI tab controls
  _wireUITab();

  // Wire Chat Floater opacity control (IPC-backed, separate from the
  // localStorage-based UI theme sliders above, since it must reach the
  // bubble BrowserWindow's own separate renderer process).
  _wireChatFloaterSection();

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
  _wireGraphMail();
  _wirePartnerAutoReply();
  _wireDMAutoReply();
  _wireEmail();
  _wireAutoNote();
  _wireSchedulerConfig();
  _wireSP();
  _wireAsana();
  _wireNotifications();
  _wireAccounts();
  _wireSectionAccordion('sd-pane-integrations');
  _wireSectionAccordion('sd-pane-ui');
  _wireSectionAccordion('sd-pane-operators');

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
  }).catch(() => {});
}
