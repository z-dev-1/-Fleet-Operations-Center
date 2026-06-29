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
    req.write(postData);
    req.end();
  });
}

/**
 * Find a user by name/alias using enterprise search
 * Returns user ID or null
 */
async function findUser(query) {
  // Try enterprise people search
  const result = await slackWebApi('search.modules', {
    query: query,
    module: 'people',
    count: '5'
  });

  if (result.ok && result.items && result.items.length > 0) {
    // Return best match
    return result.items[0].id;
  }

  return null;
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
  if (!res.ok) throw new Error('conversations.list failed: ' + res.error);
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
    ts:       m.ts,
    userId:   m.user || m.username || '',
    text:     m.text || '',
    threadTs: m.thread_ts || null,
    replyCount: m.reply_count || 0,
    channelId
  }));
}

/**
 * readDMs(limit) -- fetch most recent DM channels + last message
 */
async function readDMs(limit) {
  const lim = String(limit || 20);
  const res = await slackWebApi('conversations.list', {
    types: 'im', limit: lim, exclude_archived: 'true'
  });
  if (!res.ok) throw new Error('DM list failed: ' + res.error);
  const dms = (res.channels || []).filter(c => c.is_im);
  const results = [];
  for (const dm of dms.slice(0, 10)) {
    try {
      const hist = await readMessages(dm.id, 5);
      results.push({ channelId: dm.id, userId: dm.user, unread: dm.unread_count || 0, messages: hist });
    } catch (_) {}
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

module.exports = { isAuthenticated, sendSlackMessage, slackSaveConfig, getConfig, getChannels, readMessages, readDMs, findChannelByName, processAutoReplies };
