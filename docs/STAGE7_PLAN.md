# Fleet Ops V-C · Stage 7 — mwinit Prompt on Auth Failure: Plan

**Date:** 2026-06-28  
**Baseline:** Stage 6 complete — 516/516 sanity checks, tag `scraper-resilience-stage6-complete`  
**Scope:** `src/sync/index.js`, `src/ipc/misc.js`, `renderer/src/js/auth-bridge.js`

---

## 1. Background — What Was Deferred from Stage 6

`checkMwinit()` in `auth.js` reads the mtime of `~/.midway/cookie` and returns a warning if the file is older than 12 hours. It is called from `ipc/setup.js` during setup flow only. It is not called anywhere in the sync path.

When `ensureAuthenticated()` throws `RELAY_SESSION_INVALID` (the new Stage 6 error code), the caller in `sync/index.js` catches it as a generic `authErr` and calls `ctx.pushError('Login cancelled or timed out: ' + authErr.message)`. The renderer displays this as a red toast and a status-bar error. The user sees a string — they have no obvious path to fix it from within the app.

The specific friction: `RELAY_SESSION_INVALID` always means "run `mwinit`". But the error path today does nothing to offer that. The user must:
1. Notice the error message
2. Know that "re-run mwinit" means opening a terminal
3. Know the correct command (`mwinit` or `mwinit -f`)
4. Come back and click Sync Now

`auth:run-mwinit` already exists in `ipc/misc.js` — it spawns mwinit in a terminal (cross-platform: PowerShell on Windows, Terminal on Mac). The `window.auth.runMwinit()` bridge exists in `preload.js`. The `auth:mwinit-status` channel sends progress back to the renderer. The `auth-bridge.js` module already handles live mwinit status toasts.

Everything is in place. Stage 7 connects the dots: when a `RELAY_SESSION_INVALID` or `MIDWAY_SESSION_INVALID` auth failure is detected, the app proactively fires an OS notification and offers a one-click "Run mwinit" prompt in the renderer rather than just a red error string.

---

## 2. Audit Findings — Stage 7 Targets

### 2.1 `sync/index.js` — auth error code not inspected

Current catch block (lines 79–82):

```js
} catch (authErr) {
  ctx.pushError('Login cancelled or timed out: ' + authErr.message);
  ctx.isSyncing = false;
  return;
}
```

`authErr.code` is never read. Both `RELAY_SESSION_INVALID` and `MIDWAY_SESSION_INVALID` carry a `.code` property (set via `Object.assign(new Error(msg), { code: '...' })`). The catch block does not distinguish "user cancelled the login window" from "Midway session expired" — both produce the same generic message.

**Proposed fix:** branch on `authErr.code` to send a structured auth-failure signal:

```js
} catch (authErr) {
  const isSession = authErr.code === 'RELAY_SESSION_INVALID' ||
                    authErr.code === 'MIDWAY_SESSION_INVALID';
  ctx.pushError('Login cancelled or timed out: ' + authErr.message);
  if (isSession) ctx.pushAuthFailure({ code: authErr.code, message: authErr.message });
  ctx.isSyncing = false;
  return;
}
```

`ctx.pushAuthFailure` is a new context method (added to `app.js`) that sends `fleet:auth-failure` to the renderer with the structured payload `{ code, message }`.

### 2.2 `app.js` — no `pushAuthFailure` context method

`ctx` is assembled in `app.js` around line 140. The relevant portion:

```js
const ctx = {
  ...
  pushError:    _pushError,      // sends 'fleet:error' string
  pushStatus:   _pushStatus,     // sends 'fleet:status' string
  ...
};
```

**Proposed fix:** add `pushAuthFailure` to `ctx`:

```js
pushAuthFailure: (payload) => _send('fleet:auth-failure', payload),
```

`_send` is the same `mainWindow.webContents.send` wrapper used for all other push channels.

### 2.3 `preload.js` — no `fleet:auth-failure` listener exposed

`window.fleet` currently exposes `onData`, `onStatus`, `onError`. A new listener needs to be added for `fleet:auth-failure`.

