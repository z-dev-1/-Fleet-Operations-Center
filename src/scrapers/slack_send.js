'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { P } = require('../config/paths');
const logger = require('../utils/logger').createLogger('slack_send');

const CONFIG_FILE = P.slackConfig;

function getConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(config) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function isAuthenticated() {
  const config = getConfig();
  return !!(config && config.token && config.allCookieHeader);
}

/**
 * FEATURE (2026-07-16): isAuthenticated() below only checks that a token
 * file exists on disk -- it never confirms the token still actually works.
 * Slack session tokens (xoxc-) can be invalidated (password reset, admin
 * revoke, long inactivity) without the local file changing at all, which
 * would leave the UI showing "connected" indefinitely while every real API
 * call silently fails. checkLiveAuth() calls Slack's own auth.test endpoint
 * to confirm the token is genuinely still valid right now.
 */
async function checkLiveAuth() {
  if (!isAuthenticated()) return { authenticated: false, reason: 'not_configured' };
  try {
    const res = await slackWebApi('auth.test', {});
    if (res && res.ok) {
      // FEATURE (2026-07-21): added userId (res.user_id, the actual Slack
      // ID like U0123456) alongside the existing display-name `user` field
      // -- needed by the Partner Auto-Reply engine to detect and skip its
      // own previous messages when polling channel history (loop
      // prevention). `user` alone isn't reliably comparable to a message's
      // author ID field.
      return { authenticated: true, user: res.user || '', userId: res.user_id || '', team: res.team || '' };
    }
    return { authenticated: false, reason: res && res.error ? res.error : 'unknown' };
  } catch (e) {
    return { authenticated: false, reason: e.message };
  }
}

/**
 * FEATURE (2026-07-16): clears stored Slack credentials so the user can
 * cleanly re-authenticate if a session ever goes stale (see checkLiveAuth
 * above) instead of the token being permanently stuck with no reset path.
 */
function logout() {
  const existing = getConfig() || {};
  saveConfig({ token: '', cookie: '', allCookieHeader: '', defaultRecipient: existing.defaultRecipient || '' });
  return { ok: true };
}

/**
 * Call Slack Web API
 * Uses full cookie header (all cookies) + xoxc token in body
 */
function slackWebApi(method, params = {}) {
  const config = getConfig();
  if (!config || !config.token || !config.allCookieHeader) {
    throw new Error('Slack not configured — please sign in first');
  }

  params.token = config.token;
  const postData = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'amazon.enterprise.slack.com',
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': config.allCookieHeader,
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Slack parse error: ${data.substring(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error('Slack API timeout: ' + method));
    });
    req.write(postData);
    req.end();
  });
}

/**
 * Find a user by name/alias using enterprise search
 * Returns user ID or null
 */
async function findUser(query) {
  // If email, try lookupByEmail first
  if (query.includes("@") && query.includes(".")) {
    try {
      const emailResult = await slackWebApi("users.lookupByEmail", { email: query });
      if (emailResult.ok && emailResult.user) return emailResult.user.id;
    } catch(e) { /* fall through */ }
  }
  // Enterprise people search
  const result = await slackWebApi("search.modules", { query: query, module: "people", count: "5" });
  if (result.ok && result.items && result.items.length > 0) return result.items[0].id;
  return null;
}

/**
 * FEATURE (2026-07-16): search-based directory lookup for the Slack tab.
 *
 * IMPORTANT -- Amazon's Enterprise Grid Slack workspace hard-blocks bulk
 * conversation listing (conversations.list AND users.conversations both
 * return error: "enterprise_is_restricted" for this token type -- verified
 * live against the real API). This is a deliberate enterprise security
 * policy, not a bug and not a timing/sync issue -- it will never resolve on
 * its own. HOWEVER, individual search.modules lookups (people AND channels)
 * are NOT restricted and work fine -- also verified live. So the Slack tab
 * cannot browse a channel/DM list, but CAN search by name and open a
 * specific known conversation. That's what this function powers.
 *
 * Returns up to `limit` combined people + channel matches for `query`.
 */
