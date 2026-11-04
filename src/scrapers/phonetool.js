/**
 * phonetool.js — scrape the user's Amazon Phonetool page in-app.
 *
 * Pulls career facts for the FAS baseball card that the app can't otherwise
 * know: manager, skip-level (manager's manager), Amazon hire date, alias, and
 * prior roles/title history. Runs in the user's AUTHENTICATED Electron session
 * (same off-screen-window + Midway-cookie pattern as fas_roster.js), so it only
 * ever sees what the signed-in user can already see on Phonetool.
 *
 * Phonetool's DOM is not publicly documented and may change, so the in-page
 * script is DEFENSIVE: it tries several strategies (labelled rows, definition
 * lists, reporting-chain links, "Job history" sections) and returns whatever it
 * can find, plus a `debug` trail so the extraction can be refined against the
 * live page without guessing. Nothing is fabricated — missing fields come back
 * blank and the card leaves them for the user.
 */

const { BrowserWindow, session } = require('electron');
const logger = require('../utils/logger')('phonetool');

const BASE = 'https://atoz.amazon.work/phonetool/users/';
const _isSSO = (u) => /midway-auth\.amazon\.com|\/SSO\/redirect|federate\.amazon\.com/i.test(u || '');
// A to Z has its OWN login (atoz-login.amazon.work) separate from Midway.
const _isAtoZLoginHost = (u) => /atoz-login\.amazon\.work/i.test(u || '');

