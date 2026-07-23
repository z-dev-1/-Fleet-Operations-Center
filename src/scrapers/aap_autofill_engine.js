'use strict';
/**
 * aap_autofill_engine.js
 *
 * Browser-injectable autofill engine for AAP Create Work Request.
 * This file is loaded by ipc/scrapers.js via fs.readFileSync and injected
 * into the AAP BrowserWindow via webContents.executeJavaScript.
 *
 * It is NEVER require()'d — the 'use strict' + module.exports at the bottom
 * exist solely so node --check passes.  They are dead code when injected.
 *
 * Payload is injected by scrapers.js as window.__fleetAutofillPayload before
 * this engine runs.
 */

const CreateWRAutofill = {

         /**
          * loadPayload() — reads the work-request payload that ipc/scrapers.js
          * injected into window.__fleetAutofillPayload before executing this
          * script.  Returns null if no payload is present.
          */
         loadPayload() {
             try {
                 const raw = (typeof window !== 'undefined') && window.__fleetAutofillPayload;
                 if (!raw) { return null; }
                 return (typeof raw === 'string') ? JSON.parse(raw) : raw;
             } catch (e) {
                 console.error('[CreateWR Autofill] loadPayload error:', e.message);
             }
             return null;
         },

         /**
          * shouldRun() — returns true when a valid autofill payload is present.
          * Called by the injection wrapper before run().
          */
         shouldRun() {
             try {
                 const p = this.loadPayload();
                 return !!(p && p.unit);
             } catch (e) { return false; }
         },


         sleep(ms) { return new Promise(r => setTimeout(r, ms)); },

         log(msg) { console.log('[CreateWR Autofill] ' + msg); },

         // React-safe setter  -  fires input + change so React state updates
         setVal(el, value) {
             if (!el) return false;
             const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
             const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
             if (setter) setter.call(el, String(value || ''));
             else el.value = String(value || '');
             ['input', 'change'].forEach(t => {
                 try { el.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {}
             });
             return true;
         },

         // Full click chain  -  pointerdown  ->  mousedown  ->  mouseup  ->  click
         click(el) {
             if (!el) return false;
             try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
             ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(type => {
                 try {
                     el.dispatchEvent(type.startsWith('pointer')
                         ? new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1 })
                         : new MouseEvent(type, { bubbles: true, cancelable: true }));
                 } catch (e) {}
             });
             try { el.click(); el.focus(); } catch (e) {}
             return true;
         },

         waitFor(fn, maxMs = 8000, tickMs = 200) {
             const t0 = Date.now();
             return new Promise(resolve => {
                 const tick = () => {
                     let r = null;
                     try { r = fn(); } catch (e) {}
                     if (r) return resolve(r);
                     if (Date.now() - t0 >= maxMs) return resolve(null);
                     setTimeout(tick, tickMs);
                 };
                 tick();
             });
         },

         // All dropdowns on this form share the same option button pattern:
         // BUTTON[role="option"] with ariaLabel or inner text matching value
         async waitForOption(value, maxMs = 5000) {
             const target = String(value || '').trim().toUpperCase();
             return this.waitFor(() => {
                 // Check BUTTON[role="option"]  -  confirmed selector from recording
                 const btns = Array.from(document.querySelectorAll('BUTTON[role="option"]'));
                 const match = btns.find(b =>
                     (b.getAttribute('aria-label') || '').toUpperCase() === target ||
                     (b.innerText || b.textContent || '').trim().toUpperCase() === target ||
                     (b.innerText || b.textContent || '').trim().toUpperCase().includes(target) ||
                     target.includes((b.innerText || b.textContent || '').trim().toUpperCase())
                 );
                 if (match) return match;
                 // Fallback: any visible element with matching text
                 const all = Array.from(document.querySelectorAll('[role="option"], LI, [role="listitem"]'))
                     .filter(el => el.offsetParent);
                 return all.find(el =>
                     (el.innerText || el.textContent || '').trim().toUpperCase().includes(target)
                 ) || null;
             }, maxMs, 50); // 50ms polling  -  catch fast-appearing options
         },


         // Click a trigger element (DIV placeholder), wait for combobox INPUT, type value, wait for option, click it
         // triggerEl = DIV placeholder to click
         // value     = full option text to match
         // label     = log label
         // searchTerm = optional shorter string to TYPE into the input (defaults to value)
         async comboSelect(triggerEl, value, label, searchTerm) {
             const typeStr = String(searchTerm || value || '').trim();
             const matchStr = String(value || '').trim();

             this.log(label + ': clicking trigger');
             this.click(triggerEl);
             await this.sleep(500);

             // Wait for combobox input  -  prefer aria-expanded="true", fall back to any visible
             const input = await this.waitFor(() => {
                 const expanded = Array.from(document.querySelectorAll('INPUT[role="combobox"]'))
                     .find(i => i.getAttribute('aria-expanded') === 'true' && i.offsetParent);
                 if (expanded) return expanded;
                 return Array.from(document.querySelectorAll('INPUT[role="combobox"]'))
                     .find(i => i.offsetParent) || null;
             }, 4000, 100);

             if (!input) {
                 this.log(label + ': WARNING - combobox input not found');
                 return false;
             }

             this.log(label + ': typing search "' + typeStr + '"');
             try { input.focus(); } catch (e) {}
             await this.sleep(200);

             // Native value setter so React detects change
             try {
                 const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                 if (nativeSetter) nativeSetter.call(input, typeStr);
                 else input.value = typeStr;
             } catch (e) { input.value = typeStr; }

             ['input', 'change', 'keyup'].forEach(t => {
                 try { input.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {}
             });
             await this.sleep(800);

             // Find option matching the FULL value (not the search term)
             const option = await this.waitFor(() => {
                 const target = matchStr.toUpperCase();
                 const btns = Array.from(document.querySelectorAll('BUTTON[role="option"]'));
                 return btns.find(b =>
                     (b.getAttribute('aria-label') || '').toUpperCase() === target ||
                     (b.innerText || b.textContent || '').trim().toUpperCase() === target ||
                     (b.innerText || b.textContent || '').trim().toUpperCase().includes(target) ||
                     target.includes((b.innerText || b.textContent || '').trim().toUpperCase())
                 ) || null;
             }, 5000, 150);

             if (!option) {
                 this.log(label + ': WARNING - no option matched "' + matchStr + '"');
                 return false;
             }

             this.log(label + ': clicking "' + (option.getAttribute('aria-label') || (option.innerText || '').trim()) + '"');
             this.click(option);
             await this.sleep(300);
             return true;
         },



         // Wait for spinners to clear  -  fast polling, short initial delay
         async waitForLoad(maxMs = 6000) {
             await this.sleep(100);
             await this.waitFor(() => {
                 const spinners = document.querySelectorAll(
                     '[class*="spinner"], [class*="loading"], [class*="skeleton"], [class*="loader"], [aria-busy="true"]'
                 );
                 return Array.from(spinners).every(s => !s.offsetParent);
             }, maxMs, 80);
             await this.sleep(100);
         },

         // Click Next immediately when enabled  -  wait for next step anchor
         async nextStep(waitForSelector) {
             const btn = await this.waitFor(() => {
                 const b = Array.from(document.querySelectorAll('BUTTON')).find(b =>
                     /^next$/i.test((b.innerText || b.textContent || '').trim()) && b.offsetParent
                 );
                 if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return null;
                 return b;
             }, 8000, 80);
             if (!btn) { this.log('WARNING: Next not found/enabled'); return false; }
             this.click(btn);
             this.log(' ->  Next');
             if (waitForSelector) {
                 await this.waitFor(() => {
                     // support comma-separated selectors
                     return waitForSelector.split(',').map(s => s.trim()).reduce((found, sel) => {
                         return found || document.querySelector(sel);
                     }, null);
                 }, 5000, 80);
             } else {
                 await this.sleep(800);
             }
             return true;
         },


         // Click Next  -  wait for it to be enabled, click with native .click(), wait for next step
         async nextStep(waitForSelector) {
             const btn = await this.waitFor(() => {
                 const b = Array.from(document.querySelectorAll('BUTTON')).find(b =>
                     /^next$/i.test((b.innerText || b.textContent || '').trim()) && b.offsetParent
                 );
                 if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return null;
                 return b;
             }, 12000, 100);
             if (!btn) { this.log('WARNING: Next button not found or disabled'); return false; }
             // Native .click()  -  same method that works for radios
             btn.click();
             this.log(' ->  Next clicked');
             if (waitForSelector) {
                 await this.waitFor(() => {
                     return waitForSelector.split(',').map(s => s.trim()).reduce((found, sel) => {
                         return found || document.querySelector(sel);
                     }, null);
                 }, 6000, 80);
             } else {
                 await this.sleep(800);
             }
             return true;
         },



         async run() {
             const p = this.loadPayload();
             // BUG FIX (2026-07-16): run() previously never returned ANY
             // value -- every early-exit was a bare `return;` (implicit
             // undefined) and even a full successful run fell through to
             // undefined at the end. The IPC handler injecting this script
             // (src/ipc/scrapers.js's 'aap:autofill') resolves the whole
             // operation as soon as the window opens, WITHOUT waiting for
             // or checking this result -- see that file for the matching
             // fix. Combined, the user had ZERO way to know whether
             // autofill actually worked, partially worked, or completely
             // failed to find the equipment field (the most common
             // failure -- e.g. injected too early, before the real AAP
             // page finished loading past an auth redirect). This matches
             // "I click Open in AAP (autofill) and it does nothing but
             // open the link." Now returns a real {ok, message} result at
             // every exit point.
             if (!p || !p.unit) { this.log('No payload - aborting.'); return { ok: false, message: 'No autofill payload was provided (missing unit).' }; }
             this.log('Starting for unit: ' + p.unit);

             // STEP 1: Equipment ID  -  exact working script
             this.log('--- STEP 1 ---');

             // Step 1: Find combobox
             const equipInput = await this.waitFor(() => document.querySelector('input[role="combobox"]'), 10000, 80);
             if (!equipInput) { this.log('ERROR: Equipment combobox not found'); return { ok: false, message: 'Equipment ID field never appeared -- the AAP page likely had not finished loading (e.g. stuck on an auth redirect) when autofill started.' }; }

             equipInput.focus();
             equipInput.click();

             // Step 2: Type unit char by char at 80ms
             const equipSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
             const equipText = String(p.unit);
             for (let i = 1; i <= equipText.length; i++) {
                 equipSetter.call(equipInput, equipText.slice(0, i));
                 equipInput.dispatchEvent(new Event('input', { bubbles: true }));
                 await this.sleep(80);
             }
             this.log('Equipment ID: typed "' + equipText + '"');

             // Step 3: Wait for option by aria-label, fallback to text match
             const equipOpt = await this.waitFor(() =>
                 document.querySelector('[role="option"][aria-label="' + equipText + '"]') ||
                 Array.from(document.querySelectorAll('[role="option"]')).find(o => o.innerText.trim().includes(equipText)) ||
                 null
             , 10000, 80);

             if (equipOpt) {
                 await this.sleep(500);
                 equipOpt.click();
                 this.log('Equipment ID: selected "' + equipText + '"');
             } else {
                 this.log('ERROR: Equipment option not found for "' + equipText + '"'); return { ok: false, message: 'Typed unit "' + equipText + '" but AAP never showed a matching Equipment ID option.' };
             }

             // Wait for Next to be enabled  -  means unit data fully loaded
             await this.waitFor(() => {
                 const btns = Array.from(document.querySelectorAll('BUTTON'));
                 const next = btns.find(b => b.innerText.trim() === 'Next');
                 return (next && !next.disabled && next.getAttribute('aria-disabled') !== 'true') ? next : null;
             }, 12000, 150);
             await this.sleep(1000);

             // Click Next  -  retry up to 3 times if page doesn't change
             let equipNextClicked = false;
             for (let attempt = 0; attempt < 3; attempt++) {
                 const equipNextBtn = Array.from(document.querySelectorAll('BUTTON')).find(b => b.innerText.trim() === 'Next');
                 if (equipNextBtn && !equipNextBtn.disabled) {
                     equipNextBtn.click();
                     this.log(' ->  Next clicked (attempt ' + (attempt + 1) + ')');
                     equipNextClicked = true;
                     // Wait up to 2s for page to change  -  if combobox is still there, retry
                     const changed = await this.waitFor(() =>
                         !document.querySelector('INPUT[role="combobox"][placeholder="Enter value"]')
                     , 2000, 100).catch(() => false);
                     if (changed) break;
                     this.log('Next did not navigate  -  retrying...');
                     await this.sleep(500);
                 }
             }


             // SMART STEP DETECTOR  -  handles variable step order
             // After Equipment Next, detect what step we're on and handle it
             const detectAndHandleStep = async (stepName) => {
                 // Wait for any known step indicator to appear
                 await this.waitFor(() =>
                     document.querySelector('INPUT[type="radio"][name="answer"]') ||  // Location
                     document.querySelector('LABEL.css-rzgavw') ||                    // Asset Condition
                     document.querySelector('INPUT#wr-title')                         // Work Request Details
                 , 8000, 80);

                 // Check what's actually on screen
                 const onLocation = !!document.querySelector('INPUT[type="radio"][name="answer"]');
                 const onAssetCondition = Array.from(document.querySelectorAll('LABEL.css-rzgavw')).some(l => l.innerText.includes('Unsafe to Move'));
                 const onWorkDetails = !!document.querySelector('INPUT#wr-title');

                 this.log('Step detector: location=' + onLocation + ' assetCond=' + onAssetCondition + ' workDetails=' + onWorkDetails);

                 if (onAssetCondition) {
                     this.log('--- ASSET CONDITION ---');

                     // React fiber key confirmed on LABEL (__reactFiber$xxxx)
                     // DIV.css-fmqnxp is intermittent - do not rely on it
                     const doAssetClick = () => {
                         const labels = Array.from(document.querySelectorAll('LABEL.css-rzgavw'));
                         const unsafeLbl = labels.find(l => /unsafe/i.test(l.innerText || ''));
                         if (!unsafeLbl) { this.log('Asset Condition: WARNING - label not found'); return false; }

                         // Walk React fiber on the label to find onClick handler
                         const fiberKey = Object.keys(unsafeLbl).find(k => k.startsWith('__reactFiber$'));
                         if (fiberKey) {
                             let fiber = unsafeLbl[fiberKey];
                             // Walk up fiber tree to find onClick
                             while (fiber) {
                                 const props = fiber.memoizedProps || fiber.pendingProps;
                                 if (props && typeof props.onClick === 'function') {
                                     props.onClick({ target: unsafeLbl, currentTarget: unsafeLbl, type: 'click', bubbles: true, preventDefault: () => {}, stopPropagation: () => {} });
                                     this.log('Asset Condition: React fiber onClick called');
                                      // Set native checked + fire onChange via fiber on the input
                                      const inp = unsafeLbl.querySelector('INPUT[type="radio"]');
                                      if (inp) {
                                          const nativeCheckedSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set;
                                          try { if (nativeCheckedSetter) nativeCheckedSetter.call(inp, true); else inp.checked = true; } catch(e) { inp.checked = true; }
                                          const propsKey = Object.keys(inp).find(k => k.startsWith('__reactProps'));
                                          if (propsKey) {
                                              const pp = inp[propsKey];
                                              if (typeof pp.onChange === 'function') pp.onChange({ target: inp, currentTarget: inp, type: 'change', bubbles: true, preventDefault: () => {}, stopPropagation: () => {} });
                                              this.log('Asset Condition: __reactProps$ onChange called, checked=' + inp.checked);
                                          } else {
                                              const inpKey = Object.keys(inp).find(k => k.startsWith('__reactFiber$'));
                                              let inpFiber = inpKey ? inp[inpKey] : null;
                                              while (inpFiber) {
                                                  const ip = inpFiber.memoizedProps || inpFiber.pendingProps;
                                                  if (ip && typeof ip.onChange === 'function') { ip.onChange({ target: inp, currentTarget: inp, type: 'change', bubbles: true, preventDefault: () => {}, stopPropagation: () => {} }); break; }
                                                  inpFiber = inpFiber.return;
                                              }
                                          }
                                      }
                                      return true;
                                 }
                                 fiber = fiber.return;
                             }
                             this.log('Asset Condition: fiber found but no onClick - using __reactProps$ on input');
                         }

                         // Fallback: __reactProps$ directly on the input
                         const inp2 = unsafeLbl.querySelector('INPUT[type="radio"]');
                         if (inp2) {
                             const nativeCheckedSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set;
                             try { if (nativeCheckedSetter) nativeCheckedSetter.call(inp2, true); else inp2.checked = true; } catch(e) { inp2.checked = true; }
                             const propsKey2 = Object.keys(inp2).find(k => k.startsWith('__reactProps'));
                             if (propsKey2) {
                                 const pp2 = inp2[propsKey2];
                                 if (typeof pp2.onChange === 'function') pp2.onChange({ target: inp2, currentTarget: inp2, type: 'change', bubbles: true, preventDefault: () => {}, stopPropagation: () => {} });
                                 this.log('Asset Condition: fallback __reactProps$ onChange called, checked=' + inp2.checked);
                             } else {
                                 const inpKey2 = Object.keys(inp2).find(k => k.startsWith('__reactFiber$'));
                                 let f2 = inpKey2 ? inp2[inpKey2] : null;
                                 while (f2) {
                                     const ip2 = f2.memoizedProps || f2.pendingProps;
                                     if (ip2 && typeof ip2.onChange === 'function') { ip2.onChange({ target: inp2, currentTarget: inp2, type: 'change', bubbles: true, preventDefault: () => {}, stopPropagation: () => {} }); break; }
                                     f2 = f2.return;
                                 }
                             }
                         }
                         return true;
                     };

                      // Retry until the radio is actually checked
                      // M-5: light exponential backoff — 500ms base + 100ms per attempt
                      // prevents tight busy-loop on slow pages (was fixed 500ms every try)
                      // BUG FIX (2026-07-23): this loop only retried the RADIO
                      // click, then called nextStep() unconditionally and reported
                      // 'assetCondition' handled regardless of whether Next actually
                      // advanced the page. If the radio never got picked up (React
                      // fiber walk failing because the component wasn't fully
                      // hydrated yet on first attempt), the Next button on this step
                      // stays disabled, nextStep() times out and returns false, and
                      // we'd still tell the caller assetCondition succeeded -- so it
                      // waited for a Location page that never came and the whole run
                      // silently died right there. This is exactly the "fails once,
                      // works if you start over" symptom: a fresh page load gives the
                      // React tree a clean mount with no race. Fix: verify the radio
                      // is checked AND that nextStep() actually advanced (page no
                      // longer shows the Asset Condition label) before declaring this
                      // step handled; otherwise retry the full click+Next cycle up to
                      // 3 times before giving up with an honest failure.
                      let advanced = false;
                      for (let cycle = 1; cycle <= 3 && !advanced; cycle++) {
                          let checked = false;
                          for (let attempt = 1; attempt <= 5; attempt++) {
                              doAssetClick();
                              this.log('Asset Condition: cycle ' + cycle + ' attempt ' + attempt);
                              await this.sleep(500 + attempt * 100);
                              const unsafeLbl = Array.from(document.querySelectorAll('LABEL.css-rzgavw')).find(l => /unsafe/i.test(l.innerText || ''));
                              const unsafeInp = unsafeLbl ? unsafeLbl.querySelector('INPUT[type="radio"]') : null;
                              if (unsafeInp && unsafeInp.checked) {
                                  this.log('Asset Condition: radio confirmed checked on cycle ' + cycle + ' attempt ' + attempt);
                                  checked = true;
                                  break;
                              }
                              if (attempt < 5) this.log('Asset Condition: not checked yet, retrying...');
                          }
                          if (!checked) { this.log('Asset Condition: radio never confirmed checked this cycle -- retrying cycle'); continue; }
                          await this.sleep(300);
                          const nextOk = await this.nextStep();
                          const stillOnAssetCondition = Array.from(document.querySelectorAll('LABEL.css-rzgavw')).some(l => /unsafe/i.test(l.innerText || ''));
                          if (nextOk && !stillOnAssetCondition) {
                              advanced = true;
                          } else {
                              this.log('Asset Condition: Next did not advance the page (nextOk=' + nextOk + ') -- retrying cycle');
                          }
                      }
                      if (!advanced) {
                          this.log('Asset Condition: FAILED to advance after 3 full cycles');
                          return 'assetConditionFailed';
                      }
                      return 'assetCondition';
                  }




                 if (onLocation) {
                     return 'location'; // caller handles location
                 }

                 if (onWorkDetails) {
                     return 'workDetails'; // skipped location somehow
                 }

                 return 'unknown';
             };

             const stepAfterEquipment = await detectAndHandleStep('post-equipment');
             this.log('After equipment next: detected "' + stepAfterEquipment + '"');

             // BUG FIX (2026-07-23): propagate an honest failure instead of
             // silently falling through to Location/Work Details steps that
             // don't exist yet -- see detectAndHandleStep's Asset Condition
             // branch above.
             if (stepAfterEquipment === 'assetConditionFailed') {
                 return { ok: false, message: 'Stuck on Asset Condition step -- could not confirm the "Unsafe to Move" selection or advance past it after 3 attempts. Try again, or finish this WR manually in the AAP window.' };
             }

             // If Asset Condition was handled, now wait for Location
             if (stepAfterEquipment === 'assetCondition') {
                 await this.waitFor(() => document.querySelector('INPUT[type="radio"][name="answer"]'), 8000, 80);
             }


             // STEP 2: Location  -  exact working script, location from payload
             this.log('--- STEP 2 ---');

             // Step 1: Click Off Site by label text
             const radios2 = document.querySelectorAll('input[type="radio"][name="answer"]');
             for (const radio of radios2) {
                 const label = radio.closest('label') || radio.parentElement;
                 if (label && label.innerText.trim().toLowerCase().includes('off site')) {
                     radio.click();
                     this.log('OFFSITE: clicked');
                     break;
                 }
             }

             // GeoFence combobox  -  recorder confirms class css-cmvgon
             const geofenceInput = await this.waitFor(() =>
                 document.querySelector('INPUT.css-cmvgon[role="combobox"]') ||
                 document.querySelector('INPUT.css-cmvgon')
             , 5000, 80);

             if (geofenceInput) {
                 geofenceInput.focus();
                 geofenceInput.click();
                 const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                 const text = String(p.location || p.domicile || '').trim();
                 for (let i = 1; i <= text.length; i++) {
                     setter.call(geofenceInput, text.slice(0, i));
                     geofenceInput.dispatchEvent(new Event('input', { bubbles: true }));
                     await this.sleep(50);
                 }

                 // Wait for options then click exact match
                 const optFound = await this.waitFor(() => {
                     const opts = Array.from(document.querySelectorAll('BUTTON[role="option"]'));
                     return opts.find(o => o.innerText.trim().toUpperCase() === text.toUpperCase()) || opts.find(o => o.innerText.trim().toUpperCase().includes(text.toUpperCase())) || null;
                 }, 5000, 80);

                 if (optFound) {
                     optFound.click();
                     this.log('GeoFence: clicked "' + optFound.innerText.trim() + '"');
                     // Immediately re-click OFFSITE  -  React resets radio when option is selected
                     const radiosNow = document.querySelectorAll('input[type="radio"][name="answer"]');
                     for (const radio of radiosNow) {
                         const label = radio.closest('label') || radio.parentElement;
                         if (label && label.innerText.trim().toLowerCase().includes('off site')) {
                             radio.click();
                             this.log('OFFSITE: re-clicked immediately after GeoFence');
                             break;
                         }
                     }
                 } else {
                     this.log('GeoFence: WARNING option not found for "' + text + '"');
                 }
             } else {
                 this.log('GeoFence: WARNING combobox not found');
             }

             // Wait then Next
             const radiosReassert = document.querySelectorAll('input[type="radio"][name="answer"]');
             for (const radio of radiosReassert) {
                 const label = radio.closest('label') || radio.parentElement;
                 if (label && label.innerText.trim().toLowerCase().includes('off site')) {
                     radio.click();
                     this.log('OFFSITE: re-clicked after GeoFence');
                     break;
                 }
             }
             // Wait for Next button to become enabled  -  location data fully loaded
             await this.waitFor(() => {
                 const btns = Array.from(document.querySelectorAll('BUTTON'));
                 const next = btns.find(b => b.innerText.trim() === 'Next');
                 return (next && !next.disabled && next.getAttribute('aria-disabled') !== 'true') ? next : null;
             }, 8000, 150);
             await this.sleep(300);

             // Click Next
             const nextBtns = document.querySelectorAll('button');
             for (const btn of nextBtns) {
                 if (btn.innerText.trim().toLowerCase() === 'next') {
                     btn.click();
                     this.log(' ->  Next clicked');
                     break;
                 }
             }
             await this.waitFor(() => document.querySelector('INPUT#wr-title'), 6000, 80);







             // STEP 3: Work Request Details
             this.log('--- STEP 3 ---');

             // 1. Urgent radio
             if (p.urgent === 'Yes') {
                 const urgentYes = await this.waitFor(() => {
                     const r = document.querySelector('INPUT[type="radio"][value="true"]');
                     return (r && r.name !== 'answer' && r.offsetParent) ? r : null;
                 }, 3000);
                 if (urgentYes) {
                     urgentYes.click();
                     await this.sleep(300);
                     // 2. Urgency reason dropdown
                     const reasonTrigger = await this.waitFor(() => {
                         const label = Array.from(document.querySelectorAll('LABEL')).find(l => /urgency reason/i.test((l.innerText || '').trim()));
                         if (!label) return null;
                         const parent = label.closest('DIV');
                         return parent ? parent.querySelector('DIV[class*="css-"]') || parent.nextElementSibling : null;
                     }, 4000);
                     const reasonValue = p.urgencyReason || 'DEA - Asset Shortage';
                      if (reasonTrigger) {
                          this.log('Urgency reason: trigger found, clicking');
                          this.click(reasonTrigger);
                          const reasonOpt = await this.waitForOption(reasonValue, 5000);
                          this.log('Urgency reason: option found=' + !!reasonOpt);
                          if (reasonOpt) {
                              this.click(reasonOpt);
                              // Wait for dropdown to close - options disappear
                              await this.waitFor(() => {
                                  const openOpts = Array.from(document.querySelectorAll('BUTTON[role="option"]')).filter(b => b.offsetParent);
                                  return openOpts.length === 0 ? true : null;
                              }, 3000, 80);
                              // Wait for the selected value text to appear in the DOM (confirms React committed it)
                              await this.waitFor(() => {
                                  const body = document.body.innerText || '';
                                  return body.includes(reasonValue) ? true : null;
                              }, 3000, 100);
                              this.log('Urgency reason: value confirmed in DOM');
                              await this.sleep(400);
                          } else {
                              this.log('Urgency reason: WARNING - option not found for "' + reasonValue + '"');
                          }
                      } else {
                          this.log('Urgency reason: WARNING - trigger not found');
                      }
                  }
             } else {
                 const urgentNo = await this.waitFor(() => {
                     const r = document.querySelector('INPUT[type="radio"][value="false"]');
                     return (r && r.name !== 'answer' && r.offsetParent) ? r : null;
                 }, 2000);
                  if (urgentNo) { urgentNo.click(); await this.sleep(300); }
              }
              // Wait for React to finish re-rendering after radio click
              // (DevTools open masks this naturally - without it we're too fast)
              // Fill title - same proven pattern as working script
              const ti = await this.waitFor(() => document.querySelector('INPUT#wr-title'), 6000);
              if (ti) {
                  this.click(ti);
                  await this.sleep(100);
                  try { ti.focus(); } catch (e) {}
                  const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                  try { if (ns) ns.call(ti, ''); else ti.value = ''; ti.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
                  try { if (ns) ns.call(ti, String(p.title)); else ti.value = String(p.title); } catch (e) { ti.value = String(p.title); }
                  ['input', 'change', 'keyup'].forEach(t => { try { ti.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {} });
                  await this.sleep(150);
                  try { ti.dispatchEvent(new FocusEvent('blur', { bubbles: true })); ti.blur(); } catch (e) {}
                  const neutralEl = document.querySelector('H1,H2,H3') || document.body;
                  try { neutralEl.click(); } catch (e) {}
                  await this.sleep(150);
                  this.log('Title: "' + ti.value + '"');
                  // Click Next
                  const titleNextBtn = document.querySelector('button.css-mnocv9')
                      || Array.from(document.querySelectorAll('BUTTON')).find(b =>
                          /^next$/i.test((b.innerText || b.textContent || '').trim()) && b.offsetParent
                      );
                  if (titleNextBtn) {
                      titleNextBtn.click();
                      this.log('Title: Next clicked');
                      await this.waitFor(() => document.querySelector('TEXTAREA#my-input'), 6000, 80);
                  } else {
                      this.log('Title: WARNING - Next button not found');
                  }
              } else {
                  this.log('Title: ERROR - input not found after 6s');
              }

             // STEP 4: Issue Details
             this.log('--- STEP 4 ---');
             const issueTA = await this.waitFor(() =>
                 document.querySelector('TEXTAREA#my-input') ||
                 Array.from(document.querySelectorAll('TEXTAREA')).find(t => /accident|dented|issue/i.test(t.placeholder || '') && t.offsetParent)
             , 6000);
             if (issueTA) { this.setVal(issueTA, p.issue || ''); await this.sleep(150); }

             // Area of Concern
             try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) {}

             if (p.areaPairs && p.areaPairs.length) {
                 const totalRows = p.areaPairs.filter(pair => pair.area).length;

                 // Phase 1: click + (totalRows-1) times, wait for each new row
                 if (totalRows > 1) {
                     for (let r = 0; r < totalRows - 1; r++) {
                         const currentCount = Array.from(document.querySelectorAll('INPUT[role="combobox"][placeholder="Enter a value..."]')).filter(el => el.offsetParent).length;
                         const addBtn = document.querySelector('BUTTON.css-1sm4msn') ||
                             Array.from(document.querySelectorAll('BUTTON')).find(b => b.offsetParent && b.querySelector('svg') && !(b.innerText || '').trim());
                         if (addBtn) {
                             addBtn.click();
                             await this.waitFor(() => {
                                 const now = Array.from(document.querySelectorAll('INPUT[role="combobox"][placeholder="Enter a value..."]')).filter(el => el.offsetParent).length;
                                 return now > currentCount ? true : null;
                             }, 3000, 80);
                             await this.sleep(100);
                         }
                     }
                 }

                  // Phase 2: fill all rows
                  // BUG FIX (2026-07-23): previously used a fixed "2 inputs per row"
                  // offset (allInputs[i*2], allInputs[i*2+1]) to locate each row's
                  // Work Area / Subcategory comboboxes. That's true for every area
                  // EXCEPT Tires, which reveals a 3rd combobox (Tire Size) in the same
                  // row. The fixed i*2 math silently mistargeted inputs on Tires rows
                  // and threw off the offset for every row after it. Now we track a
                  // running inputOffset that advances by 2 or 3 depending on whether
                  // the row we just filled was Tires.
                  let inputOffset = 0;
                  for (let i = 0; i < totalRows; i++) {
                      const pair = p.areaPairs[i];
                      if (!pair.area) continue;
                      this.log('Area pair [' + i + ']: ' + pair.area + ' / ' + pair.subcategory);
                      const isTires = /^tires$/i.test(pair.area.trim());

                      const allInputs = Array.from(document.querySelectorAll('INPUT[role="combobox"][placeholder="Enter a value..."]')).filter(el => el.offsetParent);
                      const workInput = allInputs[inputOffset] || null;
                      if (workInput) {
                          try { workInput.focus(); } catch (e) {}
                          const ws = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                          const workSearch = pair.area.toLowerCase();
                          try { if (ws) ws.call(workInput, workSearch); else workInput.value = workSearch; } catch (e) { workInput.value = workSearch; }
                          ['input', 'change', 'keyup'].forEach(t => { try { workInput.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {} });
                          // Exact match first, then includes  -  prevents "engine" matching "Check Engine Light"
                          const workOpt = await this.waitFor(() => {
                              const btns = Array.from(document.querySelectorAll('BUTTON[role="option"]'));
                              const target = pair.area.toUpperCase();
                              return btns.find(b => (b.getAttribute('aria-label') || b.innerText || '').trim().toUpperCase() === target)
                                  || btns.find(b => (b.getAttribute('aria-label') || b.innerText || '').trim().toUpperCase().includes(target))
                                  || null;
                          }, 4000, 80);
                          if (workOpt) {
                              this.click(workOpt);
                              this.log('Work Area [' + i + ']: clicked "' + (workOpt.innerText || '').trim() + '"');
                              // Wait for sub dropdown to be ready after work area loads subcategories.
                              // Tires and every other area both reveal exactly ONE new generic
                              // "Enter a value..." combobox at this point (Position for Tires,
                              // Subcategory for everything else) -- Tire Size only appears later,
                              // after Position itself is selected.
                              await this.waitFor(() => {
                                  const ins = Array.from(document.querySelectorAll('INPUT[role="combobox"][placeholder="Enter a value..."]')).filter(el => el.offsetParent);
                                  return ins.length > inputOffset + 1 ? true : null;
                              }, 3000, 80);
                              await this.sleep(300);
                          } else { this.log('Work Area [' + i + ']: no match for "' + pair.area + '"'); }
                      }

                      // BUG FIX (2026-07-23, take 4): Tire Position lives at the SAME flat
                      // index as every other area's Subcategory (inputOffset + 1) -- confirmed
                      // via live DOM dump, its placeholder is the generic "Enter a value..."
                      // just like every other field, NOT a distinct string as earlier guessed.
                      // The real reason "Steer Left" never matched before is that this app's
                      // option lists aren't always rendered as BUTTON[role="option"] -- some
                      // (like this one) use LI/[role="listitem"] instead, same as the existing
                      // waitForOption() helper already has to handle elsewhere in this file.
                      if (isTires) {
                          if (pair.subcategory) {
                              const allInputsPos = Array.from(document.querySelectorAll('INPUT[role="combobox"][placeholder="Enter a value..."]')).filter(el => el.offsetParent);
                              const posInput = allInputsPos[inputOffset + 1] || null;
                              if (posInput) {
                                  // DIAGNOSTIC (2026-07-23, round 2): click for real (not just focus)
                                  // and dump the DEFAULT/untyped option list BEFORE typing anything --
                                  // three guesses about what happens after typing have all been wrong,
                                  // so capture ground truth on the natural state first.
                                  this.click(posInput);
                                  await this.sleep(400);
                                  try {
                                      const listboxId0 = posInput.getAttribute('aria-controls');
                                      const listboxEl0 = listboxId0 ? document.getElementById(listboxId0) : null;
                                      const anyOpts0 = Array.from(document.querySelectorAll('[role="option"], LI, [role="listitem"], BUTTON')).filter(el => el.offsetParent);
                                      this.log('TIRES DIAG [' + i + ']: BEFORE typing -- aria-expanded=' + posInput.getAttribute('aria-expanded') + ' aria-controls=' + listboxId0 + ' listboxFound=' + !!listboxEl0 + ' listboxHTML=' + (listboxEl0 ? listboxEl0.outerHTML.slice(0, 500) : 'n/a') + ' visibleOptionLikeCount=' + anyOpts0.length + ' sample=' + anyOpts0.slice(0, 8).map(el => '[' + el.tagName + ':' + (el.getAttribute('role')||'') + ':' + (el.innerText||'').trim().slice(0,20) + ']').join(''));
                                  } catch (e) { this.log('TIRES DIAG [' + i + ']: pre-type dump failed: ' + e.message); }

                                  try { posInput.focus(); } catch (e) {}
                                  const ps = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                                  const posSearch = pair.subcategory.toLowerCase();
                                  try { if (ps) ps.call(posInput, posSearch); else posInput.value = posSearch; } catch (e) { posInput.value = posSearch; }
                                  ['input', 'change', 'keyup'].forEach(t => { try { posInput.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {} });
                                  const posOpt = await this.waitForOption(pair.subcategory, 4000);
                                  if (posOpt) { this.click(posOpt); this.log('Tire Position [' + i + ']: clicked "' + (posOpt.innerText || '').trim() + '"'); await this.sleep(300); }
                                  else {
                                      this.log('Tire Position [' + i + ']: no match for "' + pair.subcategory + '"');
                                      // One more diagnostic in case this guess (LI/[role=listitem] fallback)
                                      // is STILL wrong -- capture exactly what the widget's own listbox
                                      // container holds AFTER typing too, for comparison against the
                                      // BEFORE-typing dump above.
                                      try {
                                          const listboxId = posInput.getAttribute('aria-controls');
                                          const listboxEl = listboxId ? document.getElementById(listboxId) : null;
                                          this.log('TIRES DIAG [' + i + ']: AFTER typing -- listbox #' + listboxId + ' -> ' + (listboxEl ? listboxEl.outerHTML.slice(0, 600) : '(not found)'));
                                      } catch (e) {}
                                  }
                              } else { this.log('Tire Position [' + i + ']: input not found'); }
                          }

                          // TIRE SIZE -- appears as a 3rd generic combobox only after Position is
                          // selected (same reveal-after-select pattern as Subcategory). Always
                          // takes its first/default option per confirmed live guidance
                          // (aap_wizard_knowledge.js) -- no typing needed.
                          const sizeInput = await this.waitFor(() => {
                              const ins = Array.from(document.querySelectorAll('INPUT[role="combobox"][placeholder="Enter a value..."]')).filter(el => el.offsetParent);
                              return ins[inputOffset + 2] || null;
                          }, 3000, 80);
                          if (sizeInput) {
                              try { sizeInput.focus(); } catch (e) {}
                              ['mousedown', 'focus', 'click'].forEach(t => { try { sizeInput.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {} });
                              const sizeOpt = await this.waitFor(() => {
                                  const btns = Array.from(document.querySelectorAll('[role="option"], LI, [role="listitem"]')).filter(b => b.offsetParent);
                                  return btns[0] || null;
                              }, 3000, 80);
                              if (sizeOpt) { this.click(sizeOpt); this.log('Tire Size [' + i + ']: clicked default "' + (sizeOpt.innerText || '').trim() + '"'); await this.sleep(300); }
                              else { this.log('Tire Size [' + i + ']: dropdown did not open'); }
                          } else { this.log('Tire Size [' + i + ']: 3rd combobox not found'); }
                      } else if (pair.subcategory) {
                          const allInputs2 = Array.from(document.querySelectorAll('INPUT[role="combobox"][placeholder="Enter a value..."]')).filter(el => el.offsetParent);
                          const subInput = allInputs2[inputOffset + 1] || null;
                          if (subInput) {
                              try { subInput.focus(); } catch (e) {}
                              const ss = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                              const subSearch = pair.subcategory.toLowerCase();
                              try { if (ss) ss.call(subInput, subSearch); else subInput.value = subSearch; } catch (e) { subInput.value = subSearch; }
                              ['input', 'change', 'keyup'].forEach(t => { try { subInput.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {} });
                              // Exact match first
                              const subOpt = await this.waitFor(() => {
                                  const btns = Array.from(document.querySelectorAll('BUTTON[role="option"]'));
                                  const target = pair.subcategory.toUpperCase();
                                  return btns.find(b => (b.getAttribute('aria-label') || b.innerText || '').trim().toUpperCase() === target)
                                      || btns.find(b => (b.getAttribute('aria-label') || b.innerText || '').trim().toUpperCase().includes(target))
                                      || null;
                              }, 4000, 80);
                              if (subOpt) { this.click(subOpt); this.log('Sub Area [' + i + ']: clicked "' + (subOpt.innerText || '').trim() + '"'); await this.sleep(300); }
                              else { this.log('Sub Area [' + i + ']: no match for "' + pair.subcategory + '"'); }
                          } else { this.log('Sub Area [' + i + ']: input not found'); }
                      }

                      // Tires rows end up with 3 generic "Enter a value..." comboboxes over
                      // their lifecycle (Work Area, Position, Size -- Size reveals only after
                      // Position is picked); every other area only ever has 2 (Work Area,
                      // Subcategory). Advance the running offset accordingly for the next row.
                      inputOffset += isTires ? 3 : 2;
                  }
             }

             // TOW DETAILS HANDLER
             // ORDER: Off Site → Transload No → Street/City/State/Zip → GeoFence (if no address)
             const hasTow = p.areaPairs && p.areaPairs.some(pair => /^tow$/i.test((pair.area || '').trim()));
             if (hasTow) {
                 this.log('TOW detected  -  handling Towing Details panel');
                 await this.sleep(800);

                  // STEP A: Click "Off Site (Address)" radio
                  // Radios on this page are NOT wrapped in <label> - text is in adjacent span/div
                  const clickOffSite = async () => {
                      // Strategy 1: find by adjacent text node / sibling span
                      const allRadios = Array.from(document.querySelectorAll('INPUT[type="radio"]')).filter(r => r.offsetParent);
                      const r = allRadios.find(r => {
                          // Check label wrapper
                          const lbl = r.closest('label');
                          if (lbl && /off.?site/i.test(lbl.innerText || lbl.textContent || '')) return true;
                          // Check parent element text
                          const parent = r.parentElement;
                          if (parent && /off.?site/i.test(parent.innerText || parent.textContent || '')) return true;
                          // Check next sibling
                          const sib = r.nextElementSibling || r.nextSibling;
                          if (sib && /off.?site/i.test(sib.textContent || '')) return true;
                          // Check parent's parent
                          const gp = parent && parent.parentElement;
                          if (gp && /off.?site/i.test(gp.innerText || '')) return true;
                          return false;
                      });
                      if (!r) return false;
                      // Use __reactProps$ to fire onChange (same pattern as asset condition radio)
                      const pk = Object.keys(r).find(k => k.startsWith('__reactProps'));
                      if (pk && r[pk] && r[pk].onChange) {
                          const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
                          if (ns) ns.call(r, true);
                          r[pk].onChange({ target: r, currentTarget: r, type: 'change', bubbles: true, preventDefault: () => {}, stopPropagation: () => {} });
                      } else {
                          r.click();
                      }
                      return true;
                  };
                  const offSiteOk = await this.waitFor(clickOffSite, 5000, 100);
                  if (offSiteOk) this.log('TOW: Off Site clicked');
                  else this.log('TOW: WARNING - Off Site radio not found');
                  await this.sleep(400);

                  // STEP B: Transload Required = No
                  // Walk up to a container that includes "Transload" label text, then find No radio inside
                  const transloadNo = await this.waitFor(() => {
                      const allRadios = Array.from(document.querySelectorAll('INPUT[type="radio"]')).filter(r => r.offsetParent);
                      return allRadios.find(r => {
                          // Walk up DOM to find a section that contains "transload" text
                          let el = r.parentElement;
                          for (let i = 0; i < 6; i++) {
                              if (!el) break;
                              const txt = el.innerText || el.textContent || '';
                              if (/transload/i.test(txt)) {
                                  // Found a transload section — check if this radio is the "No" one
                                  const radioLabel = r.nextElementSibling?.textContent || r.closest('label')?.innerText || '';
                                  const isNo = /\bno\b/i.test(radioLabel) || r.value === 'false' || r.value === 'No';
                                  return isNo;
                              }
                              el = el.parentElement;
                          }
                          return false;
                      }) || null;
                  }, 4000, 80);
                  if (transloadNo) {
                      const pk = Object.keys(transloadNo).find(k => k.startsWith('__reactProps'));
                      if (pk && transloadNo[pk] && transloadNo[pk].onChange) {
                          const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
                          if (ns) ns.call(transloadNo, true);
                          transloadNo[pk].onChange({ target: transloadNo, currentTarget: transloadNo, type: 'change', bubbles: true, preventDefault: () => {}, stopPropagation: () => {} });
                      } else {
                          transloadNo.click();
                      }
                      this.log('TOW: Transload = No');
                  } else { this.log('TOW: WARNING - Transload No radio not found'); }
                  await this.sleep(400);

                  // STEP C: Fill Street/City/State/Zip
                  // Use working native setter + dispatchEvent pattern (same as title field)
                  const fillTowField = async (id, labelHint, value) => {
                      if (!value) return;
                      const el = await this.waitFor(() => {
                          // Try by ID first
                          const byId = document.querySelector('INPUT#' + id);
                          if (byId && byId.offsetParent) return byId;
                          // Try by name
                          const byName = document.querySelector('INPUT[name="' + id + '"]');
                          if (byName && byName.offsetParent) return byName;
                          // Try by placeholder containing hint
                          const byPh = Array.from(document.querySelectorAll('INPUT[type="text"], INPUT:not([type])')).find(i =>
                              i.offsetParent && (i.placeholder || '').toLowerCase().includes(labelHint.toLowerCase())
                          );
                          if (byPh) return byPh;
                          // Try by label text
                          const labels = Array.from(document.querySelectorAll('LABEL'));
                          const lbl = labels.find(l => new RegExp(labelHint, 'i').test(l.innerText || l.textContent || ''));
                          if (lbl) {
                              const inp = lbl.control || document.querySelector('INPUT#' + (lbl.htmlFor || ''));
                              if (inp && inp.offsetParent) return inp;
                          }
                          return null;
                      }, 5000, 80);
                      if (!el) { this.log('TOW: WARNING - ' + id + ' field not found'); return; }

                      // Working pattern: click, focus, native setter clear, native setter set, dispatch events
                      el.click();
                      await this.sleep(50);
                      try { el.focus(); } catch (e) {}
                      const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                      try { if (ns) ns.call(el, ''); else el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
                      try { if (ns) ns.call(el, String(value)); else el.value = String(value); } catch (e) { el.value = String(value); }
                      ['input', 'change', 'keyup'].forEach(t => { try { el.dispatchEvent(new Event(t, { bubbles: true })); } catch (e) {} });
                      await this.sleep(80);
                      try { el.dispatchEvent(new FocusEvent('blur', { bubbles: true })); el.blur(); } catch (e) {}
                      await this.sleep(50);
                      this.log('TOW: ' + id + ' = "' + el.value + '"');
                  };
                  await fillTowField('street', 'street',  p.towStreet || '');
                  await fillTowField('city',   'city',    p.towCity   || '');
                  await fillTowField('state',  'state',   p.towState  || '');
                  await this.sleep(300);
                  await fillTowField('zip',    'zip',     p.towZip    || '');
                  // Blur zip to commit - click somewhere neutral
                  document.body.click();
                  await this.sleep(500);


                 // STEP D: GeoFence  -  ONLY if no address fields provided
                 const hasAddress = !!(p.towStreet || p.towCity || p.towState || p.towZip);
                 const towGeoCode = hasAddress ? '' : String(p.location || p.domicile || '').trim();

                 if (hasAddress) {
                     this.log('TOW: address filled  -  skipping GeoFence');
                 } else if (towGeoCode) {
                     const geoInput = await this.waitFor(() => {
                         const byParent = Array.from(document.querySelectorAll('INPUT[role="combobox"]'))
                             .find(el => el.offsetParent && el.closest('DIV.css-sbin3j'));
                         if (byParent) return byParent;
                         const byCls = document.querySelector('DIV.css-sbin3j INPUT[role="combobox"]');
                         if (byCls && byCls.offsetParent) return byCls;
                         const all = Array.from(document.querySelectorAll('INPUT[role="combobox"]'))
                             .filter(el => el.offsetParent);
                         return all[all.length - 1] || null;
                     }, 5000, 80);

                     if (geoInput) {
                         geoInput.focus(); geoInput.click();
                         await this.sleep(150);
                         const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                         for (let ci = 1; ci <= towGeoCode.length; ci++) {
                             setter.call(geoInput, towGeoCode.slice(0, ci));
                             geoInput.dispatchEvent(new Event('input', { bubbles: true }));
                             await this.sleep(60);
                         }
                         this.log('TOW: GeoFence typed "' + towGeoCode + '"');
                         const geoOpt = await this.waitFor(() => {
                             const opts = Array.from(document.querySelectorAll('BUTTON[role="option"]'));
                             return opts.find(o => o.innerText.trim().toUpperCase() === towGeoCode.toUpperCase()) ||
                                    opts.find(o => o.innerText.trim().toUpperCase().includes(towGeoCode.toUpperCase())) || null;
                         }, 5000, 80);
                         if (geoOpt) { geoOpt.click(); this.log('TOW: GeoFence selected "' + geoOpt.innerText.trim() + '"'); }
                         else { this.log('TOW: WARNING - GeoFence option not found for "' + towGeoCode + '"'); }
                         await this.sleep(400);
                     } else {
                         this.log('TOW: WARNING - GeoFence combobox not found');
                     }
                 } else {
                     this.log('TOW: no address and no domicile  -  skipping GeoFence');
                 }

                 // STEP E: Re-assert Off Site  -  React may reset it
                 await this.sleep(200);
                 await clickOffSite();
                 this.log('TOW: Off Site re-asserted');
                 await this.sleep(300);
             }

             try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) {}
             await this.sleep(150);

             const nameInput = await this.waitFor(() => document.querySelector('INPUT#driverName'), 3000);
             if (nameInput) { this.setVal(nameInput, p.contactName || ''); }

             // Phone country
             const ccTrigger = await this.waitFor(() =>
                 document.querySelector('DIV.css-aq1vka') || document.querySelector('[id^="select--r"]')
             , 3000);
             if (ccTrigger) {
                 let fired = false;
                 try {
                     const fk = Object.keys(ccTrigger).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
                     if (fk) { let f = ccTrigger[fk]; while (f) { const pr = f.memoizedProps || f.pendingProps; if (pr && typeof pr.onClick === 'function') { pr.onClick({ type: 'click', bubbles: true, preventDefault: () => {}, stopPropagation: () => {} }); fired = true; break; } f = f.return; } }
                 } catch (e) {}
                 if (!fired) { this.click(ccTrigger); }
                 const ccOpt = await this.waitFor(() => {
                     const all = Array.from(document.querySelectorAll('BUTTON[role="option"],LI,[role="option"],BUTTON')).filter(el => el.offsetParent);
                     return all.find(el => /^\+1[\s(]/.test((el.innerText || el.textContent || '').trim())) || null;
                 }, 4000, 50);
                 if (ccOpt) {
                     let optFired = false;
                     try {
                         const fk = Object.keys(ccOpt).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
                         if (fk) { let f = ccOpt[fk]; while (f) { const pr = f.memoizedProps || f.pendingProps; if (pr && typeof pr.onClick === 'function') { pr.onClick({ type: 'click', bubbles: true, preventDefault: () => {}, stopPropagation: () => {} }); optFired = true; break; } f = f.return; } }
                     } catch (e) {}
                     if (!optFired) { this.click(ccOpt); }
                     await this.sleep(200);
                 }
             }

             const phoneInput = await this.waitFor(() => document.querySelector('INPUT#driverPhoneNumber'), 3000);
             if (phoneInput) {
                 let digits = String(p.contactPhone || '').replace(/\D/g, '');
                 if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
                 this.setVal(phoneInput, digits);
             }

             if (p.contactEmail) {
                 const emailInput = Array.from(document.querySelectorAll('INPUT')).find(i => /email/i.test(i.placeholder || i.id || '') && i.offsetParent);
                 if (emailInput) { this.setVal(emailInput, p.contactEmail); }
             }
               // STEP 7: Vault attachment upload — must happen NOW, before nextStep() destroys the upload widget
               if (p.attachmentIds && p.attachmentIds.length > 0) {
                   this.log('--- STEP 7: Vault Attachments (' + p.attachmentIds.length + ') ---');
                   try {
                       let vaultDocs = [];
                       try {
                           const raw = typeof GM_getValue === 'function' ? GM_getValue('zila-doc-vault-v1', null) : null;
                           if (raw && raw.docs) vaultDocs = raw.docs;
                       } catch(e) {}
                       const selected = vaultDocs.filter(d => p.attachmentIds.includes(d.id) && d.dataUrl);
                       if (selected.length > 0) {
                           const fileInput = await this.waitFor(() => {
                               const inputs = Array.from(document.querySelectorAll('INPUT[type="file"]'));
                               return inputs.find(i => i.accept && /image|pdf/i.test(i.accept)) || inputs[0] || null;
                           }, 5000, 80);
                           if (fileInput) {
                               const dt = new DataTransfer();
                               for (const doc of selected) {
                                   try {
                                       const [header, b64] = doc.dataUrl.split(',');
                                       const mime = (header.match(/:(.*?);/) || ['','image/png'])[1];
                                       const ext  = mime === 'application/pdf' ? 'pdf' : mime.split('/')[1] || 'png';
                                       const bin  = atob(b64);
                                       const arr  = new Uint8Array(bin.length);
                                       for (let bi = 0; bi < bin.length; bi++) arr[bi] = bin.charCodeAt(bi);
                                       const file = new File([arr], (doc.name || 'attachment').slice(0, 60) + '.' + ext, { type: mime });
                                       dt.items.add(file);
                                       this.log('Vault: queued "' + file.name + '" (' + Math.round(file.size / 1024) + 'KB)');
                                   } catch(convErr) {
                                       this.log('Vault: WARNING - could not convert "' + (doc.name||'doc') + '": ' + convErr.message);
                                   }
                               }
                               if (dt.files.length > 0) {
                                   Object.defineProperty(fileInput, 'files', { value: dt.files, writable: false });
                                   fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                                   fileInput.dispatchEvent(new Event('input',  { bubbles: true }));
                                   this.log('Vault: ' + dt.files.length + ' file(s) injected - waiting for category dropdowns...');

                                   // The category dropdown trigger only appears AFTER the file finishes uploading
                                   await this.waitFor(() => {
                                       return Array.from(document.querySelectorAll('DIV[id^="select-:"]')).find(el =>
                                           el.offsetParent && (el.innerText || el.textContent || '').trim().length > 0
                                       ) || null;
                                   }, 15000, 200);

                                   await this.sleep(400);
                                   this.log('Vault: category dropdown(s) appeared - setting to Other...');

                                   for (let fi = 0; fi < dt.files.length; fi++) {
                                       const catTrigger = await this.waitFor(() => {
                                           return Array.from(document.querySelectorAll('DIV[id^="select-:"]')).find(el => {
                                               if (!el.offsetParent) return false;
                                               const txt = (el.innerText || el.textContent || '').trim();
                                               return txt.length > 0 && !/^other$/i.test(txt);
                                           }) || null;
                                       }, 5000, 150);

                                       if (!catTrigger) {
                                           this.log('Vault: WARNING - category trigger not found for file ' + (fi+1));
                                           continue;
                                       }

                                       this.click(catTrigger);
                                       await this.sleep(300);

                                       const otherBtn = await this.waitFor(() => {
                                           const btns = Array.from(document.querySelectorAll('BUTTON[role="option"]')).filter(b => b.offsetParent);
                                           return btns.find(b => /^other$/i.test((b.innerText || b.textContent || '').trim())) || null;
                                       }, 3000, 80);

                                       if (otherBtn) {
                                           this.click(otherBtn);
                                           await this.sleep(300);
                                       }  // if (otherBtn)
                                   }          // for fi (vault file loop)
                               }              // if (dt.files.length > 0)
                           }                  // if (fileInput)
                       }                      // if (selected.length > 0)
                   } catch (e) {              // outer try: vault section
                       this.log('Vault attachment error: ' + e.message);
                   }                          // end outer try/catch
               }                              // if (p.attachmentIds)

               this.log('--- COMPLETE ---');
               return { ok: true, message: 'Autofill completed through Issue Details step -- review before submitting.' };
           },                                 // run()

}; // CreateWRAutofill

if (typeof module !== 'undefined') module.exports = CreateWRAutofill;