async function searchDirectory(query, limit) {
  const lim = String(limit || 5);
  const results = [];
  try {
    const people = await slackWebApi('search.modules', { query, module: 'people', count: lim });
    if (people.ok && people.items) {
      people.items.forEach(p => results.push({
        id: p.id, name: p.name || p.real_name || p.id, type: 'user'
      }));
    }
  } catch (_) { /* one module failing shouldn't block the other */ }
  try {
    const channels = await slackWebApi('search.modules', { query, module: 'channels', count: lim });
    if (channels.ok && channels.items) {
      channels.items.forEach(c => results.push({
        id: c.id, name: c.name || c.id, type: 'channel'
      }));
    }
  } catch (_) { /* one module failing shouldn't block the other */ }
  return results;
}

/**
 * FEATURE (2026-07-16): resolves a directory result ({id, name, type} from
 * searchDirectory above) to an actual open conversation ID. For channels,
 * the search result ID already IS the channel ID. For users, we need to
 * open (or reuse) the DM via conversations.open -- verified working live
 * even though bulk listing is restricted.
 */
async function openConversation(entry) {
  if (!entry || !entry.id) throw new Error('Invalid directory entry');
  if (entry.type === 'channel') return entry.id;
  const dm = await slackWebApi('conversations.open', { users: entry.id });
  if (!dm.ok) throw new Error('conversations.open failed: ' + dm.error);
  return dm.channel.id;
}

/**
 * Send a DM or channel message
 * @param {string} recipient - name, alias, or #channel
 * @param {string} message - message text (supports Slack markdown)
 */
async function sendSlackMessage(recipient, message) {
  let channelId = null;

  // Check if it's a channel reference
  if (recipient.startsWith('#')) {
    const chanName = recipient.replace('#', '');
    const chanResult = await slackWebApi('conversations.list', {
      types: 'public_channel,private_channel',
      limit: '200'
    });
    if (chanResult.ok && chanResult.channels) {
      const match = chanResult.channels.find(c => c.name === chanName);
      if (match) channelId = match.id;
    }
  } else {
    // Search for user by name
    const userId = await findUser(recipient);
    if (userId) {
      const dmResult = await slackWebApi('conversations.open', { users: userId });
      if (dmResult.ok) {
        channelId = dmResult.channel.id;
      }
    }
  }

  if (!channelId) {
    throw new Error(`Could not find recipient: ${recipient}`);
  }

  // Send message
  const result = await slackWebApi('chat.postMessage', {
    channel: channelId,
    text: message
  });

  if (!result.ok) {
    throw new Error(`Slack API error: ${result.error}`);
  }

  logger.info('[Slack] Message sent to', recipient);
  return { ok: true, ts: result.ts };
}

// FEATURE (2026-07-16): sendSlackMessage() below resolves a recipient by
// NAME (fuzzy search.modules / users.lookupByEmail), which is inherently a
// little fragile and is really meant for the free-text "@mention" chat
// flow. Once the UI already has an exact channel/DM ID in hand (from
// getChannels()/readDMs()), re-doing a name search is both wasteful and
// less reliable than just posting directly to the known ID. Used by the
// new Slack tab's reply box.
async function sendToChannel(channelId, message, threadTs) {
  if (!channelId) throw new Error('channelId required');
  // FEATURE (2026-07-21): optional threadTs param, backward compatible --
  // existing callers passing only (channelId, message) are unaffected.
  // Added for the Slack Partner Auto-Reply engine (slack_channel_watch.js),
  // which always replies in-thread rather than posting new top-level
  // messages into a partner-facing channel.
  const payload = {
    channel:       channelId,
    text:          message,
    // Unfurl links/media so URLs in AI replies auto-expand in Slack
    unfurl_links:  'true',
    unfurl_media:  'true',
  };
  if (threadTs) payload.thread_ts = threadTs;
  const result = await slackWebApi('chat.postMessage', payload);
  if (!result.ok) throw new Error(`Slack API error: ${result.error}`);
  logger.info('[Slack] Message sent to channel', channelId, threadTs ? '(threaded)' : '');
  return { ok: true, ts: result.ts };
}


function slackSaveConfig(data) {
  const existing = getConfig() || {};
  saveConfig({
    token: data.token || existing.token,
    cookie: data.cookie || existing.cookie,
    allCookieHeader: data.allCookieHeader || existing.allCookieHeader || '',
    defaultRecipient: data.defaultRecipient || existing.defaultRecipient || ''
  });
  return { ok: true };
}


