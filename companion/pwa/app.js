// Fleet Ops Companion -- app shell logic
//
// !!! SET THIS after you deploy the worker (see companion/README.md) !!!
// Looks like: https://fleet-companion.<your-subdomain>.workers.dev
const WORKER_BASE = 'https://fleet-companion.z-fleet.workers.dev';

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

registerServiceWorker().catch(() => {});
loadAlerts();
setInterval(loadAlerts, 30000); // refresh every 30s while the app is open
