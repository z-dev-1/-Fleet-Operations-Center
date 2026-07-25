/**
 * Fleet Companion Worker
 *
 * Tiny backend for the Fleet Operations Center phone companion PWA.
 * Responsibilities:
 *  - Hand out the VAPID public key so the PWA can subscribe to push
 *  - Store phone push subscriptions in KV
 *  - Accept alerts from the desktop app (POST /api/alert, secret-protected)
 *    and fan them out as real push notifications to every subscribed phone
 *  - Keep a short rolling history of recent alerts for the PWA's dashboard
 *
 * Env vars (set via `wrangler secret put <NAME>`):
 *   VAPID_PUBLIC_KEY   - from `npx web-push generate-vapid-keys`
 *   VAPID_PRIVATE_KEY  - from `npx web-push generate-vapid-keys`
 *   VAPID_SUBJECT      - e.g. "mailto:you@example.com" (required by the spec)
 *   ALERT_SECRET       - shared secret the desktop app sends as a Bearer
 *                        token when posting alerts, so randoms can't spam
 *                        your phone if they guess the worker URL
 *   PHONE_TOKEN        - shared secret the PWA sends as a Bearer token on
 *                        chat endpoints, so randoms can't chat with your
 *                        fleet assistant if they guess the worker URL
 */
import { buildPushPayload } from '@block65/webcrypto-web-push';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function subKey(endpoint) {
  // Stable, filesystem-safe KV key derived from the subscription endpoint URL.
  return 'sub:' + btoa(endpoint).replace(/[^a-zA-Z0-9]/g, '').slice(0, 120);
}

async function listSubscriptions(kv) {
  const subs = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'sub:', cursor });
    for (const key of page.keys) {
      const raw = await kv.get(key.name);
      if (raw) {
        try { subs.push(JSON.parse(raw)); } catch { /* skip corrupt entry */ }
      }
    }
    cursor = page.cursor;
  } while (cursor);
  return subs;
}

