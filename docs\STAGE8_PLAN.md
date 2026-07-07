# Fleet Ops V-C · Stage 8 — Uptake Adaptive Settle: Plan

**Date:** 2026-06-28  
**Baseline:** Stage 7 complete — 516/516 sanity checks, tag `scraper-resilience-stage7-complete`  
**Scope:** `src/scrapers/uptake.js`

---

## 1. Background — Why This Was Deferred

Stage 6 introduced adaptive WO tab settle in `relay.js`, replacing a fixed `WO_TAB_SETTLE_MS = 4000` sleep with a DOM-signal poll. The same deferred item existed for `uptake.js`, but with a different justification for deprioritising it:

> *"`uptake.js` adaptive settle — uses `did-finish-load` + `PAGE_SETTLE_MS = 3000` — same pattern as relay; lower value, lower risk"*

After reading the full 893-line file, the actual picture is more complex and more worth fixing than the Stage 6 note implied. There is no single `PAGE_SETTLE_MS` constant. There are **six separate fixed sleeps** distributed across the scrape flow, each covering a different phase of the Uptake SPA's rendering lifecycle. Several of them are already partially guarded by DOM polls — but the polls complete and then a *further* fixed sleep runs before the actual scrape call is made, negating the poll's entire purpose.

---

## 2. Audit — All Fixed Sleeps in `uptake.js`

All line numbers are from the current file (`scraper-resilience-stage7-complete` state).

### Sleep inventory

| Line | Value | Context | Already polled before? | Problem |
|---|---|---|---|---|
| 599 | 1,500 ms | After `navTo(UPTAKE_INSIGHTS_URL)`, before `pollUntil(CHECK_LIST_READY)` | No — the poll comes *after* | Pre-poll cushion — inserted in case `did-finish-load` fires before the React table renders; actually redundant because `pollUntil(CHECK_LIST_READY)` already retries for up to 40s |
| 609 | 500 ms | After `pollUntil(CHECK_LIST_READY)` passes, before screenshot | Yes — `CHECK_LIST_READY` already confirmed table rows exist | Purely cosmetic wait; screenshot will capture the same content with or without it |
| 679 | 2,000 ms | After `pollUntil(CHECK_DETAIL_READY)` passes, before `SCRAPE_INSIGHT_DETAIL` | Yes — `CHECK_DETAIL_READY` confirmed body > 800 chars and at least one action section with > 30 chars text | **High value target.** The poll already confirmed the right-panel content is present; this 2s sleep is a belt-and-suspenders wait that fires for every insight page unconditionally |
| 704 | 2,500 ms | After clicking "Read More" / "Show More" buttons, before `SCRAPE_AFTER_READMORE` | No — no DOM signal for Read More expansion | **Medium value target.** The 2.5s wait is for React to re-render the expanded markdown; a DOM signal for body-text length growth can replace this |
| 748 | 800 ms | After `navTo(asset/{uuid})`, before `pollUntil(CHECK_ASSET_READY)` | No — poll comes *after* | Pre-poll cushion; same pattern as line 599 — redundant because `CHECK_ASSET_READY` already retries |
| 751 | 400 ms | After `pollUntil(CHECK_ASSET_READY)` passes, before `SCRAPE_ASSET_RISK` | Yes — `CHECK_ASSET_READY` confirmed spinner cleared and overview tab rendered | Same pattern as line 679 — the poll already did the work |

### Auth phase sleeps (out of scope)

Lines 794, 799 (both in the `did-finish-load` auth phase handler):
- 794: `sleep(1500)` before the first SSO button click — required; login page JavaScript needs to finish initialising before the button exists in the DOM
- 799: `sleep(2500)` before the SSO retry — required; gives the page time to respond before the retry

These are **not targets**. They guard against clicking before the DOM is ready during auth, where polling would require understanding the login page's React initialisation cycle. The current values are appropriate.

### Summary of target sleeps

