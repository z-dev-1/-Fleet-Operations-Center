/**
 * chat-bridge.js — Module 4: AI Chat IPC Bridge
 * Fleet Ops V-C, Stage 1
 *
 * Patches window.sendMsg() to route through window.ai.chat (IPC) when
 * available. Falls back to the existing canned-response array in dev mode.
 *
 * Key behaviours:
 *   - HAS_AI flag captured once at load time (never throws)
 *   - Current unit context (_curDrawerUid / UNITS) injected into every prompt
 *   - Typing indicator shown while IPC in flight
 *   - IPC errors demoted to warning toast — never throw to caller
 *   - In-flight lock prevents double-send
 *   - window._chatBridge debug handle exposed for console inspection
 */

(function () {
  'use strict';

  /* ── 1. Capability detection ─────────────────────────────────────────── */
  // S21-A: hasAI() checked lazily per-call (avoids load-time preload race)
  function hasAI() { return !!(window.ai && typeof window.ai.chat === 'function'); }

  /* ── 2. Dev-mode canned responses (preserved from original sendMsg) ─── */
  const DEV_RESPONSES = [
    'T-7743 risk 91. Parts ETA EOD at TA Fleet.',
    '4 offsite: T-2291 Cox, T-8821+T-5523 Amerit, T-4401 Goodyear.',
    'SLA breach: T-5523 at 46%. Escalate to Amerit.',
    'Can draft Slack msg, WR, or summarize trends.',
    'Risk 75+: T-7743 T-2291 T-8821.',
  ];
  let _devIdx = 0;

  /* ── 3. Helpers ─────────────────────────────────────────────────────── */
  /**
   * Build a context prefix from the currently-open drawer unit so the AI
   * knows which unit the operator is looking at.
   */
  // S22: buildAppContext -- replaces buildUnitContext with full app awareness
  function buildUnitContext() { return buildAppContext(); }

  function buildAppContext() {
    try {
      const parts = [];

      // 1. Current view
      const activeBtn = document.querySelector('.nav-btn.active, .toolbar-btn.active');
      const view = (activeBtn && activeBtn.dataset.view) || 'fleet';
      parts.push('[App Context]');
      parts.push('View: ' + view);

      // 2. Fleet summary
      const allUnits = window.UNITS ? Object.values(window.UNITS) : [];
      if (allUnits.length) {
        const offsite   = allUnits.filter(u => u.ats === 'Unavailable').length;
        const breached  = allUnits.filter(u => u.slaPct >= 90).length;
        const risk90    = allUnits.filter(u => u.risk >= 90).length;
        const avgRisk   = allUnits.length ? Math.round(allUnits.reduce(function(s,u){ return s+u.risk; },0)/allUnits.length) : 0;
        parts.push('Fleet: '+allUnits.length+' units | '+offsite+' offsite | '+breached+' SLA-breach | '+risk90+' risk90+ | avgRisk='+avgRisk);
      }

      // 3. Selected unit (if open)
      const uid = window._curDrawerUid;
      const u   = uid && window.UNITS && window.UNITS[uid];
      if (u) {
        parts.push('Selected: '+u.id+' | '+(u.year||'')+' '+(u.make||'')+' | Op='+(u.op||'--')+' Site='+(u.site||'--'));
        parts.push('  Vendor='+(u.vendor||'--')+' | Relay='+(u.relay||'--')+' | SLA='+(u.sla||'--')+' | Risk='+(u.risk||0));
        if (u.intel) parts.push('  AI: '+u.intel.slice(0,120));
      }

      // 4. Recent Slack messages mentioning this unit (if Slack available)
      if (uid && window._slackInbox && window._slackInbox.recentForUnit) {
        const slackCtx = window._slackInbox.recentForUnit(uid, 3);
        if (slackCtx.length) {
          parts.push('  Recent Slack ('+uid+'):');
          slackCtx.forEach(function(m){ parts.push('    ['+m.time+'] '+m.text.slice(0,100)); });
        }
      }

      const ctx = parts.join('\n');
      return ctx.length > 1200 ? ctx.slice(0,1200)+'...' : ctx;
    } catch (_) {
      return '';
    }
  }

  /**
   * Append a message bubble to #chatMsgs and return the element.
   * role: 'ai' | 'user'
   */

  function appendBubble(role, text) {
    const msgs = document.getElementById('chatMsgs');
    if (!msgs) return null;

    const isUser = role === 'user';
    const wrap   = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:8px;' + (isUser ? 'flex-direction:row-reverse;' : '') + 'margin-bottom:6px';

    const av = document.createElement('div');
    av.style.cssText = isUser
      ? 'width:22px;height:22px;border-radius:50%;background:var(--el);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;border:1px solid var(--bdr);color:var(--txt2)'
      : 'width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--acc),var(--pur));display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;flex-shrink:0';
    av.textContent = isUser ? 'ZS' : 'O';

    const mb = document.createElement('div');
    mb.style.cssText = isUser
      ? 'max-width:220px;padding:8px 12px;border-radius:12px;border-bottom-right-radius:3px;font-size:11px;background:var(--adim);border:1px solid var(--acc);color:var(--txt)'
      : 'max-width:220px;padding:8px 12px;border-radius:12px;border-bottom-left-radius:3px;font-size:11px;background:var(--card);border:1px solid var(--bdr);color:var(--txt)';
    mb.textContent = text;

    wrap.appendChild(av);
    wrap.appendChild(mb);
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
    return mb;
  }

  /**
   * Show animated typing indicator; returns {el, resolve}.
   * resolve(text) replaces the dots with the final answer.
   */
  function showTyping() {
    const msgs = document.getElementById('chatMsgs');
    if (!msgs) return { el: null, resolve: function () {} };

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:8px;margin-bottom:6px';
    const av   = document.createElement('div');
    av.style.cssText = 'width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--acc),var(--pur));display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;flex-shrink:0';
    av.textContent = 'O';
    const mb = document.createElement('div');
    mb.style.cssText = 'max-width:220px;padding:8px 12px;border-radius:12px;border-bottom-left-radius:3px;font-size:11px;background:var(--card);border:1px solid var(--bdr);color:var(--txt)';
    mb.innerHTML = '<div class="dots"><span></span><span></span><span></span></div>';
    wrap.appendChild(av);
    wrap.appendChild(mb);
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;

    return {
      el: wrap,
      // S21-C: path param adds sub-label on AI bubble
      resolve: function (text, path) {
        mb.textContent = text;
        if (path) {
          var lbl = document.createElement('div');
          lbl.style.cssText = 'font-size:9px;color:var(--mut);margin-top:4px;opacity:.7';
          lbl.textContent = path === 'fallback' ? '* via fallback' : '* via relay';
          mb.appendChild(lbl);
        }
        msgs.scrollTop = msgs.scrollHeight;
      },
    };
  }

  /* ── 4. Core send logic ──────────────────────────────────────────────── */
  let _inflight = false;

  async function sendMsgPatched() {
    if (_inflight) return;                           // debounce double-tap

    const inp  = document.getElementById('ci');
    const tx   = inp ? inp.value.trim() : '';
    if (!tx) return;

    // Clear input immediately
    if (inp) inp.value = '';

    // S22: /reply command -- send Slack DM directly from chat
    if (tx.startsWith('/reply ') && window.slack && window.slack.send) {
      appendBubble('user', tx);
      _inflight = true;
      const typing = showTyping();
      try {
        const rest = tx.slice(7).trim();
        const spIdx = rest.indexOf(' ');
        if (spIdx < 1) { typing.resolve('Usage: /reply @alias message'); return; }
        const recipient = rest.slice(0, spIdx).replace(/^@/, '');
        const message   = rest.slice(spIdx+1).trim();
        const res = await window.slack.send({ recipient, message });
        if (res && res.ok) {
          typing.resolve('Slack sent to ' + recipient + '');
        } else {
          typing.resolve('Slack send failed: '+(res&&res.error||'unknown'));
        }
      } catch(e) { typing.resolve('Slack error: '+e.message); }
      finally { _inflight = false; }
      return;
    }

    // Render user bubble
    appendBubble('user', tx);


    // Show typing indicator
    const typing = showTyping();
    _inflight = true;

    try {
      if (hasAI()) {  // S21-A: lazy check
        /* ── IPC path ── */
        const ctx    = buildUnitContext();
        const prompt = ctx ? ctx + '\n' + tx : tx;

        let result;
        try {
          result = await window.ai.chat(prompt);
        } catch (e) {
          throw new Error('IPC error: ' + e.message);
        }

        // Backend returns { ok, text, path } -- normalise (S21-C)
        let answer = '';
        let ipcPath = null;
        if (result && typeof result === 'object' && result.text) {
          answer  = result.text;
          ipcPath = result.path || null;  // S21-C
        } else if  (typeof result === 'string') {
          answer = result;
        } else {
          answer = 'No response from AI.';
        }

        typing.resolve(answer, ipcPath);  // S21-C

      } else {
        /* ── Dev-mode path ── */
        await new Promise(function (r) { setTimeout(r, 750); });
        typing.resolve(DEV_RESPONSES[_devIdx % DEV_RESPONSES.length]);
        _devIdx++;
      }

    } catch (err) {
      // Replace typing dots with friendly error
      if (typing.el) typing.el.remove();
      appendBubble('ai', '⚠ ' + err.message);
      if (typeof window.toast === 'function') {
        window.toast('Chat error: ' + err.message, 'warning', 'Orcha AI');
      }
    } finally {
      _inflight = false;
    }
  }

  /* ── 5. Patch window.sendMsg ─────────────────────────────────────────── */
  const _originalSendMsg = window.sendMsg;   // may be undefined on first load

  window.sendMsg = function () {
    // sendMsgPatched is async; original synchronous callers (onclick, onkeydown)
    // just fire-and-forget. We swallow the returned Promise here intentionally.
    sendMsgPatched().catch(function (e) {
      console.error('[chat-bridge] Unhandled error in sendMsgPatched:', e);
    });
  };

  /* ── 6. Debug handle ─────────────────────────────────────────────────── */
  window._chatBridge = {
    version:         '1.1.0',  // S21 hardened
    hasAI:           hasAI,    // S21-A: lazy function
    inflight:        function () { return _inflight; },
    buildUnitContext: buildUnitContext,
    buildAppContext: buildAppContext,
    devResponses:    DEV_RESPONSES,
    _originalSendMsg: _originalSendMsg,
  };

  /* ── 7. Boot log ─────────────────────────────────────────────────────── */
  const mode = HAS_AI ? 'IPC (window.ai.chat)' : 'dev (canned responses)';
  console.log('[chat-bridge] loaded — mode:', mode);

})();