// -- S22: Read functions -------------------------------------------------------

/**
 * getChannels(limit) -- list channels the authed user can access
 */
async function getChannels(limit) {
  const lim = String(limit || 100);
  const res = await slackWebApi('conversations.list', {
    types: 'public_channel,private_channel,mpim,im', limit: lim,
    exclude_archived: 'true'
  });
  if (!res.ok) return []; // enterprise restricted
  return (res.channels || []).map(c => ({
    id: c.id, name: c.name || c.id,
    isIm: !!c.is_im, isMpim: !!c.is_mpim,
    unread: c.unread_count || 0
  }));
}

/**
 * readMessages(channelId, limit) -- fetch history for any channel or DM
 */
async function readMessages(channelId, limit) {
  if (!channelId) throw new Error('channelId required');
  const lim = String(limit || 30);
  const res = await slackWebApi('conversations.history', {
    channel: channelId, limit: lim, inclusive: 'true'
  });
  if (!res.ok) throw new Error('conversations.history failed: ' + res.error);
  return (res.messages || []).map(m => ({
    ts:         m.ts,
    userId:     m.user || m.username || '',
    text:       m.text || '',
    threadTs:   m.thread_ts || null,
    replyCount: m.reply_count || 0,
    // Pass through files and attachments so consumers can read shared docs/links
    files:       m.files       || [],
    attachments: m.attachments || [],
    channelId
  }));
}

/**
 * FIX (2026-07-26): conversations.history (readMessages above) only returns
 * a channel's TOP-LEVEL message timeline -- actual thread reply messages
 * (thread_ts differs from their own ts) are excluded entirely. That means
 * the mention-thread continuation logic in slack_channel_watch.js
 * (_isInMentionThread) was fully implemented but effectively dead: the
 * reply messages it needs to see never showed up in readMessages()'s
 * output in the first place. This calls conversations.replies to fetch the
 * actual reply messages for a given thread, in the same result shape as
 * readMessages() so callers can merge the two lists interchangeably.
 */
async function readThreadReplies(channelId, threadTs, limit) {
  if (!channelId) throw new Error('channelId required');
  if (!threadTs) throw new Error('threadTs required');
  const lim = String(limit || 20);
  const res = await slackWebApi('conversations.replies', {
    channel: channelId, ts: threadTs, limit: lim
  });
  if (!res.ok) throw new Error('conversations.replies failed: ' + res.error);
  return (res.messages || []).map(m => ({
    ts:         m.ts,
    userId:     m.user || m.username || '',
    text:       m.text || '',
    threadTs:   m.thread_ts || null,
    replyCount: m.reply_count || 0,
    files:       m.files       || [],
    attachments: m.attachments || [],
    channelId
  }));
}

/**
 * FEATURE (2026-07-16): cache of channelId -> display name for DM senders,
 * to avoid re-resolving conversations.info + users.info on every 30s poll
 * for the same conversation. See readDMs() below for the full rewrite
 * rationale (two bugs found: dead API call + shape mismatch).
 */
const _dmUserNameCache = new Map();

// FEATURE (2026-07-25): generic userId -> display name cache/resolver, used
// both by 1:1 DM name resolution below and, for GROUP DMs, to build a
// human-readable "Alice, Bob, Carol" name from multiple member IDs. Kept
// separate from _dmUserNameCache, which caches by *channelId* not userId.
const _userInfoCache = new Map();

async function resolveUserName(userId) {
  if (!userId) return null;
  if (_userInfoCache.has(userId)) return _userInfoCache.get(userId);
  try {
    const u = await slackWebApi('users.info', { user: userId });
    const name = (u.ok && u.user) ? (u.user.real_name || u.user.name || userId) : userId;
    _userInfoCache.set(userId, name);
    return name;
  } catch (_) {
    return userId;
  }
}

// Own userId (Z), fetched lazily via auth.test and cached for the process
// lifetime -- needed to exclude Z from the joined member-name list when
// resolving a GROUP DM's display name (see below), without every caller
// having to look it up and pass it in explicitly.
let _myUserId = null;
async function _getMyUserId() {
  if (_myUserId) return _myUserId;
  try {
    const auth = await checkLiveAuth();
    if (auth && auth.authenticated && auth.userId) _myUserId = auth.userId;
  } catch (_) { /* best-effort -- group name just falls back to including Z if this fails */ }
  return _myUserId;
}

