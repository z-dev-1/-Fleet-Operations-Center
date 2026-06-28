/**
 * slack-bridge.js — Module 9: Slack Bridge
 * Fleet Ops V-C, Stage 2
 *
 * Wires Slack messaging into the UI:
 *   - Patches window.sendFleetAlert(opts) — primary send entry point
 *   - Patches window.draftSlack() — overrides the inline version, opens a
 *     real send modal pre-filled from the current unit context
 *   - Opens a compose modal with 4 message templates + free-text editor
 *   - Integrates with auth-bridge: disables send if Slack not authenticated,
 *     shows "Connect Slack" flow via window.slack.login()
 *   - Injects "Draft Slack" item wiring into drawer actions + context menu
 *     (these buttons already exist in HTML — we just wire them properly)
 *   - Push event: window.slack.onSlackProgress (not currently in preload —
 *     falls back gracefully)
 *
 * Message templates:
 *   1. Vendor follow-up    — parts / ETA not received
 *   2. SLA escalation      — breach imminent
 *   3. Return to service   — unit back in fleet
 *   4. Status update       — general fleet status
 *   5. Custom              — free text (auto-populated from unit)
 *
 * Capability flags (captured once at load time):
 *   HAS_SLACK_SEND  — window.slack.send available
 *   HAS_SLACK_AUTH  — window.slack.checkAuth available
 *   HAS_SLACK_LOGIN — window.slack.login available
 *
 * Dev fallback: simulates send with 800ms delay.
 * window._slackBridge debug handle exposed.
 */

