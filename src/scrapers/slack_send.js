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

module.exports = { isAuthenticated, sendSlackMessage, slackSaveConfig, getConfig };
