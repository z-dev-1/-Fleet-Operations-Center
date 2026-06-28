'use strict';
/**
 * Fleet Status Email Sender — ballard.amazon.com
 * 
 * SMTP: Port 1587, STARTTLS, Kerberos/GSSAPI (tries UseDefaultCredentials first)
 * Fallback: username/password if Kerberos fails
 * 
 * IMAP (for future inbox reading): Port 1993, SSL, username/password
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { P } = require('../config/paths');
const logger = require('../utils/logger').createLogger('email_sender');

const CONFIG_FILE = P.emailConfig;
function loadEmailConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch(e) { logger.warn('[Email] Config load error:', e.message); }
  return {
    username: 'ANT\\zsantia',
    password: '',
    from: 'zsantia@amazon.com',
    defaultTo: 'kiernl@amazon.com;samnimm@amazon.com',
    defaultCc: 'thoschr@amazon.com'
  };
}


function saveEmailConfig(config) {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch(e) { logger.warn('[Email] Config save error:', e.message); }
}

/**
 * Send email via PowerShell + .NET SmtpClient
 * Strategy: Try Kerberos (UseDefaultCredentials) first
 *           If that fails, retry with explicit username/password
 */
async function sendFleetEmail(opts, log) {
  if (!log) log = logger.info.bind(logger);

  const config = loadEmailConfig();
  const to = (opts.to || config.defaultTo || '').replace(/;/g, "','");
  const cc = (opts.cc || config.defaultCc || '').replace(/;/g, "','");
  const from = opts.from || config.from || 'zilasant@amazon.com';
  const subject = opts.subject || 'Fleet Status Report \u2014 ' + new Date().toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  // Save PNG attachment to temp file if provided
  let attachmentPath = '';
  if (opts.pngDataUrl && opts.pngDataUrl.startsWith('data:image/png;base64,')) {
    const b64 = opts.pngDataUrl.split(',')[1];
    const tmpDir = path.join(os.tmpdir(), 'fleet-email');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    attachmentPath = path.join(tmpDir, opts.pngFilename || 'FleetReport.png');
    fs.writeFileSync(attachmentPath, Buffer.from(b64, 'base64'));
    log('[Email] PNG saved: ' + attachmentPath + ' (' + Math.round(fs.statSync(attachmentPath).size / 1024) + ' KB)');
  }

  const htmlBody = opts.htmlBody || '<h2>Fleet Status Report</h2><p>Please find the latest fleet status report attached.</p><hr><p style="font-size:11px;color:#666;">Sent from Fleet Status App</p>';

  // Escape for PowerShell here-string
  const safeHtml = htmlBody.replace(/'/g, "''");
  const attPath = attachmentPath.replace(/\\/g, '\\\\').replace(/'/g, "''");

  // Build PowerShell — tries Kerberos first, then username/password
  const username = config.username || 'zilasant';
  const password = config.password || '';

  // PowerShell: use .NET SmtpClient with STARTTLS + credentials
  const ps1 = `
$ErrorActionPreference = 'Stop'
try {
  $smtp = New-Object System.Net.Mail.SmtpClient('ballard.amazon.com', 1587)
  $smtp.EnableSsl = $true
  $smtp.Credentials = New-Object System.Net.NetworkCredential('${username.replace(/'/g, "''")}', '${password.replace(/'/g, "''")}')

  $msg = New-Object System.Net.Mail.MailMessage
  $msg.From = '${from.replace(/'/g, "''")}'
  $msg.Subject = '${subject.replace(/'/g, "''")}'
  $msg.IsBodyHtml = $true
  $msg.Body = '${safeHtml}'

  '${to}'.Split(',') | ForEach-Object { $msg.To.Add($_.Trim().Trim("'")) }
  ${cc ? "'" + cc + "'.Split(',') | ForEach-Object { $msg.CC.Add($_.Trim().Trim(\"'\")) }" : ''}
  ${attachmentPath ? "$att = New-Object System.Net.Mail.Attachment('" + attPath + "'); $msg.Attachments.Add($att)" : ''}

  $smtp.Send($msg)
  ${attachmentPath ? '$att.Dispose()' : ''}
  $msg.Dispose()
  $smtp.Dispose()
  Write-Output 'SUCCESS'
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
`;

  if (!password) {
    log('[Email] No password configured \u2014 go to Settings \u2192 Accounts \u2192 Email \u2192 Configure');
    return { ok: false, error: 'Email password not configured. Go to Settings \u2192 Accounts \u2192 Email \u2192 Configure.' };
  }

  log('[Email] Sending to: ' + to.replace(/'/g, ''));



  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps1], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        const errMsg = (stderr || err.message || '').trim().split('\n')[0];
        log('[Email] FAILED: ' + errMsg);
        resolve({ ok: false, error: errMsg });
      } else {
        const out = (stdout || '').trim();
        if (out.includes('SUCCESS')) {
          const method = out.includes('KERBEROS') ? 'Kerberos' : 'Password';
          log('[Email] SUCCESS via ' + method);
          resolve({ ok: true, messageId: method.toLowerCase() + '-' + Date.now() });
        } else {
          log('[Email] Unknown result: ' + out);
          resolve({ ok: false, error: out || 'Unknown result' });
        }
      }
      // Cleanup temp file
      if (attachmentPath && fs.existsSync(attachmentPath)) {
        try { fs.unlinkSync(attachmentPath); } catch(e) {}
      }
    });
  });
}

module.exports = { sendFleetEmail, loadEmailConfig, saveEmailConfig, CONFIG_FILE };