**Proposed fix:**

```js
contextBridge.exposeInMainWorld('fleet', {
  ...existing...
  onAuthFailure: (cb) => on('fleet:auth-failure', cb),
});
```

### 2.4 `renderer/src/js/bridge.js` — no handler for `fleet:auth-failure`

`init()` wires all push-channel listeners. Needs a new subscription:

```js
window.fleet.onAuthFailure((payload) => {
  bus.emit('fleet:auth-failure', payload);
});
```

### 2.5 `renderer/src/js/auth-bridge.js` — no response to `fleet:auth-failure`

`auth-bridge.js` already handles `auth:mwinit-status` live progress. It needs to listen for `fleet:auth-failure` and:

1. **OS notification** (via `window.notify` / `window.app.notify`): "Midway session expired — click to re-authenticate"
2. **In-app mwinit prompt banner**: inject a dismissible yellow banner above the status bar (or use the existing `toast` mechanism with an action button) offering "Run mwinit now"
3. **On click**: call `window.auth.runMwinit()`, which fires `auth:mwinit-status` progress back through the existing channel

---

## 3. Proposed Work — Stage 7

### Step 1 — Structured auth-failure channel (`sync/index.js` + `app.js` + `preload.js` + `bridge.js`)

**Files:** `src/sync/index.js`, `src/app.js`, `preload.js`, `renderer/src/js/bridge.js`  
**Estimated checks:** +8

#### `src/app.js`

Add `pushAuthFailure` to the `ctx` object assembled around line 140:

```js
pushAuthFailure: (payload) => _send('fleet:auth-failure', payload),
```

#### `src/sync/index.js`

Extend the `authErr` catch block to branch on `.code`:

```js
} catch (authErr) {
  const _isSessionErr = authErr.code === 'RELAY_SESSION_INVALID' ||
                        authErr.code === 'MIDWAY_SESSION_INVALID';
  ctx.pushError('Login cancelled or timed out: ' + authErr.message);
  if (_isSessionErr) {
    logger.warn('[Sync] Auth session failure — code:', authErr.code);
    ctx.pushAuthFailure({ code: authErr.code, message: authErr.message });
  }
  ctx.isSyncing = false;
  return;
}
```

#### `preload.js`

Add `onAuthFailure` listener to `window.fleet`:

```js
contextBridge.exposeInMainWorld('fleet', {
  // ...existing...
  onAuthFailure: (cb) => on('fleet:auth-failure', cb),
});
```

#### `renderer/src/js/bridge.js`

Wire `fleet:auth-failure` in `init()`:

```js
window.fleet.onAuthFailure((payload) => {
  bus.emit('fleet:auth-failure', payload);
});
```

---

### Step 2 — mwinit prompt in `auth-bridge.js`

**Files:** `renderer/src/js/auth-bridge.js`  
**Estimated checks:** +6

Add a `fleet:auth-failure` subscription at the bottom of the IIFE in `auth-bridge.js`. On auth failure:

1. Fire an OS-level notification via `window.app.notify` if available
2. Inject a dismissible `#mwinit-prompt-bar` banner into the DOM (above `#status-bar`) with:
   - Yellow/amber background
   - Text: `"Midway session expired — run mwinit to re-authenticate"`
   - Button: `"Run mwinit"` → calls `window.auth.runMwinit()`
   - Dismiss (×) button → removes the banner
3. On `auth:mwinit-status` events while the banner is visible: update banner text to show progress ("launched", "complete")
4. Auto-dismiss the banner after mwinit completes (status = `'launched'` + 5s, or `'complete'`)

Implementation in `auth-bridge.js` (appended inside the existing IIFE):

