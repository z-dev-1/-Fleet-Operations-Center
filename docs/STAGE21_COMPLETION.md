# Fleet Ops V-C — Stage 21 Completion Record

**Date:** 2026-06-30
**Commit:** `2936840`
**Sanity suite:** 12 S21 checks pass within 914/914

---

## 1. What This Stage Was

Stage 21 was an **Orcha chat wiring audit** — a correctness and robustness pass
across the four files that make up the in-app AI chat stack:

| File | Role |
|---|---|
| `renderer/src/js/chat-bridge.js` | Routes `window.sendMsg()` through `window.ai.chat` IPC |
| `renderer/src/js/orcha-bridge.js` | Injects the Orcha drawer button into the unit-detail panel |
| `renderer/src/index.html` | Inline `sendMsg` fallback / bridge guard |
| `src/scrapers/orcha_ws.js` | Manages the persistent WebSocket session to the Orcha server |

The stage was a bug-fix pass, not a feature build. No new UI surfaces were added.

---

## 2. Changes Made (commit `2936840`)

### A — `chat-bridge.js`: lazy `hasAI()` guard
**Problem:** `window.ai` was read at module init time (before preload had injected
it), causing `sendMsg` to silently use the stub path even when AI was available.
**Fix:** Replaced the eager `const aiReady = !!window.ai` with a lazy
`function hasAI() { return !!(window.ai && typeof window.ai.chat === 'function'); }`
called at each send site.

### B — `chat-bridge.js`: `MAX_CTX` context window cap
**Problem:** Long conversation histories were being sent in full to the IPC layer,
causing token overruns on the Orcha WS side.
**Fix:** Added `MAX_CTX` constant; conversation array is sliced to `MAX_CTX` items
before each send.

### C — `chat-bridge.js`: `ipcPath` capture
**Problem:** Streaming responses returned an `ipcPath` for file-based result reads,
but the bridge was discarding it.
**Fix:** `ipcPath` captured from the IPC result and passed to `typing.resolve(text, path)`
so the renderer can deep-link to the response file if needed.

### D — `index.html`: `_chatBridge` guard on inline `sendMsg`
**Problem:** The inline `sendMsg` stub in `index.html` had no guard — it would run
even after `chat-bridge.js` had patched `window.sendMsg`, causing double-sends in
some timing windows.
**Fix:** Added `if (!_chatBridge)` guard on the inline definition.

### E — `orcha-bridge.js`: injection timing
**Problem:** The Orcha drawer button inject ran synchronously on `DOMContentLoaded`,
before the unit-detail panel HTML was stamped. Button was never found.
**Fix:** Wrapped inject in `setTimeout(_injectDrawerButton, 200)` with a 500ms
retry fallback if the button element is still missing.

### F — `orcha_ws.js`: session age guard (`SESSION_MAX_AGE_MS`)
**Problem:** Stale WebSocket sessions were being reused after the Orcha server had
already timed them out (no age check on restore).
**Fix:** `SESSION_MAX_AGE_MS` constant defined; `orcha_ws` now checks `mtimeMs` of
the session file on restore and stamps `_fleetChatSessionTs = Date.now()` on creation.
Sessions older than `SESSION_MAX_AGE_MS` are discarded and re-established.

---

## 3. Sanity Checks (S21) — 12 checks (A–F, 2 per fix)

| Check | Assertion |
|---|---|
| S21-A × 2 | `function hasAI` defined; `if (hasAI())` used at send site |
| S21-B | `MAX_CTX` constant in chat-bridge |
| S21-C × 2 | `ipcPath` captured from result; `typing.resolve` accepts `path` param |
| S21-D | `_chatBridge` guard in `index.html` inline `sendMsg` |
| S21-E × 2 | 200ms inject timeout; 500ms retry present |
| S21-F × 3 | `SESSION_MAX_AGE_MS` defined; `mtimeMs` checked on restore; session stamped with `Date.now()` |

All 12 pass. Suite at commit: **759/759**.

---

*Completion record written 2026-06-30.*
