/**
 * setup.js -- Setup wizard renderer entry point
 *
 * BUG FIX (2026-07-22): the wizard previously collected every field into
 * one big object and handed it to a 'wizard:complete' IPC event at the
 * very end -- but nothing in the app ever sent that event (confirmed via
 * a full-codebase search), so EVERYTHING typed into the wizard (name,
 * domiciles, Orcha config, etc.) was silently discarded on every single
 * completed setup, and the app always booted on hardcoded defaults.
 *
 * Fix: every step now saves itself immediately, through the exact same
 * bridge calls (window.settings / window.slack / window.email / etc.)
 * that the real, working Settings drawer uses for the same fields --
 * same preload.js is loaded in this window, so all of those are already
 * available here. There is no more "collect everything, apply it all at
 * the end" step to go stale.
 *
 * EXPANDED (2026-07-22): now has a real, working step for every
 * FUNCTIONAL setting in the app (not just profile/domiciles/midway),
 * covering: profile, domiciles, midway, notifications (incl. sound),
 * Orcha, Email (SMTP), Outlook (Graph), Slack, SharePoint workbooks,
 * Asana, vendor portal credentials, and sync interval.
 *
 * Deliberately NOT included, with reasons (see setup/state.js for the
 * same note):
 *   - Appearance/theme, Partner WR Forms Google Sheet -- both persist to
 *     this renderer's own localStorage, which is NOT shared with the
 *     main window (separate BrowserWindow = separate storage). Wiring
 *     them here would silently reproduce the exact bug this expansion
 *     exists to fix. Configure both in Settings (10 seconds, one time).
 *   - Operators & SP per-operator mapping, generic Accounts bookmarks --
 *     both are auto-populated / only meaningful once a real sync has run
 *     and returned real domicile/operator data, which doesn't exist yet
 *     on a first launch.
 *
 * Required steps (must be completed to finish setup): profile, domiciles, midway.
 * Everything else is optional and individually skippable.
 */

import * as notifSounds from '../js/notif-sounds.js';

// ── Small helpers ────────────────────────────────────────────────────────
function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function _showInline(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'setup__inline-status' + (cls ? ' ' + cls : '');
  el.style.display = text ? '' : 'none';
}

// Tracks a one-line human-readable summary per step, shown on the Confirm
// screen. Populated as each step actually succeeds at saving something --
// not from raw form values -- so the summary reflects what's REALLY saved.
const _savedSummary = {};