// In-page extractor — tuned to the real A to Z Phone Tool layout:
//   • Header: name, title line ("Fleet Asset Specialist, L4 ..."), "Total tenure:"
//     and "Latest hire date:" labelled rows, alias chip (zilasant@).
//   • "Org chart" section: a top-down management chain; the row ABOVE the user
//     (highlighted/last) is the manager, two above is the skip-level.
//   • "Job history" section: prior titles; the "Promotion" entry's prior title
//     is the previous role.
const IN_PAGE_SCRIPT = `(function () {
  const debug = [];
  const txt = (el) => (el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim();
  const out = { alias: '', manager: '', skipLevel: '', hireDate: '', previousRoles: '', years: '', months: '', title: '' };

  try {
    const bodyText = (document.body && document.body.innerText) || '';
    const lines = bodyText.split(/\\n+/).map(s => s.trim()).filter(Boolean);

    // "Label: value" (or label line followed by value line) lookup.
    function byLabel(labelRe) {
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        const m = ln.match(/^([^:]{2,40}):\\s*(.*)$/);
        if (m && labelRe.test(m[1])) {
          if (m[2] && m[2].trim()) return m[2].trim();
          if (lines[i + 1]) return lines[i + 1].trim(); // value on next line
        }
      }
      return '';
    }

    // Alias — the "@"-looking token / email.
    const mAlias = bodyText.match(/([a-z0-9][a-z0-9._-]{1,30})@amazon\\.com/i);
    if (mAlias) out.alias = mAlias[1];

    // Title line — the line right under the name that contains a level (L4/L5)
    // and/or "Specialist/Manager/Coordinator".
    const titleLine = lines.find(l => /\\bL\\d\\b/.test(l) && /(specialist|manager|coordinator|analyst|lead|engineer|field)/i.test(l));
    if (titleLine) out.title = titleLine;

    // Hire date — "Latest hire date:" then a date like "February 17th, 2020".
    out.hireDate = byLabel(/latest hire date|hire date|start date/i) || out.hireDate;
    // Total tenure — "6 years, 8 months, 4 days" → years.
    const tenure = byLabel(/total tenure|tenure/i);
    if (tenure) {
      const my = tenure.match(/(\\d+)\\s*year/i); if (my) out.years = my[1];
      const mm = tenure.match(/(\\d+)\\s*month/i); if (mm) out.months = mm[1];
    }

    // ── Org chart → manager + skip-level ──
    try {
      // Find the "Org chart" section container.
      const orgHead = [...document.querySelectorAll('*')].find(el => /^org chart$/i.test(txt(el)) && el.children.length < 3);
      let scope = orgHead ? (orgHead.closest('section') || orgHead.parentElement || document.body) : document.body;
      // Each person row shows a Name + alias link. Collect the ordered list of
      // people in the chart (top manager first → the user last).
      const people = [];
      const anchors = [...scope.querySelectorAll('a')].filter(a => /@/.test(txt(a)) === false && txt(a).split(' ').length >= 2 && txt(a).length < 40);
      // Prefer rows: look for blocks that contain a name + "(alias)".
      const rowText = txt(scope).split(/\\u2022|\\n/).map(s => s.trim()).filter(Boolean);
      // Simpler + robust: names appear as "Name (alias)" patterns in the section text.
      const nameMatches = [...txt(scope).matchAll(/([A-Z][a-zA-Z.'-]+(?:\\s+[A-Z][a-zA-Z.'-]+){1,2})\\s*\\(([a-z0-9]+)\\)/g)];
      nameMatches.forEach(m => { if (!people.some(p => p.alias === m[2])) people.push({ name: m[1].trim(), alias: m[2] }); });
      debug.push('orgchart people: ' + people.map(p => p.name + '(' + p.alias + ')').join(' > '));
      // The user is the entry whose alias matches ours (out.alias); manager is
      // the entry immediately before, skip-level two before.
      let selfIdx = out.alias ? people.findIndex(p => p.alias.toLowerCase() === out.alias.toLowerCase()) : -1;
      if (selfIdx < 0 && people.length) selfIdx = people.length - 1; // assume last = user
      if (selfIdx >= 1) out.manager = people[selfIdx - 1].name;
      if (selfIdx >= 2) out.skipLevel = people[selfIdx - 2].name;
    } catch (e) { debug.push('orgchart err: ' + e.message); }

    // ── Job history → previous role ──
    try {
      const histHead = [...document.querySelectorAll('*')].find(el => /^job history$/i.test(txt(el)) && el.children.length < 3);
      let scope = histHead ? (histHead.closest('section') || histHead.parentElement) : null;
      if (scope) {
        const t = txt(scope);
        // A promotion entry names the PRIOR title, e.g. "Job Title: Logistics
        // Coordinator IV". Grab any "Coordinator/Analyst/Specialist" title that
        // is NOT the current one.
        const roleMatches = [...t.matchAll(/((?:Logistics\\s+)?(?:Coordinator|Analyst|Specialist|Manager|Associate)[^,.;]{0,30})/gi)]
          .map(m => m[1].trim());
        const uniq = [...new Set(roleMatches)].filter(r => r && (!out.title || !out.title.includes(r))).slice(0, 4);
        if (uniq.length) out.previousRoles = uniq.join('; ');
        debug.push('jobhistory roles: ' + uniq.join(' | '));
      } else { debug.push('no job-history section'); }
    } catch (e) { debug.push('history err: ' + e.message); }

    // Normalize hire date to MM/YYYY and derive years if tenure was absent.
    try {
      if (out.hireDate) {
        const d = new Date(out.hireDate.replace(/(\\d+)(st|nd|rd|th)/i, '$1'));
        if (!isNaN(d)) {
          if (!out.years) {
            const now = new Date();
            let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
            out.years = String(Math.max(0, Math.floor(months / 12)));
          }
          out.hireDate = String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
        }
      }
    } catch (e) { debug.push('date err: ' + e.message); }

    debug.push('found: ' + Object.keys(out).filter(k => out[k]).map(k => k + '=' + out[k]).join(' | '));
    // DIAGNOSTIC: capture the real page shape so selectors can be written against
    // reality instead of guesses (logged, never shown to the user).
    try {
      debug.push('URL=' + location.href);
      debug.push('TITLE=' + (document.title || '').slice(0, 80));
      debug.push('bodyLen=' + bodyText.length);
      debug.push('bodySample=' + bodyText.replace(/\\s+/g, ' ').slice(0, 600));
      debug.push('dt#=' + document.querySelectorAll('dt').length + ' th#=' + document.querySelectorAll('th').length + ' a#=' + document.querySelectorAll('a').length + ' table#=' + document.querySelectorAll('table').length);
    } catch (e) { debug.push('diag err: ' + e.message); }
    return { ok: true, data: out, debug };
  } catch (e) {
    return { ok: false, error: 'script', detail: e.message, debug };
  }
})();`;