(function () {
  'use strict';

  /* ── 1. Capability detection ────────────────────────────────────────── */
  const HAS_SLACK_SEND  = !!(window.slack && typeof window.slack.send      === 'function');
  const HAS_SLACK_AUTH  = !!(window.slack && typeof window.slack.checkAuth === 'function');
  const HAS_SLACK_LOGIN = !!(window.slack && typeof window.slack.login     === 'function');

  const HAS_ANY_SLACK = HAS_SLACK_SEND || HAS_SLACK_AUTH;

  /* ── 2. State ───────────────────────────────────────────────────────── */
  const _state = {
    sending:   false,
    lastSent:  null,
    authKnown: false, // populated from auth-bridge _state or fresh check
  };

  /* ── 3. Message templates ────────────────────────────────────────────── */

  function _buildTemplates(u) {
    const id      = (u && u.id)       || '—';
    const vendor  = (u && u.vendor)   || '—';
    const relay   = (u && u.relay)    || '—';
    const sla     = (u && u.sla)      || '—';
    const site    = (u && u.site)     || '—';
    const next    = (u && u.next)     || '';

    return [
      {
        label: '📦 Vendor follow-up',
        text:  '[Fleet] ' + id + ' @ ' + vendor + ' — parts / ETA update not received. ' +
               'Please confirm status by EOD. Relay: ' + relay + '. SLA: ' + sla + '.',
      },
      {
        label: '🚨 SLA escalation',
        text:  '[Fleet ESCALATION] ' + id + ' SLA at ' + sla + ' — breach imminent. ' +
               'Unit at ' + vendor + ' (' + site + '). Immediate update required. ' +
               (next ? 'Action: ' + next : ''),
      },
      {
        label: '✅ Return to service',
        text:  '[Fleet] ' + id + ' has returned to service at ' + site + '. ' +
               'Relay status: ' + relay + '. No open blockers.',
      },
      {
        label: '📋 Status update',
        text:  '[Fleet Update] ' + id + ' — Relay: ' + relay + ' | Vendor: ' + vendor +
               ' | SLA: ' + sla + (next ? ' | NEXT: ' + next : '') + '.',
      },
      {
        label: '✏️ Custom message',
        text:  '',
      },
    ];
  }

  /* ── 4. Modal HTML ───────────────────────────────────────────────────── */

  function _ensureModal() {
    if (document.getElementById('slack-compose-modal')) return;

    const overlay = document.createElement('div');
    overlay.id = 'slack-compose-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:500',
      'background:rgba(13,17,23,.75)', 'backdrop-filter:blur(4px)',
      'display:none', 'align-items:center', 'justify-content:center',
    ].join(';');
    overlay.onclick = function (e) {
      if (e.target === overlay) _closeSlackModal();
    };

    const card = document.createElement('div');
    card.id = 'slack-compose-modal';
    card.style.cssText = [
      'background:var(--panel)', 'border:1px solid var(--bdr)',
      'border-radius:12px', 'width:480px', 'max-width:95vw',
      'box-shadow:0 20px 60px rgba(0,0,0,.6)',
    ].join(';');

    card.innerHTML =
      '<div style="padding:16px 18px 12px;border-bottom:1px solid var(--bdr);display:flex;align-items:center;justify-content:space-between">' +
        '<div>' +
          '<div style="font-family:var(--mono);font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--mut)">Slack Message</div>' +
          '<div id="slack-modal-unit" style="font-size:13px;font-weight:700;color:var(--txt);margin-top:2px">—</div>' +
        '</div>' +
        '<button onclick="window._slackBridge._closeModal()" style="background:none;border:none;color:var(--txt2);cursor:pointer;font-size:16px;padding:2px 6px;border-radius:4px">&#10005;</button>' +
      '</div>' +

      '<div style="padding:14px 18px">' +
        '<div style="font-size:10px;color:var(--txt2);margin-bottom:8px;font-weight:600">Template</div>' +
        '<div id="slack-tmpl-list" style="display:flex;flex-direction:column;gap:4px;margin-bottom:12px"></div>' +

        '<div style="font-size:10px;color:var(--txt2);margin-bottom:6px;font-weight:600">Message</div>' +
        '<textarea id="slack-compose-ta" style="' + [
          'width:100%', 'min-height:100px', 'background:var(--el)',
          'color:var(--txt)', 'border:1px solid var(--bdr)', 'border-radius:7px',
          'padding:9px 11px', 'font-size:11px', 'font-family:inherit',
          'resize:vertical', 'box-sizing:border-box', 'outline:none',
          'line-height:1.6',
        ].join(';') + '"></textarea>' +

        '<div id="slack-auth-warn" style="display:none;margin-top:8px;padding:8px 12px;background:rgba(248,81,73,.1);border:1px solid rgba(248,81,73,.25);border-radius:7px;font-size:11px;color:var(--red)">' +
          '⚠ Slack not connected. <button id="slack-connect-btn" style="background:none;border:none;color:var(--acc);cursor:pointer;font-size:11px;text-decoration:underline;padding:0">Connect now</button>' +
        '</div>' +
      '</div>' +

      '<div style="padding:10px 18px 14px;border-top:1px solid var(--bdr);display:flex;gap:8px;justify-content:flex-end">' +
        '<button onclick="window._slackBridge._closeModal()" style="padding:7px 16px;background:var(--el);border:1px solid var(--bdr);border-radius:7px;color:var(--txt2);font-size:11px;cursor:pointer">Cancel</button>' +
        '<button id="slack-send-btn" onclick="window._slackBridge._sendFromModal()" style="padding:7px 18px;background:linear-gradient(135deg,var(--acc),var(--pur));border:none;border-radius:7px;color:#fff;font-size:11px;font-weight:700;cursor:pointer">Send to Slack</button>' +
      '</div>';

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Connect button
    const connectBtn = document.getElementById('slack-connect-btn');
    if (connectBtn) {
      connectBtn.onclick = function () {
        _triggerSlackLogin();
      };
    }
  }

  /* ── 5. Open / close modal ───────────────────────────────────────────── */

  function _openSlackModal(uid) {
    _ensureModal();
    const u = (window.UNITS && uid && window.UNITS[uid]) || null;

    // Unit label
    const unitLabel = document.getElementById('slack-modal-unit');
    if (unitLabel) unitLabel.textContent = uid ? (uid + (u ? ' · ' + (u.vendor || '') : '')) : 'Fleet Alert';

    // Populate templates
    const list = document.getElementById('slack-tmpl-list');
    if (list) {
      list.innerHTML = '';
      const templates = _buildTemplates(u);
      templates.forEach(function (tmpl, i) {
        const btn = document.createElement('button');
        btn.style.cssText = [
          'text-align:left', 'padding:6px 10px', 'border-radius:6px',
          'font-size:11px', 'cursor:pointer', 'border:1px solid var(--bdr)',
          'background:var(--el)', 'color:var(--txt2)', 'transition:all .15s',
        ].join(';');
        btn.textContent = tmpl.label;
        btn.onclick = function () {
          const ta = document.getElementById('slack-compose-ta');
          if (ta) ta.value = tmpl.text;
          // Highlight active
          list.querySelectorAll('button').forEach(function (b) {
            b.style.background = 'var(--el)';
            b.style.color      = 'var(--txt2)';
            b.style.borderColor = 'var(--bdr)';
          });
          btn.style.background   = 'var(--adim)';
          btn.style.color        = 'var(--acc2)';
          btn.style.borderColor  = 'rgba(88,166,255,.3)';
        };
        list.appendChild(btn);

        // Select first non-custom template by default
        if (i === 0) {
          setTimeout(function () { btn.click(); }, 0);
        }
      });
    }

    // Auth warning
    _checkAuthWarn();

    // Show
    const ov = document.getElementById('slack-compose-overlay');
    if (ov) {
      ov.style.display = 'flex';
      setTimeout(function () {
        const ta = document.getElementById('slack-compose-ta');
        if (ta) ta.focus();
      }, 80);
    }
  }

  function _closeSlackModal() {
    const ov = document.getElementById('slack-compose-overlay');
    if (ov) ov.style.display = 'none';
  }

  /* ── 6. Auth warning display ─────────────────────────────────────────── */

  function _checkAuthWarn() {
    const warn = document.getElementById('slack-auth-warn');
    const sendBtn = document.getElementById('slack-send-btn');
    if (!warn) return;

    // Use auth-bridge state if available, otherwise assume ok
    const slackOk = (window._authBridge && window._authBridge.state)
      ? window._authBridge.state.slack !== false
      : true;

    warn.style.display = slackOk ? 'none' : 'block';
    if (sendBtn) {
      sendBtn.disabled = !slackOk;
      sendBtn.style.opacity = slackOk ? '1' : '.4';
    }
  }

  async function _triggerSlackLogin() {
    if (!HAS_SLACK_LOGIN) {
      if (typeof window.toast === 'function') {
        window.toast('Slack login not available in dev mode', 'info', 'Slack');
      }
      return;
    }
    try {
      if (typeof window.toast === 'function') {
        window.toast('Opening Slack auth...', 'info', 'Slack');
      }
      await window.slack.login();
      // Re-poll auth-bridge after 5s
      setTimeout(function () {
        if (window._authBridge && typeof window._authBridge.pollNow === 'function') {
          window._authBridge.pollNow().then(function () {
            _checkAuthWarn();
          }).catch(function () {});
        }
      }, 5000);
    } catch (e) {
      console.warn('[slack-bridge] login error:', e);
    }
  }

  /* ── 7. Core: send ───────────────────────────────────────────────────── */

  async function _sendFromModal() {
    if (_state.sending) return;

    const ta = document.getElementById('slack-compose-ta');
    const text = ta ? ta.value.trim() : '';
    if (!text) {
      if (typeof window.toast === 'function') {
        window.toast('Message cannot be empty', 'warning', 'Slack');
      }
      return;
    }

    _state.sending = true;

    const sendBtn = document.getElementById('slack-send-btn');
    if (sendBtn) {
      sendBtn.disabled   = true;
      sendBtn.textContent = 'Sending...';
    }

    try {
      await sendFleetAlert({ text: text });
      _closeSlackModal();
    } finally {
      _state.sending = false;
      if (sendBtn) {
        sendBtn.disabled    = false;
        sendBtn.textContent = 'Send to Slack';
      }
    }
  }

  async function sendFleetAlert(opts) {
    if (!opts || !opts.text) return;

    if (!HAS_SLACK_SEND) {
      // Dev fallback
      await new Promise(function (r) { setTimeout(r, 800); });
      if (typeof window.toast === 'function') {
        window.toast('Slack: ' + opts.text.slice(0, 60) + '...', 'success', 'Slack (dev)');
      }
      _state.lastSent = { text: opts.text, ts: Date.now() };
      return { ok: true, dev: true };
    }

    try {
      const result = await window.slack.send({
        channel: opts.channel || null, // backend picks default channel if null
        text:    opts.text,
      });

      _state.lastSent = { text: opts.text, ts: Date.now(), result: result };

      if (result && result.ok) {
        if (typeof window.toast === 'function') {
          window.toast('Message sent to Slack', 'success', 'Slack');
        }
      } else {
        const err = (result && result.error) || 'Unknown error';
        if (typeof window.toast === 'function') {
          window.toast('Slack send failed: ' + err, 'warning', 'Slack');
        }
      }

      return result;

    } catch (e) {
      console.warn('[slack-bridge] send error:', e);
      if (typeof window.toast === 'function') {
        window.toast('Slack error: ' + (e.message || 'IPC error'), 'warning', 'Slack');
      }
      return { ok: false, error: e.message };
    }
  }

  /* ── 8. Patch window.draftSlack (override inline version) ────────────── */

  function _patchDraftSlack() {
    // The inline draftSlack() populates the chat input — we upgrade it to
    // open the real compose modal instead.
    const _originalDraftSlack = typeof window.draftSlack === 'function'
      ? window.draftSlack
      : null;

    window.draftSlack = function () {
      const uid = window._curDrawerUid;
      if (uid) {
        _openSlackModal(uid);
      } else if (_originalDraftSlack) {
        _originalDraftSlack();
      } else {
        if (typeof window.toast === 'function') {
          window.toast('Open a unit drawer first', 'warning', 'Slack');
        }
      }
    };
  }

  /* ── 9. Wire context menu "Send Slack Message" button ────────────────── */

  function _wireCtxSlack() {
    const menu = document.getElementById('ctxMenu');
    if (!menu) return;

    // Find the existing "Send Slack Message" button by text
    const items = menu.querySelectorAll('.ctx-item');
    items.forEach(function (item) {
      if (item.textContent.includes('Slack')) {
        item.onclick = function () {
          const uid = window.ctxTarget;
          if (typeof window.closeCtx === 'function') window.closeCtx();
          _openSlackModal(uid || null);
        };
      }
    });
  }

  /* ── 10. Boot ────────────────────────────────────────────────────────── */

  function boot() {
    // Expose globals
    window.sendFleetAlert = sendFleetAlert;

    // Patch inline draftSlack
    _patchDraftSlack();

    // Wire context menu
    _wireCtxSlack();

    // Pre-build the modal DOM so first open is instant
    _ensureModal();

    const mode = HAS_SLACK_SEND ? 'IPC mode' : 'dev mode';
    console.log(
      '[slack-bridge] loaded —', mode,
      '(send=' + HAS_SLACK_SEND +
      ' auth=' + HAS_SLACK_AUTH +
      ' login=' + HAS_SLACK_LOGIN + ')'
    );
  }

  /* ── 11. Debug handle ────────────────────────────────────────────────── */

  window._slackBridge = {
    version:        '1.0.0',
    HAS_SLACK_SEND:  HAS_SLACK_SEND,
    HAS_SLACK_AUTH:  HAS_SLACK_AUTH,
    HAS_SLACK_LOGIN: HAS_SLACK_LOGIN,
    state:           _state,
    openModal:       _openSlackModal,
    _closeModal:     _closeSlackModal,
    _sendFromModal:  _sendFromModal,
    sendFleetAlert:  sendFleetAlert,
  };

  /* ── 12. Start ───────────────────────────────────────────────────────── */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
