# Fleet Ops Companion (iPhone PWA)

Phone companion for Fleet Operations Center. No Apple Developer account,
no App Store -- installs as a home-screen app via Safari, gets real push
notifications for fleet alerts.

Two pieces:
- `worker/` -- Cloudflare Worker (free tier). Stores push subscriptions,
  receives alerts from the desktop app, sends push notifications.
- `pwa/` -- the actual phone app (static site). Deployed to Cloudflare
  Pages (free tier).

## One-time setup

### 1. Log in to Cloudflare from this machine
```
cd companion/worker
npx wrangler login
```
Opens a browser tab to authorize. This machine's `wrangler` CLI is now
tied to your Cloudflare account.

### 2. Create the KV namespace (stores push subscriptions + alert history)
```
npx wrangler kv namespace create fleet-companion-kv
```
Copy the `id` it prints, paste it into `companion/worker/wrangler.toml`
replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

### 3. Generate VAPID keys (already done once for you)
These were generated already:
```
publicKey:  BCTCJLbCGjiWszHvrqg7OH7IpG2Wxryp1qgJbqMLpK-K1fP8e5Bp1TLZGQLUCmB5f5ontg8IbQtAAaeVehKOR-I
privateKey: LHH6ahkJfw1KfVeJlGEm-le2Sbgl3JXKv7HB_xSbOBI
```
(If you ever want fresh ones: `npx web-push generate-vapid-keys --json`)

### 4. Set the Worker's secrets
From `companion/worker/`:
```
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
npx wrangler secret put ALERT_SECRET
```
Each command prompts you to paste a value:
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` -- the values above
- `VAPID_SUBJECT` -- `mailto:you@example.com` (any email, required by the
  push spec, Apple/Google never contact it)
- `ALERT_SECRET` -- make up any long random string, e.g. run
  `openssl rand -hex 24` and use that. This is the password the desktop
  app uses so random strangers can't spam your phone if they ever guess
  your worker URL.

### 5. Deploy the Worker
```
npx wrangler deploy
```
It prints your Worker's live URL, e.g.
`https://fleet-companion.YOUR-SUBDOMAIN.workers.dev`. Copy it.

### 6. Point the PWA at your Worker
Edit `companion/pwa/app.js`, first line after the comment block:
```js
const WORKER_BASE = 'https://fleet-companion.YOUR-SUBDOMAIN.workers.dev';
```
Paste your real Worker URL from step 5.

### 7. Deploy the PWA to Cloudflare Pages
From `companion/pwa/`:
```
npx wrangler pages deploy . --project-name=fleet-companion-pwa
```
It prints a live URL, e.g. `https://fleet-companion-pwa.pages.dev`.

### 8. Install it on your iPhone
1. Open the Pages URL from step 7 in **Safari** on your iPhone
2. Tap Share -> "Add to Home Screen"
3. Open it from the home screen icon (not Safari) -- push notifications
   on iOS only work when launched from the installed home-screen icon
4. Tap "Enable Notifications" and allow the permission prompt

## Testing it end-to-end
Send yourself a test alert from any machine:
```
curl -X POST https://fleet-companion.YOUR-SUBDOMAIN.workers.dev/api/alert \
  -H "Authorization: Bearer YOUR_ALERT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test Alert","body":"This is a test from curl"}'
```
Your phone should get a push notification within a few seconds.

## Next step (not done yet)
Once this is confirmed working end-to-end, the desktop app's existing
alert/chat-head logic (`pushBubbleNotification()` in `src/window/index.js`,
Slack escalation trigger in `src/ipc/slack.js`) gets a small addition to
also POST to `/api/alert` using the Worker URL + ALERT_SECRET, stored via
the same `store` module used elsewhere in the app. That part is
intentionally not wired up yet -- confirm the phone pipeline works first.
