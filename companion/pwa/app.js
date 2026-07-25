// Fleet Ops Companion -- app shell logic
//
// !!! SET THIS after you deploy the worker (see companion/README.md) !!!
// Looks like: https://fleet-companion.<your-subdomain>.workers.dev
const WORKER_BASE = 'https://fleet-companion.z-fleet.workers.dev';
// !!! SET THIS to the PHONE_TOKEN you set via `wrangler secret put PHONE_TOKEN` !!!
const PHONE_TOKEN = 'c78ae0aea34fd7479ed55dce330e9673';

const statusEl = document.getElementById('status');
const btnEnable = document.getElementById('btn-enable');
const alertsListEl = document.getElementById('alerts-list');

function setStatus(msg) { statusEl.textContent = msg; }

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) throw new Error('Service workers not supported');
  return navigator.serviceWorker.register('sw.js');
}

async function enableNotifications() {
  btnEnable.disabled = true;
  try {
    if (!('PushManager' in window)) {
      setStatus('Push notifications are not supported in this browser.');
      return;
    }
    setStatus('Requesting permission...');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setStatus('Notifications permission was not granted.');
      return;
    }

    const registration = await registerServiceWorker();
    await navigator.serviceWorker.ready;

    setStatus('Fetching push key...');
    const keyRes = await fetch(`${WORKER_BASE}/api/vapid-public-key`);
    const { publicKey } = await keyRes.json();

    setStatus('Subscribing...');
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    await fetch(`${WORKER_BASE}/api/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    });

    setStatus('Notifications enabled. You will get pushed alerts on this phone.');
    btnEnable.textContent = 'Notifications Enabled';
  } catch (err) {
    setStatus('Error: ' + err.message);
    btnEnable.disabled = false;
  }
}

function renderAlerts(alerts) {
  if (!alerts || alerts.length === 0) {
    alertsListEl.innerHTML = '<div class="empty">No alerts yet.</div>';
    return;
  }
  alertsListEl.innerHTML = alerts.map((a) => `
    <div class="alert-card">
      <div class="alert-title">${escapeHtml(a.title)}</div>
      <div class="alert-body">${escapeHtml(a.body)}</div>
      <div class="alert-time">${new Date(a.ts).toLocaleString()}</div>
    </div>
  `).join('');
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadAlerts() {
  try {
    const res = await fetch(`${WORKER_BASE}/api/alerts`);
    const data = await res.json();
    renderAlerts(data.alerts);
  } catch {
    alertsListEl.innerHTML = '<div class="empty">Could not load alerts.</div>';
  }
}

btnEnable.addEventListener('click', enableNotifications);

// ── Tabs ──────────────────────────────────────────────────────────────────────
const tabBtnChat = document.getElementById('tab-btn-chat');
const tabBtnAlerts = document.getElementById('tab-btn-alerts');
const tabChat = document.getElementById('tab-chat');
const tabAlerts = document.getElementById('tab-alerts');

function showTab(name) {
  const isChat = name === 'chat';
  tabBtnChat.classList.toggle('active', isChat);
  tabBtnAlerts.classList.toggle('active', !isChat);
  tabChat.classList.toggle('active', isChat);
  tabAlerts.classList.toggle('active', !isChat);
}
tabBtnChat.addEventListener('click', () => showTab('chat'));
tabBtnAlerts.addEventListener('click', () => showTab('alerts'));

// ── Chat ──────────────────────────────────────────────────────────────────────
const chatScroll = document.getElementById('chat-scroll');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatThinking = document.getElementById('chat-thinking');
let _lastRenderedCount = 0;

function renderChat(messages) {
  if (!messages || messages.length === 0) {
    chatScroll.innerHTML = '<div class="empty">Ask your fleet assistant anything.</div>';
    return;
  }
  chatScroll.innerHTML = messages.map((m) => `
    <div class="msg ${m.role === 'user' ? 'user' : 'assistant'}">
      ${escapeHtml(m.text)}
      <div class="msg-time">${new Date(m.ts).toLocaleTimeString()}</div>
    </div>
  `).join('');
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

async function loadChatHistory(scrollToBottom) {
  try {
    const res = await fetch(`${WORKER_BASE}/api/chat-history`, {
      headers: { Authorization: `Bearer ${PHONE_TOKEN}` },
    });
    const data = await res.json();
    const messages = data.messages || [];
    // Once a new assistant message shows up, the reply has landed -- hide
    // the "thinking" indicator even if the phone missed the push (app was
    // in the foreground and push notifications don't fire while visible).
    if (messages.length > _lastRenderedCount) chatThinking.style.display = 'none';
    _lastRenderedCount = messages.length;
    renderChat(messages);
    if (scrollToBottom) chatScroll.scrollTop = chatScroll.scrollHeight;
  } catch {
    // Leave whatever is currently rendered; will retry on next interval tick.
  }
}

async function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  chatThinking.style.display = 'block';
  try {
    await fetch(`${WORKER_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PHONE_TOKEN}` },
      body: JSON.stringify({ text }),
    });
    await loadChatHistory(true);
  } catch (err) {
    chatThinking.style.display = 'none';
    setStatus('Could not send message: ' + err.message);
  }
}

chatSend.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});

registerServiceWorker().catch(() => {});
loadAlerts();
loadChatHistory(true);
setInterval(loadAlerts, 30000); // refresh every 30s while the app is open
setInterval(loadChatHistory, 5000); // poll for AI replies every 5s while open
