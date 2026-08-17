/**
 * events.js — Event name constants for the renderer event bus
 *
 * Phase 4: Single source of truth for all bus event names.
 * Import and use these instead of magic strings to get:
 *   - Autocomplete in editor
 *   - Typos caught at import time
 *   - Easy "find all references" for any event
 *
 * Usage:
 *   import { FLEET_DATA, UI_VIEW_CHANGE } from './events.js';
 *   bus.on(FLEET_DATA, (data) => { ... });
 *   bus.emit(UI_VIEW_CHANGE, { from: 'fleet', to: 'settings' });
 */

// ── IPC → Renderer (emitted by bridge.js) ────────────────────────────────────
export const FLEET_DATA           = 'fleet:data';
export const FLEET_STATUS         = 'fleet:status';
export const FLEET_ERROR          = 'fleet:error';
export const FLEET_AUTH_FAILURE   = 'fleet:auth-failure';
export const FLEET_AUTO_EMAIL     = 'fleet:auto-email';
export const FLEET_REFRESH        = 'fleet:refresh';

export const ORCHA_PROGRESS       = 'orcha:progress';
export const ORCHA_ALERTS         = 'orcha:alerts';
export const ORCHA_RECOMMENDATIONS = 'orcha:recommendations';
export const ORCHA_TRACKER        = 'orcha:tracker';
export const ORCHA_DRAFTS         = 'orcha:drafts';
export const ORCHA_HEALTH         = 'orcha:health';
export const ORCHA_MONITOR        = 'orcha:monitor';
export const ORCHA_BRIEFING       = 'orcha:morning-briefing';

export const DAILY_NOTES_PROGRESS = 'daily-notes:progress';
export const SP_PROGRESS          = 'sp:progress';

export const NAVIGATE_UNIT        = 'navigate:unit';
export const AUTH_MWINIT_STATUS   = 'auth:mwinit-status';
export const SETUP_PROGRESS       = 'setup:progress';

export const NOTES_UPDATED        = 'notes:updated';
export const PINS_UPDATED         = 'pins:updated';
export const WR_CREATED           = 'wr:created';
export const WR_PROGRESS          = 'wr:progress';
export const EMAIL_COMPOSE        = 'email:compose';

export const SLACK_INCOMING       = 'slack:incoming';

export const CONNECTION_STATUS    = 'app:connection-status';

// ── Vendor workflow events ────────────────────────────────────────────────────
export const VENDOR_PROGRESS      = 'vendor:progress';
export const VENDOR_REVIEW_READY  = 'vendor:review-ready';
export const VENDOR_COMPLETE      = 'vendor:complete';
export const VENDOR_ERROR         = 'vendor:error';

// ── Internal UI events ────────────────────────────────────────────────────────
export const UI_VIEW_CHANGE       = 'ui:view-change';
export const UI_UNIT_SELECT       = 'ui:unit-select';
export const UI_UNIT_DESELECT     = 'ui:unit-deselect';
export const UI_FILTER_CHANGE     = 'ui:filter-change';
export const UI_SEARCH            = 'ui:search';
export const UI_TOAST             = 'ui:toast';
export const UI_LOADING           = 'ui:loading';
export const UI_QUICK_FILTER      = 'ui:quick-filter';
export const UI_NOTIF_PUSH        = 'ui:notif-push';

// ── State slice events (emitted by state.js on update) ────────────────────────
export const STATE_FLEET          = 'state:fleet';
export const STATE_UI             = 'state:ui';
export const STATE_SYNC           = 'state:sync';
export const STATE_AUTH           = 'state:auth';
export const STATE_SETTINGS       = 'state:settings';
export const STATE_VENDOR         = 'state:vendor';
export const STATE_MONITOR        = 'state:monitor';
export const STATE_ALERTS         = 'state:alerts';
export const STATE_RECOMMENDATIONS = 'state:recommendations';
export const STATE_TRACKER        = 'state:tracker';
export const STATE_HEALTH         = 'state:health';

// ── Settings events ───────────────────────────────────────────────────────────
export const SETTINGS_SLA_TARGET  = 'settings:sla-target';
