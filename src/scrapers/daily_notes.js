'use strict';
/**
 * daily_notes.js — Daily Notes Automation
 * 
 * For each unit with an Alt ID:
 * 1. Opens saved work order link + offsite event link
 * 2. Reads latest status, comments, notes, dates, action items
 * 3. Compares to last saved snapshot
 * 4. If changes → summarize what changed
 * 5. If no changes → "No new updates"
 * 
 * For Volvo/ASIST vendors: also pulls Relay Garage conversation data
 * 
 * Saves snapshot after each run for next-day comparison.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { P } = require('../config/paths');
const logger = require('../utils/logger').createLogger('daily_notes');
const SNAPSHOT_FILE = P.dailyNotesSnap;
const NOTES_LOG_FILE = P.dailyNotesLog;
const GENERATED_HISTORY_FILE = P.dailyNotesGenerated;
const DECISION_LOG_FILE = P.dailyNotesDec;

// Decision log — tracks WHY each note was added or skipped
function loadDecisionLog() {
  try {
    if (fs.existsSync(DECISION_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(DECISION_LOG_FILE, 'utf8'));
    }
  } catch (e) { logger.warn('[DailyNotes] loadDecisionLog error:', e.message); }
  return [];
}

function saveDecisionLog(log) {
  const dir = path.dirname(DECISION_LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Keep last 7 days
  const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
  const trimmed = log.filter(entry => new Date(entry.timestamp).getTime() > cutoff);
  fs.writeFileSync(DECISION_LOG_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

/**
 * DECISION ENGINE — determines whether to add a note
 * 
 * Returns: { decision: 'NEW_UPDATE' | 'NO_UPDATE_TODAY_NOT_LOGGED' | 'NO_ACTION_NEEDED', reason: string }
 * 
 * Logic:
 * 1. If latest vendor note/comment is already reflected in my last note → NO_ACTION_NEEDED
 * 2. If today already has a note AND no new vendor activity after that note → NO_ACTION_NEEDED
 * 3. If today has new vendor/system update AFTER my last note → NEW_UPDATE
 * 4. If latest vendor note is older than today AND no new info AND no note today → NO_UPDATE_TODAY_NOT_LOGGED
 * 5. If "No update pending follow-up" already exists for today → NO_ACTION_NEEDED
 */
