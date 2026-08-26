/**
 * ipc/ai.js - AI features IPC handlers
 * ai:suggest, ai:ask, ai:chat
 * orcha:get-config, orcha:save-config, orcha:test, orcha:status, orcha:mwinit, orcha:refresh-creds
 * daily-notes:open-windows, daily-notes:run, daily-notes:get-log
 *
 * V-C: session path uses P.aapCache (cross-platform) instead of hardcoded AppData\Roaming path.
 *
 * Stage 3 hardening (2026-06-28):
 *   - Issue #8  MED: daily-notes:run caps batch size (MAX_DAILY_NOTES_BATCH = 100) and
 *                    validates each unit has equipmentId before dispatch.
 *   - Issue #13 LOW: ai:chat indicates which path was used (chat vs fallback) in response.
 *   - Issue #15 LOW: ai:ask + ai:suggest cap prompt/unit payload size.
 *   - All handlers migrated to handle() wrapper.
 */

const { BrowserWindow, screen: eScreen, session: eSession } = require('electron');
const store  = require('../store');
const { P }  = require('../config/paths');
const logger = require('../utils/logger')('ipc:ai');
const fs     = require('fs');
const { handle, requireString, requireStringMax, requireArrayMax } = require('./_safe');
const { ConfigError } = require('../utils/errors');

// â”€â”€ Phase 3: IPC rate limiter for expensive AI operations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Prevents renderer from flooding AI backends (Bedrock $$, Orcha WS) with
// concurrent requests. Simple per-channel concurrency cap: excess calls queue
// and resolve in order. No external dependency.
function _createLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(() => {
          active--;
          if (queue.length > 0) queue.shift()();
        });
      };
      if (active < maxConcurrent) run();
      else queue.push(run);
    });
  };
}
const _aiAskLimit  = _createLimiter(1);  // max 1 concurrent ai:ask
const _aiChatLimit = _createLimiter(1);  // max 1 concurrent ai:chat

// â”€â”€ Issue #15 / #8: size caps â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const MAX_PROMPT_LEN       = 32000;   // characters â€” ai:ask, ai:chat
const MAX_DAILY_NOTES_BATCH = 100;   // units    â€” daily-notes:run
const MAX_SUGGEST_KEYS      = 100;   // keys on unit object for ai:suggest (raised S28: enriched units have ~71 keys)


// â”€â”€ Site / unit email report builder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns plain-text (not HTML) so the body renders correctly in OWA/mailto.
// Called from the EMAIL action handler when userMsg references a site or unit.
function _buildEmailReport(userMsg, rows, notesStore, allowedOperators) {
  const today = new Date().toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
  if (Array.isArray(allowedOperators) && allowedOperators.length) {
    var _allow = allowedOperators.map(function(o){ return String(o||"").toUpperCase().trim(); }).filter(Boolean);
    if (_allow.length) { rows = (rows || []).filter(function(r){ return _allow.indexOf((r.operator||"").toUpperCase()) !== -1; }); }
  }

  // Match against actual known sites/operators from the data â€” not a fixed regex.
  // This catches all-letter operator codes (AGNLI, TUZR, etc.) that the old
  // /[A-Z]{2,4}\d{2,3}/ pattern silently skipped.
  const msgUpper    = userMsg.toUpperCase();
  const knownSites  = [...new Set(rows.map(function(r){ return (r.domicileSite||'').toUpperCase(); }).filter(Boolean))];
  const knownOps    = [...new Set(rows.map(function(r){ return (r.operator||'').toUpperCase(); }).filter(Boolean))];
  const siteCode    = knownSites.find(function(s){ return s.length > 2 && msgUpper.includes(s); }) || null;
  const opCode      = !siteCode ? (knownOps.find(function(o){ return o.length > 2 && msgUpper.includes(o); }) || null) : null;
  const unitMatch   = userMsg.match(/\b([A-Za-z]?\d{5,8})\b/);
  const unitId      = unitMatch ? unitMatch[1].toUpperCase() : null;

  let targetRows = [];
  if (siteCode) {
    targetRows = rows.filter(function(r) {
      return (r.domicileSite||'').toUpperCase() === siteCode;
    });
  } else if (opCode) {
    targetRows = rows.filter(function(r) {
      return (r.operator||'').toUpperCase() === opCode;
    });
  } else if (unitId) {
    const r = rows.find(function(r){ return r.equipmentId === unitId; });
    if (r) targetRows = [r];
  }
  if (!targetRows.length) return null;

  const label   = siteCode || opCode || unitId;
  const total   = targetRows.length;
  const unavail = targetRows.filter(function(r){ return (r.lifecycleState||'').toLowerCase().includes('unavail'); });
  const avail   = targetRows.filter(function(r){ return !(r.lifecycleState||'').toLowerCase().includes('unavail'); });
  const uptakeRate = total ? Math.round((avail.length / total) * 100) : 0;

  const lines = [];
  lines.push('Fleet Report â€” ' + label);
  lines.push('Generated: ' + today);
  lines.push('');
  lines.push('SITE SUMMARY');
  lines.push('  Uptake Rate : ' + uptakeRate + '%');
  lines.push('  Total Units : ' + total);
  lines.push('  Available   : ' + avail.length);
  lines.push('  Unavailable : ' + unavail.length);

  if (unavail.length) {
    lines.push('');
    lines.push('UNAVAILABLE UNITS (' + unavail.length + ')');
    lines.push(('-').repeat(80));
    unavail.forEach(function(r) {
      const ns       = notesStore[r.equipmentId] || {};
      const timeline = (r.repairTimeline || ns.timeline || ns.notes || '').trim();
      const recentTl = timeline
        ? timeline.split('\n').slice(-5).join('\n          ')
        : 'No notes on file';
      lines.push('');
      lines.push('Unit     : ' + r.equipmentId + (r.assetType ? '  (' + r.assetType + ')' : ''));
      lines.push('Status   : ' + (r.lifecycleReason || r.lifecycleState || ''));
      lines.push('Vendor   : ' + (r.vendor || 'N/A'));
      lines.push('Down     : ' + (r.workDuration || 'unknown'));
      if (r.etc || r.pmBDue)
        lines.push('ETC/PM   : ' + (r.etc || r.pmBDue || ''));
      if (r.issueDetails || ns.issueSummary)
        lines.push('Issue    : ' + (r.issueDetails || ns.issueSummary || '').substring(0, 200));
      lines.push('Notes    : ' + recentTl);
      if (r.riskScore != null || r.riskLabel)
        lines.push('Uptake Risk : ' + (r.riskScore != null ? r.riskScore : 'N/A') + (r.riskLabel ? ' (' + r.riskLabel + ')' : ''));
    });
  }

  if (avail.length) {
    lines.push('');
    lines.push('AVAILABLE UNITS (' + avail.length + ')');
    lines.push(('-').repeat(80));
    avail.forEach(function(r) {
      lines.push('  ' + r.equipmentId + '  ' + (r.lifecycleState||'') + '  ' + (r.vendor||'') + (r.riskLabel ? '  Risk:' + r.riskLabel + (r.riskScore != null ? '(' + r.riskScore + ')' : '') : ''));
    });
  }

  // Uptake (fleet.uptake.com) predictive-maintenance insights â€” full detail,
  // not just risk score, so the AI has real diagnostic content to work with.
  const withInsights = targetRows.filter(function(r){ return Array.isArray(r.insightsList) && r.insightsList.length; });
  if (withInsights.length) {
    lines.push('');
    lines.push('UPTAKE INSIGHTS (fleet.uptake.com)');
    lines.push(('-').repeat(80));
    withInsights.forEach(function(r) {
      lines.push('');
      lines.push('Unit     : ' + r.equipmentId + (r.riskLabel ? '  Risk: ' + r.riskLabel + (r.riskScore != null ? ' (' + r.riskScore + ')' : '') : ''));
      if (r.vin) lines.push('VIN      : ' + r.vin);
      r.insightsList.forEach(function(ins) {
        lines.push('  - ' + (ins.title || 'Insight') + (ins.subsystem ? ' [' + ins.subsystem + ']' : '') + (ins.stillActive === false ? ' (resolved)' : ' (active)'));
        if (ins.guidance) lines.push('    Guidance : ' + String(ins.guidance).substring(0, 200));
        if (ins.summary)  lines.push('    Summary  : ' + String(ins.summary).substring(0, 200));
        if (ins.firstSeen || ins.lastSeen) lines.push('    Seen     : ' + (ins.firstSeen || '?') + ' \u2192 ' + (ins.lastSeen || '?'));
      });
    });
  } else if (targetRows.some(function(r){ return r.uptakeSynced; })) {
    lines.push('');
    lines.push('UPTAKE INSIGHTS: none flagged for this fleet segment.');
  }

  lines.push('');
  lines.push('---');
  lines.push('Sent from Fleet Operations Center');
  return lines.join('\n');
}