// ── Step definitions ─────────────────────────────────────────────────────
const STEPS = [
  // ════════════════════════════════════════════════════════════ REQUIRED
  {
    id: 'profile', title: 'Your Profile', required: true,
    html: `
      <label>Full Name <input id="sw-name" type="text" class="setup__input" placeholder="Jane Smith" /></label>
      <label>Amazon Email <input id="sw-email" type="email" class="setup__input" placeholder="jsmith@amazon.com" /></label>
      <label>Phone (optional) <input id="sw-phone" type="tel" class="setup__input" placeholder="+1 555 0100" /></label>
    `,
    validate: () => {
      const name  = document.getElementById('sw-name').value.trim();
      const email = document.getElementById('sw-email').value.trim();
      if (!name)  return { ok: false, error: 'Enter your name.' };
      if (!/\S+@\S+\.\S+/.test(email)) return { ok: false, error: 'Enter a valid email address.' };
      return { ok: true };
    },
    onNext: async () => {
      const name  = document.getElementById('sw-name').value.trim();
      const email = document.getElementById('sw-email').value.trim();
      const phone = document.getElementById('sw-phone').value.trim();
      await window.settings.save('profile', { name, email, phone, role: 'Fleet Coordinator' });
      // Seed a sensible per-operator email default from the profile --
      // same intent the old (dead) completion step had, now actually applied.
      try {
        await window.email.saveOpEmails({
          username: 'ANT\\' + (email.split('@')[0] || ''),
          password: '', from: email, defaultTo: '', defaultCc: '',
        });
      } catch (_) { /* non-fatal -- op email defaults are a convenience, not required */ }
      _savedSummary.profile = [name, email, phone].filter(Boolean).join(' | ');
      return { ok: true };
    },
  },
  {
    id: 'domiciles', title: 'Your Domicile Sites', required: true,
    html: `
      <p class="setup__hint">Enter your domicile site codes, one per line or comma-separated (e.g. ABE40).</p>
      <textarea id="sw-domiciles" class="setup__textarea" rows="6" placeholder="ABE40&#10;EWR45&#10;PHL40"></textarea>
    `,
    validate: () => {
      const codes = document.getElementById('sw-domiciles').value
        .split(/[\n,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (!codes.length) return { ok: false, error: 'Enter at least one domicile code -- the app has nothing to sync without one.' };
      return { ok: true, codes };
    },
    onNext: async () => {
      const codes = document.getElementById('sw-domiciles').value
        .split(/[\n,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
      try {
        // BUG FIX (2026-07-22): this is the exact call the working
        // Settings -> Domiciles "Save" button makes
        // (settings:save-domiciles) -- it also triggers an immediate
        // rescan. The wizard previously wrote a different, dead code
        // path that never actually ran.
        await window.settings.saveDomiciles(codes);
        _savedSummary.domiciles = codes.join(', ');
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message || 'Save failed.' };
      }
    },
  },
  {
    id: 'midway', title: 'Midway Authentication', required: true,
    html: `
      <p class="setup__hint">Fleet Operations requires Midway (mwinit) for internal tool access.</p>
      <div id="sw-midway-status" class="setup__status">Not checked yet</div>
      <button id="sw-run-mwinit" class="setup__btn setup__btn--secondary" type="button">Check / Run mwinit</button>
    `,
    afterMount: () => {
      window.auth.checkMidway().then((ok) => {
        document.getElementById('sw-midway-status').textContent = ok ? 'Midway OK' : 'Not authenticated yet -- click below';
      }).catch(() => {});
      document.getElementById('sw-run-mwinit').addEventListener('click', async () => {
        document.getElementById('sw-midway-status').textContent = 'Running mwinit...';
        try {
          const r = await window.auth.runMwinit();
          document.getElementById('sw-midway-status').textContent =
            r && r.ok ? 'Midway OK' : ('Failed: ' + ((r && r.reason) || 'unknown'));
        } catch (e) {
          document.getElementById('sw-midway-status').textContent = 'Error: ' + e.message;
        }
      });
    },
    // BUG FIX (2026-07-22): previously the Next button on this REQUIRED
    // step advanced (and marked it complete) unconditionally, with no
    // check that mwinit had actually succeeded -- a required step that
    // could never actually block anything. Now verified live at Next time.
    validate: async () => {
      try {
        const ok = await window.auth.checkMidway();
        if (!ok) return { ok: false, error: 'Run mwinit above and confirm it says "Midway OK" before continuing.' };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message || 'Could not verify Midway status.' };
      }
    },
    onNext: async () => { _savedSummary.midway = 'Authenticated'; return { ok: true }; },
  },

  // ════════════════════════════════════════════════════════════ OPTIONAL
  {
    id: 'notifications', title: 'Notifications', required: false,
    html: `
      <p class="setup__hint">All optional -- you can change these anytime in Settings.</p>
      <div class="setup__toggle-row"><span>OS notification on Midway auth failure</span><input type="checkbox" id="sw-notif-auth-fail" checked/></div>
      <div class="setup__toggle-row"><span>OS notification on sync complete</span><input type="checkbox" id="sw-notif-sync-ok" checked/></div>
      <div class="setup__toggle-row"><span>OS notification on sync error</span><input type="checkbox" id="sw-notif-sync-err" checked/></div>
      <div class="setup__toggle-row"><span>Sound notifications</span><input type="checkbox" id="sw-notif-sounds" checked/></div>
      <label>Volume <input type="range" id="sw-notif-vol" min="0" max="100" value="50" /></label>
      <button id="sw-notif-test" class="setup__btn setup__btn--secondary" type="button">Test sounds</button>
    `,
    afterMount: () => {
      document.getElementById('sw-notif-test').addEventListener('click', () => {
        const vol = (parseInt(document.getElementById('sw-notif-vol').value, 10) || 0) / 100;
        notifSounds.configure({ enabled: true, volume: vol });
        ['success', 'error', 'alert', 'message'].forEach((t, i) => setTimeout(() => notifSounds.play(t), i * 700));
      });
    },
    onNext: async () => {
      const cfg = {
        authFail:     document.getElementById('sw-notif-auth-fail').checked,
        syncOk:       document.getElementById('sw-notif-sync-ok').checked,
        syncErr:      document.getElementById('sw-notif-sync-err').checked,
        soundsEnabled: document.getElementById('sw-notif-sounds').checked,
        soundVolume:  (parseInt(document.getElementById('sw-notif-vol').value, 10) || 0) / 100,
      };
      await window.settings.save('notifications', cfg);
      _savedSummary.notifications = 'Configured';
      return { ok: true };
    },
  },
  {
    id: 'orcha', title: 'Orcha AI Config', required: false,
    html: `
      <p class="setup__hint">Optional -- powers AI features across the app. Skip and configure later if you're not ready.</p>
      <label>Mode
        <select id="sw-orcha-mode" class="setup__select">
          <option value="local">Local</option>
          <option value="remote">Remote</option>
        </select>
      </label>
      <label>Host (if remote) <input id="sw-orcha-host" class="setup__input" type="text" placeholder="localhost" /></label>
      <label>Port <input id="sw-orcha-port" class="setup__input" type="number" placeholder="4799" /></label>
      <div class="setup__btn-row">
        <button id="sw-orcha-test" class="setup__btn setup__btn--secondary" type="button">Test connection</button>
      </div>
      <div id="sw-orcha-status" class="setup__inline-status" style="display:none"></div>
    `,
    afterMount: () => {
      document.getElementById('sw-orcha-test').addEventListener('click', async () => {
        _showInline('sw-orcha-status', 'Connecting...', '');
        try {
          const r = await window.ai.test();
          if (r && r.ok) _showInline('sw-orcha-status', 'Connected -- ' + (r.response || 'OK').substring(0, 40), 'ok');
          else _showInline('sw-orcha-status', 'Failed: ' + ((r && (r.lastError || r.status)) || 'no response'), 'err');
        } catch (e) { _showInline('sw-orcha-status', 'Error: ' + e.message, 'err'); }
      });
    },
    onNext: async () => {
      const mode = document.getElementById('sw-orcha-mode').value;
      const host = document.getElementById('sw-orcha-host').value.trim();
      const port = parseInt(document.getElementById('sw-orcha-port').value, 10) || 4799;
      // BUG FIX (2026-07-22): the old dead code saved this under a
      // DIFFERENT key ('orchaConfig' via store.save directly) than what
      // the real Settings "Orcha Config" panel actually uses
      // (settings:save with key 'orcha') -- so even if it HAD run, it
      // would have written to a key nothing else reads.
      await window.settings.save('orcha', { mode, host, port });
      _savedSummary.orcha = mode + (mode === 'remote' ? ' @ ' + host + ':' + port : '');
      return { ok: true };
    },
  },
  {
    id: 'email', title: 'Email (SMTP)', required: false,
    html: `
      <p class="setup__hint">Optional -- needed for scheduled fleet report emails. Skip if you'll use Outlook (next step) instead.</p>
      <label>Host <input id="sw-email-host" class="setup__input" placeholder="smtp.corp.amazon.com" /></label>
      <label>Port <input id="sw-email-port" class="setup__input" type="number" placeholder="587" /></label>
      <label>From <input id="sw-email-from" class="setup__input" type="email" placeholder="you@amazon.com" /></label>
      <label>Username <input id="sw-email-user" class="setup__input" placeholder="LDAP user" /></label>
      <label>Password <input id="sw-email-pass" class="setup__input" type="password" placeholder="(encrypted)" /></label>
    `,
    onNext: async () => {
      const host = document.getElementById('sw-email-host').value.trim();
      const port = parseInt(document.getElementById('sw-email-port').value, 10) || 587;
      const from = document.getElementById('sw-email-from').value.trim();
      const user = document.getElementById('sw-email-user').value.trim();
      const pass = document.getElementById('sw-email-pass').value;
      if (!host && !from && !user && !pass) { _savedSummary.email = 'skipped'; return { ok: true }; } // nothing entered -- treat as a clean skip, not an error
      await window.email.saveConfig({ host, port, from, user, pass });
      document.getElementById('sw-email-pass').value = '';
      _savedSummary.email = host ? (host + ':' + port) : 'saved';
      return { ok: true };
    },
  },
  {
    id: 'graph', title: 'Outlook (Microsoft Graph)', required: false,
    html: `
      <p class="setup__hint">Sends fleet reports via Microsoft Graph -- no VPN needed. Sign in once; stays signed in after that.</p>
      <div id="sw-graph-status" class="setup__status">Checking...</div>
      <button id="sw-graph-login" class="setup__btn setup__btn--secondary" type="button">Sign in to Outlook</button>
    `,
    afterMount: () => {
      const check = () => window.graphMail.checkAuth().then((res) => {
        const el = document.getElementById('sw-graph-status');
        if (!res || !res.configured) { el.textContent = 'Not yet configured -- skip, set up later in Settings'; return; }
        el.textContent = res.signedIn ? 'Connected' : 'Not connected';
      }).catch(() => {});
      check();
      document.getElementById('sw-graph-login').addEventListener('click', async () => {
        const btn = document.getElementById('sw-graph-login');
        btn.disabled = true; btn.textContent = 'Signing in...';
        try {
          const r = await window.graphMail.signIn();
          _savedSummary.graph = (r && r.ok) ? ('Connected: ' + (r.account || '')) : 'Not completed';
        } catch (e) { _savedSummary.graph = 'Error: ' + e.message; }
        btn.disabled = false; btn.textContent = 'Sign in to Outlook';
        check();
      });
    },
    onNext: async () => { if (!_savedSummary.graph) _savedSummary.graph = 'skipped'; return { ok: true }; },
  },
  {
    id: 'slack', title: 'Slack', required: false,
    html: `
      <p class="setup__hint">Needed for partner Slack channel monitoring and auto-reply features.</p>
      <div id="sw-slack-status" class="setup__status">Checking...</div>
      <button id="sw-slack-login" class="setup__btn setup__btn--secondary" type="button">Sign in to Slack</button>
    `,
    afterMount: () => {
      const check = () => window.slack.checkLiveAuth().then((res) => {
        document.getElementById('sw-slack-status').textContent = (res && res.authenticated) ? 'Connected' : 'Not connected';
      }).catch(() => {});
      check();
      document.getElementById('sw-slack-login').addEventListener('click', async () => {
        const btn = document.getElementById('sw-slack-login');
        btn.disabled = true; btn.textContent = 'Signing in...';
        try {
          const r = await window.slack.login();
          _savedSummary.slack = (r && r.ok) ? 'Connected' : ((r && r.error) || 'Not completed');
        } catch (e) { _savedSummary.slack = 'Error: ' + e.message; }
        btn.disabled = false; btn.textContent = 'Sign in to Slack';
        check();
      });
    },
    onNext: async () => { if (!_savedSummary.slack) _savedSummary.slack = 'skipped'; return { ok: true }; },
  },
  {
    id: 'sharepoint', title: 'SharePoint Workbooks', required: false,
    html: `
      <p class="setup__hint">Optional, and easier after your first sync (so you know your real domicile/operator codes) -- feel free to skip and configure later in Settings &rarr; Operators &amp; SP.</p>
      <label>SharePoint Excel URL <input id="sw-sp-url" class="setup__input" placeholder="Paste SharePoint Excel file URL..." /></label>
      <button id="sw-sp-discover" class="setup__btn setup__btn--secondary" type="button">Load sheets</button>
      <div id="sw-sp-results" style="display:none;margin-top:10px">
        <div id="sw-sp-sheets"></div>
      </div>
      <div id="sw-sp-status" class="setup__inline-status" style="display:none"></div>
    `,
    afterMount: () => {
      document.getElementById('sw-sp-discover').addEventListener('click', async () => {
        const url = document.getElementById('sw-sp-url').value.trim();
        if (!url) { _showInline('sw-sp-status', 'Paste a SharePoint Excel URL first.', 'warn'); return; }
        const btn = document.getElementById('sw-sp-discover');
        btn.disabled = true; btn.textContent = 'Discovering...';
        try {
          const result = await window.sp.discoverSheets(url);
          if (!result || !result.ok) { _showInline('sw-sp-status', (result && result.error) || 'Could not discover sheets.', 'err'); return; }
          const resultsDiv = document.getElementById('sw-sp-results');
          const sheetsDiv = document.getElementById('sw-sp-sheets');
          resultsDiv.style.display = '';
          sheetsDiv.innerHTML = result.sheets.map((s, i) => `
            <div class="setup__sheet-row">
              <input type="checkbox" id="sw-sp-sh-${i}" data-sheet="${_esc(s.xmlFile || s.name)}" data-name="${_esc(s.name)}" data-header="${_esc(s.headerRow)}" />
              <label for="sw-sp-sh-${i}"><strong>${_esc(s.name)}</strong> <span class="setup__mut">(header row ${_esc(s.headerRow)})</span></label>
              <input class="setup__input setup__input--sm" placeholder="Operator code" id="sw-sp-op-${i}" />
            </div>
          `).join('') + `
            <label>Domicile <input class="setup__input" id="sw-sp-domicile" placeholder="ABE40, AVP40..." /></label>
            <button id="sw-sp-save" class="setup__btn" type="button">Save workbook config</button>
          `;
          document.getElementById('sw-sp-save').addEventListener('click', async () => {
            const checks = sheetsDiv.querySelectorAll('input[type=checkbox]:checked');
            if (!checks.length) { _showInline('sw-sp-status', 'Select at least one sheet.', 'warn'); return; }
            const carriers = [];
            checks.forEach((cb) => {
              const headerRow = parseInt(cb.dataset.header || '16', 10);
              const opInput = cb.parentElement.querySelector('.setup__input--sm');
              const operator = opInput ? opInput.value.trim().toUpperCase() : '';
              carriers.push({ code: (operator || cb.dataset.name || 'DEFAULT').toUpperCase(), sheet: cb.dataset.sheet, sheetName: cb.dataset.name, headerRow });
            });
            const domicile = (document.getElementById('sw-sp-domicile').value || '').trim().toUpperCase();
            const workbook = { name: 'Workbook', domicile, path: result.filePath || url, carriers, headerRow: carriers[0].headerRow };
            const existing = await window.sp.getConfig();
            const workbooks = (existing && existing.workbooks) || [];
            workbooks.push(workbook);
            await window.sp.saveConfig({ ...existing, workbooks });
            _savedSummary.sharepoint = workbook.domicile || (carriers.length + ' sheet(s)');
            _showInline('sw-sp-status', 'Saved.', 'ok');
          });
        } catch (e) {
          _showInline('sw-sp-status', 'Error: ' + e.message, 'err');
        } finally {
          btn.disabled = false; btn.textContent = 'Load sheets';
        }
      });
    },
    onNext: async () => { if (!_savedSummary.sharepoint) _savedSummary.sharepoint = 'skipped'; return { ok: true }; },
  },
  {
    id: 'asana', title: 'Asana', required: false,
    html: `
      <p class="setup__hint">Optional -- lets Fleet Operations create/track Asana tasks.</p>
      <label>Personal Access Token <input id="sw-asana-pat" class="setup__input" type="password" placeholder="0/xxxxxxxx" /></label>
      <label>Workspace GID <input id="sw-asana-ws" class="setup__input" placeholder="1234567890" /></label>
      <label>Project GID <input id="sw-asana-proj" class="setup__input" placeholder="1234567890" /></label>
    `,
    onNext: async () => {
      const pat = document.getElementById('sw-asana-pat').value;
      const workspace = document.getElementById('sw-asana-ws').value.trim();
      const project = document.getElementById('sw-asana-proj').value.trim();
      if (!pat && !workspace && !project) { _savedSummary.asana = 'skipped'; return { ok: true }; }
      await window.asana.saveConfig({ pat, workspace, project });
      document.getElementById('sw-asana-pat').value = '';
      _savedSummary.asana = 'Configured';
      return { ok: true };
    },
  },
  {
    id: 'vendorcreds', title: 'Vendor Portal Credentials', required: false,
    html: `
      <p class="setup__hint">Optional -- needed for automated vendor portal scraping (PACCAR, Volvo, etc). Save any you have handy now; add the rest later in Settings &rarr; Integrations.</p>
      <div id="sw-vendor-list"></div>
    `,
    afterMount: () => {
      const VENDORS = [
        ['paccar', 'PACCAR (paccarpg.decisiv.net)', 'Username'],
        ['volvo', 'Volvo (volvopg.asist.decisiv.net)', 'Username'],
        ['record360', 'Record360 (dashboard.record360.com)', 'Email'],
        ['aperia', 'Aperia / Halo Tire (amazon.aperiatech.com)', 'Email'],
        ['reach24', 'Reach24 (amazon.reach24.net)', 'Email'],
        ['dtna', 'DTNA Service Tracker (dtna.my.site.com)', 'Username'],
        ['roadready', 'Road Ready (roadready.fadv.com)', 'Username'],
        ['velogic', 'Velogic (velogic.my.site.com)', 'Username'],
        ['abs', 'Access Billing Services (access-billing-services.com)', 'Username'],
      ];
      const list = document.getElementById('sw-vendor-list');
      list.innerHTML = VENDORS.map(([id, label, userLabel]) => `
        <div class="setup__vendor-block">
          <div class="setup__vendor-label">${_esc(label)}</div>
          <div class="setup__row">
            <input class="setup__input" id="sw-v-${id}-user" placeholder="${_esc(userLabel)}" />
            <input class="setup__input" id="sw-v-${id}-pass" type="password" placeholder="Password" />
            <button class="setup__btn setup__btn--sm" id="sw-v-${id}-save" type="button">Save</button>
          </div>
          <div class="setup__inline-status" id="sw-v-${id}-status" style="display:none"></div>
        </div>
      `).join('');
      let savedCount = 0;
      VENDORS.forEach(([id]) => {
        document.getElementById(`sw-v-${id}-save`).addEventListener('click', async () => {
          const user = document.getElementById(`sw-v-${id}-user`).value.trim();
          const pass = document.getElementById(`sw-v-${id}-pass`).value;
          if (!user || !pass) { _showInline(`sw-v-${id}-status`, 'Enter both fields.', 'warn'); return; }
          await window.credentials.set(`vendor.${id}.username`, user);
          await window.credentials.set(`vendor.${id}.password`, pass);
          await window.settings.save(`${id}_user`, user);
          document.getElementById(`sw-v-${id}-pass`).value = '';
          _showInline(`sw-v-${id}-status`, 'Saved.', 'ok');
          savedCount++;
          _savedSummary.vendorcreds = savedCount + ' vendor(s) configured';
        });
      });
    },
    onNext: async () => { if (!_savedSummary.vendorcreds) _savedSummary.vendorcreds = 'skipped'; return { ok: true }; },
  },
  {
    id: 'schedulers', title: 'Sync Interval', required: false,
    html: `
      <p class="setup__hint">How often Fleet Operations checks AAP/Relay/Uptake for updates. Default is 5 minutes.</p>
      <label>Sync interval (minutes) <input id="sw-sync-interval" class="setup__input" type="number" min="1" max="360" placeholder="5" /></label>
    `,
    afterMount: () => {
      window.settings.getSyncInterval().then((res) => {
        const el = document.getElementById('sw-sync-interval');
        if (res && res.minutes) el.value = res.minutes;
      }).catch(() => {});
    },
    onNext: async () => {
      const raw = document.getElementById('sw-sync-interval').value.trim();
      if (!raw) { _savedSummary.schedulers = 'default (5 min)'; return { ok: true }; }
      const minutes = parseInt(raw, 10);
      if (isNaN(minutes) || minutes < 1) return { ok: false, error: 'Enter a valid number of minutes.' };
      try {
        const result = await window.settings.saveSyncInterval(minutes);
        _savedSummary.schedulers = 'every ' + ((result && result.minutes) || minutes) + ' min';
        return { ok: true };
      } catch (e) { return { ok: false, error: e.message || 'Save failed.' }; }
    },
  },

  // ═══════════════════════════════════════════════════════════ CONFIRM
  {
    id: 'confirm', title: 'Review & Complete', required: false,
    html: `<div id="sw-confirm-summary" class="setup__summary">Loading summary...</div>`,
    afterMount: () => {
      const LABELS = {
        profile: 'Profile', domiciles: 'Domiciles', midway: 'Midway',
        notifications: 'Notifications', orcha: 'Orcha AI', email: 'Email (SMTP)',
        graph: 'Outlook (Graph)', slack: 'Slack', sharepoint: 'SharePoint',
        asana: 'Asana', vendorcreds: 'Vendor Credentials', schedulers: 'Sync Interval',
      };
      const el = document.getElementById('sw-confirm-summary');
      el.innerHTML = Object.entries(LABELS).map(([key, label]) => {
        const val = _savedSummary[key];
        const display = val ? _esc(val) : '<em class="setup__mut">not configured</em>';
        return `<div class="setup__review-row"><span class="setup__review-key">${label}</span><span class="setup__review-val">${display}</span></div>`;
      }).join('');
    },
    collect: () => ({}),
  },
];

// ── Wizard shell ─────────────────────────────────────────────────────────
let _currentStep = 0;

const mountEl = document.getElementById('setup-mount');
const titleEl = document.querySelector('.setup-header .setup-version');

function render() {
  const step = STEPS[_currentStep];
  if (!mountEl || !step) return;

  if (titleEl) titleEl.textContent = 'Step ' + (_currentStep + 1) + ' of ' + STEPS.length + ': ' + step.title;

  const isLast = _currentStep === STEPS.length - 1;
  mountEl.innerHTML = `
    <div class="setup-step">
      <div class="setup-step__body">${step.html}</div>
      <div class="setup-step__error" id="sw-step-error" style="display:none"></div>
      <div class="setup-step__footer">
        ${_currentStep > 0 ? '<button id="sw-back" class="setup__btn setup__btn--secondary" type="button">Back</button>' : ''}
        <button id="sw-next" class="setup__btn" type="button">
          ${isLast ? 'Complete Setup' : (step.required ? 'Next' : 'Next (optional -- skip anytime)')}
        </button>
      </div>
    </div>
  `;

  if (step.afterMount) step.afterMount();

  if (_currentStep > 0) {
    document.getElementById('sw-back').addEventListener('click', () => {
      _currentStep--;
      render();
    });
  }

  document.getElementById('sw-next').addEventListener('click', async () => {
    const btn = document.getElementById('sw-next');
    const errEl = document.getElementById('sw-step-error');
    errEl.style.display = 'none';

    if (step.validate) {
      const v = await step.validate();
      if (!v || !v.ok) {
        errEl.textContent = (v && v.error) || 'Please fix the highlighted issue.';
        errEl.style.display = '';
        return;
      }
    }

    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = isLast ? 'Finishing...' : 'Saving...';

    try {
      if (step.onNext) {
        const r = await step.onNext();
        if (!r || !r.ok) {
          errEl.textContent = (r && r.error) || 'Save failed.';
          errEl.style.display = '';
          btn.disabled = false; btn.textContent = originalText;
          return;
        }
      }
      // Records step completion for setup/state.js's isSetupComplete()
      // check -- unrelated to (and no longer dependent on) the dead
      // 'wizard:complete' path described above.
      try { await window.setup.saveStep(step.id, {}); } catch (e) { console.error('saveStep failed:', step.id, e); }

      if (!isLast) {
        _currentStep++;
        render();
      } else {
        const result = await window.setup.complete();
        if (!result || !result.ok) {
          errEl.textContent = 'Setup incomplete -- a required step is missing. Please go back and check profile/domiciles/midway.';
          errEl.style.display = '';
          btn.disabled = false; btn.textContent = originalText;
        }
        // On success, main process closes this window and opens the main window.
      }
    } catch (e) {
      errEl.textContent = 'Error: ' + e.message;
      errEl.style.display = '';
      btn.disabled = false; btn.textContent = originalText;
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', render);
} else {
  render();
}