| Sleep | Line | Fixed value | What replaces it | Saving (fast page) |
|---|---|---|---|---|
| Post-`navTo` insights list cushion | 599 | 1,500 ms | Remove (poll handles it) | 1,500 ms |
| Post-list-ready screenshot cushion | 609 | 500 ms | Remove (list already confirmed) | 500 ms |
| Post-detail-ready extra settle | 679 | 2,000 ms | Remove (poll already confirmed content) | 2,000 ms |
| Post-Read-More expansion | 704 | 2,500 ms | DOM poll for body-text growth | ~500–800 ms on fast render |
| Post-`navTo` asset overview cushion | 748 | 800 ms | Remove (poll handles it) | 800 ms |
| Post-asset-ready extra settle | 751 | 400 ms | Remove (poll already confirmed) | 400 ms |

**Total fixed sleep removed from the per-insight loop:** 2,500 ms (line 679) + 2,500 ms (line 704) = 5,000 ms per insight page.  
**Total fixed sleep removed from the per-asset loop:** 800 ms (line 748) + 400 ms (line 751) = 1,200 ms per asset overview.  
**Total one-time sleeps removed:** 1,500 ms (line 599) + 500 ms (line 609) = 2,000 ms.

---

## 3. DOM Signal Analysis

### 3.1 Lines 599, 748 — Pre-poll cushions

These sleeps exist purely to let the page start loading before the DOM poll begins. The `pollUntil()` helper already handles this: it runs up to `DOM_POLL_MAX = 50` iterations at `DOM_POLL_INTERVAL = 800ms` (40s budget). The first few ticks will return `false` while the page loads — that is the poll's intended behaviour. The pre-poll sleeps add latency on every call without adding safety.

**Fix:** Remove both sleeps. No DOM signal needed — the existing poll already provides the wait.

### 3.2 Lines 609, 751 — Post-poll-confirmation cushions

These sleeps fire *after* a DOM poll has already confirmed the content is present. Line 609 follows `pollUntil(CHECK_LIST_READY)` — which confirms `tbody tr` cells with anchor links exist. Line 751 follows `pollUntil(CHECK_ASSET_READY)` — which confirms spinner cleared AND the asset overview tab rendered. There is nothing the extra sleep adds; it is legacy belt-and-suspenders from before the polls were tightened.

**Fix:** Remove both sleeps.

### 3.3 Line 679 — Post-`CHECK_DETAIL_READY` extra settle

`CHECK_DETAIL_READY` (lines 383–397) is already a robust signal:

```js
var bodyLen = (document.body ? document.body.innerText : '').trim().length;
if (bodyLen < 800) return false;
var secs = Array.from(document.querySelectorAll('._insight-details__action_1ba7f_897'));
if (!secs.length) return false;
return secs.some(function(sec) {
  var el = sec.querySelector('._insight-details__markdown_1ba7f_902') ||
           sec.querySelector('._insight-details__value_1ba7f_942');
  return !!(el && (el.innerText || el.textContent || '').trim().length > 30);
});
```

This passes only when:
1. Body text > 800 characters
2. At least one `_insight-details__action` section exists
3. That section has a markdown or value element with > 30 characters of text

When this poll returns `true`, the right panel is fully rendered with actual content. The subsequent 2,000ms sleep adds no further safety — the `SCRAPE_INSIGHT_DETAIL` script reads from the same selectors that `CHECK_DETAIL_READY` already confirmed are populated.

**Fix:** Remove the sleep at line 679.

### 3.4 Line 704 — Post-Read-More expansion

This is the only sleep that cannot simply be removed. The "Read More" button click triggers a React state change that re-renders the markdown sections with expanded text. The current DOM after `pollUntil(CHECK_DETAIL_READY)` passed will have the *truncated* version of the markdown. After clicking "Read More", we need to wait for React to re-render.

