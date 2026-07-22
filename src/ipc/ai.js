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

// ── Issue #15 / #8: size caps ────────────────────────────────────────────────
const MAX_PROMPT_LEN       = 32000;   // characters — ai:ask, ai:chat
const MAX_DAILY_NOTES_BATCH = 100;   // units    — daily-notes:run
const MAX_SUGGEST_KEYS      = 100;   // keys on unit object for ai:suggest (raised S28: enriched units have ~71 keys)

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
  handle('ai:ask', async (_e, prompt) => {
    requireStringMax(prompt, 'prompt', MAX_PROMPT_LEN);
    return askOrcha(prompt);
  });

  // Issue #13: response now includes `path` field ('chat' or 'fallback')
  // so the renderer knows which code path ran.
  handle('ai:chat', async (_e, prompt) => {
    requireStringMax(prompt, 'prompt', MAX_PROMPT_LEN);
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
      // askOrcha may return a string or an object — normalise
      if (typeof result === 'string') return { ok: true, text: result, path: 'fallback' };
      return { ...result, path: 'fallback' };
    }
  });

  // Orcha config
  handle('orcha:get-config',    () => loadOrchaConfig());
  handle('orcha:save-config',   (_e, config) => { saveOrchaConfig(config); return { ok: true }; });

  // Relay health / auth
  handle('orcha:test',          async () => relay.healthCheck());
  handle('orcha:status',        () => relay.getStatus());
  handle('orcha:mwinit',        async () => relay.runMwinit());
  handle('orcha:refresh-creds', () => { relay.refreshCredentials(); return { ok: true }; });

  // ── AI Config (preference + per-backend config) ────────────────────────
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
      claudeBin,
      claudeTimeoutMs:  orchaCfg.claudeTimeoutMs || 60000,
      claudeAvailable:  require('fs').existsSync(claudeBin),
    };
  });

  // Save AI config — persists preference + both backends, hot-applies preference
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
      claudeTimeoutMs: config.claudeTimeoutMs  || 60000,
    };
    const tmp = P.orchaConfig + '.tmp';
    fs.mkdirSync(require('path').dirname(P.orchaConfig), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
    fs.renameSync(tmp, P.orchaConfig);
    relay.setPreference(merged.aiPreference);
    logger.info('[AI Config] Saved. preference=' + merged.aiPreference);
    return { ok: true, preference: merged.aiPreference };
  });

  // Test the Claude Code path directly
  handle('ai:test-claude', () => relay.testClaude());

  // Daily Notes - open Relay + Offsite windows side-by-side
  handle('daily-notes:open-windows', async (_e, opts) => {
    const spSes = eSession.defaultSession;
    const { width, height } = eScreen.getPrimaryDisplay().workAreaSize;
    const halfW = Math.floor(width / 2);
    const winH  = Math.floor(height * 0.85);
    const topY  = Math.floor(height * 0.05);
    const windows = [];

    if (opts.relayUrl) {
      const relayWin = new BrowserWindow({
        width: halfW, height: winH, x: 0, y: topY,
        title: 'Relay Garage - ' + (opts.unitId || ''),
        icon: require('../config/app-icon').getAppIconPath(),
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: spSes },
      });
      relayWin.loadURL(opts.relayUrl);
      windows.push(relayWin);
    }

    if (opts.offsiteUrl) {
      const offsiteWin = new BrowserWindow({
        width: halfW, height: winH, x: halfW, y: topY,
        title: 'Offsite Event - ' + (opts.unitId || ''),
        icon: require('../config/app-icon').getAppIconPath(),
        webPreferences: { nodeIntegration: false, contextIsolation: true, session: spSes },
      });
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
  // ── Unified Orcha action handler (used by bubble + main) ────────────────
  handle('ai:orcha-action', async (_e, userMsg) => {
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
    const unitMatch = userMsg.match(/([A-Za-z]?\\d{5,8})/);
    let unitDetail = '';
    if (unitMatch) {
      const uid = unitMatch[1].toUpperCase();
      const unit = rows.find(r => r.equipmentId === uid);
      const notes = notesStore[uid] || {};
      if (unit) unitDetail = '\\nUNIT ' + uid + ': Vendor=' + (unit.vendor||'none') + ' Life=' + (unit.lifecycleState||'') + '/' + (unit.lifecycleReason||'') + ' Site=' + (unit.domicileSite||'') + ' Down=' + (unit.workDuration||'?') + ' Issue=' + (unit.issueDetails||notes.issueSummary||'') + '\\nTimeline: ' + (notes.timeline||'none');
    }
    // Load contact book
    const allContacts = store.load('contacts', []);
    const slackContacts = allContacts.filter(function(ct){ return ct.type === 'slack' && ct.slackId; });
    // Recent patterns for auto-suggest
    const recentPatterns = store.load('orchaPatterns', []).slice(-20);
    const frequentActions = {};
    recentPatterns.forEach(function(p){ (p.actions||[]).forEach(function(a){ frequentActions[a] = (frequentActions[a]||0) + 1; }); });

    const contactList = slackContacts.length 
      ? '\nSLACK CONTACTS (use exact handle when sending):\n' + slackContacts.map(function(ct){ return '@' + ct.slackId + ' (' + ct.name + (ct.company ? ' - ' + ct.company : '') + ')'; }).join('\n') + '\n'
      : '';

    // Check due reminders
    const allReminders = store.load('reminders', []);
    const today = new Date().toISOString().split('T')[0];
    const dueReminders = allReminders.filter(function(r){ return r.when <= today; });
    const reminderText = dueReminders.length ? '\nDUE REMINDERS:\n' + dueReminders.map(function(r){ return r.unit + ': ' + r.note + ' (due ' + r.when + ')'; }).join('\n') + '\n' : '';

    const fleetSummary = 'FLEET:' + rows.length + ' total|' + unavail.length + ' unavail\\n' + unavail.slice(0,30).map(function(r){return r.equipmentId+' | '+(r.vendor||'-')+' | '+(r.domicileSite||'')+' | '+(r.operator||'')+' | Down:'+(r.workDuration||'?')+' | ETC:'+(r.etc||'-')+' | Risk:'+(r.riskScore||'-')}).join('\n');
    // Token management — keep prompt under ~3000 chars to leave room for response
    const TOKEN_BUDGET = 3000;
    let promptParts = [fleetSummary, contactList, reminderText, memoryContext, unitDetail];
    let totalLen = promptParts.join('').length;
    
    // If over budget, trim in priority order (least important first)
    if (totalLen > TOKEN_BUDGET) {
      // 1. Trim fleet summary to 15 units
      const shortFleet = 'FLEET:' + rows.length + ' total|' + unavail.length + ' unavail\n' +
        unavail.slice(0,15).map(function(r){return r.equipmentId+' | '+(r.vendor||'-')+' | '+(r.domicileSite||'')}).join('\n');
      promptParts[0] = shortFleet;
    }
    totalLen = promptParts.join('').length;
    if (totalLen > TOKEN_BUDGET) {
      // 2. Trim memory to last 5 exchanges
      const shortMem = chatHistory.length > 0
        ? '\nRECENT:\n' + chatHistory.slice(-5).map(function(m){ return m.role + ': ' + m.text.substring(0, 80); }).join('\n') + '\n'
        : '';
      promptParts[3] = shortMem;
    }
    totalLen = promptParts.join('').length;
    if (totalLen > TOKEN_BUDGET) {
      // 3. Trim unit detail timeline to last 5 entries
      if (unitDetail.includes('Timeline:')) {
        const tlIdx = unitDetail.indexOf('Timeline:');
        const tlLines = unitDetail.substring(tlIdx).split('\n');
        unitDetail = unitDetail.substring(0, tlIdx) + 'Timeline (recent):\n' + tlLines.slice(-5).join('\n');
        promptParts[4] = unitDetail;
      }
    }
    const finalContext = promptParts.join('');

    
    const d = new Date(); const dateStr = String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0');
    const prompt = 'You are a professional fleet operations coordinator writing on behalf of the user. DATE:'+dateStr+'\n\nPERSONALITY:\n- You communicate like a professional human — warm but concise\n- New messages (send/slack/message): ALWAYS start with appropriate greeting (Good morning/Good afternoon/Good evening based on time of day) then the content\n- Replies: Skip the greeting, just respond directly\n- Match what the user asks: update=status update, summary=brief summary, info=key details, follow-up=check on progress\n- If about a unit: focus on that unit only\n- If about a domicile/operator: focus on all units at that site/operator\n- Keep Slack messages concise (3-5 sentences max), professional fleet language\n- Never add recommendations or suggestions unless user explicitly asks\n\nACTIONS (JSON): TIMELINE({type:TIMELINE,unit:ID,entry:MM/DD-note}), SLACK({type:SLACK,recipient:handle,message:text}), SYNC, SP_PUSH, EMAIL, READ_SLACK, REMIND({type:REMIND,unit:ID,when:YYYY-MM-DD,note:text}), DAILY_NOTES, DRAFT_FOLLOWUPS, CREATE_WR({type:CREATE_WR,unit:ID,issue:text}), MOVE_UNIT({type:MOVE_UNIT,unit:ID,status:available|unavailable}), PIN({type:PIN,unit:ID}), UNPIN({type:UNPIN,unit:ID}), SCHEDULE({type:SCHEDULE,action:text,cron:text}), EMAIL({type:EMAIL,to:email,subject:text,body:text})\n\nRESPOND WITH JSON ONLY: {"reply":"your brief confirmation","actions":[...]}\n\nRULES:\n- actions=[] if just answering a question\n- Do EXACTLY what user asks. No extras.\n- SLACK: Match recipient from SLACK CONTACTS by name. Confirm who you are sending to in reply.\n- SLACK message style: greeting (if new msg) + context + status/update/summary as requested. Sign off naturally.\n- TIMELINE: professional fleet note, MM/DD - 1-2 sentences max.\n- Never invent data.\\n\\n'+fleetSummary+'\\n'+unitDetail+'\\nUser: '+userMsg;
    try {
      logger.info('[ai:orcha-action] Calling relay.ask (' + prompt.length + ' chars)...');
      const aiText = await relay.ask(prompt);
      logger.info('[ai:orcha-action] Got response: ' + (aiText ? aiText.length + ' chars' : 'EMPTY'));
      if (!aiText) return {ok:false,text:'AI empty',action:'chat'};
      let parsed; const jm = aiText.match(/\{[\s\S]*\}/);
      if (jm) try { parsed = JSON.parse(jm[0]); } catch(e) {}
      if (!parsed) return {ok:true,text:aiText,action:'chat'};
      const results = [];
      for (const a of (parsed.actions||[])) {
        if (a.type==='TIMELINE'&&a.unit&&a.entry) { const ns=store.load('notesStore',{}); const u=ns[a.unit]||{}; u.timeline=u.timeline?u.timeline+'\\n'+a.entry:a.entry; ns[a.unit]=u; store.save('notesStore',ns); try { const _s = require('electron').BrowserWindow.getAllWindows()[0]; if(_s) _s.webContents.send('notes:updated',{unitId:a.unit,timeline:u.timeline}); } catch(e){} results.push('Timeline:'+a.unit+' done');
          try { require('../orcha/repair-history').addEvent(a.unit, {summary:a.entry,vendor:'',outcome:'in-progress'}); } catch(e){} }
        if (a.type==='SLACK'&&a.recipient&&a.message) { const {sendSlackMessage}=require('../../src/scrapers/slack_send'); const r=await sendSlackMessage(a.recipient,a.message); results.push(r&&r.ok!==false?'Slack sent to '+a.recipient:'Slack failed'); }
        if (a.type==='SYNC') results.push('Sync triggered');
        if (a.type==='SP_PUSH') results.push('SP push triggered');
        if (a.type==='EMAIL') results.push('Email triggered');
        if (a.type==='DRAFT_FOLLOWUPS') {
          const stale = rows.filter(function(r){ return (r.lifecycleState||'').toLowerCase().includes('unavail') && r.vendor && r.vendor !== '--'; });
          const drafts = stale.slice(0,5).map(function(r){ return r.equipmentId + ' (' + r.vendor + '): Request status update — unit down ' + (r.workDuration||'?') + '.'; });
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
          const drafts = stale.slice(0,5).map(function(r){ return r.equipmentId + ' (' + r.vendor + '): Request status — down ' + (r.workDuration||'?'); });
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
            const { classifyRequest } = require('./partner-wr');
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
              ? 'Added to WR review queue for ' + a.unit + ': "' + (chatReq.aiTitle || a.issue) + '" — approve in Partner Requests to submit to AAP.'
              : 'Logged request for ' + a.unit + ' but AI classification failed — check Partner Requests review queue to fill in manually.');
          } catch (e) {
            results.push('Could not queue WR for ' + a.unit + ': ' + e.message);
          }
        }
        if (a.type==='MOVE_UNIT'&&a.unit&&a.status) {
          const fd2 = store.load('fleetData', {});
          const target = (fd2.rows||[]).find(function(r){return r.equipmentId===a.unit;});
          if (target) { target.lifecycleState = a.status === 'available' ? 'Available' : 'Unavailable'; store.save('fleetData', fd2); }
          try { const _w = require('electron').BrowserWindow.getAllWindows()[0]; if(_w) _w.webContents.send('fleet:refresh'); } catch(e){}
          results.push('Unit ' + a.unit + ' moved to ' + a.status);
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
        if (a.type==='EMAIL'&&a.to&&a.subject&&a.body) {
          try { const _w = require('electron').BrowserWindow.getAllWindows()[0]; if(_w) _w.webContents.send('email:compose',{to:a.to,subject:a.subject,body:a.body}); results.push('Email composed to ' + a.to); } catch(e){ results.push('Email error: '+e.message); }
        }
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
              results.push('📩 Recent messages:\n' + summary);
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
      return {ok:true,text:(parsed.reply||'')+(results.length?'\\n'+results.join('\\n'):''),action:results.length?'multi':'chat'};
    } catch(e) { return {ok:false,text:'Error:'+e.message,action:'chat'}; }
  });




  logger.info('AI IPC handlers registered');
}

module.exports = { registerAIHandlers };
