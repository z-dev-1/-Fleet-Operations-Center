/**
 * ask-internal.js
 * Relays a question to the internal Amazon AI agent "AITeammate" (a Slack DM)
 * and waits for its reply, so the personal assistant (FAB + only-me Slack) can
 * seek internal guidance for questions it can't answer from its own knowledge
 * or fleet data.
 *
 * Flow:
 *   1. Post the question into the AITeammate DM channel.
 *   2. Poll the channel history for a NEW message that isn't ours (i.e. the
 *      agent's answer, with ts newer than what we posted).
 *   3. Return that answer text, or a graceful timeout note.
 *
 * AITeammate is an AI agent, so replies can take longer than a canned bot —
 * we poll up to ASK_TIMEOUT_MS.
 */

const logger = require('../utils/logger').createLogger('ask-internal');

// The AITeammate DM channel id (internal Amazon AI agent).
const AITEAMMATE_CHANNEL = 'D0BTCKCQKA9';

const ASK_TIMEOUT_MS   = 75000; // total wait for the agent's reply (agent can be slow)
const POLL_INTERVAL_MS = 3000;  // how often to check for a reply
const FIRST_WAIT_MS    = 2500;  // small delay before the first poll

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * askInternal(question) -> { ok, answer, error }
 * Sends `question` to AITeammate and returns its reply text.
 */
async function askInternal(question) {
  const q = (question || '').trim();
  if (!q) return { ok: false, error: 'empty question' };

  let slack;
  try { slack = require('../scrapers/slack_send'); }
  catch (e) { return { ok: false, error: 'slack module unavailable: ' + e.message }; }

  const { sendToChannel, readMessages, checkLiveAuth } = slack;

  // Confirm auth + get our own user id so we can tell our message apart from
  // the agent's reply.
  let myUserId = '';
  try {
    const auth = await checkLiveAuth();
    if (!auth || !auth.authenticated) return { ok: false, error: 'Slack not authenticated' };
    myUserId = auth.userId || '';
  } catch (e) {
    return { ok: false, error: 'auth check failed: ' + e.message };
  }

  // 1. Post the question.
  let sentTs;
  try {
    const res = await sendToChannel(AITEAMMATE_CHANNEL, q);
    sentTs = res && res.ts ? parseFloat(res.ts) : (Date.now() / 1000);
    logger.info('[ask-internal] question sent to AITeammate (ts=' + sentTs + '): ' + q.slice(0, 120));
  } catch (e) {
    return { ok: false, error: 'could not send to AITeammate: ' + e.message };
  }

  // 2. Poll for the agent's reply (newest message not authored by us, newer
  //    than our sent message).
  await sleep(FIRST_WAIT_MS);
  const deadline = Date.now() + ASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const msgs = await readMessages(AITEAMMATE_CHANNEL, 10); // newest-first
      // Find the newest message strictly after our question that we didn't author.
      const reply = (msgs || [])
        .filter(m => parseFloat(m.ts) > sentTs)
        .filter(m => !myUserId || m.userId !== myUserId)
        .filter(m => (m.text || '').trim().length > 0)
        .sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts))[0];
      if (reply) {
        logger.info('[ask-internal] AITeammate replied (' + (reply.text || '').length + ' chars)');
        return { ok: true, answer: reply.text };
      }
    } catch (e) {
      logger.warn('[ask-internal] poll error (will retry): ' + e.message);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  logger.warn('[ask-internal] timed out waiting for AITeammate reply');
  return { ok: false, error: 'timeout', timedOut: true };
}

module.exports = { askInternal, AITEAMMATE_CHANNEL };