// â”€â”€ Unified Orcha action handler (used by bubble + main + phone companion) â”€â”€
// Builds the full fleet-context prompt (per-unit detail, contacts, memory,
// reminders), calls the AI, parses {reply, actions:[...]}, executes safe
// actions immediately, and returns pendingConfirm items for anything that
// sends externally (Slack/email) -- those require an explicit confirm step
// via confirmSend() below, regardless of caller (FAB button click or phone
// text reply).
// Simple deterministic fleet-count/status questions are answered directly
// from already-loaded rows/unavail data below, with NO AI call at all --
// requirement being: normal simple unit requests should bypass the AI
// cascade entirely rather than pay a 90-240s round trip for something a
// straight array filter/length can answer instantly and exactly.
function _tryFastPathAnswer(userMsg, rows, unavail) {
  const msg = (userMsg || '').trim().toLowerCase();
  // Anything with an action verb or a specific unit/site reference still
  // needs the full AI cascade -- only bare counting/status questions here.
  if (/\b(send|email|slack|remind|schedule|note|timeline|pin|unpin|move|create|draft)\b/.test(msg)) return null;
  if (/[A-Za-z]?\d{5,8}/.test(msg)) return null; // looks like a specific unit id

  const total = rows.length;
  if (!total) return null; // no fleet data loaded -- let the AI explain that itself

  if (/how many.*(unavailable|down|out of service)/.test(msg) || /^(unavailable|down)\s*count\??$/.test(msg)) {
    return unavail.length + ' of ' + total + ' units are currently unavailable.';
  }
  if (/how many.*\bavailable\b/.test(msg) && !/unavailable/.test(msg)) {
    return (total - unavail.length) + ' of ' + total + ' units are currently available.';
  }
  if (/how many (total )?(units|vehicles|trucks)\b/.test(msg)) {
    return 'There are ' + total + ' total units in the fleet.';
  }
  if (/uptake rate/.test(msg)) {
    const rate = Math.round(((total - unavail.length) / total) * 100);
    return 'Current uptake rate is ' + rate + '% (' + (total - unavail.length) + ' of ' + total + ' units available).';
  }
  return null;
}