`CHECK_DETAIL_READY` cannot be reused here — it would immediately return `true` again (the truncated text still satisfies the > 30 character threshold). We need a new signal: the body text length must *increase* after the click, indicating that expanded content has been rendered.

**New constant: `UPTAKE_POLL_READ_MORE_MS = 300`** (tick interval — slightly tighter than relay's 200ms because this is body-length delta detection, not text-presence detection)

**New constant: `UPTAKE_READ_MORE_WAIT_MS = 3000`** (deadline — same semantics as relay's `WO_TAB_MAX_WAIT_MS`: the existing 2500ms sleep becomes a poll deadline, with +500ms headroom)

**New script: `POLL_AFTER_READMORE`** — samples `body.innerText.length` before the click, then checks for growth > 100 characters after the click:

```js
// Called before the click to capture baseline length
const SAMPLE_BODY_LEN = `(document.body ? document.body.innerText.length : 0)`;

// Called in poll loop after click — returns true when body has grown
// Uses a closure variable set before the click: _bodyLenBefore
// We inject the baseline into the poll expression at call time (template literal)
```

Because `win.webContents.executeJavaScript` is a single-call boundary (no persistent variables between calls), the baseline body length is captured before the click in the outer JS context, then baked into the poll expression as a literal:

```js
const _bodyBefore = await win.webContents.executeJavaScript(
  `document.body ? document.body.innerText.length : 0`
);
// ... click Read More ...
// Poll loop:
const _pollExpr = `(document.body ? document.body.innerText.length : 0) > ${_bodyBefore + 100}`;
```

This is the same pattern as Phase 3 in `relay.js` (body growth check, lines 684–691 of the Stage 6 implementation).

**Fallback:** If the poll times out at `UPTAKE_READ_MORE_WAIT_MS`, `SCRAPE_AFTER_READMORE` runs anyway — identical to current behaviour. No regression if the expansion never increases body length by >100 characters (e.g. if the asset has no "Read More" buttons).

### 3.5 Line 748 — See §3.1 (pre-poll cushion)

---

## 4. Proposed Work — Stage 8

**One step. One file.**

### Step 1 — Remove redundant sleeps + adaptive Read More settle

**File:** `src/scrapers/uptake.js`  
**Commit message:** `fix(scrapers): Stage 8 -- adaptive Read More settle + remove redundant sleeps (uptake.js)`

#### Changes

**Add two new constants** after the existing `DOM_POLL_MAX` constant block (around line 48):

```js
const UPTAKE_READ_MORE_WAIT_MS = 3_000;   // S8: Read More expansion poll deadline (was 2500ms fixed sleep)
const UPTAKE_READ_MORE_POLL_MS = 300;     // S8: body-length delta poll tick interval
```

**Line 599 — remove** `await sleep(1500)` and its trailing newline. The `pollUntil(CHECK_LIST_READY)` immediately following already handles the wait.

**Line 609 — remove** `await sleep(500)`. The screenshot captures the same list that `CHECK_LIST_READY` already confirmed.

**Line 679 — remove** `await sleep(2000)`. `CHECK_DETAIL_READY` already confirmed the right panel is populated.

**Lines 704 — replace** fixed `await sleep(2500)` with body-length delta poll:

```js
// S8: adaptive Read More settle — poll until body grows (or 3s deadline)
const _bodyBefore = await win.webContents.executeJavaScript(
  `document.body ? document.body.innerText.length : 0`
).catch(() => 0);
// ... [existing Read More click block unchanged] ...
const _t0_rm = Date.now();
let _rmReady = false;
while (Date.now() - _t0_rm < UPTAKE_READ_MORE_WAIT_MS) {
  await sleep(UPTAKE_READ_MORE_POLL_MS);
  try {
    const _bodyNow = await win.webContents.executeJavaScript(
      `document.body ? document.body.innerText.length : 0`
    );
    if (_bodyNow > _bodyBefore + 100) { _rmReady = true; break; }
  } catch(_) {}
}
logger.info('[Uptake] Read More settle | waited:', (Date.now() - _t0_rm) + 'ms',
  '| signal:', _rmReady ? 'DOM' : 'timeout(3s)');
```

**Note on ordering:** The body length sample (`_bodyBefore`) must be captured *before* the Read More click block (lines 692–702), because the click is what triggers the growth we're detecting. The poll loop replaces the sleep at line 704, which currently comes *after* the click block. Existing structure is:

```
line 679: await sleep(2000)        ← REMOVE
line 680: SCRAPE_INSIGHT_DETAIL    ← unchanged
...
line 692-702: Read More click      ← unchanged
line 704: await sleep(2500)        ← REPLACE with poll
line 705: SCRAPE_AFTER_READMORE    ← unchanged
```

After Stage 8:

```
           [no sleep]
line 680: SCRAPE_INSIGHT_DETAIL    ← unchanged
           _bodyBefore sample      ← NEW (before click)
...
line 692-702: Read More click      ← unchanged
           poll loop               ← NEW (replaces sleep 704)
line 705: SCRAPE_AFTER_READMORE    ← unchanged
```

**Lines 748, 751 — remove** `await sleep(800)` and `await sleep(400)`. `pollUntil(CHECK_ASSET_READY)` already confirmed spinner cleared and tab rendered.

**Add settle log lines** for both the Read More poll (above) and the asset overview poll (for observability parity with relay):

After `pollUntil(CHECK_ASSET_READY)` (currently line 749), add:
```js
flog('[Uptake] Asset overview ready for', u.id,
  '| waited by poll | signal: DOM');
```

(The asset overview has no equivalent fixed sleep to replace with a timed log — the poll itself provides the wait, so we just log that it passed.)

---

## 5. Timing Improvement

### Per-insight-detail page (assuming `CHECK_DETAIL_READY` passes quickly and body grows after Read More)

| Phase | Before Stage 8 | After Stage 8 |
|---|---|---|
| Post-detail-poll extra settle | 2,000 ms (fixed) | 0 ms (removed) |
| Post-Read-More expansion | 2,500 ms (fixed) | ~400–800 ms (DOM signal at 300ms ticks) |
| Total per-insight | ~4,500 ms | ~400–800 ms |

### Per-asset-overview page (risk score pass)

| Phase | Before Stage 8 | After Stage 8 |
|---|---|---|
| Pre-poll cushion | 800 ms (fixed) | 0 ms (removed) |
| Post-poll extra settle | 400 ms (fixed) | 0 ms (removed) |
| Total per-asset | 1,200 ms | 0 ms (poll only) |

### One-time (list page)

| Phase | Before Stage 8 | After Stage 8 |
|---|---|---|
| Pre-poll cushion | 1,500 ms (fixed) | 0 ms (removed) |
| Post-list screenshot | 500 ms (fixed) | 0 ms (removed) |
| Total | 2,000 ms | 0 ms |

### Full sync estimate (example: 20 insights, 10 unique assets)

| | Before Stage 8 | After Stage 8 |
|---|---|---|
| List phase | ~2,000 ms | ~0 ms |
| Detail loop (20 insights × 4,500ms fixed) | ~90,000 ms | ~20 insights × ~600ms = ~12,000 ms |
| Asset pass (10 assets × 1,200ms fixed) | ~12,000 ms | ~0 ms (poll only) |
| **Total fixed idle** | **~104,000 ms (~1m 44s)** | **~12,000 ms (~12s)** |

These are idle-sleep savings only. Actual page load time, `waitForLoadQuiet`, and `pollUntil` durations are unchanged — they are already DOM-driven.

---

## 6. Sanity Checks — Stage 8

**Projected: +8 new checks → 524/524 in main suite**

| ID | Check | File |
|---|---|---|
| S8-a | `UPTAKE_READ_MORE_WAIT_MS = 3_000` constant defined | `uptake.js` |
| S8-b | `UPTAKE_READ_MORE_POLL_MS = 300` constant defined | `uptake.js` |
| S8-c | Pre-poll `sleep(1500)` before insights list removed | `uptake.js` |
| S8-d | Post-list `sleep(500)` before screenshot removed | `uptake.js` |
| S8-e | Post-detail-ready `sleep(2000)` removed | `uptake.js` |
| S8-f | Fixed `sleep(2500)` after Read More click removed | `uptake.js` |
| S8-g | Read More body-length poll loop present | `uptake.js` |
| S8-h | Pre-poll `sleep(800)` + post-poll `sleep(400)` in asset pass removed | `uptake.js` |

### Check implementation notes

- S8-c: assert `"await sleep(1500);\n\n        const listReady"` not in file (verifies the specific pre-poll sleep, not both 1500ms sleeps)
- S8-d: assert `"await sleep(500);\n        const listShot"` not in file
- S8-e: assert `"await sleep(2000); // extra settle"` not in file (comment makes this unambiguous)
- S8-f: assert `"await sleep(2500); // let React re-render"` not in file
- S8-g: assert `"while (Date.now() - _t0_rm < UPTAKE_READ_MORE_WAIT_MS)"` in file
- S8-h: assert `"await sleep(800);\n            const assetReady"` not in file AND `"await sleep(400);\n            const assetData"` not in file

---

## 7. Files Changed

| File | Changes |
|---|---|
| `src/scrapers/uptake.js` | `UPTAKE_READ_MORE_WAIT_MS`, `UPTAKE_READ_MORE_POLL_MS` constants; 5 sleep removals; Read More body-growth poll loop |
| `docs/STAGE8_PLAN.md` *(this file)* | — |

No other files change. All fixes are encapsulated in `uptake.js`.

---

## 8. Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| Removing pre-poll sleep (lines 599, 748) causes poll to start before page begins loading | Very low | `pollUntil` checks `win.isDestroyed()` on every tick and retries up to 50 times at 800ms intervals (40s budget); the first few ticks cover the load start window |
| `CHECK_DETAIL_READY` passes but right-panel content is not fully rendered for `SCRAPE_INSIGHT_DETAIL` | Low | `CHECK_DETAIL_READY` requires body > 800 chars AND an action section with > 30 chars content; this is a stronger signal than the 2s sleep was providing. First-insight diagnostic log remains enabled |
| Body growth > 100 chars never fires after Read More click (asset has no Read More buttons) | Accepted | Poll times out after 3s, `SCRAPE_AFTER_READMORE` runs as fallback — same as today. The scraper already handles the no-expansion case via `expanded.summary || detail.summary || ''` fallback chain |
| Remove `sleep(400)` post-asset-ready causes `SCRAPE_ASSET_RISK` to race against spinner re-appearing | Very low | `CHECK_ASSET_READY` explicitly checks `!!document.querySelector('[class*="loading"][class*="state"], [class*="spinner"]') === false` before returning true; no spinner re-appear is expected after that signal |

---

## 9. Out of Scope for Stage 8

| Item | Reason |
|---|---|
| Auth phase sleeps (lines 794, 799) | Required — protect against clicking SSO button before DOM is ready; not adaptable without login-page DOM research |
| `waitForLoadQuiet` debounce timing | Correct architectural approach for SPA navigation; the 1200ms quiet window is already well-tuned |
| `DOM_POLL_INTERVAL = 800` tick reduction | Would speed up list/detail/asset polls but requires testing against slow AAP+Uptake sessions; out of scope for a sleep-removal pass |
| Retry wrapping for Uptake insight pages | `withRetry` was applied to relay in Stage 5; Uptake insight pages are sequential single-window scrapes where a retry would require re-navigating — different risk profile, separate consideration |

---

*Document written 2026-06-28. Predecessor: STAGE7_COMPLETION.md.*
