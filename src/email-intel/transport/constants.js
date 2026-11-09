'use strict';
/**
 * email-intel/transport/constants.js — frozen limits of the Outlook REST transport (design 4.1).
 *
 * No host string lives here: the REST host is defined only in transport/endpoints.js (static guard).
 * TOKEN_PAGE_URL is the same landing page the DOM reader uses (owa_reader.INBOX_URL); the SPA redirects
 * it to the mailbox host on its own.
 */
const TC = Object.freeze({
  TOKEN_PAGE_URL: 'https://outlook.office365.com/mail/inbox',
  REFRESH_MARGIN_MS: 5 * 60_000,        // start a refresh from the cache when exp - now < this
  FRESH_ACCEPT_MS: 60_000,              // a freshly captured token is accepted when exp - now >= this
  SEND_MIN_TTL_MS: 10 * 60_000,         // send pre-check only: ask for a refresh below this
  SEND_TOKEN_FLOOR_MS: 3 * 60_000,      // send pre-check: below this after the refresh -> TOKEN_SHORT
  TOKEN_WINDOW_HARD_MS: 60_000,         // whole token window lifetime (NFR-4)
  BEARER_WAIT_MS: 30_000,               // after the mailbox loaded
  BEARER_SETTLE_MS: 2_000,              // wait for a better-ranked request after the first usable capture
  TOKEN_AUTH_WALL_MS: 45_000,           // blocked only if STILL on an auth host this long after the first auth navigation
  KMSI_POLL_MS: 1_000,
  WINDOW_CLOSE_WAIT_MS: 5_000,
  REFRESH_COOLDOWN_MS: 60_000,          // after a failed refresh; also the upper bound of the refresh hold
  MAX_INFLIGHT: 4,                      // read/write requests; `final` requests bypass the semaphore
  GET_TIMEOUT_MS: 20_000, ATTACH_TIMEOUT_MS: 30_000, POST_TIMEOUT_MS: 30_000,
  JSON_MAX_BYTES: 4 * 1024 * 1024,
  SMALL_MAX_BYTES: 256 * 1024,          // bodies of send / move / probe responses
  ATTACH_JSON_OVERHEAD: 64 * 1024,      // attachment response cap = ceil(maxBytes * 4/3) + this
  RETRY_AFTER_CAP_MS: 60_000, THROTTLE_MAX_TRIES: 3, BACKOFF_BASE_MS: 2_000, TRANSIENT_RETRY_MS: 1_000,
  PAGE_TOP: 50, FORWARD_MAX_PAGES: 6, SEED_TOP_MAX: 50,
  CONTEXT_MAX: 10, CONVERSATION_TOP: 25, CONVERSATION_FALLBACK_PAGES: 3,
  FOLDER_LIST_MAX: 300, FOLDER_DEPTH_MAX: 3,
  WM_IDS_MAX: 50,
  VERIFY_TIMEOUT_MS: 60_000, VERIFY_POLL_MS: 3_000,
  SENT_TOP: 50, SENT_TOP_SMALL: 10,
  SENT_PAGES_MAX: 4,
  SENT_ITEMS_MAX: 200,
  SENT_PAGES_HARD_MAX: 20,
  DELETE_CONV_MAX: 50,
  ATT_ID_MAX: 512,
  ITEM_ID_MAX: 512,
  IMID_MAX: 998,
  RECONCILE_AUTO_MAX: 3, RECONCILE_AUTO_MIN_AGE_MS: 2 * 60_000, RECONCILE_AUTO_GAP_MS: 10 * 60_000,
  RECONCILE_AUTO_BUDGET_MS: 90_000,     // R4-M5: wall budget of the scan-start auto-reconcile
});

module.exports = { TC };