// opts.signal    â€” optional AbortSignal threaded into relay.ask(); lets a
//                  caller (e.g. Slack Just Me's per-message job) cancel a
//                  hung AI call and clean up without waiting for the 240s
//                  outer safety timeout.
// opts.requestId â€” optional caller-supplied id for correlated logging.
async function processOrchaAction(userMsg, opts = {}) {
  requireStringMax(userMsg, 'userMsg', MAX_PROMPT_LEN);
    const store = require('../store');
    // Conversation memory (7 days)
    let chatHistory = store.load('chatHistory', []);
    const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    chatHistory = chatHistory.filter(function(m){ return m.ts > weekAgo; });
    
    // Keep last 20 exchanges max for token management
    if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40);
    
    const memoryContext = chatHistory.length > 0
      ? '\nRECENT CONVERSATION (remember this context):\n' + chatHistory.slice(-10).map(function(m){ return m.role + ': ' + m.text.substring(0, 150); }).join('\n') + '\n'
      : '';

    
    const relay = require('../orcha/relay');
    const fd = store.load('fleetData', {});
    const rows = fd.rows || [];
    const notesStore = store.load('notesStore', {});
    const unavail = rows.filter(r => (r.lifecycleState || '').toLowerCase().includes('unavail'));

    const _fastAnswer = _tryFastPathAnswer(userMsg, rows, unavail);
    if (_fastAnswer) {
      logger.info('[ai:orcha-action] fast-path answered directly from fleet data \u2014 AI cascade bypassed');
      chatHistory.push({role:'user', text:userMsg, ts:Date.now()});
      chatHistory.push({role:'ai', text:_fastAnswer, ts:Date.now()});
      store.save('chatHistory', chatHistory);
      return { ok: true, text: _fastAnswer, action: 'chat', fastPath: true };
    }

    // FIX (2026-08-17): the previous regex was /([A-Za-z]?\\d{5,8})/ â€” the
    // doubled backslash meant it matched a literal "\d", never an actual digit,
    // so unit-specific detail was NEVER attached (every unit summary went in
    // blind, and the model would hallucinate â€” e.g. asked for one unit, it
    // echoed a different ID with no real data). Rather than rely on a shape
    // guess at all, match against the REAL equipment IDs present in the fleet
    // data: find the longest equipmentId that appears as a whole token in the
    // message. This handles numeric IDs (208336), prefixed IDs (B62281,
    // AMZ3339, IND260155) and any future format without a brittle pattern.
    // FIX (2026-08-17): understand what the user MEANS the way they do.
    // One resolver (src/orcha/ai-context.js resolveEntities) matches the message
    // against the REAL units, domicile SITES, and OPERATORS in the data as whole
    // tokens â€” so "ABE40" resolves as the ABE40 site, "AMZ1997" as that unit,
    // "ABEOW" as the operator, etc. buildFleetContext then emits focused,
    // data-rich detail (unit timelines, or a site/operator roll-up) instead of
    // the old brittle /\d{5,8}/ regex that silently attached nothing.
    const { buildFleetContext, resolveEntities } = require('../orcha/ai-context');
    const _resolved = resolveEntities(userMsg, rows);
    const richContext = buildFleetContext(userMsg, {
      maxUnits: 8, includeTimeline: true, includePM: true, includeRisk: true,
    });

    // siteReport still used by the EMAIL/SLACK *action* paths below (they attach
    // a full plain-text report when delivering data to someone).
    const siteReport = _buildEmailReport(userMsg, rows, notesStore);

    // Anti-hallucination guard: only if the message names an ID-like token AND
    // the resolver found NOTHING (no unit, site, or operator) â€” then tell the
    // model plainly there's no data so it doesn't invent a summary. With the new
    // resolver this now correctly does NOT fire for real sites like ABE40.
    let notFoundNote = '';
    if (!_resolved.units.length && !_resolved.groups.length && rows.length) {
      const _idLike = (userMsg || '').match(/\b([A-Za-z]{2,}\d{1,}|[A-Za-z]?\d{4,})\b/);
      if (_idLike) {
        notFoundNote = '\\n\\nIMPORTANT: The fleet data currently loaded has NO unit, site, or operator matching "' + _idLike[1] + '". Do NOT invent or summarize data for it. Tell the user plainly that you have no data for "' + _idLike[1] + '" and ask them to confirm the ID.';
      }
    }
    // Load contact book
    const allContacts = store.load('contacts', []);
    const slackContacts = allContacts.filter(function(ct){ return ct.type === 'slack' && ct.slackId; });
    // Recent patterns for auto-suggest
    const recentPatterns = store.load('orchaPatterns', []).slice(-20);
    const frequentActions = {};
    recentPatterns.forEach(function(p){ (p.actions||[]).forEach(function(a){ frequentActions[a] = (frequentActions[a]||0) + 1; }); });

    const contactList = slackContacts.length 
      ? '\nKNOWN SLACK CONTACTS (you can also send to any email address or name not listed here):\n' + slackContacts.map(function(ct){ return '@' + ct.slackId + ' (' + ct.name + (ct.company ? ' - ' + ct.company : '') + ')'; }).join('\n') + '\n'
      : '';
    const emailContacts = allContacts.filter(function(ct){ return ct.email; });
    const emailContactList = emailContacts.length
      ? '\nEMAIL CONTACTS (use exact address for EMAIL action):\n' + emailContacts.map(function(ct){ return ct.name + ' <' + ct.email + '>'; }).join('\n') + '\n'
      : '';

    // Check due reminders
    const allReminders = store.load('reminders', []);
    const today = new Date().toISOString().split('T')[0];
    const dueReminders = allReminders.filter(function(r){ return r.when <= today; });
    const reminderText = dueReminders.length ? '\nDUE REMINDERS:\n' + dueReminders.map(function(r){ return r.unit + ': ' + r.note + ' (due ' + r.when + ')'; }).join('\n') + '\n' : '';

    // richContext (from resolveEntities/buildFleetContext) is the authoritative
    // data block: it already focuses on whatever units/site/operator the message
    // referenced, with fleet summary as the fallback. Keep contacts/reminders/
    // memory as supporting context. No more brittle unitDetail string.

    
    const d = new Date(); const dateStr = String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0'); const timeStr = String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
    const prompt = 'You are a professional fleet operations coordinator writing on behalf of the user. DATE:'+dateStr+' TIME (24h):'+timeStr+'\n\nPERSONALITY:\n- You communicate like a professional human â€” warm but concise\n- New messages (send/slack/message): ALWAYS start with appropriate greeting (Good morning/Good afternoon/Good evening based on time of day) then the content\n- Replies: Skip the greeting, just respond directly\n- Match what the user asks: update=status update, summary=brief summary, info=key details, follow-up=check on progress\n- If about a unit: focus on that unit only\n- If about a domicile/operator: focus on all units at that site/operator\n- If a DETAILED FLEET REPORT is provided below, that is your full and only source of truth for that site/operator/unit -- it has every unit status, vendor, down time, ETC/PM, issue details and full repair timeline/notes, plus the uptake rate (% available), AND -- separately -- any Uptake (fleet.uptake.com) predictive-maintenance risk score/label and full insight details (title, subsystem, guidance, active/resolved, first/last seen) under an UPTAKE INSIGHTS section for units that have been scraped by that third-party telematics tool. Uptake rate and Uptake insights are two different things -- do not conflate them, report both when present. Use ALL of it when relevant to what was asked: whether the user is asking a question (summarize thoroughly -- status, vendor, timeline, issue, uptake rate, uptake risk/insights) or sending it to someone (the system attaches the whole report; your job is just the intro line). Same data either way -- only the framing changes.\n- Keep Slack messages concise (3-5 sentences max), professional fleet language\n- Never add recommendations or suggestions unless user explicitly asks\n\nCRITICAL â€” SEND vs ASK:\n- "send update/report/data/notes to [person] for [site]" = YOU are DELIVERING fleet info TO them.\n  Write the message as the person SENDING the report, not asking for one.\n  Your message body is just a 1-sentence intro â€” the system attaches the real data automatically.\n  WRONG: "Could you provide an update on AVP40?" (that is asking them)\n  RIGHT:  "Here is the latest AVP40 fleet status and notes, as requested." (that is delivering)\n- Only generate a question/follow-up when the user explicitly says "ask", "follow up", or "check on".\n\nACTIONS (JSON): TIMELINE({type:TIMELINE,unit:ID,entry:MM/DD-note}), SLACK({type:SLACK,recipient:handle_or_email,message:text}), SYNC, SP_PUSH, EMAIL, READ_SLACK, REMIND({type:REMIND,unit:ID,when:YYYY-MM-DD,note:text}), DAILY_NOTES, DRAFT_FOLLOWUPS, CREATE_WR({type:CREATE_WR,unit:ID,issue:text}), MOVE_UNIT({type:MOVE_UNIT,unit:ID,status:available|unavailable,reason:text}) â€” changes the unit REAL lifecycle in AAP (available=Active, unavailable=Unavailable); reason optional, defaults to Healthy for Active; user confirms before it commits, PIN({type:PIN,unit:ID}), UNPIN({type:UNPIN,unit:ID}), SCHEDULE({type:SCHEDULE,action:text,cron:text}), EMAIL({type:EMAIL,to:email,subject:text,body:text})\n\nRESPOND WITH JSON ONLY: {"reply":"your brief confirmation","actions":[...]}\n\nRULES:\n- actions=[] if just answering a question\n- Do EXACTLY what user asks. No extras.\n- SLACK: Send to whoever the user specifies. If user gives an email address or a name not in KNOWN SLACK CONTACTS, use it directly as recipient â€” the system will resolve it. NEVER refuse or ask for confirmation because someone is not in the contact list. Just attempt the send.\n- SLACK message style: greeting (if new msg) + context + status/update/summary as requested. Sign off naturally.\n- TIMELINE: professional fleet note, MM/DD - 1-2 sentences max.\n- Never invent data.\\n\\n'+richContext+(siteReport?'\\n\\nDETAILED FLEET REPORT (for delivery/attachment):\\n'+siteReport:'')+notFoundNote+reminderText+memoryContext+contactList+emailContactList+'\\nUser: '+userMsg;
    try {
      logger.info('[ai:orcha-action] Calling relay.ask (' + prompt.length + ' chars)...');
      const aiText = await relay.ask(prompt, { signal: opts.signal, requestId: opts.requestId });
      logger.info('[ai:orcha-action] Got response: ' + (aiText ? aiText.length + ' chars' : 'EMPTY'));
      if (!aiText) return {ok:false,text:'AI empty',action:'chat'};
      let parsed; const jm = aiText.match(/\{[\s\S]*\}/);
      if (jm) try { parsed = JSON.parse(jm[0]); } catch(e) {}
      if (!parsed) return {ok:true,text:aiText,action:'chat'};
      const results = [];
      const pendingConfirm = [];
      for (const a of (parsed.actions||[])) {
        if (a.type==='TIMELINE'&&a.unit&&a.entry) { const ns=store.load('notesStore',{}); const u=ns[a.unit]||{}; u.timeline=u.timeline?u.timeline+'\\n'+a.entry:a.entry; ns[a.unit]=u; store.save('notesStore',ns); try { const _s = require('electron').BrowserWindow.getAllWindows()[0]; if(_s) _s.webContents.send('notes:updated',{unitId:a.unit,timeline:u.timeline}); } catch(e){} results.push('Timeline:'+a.unit+' done');
          try { require('../orcha/repair-history').addEvent(a.unit, {summary:a.entry,vendor:'',outcome:'in-progress'}); } catch(e){} }
        if (a.type==='SLACK'&&a.recipient&&a.message) {
          // Build real fleet data body.
          // If the user asked to send data for a site/operator but we have no fleet data
          // loaded yet, do NOT fall back to the AI's invented text (which is usually a
          // question asking the recipient for data â€” the opposite of what was intended).
          // Per-operator scoping: if the target contact is tagged with operators,
          // the report is hard-limited to those operators (empty = full, unchanged).
          var _scRL = a.recipient.toLowerCase().replace(/^@/, "");
          var _scContact = allContacts.find(function(ct){ return (ct.name && ct.name.toLowerCase().includes(_scRL)) || (ct.slackId && ct.slackId.toLowerCase() === _scRL) || (ct.email && ct.email.toLowerCase() === _scRL); });
          var _scOps = (_scContact && Array.isArray(_scContact.operators)) ? _scContact.operators : [];
          const realReport  = _buildEmailReport(userMsg, rows, notesStore, _scOps);
          const _msgUp      = userMsg.toUpperCase();
          const _knownS     = [...new Set(rows.map(r => (r.domicileSite||''). toUpperCase()).filter(Boolean))];
          const _knownO     = [...new Set(rows.map(r => (r.operator||''). toUpperCase()).filter(Boolean))];
          const _siteHit    = _knownS.find(s => s.length > 2 && _msgUp.includes(s))
                           || _knownO.find(o => o.length > 2 && _msgUp.includes(o));
          if (!realReport && _siteHit) {
            // User asked to send data for a known site but report is empty â€” stop, explain
            results.push('Slack not sent: no fleet data found for ' + _siteHit + '. Sync fleet data first.');
            continue; // eslint-disable-line no-continue
          }
          const slackBody = realReport || a.message;

          // Resolve recipient: contact book first (exact match), then fuzzy Slack search.
          // This prevents partial names like "zila" from matching the wrong Slack user.
          // Strip a leading @ -- the AI copies the exact "@slackId (Name)"
          // format shown in KNOWN SLACK CONTACTS, so a.recipient often comes
          // back as the literal Slack ID (e.g. "@U024WLE7Q11") rather than a
          // name. The old name-only .includes() check never matched that, so
          // the contact fell through to a raw findUser() search for the
          // literal ID string and failed with "Could not find recipient".
          const rLower = a.recipient.toLowerCase().replace(/^@/, '');
          const matchedContact = allContacts.find(ct =>
            (ct.name && ct.name.toLowerCase().includes(rLower)) ||
            (ct.slackId && ct.slackId.toLowerCase() === rLower) ||
            (ct.email && ct.email.toLowerCase() === rLower)
          );

          // Never send automatically â€” regardless of how the user phrased the
          // request, a real Slack send always needs an explicit confirm click.
          // This is the single choke point every AI-driven SLACK action passes
          // through, so no phrasing can bypass the confirmation prompt.
          pendingConfirm.push({
            id: 'pc' + Date.now() + Math.random().toString(36).slice(2, 6),
            channel: 'slack',
            recipientName: matchedContact ? matchedContact.name : a.recipient,
            contact: matchedContact || null,
            rawRecipient: a.recipient,
            body: slackBody,
            isRealData: !!realReport
          });
          results.push('Ready to send Slack message to ' + (matchedContact ? matchedContact.name : a.recipient) + ' â€” confirm below.');
        }
        if (a.type==='SYNC') results.push('Sync triggered');
        if (a.type==='SP_PUSH') results.push('SP push triggered');
        if (a.type==='EMAIL') {
          try {
            let toAddr = (a.to || '').trim();
            // If no @ in address, try to look up contact by name
            if (!toAddr.includes('@')) {
              const emailContact = allContacts.find(ct => ct.email &&
                ct.name.toLowerCase().includes(toAddr.toLowerCase()));
              if (emailContact) toAddr = emailContact.email;
            }
            if (!toAddr.includes('@')) {
              results.push('Email failed: no email address found for "' + (a.to||'') + '" â€” add one in Contact Book');
            } else {
              // Build a real data report. If user asked to send data for a known
              // site but we have nothing, stop â€” do not send AI's invented question.
              // Per-operator scoping for email recipients (empty = full, unchanged).
              var _emTo = (a.to || "").toLowerCase().trim();
              var _emC = allContacts.find(function(ct){ return (ct.email && ct.email.toLowerCase() === _emTo) || (ct.name && ct.name.toLowerCase().includes(_emTo)); });
              var _emScOps = (_emC && Array.isArray(_emC.operators)) ? _emC.operators : [];
              const reportHtml  = _buildEmailReport(userMsg, rows, notesStore, _emScOps);
              const _emMsgUp    = userMsg.toUpperCase();
              const _emSites    = [...new Set(rows.map(r => (r.domicileSite||''). toUpperCase()).filter(Boolean))];
              const _emOps      = [...new Set(rows.map(r => (r.operator||''). toUpperCase()).filter(Boolean))];
              const _emSiteHit  = _emSites.find(s => s.length > 2 && _emMsgUp.includes(s))
                               || _emOps.find(o => o.length > 2 && _emMsgUp.includes(o));
              if (!reportHtml && _emSiteHit) {
                results.push('Email not sent: no fleet data found for ' + _emSiteHit + '. Sync fleet data first.');
                continue;
              }
              const _knownSites2 = [...new Set(rows.map(function(r){ return (r.domicileSite||'').toUpperCase(); }).filter(Boolean))];
              const _knownOps2   = [...new Set(rows.map(function(r){ return (r.operator||'').toUpperCase(); }).filter(Boolean))];
              const _mu2         = userMsg.toUpperCase();
              const _label2      = _knownSites2.find(function(s){ return s.length>2&&_mu2.includes(s); })
                                || _knownOps2.find(function(o){ return o.length>2&&_mu2.includes(o); })
                                || null;
              const autoSubject = _label2
                ? 'Fleet Report \u2014 ' + _label2 + ' \u2014 ' + new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
                : null;
              // Never send automatically â€” same choke point as SLACK above.
              // Every AI-driven EMAIL action lands here and waits for confirm.
              pendingConfirm.push({
                id: 'pc' + Date.now() + Math.random().toString(36).slice(2, 6),
                channel: 'email',
                recipientName: toAddr,
                to: toAddr,
                subject: a.subject || autoSubject || 'Message from Fleet Operations Center',
                body: reportHtml || a.body || '',
                isRealData: !!reportHtml
              });
              results.push('Ready to email ' + toAddr + ' â€” confirm below.');
            }
          } catch(emailErr) { results.push('Email error: ' + emailErr.message); }
        }
        if (a.type==='DRAFT_FOLLOWUPS') {
          const stale = rows.filter(function(r){ return (r.lifecycleState||'').toLowerCase().includes('unavail') && r.vendor && r.vendor !== '--'; });
          const drafts = stale.slice(0,5).map(function(r){ return r.equipmentId + ' (' + r.vendor + '): Request status update â€” unit down ' + (r.workDuration||'?') + '.'; });
          results.push('Follow-up drafts:\n' + drafts.join('\n'));
        }
        if (a.type==='DAILY_NOTES') {
          const unavailUnits = rows.filter(function(r){ return (r.lifecycleState||'').toLowerCase().includes('unavail'); });
          const ns = store.load('notesStore', {});
          const today = new Date();
          const mm = String(today.getMonth()+1).padStart(2,'0');
          const dd = String(today.getDate()).padStart(2,'0');
          let count = 0;
          unavailUnits.forEach(function(r){
            const uid = r.equipmentId;
            const unit = ns[uid] || {};
            const vendor = r.vendor || 'no vendor';
            const reason = r.lifecycleReason || 'unknown';
            const entry = mm+'/'+dd+' - Status: '+reason+'. Vendor: '+vendor+'. Pending update.';
            unit.timeline = unit.timeline ? unit.timeline + '\n' + entry : entry;
            ns[uid] = unit;
            count++;
          });
          store.save('notesStore', ns);
          results.push('Daily notes: ' + count + ' units updated');
        }
        if (a.type==='DRAFT_FOLLOWUPS') {
          const stale = rows.filter(function(r){ return (r.lifecycleState||'').toLowerCase().includes('unavail') && r.vendor && r.vendor !== '--'; });
          const drafts = stale.slice(0,5).map(function(r){ return r.equipmentId + ' (' + r.vendor + '): Request status â€” down ' + (r.workDuration||'?'); });
          results.push('Follow-up drafts:\n' + drafts.join('\n'));
        }
        if (a.type==='CREATE_WR'&&a.unit&&a.issue) {
          // BUG FIX (2026-07-16): this previously pushed {unit, issue,
          // status:'pending'} into a local 'wrQueue' store key that NOTHING
          // ever reads back -- no background job, no UI list, nothing. It
          // fired a 'wr:created' IPC event that zero renderer code listens
          // for. The chat reply said "WR created for X" but nothing was
          // ever actually created in AAP -- a complete fake-success dead
          // end (confirmed by full codebase search: no consumer of wrQueue
          // or wr:created exists).
          //
          // Fixed: routes through the SAME AI-classification + review-queue
          // pipeline that partner-submitted WRs already use
          // (partner-wr.js's classifyRequest + 'partnerWRs_review' store
          // key) rather than either (a) still faking it, or (b) calling
          // aap_create_wr.js's createWorkRequest() directly with only
          // {unit, issue} and no vendor/area/subcategory -- the chat prompt
          // above doesn't extract those fields, and submitting an
          // incomplete WR straight to AAP from a casual chat message
          // without any human review is not an acceptable substitute for a
          // fake success. This way it gets AI-classified (title, area,
          // vendor, urgency) exactly like a partner-submitted request, and
          // shows up in the existing Review queue for one-click approval.
          try {
            const { classifyRequest } = require('./wr-classify');
            const review = store.load('partnerWRs_review', []);
            const reqId = 'CHAT-' + Date.now().toString(36).toUpperCase();
            let chatReq = {
              id: reqId, unit: a.unit, site: '', issue: a.issue,
              reportedBy: 'Orcha Chat', phone: '', photo: '',
              createdAt: new Date().toISOString(), status: 'classifying',
            };
            review.push(chatReq);
            store.save('partnerWRs_review', review);
            try {
              chatReq = await classifyRequest(chatReq, relay);
            } catch (classifyErr) {
              chatReq.status = 'pending';
              chatReq.aiError = classifyErr.message;
              logger.warn('[ai:orcha-action] CREATE_WR classify failed: ' + classifyErr.message);
            }
            const review2 = store.load('partnerWRs_review', []);
            const idx2 = review2.findIndex(r => r.id === reqId);
            if (idx2 !== -1) review2[idx2] = chatReq;
            store.save('partnerWRs_review', review2);
            try { const _w = require('electron').BrowserWindow.getAllWindows()[0]; if(_w) _w.webContents.send('partner:new-requests', { count: review2.length }); } catch(e){}
            results.push(chatReq.status === 'ready'
              ? 'Added to WR review queue for ' + a.unit + ': "' + (chatReq.aiTitle || a.issue) + '" â€” approve in Partner Requests to submit to AAP.'
              : 'Logged request for ' + a.unit + ' but AI classification failed â€” check Partner Requests review queue to fill in manually.');
          } catch (e) {
            results.push('Could not queue WR for ' + a.unit + ': ' + e.message);
          }
        }
        if (a.type==='MOVE_UNIT'&&a.unit&&a.status) {
          // MOVE_UNIT performs the REAL AAP lifecycle change (via setLifecycle),
          // not just a local display update. Route through pendingConfirm so a
          // conversational request ("make unit X available") requires an explicit
          // confirm click before mutating AAP â€” same safety gate as Slack/email.
          const fd2 = store.load('fleetData', {});
          const target = (fd2.rows||[]).find(function(r){return r.equipmentId===a.unit;});
          if (!target) {
            results.push('Cannot change lifecycle: unit ' + a.unit + ' not found in fleet data â€” sync first.');
          } else if (!target.assetUrl) {
            results.push('Cannot change lifecycle for ' + a.unit + ': no AAP asset URL (re-sync the app, then retry).');
          } else {
            const _state  = a.status === 'available' ? 'Active' : 'Unavailable';
            const _reason = (a.reason && String(a.reason).trim())
              ? String(a.reason).trim()
              : (_state === 'Active' ? 'Healthy' : '');
            // Open work-order awareness: if flipping to Active while an open WR
            // exists, surface it in the confirm prompt so the user knows AAP may
            // block it (they can still confirm to attempt â€” "insist").
            const _openU = parseInt(target.openUnplanned, 10) || 0;
            const _openP = parseInt(target.openPlanned, 10) || 0;
            const _woNote = (_state === 'Active' && (_openU + _openP) > 0)
              ? ' \u26a0 open WR (' + (_openU ? _openU + ' unplanned' : '') + (_openU && _openP ? ', ' : '') + (_openP ? _openP + ' planned' : '') + (target.vendor ? ' \u2014 ' + target.vendor : '') + ') \u2014 AAP may block; confirm to attempt anyway'
              : '';
            pendingConfirm.push({
              id: 'pc' + Date.now() + Math.random().toString(36).slice(2, 6),
              channel: 'lifecycle',
              recipientName: a.unit + ' \u2192 ' + _state + (_reason ? ' (' + _reason + ')' : '') + _woNote,
              equipmentId: target.equipmentId,
              assetUrl: target.assetUrl,
              state: _state,
              reason: _reason,
            });
          }
        }
        if (a.type==='PIN'&&a.unit) {
          const pins = store.load('pins', []);
          if (!pins.includes(a.unit)) { pins.push(a.unit); store.save('pins', pins); }
          try { const _w = require('electron').BrowserWindow.getAllWindows()[0]; if(_w) _w.webContents.send('pins:updated', pins); } catch(e){}
          results.push('Pinned ' + a.unit);
        }
        if (a.type==='UNPIN'&&a.unit) {
          let pins = store.load('pins', []);
          pins = pins.filter(function(p){return p !== a.unit;});
          store.save('pins', pins);
          try { const _w = require('electron').BrowserWindow.getAllWindows()[0]; if(_w) _w.webContents.send('pins:updated', pins); } catch(e){}
          results.push('Unpinned ' + a.unit);
        }
        if (a.type==='SCHEDULE'&&a.action&&a.cron) {
          const schedules = store.load('schedules', []);
          schedules.push({action:a.action, cron:a.cron, created:new Date().toISOString(), active:true});
          store.save('schedules', schedules);
          results.push('Scheduled: ' + a.action + ' (' + a.cron + ')');
        }
        // (duplicate EMAIL handler removed â€” handled above with real report body)
        if (a.type==='REMIND'&&a.unit&&a.when&&a.note) {
          const reminders = store.load('reminders', []);
          reminders.push({unit:a.unit, when:a.when, note:a.note, created:new Date().toISOString()});
          store.save('reminders', reminders);
          results.push('Reminder set: ' + a.unit + ' on ' + a.when);
        }
        if (a.type==='READ_SLACK') {
          const {readDMs} = require('../../src/scrapers/slack_send');
          try {
            const dms = await readDMs(10);
            if (dms && dms.length) {
              const summary = dms.slice(0,5).map(function(m){ return (m.user||'unknown') + ': ' + (m.text||'').substring(0,100); }).join('\n');
              results.push('ðŸ“© Recent messages:\n' + summary);
            } else { results.push('No new messages'); }
          } catch(e) { results.push('Slack read error: ' + e.message); }
        }
      }
      // Learn pattern
      try {
        const patterns = store.load('orchaPatterns', []);
        patterns.push({ts:Date.now(), input:userMsg, actions:(parsed.actions||[]).map(function(a){return a.type;})});
        if (patterns.length > 200) patterns.splice(0, patterns.length - 200);
        store.save('orchaPatterns', patterns);
      } catch(e){}
      // Save to conversation memory
      chatHistory.push({role:'user', text:userMsg, ts:Date.now()});
      chatHistory.push({role:'ai', text:parsed.reply||'', ts:Date.now()});
      store.save('chatHistory', chatHistory);
      return {ok:true,text:(parsed.reply||'')+(results.length?'\n'+results.join('\n'):''),action:results.length?'multi':'chat',pendingConfirm};
    } catch(e) { return {ok:false,text:'Error:'+e.message,action:'chat'}; }
}

