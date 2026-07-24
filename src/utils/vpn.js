'use strict';
/**
 * src/utils/vpn.js
 *
 * Thin wrapper around Cisco Secure Client's `vpncli.exe state` command.
 * Used by the startup VPN gate (app.js) to block launch until Amazon VPN
 * is connected — prevents scrapes and auth flows from hitting internal
 * corp URLs (aap-na.corp.amazon.com, ballard.amazon.com, etc.) while
 * the machine is off-network.
 */

const { execFile } = require('child_process');

const VPNCLI_PATH = 'C:\\Program Files (x86)\\Cisco\\Cisco Secure Client\\vpncli.exe';

/**
 * Queries Cisco Secure Client for the current tunnel state.
 *
 * Returns: { connected: bool, status: string, raw: string }
 *   connected — true if vpncli reports "state: Connected"
 *   status    — one of 'connected' | 'disconnected' | 'unknown' | 'error'
 *   raw       — trimmed stdout (or error message on exec failure)
 */
function checkVpnState() {
  return new Promise((resolve) => {
    execFile(VPNCLI_PATH, ['state'], { timeout: 6000, windowsHide: true }, (err, stdout) => {
      if (err) {
        // vpncli itself failed (not found, daemon not running, etc.)
        resolve({ connected: false, status: 'error', raw: err.message });
        return;
      }
      const text = (stdout || '').trim();
      // vpncli state output contains one or more ">> state: <X>" lines.
      // We treat the LAST one as authoritative (it reflects the final state).
      const matches = text.match(/state:\s*(\S+)/gi) || [];
      const last = matches.length ? matches[matches.length - 1] : '';
      const connected = /connected/i.test(last) && !/disconnected/i.test(last);
      const status = connected ? 'connected'
                   : /disconnected/i.test(last) ? 'disconnected'
                   : 'unknown';
      resolve({ connected, status, raw: text });
    });
  });
}

module.exports = { checkVpnState, VPNCLI_PATH };