function makeDecision(unit, currSnapshot, prevSnapshot, diff) {
  const today = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' });
  const todayFull = new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
  const priorNotes = unit.savedNotes || '';
  const noteLines = priorNotes.split('\n').filter(l => l.trim());
  
  // Find today's notes
  const todayNotes = noteLines.filter(l => l.startsWith(today) || l.startsWith(todayFull));
  const hasTodayNote = todayNotes.length > 0;
  const hasTodayNoUpdate = todayNotes.some(l => l.toLowerCase().includes('no update pending follow-up'));
  
  // Get the timestamp of the last note (any day)
  const lastNoteLine = noteLines[noteLines.length - 1] || '';
  
  // Current vendor activity indicators
  const currConversation = currSnapshot.relayConversation || currSnapshot.liveConversation || '';
  const prevConversation = (prevSnapshot && (prevSnapshot.relayConversation || prevSnapshot.liveConversation)) || '';
  const currIssue = currSnapshot.relayIssue || currSnapshot.issue || '';
  const prevIssue = (prevSnapshot && (prevSnapshot.relayIssue || prevSnapshot.issue)) || '';
  const currStatus = currSnapshot.relayStatus || currSnapshot.atsState || '';
  const prevStatus = (prevSnapshot && (prevSnapshot.relayStatus || prevSnapshot.atsState)) || '';
  
  // Detect meaningful changes
  const conversationChanged = currConversation !== prevConversation && currConversation.length > 0;
  const issueChanged = currIssue !== prevIssue && currIssue.length > 0;
  const statusChanged = currStatus !== prevStatus;
  const ASIST_RANK_D = { estimate: 3, case: 2, service_request: 1, none: 0 };
  const asistUpgrade = (ASIST_RANK_D[currSnapshot.asistSource]||0) > (ASIST_RANK_D[(prevSnapshot && prevSnapshot.asistSource)]||0);
  const hasMeaningfulChange = conversationChanged || issueChanged || statusChanged || diff.hasChanges || asistUpgrade;
  
  // Check if the last note already covers the current state
  const lastNoteContent = lastNoteLine.replace(/^\d{2}\/\d{2}(\/\d{2})?\s*-?\s*/, '').toLowerCase();
  const currentStateKeywords = [
    currStatus.toLowerCase(),
    (currIssue || '').substring(0, 50).toLowerCase()
  ].filter(k => k.length > 3);
  
  const lastNoteCoversCurrentState = currentStateKeywords.length > 0 && 
    currentStateKeywords.some(kw => lastNoteContent.includes(kw.substring(0, 20)));

  // DECISION LOGIC
  
  // Rule 5: Already logged "no update" today → do nothing
  if (hasTodayNoUpdate) {
    return { decision: 'NO_ACTION_NEEDED', reason: '"No update pending follow-up" already logged today.' };
  }
  
  // Rule 1: Latest vendor info already reflected in last note
  if (!hasMeaningfulChange && lastNoteCoversCurrentState) {
    return { decision: 'NO_ACTION_NEEDED', reason: 'Last note already reflects current vendor state. No new activity.' };
  }
  
  // Rule 2: Today has a note AND no new vendor activity since
  if (hasTodayNote && !hasMeaningfulChange) {
    return { decision: 'NO_ACTION_NEEDED', reason: 'Today already has a note and no new vendor activity detected.' };
  }
  
  // Rule 3: New vendor/system update detected → generate note
  if (hasMeaningfulChange) {
    const changeReasons = [];
    if (conversationChanged) changeReasons.push('vendor comments changed');
    if (issueChanged) changeReasons.push('issue details updated');
    if (statusChanged) changeReasons.push(`status changed: ${prevStatus} → ${currStatus}`);
    if (diff.hasChanges && changeReasons.length === 0) changeReasons.push(diff.changes);
    if (asistUpgrade) changeReasons.push('ASIST enrichment upgraded to ' + (currSnapshot.asistSource || 'unknown'));
    return { decision: 'NEW_UPDATE', reason: 'New activity: ' + changeReasons.join(', ') };
  }
  
  // Rule 4: No new info, no note today → log "no update pending follow-up" (once)
  if (!hasTodayNote) {
    return { decision: 'NO_UPDATE_TODAY_NOT_LOGGED', reason: 'No vendor activity today and no note logged yet. Adding pending follow-up.' };
  }
  
  // Default: do nothing
  return { decision: 'NO_ACTION_NEEDED', reason: 'No meaningful change detected.' };
}

// Track ALL notes ever generated per unit (persists even if user deletes them)
function getGeneratedHistory(unitId) {
  try {
    if (fs.existsSync(GENERATED_HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(GENERATED_HISTORY_FILE, 'utf8'));
      return (data[unitId] || []).join('\n');
    }
  } catch (e) { logger.warn('[DailyNotes] getGeneratedHistory error:', e.message); }
  return '';
}

function saveGeneratedNote(unitId, note) {
  try {
    const dir = path.dirname(GENERATED_HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let data = {};
    if (fs.existsSync(GENERATED_HISTORY_FILE)) {
      data = JSON.parse(fs.readFileSync(GENERATED_HISTORY_FILE, 'utf8'));
    }
    if (!data[unitId]) data[unitId] = [];
    // Don't add duplicates
    if (!data[unitId].includes(note)) {
      data[unitId].push(note);
      // Keep last 50 per unit
      if (data[unitId].length > 50) data[unitId] = data[unitId].slice(-50);
    }
    fs.writeFileSync(GENERATED_HISTORY_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { logger.warn('[DailyNotes] saveGeneratedNote error:', e.message); }
}


function loadSnapshots() {
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) {
      return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    }
  } catch (e) { logger.warn('[DailyNotes] Snapshot load error:', e.message); }
  return {};
}

function saveSnapshots(snapshots) {
  const dir = path.dirname(SNAPSHOT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshots, null, 2), 'utf8');
}

function loadNotesLog() {
  try {
    if (fs.existsSync(NOTES_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(NOTES_LOG_FILE, 'utf8'));
    }
  } catch (e) { logger.warn('[DailyNotes] loadNotesLog error:', e.message); }
  return [];
}

