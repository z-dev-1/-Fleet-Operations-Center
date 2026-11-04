'use strict';
/**
 * scrapers/email_sender_smtp.js — cross-platform SMTP sender (Stage 6).
 *
 * WHY THIS EXISTS: the existing email_sender.js sends via Windows PowerShell +
 * .NET SmtpClient, so it cannot run on the headless Linux standby (Dev Space).
 * This adapter does the SAME SMTP send to ballard.amazon.com:1587 (STARTTLS)
 * using nodemailer (pure Node, cross-platform) and exposes the SAME
 * sendFleetEmail(opts, log) contract, so the scheduler/pipeline/IPC callers
 * can use it unchanged on either host.
 *
 * SAFETY — FAIL CLOSED BY DEFAULT. This path is DISABLED unless two things hold:
 *   1. the cluster side-effect gate permits 'email-send' (leader + mode), AND
 *   2. the SMTP capability is explicitly enabled (config.smtpEnabled === true
 *      OR env FLEET_SMTP=1), because SMTP-from-standby is UNPROVEN on the
 *      Dev Space:
 *        - port 1587 reachability was not confirmed there, AND
 *        - src/graph/client.js documents that ballard SMTP "requires VPN, and
 *          the user is almost never on VPN" — so it may not route at all.
 *   Until someone verifies the relay is reachable + authenticating from the
 *   host and flips smtpEnabled, this returns { ok:false, blocked:'smtp-disabled' }
 *   and NEVER attempts a send. Flipping the flag needs no code change.
 *
 * Credentials come from the per-host email config (never copied between
 * machines — spec §8); each host configures its own.
 *
 * Result contract (matches email_sender.sendFleetEmail):
 *   { ok:boolean, messageId?:string, error?:string, blocked?:string }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { P } = require('../config/paths');
let logger; try { logger = require('../utils/logger').createLogger('email-smtp'); } catch (_) { logger = { info(){}, warn(){}, error(){} }; }
const DEFAULTS = require('../config/defaults');

function _loadCfg() {
  try { if (fs.existsSync(P.emailConfig)) return JSON.parse(fs.readFileSync(P.emailConfig, 'utf8')); } catch (_) {}
  return {};
}

// Is the SMTP side-effect allowed right now? Fail closed unless BOTH the
// cluster gate permits it AND the capability is explicitly enabled.
function _smtpAllowed(cfg) {
  // Capability flag (explicit opt-in — default OFF).
  const enabled = cfg.smtpEnabled === true || process.env.FLEET_SMTP === '1';
  if (!enabled) return { ok: false, reason: 'smtp-disabled' };
  // Cluster side-effect gate (leader + mode + host capability). When the
  // cluster flag is OFF this passes (legacy single-host), preserving current
  // laptop behavior.
  try {
    const cluster = require('../cluster');
    if (cluster && typeof cluster.canSideEffect === 'function') {
      const d = cluster.canSideEffect('email-send');
      if (!d.ok) return { ok: false, reason: 'gate:' + d.reason };
    }
  } catch (_) { /* cluster absent → legacy, allow */ }
  return { ok: true };
}

/**
 * sendFleetEmailSmtp(opts, log) — send ONE email via nodemailer/STARTTLS.
 * Mirrors email_sender.sendFleetEmail's contract. Fails closed per _smtpAllowed.
 */
async function sendFleetEmailSmtp(opts, log) {
  opts = opts || {};
  if (!log) log = (m) => logger.info(m);
  const cfg = _loadCfg();

  const allow = _smtpAllowed(cfg);
  if (!allow.ok) {
    log('[email-smtp] not sending — ' + allow.reason);
    return { ok: false, blocked: allow.reason };
  }

  const host = cfg.smtpHost || DEFAULTS.EMAIL_SMTP_HOST;
  const port = cfg.smtpPort || DEFAULTS.EMAIL_SMTP_PORT;
  const user = cfg.username || cfg.user || '';
  const pass = cfg.password || cfg.pass || '';
  const from = opts.from || cfg.from || user;
  const to = opts.to || cfg.defaultTo || '';
  const cc = opts.cc || cfg.defaultCc || '';
  const subject = opts.subject || ('Fleet Status Report — ' + new Date().toISOString());
  const html = opts.htmlBody || '<p>Fleet Status Report</p>';

  if (!to) return { ok: false, error: 'no recipient' };
  if (!pass) {
    log('[email-smtp] no SMTP password configured for this host');
    return { ok: false, error: 'SMTP password not configured on this host' };
  }

  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (e) { return { ok: false, error: 'nodemailer not installed: ' + e.message }; }

  // Optional PNG attachment (same opts shape as the PowerShell sender).
  const attachments = [];
  let tmpFile = null;
  try {
    if (opts.pngDataUrl && opts.pngDataUrl.startsWith('data:image/png;base64,')) {
      const b64 = opts.pngDataUrl.split(',')[1];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-email-'));
      tmpFile = path.join(dir, opts.pngFilename || 'FleetReport.png');
      fs.writeFileSync(tmpFile, Buffer.from(b64, 'base64'));
      attachments.push({ filename: opts.pngFilename || 'FleetReport.png', path: tmpFile });
    }
  } catch (e) { log('[email-smtp] attachment prep failed: ' + e.message); }

  const transport = nodemailer.createTransport({
    host, port,
    secure: false,          // 1587 uses STARTTLS, not implicit TLS
    requireTLS: true,
    auth: user && pass ? { user, pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    tls: { minVersion: 'TLSv1.2' },
  });

  try {
    log('[email-smtp] sending to ' + String(to) + ' via ' + host + ':' + port);
    const info = await transport.sendMail({
      from, to: String(to).replace(/;/g, ','), cc: cc ? String(cc).replace(/;/g, ',') : undefined,
      subject, html, attachments,
    });
    log('[email-smtp] sent messageId=' + (info && info.messageId));
    return { ok: true, messageId: (info && info.messageId) || ('smtp-' + Date.now()) };
  } catch (e) {
    logger.warn('[email-smtp] send failed: ' + e.message);
    return { ok: false, error: e.message };
  } finally {
    try { transport.close(); } catch (_) {}
    if (tmpFile) { try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch (_) {} }
  }
}

// verifyTransport() — a safe connectivity/auth probe that does NOT send mail.
// Useful for the Instance Management dashboard + the "is SMTP reachable here?"
// check, without the terminal-capture problem of an ad-hoc curl.
async function verifyTransport() {
  const cfg = _loadCfg();
  let nodemailer; try { nodemailer = require('nodemailer'); } catch (e) { return { ok: false, error: 'nodemailer missing' }; }
  const host = cfg.smtpHost || DEFAULTS.EMAIL_SMTP_HOST;
  const port = cfg.smtpPort || DEFAULTS.EMAIL_SMTP_PORT;
  const user = cfg.username || cfg.user || '';
  const pass = cfg.password || cfg.pass || '';
  const transport = nodemailer.createTransport({
    host, port, secure: false, requireTLS: true,
    auth: user && pass ? { user, pass } : undefined,
    connectionTimeout: 8000, greetingTimeout: 6000,
  });
  try { await transport.verify(); return { ok: true, host, port }; }
  catch (e) { return { ok: false, host, port, error: e.message }; }
  finally { try { transport.close(); } catch (_) {} }
}

module.exports = { sendFleetEmailSmtp, verifyTransport, _smtpAllowed };
