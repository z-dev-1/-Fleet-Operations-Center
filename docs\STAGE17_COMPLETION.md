# Fleet Ops V-C — Stage 17 Completion Record

**Date:** 2026-06-29
**Commits:** `6c78da4` (wire) + `d2290bf` (checks)
**Tag:** `renderer-stage17-complete`
**Sanity suite:** all S17 checks pass within 914/914

---

## 1. What This Stage Was

Stage 17 in the as-built numbering is the **app.js + toolbar wiring pass for the
Vendors view** — connecting the already-built `vendors.js` module into the app
router and toolbar so it becomes reachable in production.

> Note on numbering: `STAGE9_PLAN.md` originally labelled this stage "Partner portal".
> During development the partner portal was folded into the vendor bridge + unit-detail
> workflow (Stages 23–25). Stage 17 was reassigned to wiring work in commit `6c78da4`.

---

## 2. What Was Wired

### `app.js` changes (commit `6c78da4`)

```js
import { init as initVendors } from './views/vendors.js';   // added
// ...
initVendors(viewsMount);                                      // boot call
// ...
const vendorsView = document.getElementById('view-vendors'); // element ref
// ...
if (vendorsView) vendorsView.style.display = to === 'vendors' ? 'flex' : 'none';
```

### `toolbar.js` changes (commit `6c78da4`)

```html
<button id="tb-vendors" class="toolbar__btn" title="Vendors">...</button>
```

```js
document.getElementById('tb-vendors').addEventListener('click', () => {
  bus.emit('ui:view-change', { from: 'fleet', to: 'vendors' });
});
```

---

## 3. Sanity Checks (S17) — 9 checks

| Check | Assertion |
|---|---|
| S17-1 | `app.js` imports `initVendors` + `vendors.js` path |
| S17-2 | `app.js` calls `initVendors(viewsMount)` |
| S17-3 | `app.js` grabs `view-vendors` element |
| S17-4 | `app.js` routes vendors in `ui:view-change` (`vendorsView.style.display`) |
| S17-5 | `vendors.js` exports `init()` |
| S17-6 | `vendors.js` listens on `fleet:data` |
| S17-7 | `vendors.js` listens on `ui:view-change` |
| S17-T1 | Toolbar has `tb-vendors` button |
| S17-T2 | Toolbar emits `view-change` to `vendors` |

All 9 pass. Added in commit `d2290bf` (sanity total at that point: 731).

---

## 4. Relationship to Stage 14

Stage 14 built and fully verified `vendors.js` as a standalone module.
Stage 17 is the integration step that makes it reachable from the running app.
Together they close the vendors feature end-to-end.

---

*Completion record written 2026-06-29.*