```js
/* ── 7. fleet:auth-failure → mwinit prompt ────────────────────────────── */
function _showMwinitPrompt(code) {
  // Remove any existing prompt first (idempotent)
  const existing = document.getElementById('mwinit-prompt-bar');
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.id = 'mwinit-prompt-bar';
  bar.setAttribute('data-code', code);
  bar.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
    'background:#b45309', 'color:#fff',
    'padding:8px 16px', 'font-size:13px',
    'display:flex', 'align-items:center', 'gap:10px',
    'box-shadow:0 2px 6px rgba(0,0,0,.4)',
  ].join(';');
  bar.innerHTML = [
    '<span id="mwinit-prompt-msg">',
      'Midway session expired \u2014 run <code>mwinit</code> to re-authenticate',
    '</span>',
    '<button id="mwinit-prompt-btn" style="',
      'background:#fff;color:#b45309;border:none;border-radius:4px;',
      'padding:3px 10px;cursor:pointer;font-size:12px;font-weight:600;',
    '">Run mwinit</button>',
    '<button id="mwinit-prompt-dismiss" style="',
      'background:transparent;color:#fff;border:none;font-size:16px;',
      'cursor:pointer;margin-left:auto;line-height:1;',
    '">\u00D7</button>',
  ].join('');

  document.body.prepend(bar);

  document.getElementById('mwinit-prompt-btn').addEventListener('click', () => {
    document.getElementById('mwinit-prompt-msg').textContent =
      'Launching mwinit — complete authentication in the terminal window...';
    document.getElementById('mwinit-prompt-btn').disabled = true;
    if (window.auth && typeof window.auth.runMwinit === 'function') {
      window.auth.runMwinit().catch(() => {});
    }
  });

  document.getElementById('mwinit-prompt-dismiss').addEventListener('click', () => {
    bar.remove();
  });
}

function _updateMwinitPrompt(status) {
  const msg = document.getElementById('mwinit-prompt-msg');
  if (!msg) return;
  if (status === 'launched') {
    msg.textContent = 'mwinit launched — complete auth in terminal, then click Sync Now';
    // Auto-dismiss after 15s — user should re-sync manually
    setTimeout(() => {
      const b = document.getElementById('mwinit-prompt-bar');
      if (b) b.remove();
    }, 15_000);
  } else if (status === 'complete') {
    msg.textContent = 'mwinit complete — click Sync Now to retry';
    setTimeout(() => {
      const b = document.getElementById('mwinit-prompt-bar');
      if (b) b.remove();
    }, 8_000);
  } else if (status && status.startsWith('error:')) {
    msg.textContent = 'mwinit failed to launch: ' + status.slice(6);
  }
}

// Listen for session auth failures
if (typeof window.addEventListener === 'function') {
  document.addEventListener('fleet:auth-failure-event', (e) => {
    _showMwinitPrompt(e.detail && e.detail.code);
  });
}

// Wire bus → DOM event bridge (bus is module-scoped above this block via import)
// NOTE: auth-bridge.js is a legacy non-module IIFE; bus is not directly importable here.
// Use window.__fleet_bus if available (set by app.js init), else fallback to window event.
if (window.__fleet_bus && typeof window.__fleet_bus.on === 'function') {
  window.__fleet_bus.on('fleet:auth-failure', (payload) => {
    _showMwinitPrompt(payload && payload.code);
    // OS notification
    if (window.app && typeof window.app.notify === 'function') {
      window.app.notify(
        'Fleet: Midway session expired',
        'Run mwinit to re-authenticate, then click Sync Now'
      ).catch(() => {});
    }
  });
  window.__fleet_bus.on('auth:mwinit-status', _updateMwinitPrompt);
}
```

**Note on bus access in `auth-bridge.js`:** `auth-bridge.js` is a legacy IIFE script (non-ESM), loaded via `<script>` rather than as an ES module, so it cannot `import bus from './bus.js'`. Two options:
1. Expose `bus` as `window.__fleet_bus` from `app.js` init — clean, no structural change needed
2. Convert `auth-bridge.js` to an ES module — larger scope, not needed for this fix

**Option 1 is chosen.** One line added to `renderer/src/js/app.js` (or `bridge.js` `init()`) after bus wiring: `window.__fleet_bus = bus;`

---

## 4. Sanity Check Projection

