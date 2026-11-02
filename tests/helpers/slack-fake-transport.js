'use strict';
// tests/helpers/slack-fake-transport.js
//
// Phase 4b shared harness: a scripted, in-memory Slack Web API transport for
// the REAL src/scrapers/slack_send.js (installed through _setRawRequestForTests).
// No network, no real Slack, no real credentials -- the slack_config.json it
// writes holds fake placeholder values only.
//
// Fixture model (raw Slack shapes):
//   fake.ims   = [{ id, has_unreads, latest }]           client.counts ims
//   fake.mpims = [{ id, has_unreads, latest }]           client.counts mpims
//   fake.conv[id] = { peer, isMpim, name, members, messages: [raw], replies: { [parentTs]: [raw parent, ...raw replies] } }
//   raw message = { ts, user, text, reply_count, latest_reply, thread_ts, files }
// Every call is recorded as [method, params] in fake.calls. Any method the
// fixture does not script answers { ok:false, error:'unscripted:<m>' } and is
// recorded in fake.unscripted (tests assert it stays empty).

const fs = require('fs');
const path = require('path');

const SLACK_SEND = path.join(__dirname, '..', '..', 'src', 'scrapers', 'slack_send.js');

function _cmp(a, b) { return parseFloat(a) - parseFloat(b); }

function createFakeSlack(opts = {}) {
  const fake = {
    me: opts.me || 'UME',
    latencyMs: opts.latencyMs || 0,
    ims: [], mpims: [], conv: {},
    calls: [], unscripted: [], posts: [],
    infoFail: new Set(),        // channel ids whose conversations.info answers ok:false
    historyFail: new Set(),     // channel ids whose conversations.history answers ok:false
    repliesFail: new Set(),     // 'ch:ts' keys whose conversations.replies answers ok:false
    rateLimit: [],              // queue of { method, retryAfter } -> next matching call answers __rateLimited
    postSeq: 0,
    hooks: {},                  // method -> fn(params) called before answering (scripted races)
  };

  function answer(method, params) {
    const rl = fake.rateLimit.findIndex(r => r.method === method);
    if (rl !== -1) { const r = fake.rateLimit.splice(rl, 1)[0]; return { __rateLimited: true, retryAfter: r.retryAfter == null ? null : r.retryAfter }; }
    switch (method) {
      case 'auth.test': return { ok: true, user_id: fake.me, user: 'me', team: 'T' };
      case 'client.counts': return { ok: true, ims: fake.ims.map(x => ({ ...x })), mpims: fake.mpims.map(x => ({ ...x })), channels: [] };
      case 'conversations.info': {
        const c = fake.conv[params.channel];
        if (!c || fake.infoFail.has(params.channel)) return { ok: false, error: 'channel_not_found' };
        if (c.isMpim) return { ok: true, channel: { id: params.channel, is_mpim: true, name: c.name || params.channel } };
        return { ok: true, channel: { id: params.channel, user: c.peer, name: c.name } };
      }
      case 'users.info': return { ok: true, user: { id: params.user, real_name: 'Name ' + params.user } };
      case 'conversations.members': {
        const c = fake.conv[params.channel];
        return { ok: true, members: (c && c.members) || [] };
      }
      case 'conversations.history': {
        const c = fake.conv[params.channel];
        if (!c || fake.historyFail.has(params.channel)) return { ok: false, error: 'channel_not_found' };
        let msgs = (c.messages || []).slice().sort((a, b) => _cmp(b.ts, a.ts));
        if (params.oldest != null) {
          msgs = msgs.filter(m => params.inclusive === 'false' ? _cmp(m.ts, params.oldest) > 0 : _cmp(m.ts, params.oldest) >= 0);
        }
        const lim = parseInt(params.limit, 10) || 100;
        return { ok: true, messages: msgs.slice(0, lim).map(m => ({ ...m })), has_more: false };
      }
      case 'conversations.replies': {
        const c = fake.conv[params.channel];
        if (!c || fake.repliesFail.has(params.channel + ':' + params.ts)) return { ok: false, error: 'thread_not_found' };
        let thread = (c.replies || {})[params.ts];
        if (!thread) {
          // A reply ts resolves to its parent's thread (Slack behavior, A3).
          for (const k of Object.keys(c.replies || {})) {
            if ((c.replies[k] || []).some(m => m.ts === params.ts)) { thread = c.replies[k]; break; }
          }
        }
        const lim = parseInt(params.limit, 10) || 100;
        return { ok: true, messages: (thread || []).slice(0, lim).map(m => ({ ...m })), has_more: false };
      }
      case 'chat.postMessage': {
        fake.postSeq++;
        fake.posts.push({ channel: params.channel, text: params.text, thread_ts: params.thread_ts });
        return { ok: true, ts: 'R' + fake.postSeq };
      }
      default:
        fake.unscripted.push(method);
        return { ok: false, error: 'unscripted:' + method };
    }
  }

  fake.transport = async (method, params) => {
    fake.calls.push([method, { ...(params || {}) }]);
    if (fake.hooks[method]) { try { fake.hooks[method](params); } catch (_) {} }
    const res = answer(method, params || {});
    if (fake.latencyMs) await new Promise(r => setTimeout(r, fake.latencyMs));
    return res;
  };
  fake.count = (method) => fake.calls.filter(c => !method || c[0] === method).length;
  fake.reset = () => { fake.calls.length = 0; fake.unscripted.length = 0; fake.posts.length = 0; };
  return fake;
}

// Load the REAL slack_send against `fake`. The data dir must already be set
// (P.slackConfig is captured when slack_send loads). Writes fake credentials.
function loadRealSlackSend(req, dataDir, fake) {
  fs.writeFileSync(path.join(dataDir, 'slack_config.json'), JSON.stringify({ token: 'xoxc-test', allCookieHeader: 'd=test' }));
  delete req.cache[SLACK_SEND];
  const ss = req(SLACK_SEND);
  ss._resetForTests();
  ss._setRawRequestForTests(fake.transport);
  return ss;
}

// Drive a promise to completion under vi.useFakeTimers().
async function drive(p, vi, stepMs = 25, maxSteps = 400000) {
  let done = false, val, err;
  p.then(v => { done = true; val = v; }, e => { done = true; err = e; });
  for (let i = 0; !done && i < maxSteps; i++) await vi.advanceTimersByTimeAsync(stepMs);
  if (!done) throw new Error('drive: promise did not settle');
  if (err) throw err;
  return val;
}

module.exports = { createFakeSlack, loadRealSlackSend, drive, SLACK_SEND };