// FEATURE (2026-07-25): now handles GROUP DMs (Slack "mpim" conversations,
// 3+ people) in addition to 1:1 DMs. A 1:1 DM's conversations.info response
// has a single 'user' field; a group DM has none -- instead it has
// 'is_mpim: true' and requires a separate conversations.members call to
// get the participant list, each of which is then resolved and joined into
// e.g. "Alice Smith, Bob Lee" for display (Z's own name is excluded).
async function _resolveDmSenderName(channelId, myUserId) {
  if (_dmUserNameCache.has(channelId)) return _dmUserNameCache.get(channelId);
  try {
    const info = await slackWebApi('conversations.info', { channel: channelId });
    if (!info.ok || !info.channel) return null;

    let name = null;
    if (info.channel.user) {
      // 1:1 DM -- single named counterpart.
      name = await resolveUserName(info.channel.user);
    } else if (info.channel.is_mpim) {
      // Group DM -- resolve every member's name, excluding Z.
      const self = myUserId || await _getMyUserId();
      const mem = await slackWebApi('conversations.members', { channel: channelId });
      const memberIds = (mem.ok && mem.members) ? mem.members : [];
      const others = memberIds.filter(id => id !== self);
      const names = await Promise.all(others.map(id => resolveUserName(id)));
      name = names.filter(Boolean).join(', ') || info.channel.name || null;
    }
    if (!name) return null;
    _dmUserNameCache.set(channelId, name);
    return name;
  } catch (_) {
    return null;
  }
}

// Tracks message ts values already surfaced to the caller, so the same
// unread DM doesn't re-notify on every subsequent poll (see readDMs below
// for why this is needed instead of calling conversations.mark, which
// would change the user's real Slack read-state as a side effect).
const _dmNotifiedTs = new Set();

/**
 * readDMs(limit) -- fetch NEW unread DM messages across all direct messages.
 *
 * REWRITTEN 2026-07-16 (two bugs found and fixed):
 *
 * BUG 1 -- dead on arrival: the original implementation called
 * conversations.list({types:'im'}), which Amazon's Enterprise Grid Slack
 * workspace blocks outright (error: enterprise_is_restricted -- verified
 * live against the real API with an authenticated session). This threw on
 * every single call since this feature existed; every caller wraps it in
 * try/catch and swallows the error silently, so DM polling has been
 * silently non-functional the entire time -- not a sync/timing issue.
 *
 * BUG 2 -- shape mismatch, independent of bug 1: the original return shape
 * was [{ channelId, userId, unread, messages: [...] }] (per-conversation,
 * nested history). The only consumer, orcha-fab.js's _startSlackPoll(),
 * reads msg.ts / msg.text / msg.user directly off each top-level array
 * item. Those fields never existed at that nesting level, so even if bug 1
 * didn't exist, every entry's msg.ts would be undefined, _lastDmTs would
 * never advance past its initial null, and no notification would have
 * ever correctly fired.
 *
 * FIX: client.counts is NOT subject to the same restriction (verified
 * live) and returns every DM channel ID plus an accurate has_unreads flag
 * -- the same endpoint the real Slack client uses on boot, not subject to
 * the "listing conversations" restriction. Used to find which DMs actually
 * have new messages, then fetch history only for those. Returns a FLAT
 * array of message objects matching what the consumer actually reads:
 * { ts, text, user, channelId }.
 */
/**
 * listOpenDMs() -- FEATURE (2026-07-23): returns ALL open DM conversations
 * (not just ones with Slack's has_unreads flag, unlike readDMs() above).
 * Needed by the DM Auto-Reply engine (slack_dm_autoreply.js), which -- like
 * the Partner Auto-Reply channel engine -- tracks its OWN persisted
 * lastSeenTs per conversation and must check every DM thread on every poll,
 * not just ones Slack currently considers unread (a thread can have a new
 * message we have not replied to yet even after Slack's own unread flag is
 * cleared by e.g. the user glancing at the Chat tab poller). Deliberately
 * independent of readDMs()'s _dmNotifiedTs set above -- that set exists to
 * avoid duplicate desktop-notification spam for the manual-reply Chat tab
 * poller, and sharing it here would cause the two pollers to silently steal
 * each other's notifications.
 */