async function fetchPhonetool(user, opts = {}) {
  const timeoutMs = opts.timeoutMs || 45000;
  const url = BASE + encodeURIComponent(String(user || 'zilasant').trim());

  try {
    const { injectCookies } = require('./auth');
    await injectCookies(session.defaultSession);
  } catch (e) {
    logger.warn('cookie inject skipped: ' + e.message);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
      resolve(res);
    };

    const win = new BrowserWindow({
      width: 1400, height: 1000,
      show: false, x: -3000, y: -3000, skipTaskbar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession },
    });

    const timeout = setTimeout(() => {
      logger.warn('phonetool fetch timed out after ' + timeoutMs + 'ms');
      finish({ ok: false, error: 'timeout', detail: 'Phonetool did not respond in time.' });
    }, timeoutMs);

    const run = async () => {
      let cur = '';
      try { cur = win.webContents.getURL(); } catch (_) {}
      if (_isAtoZLoginHost(cur)) {
        clearTimeout(timeout);
        logger.warn('bounced to A to Z login — needs A to Z sign-in');
        finish({ ok: false, error: 'atoz-login', detail: 'Not signed in to Amazon A to Z. Click "Sign in to A to Z" first, then Fetch Phonetool.' });
        return;
      }
      if (_isSSO(cur)) {
        clearTimeout(timeout);
        logger.warn('landed on Midway SSO — session invalid');
        finish({ ok: false, error: 'auth', detail: 'Midway session expired. Open the main window to re-authenticate, then try again.' });
        return;
      }
      try {
        // Give the SPA time to render; poll until the body has real content (or
        // up to ~12s) because Phonetool hydrates its data after initial paint.
        let result = null;
        for (let attempt = 0; attempt < 6; attempt++) {
          await new Promise(r => setTimeout(r, 2000));
          result = await win.webContents.executeJavaScript(IN_PAGE_SCRIPT, true);
          const dbg = (result && result.debug) || [];
          const bodyLen = parseInt((dbg.find(d => /^bodyLen=/.test(d)) || 'bodyLen=0').split('=')[1], 10) || 0;
          const foundAny = result && result.data && Object.keys(result.data).some(k => result.data[k]);
          // Re-check auth each loop in case it bounced late.
          let u = ''; try { u = win.webContents.getURL(); } catch (_) {}
          if (_isAtoZLoginHost(u)) { clearTimeout(timeout); finish({ ok: false, error: 'atoz-login', detail: 'Not signed in to Amazon A to Z. Click "Sign in to A to Z" first.' }); return; }
          if (_isSSO(u)) { clearTimeout(timeout); finish({ ok: false, error: 'auth', detail: 'Midway session expired — re-authenticate and retry.' }); return; }
          if (foundAny || bodyLen > 400) break; // page has rendered
        }
        clearTimeout(timeout);
        if (result && Array.isArray(result.debug)) logger.info('[phonetool debug] ' + result.debug.join(' | '));
        if (result && result.ok) {
          logger.info('phonetool fetched for ' + user + ': ' + Object.keys(result.data || {}).filter(k => result.data[k]).join(', '));
          finish({ ok: true, data: result.data });
        } else {
          finish({ ok: false, error: (result && result.error) || 'failed', detail: (result && result.detail) || 'unknown' });
        }
      } catch (e) {
        clearTimeout(timeout);
        logger.error('executeJavaScript threw: ' + e.message);
        finish({ ok: false, error: 'script', detail: e.message });
      }
    };

    win.webContents.once('did-finish-load', run);
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      if (code === -3) return;
      logger.warn('did-fail-load: ' + code + ' ' + desc);
    });

    win.loadURL(url);
  });
}

// ── A to Z sign-in ────────────────────────────────────────────────────────────
// Phonetool lives on atoz.amazon.work, which uses a SEPARATE login from Midway
// (the app's AAP session does NOT carry it). This opens a VISIBLE window on the
// A to Z login using the shared session.defaultSession so the resulting cookies
// persist and the headless Phonetool fetch can reuse them. Resolves once the
// user has signed in (URL leaves the login host and reaches atoz.amazon.work),
// or when the window is closed / it times out.
const _ATOZ_LOGIN = 'https://atoz.amazon.work/phonetool';
const _isAtoZLogin = (u) => /atoz-login\.amazon\.work/i.test(u || '');
const _isAtoZApp   = (u) => /:\/\/atoz\.amazon\.work\//i.test(u || '');

function signInAtoZ(opts = {}) {
  const timeoutMs = opts.timeoutMs || 180000; // user may take a couple minutes
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => {
      if (settled) return; settled = true;
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
      resolve(res);
    };

    const win = new BrowserWindow({
      width: 1100, height: 820, show: true, title: 'Sign in to Amazon A to Z',
      webPreferences: { nodeIntegration: false, contextIsolation: true, session: session.defaultSession },
    });

    const timeout = setTimeout(() => {
      logger.warn('A to Z sign-in timed out');
      finish({ ok: false, error: 'timeout', detail: 'Sign-in window timed out. Try again.' });
    }, timeoutMs);

    // Detect successful login: navigated to the A to Z app (not the login host).
    const check = () => {
      let u = ''; try { u = win.webContents.getURL(); } catch (_) {}
      if (_isAtoZApp(u) && !_isAtoZLogin(u)) {
        clearTimeout(timeout);
        logger.info('A to Z sign-in detected (' + u.split('?')[0] + ')');
        // Give the session a beat to persist cookies before closing.
        setTimeout(() => finish({ ok: true }), 1500);
      }
    };
    win.webContents.on('did-navigate', check);
    win.webContents.on('did-navigate-in-page', check);
    win.webContents.on('did-finish-load', check);
    win.on('closed', () => { clearTimeout(timeout); if (!settled) { settled = true; resolve({ ok: false, error: 'closed', detail: 'Sign-in window was closed.' }); } });

    win.loadURL(_ATOZ_LOGIN);
  });
}

// Quick check: does the session currently have a usable A to Z login? We can't
// read HttpOnly cookies reliably, so we treat "a prior successful sign-in this
// run" as the signal; the real test is the fetch itself (it reports auth if it
// bounces to login).
module.exports = { fetchPhonetool, signInAtoZ };