| Step | New checks | Running total |
|---|---|---|
| End of Stage 6 | — | 516 |
| Step 1 — structured auth-failure channel | +8 | 524 |
| Step 2 — mwinit prompt in auth-bridge | +6 | **~530** |

### Step 1 planned checks

| ID | Check | File |
|---|---|---|
| S7-S1-a | `pushAuthFailure` present in `ctx` (`app.js`) | `src/app.js` |
| S7-S1-b | `fleet:auth-failure` channel sent via `_send` | `src/app.js` |
| S7-S1-c | `sync/index.js` reads `authErr.code` | `src/sync/index.js` |
| S7-S1-d | `RELAY_SESSION_INVALID` branch in authErr catch | `src/sync/index.js` |
| S7-S1-e | `MIDWAY_SESSION_INVALID` branch in authErr catch | `src/sync/index.js` |
| S7-S1-f | `pushAuthFailure` called in auth catch | `src/sync/index.js` |
| S7-S1-g | `onAuthFailure` exposed on `window.fleet` in `preload.js` | `preload.js` |
| S7-S1-h | `fleet:auth-failure` wired in `bridge.js` `init()` | `renderer/src/js/bridge.js` |

### Step 2 planned checks

| ID | Check | File |
|---|---|---|
| S7-S2-a | `_showMwinitPrompt` function present | `auth-bridge.js` |
| S7-S2-b | `mwinit-prompt-bar` element ID present | `auth-bridge.js` |
| S7-S2-c | `fleet:auth-failure` subscription via `__fleet_bus` | `auth-bridge.js` |
| S7-S2-d | `_updateMwinitPrompt` function handles `'launched'` | `auth-bridge.js` |
| S7-S2-e | OS notify call on auth failure present | `auth-bridge.js` |
| S7-S2-f | `window.__fleet_bus = bus` present in bridge init | `renderer/src/js/bridge.js` |

---

## 5. File Change Summary

| File | Step | Changes |
|---|---|---|
| `src/app.js` | 1 | Add `pushAuthFailure` to `ctx` |
| `src/sync/index.js` | 1 | Branch on `authErr.code` in auth catch; call `pushAuthFailure` |
| `preload.js` | 1 | Add `onAuthFailure` to `window.fleet` |
| `renderer/src/js/bridge.js` | 1 + 2 | Wire `fleet:auth-failure` bus event; expose `window.__fleet_bus` |
| `renderer/src/js/auth-bridge.js` | 2 | `_showMwinitPrompt`, `_updateMwinitPrompt`, `fleet:auth-failure` + `auth:mwinit-status` subscriptions, OS notify call |

---

## 6. Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| `window.__fleet_bus` not set before `auth-bridge.js` runs | Low | `auth-bridge.js` guards with `if (window.__fleet_bus && ...)` — no-op if bus not ready |
| OS `Notification` not supported (headless / no desktop) | Low | Existing `Notification.isSupported()` guard in `misc.js` `notify` handler catches this |
| Prompt banner injected before `document.body` exists | Negligible | `auth-bridge.js` defers to `DOMContentLoaded` already; auth failure cannot be emitted before sync starts |
| User dismisses banner and re-triggers sync without running mwinit | Accepted | Sync will fail again with the same error and re-show the banner |
| `auth:run-mwinit` spawns terminal but user closes it before completing | Accepted | `_updateMwinitPrompt('launched')` auto-dismisses after 15s with "click Sync Now" instruction; re-sync will re-show the banner if still stale |

---

## 7. Out of Scope for Stage 7

| Item | Reason |
|---|---|
| Auto-retry sync after mwinit completes | Cannot detect mwinit completion from the spawned terminal process — it runs detached. Would require polling `checkMwinit()` on a timer after launch, which is a separate feature. |
| `mwinit -f` force-refresh option | The existing `auth:run-mwinit` always uses plain `mwinit`. Adding a force flag requires a UI choice the spec does not call for. |
| `uptake.js` adaptive settle | Still deferred; not auth-related. |

---

*Document written 2026-06-28. Predecessor: STAGE6_COMPLETION.md.*