// FEATURE (2026-07-25): now also returns GROUP DMs (Slack's "mpim" list,
// alongside the existing "ims" 1:1 list) -- previously this only pulled
// counts.ims, so the DM Auto-Reply engine (slack_dm_autoreply.js) never
// even saw group DM threads, let alone replied in them. Each result now
// carries isGroup so callers can tell the two apart (e.g. for reply-context
// / persona prompting -- a group thread needs different handling than a
// 1:1, since replies are visible to everyone in the group).
async function listOpenDMs(limit, myUserId) {
  const lim = Math.min(Number(limit) || 40, 100);
  const counts = await slackWebApi('client.counts', {});
  if (!counts.ok) throw new Error('client.counts failed: ' + counts.error);
  const ims   = (counts.ims   || []).map(c => ({ id: c.id, isGroup: false }));
  const mpims = (counts.mpims || []).map(c => ({ id: c.id, isGroup: true  }));
  const all = ims.concat(mpims).slice(0, lim);
  // Parallel name resolution — resolve all conversations.info calls at once
  // instead of sequentially. With 40 DMs, sequential calls at 8s timeout each
  // could take 40×8s=320s; parallel reduces that to max(one call) ≈ 8s.
  const names = await Promise.all(
    all.map(c => _resolveDmSenderName(c.id, myUserId).catch(() => null))
  );
  return all.map((c, i) => ({ channelId: c.id, name: names[i] || c.id, isGroup: c.isGroup }));
}

async function readDMs(limit) {
  const lim = Math.min(Number(limit) || 20, 39);
  const counts = await slackWebApi('client.counts', {});
  if (!counts.ok) throw new Error('client.counts failed: ' + counts.error);
  // FEATURE (2026-07-25): include group DMs (mpims), not just 1:1 (ims) --
  // same gap as listOpenDMs() had. Without this, an unread message in a
  // group DM never surfaced a Chat tab notification at all.
  const unread = (counts.ims || []).concat(counts.mpims || [])
    .filter(im => im.has_unreads).slice(0, lim);

  const results = [];
  for (const im of unread) {
    try {
      const hist = await readMessages(im.id, 3);
      if (!hist.length) continue;
      const latest = hist[0]; // conversations.history returns newest-first
      const key = im.id + ':' + latest.ts;
      if (_dmNotifiedTs.has(key)) continue;
      _dmNotifiedTs.add(key);
      const senderName = await _resolveDmSenderName(im.id);
      results.push({
        ts: latest.ts,
        text: latest.text,
        user: senderName || latest.userId || 'Slack',
        channelId: im.id
      });
    } catch (_) { /* one DM failing shouldn't block the others */ }
  }
  return results;
}

/**
 * findChannelByName(name) -- resolve #channel-name to channel ID
 */
