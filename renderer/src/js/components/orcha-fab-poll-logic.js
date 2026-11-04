/**
 * orcha-fab-poll-logic.js — Pure logic for the Orcha FAB's Slack poll timers.
 *
 * FEATURE (2026-11-01, Phase 4 — single main-process communications poller):
 * every decision orcha-fab.js makes about its three renderer poll timers
 * (DM notify, channel watch, DM auto-reply) lives here so it can be unit-tested
 * under vitest's node environment. NO DOM, NO bus, NO bridge imports —
 * orcha-fab.js injects everything (precedent: status-bar-logic.js).
 *
 * Modes come from main (`slack:get-poller-status` / `slack:poll-mode` push):
 *   off / shadow — the renderer owns polling exactly as today (both windows).
 *   on           — main owns polling; NO renderer poll timer arms, in any window.
 * See src/slack/poller.js for the main side and the documented off-delta.
 */

export const POLL_MODES = ['off', 'shadow', 'on'];
export const POLL_KINDS = ['dmNotify', 'channelWatch', 'dmAutoReply'];

/** String, trimmed, lowercase, in POLL_MODES; anything else → 'off'. */
export function normalizePollMode(raw) {
  if (typeof raw !== 'string') return 'off';
  const m = raw.trim().toLowerCase();
  return POLL_MODES.includes(m) ? m : 'off';
}

/** Which renderer timers may run. Same answer for the main window AND the bubble. */
export function rendererPollPlan(mode) {
  const own = normalizePollMode(mode) !== 'on';
  return { dmNotify: own, channelWatch: own, dmAutoReply: own };
}

/**
 * Arm decision for ONE renderer timer. `mode` MUST be the loaded mode;
 * null/undefined = "not loaded yet" and throws, so a caller that forgot to
 * await the mode loader fails loudly instead of arming.
 * timerExists keeps TODAY's per-kind guard exactly:
 *   channelWatch / dmAutoReply: today's `if (_xTimer) return` → !timerExists
 *   dmNotify: today has NO such guard (the _togglePanel/boot double-arm is
 *             pre-existing) → ignored in off/shadow.
 */
export function shouldArm(kind, mode, timerExists) {
  if (mode == null) throw new Error('shouldArm: poll mode not loaded');
  if (!rendererPollPlan(mode)[kind]) return false;           // 'on' → never arm, any kind, any window
  if (kind === 'dmNotify') return true;                      // parity with today (no guard)
  return !timerExists;
}

/** Whether _startSlackPoll should (re)run checkLiveAuth. off/shadow: every call (today). on: once per window. */
export function shouldCheckAuth(mode, alreadyChecked) {
  return normalizePollMode(mode) !== 'on' || !alreadyChecked;
}

/**
 * Pure reducer for ANY poll result, timer-returned or pushed. Returns ORDERED
 * per-message steps; the caller commits state and applies effects step by step
 * (applySteps), so the interleaving is today's.
 *   dmNotify: one step per newly-seen DM (string-compare dedupe vs lastDmTs, as today).
 *   channelWatch / dmAutoReply: at most ONE step, lastDmTs undefined (= leave state untouched).
 * Titles, icons and bodies are copied character for character from the
 * pre-Phase-4 timer callbacks in orcha-fab.js.
 */
export function reducePollResult(kind, result, lastDmTs) {
  const steps = [];
  if (kind === 'dmNotify') {
    if (!result || !result.length) return { steps };
    let cur = lastDmTs;
    for (let i = 0; i < result.length; i++) {
      const msg = result[i];
      if (cur && msg.ts <= cur) continue;
      cur = msg.ts;
      steps.push({
        lastDmTs: msg.ts,
        effects: [
          { type: 'appendDM', msg },
          { type: 'notif', icon: '\u{1F4E9}', title: 'Slack DM', body: msg.text },
        ],
      });
    }
    return { steps };
  }
  if (kind === 'channelWatch' || kind === 'dmAutoReply') {
    if (result && result.escalatedCount > 0) {
      steps.push({
        lastDmTs: undefined,
        effects: [
          {
            type: 'notif',
            icon: '\u{1F6A8}',
            title: (kind === 'channelWatch' ? 'Partner AI: ' : 'DM AI: ') + result.escalatedCount + ' item(s) need review',
            body: (result.items[0] && result.items[0].title) || '',
          },
          { type: 'updateReviewBadge' },
          { type: 'refreshReviewIfOpen' },
        ],
      });
    }
  }
  return { steps };
}

/**
 * Applier with today's exact failure semantics. Per step: commit FIRST (today
 * sets _lastDmTs = msg.ts before _appendSlackDM), then apply effects in order.
 * The first throw propagates to the caller's silent try/catch, so later steps
 * are NOT applied and NOT committed — identical to a throw inside today's forEach.
 */
export function applySteps(steps, commit, apply) {
  for (const st of steps) {
    if (st.lastDmTs !== undefined) commit(st.lastDmTs);
    for (const ef of st.effects) apply(ef);
  }
}

/**
 * Memoized poll-mode loader. getStatus() is called at most once. A missing
 * status, rejection or synchronous throw resolves 'off'. A set(m) push that
 * lands before the IPC reply wins over the late reply.
 */
export function createPollModeLoader(getStatus) {
  let mode = null;
  let p = null;
  return {
    load() {
      if (!p) {
        p = Promise.resolve()
          .then(() => getStatus())
          .then(s => normalizePollMode(s && s.mode), () => 'off')
          .then(m => { if (mode == null) mode = m; return mode; });
      }
      return p;
    },
    set(m) {
      mode = normalizePollMode(m);
      p = Promise.resolve(mode);
      return mode;
    },
    current() { return mode; },
  };
}

/**
 * Timers to clear / arm after a mode change. `armed` = {kind: boolean}.
 * clear: not allowed but armed; arm: allowed but not armed.
 */
export function planModeChange(mode, armed) {
  const plan = rendererPollPlan(mode);
  const a = armed || {};
  return {
    clear: POLL_KINDS.filter(k => !plan[k] && a[k]),
    arm: POLL_KINDS.filter(k => plan[k] && !a[k]),
  };
}

/**
 * DM-notify timer starter (today's _startSlackPoll body, injectable).
 * d = {loadMode, currentMode, checkLiveAuth, getAuthed, setAuthed, getTimer,
 *      setTimer, setInterval, tick, intervalMs}
 * The post-await re-check (step 5) closes the double-arm when an on→off
 * fallback push lands while the boot start() is between its awaits. Without a
 * push, off/shadow keep today's double-arm (parity).
 */
export function createDmNotifyStarter(d) {
  let alreadyChecked = false;
  let pushSeen = false;
  return {
    async start(opts) {
      const o = opts || {};
      const mode = await d.loadMode();
      if (shouldCheckAuth(mode, alreadyChecked)) {
        alreadyChecked = true;
        try {
          const a = await d.checkLiveAuth();
          d.setAuthed(a && a.authenticated);
        } catch (e) { d.setAuthed(false); }
      }
      if (!d.getAuthed()) return;
      if (!shouldArm('dmNotify', d.currentMode(), !!d.getTimer())) return;
      if (d.getTimer() && (o.fromModePush || pushSeen)) return;
      d.setTimer(d.setInterval(d.tick, d.intervalMs));
    },
    notePush() { pushSeen = true; },
  };
}