function saveNotesLog(log) {
  const dir = path.dirname(NOTES_LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Keep last 30 days
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const trimmed = log.filter(entry => new Date(entry.timestamp).getTime() > cutoff);
  fs.writeFileSync(NOTES_LOG_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

/**
 * Fetch page content from a URL using the AAP session (cookies from scraper)
 * Returns text content of the page
 */
async function fetchPageContent(url, session, log) {
  if (!url || !session) return null;
  try {
    const cookies = session.cookies || [];
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    
    const https = require('https');
    const http = require('http');
    const mod = url.startsWith('https') ? https : http;
    
    return new Promise((resolve, reject) => {
      const req = mod.get(url, { 
        headers: { 
          'Cookie': cookieHeader,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 15000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', (e) => { log('[DailyNotes] Fetch error: ' + e.message); resolve(null); });
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  } catch (e) {
    log('[DailyNotes] fetchPageContent error: ' + e.message);
    return null;
  }
}

/**
 * Extract meaningful text from HTML page content
 */
function extractPageText(html) {
  if (!html) return '';
  // Remove script/style tags
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                 .replace(/<style[\s\S]*?<\/style>/gi, '')
                 .replace(/<[^>]+>/g, ' ')
                 .replace(/&nbsp;/g, ' ')
                 .replace(/&amp;/g, '&')
                 .replace(/&lt;/g, '<')
                 .replace(/&gt;/g, '>')
                 .replace(/\s+/g, ' ')
                 .trim();
  // Limit to 3000 chars to avoid overwhelming AI
  return text.substring(0, 3000);
}

/**
 * Get Relay Garage data for a unit from the relay cache
 */
function getRelayData(unitId) {
  try {
    const relayCachePath = P.relayCache;
    if (fs.existsSync(relayCachePath)) {
      const cache = JSON.parse(fs.readFileSync(relayCachePath, 'utf8'));
      const unitData = cache.find(r => r.equipmentId === unitId || r.id === unitId);
      if (unitData) {
        return {
          status: unitData.status || unitData.relayStatus || '',
          vendor: unitData.vendor || '',
          issue: unitData.issue || unitData.issueDetails || '',
          duration: unitData.duration || unitData.workDuration || '',
          comments: unitData.comments || unitData.relayComments || '',
          lastUpdated: unitData.lastUpdated || unitData.updatedAt || ''
        };
      }
    }
  } catch (e) { logger.warn('[DailyNotes] getRelayData error:', e.message); }
  return null;
}

/**
 * Build current state snapshot for a unit
 */
async function buildUnitSnapshot(unit, session, log) {
  const snapshot = {
    unitId: unit.id,
    altId: unit.altId || '',
    vendor: unit.vendor || '',
    atsState: unit.atsState || '',
    relayStatus: unit.relayStatus || '',
    issue: unit.issue || '',
    duration: unit.duration || '',
    savedNotes: unit.savedNotes || '',
    asistSource:    unit.asistSource    || '',
    asistLabel:     unit.asistLabel     || '',
    asistSrUrl:     unit.asistSrUrl     || '',
    asistScrapedAt: unit.asistScrapedAt || '',
    dealerName:     unit.dealerName     || '',
    subVendor:      unit.subVendor      || unit.dealerName || '',
    timestamp: new Date().toISOString()
  };

  // Get Relay Garage conversation/issue data ONLY (no addresses, no full page scrape)
  const relayData = getRelayData(unit.id);
  if (relayData) {
    snapshot.relayConversation = relayData.comments || '';
    snapshot.relayStatus = relayData.status || '';
    snapshot.relayIssue = relayData.issue || '';
    snapshot.relayLastUpdated = relayData.lastUpdated || '';
  }

  return snapshot;
}


/**
 * Compare two snapshots — only conversations and issue details
 */
function diffSnapshots(prev, curr) {
  if (!prev) return { isNew: true, changes: 'First scan — no previous snapshot.' };
  
  const changes = [];
  
  if (prev.atsState !== curr.atsState) {
    changes.push(`ATS: ${prev.atsState} → ${curr.atsState}`);
  }
  if (prev.relayStatus !== curr.relayStatus && curr.relayStatus) {
    changes.push(`Relay: ${prev.relayStatus || 'N/A'} → ${curr.relayStatus}`);
  }
  if (prev.issue !== curr.issue && curr.issue) {
    changes.push(`Issue: "${curr.issue.substring(0, 100)}"`);
  }
  if (prev.duration !== curr.duration && curr.duration) {
    changes.push(`Duration: ${curr.duration}`);
  }
  
  // Compare Relay Garage conversations (the key data)
  if (curr.relayConversation && prev.relayConversation !== curr.relayConversation) {
    changes.push('New Relay Garage conversation/comments');
  }
  if (curr.relayIssue && prev.relayIssue !== curr.relayIssue) {
    changes.push(`Relay issue updated: "${curr.relayIssue.substring(0, 100)}"`);
  }
  // S25-11: detect ASIST source tier upgrade
  const ASIST_RANK = { estimate: 3, case: 2, service_request: 1, none: 0 };
  const prevAsistRank = ASIST_RANK[prev.asistSource] || 0;
  const currAsistRank = ASIST_RANK[curr.asistSource] || 0;
  if (currAsistRank > prevAsistRank && curr.asistSource) {
    const srcLabel = curr.asistSource === 'estimate' ? 'Fleet Estimate' : curr.asistSource === 'case' ? 'ASIST Case' : 'Service Request';
    changes.push('ASIST enriched to ' + srcLabel + (curr.asistLabel ? ': ' + curr.asistLabel.substring(0,60) : ''));
  } else if (curr.asistLabel && prev.asistLabel !== curr.asistLabel && curr.asistRank >= prevAsistRank) {
    changes.push('ASIST label updated: ' + curr.asistLabel.substring(0,60));
  }

  // S25-13: detect Sub Vendor arrival or change
  if (curr.subVendor && curr.subVendor !== prev.subVendor) {
    changes.push('Sub Vendor: ' + curr.subVendor.substring(0,60) + (prev.subVendor ? ' (was ' + prev.subVendor.substring(0,40) + ')' : ''));
  }

  
  return {
    isNew: false,
    hasChanges: changes.length > 0,
    changes: changes.length > 0 ? changes.join(' | ') : null,
    prevConversation: prev.relayConversation || '',
    currConversation: curr.relayConversation || '',
    prevIssue: prev.relayIssue || prev.issue || '',
    currIssue: curr.relayIssue || curr.issue || ''
  };
}


/**
 * Main: Run daily notes for all units with Alt IDs
 * @param {Array} units - UNITS array from the app
 * @param {Object} session - AAP session with cookies
 * @param {Function} askAI - Orcha AI function
 * @param {Function} log - logging callback
 * @returns {Array} - Array of { unitId, altId, vendor, note }
 */
async function runDailyNotes(units, session, askAI, log) {
  if (!log) log = logger.info.bind(logger);
  
  // Filter to units with Alt ID only
  const targetUnits = units.filter(u => u.altId && u.altId.trim());
  log(`[DailyNotes] Starting for ${targetUnits.length} units with Alt IDs...`);
  
  const snapshots = loadSnapshots();
  const results = [];
  const newSnapshots = { ...snapshots };
  
  const decisionLog = loadDecisionLog();

  for (let i = 0; i < targetUnits.length; i++) {
    const unit = targetUnits[i];
    log(`[DailyNotes] (${i + 1}/${targetUnits.length}) Unit ${unit.id} — ${unit.altId}`);
    
    try {
      // Build current snapshot
      const currSnapshot = await buildUnitSnapshot(unit, session, log);
      const prevSnapshot = snapshots[unit.id] || null;
      
      // Compare snapshots
      const diff = diffSnapshots(prevSnapshot, currSnapshot);
      
      // ═══════════════════════════════════════════════════════════
      // DECISION ENGINE — determine if a note should be added
      // ═══════════════════════════════════════════════════════════
      const decision = makeDecision(unit, currSnapshot, prevSnapshot, diff);
      log(`[DailyNotes] ${unit.id} → Decision: ${decision.decision} | Reason: ${decision.reason}`);
      
      // Log the decision
      decisionLog.push({
        timestamp: new Date().toISOString(),
        unitId: unit.id,
        altId: unit.altId,
        decision: decision.decision,
        reason: decision.reason,
        diffSummary: diff.changes || (diff.isNew ? 'First scan' : 'No changes')
      });

      let note = '';
      let shouldAdd = false;

      if (decision.decision === 'NO_ACTION_NEEDED') {
        // ─── Do nothing. Don't add a note. ───
        note = '';
        shouldAdd = false;
        
      } else if (decision.decision === 'NO_UPDATE_TODAY_NOT_LOGGED') {
        // ─── No activity today, but no note logged yet. Add one-liner. ───
        note = 'No update pending follow-up';
        shouldAdd = true;

      } else if (decision.decision === 'NEW_UPDATE') {
        // ─── Meaningful change detected → call AI to summarize ───
        const unitMake = (unit.model || '').replace(/^\d{4}\s*/, '').split(' ')[0] || '';
        const slaInfo = unit.slaTarget ? `SLA Target: ${unit.slaTarget} days, Down: ${unit.duration || 'unknown'}` : '';
        
        let aiPrompt = `You are Orcha, writing a daily maintenance note for Z Santiago (Fleet Ops Manager).

UNIT CONTEXT:
- Unit: ${unit.id} | Alt ID: ${unit.altId}
- Make/Model: ${unit.model || 'N/A'}
- Vendor: ${unit.vendor || 'N/A'}
${currSnapshot.subVendor ? `- Sub Vendor: ${currSnapshot.subVendor}` : ``}
- Status: ${currSnapshot.atsState || 'N/A'} | Relay: ${currSnapshot.relayStatus || 'N/A'}
- Duration Down: ${unit.duration || 'N/A'}
${slaInfo ? `- ${slaInfo}\n` : ''}- Risk: ${unit.riskScore || 'N/A'} (${unit.riskTier || ''})

WHAT CHANGED (trigger for this note):
${decision.reason}

DIFF DETAILS:
${diff.changes || 'See conversation/issue data below'}

`;
        // Include all data sources
        if (currSnapshot.liveConversation) {
          aiPrompt += `LIVE DATA (Relay Garage + Offsite Notes):\n${currSnapshot.liveConversation.substring(0, 4000)}\n\n`;
        } else {
          if (diff.currConversation) {
            aiPrompt += `RELAY GARAGE CONVERSATION:\n${diff.currConversation.substring(0, 1500)}\n\n`;
          }
        }
        
        if (diff.currIssue) {
          aiPrompt += `CURRENT ISSUE: ${diff.currIssue.substring(0, 500)}\n\n`;
        }

        // S25-11: inject ASIST offsite enrichment into AI prompt
        if (currSnapshot.asistLabel || currSnapshot.asistSource) {
          const _srcLabel = currSnapshot.asistSource === 'estimate' ? 'Fleet Estimate' : currSnapshot.asistSource === 'case' ? 'ASIST Case' : currSnapshot.asistSource === 'service_request' ? 'Service Request' : '(unknown)';
          let _asistLine = 'Offsite Source: ' + _srcLabel;
          if (currSnapshot.asistLabel) _asistLine += ' - ' + currSnapshot.asistLabel.substring(0,80);
          if (currSnapshot.asistSrUrl)  _asistLine += ' | SR: ' + currSnapshot.asistSrUrl.substring(0,100);
          if (currSnapshot.asistScrapedAt) _asistLine += ' (enriched ' + currSnapshot.asistScrapedAt.slice(0,10) + ')';
          aiPrompt += 'VOLVO ASIST OFFSITE EVENT:\n' + _asistLine + '\n\n';
        }


        // Include prior notes AND generated history
        const priorNotes = unit.savedNotes || currSnapshot.savedNotes || '';
        const generatedHistory = getGeneratedHistory(unit.id);
        const allPriorContext = (priorNotes + '\n' + generatedHistory).trim();
        if (allPriorContext) {
          aiPrompt += `PRIOR NOTES (do NOT repeat ANY of this — only write what's NEW):\n${allPriorContext.substring(0, 2000)}\n\n`;
        }
        
        aiPrompt += `INSTRUCTIONS:
Write ONLY the new update. The system already determined something meaningful changed.
Summarize ONLY the new information that triggered this note.

RULES:
- 1-3 short lines max. Be direct — like a fleet manager's personal notes.
- Focus on: repair progress, parts status, vendor response, estimates, ETAs, appointments, status changes
- NEVER repeat info already in prior notes
- NEVER include: phone numbers, emails, physical addresses, contact names, locations
- If estimate was approved/denied, mention amount
- If unit is approaching SLA breach, flag it
- No date prefix (system adds it)
- No quotes, no explanation — just the note text

EXAMPLES:
"Diagnostic complete — turbo replacement needed. EST $4,200 submitted, awaiting approval."
"Parts received. Tech assigned, repair starts tomorrow AM."
"Tow to ${unitMake || 'OEM'} dealer scheduled — work out of scope for ${unit.vendor || 'current vendor'}. ETA pickup today."
"No response from vendor in 48hrs. Escalation needed."
"EST approved $2,800. Repair in progress — ETA completion end of day."
"Repair complete, road-tested. Pending release back to fleet."

Reply with ONLY the note text.`;

        try {
          log(`[DailyNotes] Calling AI for ${unit.id}...`);
          const aiResult = await askAI(aiPrompt);
          const aiText = (aiResult && aiResult.text) ? aiResult.text : (typeof aiResult === 'string' ? aiResult : '');
          note = aiText.trim();
          
          // If AI says "no new updates" despite decision saying NEW_UPDATE, still skip
          if (!note || note.toLowerCase() === 'no new updates' || note.toLowerCase() === 'no new updates.') {
            note = '';
            shouldAdd = false;
            // Update decision log
            decisionLog[decisionLog.length - 1].decision = 'NO_ACTION_NEEDED';
            decisionLog[decisionLog.length - 1].reason += ' (AI confirmed no meaningful update)';
          } else {
            shouldAdd = true;
            saveGeneratedNote(unit.id, note);
          }
        } catch (aiErr) {
          log(`[DailyNotes] AI error for ${unit.id}: ${aiErr.message}`);
          // Fallback: use diff summary as note
          note = `Status change: ${diff.changes}`;
          shouldAdd = true;
        }
      }
      
      results.push({
        unitId: unit.id,
        altId: unit.altId,
        vendor: unit.vendor || '',
        woUrl: unit.savedOffsiteUrl || unit.savedOffsiteEvent || unit.serviceUrl || "",
        offsiteUrl: unit.savedSalesforceCase || '',
        asistSource: currSnapshot.asistSource || '',
        asistLabel:  currSnapshot.asistLabel  || '',
        subVendor:   currSnapshot.subVendor   || '',
        dealerName:  currSnapshot.dealerName  || '',
        note: shouldAdd ? note : '',
        hasChanges: shouldAdd,
        decision: decision.decision,
        reason: decision.reason
      });
      
      // Save new snapshot
      newSnapshots[unit.id] = currSnapshot;
      
    } catch (unitErr) {
      log(`[DailyNotes] Error for ${unit.id}: ${unitErr.message}`);
      results.push({
        unitId: unit.id,
        altId: unit.altId,
        vendor: unit.vendor || '',
        note: `Error: ${unitErr.message}`,
        hasChanges: false,
        decision: 'ERROR',
        reason: unitErr.message
      });
    }
    
    // Small delay between units to not overwhelm
    await new Promise(r => setTimeout(r, 500));
  }
  
  // Save decision log
  saveDecisionLog(decisionLog);
  
  // Save all snapshots
  saveSnapshots(newSnapshots);
  log(`[DailyNotes] Complete. ${results.filter(r => r.hasChanges).length} units with updates, ${results.filter(r => !r.hasChanges).length} no changes.`);
  
  // Save to log
  const notesLog = loadNotesLog();
  notesLog.push({
    timestamp: new Date().toISOString(),
    count: results.length,
    withUpdates: results.filter(r => r.hasChanges).length,
    results: results
  });
  saveNotesLog(notesLog);
  
  return results;
}

module.exports = { runDailyNotes, loadSnapshots, saveSnapshots, loadNotesLog, loadDecisionLog, makeDecision };