// â”€â”€ Confirmed send â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// processOrchaAction() never sends directly -- it returns a pendingConfirm
// item (recipient + real report body) and the caller (FAB renderer or phone
// companion) must get an explicit confirmation before this runs. Nothing
// goes out without it.
async function confirmSend(item) {
  if (!item || !item.channel) return { ok: false, error: 'Nothing to send' };
  try {
    if (item.channel === 'slack') {
      const { sendSlackMessage, sendToChannel, openConversation } = require('../../src/scrapers/slack_send');
      const contact = item.contact;
      let r2;
      if (contact && contact.channelId) {
        r2 = await sendToChannel(contact.channelId, item.body);
      } else if (contact && contact.slackId) {
        const chId = await openConversation({ id: contact.slackId, type: 'person' });
        r2 = await sendToChannel(chId, item.body);
      } else if (contact && contact.email) {
        r2 = await sendSlackMessage(contact.email, item.body);
      } else {
        r2 = await sendSlackMessage(item.rawRecipient, item.body);
      }
      const sendOk = !!(r2 && r2.ok !== false);
      return sendOk
        ? { ok: true, message: 'Slack sent to ' + item.recipientName }
        : { ok: false, error: 'Slack send failed' };
    }
    if (item.channel === 'email') {
      const { sendFleetEmail } = require('../scrapers/email_sender');
      const emailRes = await sendFleetEmail({
        to: item.to,
        subject: item.subject,
        htmlBody: item.body ? '<pre>' + item.body.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</pre>' : '',
        plainText: item.body || '',
      });
      if (emailRes.ok) return { ok: true, message: 'Email sent to ' + item.to };
      // SMTP failed â€” open the in-app composer pre-filled so the user can still send.
      try {
        const _ew = require('electron').BrowserWindow.getAllWindows()[0];
        if (_ew) _ew.webContents.send('email:compose', { to: item.to, subject: item.subject, body: item.body || '' });
      } catch (_) {}
      return { ok: false, error: 'SMTP failed â€” composer opened instead' };
    }
    if (item.channel === 'lifecycle') {
      // Real AAP lifecycle mutation, gated behind the confirm click.
      const { setLifecycleState } = require('../scrapers/setLifecycle');
      const lr = await setLifecycleState({
        equipmentId: item.equipmentId,
        assetUrl:    item.assetUrl,
        state:       item.state,
        reason:      item.reason || '',
      });
      if (lr && lr.success) {
        try {
          const fd = store.load('fleetData', {});
          const t = (fd.rows||[]).find(r => r.equipmentId === item.equipmentId);
          if (t) {
            t.lifecycleState = item.state;
            if (item.reason) t.lifecycleReason = item.reason;
            store.save('fleetData', fd);
          }
          const _w = require('electron').BrowserWindow.getAllWindows()[0];
          if (_w) _w.webContents.send('fleet:refresh');
        } catch (_) {}
        return { ok: true, message: 'Unit ' + item.equipmentId + ' set to ' + item.state + (item.reason ? ' - ' + item.reason : '') + ' in AAP' };
      }
      return { ok: false, error: (lr && lr.message) || 'AAP did not confirm the lifecycle change' };
    }
    return { ok: false, error: 'Unknown channel: ' + item.channel };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function registerAIHandlers(ctx) {
  const { suggestDropdowns, askOrcha, sendOrchaChat, loadOrchaConfig, saveOrchaConfig } = require('../../src/scrapers/orcha_ws');
  const relay = require('../orcha/relay');
  const send  = ctx.sendToWindow;

  // Issue #15: prompt length cap
  handle('ai:suggest', async (_e, unit) => {
    if (!unit || typeof unit !== 'object') throw new ConfigError('unit must be an object', 'unit');
    const keyCount = Object.keys(unit).length;
    if (keyCount > MAX_SUGGEST_KEYS) {
      throw new ConfigError('unit object too large (' + keyCount + ' keys, max ' + MAX_SUGGEST_KEYS + ')', 'unit');
    }
    return suggestDropdowns(unit);
  });

  // Issue #15: prompt length cap
  // Phase 3: rate-limited to 1 concurrent call
  // FIX (2026-08-17): was using askOrcha (WS-only, no fallback) which hangs
  // when the Orcha WS queue is busy. Switch to relay.ask â€” the full automatic
  // chain (Orcha WS â†’ CLI â†’ Claude Code â†’ Bedrock) so ai:ask is reliable for
  // all callers (Daily Call AI Review, WBR Generate, etc.)
  handle('ai:ask', async (_e, prompt) => {
    requireStringMax(prompt, 'prompt', MAX_PROMPT_LEN);
    const text = await _aiAskLimit(() => relay.ask(prompt));
    // Normalize: relay.ask returns a raw string; callers expect { ok, text }
    if (typeof text === 'string') return { ok: true, text };
    return text; // in case it's already an object
  });

  // Issue #13: response now includes `path` field ('chat' or 'fallback')
  // so the renderer knows which code path ran.
  // Phase 3: rate-limited to 1 concurrent call
  handle('ai:chat', async (_e, prompt) => {
    requireStringMax(prompt, 'prompt', MAX_PROMPT_LEN);
    return _aiChatLimit(async () => {
    // Inject Orcha system directive into every chat call
    const { ORCHA_DIRECTIVE } = require('../orcha/system-prompt');
    // Inject live fleet data summary
    const store = require('../store');
    const fd = store.load('fleetData', {});
    const rows = fd.rows || [];
    const unavail = rows.filter(r => (r.lifecycleState || '').toLowerCase().includes('unavail'));
    const offsite = rows.filter(r => (r.lifecycleReason || '').toLowerCase().includes('offsite'));
    const fleetSummary = '\n\nLIVE FLEET DATA (' + rows.length + ' total units):\n'
      + 'Unavailable: ' + unavail.length + ' | Offsite: ' + offsite.length + ' | Available: ' + (rows.length - unavail.length) + '\n'
      + 'Unavailable units:\n'
      + unavail.slice(0, 40).map(r => r.equipmentId + ' | ' + (r.vendor || 'no vendor') + ' | ' + (r.lifecycleReason || '') + ' | ' + (r.domicileSite || '') + ' | Down: ' + (r.workDuration || '?')).join('\n')
      + '\n';
    prompt = ORCHA_DIRECTIVE + fleetSummary + '\n\nUser: ' + prompt;
    try {
      const text = await sendOrchaChat(prompt);
      return { ok: true, text, path: 'chat' };
    } catch (e) {
      logger.warn('Fleet Chat fallback to askOrcha:', e.message);
      const result = await askOrcha(prompt);
      // askOrcha may return a string or an object â€” normalise
      if (typeof result === 'string') return { ok: true, text: result, path: 'fallback' };
      return { ...result, path: 'fallback' };
    }
    });
  });

  // Orcha config
  handle('orcha:get-config',    () => loadOrchaConfig());
  handle('orcha:save-config',   (_e, config) => {
    logger.info('[AI Config] orcha:save-config called with aiPreference=' + (config && config.aiPreference));
    saveOrchaConfig(config);
    return { ok: true };
  });

  // Relay health / auth
  handle('orcha:test',          async () => relay.healthCheck());
  handle('orcha:status',        () => relay.getStatus());
  handle('orcha:mwinit',        async () => relay.runMwinit());
  handle('orcha:refresh-creds', () => { relay.refreshCredentials(); return { ok: true }; });

  // â”€â”€ AI Config (preference + per-backend config) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Returns full config: preference, orcha settings, claude settings + live status
  handle('ai:get-ai-config', () => {
    const orchaCfg = (() => {
      try {
        if (fs.existsSync(P.orchaConfig)) return JSON.parse(fs.readFileSync(P.orchaConfig, 'utf8'));
      } catch (_) {}
      return {};
    })();
    const os = require('os'), path = require('path');
    const claudeBin = process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'Toolbox', 'bin', 'claude.exe')
      : path.join(os.homedir(), '.toolbox', 'bin', 'claude');
    return {
      aiPreference:     relay.getPreference(),
      mode:             orchaCfg.mode || 'local',
      host:             orchaCfg.host || 'localhost',
      port:             orchaCfg.port || 4799,
      orchaAgentId:     orchaCfg.orchaAgentId || 'orcha_default',
      modelId:          orchaCfg.modelId || '',
      claudeBin,
      claudeTimeoutMs:  orchaCfg.claudeTimeoutMs || 60000,
      claudeAvailable:  require('fs').existsSync(claudeBin),
    };
  });

  // Save AI config â€” persists preference + both backends, hot-applies preference
  handle('ai:save-ai-config', (_e, config) => {
    const existing = (() => {
      try {
        if (fs.existsSync(P.orchaConfig)) return JSON.parse(fs.readFileSync(P.orchaConfig, 'utf8'));
      } catch (_) {}
      return {};
    })();
    const merged = {
      ...existing,
      mode:            config.mode             || existing.mode || 'local',
      host:            config.host             || existing.host || 'localhost',
      port:            config.port             || existing.port || 4799,
      aiPreference:    config.aiPreference     || 'auto',
      // Orcha agent selects the server-side model (orcha_default = Opus 4.6).
      orchaAgentId:    config.orchaAgentId     || existing.orchaAgentId || 'orcha_default',
      // Bedrock fallback model. Empty string is a valid "use app default" value,
      // so honor it explicitly when the key is present rather than dropping it.
      modelId:         (config.modelId !== undefined ? config.modelId : (existing.modelId || '')),
      claudeTimeoutMs: config.claudeTimeoutMs  || 60000,
    };
    const tmp = P.orchaConfig + '.tmp';
    fs.mkdirSync(require('path').dirname(P.orchaConfig), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
    fs.renameSync(tmp, P.orchaConfig);
    relay.setPreference(merged.aiPreference);
    relay.setClaudeTimeout(merged.claudeTimeoutMs);
    logger.info('[AI Config] Saved. preference=' + merged.aiPreference + ', agent=' + merged.orchaAgentId + ', modelId=' + (merged.modelId || '(default)') + ', claudeTimeoutMs=' + merged.claudeTimeoutMs);
    return { ok: true, preference: merged.aiPreference };
  });

  // Test the Claude Code path directly
  handle('ai:test-claude', () => relay.testClaude());

  // Daily Notes - open Relay + Offsite windows side-by-side (with auto-login)
  handle('daily-notes:open-windows', async (_e, opts) => {
    const { attachAutoLogin, partitionForUrl } = require('../orcha/auto-login');
    const { width, height } = eScreen.getPrimaryDisplay().workAreaSize;
    const halfW = Math.floor(width / 2);
    const winH  = Math.floor(height * 0.85);
    const topY  = Math.floor(height * 0.05);
    const windows = [];

    if (opts.relayUrl) {
      const partition = partitionForUrl(opts.relayUrl) || '';
      const ses = partition ? eSession.fromPartition(partition) : eSession.defaultSession;
      const relayWin = new BrowserWindow({
        width: halfW, height: winH, x: 0, y: topY,
        title: 'Relay Garage - ' + (opts.unitId || ''),
        icon: require('../config/app-icon').getAppIconPath(),
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: ses },
      });
      attachAutoLogin(relayWin, opts.relayUrl, { maxRetries: 3 });
      relayWin.loadURL(opts.relayUrl);
      windows.push(relayWin);
    }

    if (opts.offsiteUrl) {
      const partition = partitionForUrl(opts.offsiteUrl) || '';
      const ses = partition ? eSession.fromPartition(partition) : eSession.defaultSession;
      const offsiteWin = new BrowserWindow({
        width: halfW, height: winH, x: halfW, y: topY,
        title: 'Offsite Event - ' + (opts.unitId || ''),
        icon: require('../config/app-icon').getAppIconPath(),
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: ses },
      });
      attachAutoLogin(offsiteWin, opts.offsiteUrl, { maxRetries: 3 });
      offsiteWin.loadURL(opts.offsiteUrl);
      windows.push(offsiteWin);
    }

    if (windows.length === 1) {
      windows[0].setBounds({ x: Math.floor(width * 0.1), y: topY, width: Math.floor(width * 0.8), height: winH });
    }
    return { opened: windows.length };
  });

  // Issue #8: batch size cap + per-unit shape validation
  handle('daily-notes:run', async (_e, units) => {
    if (!Array.isArray(units) || units.length === 0) {
      throw new ConfigError('units must be a non-empty array', 'units');
    }
    if (units.length > MAX_DAILY_NOTES_BATCH) {
      throw new ConfigError(
        'daily-notes:run batch too large (' + units.length + ', max ' + MAX_DAILY_NOTES_BATCH + ')',
        'units'
      );
    }
    // Each element must have a non-empty equipmentId string
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (!u || typeof u !== 'object') {
        throw new ConfigError('units[' + i + '] must be an object', 'units');
      }
      if (typeof u.equipmentId !== 'string' || u.equipmentId.trim() === '') {
        throw new ConfigError('units[' + i + '].equipmentId must be a non-empty string', 'units');
      }
    }
    const { runDailyNotes } = require('../../src/scrapers/daily_notes');
    // V-C: use P.aapCache instead of hardcoded AppData path
    let session = { cookies: [] };
    try {
      if (fs.existsSync(P.aapCache)) session = JSON.parse(fs.readFileSync(P.aapCache, 'utf8'));
    } catch (_) { /* no session yet - proceed without cookies */ }
    return runDailyNotes(units, session, askOrcha, (msg) => {
      logger.info(msg);
      if (send) send('daily-notes:progress', msg);
    });
  });

  handle('daily-notes:get-log', () => {
    const { loadNotesLog } = require('../../src/scrapers/daily_notes');
    return loadNotesLog();
  });
  // S28: Append entry to unit timeline
  handle('ai:append-timeline', async (_e, data) => {
    if (!data || !data.unitId || !data.entry) throw new ConfigError('unitId and entry required', 'data');
    const store = require('../store');
    const ns = store.load('notesStore', {});
    const unit = ns[data.unitId] || {};
    const existing = unit.timeline || '';
    unit.timeline = existing ? existing + '\n' + data.entry : data.entry;
    // Track as a manually-confirmed entry (immutable truth) so a later Orcha
    // deep-scan regeneration merges it back in instead of discarding it when
    // it rebuilds the timeline from raw vendor comments.
    unit.manualEntries = Array.isArray(unit.manualEntries) ? unit.manualEntries : [];
    unit.manualEntries.push(data.entry);
    ns[data.unitId] = unit;
    store.save('notesStore', ns);
    
    // Also update fleet_data row
    const fd = store.load('fleetData', {});
    if (fd.rows) {
      const row = fd.rows.find(r => r.equipmentId === data.unitId);
      if (row) row.repairTimeline = unit.timeline;
      store.save('fleetData', fd);
    }

    // Notify renderer for instant refresh (parity with notes:add-timeline)
    try {
      const wins = require('electron').BrowserWindow.getAllWindows();
      const main = wins.find(w => !w.isDestroyed() && w.webContents.getURL().includes('localhost:5173'));
      if (main) main.webContents.send('notes:updated', { unitId: data.unitId, timeline: unit.timeline });
    } catch (e) { /* no active renderer window yet */ }

    logger.info('[AI] Timeline appended for ' + data.unitId + ': ' + data.entry.substring(0, 60));
    return { ok: true };
  });
  // â”€â”€ Unified Orcha action handler (used by bubble + main) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  handle('ai:orcha-action', async (_e, userMsg) => processOrchaAction(userMsg));

  // â”€â”€ Confirmed send â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // ai:orcha-action never sends directly â€” it returns a pendingConfirm item
  // (recipient + real report body) and the renderer shows Send/Cancel buttons.
  // This handler fires ONLY after the user explicitly clicks Send. Regardless
  // of how the original request was phrased, nothing ever goes out without it.
  handle('ai:confirm-send', async (_e, item) => confirmSend(item));




  // Load saved AI preference at startup so relay.ask() uses the correct
  // path immediately -- without this, relay defaults to 'auto' on every
  // restart regardless of what the user saved in AI Config.
  try {
    if (fs.existsSync(P.orchaConfig)) {
      const saved = JSON.parse(fs.readFileSync(P.orchaConfig, 'utf8'));
      if (saved.aiPreference && ['auto', 'orcha', 'claude'].includes(saved.aiPreference)) {
        relay.setPreference(saved.aiPreference);
        logger.info('[AI Config] Startup: loaded preference=' + saved.aiPreference);
      }
    }
  } catch (e) {
    logger.warn('[AI Config] Startup: failed to load saved preference:', e.message);
  }

  // Direct email send from chat compose bubble.
  // Strategy:
  //   1. SMTP (silent) -- if password is configured in Settings -> Accounts -> Email
  //   2. OWA in-app window -- opens an Electron BrowserWindow with the OWA compose URL
  //      pre-filled (To, Subject, Body). Uses the existing session so auth is shared.
  //      Defaults to Office 365 OWA; override via emailConfig.owaUrl.
  handle('ai:send-email', async (_e, data) => {
    if (!data || !data.to || !data.body) throw new Error('to and body required');
    requireStringMax(data.to,   'to',   256);
    if (data.subject) requireStringMax(data.subject, 'subject', 256);
    requireStringMax(data.body, 'body', 32000); // fleet reports can be large

    const { sendFleetEmail, loadEmailConfig } = require('../scrapers/email_sender');
    const cfg    = loadEmailConfig();
    const method = cfg.emailMethod || 'auto';
    // Use <pre> so plain-text fleet reports render with correct spacing on SMTP.
    // OWA path uses data.body (plain text) in the &body= URL param â€” no HTML.
    const htmlBody = '<pre style="font-family:Courier New,monospace;font-size:12px;white-space:pre-wrap">'
      + (data.body || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      + '</pre>';

    // Helper: open OWA compose window
    function openOWACompose() {
      const { BrowserWindow, session: eSession } = require('electron');
      const { getAppIconPath } = require('../config/app-icon');
      const owaBase = (cfg.owaUrl || 'https://outlook.office365.com/mail/deeplink/compose').replace(/\/$/, '');
      const owaUrl  = owaBase
        + '?to='      + encodeURIComponent(data.to)
        + '&subject=' + encodeURIComponent(data.subject || 'Message from Fleet Operations Center')
        + '&body='    + encodeURIComponent(data.body || '');
      const owaWin = new BrowserWindow({ width: 960, height: 720, title: 'Compose Email â€” ' + data.to, icon: getAppIconPath(), webPreferences: { nodeIntegration: false, contextIsolation: true, session: eSession.defaultSession } });
      owaWin.setMenu(null);
      owaWin.loadURL(owaUrl);
      owaWin.once('ready-to-show', () => owaWin.show());
      return { ok: true, method: 'owa' };
    }

    // â”€â”€ Graph â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (method === 'graph' || method === 'auto') {
      try {
        const graphClient = require('../graph/client');
        if (await graphClient.isSignedIn()) {
          const res = await graphClient.sendMail({ to: data.to, subject: data.subject || 'Message from Fleet Operations Center', htmlBody });
          if (res.ok) return { ok: true, method: 'graph' };
        } else if (method === 'graph') {
          return { ok: false, error: 'Microsoft Graph: not signed in. Go to Settings -> Outlook (Microsoft Graph).' };
        }
      } catch (e) {
        logger.warn('[ai:send-email] Graph failed:', e.message);
        if (method === 'graph') return { ok: false, error: 'Graph failed: ' + e.message };
      }
    }

    // â”€â”€ SMTP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (method === 'smtp' || (method === 'auto' && (cfg.password || cfg.pass) && (cfg.password || cfg.pass).trim())) {
      const res = await sendFleetEmail({ to: data.to, subject: data.subject || 'Message from Fleet Operations Center', htmlBody });
      if (res.ok) return { ok: true, method: 'smtp' };
      logger.warn('[ai:send-email] SMTP failed (' + res.error + ')' + (method === 'smtp' ? '' : ', falling back to OWA'));
      if (method === 'smtp') return { ok: false, error: res.error || 'SMTP failed' };
    }

    // â”€â”€ OWA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    return openOWACompose();
  });


  // â”€â”€ ai:build-report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Called by the renderer's direct data-send interceptor BEFORE the AI ever
  // sees the message. Extracts the site/operator from the query, pulls matching
  // rows from the fleet store, and returns the plain-text report that the compose
  // bubble pre-fills. No AI involved â€” pure data retrieval.
  handle('ai:build-report', (_e, opts) => {
    const query = (opts && opts.query) || '';
    const store = require('../store');
    const fd    = store.load('fleetData', {});
    const rows  = fd.rows || [];
    const notesStore = store.load('notesStore', {});

    if (!rows.length) {
      return { ok: false, error: 'No fleet data loaded â€” sync first.' };
    }

    const report = _buildEmailReport(query, rows, notesStore);
    if (!report) {
      // Also try extracting a site code directly from the query and checking
      // if it appears anywhere in the data, to give a more helpful error.
      const msgUp = query.toUpperCase();
      const allSites = [...new Set(rows.map(r => (r.domicileSite||'').toUpperCase()).filter(Boolean))];
      const allOps   = [...new Set(rows.map(r => (r.operator||'').toUpperCase()).filter(Boolean))];
      const hit = allSites.find(s => s.length > 2 && msgUp.includes(s))
               || allOps.find(o => o.length > 2 && msgUp.includes(o));
      return {
        ok: false,
        error: hit
          ? 'No units found for ' + hit + ' in current fleet data.'
          : 'No site or operator recognized in your message. Try including the site code (e.g. AVP40).',
      };
    }

    // Extract site label for the subject line
    const msgUp2   = query.toUpperCase();
    const allSites2 = [...new Set(rows.map(r => (r.domicileSite||'').toUpperCase()).filter(Boolean))];
    const allOps2   = [...new Set(rows.map(r => (r.operator||'').toUpperCase()).filter(Boolean))];
    const label     = allSites2.find(s => s.length > 2 && msgUp2.includes(s))
                   || allOps2.find(o => o.length > 2 && msgUp2.includes(o))
                   || 'Fleet';

    return { ok: true, report, label };
  });

  logger.info('AI IPC handlers registered');
}

module.exports = { registerAIHandlers, processOrchaAction, confirmSend };
