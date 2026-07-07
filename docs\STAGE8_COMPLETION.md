# Fleet Ops V-C · Stage 8 — Completion Record

**Date:** 2026-06-28  
**Commit:** `034fce5`  
**Tag:** `scraper-resilience-stage8-complete`  
**Sanity suite:** 524/524 (8 new checks — zero regressions)

---

## 1. What Was Done

Stage 8 applied adaptive settle to `src/scrapers/uptake.js` — the final deferred item from Stage 6. Six fixed sleeps were audited across the Uptake SPA scrape flow. Five were removed outright (redundant after DOM polls already confirmed content). One was replaced with a body-length delta poll.

---

## 2. Changes — `src/scrapers/uptake.js`

### New constants (after `DOM_POLL_MAX`)

```js
const UPTAKE_READ_MORE_WAIT_MS = 3_000;   // S8: Read More expansion poll deadline (was 2500ms fixed sleep)
const UPTAKE_READ_MORE_POLL_MS = 300;     // S8: body-length delta poll tick interval
```

### Removals

| Line (pre-S8) | Value | Why removed |
|---|---|---|
| 599 | `sleep(1500)` | Pre-poll cushion before `pollUntil(CHECK_LIST_READY)` — redundant; poll handles wait |
| 609 | `sleep(500)` | Post-list-ready screenshot cushion — `CHECK_LIST_READY` already confirmed rows exist |
| 679 | `sleep(2000)` | Post-`CHECK_DETAIL_READY` extra settle — poll already confirmed right-panel content |
| 748 | `sleep(800)` | Pre-poll cushion before `pollUntil(CHECK_ASSET_READY)` — same redundancy as line 599 |
| 751 | `sleep(400)` | Post-`CHECK_ASSET_READY` extra settle — poll already confirmed spinner cleared |

### Replacement — Read More adaptive poll

The `sleep(2500)` after the Read More click block (line 704) was replaced with a body-length delta poll:

```js
// S8: adaptive Read More settle — sample body length before poll
const _bodyBefore = await win.webContents.executeJavaScript(
  'document.body ? document.body.innerText.length : 0'
).catch(() => 0);
const _t0_rm = Date.now();
let _rmReady = false;
while (Date.now() - _t0_rm < UPTAKE_READ_MORE_WAIT_MS) {
  await sleep(UPTAKE_READ_MORE_POLL_MS);
  try {
    const _bodyNow = await win.webContents.executeJavaScript(
      'document.body ? document.body.innerText.length : 0'
    );
    if (_bodyNow > _bodyBefore + 100) { _rmReady = true; break; }
  } catch(_) {}
}
logger.info('[Uptake] Read More settle | waited:', (Date.now() - _t0_rm) + 'ms',
  '| signal:', _rmReady ? 'DOM' : 'timeout(3s)');
```

Fallback: if body never grows > 100 chars in 3s, `SCRAPE_AFTER_READMORE` runs as before.

### Added observability log

After `pollUntil(CHECK_ASSET_READY)` in the risk score pass:
```js
flog('[Uptake] Asset overview ready for', u.id, '| signal: DOM');
```

### Preserved (out of scope)

Auth phase sleeps at lines 794 (`sleep(1500)`) and 799 (`sleep(2500)`) — required for SSO button timing. Untouched.

---

## 3. Sanity Checks (8 new, 8/8 passed)

| ID | Check |
|---|---|
| S8-a | `UPTAKE_READ_MORE_WAIT_MS = 3_000` defined |
| S8-b | `UPTAKE_READ_MORE_POLL_MS = 300` defined |
| S8-c | Pre-poll `sleep(1500)` before insights list removed |
| S8-d | Post-list `sleep(500)` before screenshot removed |
| S8-e | Post-detail-ready `sleep(2000)` removed |
| S8-f | Fixed `sleep(2500)` after Read More removed |
| S8-g | Read More body-length poll loop present |
| S8-h | Pre-poll `sleep(800)` + post-poll `sleep(400)` in asset pass removed |

**Main suite: 524/524 — zero regressions.**

---

## 4. Timing Improvement

| Phase | Before | After |
|---|---|---|
| List page (one-time) | 2,000 ms fixed | 0 ms |
| Per-insight detail (× N insights) | 4,500 ms fixed | ~400–800 ms DOM |
| Per-asset overview (× M assets) | 1,200 ms fixed | 0 ms |
| **Example: 20 insights, 10 assets** | **~104,000 ms idle** | **~12,000 ms idle** |

---

## 5. Git Summary

| Commit | Description |
|---|---|
| `034fce5` | fix(scrapers): Stage 8 -- adaptive Read More settle + remove redundant sleeps (uptake.js) |

**Tag:** `scraper-resilience-stage8-complete` @ `034fce5`

---

*Completion record written 2026-06-28.*  
*Stages 5–8 complete. Total sanity checks from Stage 4 baseline: 430 → 524 (+94).*
