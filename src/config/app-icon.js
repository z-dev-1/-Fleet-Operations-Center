'use strict';
/**
 * config/app-icon.js -- Shared app icon resolver.
 *
 * BUG (2026-07-22): every BrowserWindow in this app -- main window, setup
 * wizard, AAP column setup, Uptake/Relay/AAP popups, Slack/Outlook
 * sign-in windows, the SxS Relay/Offsite comparison windows, the vendor
 * "Test login" windows, and the beta-gate deny window -- was created
 * with no `icon` property at all, so every single one showed the
 * generic default Electron icon in the Windows taskbar/titlebar/alt-tab
 * switcher, even though a real app icon (assets/icon.ico, already
 * correctly wired into electron-builder's packaged .exe AND into the
 * system tray via createTray() in src/window/index.js) has existed in
 * this repo since 2026-07-06. This resolver is the single source of
 * truth so every window can point at the same real icon with one line.
 *
 * .ico preferred over .png on Windows -- an .ico file bundles multiple
 * resolutions (16/32/48/256px) so Windows can pick the sharpest one for
 * each context (small titlebar vs. large alt-tab preview) rather than
 * scaling a single fixed-size .png.
 *
 * Deliberately NOT applied to windows that are already invisible by
 * design (skipTaskbar:true, or show:false + positioned off-screen) --
 * those are internal scraper/automation windows the user never sees, so
 * there is nothing for an icon to visibly fix there.
 */

const path = require('path');
const fs   = require('fs');

const ROOT_DIR = path.join(__dirname, '..', '..');
const ICON_ICO = path.join(ROOT_DIR, 'assets', 'icon.ico');
const ICON_PNG = path.join(ROOT_DIR, 'assets', 'icon.png');

let _resolved; // cached after first call -- file presence won't change mid-session

function getAppIconPath() {
  if (_resolved !== undefined) return _resolved;
  if (fs.existsSync(ICON_ICO)) { _resolved = ICON_ICO; }
  else if (fs.existsSync(ICON_PNG)) { _resolved = ICON_PNG; }
  else { _resolved = undefined; } // BrowserWindow simply omits icon customization -- falls back to default, never throws
  return _resolved;
}

module.exports = { getAppIconPath, ICON_ICO, ICON_PNG };
