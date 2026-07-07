/**
 * morning-briefing.js — Full-screen futuristic morning briefing overlay
 */

import bus from '../bus.js';

let _shown = false;

export function init() {
  if (!window.fleet || !window.fleet.onBriefing) return;

  window.fleet.onBriefing((data) => {
    if (_shown || !data) return;
    _shown = true;
    _showBriefing(data);
  });
}

function _showBriefing(data) {
  const overlay = document.createElement('div');
  overlay.id = 'morning-briefing';
  overlay.innerHTML = `
    <div class="mb-backdrop"></div>
    <div class="mb-content">
      <div class="mb-header">
        <div class="mb-greeting">${_getGreeting()}</div>
        <div class="mb-time">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
      </div>
      <div class="mb-divider"></div>
      <div class="mb-stats">
        <div class="mb-stat mb-stat--critical">
          <span class="mb-stat-num">${data.critical || 0}</span>
          <span class="mb-stat-label">Critical</span>
        </div>
        <div class="mb-stat mb-stat--warning">
          <span class="mb-stat-num">${data.warnings || 0}</span>
          <span class="mb-stat-label">Warnings</span>
        </div>
      </div>
      <div class="mb-body">${_formatAlerts(data.text)}</div>
      <button class="mb-dismiss" id="mb-dismiss">Enter Fleet Operations</button>
    </div>
  `;

  // Styles
  const style = document.createElement('style');
  style.textContent = `
    #morning-briefing {
      position: fixed; inset: 0; z-index: 99999;
      display: flex; align-items: center; justify-content: center;
      animation: mbFadeIn 0.8s ease forwards;
    }
    @keyframes mbFadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes mbFadeOut { from { opacity: 1; } to { opacity: 0; } }
    @keyframes mbSlideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    @keyframes mbPulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
    @keyframes mbScanline { from { top: -2px; } to { top: 100%; } }
    .mb-backdrop {
      position: absolute; inset: 0;
      background: radial-gradient(ellipse at center, rgba(13,17,23,0.95) 0%, rgba(0,0,0,0.99) 100%);
      backdrop-filter: blur(20px);
    }
    .mb-content {
      position: relative; z-index: 1;
      width: 500px; max-width: 90vw; max-height: 80vh;
      padding: 40px; overflow-y: auto;
      animation: mbSlideUp 0.6s 0.3s ease forwards;
      opacity: 0;
    }
    .mb-header { text-align: center; margin-bottom: 20px; }
    .mb-greeting {
      font-size: 28px; font-weight: 200; color: #e6edf3;
      letter-spacing: 1px; margin-bottom: 6px;
      text-shadow: 0 0 20px rgba(240,168,0,0.3);
    }
    .mb-time { font-size: 12px; color: #8b949e; letter-spacing: 2px; text-transform: uppercase; }
    .mb-divider {
      height: 1px; margin: 20px auto;
      background: linear-gradient(90deg, transparent, #f0a800, transparent);
      width: 60%; animation: mbPulse 2s infinite;
    }
    .mb-stats {
      display: flex; justify-content: center; gap: 40px; margin-bottom: 24px;
    }
    .mb-stat { text-align: center; }
    .mb-stat-num {
      display: block; font-size: 36px; font-weight: 700;
      font-family: 'SF Mono', monospace;
    }
    .mb-stat--critical .mb-stat-num { color: #f85149; text-shadow: 0 0 15px rgba(248,81,73,0.4); }
    .mb-stat--warning .mb-stat-num { color: #f0a800; text-shadow: 0 0 15px rgba(240,168,0,0.4); }
    .mb-stat-label { font-size: 10px; color: #8b949e; text-transform: uppercase; letter-spacing: 1.5px; }
    .mb-body {
      font-size: 12px; color: #c9d1d9; line-height: 1.8;
      font-family: 'SF Mono', Consolas, monospace;
      background: rgba(13,17,23,0.6); border: 1px solid rgba(48,54,61,0.5);
      border-radius: 8px; padding: 16px; max-height: 200px; overflow-y: auto;
    }
    .mb-body .mb-line-critical { color: #f85149; }
    .mb-body .mb-line-warning { color: #f0a800; }
    .mb-body .mb-line-ok { color: #3fb950; }
    .mb-dismiss {
      display: block; margin: 30px auto 0; padding: 12px 32px;
      background: linear-gradient(135deg, rgba(240,168,0,0.15), rgba(240,168,0,0.05));
      border: 1px solid rgba(240,168,0,0.4); border-radius: 8px;
      color: #f0a800; font-size: 12px; font-weight: 600; letter-spacing: 1px;
      cursor: pointer; transition: all 0.2s;
      text-transform: uppercase;
    }
    .mb-dismiss:hover {
      background: rgba(240,168,0,0.2); border-color: #f0a800;
      box-shadow: 0 0 20px rgba(240,168,0,0.2);
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(overlay);

  document.getElementById('mb-dismiss').addEventListener('click', () => {
    overlay.style.animation = 'mbFadeOut 0.4s ease forwards';
    setTimeout(() => overlay.remove(), 400);
  });

  // Auto-dismiss after 15s
  setTimeout(() => {
    if (document.getElementById('morning-briefing')) {
      overlay.style.animation = 'mbFadeOut 0.4s ease forwards';
      setTimeout(() => overlay.remove(), 400);
    }
  }, 15000);
}

function _getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good Morning';
  if (h < 17) return 'Good Afternoon';
  return 'Good Evening';
}

function _formatAlerts(text) {
  if (!text) return '<div class="mb-line-ok">Fleet is healthy. No critical issues.</div>';
  return text.split('\n').map(line => {
    if (line.includes('\uD83D\uDD34')) return '<div class="mb-line-critical">' + line + '</div>';
    if (line.includes('\u26A0')) return '<div class="mb-line-warning">' + line + '</div>';
    return '<div>' + line + '</div>';
  }).join('');
}
