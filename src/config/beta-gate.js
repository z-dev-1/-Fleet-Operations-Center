'use strict';
/**
 * config/beta-gate.js -- Restricts the current beta build to an explicit
 * allowlist of corp usernames.
 *
 * WHY os.userInfo().username, NOT parsing the Midway cookie file:
 * on Amazon's domain-joined corp Windows machines, the OS login name IS
 * the corp alias. Confirmed live on this machine:
 *   whoami                        -> ant\zilasant
 *   os.userInfo().username        -> 'zilasant'
 * mwinit itself authenticates Midway for whichever user is already
 * logged into Windows -- there is no separate "Midway identity" apart
 * from that OS session. So os.userInfo().username IS what "matches
 * mwinit" resolves to; reading the Midway cookie file directly to try to
 * extract a username would mean parsing an undocumented, fragile
 * internal cookie format for zero benefit over this.
 *
 * This app is distributed as a per-user copy on each teammate's own
 * laptop (not a shared multi-user install), so this check runs against
 * whichever Windows account is currently running the app -- exactly the
 * identity mwinit itself would authenticate.
 *
 * Two tiers:
 *   BETA_ADMIN_USERS   -- app owner/maintainer(s). ALWAYS allowed,
 *                          regardless of BETA_GATE_ENABLED, so the admin
 *                          never gets locked out of their own build while
 *                          testing/maintaining it -- e.g. zilasant (2026-07-22).
 *   BETA_ALLOWED_USERS -- the actual beta testers currently being given
 *                          access, separate from the admin list so
 *                          rotating testers in/out never risks touching
 *                          admin access by mistake.
 *
 * TO ADD/REMOVE BETA USERS: edit BETA_ALLOWED_USERS below. Lowercase, no
 * domain prefix (e.g. 'mckristh', not 'ANT\\mckristh').
 *
 * TO LIFT THE GATE ENTIRELY (e.g. once this graduates from beta to GA):
 * set BETA_GATE_ENABLED to false, or delete the isBetaUser() check at the
 * top of app.whenReady() in src/app.js.
 */

const os = require('os');

const BETA_GATE_ENABLED = true;

const BETA_ADMIN_USERS = [
  'zilasant',
];

const BETA_ALLOWED_USERS = [
  'mckristh',
];

function getCurrentUsername() {
  try {
    return String(os.userInfo().username || '').toLowerCase().trim();
  } catch (_) {
    return '';
  }
}

function isAdminUser() {
  const current = getCurrentUsername();
  if (!current) return false;
  return BETA_ADMIN_USERS.some((u) => u.toLowerCase() === current);
}

function isBetaUser() {
  if (isAdminUser()) return true; // admin always has access, gate on/off notwithstanding
  if (!BETA_GATE_ENABLED) return true;
  const current = getCurrentUsername();
  if (!current) return false;
  return BETA_ALLOWED_USERS.some((u) => u.toLowerCase() === current);
}

module.exports = {
  isBetaUser,
  isAdminUser,
  getCurrentUsername,
  BETA_ADMIN_USERS,
  BETA_ALLOWED_USERS,
  BETA_GATE_ENABLED,
};