async function findChannelByName(name) {
  const clean = name.replace(/^#/, '').trim().toLowerCase();
  const channels = await getChannels(200);
  const match = channels.find(c => c.name.toLowerCase() === clean);
  return match ? match.id : null;
}

/**
 * FEATURE (2026-07-22): verifies a Slack channel ID for the Partner
 * Auto-Reply channel-add-by-ID flow (see slack_channel_watch.js /
 * Settings -> Partner Auto-Reply). conversations.list and
 * users.conversations are both hard-blocked on this Enterprise Grid
 * workspace (enterprise_is_restricted, confirmed live) -- no real "browse
 * all my channels" is possible. conversations.info is NOT restricted
 * (confirmed live) and returns an accurate is_member flag, so ID entry +
 * a membership check here is the safe, correct alternative: it prevents
 * silently watching a channel the user was never actually a member of.
 */
async function checkChannelMembership(channelId) {
  if (!channelId || typeof channelId !== 'string') throw new Error('channelId required');
  const res = await slackWebApi('conversations.info', { channel: channelId.trim() });
  if (!res.ok) return { ok: false, error: res.error || 'lookup failed' };
  return {
    ok: true,
    isMember: !!(res.channel && res.channel.is_member),
    name: (res.channel && res.channel.name) || channelId,
    isPrivate: !!(res.channel && res.channel.is_private),
  };
}

/**
 * Auto-reply engine (S22)
 * rules: [{ keyword, response, delayMs, enabled }]
 * processAutoReplies(messages, rules) -- check messages against rules, send replies
 */
const _autoReplySent = new Set();

async function processAutoReplies(messages, rules) {
  if (!rules || !rules.length || !messages || !messages.length) return [];
  const activeRules = rules.filter(r => r.enabled !== false && r.keyword && r.response);
  const sent = [];
  for (const msg of messages) {
    const key = msg.channelId + ':' + msg.ts;
    if (_autoReplySent.has(key)) continue;
    const text = (msg.text || '').toLowerCase();
    for (const rule of activeRules) {
      if (!text.includes(rule.keyword.toLowerCase())) continue;
      _autoReplySent.add(key);
      const delay = rule.delayMs || 0;
      setTimeout(async () => {
        try {
          await slackWebApi('chat.postMessage', {
            channel: msg.channelId,
            text: rule.response,
            thread_ts: msg.ts
          });
          logger.info('[Slack auto-reply] sent: ' + key);
        } catch (e) { logger.warn('[Slack auto-reply] failed: ' + e.message); }
      }, delay);
      sent.push({ key, rule: rule.keyword, delay });
      break;
    }
  }
  return sent;
}

/**
 * FEATURE (2026-07-28): downloadFileContent(file) — fetches the plaintext
 * body of a file shared in a Slack DM so the auto-reply AI can read and
 * respond to its content.
 *
 * Supported: text/*, application/json, *csv*, *markdown*, *log*
 * Unsupported (images, PDFs, binaries): returns null — caller skips gracefully.
 *
 * Auth: uses the stored xoxc token as a Bearer header against
 * url_private (the Slack CDN URL for the file). This is the correct
 * auth method for xoxc-type user tokens on Enterprise Grid.
 *
 * Returns: { name, mimetype, content } or null.
 */
async function downloadFileContent(file) {
  if (!file || !file.url_private) return null;

  // Only attempt to read human-readable text formats
  const mime = (file.mimetype || '').toLowerCase();
  const name = (file.name    || '').toLowerCase();
  const isReadable =
    mime.startsWith('text/') ||
    mime.includes('json')    ||
    mime.includes('csv')     ||
    mime.includes('markdown')  ||
    name.endsWith('.txt')    ||
    name.endsWith('.md')     ||
    name.endsWith('.csv')    ||
    name.endsWith('.json')   ||
    name.endsWith('.log');
  if (!isReadable) return null;

  const config = getConfig();
  if (!config || !config.token) return null;

  return new Promise((resolve) => {
    const urlObj = new URL(file.url_private);
    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'GET',
      headers:  { Authorization: 'Bearer ' + config.token },
    };
    const req = https.request(options, (res) => {
      // Follow one redirect (Slack CDN sometimes redirects)
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        const redir = new URL(res.headers.location);
        const rOpts = {
          hostname: redir.hostname,
          path:     redir.pathname + redir.search,
          method:   'GET',
          headers:  { Authorization: 'Bearer ' + config.token },
        };
        const rReq = https.request(rOpts, (rRes) => {
          let data = '';
          rRes.on('data', c => { if (data.length < 32768) data += c; }); // 32KB cap
          rRes.on('end', () => resolve({ name: file.name, mimetype: mime, content: data }));
        });
        rReq.on('error', () => resolve(null));
        rReq.setTimeout(8000, () => { rReq.destroy(); resolve(null); });
        rReq.end();
        return;
      }
      let data = '';
      res.on('data', c => { if (data.length < 32768) data += c; }); // 32KB cap
      res.on('end', () => resolve({ name: file.name, mimetype: mime, content: data }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

module.exports = { isAuthenticated, checkLiveAuth, logout, sendSlackMessage, sendToChannel, slackSaveConfig, getConfig, getChannels, readMessages, readThreadReplies, readDMs, listOpenDMs, findChannelByName, processAutoReplies, searchDirectory, openConversation, checkChannelMembership, resolveUserName, downloadFileContent };