async function sendPushToAll(env, subs, payloadObj) {
  const results = await Promise.allSettled(
    subs.map(async (subscription) => {
      const message = { data: JSON.stringify(payloadObj), options: { ttl: 60 * 60 } };
      const vapid = {
        subject: env.VAPID_SUBJECT,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
      };
      const payload = await buildPushPayload(message, subscription, vapid);
      const res = await fetch(subscription.endpoint, payload);
      if (res.status === 404 || res.status === 410) {
        // Subscription is gone (user uninstalled / revoked) -- clean it up.
        await env.COMPANION_KV.delete(subKey(subscription.endpoint));
      }
      return res.status;
    })
  );
  return results;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ── Public: hand out the VAPID public key so the PWA can subscribe ──────
    if (pathname === '/api/vapid-public-key' && request.method === 'GET') {
      return json({ publicKey: env.VAPID_PUBLIC_KEY });
    }

    // ── Public: register this phone for push notifications ─────────────────
    if (pathname === '/api/subscribe' && request.method === 'POST') {
      const subscription = await request.json();
      if (!subscription || !subscription.endpoint) {
        return json({ error: 'invalid subscription' }, 400);
      }
      await env.COMPANION_KV.put(subKey(subscription.endpoint), JSON.stringify(subscription));
      return json({ ok: true });
    }

    if (pathname === '/api/unsubscribe' && request.method === 'POST') {
      const { endpoint } = await request.json();
      if (endpoint) await env.COMPANION_KV.delete(subKey(endpoint));
      return json({ ok: true });
    }

    // ── Public: recent alert history for the PWA dashboard ─────────────────
    if (pathname === '/api/alerts' && request.method === 'GET') {
      const raw = await env.COMPANION_KV.get('alerts:recent');
      return json({ alerts: raw ? JSON.parse(raw) : [] });
    }

    // ── Protected: desktop app posts a new alert here ───────────────────────
    if (pathname === '/api/alert' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.ALERT_SECRET}`) {
        return json({ error: 'unauthorized' }, 401);
      }

      const body = await request.json();
      const alert = {
        title: String(body.title || 'Fleet Ops Alert').slice(0, 120),
        body: String(body.body || '').slice(0, 500),
        url: body.url || '/',
        ts: Date.now(),
      };

      // Keep the last 20 alerts for the dashboard.
      const rawRecent = await env.COMPANION_KV.get('alerts:recent');
      const recent = rawRecent ? JSON.parse(rawRecent) : [];
      recent.unshift(alert);
      await env.COMPANION_KV.put('alerts:recent', JSON.stringify(recent.slice(0, 20)));

      const subs = await listSubscriptions(env.COMPANION_KV);
      const results = await sendPushToAll(env, subs, alert);

      return json({ ok: true, delivered: subs.length, results: results.map(r => r.status) });
    }

    // ── Phone: send a chat message to the fleet assistant ──────────────────
    if (pathname === '/api/chat' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.PHONE_TOKEN}`) {
        return json({ error: 'unauthorized' }, 401);
      }
      const { text } = await request.json();
      if (!text || !String(text).trim()) return json({ error: 'empty message' }, 400);

      const id = crypto.randomUUID();
      const msg = { id, role: 'user', text: String(text).slice(0, 2000), ts: Date.now() };

      const rawHistory = await env.COMPANION_KV.get('chat:history');
      const history = rawHistory ? JSON.parse(rawHistory) : [];
      history.push(msg);
      await env.COMPANION_KV.put('chat:history', JSON.stringify(history.slice(-100)));

      return json({ ok: true, id });
    }

    // ── Phone: fetch the running conversation ───────────────────────────────
    if (pathname === '/api/chat-history' && request.method === 'GET') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.PHONE_TOKEN}`) {
        return json({ error: 'unauthorized' }, 401);
      }
      const raw = await env.COMPANION_KV.get('chat:history');
      return json({ messages: raw ? JSON.parse(raw) : [] });
    }

    // ── Desktop: poll for phone messages awaiting an AI reply ───────────────
    // Derived directly from chat:history instead of a separate destructible
    // "pending" queue. KV is not strongly consistent across regions/time --
    // a queue that gets unconditionally overwritten-with-[] on every read can
    // silently lose a message if a poll lands on a stale read right after a
    // phone message was written. History never gets destructively cleared,
    // so nothing can be lost this way: any user message after the last
    // assistant reply is, by definition, still awaiting an answer.
    if (pathname === '/api/chat-poll' && request.method === 'GET') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.ALERT_SECRET}`) {
        return json({ error: 'unauthorized' }, 401);
      }
      const raw = await env.COMPANION_KV.get('chat:history');
      const history = raw ? JSON.parse(raw) : [];
      let lastAssistantIdx = -1;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'assistant') { lastAssistantIdx = i; break; }
      }
      const pending = history.slice(lastAssistantIdx + 1).filter(m => m.role === 'user');
      return json({ messages: pending });
    }

    // ── Desktop: post the AI's reply to a phone message ─────────────────────
    if (pathname === '/api/chat-reply' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.ALERT_SECRET}`) {
        return json({ error: 'unauthorized' }, 401);
      }
      const { id, text } = await request.json();
      const reply = { id: id || crypto.randomUUID(), role: 'assistant', text: String(text || '').slice(0, 4000), ts: Date.now() };

      const rawHistory = await env.COMPANION_KV.get('chat:history');
      const history = rawHistory ? JSON.parse(rawHistory) : [];
      history.push(reply);
      await env.COMPANION_KV.put('chat:history', JSON.stringify(history.slice(-100)));

      const subs = await listSubscriptions(env.COMPANION_KV);
      await sendPushToAll(env, subs, {
        title: 'Fleet Assistant',
        body: reply.text.slice(0, 150),
        url: './index.html',
      });

      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  },
};
