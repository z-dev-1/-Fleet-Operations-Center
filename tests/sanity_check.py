"""
Fleet Ops V-C — Stage 1 Sanity Check
Modules 1–5: fleet / notes / relay / chat / auth
"""
import os
import re, os, sys

BASE   = '/home/zilasant/fleet/version_c'
HTML   = f'{BASE}/renderer/src/index.html'
FB     = f'{BASE}/renderer/src/js/fleet-bridge.js'
NB     = f'{BASE}/renderer/src/js/notes-bridge.js'
RB     = f'{BASE}/renderer/src/js/relay-bridge.js'
CB     = f'{BASE}/renderer/src/js/chat-bridge.js'
AB     = f'{BASE}/renderer/src/js/auth-bridge.js'
OB     = f'{BASE}/renderer/src/js/orcha-bridge.js'
SB     = f'{BASE}/renderer/src/js/slack-bridge.js'
STB    = f'{BASE}/renderer/src/js/settings-bridge.js'
AAP    = f'{BASE}/renderer/src/js/aap-bridge.js'
DN     = f'{BASE}/renderer/src/js/daily-notes-bridge.js'
SAFE   = f'{BASE}/src/ipc/_safe.js'
SCR    = f'{BASE}/src/ipc/scrapers.js'
CRD    = f'{BASE}/src/ipc/credentials.js'
SET    = f'{BASE}/src/ipc/settings.js'
NOT    = f'{BASE}/src/ipc/notes.js'
AI     = f'{BASE}/src/ipc/ai.js'
SLK    = f'{BASE}/src/ipc/slack.js'
MISC   = f'{BASE}/src/ipc/misc.js'
ASN    = f'{BASE}/src/ipc/asana.js'
SPT    = f'{BASE}/src/ipc/sharepoint.js'
SUP    = f'{BASE}/src/ipc/setup.js'
DSCAN  = f'{BASE}/src/orcha/deep-scan.js'
STORE  = f'{BASE}/src/store/index.js'
SYNC   = f'{BASE}/src/sync/index.js'
ORC2   = f'{BASE}/src/ipc/orcha.js'
ORC    = f'{BASE}/src/ipc/orcha.js'
IPC_N  = f'{BASE}/src/ipc/notes.js'
PRELD  = f'{BASE}/preload.js'
GEO    = f'{BASE}/src/scrapers/geofence_scraper.js'
UPT    = f'{BASE}/src/scrapers/uptake.js'
RLY    = f'{BASE}/src/scrapers/relay.js'
RETRY  = f'{BASE}/src/utils/retry.js'
SPU    = f'{BASE}/src/scrapers/sharepoint_push.js'
AAP_SC = f'{BASE}/src/scrapers/aap.js'
DN_SC  = f'{BASE}/src/scrapers/daily_notes.js'
SL_SC  = f'{BASE}/src/scrapers/setLifecycle.js'
PW_SC  = f'{BASE}/src/scrapers/pw_scraper.js'
AAG_SC = f'{BASE}/src/scrapers/aap_adaptive_agent.js'
AE_SC  = f'{BASE}/src/scrapers/aap_autofill_engine.js'
AUTH_SC = f'{BASE}/src/scrapers/auth.js'

passes, warns, fails = [], [], []

def chk(label, ok, warn=False):
    mark = '✓' if ok else ('⚠ ' if warn else '✗')
    (passes if ok else (warns if warn else fails)).append(f'  {mark} {label}')

def read(p):
    with open(p, encoding='utf-8') as f: return f.read()

html = read(HTML)
fb   = read(FB)
nb   = read(NB)
rb   = read(RB)
cb   = read(CB)
ab   = read(AB)
ob   = read(OB)
sb   = read(SB)
stb  = read(STB)
aap  = read(AAP)
dn   = read(DN)
safe = read(SAFE)
scr  = read(SCR)
crd  = read(CRD)
set_ = read(SET)
not_ = read(NOT)
ai   = read(AI)
slk  = read(SLK)
misc = read(MISC)
asn  = read(ASN)
spt  = read(SPT)
sup  = read(SUP)
dscan = read(DSCAN)
store_src = read(STORE)
sync_src  = read(SYNC)
orc2 = read(ORC2)
orc  = read(ORC)
ipcn = read(IPC_N)
pre  = read(PRELD)
geo  = read(GEO)
upt  = read(UPT)
rly  = read(RLY)
ret  = read(RETRY)
spu  = read(SPU)
aap_s = read(AAP_SC)
dn_s  = read(DN_SC)
sl_s  = read(SL_SC)
pw_s  = read(PW_SC)
aag_s = read(AAG_SC)
ae_s  = read(AE_SC)
auth_s = read(AUTH_SC)

# ── Module 1 checks ─────────────────────────────────────────────────────────
chk('Script order: fleet→notes→relay→chat→auth',
    html.index('fleet-bridge.js') < html.index('notes-bridge.js') <
    html.index('relay-bridge.js') < html.index('chat-bridge.js') <
    html.index('auth-bridge.js'))
chk('Script tag fleet-bridge.js present exactly once',  html.count('fleet-bridge.js')  == 1)
chk('Script tag notes-bridge.js present exactly once',
    len(re.findall(r'<script[^>]+(?<!daily-)notes-bridge\.js', html)) == 1)
chk('Script tag relay-bridge.js present exactly once',  html.count('relay-bridge.js')  == 1)
chk('Script tag chat-bridge.js present exactly once',   html.count('chat-bridge.js')   == 1)
chk('Script tag auth-bridge.js present exactly once',   html.count('auth-bridge.js')   == 1)
chk('_curDrawerUid=uid assigned in openDrawerByUid',    '_curDrawerUid=uid' in html)
chk('drTab() defined in inline script',                 'function drTab(' in html)
chk('openDrawerByUid() defined',                        'function openDrawerByUid(' in html)
chk('fleet-bridge renderTable uses openDrawerByUid',    'openDrawerByUid' in fb)
chk('Static tbody row onclick functions only openDrawer',
    set(re.findall(r'onclick="(\w+)\(', ''.join(re.findall(r'<tr[^>]*onclick="([^"]+)"', html)))) == {'openDrawer'},
    warn=True)

# ── Module 2 checks ─────────────────────────────────────────────────────────
chk('Original saveNote() declared in inline script',    'function saveNote(' in html)
chk('Original autoSaveNote() declared in inline script','function autoSaveNote(' in html)
chk('notes-bridge assigns window.saveNote',             'window.saveNote' in nb)
chk('notes-bridge assigns window.autoSaveNote',         'window.autoSaveNote' in nb)
chk('notes-bridge has patchDrTab()',                    'patchDrTab' in nb)
chk('patchDrTab wraps window.drTab',                    'window.drTab' in nb)
chk('notes-bridge has patchOpenDrawerByUid()',          'patchOpenDrawerByUid' in nb)
for ch in ['notes:get-unit','notes:get-all','notes:save-unit','notes:delete-unit']:
    chk(f'IPC channel "{ch}" in both ipc/notes.js and preload.js',
        ch in ipcn and ch in pre)
chk('registerNotesIPC called in ipc/index.js',
    'registerNotesIPC' in read(f'{BASE}/src/ipc/index.js'))
chk('HAS_NOTES captured at load time (always false in dev)',
    'HAS_NOTES' in nb, warn=True)

# ── Module 3 checks ─────────────────────────────────────────────────────────
chk('relay-bridge.js LF only',                          '\r' not in rb)
chk('relay-bridge.js: parentheses balanced',            rb.count('(') == rb.count(')'))
chk('relay-bridge patches window.commitRelay',          'window.commitRelay' in rb)
chk('relay-bridge patches window.applyBulkRelay',       'window.applyBulkRelay' in rb)
chk('relay-bridge has RELAY_TO_LIFECYCLE map',          'RELAY_TO_LIFECYCLE' in rb)
chk('All 6 relay values in mapping',
    all(v in rb for v in ['Available','In Progress','Pending Parts','Pending Diag','Offsite Shop','Accident']))
chk('AAP state Active present for Available',           "'Active'" in rb or '"Active"' in rb)
chk('AAP state Unavailable present for others',         "'Unavailable'" in rb or '"Unavailable"' in rb)
chk('commitToAAP async function defined',               'async function commitToAAP' in rb)
chk('HAS_AAP guard present',                            'HAS_AAP' in rb)
chk('Dev-mode fallback toast present',                  'localStorage only' in rb)
chk('Bulk relay: uid snapshot before original runs',    'checkedUids' in rb)
chk('Bulk relay: sequential IPC with delay',            '200' in rb)
chk('window.aap.setLifecycle called',                   'window.aap.setLifecycle' in rb)
chk('window._relayBridge debug handle exposed',         'window._relayBridge' in rb)
chk('relay-bridge console.log identifies mode',         'relay-bridge] loaded' in rb)

# ── Module 4 checks ─────────────────────────────────────────────────────────
chk('chat-bridge.js LF only',                           '\r' not in cb)
chk('chat-bridge.js: parentheses balanced',             cb.count('(') == cb.count(')'))
chk('HAS_AI flag detected from window.ai.chat',         'window.ai' in cb and 'HAS_AI' in cb)
chk('window.sendMsg patched',                           'window.sendMsg' in cb)
chk('Original sendMsg preserved (_originalSendMsg)',    '_originalSendMsg' in cb)
chk('Typing indicator shown while IPC in flight',       'showTyping' in cb)
chk('In-flight lock prevents double-send',              '_inflight' in cb)
chk('Unit context injected via buildUnitContext',       'buildUnitContext' in cb)
chk('UNITS and _curDrawerUid referenced for context',
    'window.UNITS' in cb and '_curDrawerUid' in cb)
chk('IPC result handles {ok, text} object format',      'result.text' in cb)
chk('IPC error demoted to toast, not thrown',           'window.toast' in cb)
chk('Dev-mode canned responses preserved',              'DEV_RESPONSES' in cb)
chk('window._chatBridge debug handle exposed',          'window._chatBridge' in cb)
chk('window.ai.chat IPC channel registered in preload', 'ai:chat' in pre)
chk('window.ai.ask IPC channel registered in preload',  'ai:ask' in pre)
chk('[chat-bridge] boot log present',                   'chat-bridge] loaded' in cb)

# ── Module 5 checks ─────────────────────────────────────────────────────────
chk('auth-bridge.js LF only',                               '\r' not in ab)
chk('auth-bridge.js: parentheses balanced',                 ab.count('(') == ab.count(')'))
chk('HAS_AUTH flag checks window.auth.checkMidway',         'HAS_AUTH' in ab and 'window.auth' in ab)
chk('HAS_SLACK flag checks window.slack.checkAuth',         'HAS_SLACK' in ab and 'window.slack' in ab)
chk('HAS_AI_TEST flag checks window.ai.test',               'HAS_AI_TEST' in ab and 'window.ai' in ab)
chk('auth:check-midway IPC handler registered in preload',  'auth:check-midway' in pre)
chk('auth:run-mwinit IPC handler registered in preload',    'auth:run-mwinit' in pre)
chk('slack:check-auth IPC handler registered in preload',   'slack:check-auth' in pre)
chk('Midway polled via checkMidway()',                       'checkMidway' in ab)
chk('Slack polled via checkSlack()',                         'checkSlack' in ab)
chk('Orcha polled via checkOrcha()',                         'checkOrcha' in ab)
chk('#auth-status-bar injected into .topbar-right',          'auth-status-bar' in ab and 'topbar-right' in ab)
chk('.cp-st text updated to reflect Orcha status',           'cp-st' in ab and 'updateChatStatus' in ab)
chk('mwinit status listener registered',                     'onMwinitStatus' in ab and 'registerMwinitListener' in ab)
chk('mwinit re-poll triggered after launch',                 '3000' in ab)
chk('Poll interval 5 minutes (300 000 ms)',                  '300000' in ab)
chk('First poll delayed 2s after boot',                      '2000' in ab)
chk('Dev-mode bar shown when no IPC available',              'mountDevBar' in ab and 'DEV MODE' in ab)
chk('window._authBridge debug handle exposed',               'window._authBridge' in ab)
chk('pollNow() exposed on debug handle',                     'pollNow' in ab)
chk('[auth-bridge] boot log present',                        'auth-bridge] loaded' in ab)


# ── Preload additions checks ──────────────────────────────────────────────────
chk('preload: window.ai.deepProcess exposed',        'deepProcess' in pre and 'orcha:deep-process' in pre)
chk('preload: window.ai.recordCorrection exposed',   'recordCorrection' in pre and 'orcha:record-correction' in pre)
chk('preload: window.ai.suggestVendor exposed',      'suggestVendor' in pre and 'orcha:suggest-vendor' in pre)
chk('preload: window.ai.getCorrections exposed',     'getCorrections' in pre and 'orcha:get-corrections' in pre)
chk('preload: window.ai.runDailyNotes exposed',      'runDailyNotes' in pre and 'daily-notes:run' in pre)
chk('preload: window.ai.getDailyNotesLog exposed',   'getDailyNotesLog' in pre and 'daily-notes:get-log' in pre)
chk('preload: window.ai.onDailyNotesProgress exposed','onDailyNotesProgress' in pre and 'daily-notes:progress' in pre)
chk('preload: window.ai.openDailyWindows exposed',   'openDailyWindows' in pre and 'daily-notes:open-windows' in pre)
chk('preload: window.ai.saveOrchaConfig exposed',    'saveOrchaConfig' in pre and 'orcha:save-config' in pre)
chk('preload: window.ai.refreshCreds exposed',       'refreshCreds' in pre and 'orcha:refresh-creds' in pre)

# ── Module 6 checks ───────────────────────────────────────────────────────────chk('orcha-bridge.js present',                           len(ob) > 100)
chk('orcha-bridge.js LF only',                           '\r' not in ob)
chk('orcha-bridge.js: parentheses balanced',             ob.count('(') == ob.count(')'))
chk('HAS_ORCHA_DEEP flag from window.ai.deepProcess',    'HAS_ORCHA_DEEP' in ob and 'window.ai' in ob)
chk('HAS_ORCHA_LEARN flag from window.ai.recordCorrection', 'HAS_ORCHA_LEARN' in ob)
chk('window.runOrchaDeepProcess exposed globally',       'window.runOrchaDeepProcess' in ob)
chk('window.runOrchaVendorSuggest exposed globally',     'window.runOrchaVendorSuggest' in ob)
chk('window.recordOrchaCorrection exposed globally',     'window.recordOrchaCorrection' in ob)
chk('AI-box loading overlay (_showAiLoading)',           '_showAiLoading' in ob)
chk('AI-box restore on failure (_restoreAiBox)',         '_restoreAiBox' in ob)
chk('UNITS cache updated on result',                     'window.UNITS' in ob)
chk('Drawer .ai-box content updated on result',          '.ai-box' in ob or 'ai-box' in ob)
chk('.ai-act (NEXT action) updated on result',           'ai-act' in ob)
chk('.ai-stamp (confidence stamp) updated on result',    'ai-stamp' in ob)
chk('Repair timeline .tl entries prepended',             'tl-item' in ob and 'insertBefore' in ob)
chk('Notes area hydrated on result',                     'notesArea' in ob)
chk('In-flight lock prevents double-process (_state.running)', '_state.running' in ob)
chk('Dev canned responses array (DEV_INTEL)',            'DEV_INTEL' in ob)
chk('"Run Orcha" button injected into drawer actions',   'orcha-run-btn' in ob and '_injectDrawerButton' in ob)
chk('"Run Orcha" item injected into context menu',       'ctx-orcha-item' in ob and '_injectCtxMenuItem' in ob)
chk('MutationObserver watches drawer open/close',        'MutationObserver' in ob and '_watchDrawer' in ob)
chk('IPC error demoted to toast, not thrown',            'window.toast' in ob)
chk('window._orchaBridge debug handle exposed',          'window._orchaBridge' in ob)
chk('[orcha-bridge] boot log present',                   'orcha-bridge] loaded' in ob)
chk('Script tag orcha-bridge.js present exactly once',   html.count('orcha-bridge.js') == 1)
chk('Script order: auth-bridge before orcha-bridge',
    html.index('auth-bridge.js') < html.index('orcha-bridge.js'))


# ── Module 9 checks ───────────────────────────────────────────────────────────
chk('slack-bridge.js present',                                  len(sb) > 100)
chk('slack-bridge.js LF only',                                  '\r' not in sb)
chk('slack-bridge.js: parentheses balanced',                    sb.count('(') == sb.count(')'))
chk('HAS_SLACK_SEND flag from window.slack.send',               'HAS_SLACK_SEND' in sb and 'window.slack' in sb)
chk('HAS_SLACK_AUTH flag from window.slack.checkAuth',          'HAS_SLACK_AUTH' in sb)
chk('HAS_SLACK_LOGIN flag from window.slack.login',             'HAS_SLACK_LOGIN' in sb)
chk('window.sendFleetAlert exposed globally',                   'window.sendFleetAlert' in sb)
chk('window.draftSlack patched (patchDraftSlack)',              '_patchDraftSlack' in sb and 'window.draftSlack' in sb)
chk('Compose modal built (_ensureModal)',                       '_ensureModal' in sb and 'slack-compose-modal' in sb)
chk('5 message templates defined (_buildTemplates)',            '_buildTemplates' in sb and 'Vendor follow-up' in sb)
chk('SLA escalation template present',                         'escalation' in sb.lower() or 'Escalation' in sb)
chk('Return to service template present',                      'Return to service' in sb or 'returned to service' in sb)
chk('Auth warning shown when Slack not connected',             'slack-auth-warn' in sb and '_checkAuthWarn' in sb)
chk('Connect Slack flow triggers window.slack.login()',        '_triggerSlackLogin' in sb and 'slack.login' in sb)
chk('Auth-bridge state integration (_authBridge.state)',       '_authBridge' in sb)
chk('Re-poll auth-bridge after login (5s delay)',              '5000' in sb)
chk('In-flight lock prevents double-send (_state.sending)',    '_state.sending' in sb)
chk('Dev fallback: 800ms delay simulate send',                 '800' in sb)
chk('Context menu Slack item wired (_wireCtxSlack)',           '_wireCtxSlack' in sb)
chk('IPC error demoted to toast, not thrown',                  'window.toast' in sb)
chk('window._slackBridge debug handle exposed',                'window._slackBridge' in sb)
chk('[slack-bridge] boot log present',                         'slack-bridge] loaded' in sb)
chk('Script tag slack-bridge.js present exactly once',         html.count('slack-bridge.js') == 1)
chk('Script order: orcha-bridge before slack-bridge',
    html.index('orcha-bridge.js') < html.index('slack-bridge.js'))


# ── Module 10 checks ──────────────────────────────────────────────────────────
chk('settings-bridge.js present',                               len(stb) > 100)
chk('settings-bridge.js LF only',                              '\\r' not in stb)
chk('settings-bridge.js: parentheses balanced',                stb.count('(') == stb.count(')'))
chk('HAS_SETTINGS flag from window.settings.getAll',           'HAS_SETTINGS' in stb and 'window.settings' in stb)
chk('HAS_CREDENTIALS flag from window.credentials.list',       'HAS_CREDENTIALS' in stb and 'window.credentials' in stb)
chk('HAS_APP_IPC flag from window.app.windowAction',           'HAS_APP_IPC' in stb and 'window.app' in stb)
chk('Settings loaded from backend on boot (_loadAndApplySettings)', '_loadAndApplySettings' in stb)
chk('Settings saved to backend on UI change (_saveSettingToBackend)', '_saveSettingToBackend' in stb)
chk('toggleTheme patched to persist to backend',               '_origToggleTheme' in stb and 'window.toggleTheme' in stb)
chk('setDensity patched to persist to backend',                '_origSetDensity' in stb and 'window.setDensity' in stb)
chk('Domicile load/save via IPC (loadDomiciles/saveDomiciles)', 'loadDomiciles' in stb and 'saveDomiciles' in stb)
chk('window.checkCredential exposed (credentials:has)',        'window.checkCredential' in stb and 'credentials.has' in stb)
chk('window.setCredential exposed (credentials:set)',          'window.setCredential' in stb and 'credentials.set' in stb)
chk('window.listCredentials exposed (credentials:list)',       'window.listCredentials' in stb and 'credentials.list' in stb)
chk('window.deleteCredential exposed (credentials:delete)',    'window.deleteCredential' in stb and 'credentials.delete' in stb)
chk('Credentials never show raw values in UI',                 'never' in stb.lower() or 'Never' in stb)
chk('Credentials section injected into settings panel',        '_injectCredentialsTab' in stb and 'creds-section' in stb)
chk('Settings panel watched for credentials tab injection',    '_watchSettingsPanel' in stb and 'MutationObserver' in stb)
chk('minimizeApp patched to use window:action IPC',            '_patchMinimize' in stb and 'windowAction' in stb)
chk('window.getAppVersion exposed (app:version)',              'window.getAppVersion' in stb)
chk('Dev fallback: settings degrade gracefully',               'localStorage' in stb)
chk('IPC error demoted to warn/toast, not thrown',             'window.toast' in stb or 'console.warn' in stb)
chk('window._settingsBridge debug handle exposed',             'window._settingsBridge' in stb)
chk('[settings-bridge] boot log present',                      'settings-bridge] loaded' in stb)
chk('Script tag settings-bridge.js present exactly once',      html.count('settings-bridge.js') == 1)
chk('Script order: slack-bridge before settings-bridge',
    html.index('slack-bridge.js') < html.index('settings-bridge.js'))


# ── Module 8 checks ───────────────────────────────────────────────────────────
chk('aap-bridge.js present',                                    len(aap) > 100)
chk('aap-bridge.js LF only',                                   '\\r' not in aap)
chk('aap-bridge.js: parentheses balanced',                     aap.count('(') == aap.count(')'))
chk('HAS_AAP flag from window.aap.createWR',                   'HAS_AAP' in aap and 'window.aap' in aap)
chk('HAS_ADAPTIVE flag from window.aap.adaptiveScanBatch',     'HAS_ADAPTIVE' in aap and 'adaptiveScanBatch' in aap)
chk('HAS_AUTOFILL flag from window.aap.autofill',              'HAS_AUTOFILL' in aap and 'window.aap.autofill' in aap)
chk('HAS_LIFECYCLE flag from window.aap.setLifecycle',         'HAS_LIFECYCLE' in aap and 'setLifecycle' in aap)
chk('Write-gate: _writeGate() present for all write ops',      '_writeGate' in aap)
chk('Write-gate: shows WRITE OPERATION badge in UI',           'WRITE OPERATION' in aap)
chk('Write-gate: user must click Confirm to proceed',          'aap-gate-confirm' in aap and 'confirmed' in aap)
chk('Write-gate: cancel resolves false, abandons operation',   'resolve(false)' in aap or '_done(false)' in aap)
chk('window.runAdaptiveScan exposed → adaptive:scan-batch',    'window.runAdaptiveScan' in aap and 'adaptiveScanBatch' in aap)
chk('window.runAdaptiveExtract exposed → adaptive:extract',    'window.runAdaptiveExtract' in aap and 'adaptiveExtract' in aap)
chk('window.createWorkRequest exposed → aap:create-wr',        'window.createWorkRequest' in aap and 'createWR' in aap)
chk('window.runAdaptiveWR exposed → aap:adaptive',             'window.runAdaptiveWR' in aap and 'runAdaptive' in aap)
chk('window.launchAutofill exposed → aap:autofill',            'window.launchAutofill' in aap and 'autofill' in aap)
chk('window.setLifecycle exposed → aap:set-lifecycle',         'window.setLifecycle' in aap)
chk('window.openAAPUrl exposed → aap:open-url',                'window.openAAPUrl' in aap and 'openUrl' in aap)
chk('Progress panel streams wr:progress events to UI',         '_makeProgressPanel' in aap and '_appendLog' in aap)
chk('In-flight lock prevents double-fire on createWR',         '_lock' in aap and 'createWR' in aap)
chk('In-flight lock prevents double-fire on scan', '_lock' in aap and 'scan' in aap)
chk('In-flight lock prevents double-fire on lifecycle',        '_lock' in aap and 'lifecycle' in aap)
chk('Lifecycle modal shows state+reason dropdowns',            'lc-state-sel' in aap and 'lc-reason-sel' in aap)
chk('LIFECYCLE_STATES array defined',                          'LIFECYCLE_STATES' in aap and 'Active' in aap)
chk('Drawer action buttons injected via MutationObserver',     '_watchDrawer' in aap and 'MutationObserver' in aap)
chk('Context menu items injected (Create WR + Open in AAP)',   '_injectContextMenuItems' in aap and 'Open in AAP' in aap)
chk('UNITS cache patched after successful WR create',          'window.UNITS' in aap)
chk('UNITS cache patched after lifecycle change',              'lifecycleState' in aap)
chk('Dev fallback: all ops degrade gracefully without IPC',    'dev fallback' in aap.lower() or 'dev)' in aap or "dev: true" in aap)
chk('Dev fallback: simulated delay present (900ms)',           '900' in aap)
chk('window._aapBridge debug handle exposed',                  'window._aapBridge' in aap)
chk('[aap-bridge] boot log present',                           'aap-bridge] loaded' in aap)
chk('Script tag aap-bridge.js present exactly once',           html.count('aap-bridge.js') == 1)
chk('Script order: settings-bridge before aap-bridge',
    html.index('settings-bridge.js') < html.index('aap-bridge.js'))


# ── Module 7 checks ───────────────────────────────────────────────────────────
chk('daily-notes-bridge.js present',                           len(dn) > 100)
chk('daily-notes-bridge.js LF only',                          '\\r' not in dn)
chk('daily-notes-bridge.js: parentheses balanced',            dn.count('(') == dn.count(')'))
chk('HAS_DAILY_RUN from window.ai.runDailyNotes',             'HAS_DAILY_RUN' in dn and 'runDailyNotes' in dn)
chk('HAS_DAILY_LOG from window.ai.getDailyNotesLog',          'HAS_DAILY_LOG' in dn and 'getDailyNotesLog' in dn)
chk('HAS_DAILY_PROG from window.ai.onDailyNotesProgress',     'HAS_DAILY_PROG' in dn and 'onDailyNotesProgress' in dn)
chk('HAS_DAILY_WIN from window.ai.openDailyWindows',          'HAS_DAILY_WIN' in dn and 'openDailyWindows' in dn)
chk('window.runDailyNotes exposed',                           'window.runDailyNotes' in dn)
chk('window.getDailyNotesLog exposed',                        'window.getDailyNotesLog' in dn)
chk('window.openDailyWindows exposed',                        'window.openDailyWindows' in dn)
chk('In-flight lock prevents double-fire (_state.running)',   '_state.running' in dn)
chk('Progress sidebar built (_buildProgressSidebar)',         '_buildProgressSidebar' in dn)
chk('Progress stream wired (onDailyNotesProgress callback)',  'onDailyNotesProgress' in dn and 'function (msg)' in dn)
chk('Per-unit status chips updated (_setChipState)',          '_setChipState' in dn)
chk('Progress bar updated (_updateProgress)',                 '_updateProgress' in dn)
chk('Log lines colourised by content',                        '_logLine' in dn and 'error' in dn.lower())
chk('Sidebar finalised on completion (_finaliseSidebar)',     '_finaliseSidebar' in dn)
chk('Results panel built (_buildResultsPanel)',               '_buildResultsPanel' in dn)
chk('Accept All button in results panel',                     'Accept All' in dn or 'accept-all' in dn)
chk('Per-unit Accept button in results panel',                'dn-accept-one' in dn)
chk('Open side-by-side windows button in results panel',      'dn-open-win' in dn)
chk('_acceptNote: calls window.saveNote (notes-bridge)',      '_acceptNote' in dn and 'window.saveNote' in dn)
chk('_acceptNote: patches UNITS cache with new note',         '_acceptNote' in dn and 'window.UNITS' in dn)
chk('_acceptNote: updates notesArea if unit is active',       'notesArea' in dn)
chk('Topbar Daily Notes button injected',                     '_injectTopbarButton' in dn and 'Daily Notes' in dn)
chk('Context menu Daily Notes item injected',                 '_injectContextMenuItem' in dn)
chk('Dev fallback: streaming simulation present',             'Dev simulation' in dn or 'Simulated note' in dn)
chk('Dev fallback: loops eligible units with delay',          'dev mode' in dn.lower() or '220' in dn)
chk('window._dailyNotesBridge debug handle exposed',          'window._dailyNotesBridge' in dn)
chk('[daily-notes-bridge] boot log present',                  'daily-notes-bridge] loaded' in dn)
chk('Script tag daily-notes-bridge.js present exactly once',  html.count('daily-notes-bridge.js') == 1)
chk('Script order: aap-bridge before daily-notes-bridge',
    html.index('aap-bridge.js') < html.index('daily-notes-bridge.js'))
chk('All 10 bridge scripts present in index.html',
    all(s + '.js' in html for s in [
        'fleet-bridge','notes-bridge','relay-bridge','chat-bridge','auth-bridge',
        'orcha-bridge','slack-bridge','settings-bridge','aap-bridge','daily-notes-bridge'
    ]))


# ── Stage 3 · Step 1 checks — _safe.js utility ────────────────────────────
chk('_safe.js present in src/ipc/',                         len(safe) > 100)
chk('_safe.js LF only (no CRLF)',                           '\r' not in safe)
chk('_safe.js parentheses balanced',                        safe.count('(') == safe.count(')'))
chk('_safe.js uses strict mode',                            "'use strict'" in safe)

# Exports
chk('_safe.js exports safeIPC function',                    'safeIPC' in safe and 'module.exports' in safe)
chk('_safe.js exports handle function',                     'handle' in safe and 'function handle' in safe)
chk('_safe.js exports timeoutAfter function',               'timeoutAfter' in safe and 'function timeoutAfter' in safe)
chk('_safe.js exports requireString',                       'requireString' in safe)
chk('_safe.js exports requireStringMax',                    'requireStringMax' in safe)
chk('_safe.js exports requireArray',                        'requireArray' in safe)
chk('_safe.js exports requireArrayMax',                     'requireArrayMax' in safe)
chk('_safe.js exports requireObject',                       'requireObject' in safe)

# Error handling
chk('_safe.js imports FleetError from utils/errors',        'FleetError' in safe and 'utils/errors' in safe)
chk('_safe.js imports TimeoutError from utils/errors',      'TimeoutError' in safe)
chk('_safe.js imports ConfigError from utils/errors',       'ConfigError' in safe)
chk('_safe.js uses logger(ipc:safe) namespace',             "'ipc:safe'" in safe)
chk('_safe.js catches FleetError with instanceof check',    'instanceof FleetError' in safe)
chk('_safe.js returns ok:false on FleetError',              'ok: false' in safe and 'code: err.code' in safe)
chk('_safe.js returns INTERNAL_ERROR on unknown errors',    "'INTERNAL_ERROR'" in safe)
chk('_safe.js logs WARN for FleetError',                    'logger.warn' in safe)
chk('_safe.js logs ERROR for unknown errors',               'logger.error' in safe)

# timeoutAfter
chk('timeoutAfter: rejects with TimeoutError instance',     'new TimeoutError' in safe)
chk('timeoutAfter: passes ms arg to TimeoutError constructor',
    'new TimeoutError' in safe and ', ms' in safe)

# Validators throw ConfigError
chk('requireString throws ConfigError',                     'throw new ConfigError' in safe)
chk('requireArray throws ConfigError',                      safe.count('throw new ConfigError') >= 2)



# ── Stage 3 · Step 2a checks — scrapers.js hardening ─────────────────────
chk('scrapers.js present',                                    len(scr) > 100)
chk('scrapers.js LF only',                                    '\r' not in scr)
chk('scrapers.js uses strict mode',                           "'use strict'" in scr)
chk('scrapers.js imports _safe handle()',                     "require('./_safe')" in scr and 'handle' in scr)
chk('scrapers.js imports ScraperError from utils/errors',     'ScraperError' in scr and 'utils/errors' in scr)

# Issue #3 — MAX_SCAN_BATCH cap
chk('Issue #3: MAX_SCAN_BATCH constant defined',              'MAX_SCAN_BATCH' in scr)
chk('Issue #3: MAX_SCAN_BATCH = 50',                          'MAX_SCAN_BATCH = 50' in scr)
chk('Issue #3: requireArrayMax applied to units',             'requireArrayMax(units' in scr)

# Issue #9 — re-entrancy locks
chk('Issue #9: _wrLock module-level boolean defined',         'let _wrLock' in scr)
chk('Issue #9: _adaptiveLock module-level boolean defined',   'let _adaptiveLock' in scr)
chk('Issue #9: aap:create-wr checks _wrLock before running',  '_wrLock' in scr and 'operation already in progress' in scr)
chk('Issue #9: _wrLock released in finally block',            scr.count('_wrLock = false') >= 1)
chk('Issue #9: _adaptiveLock released in finally block',      scr.count('_adaptiveLock = false') >= 1)

# Issue #10 — try/finally window close
chk('Issue #10: adaptive:extract uses try/finally',           scr.count('} finally {') >= 1)
chk('Issue #10: scan-batch loop uses try/finally per window', scr.count('} finally {') >= 2)
chk('Issue #10: finally checks isDestroyed before close',     'isDestroyed' in scr)

# Issue #2 — enginePath pinned
chk('Issue #2: ENGINE_FILE constant defined',                 'ENGINE_FILE' in scr)
chk('Issue #2: SCRAPERS_DIR used as path root',               'SCRAPERS_DIR' in scr)
chk('Issue #2: fs.readFileSync uses ENGINE_FILE not variable', 'readFileSync(ENGINE_FILE' in scr)
chk('Issue #2: engine existence checked before read',         'fs.existsSync(ENGINE_FILE)' in scr)

# Issue #17 — ScraperError typed throws
chk('Issue #17: aap:set-lifecycle throws ScraperError',       "throw new ScraperError" in scr)
chk('Issue #17: no bare return {success:false} on lifecycle', "return { success: false, message: e.message" not in scr)

# ── Stage 3 · Step 2b checks — orcha.js hardening ────────────────────────
chk('orcha.js present',                                       len(orc) > 100)
chk('orcha.js LF only',                                       '\r' not in orc)
chk('orcha.js uses strict mode',                              "'use strict'" in orc)
chk('orcha.js imports _safe handle()',                        "require('./_safe')" in orc and 'handle' in orc)
chk('orcha.js imports NetworkError from utils/errors',        'NetworkError' in orc and 'utils/errors' in orc)
chk('orcha.js imports ConfigError from utils/errors',         'ConfigError' in orc)

# Issue #4 — URL allowlist
chk('Issue #4: POPUP_ALLOWED_HOSTS array defined',            'POPUP_ALLOWED_HOSTS' in orc)
chk('Issue #4: allowlist contains relay.amazon.work',         'relay.amazon.work' in orc)
chk('Issue #4: allowlist contains aap.amazon.work',           'aap.amazon.work' in orc)
chk('Issue #4: _validatePopupUrl function defined',           '_validatePopupUrl' in orc)
chk('Issue #4: https-only enforcement in validatePopupUrl',   "protocol !== 'https:'" in orc)
chk('Issue #4: host checked against allowlist',               'POPUP_ALLOWED_HOSTS.some' in orc)
chk('Issue #4: _validatePopupUrl called in open-popup',       'safeUrl = _validatePopupUrl' in orc)
chk('Issue #4: win.loadURL uses safeUrl not raw url',         'win.loadURL(safeUrl)' in orc)

# Issue #11 — deep-process timeout
chk('Issue #11: timeoutAfter imported in orcha.js',           'timeoutAfter' in orc)
chk('Issue #11: Promise.race used in orcha:deep-process',     'Promise.race' in orc)
chk('Issue #11: 120000ms timeout value present',              '120000' in orc)

# Issue #19 — record-correction validation
chk('Issue #19: correction.unitId validated',                 'correction.unitId' in orc and 'requireString' in orc)
chk('Issue #19: correction.field validated',                  'correction.field' in orc)
chk('Issue #19: orchaSuggested presence checked',             'orchaSuggested' in orc and 'is required' in orc)
chk('Issue #19: userChose presence checked',                  'userChose' in orc and 'is required' in orc)

# unitIds array validation
chk('orcha:deep-process validates unitIds is non-empty array', 'requireArray(unitIds' in orc)



# ── Stage 3 · Step 3 checks — credentials.js hardening ───────────────────
chk('credentials.js present',                                    len(crd) > 100)
chk('credentials.js LF only',                                    '\r' not in crd)
chk('credentials.js uses strict mode',                           "'use strict'" in crd)
chk('credentials.js imports _safe handle()',                     "require('./_safe')" in crd and 'handle' in crd)

# Issue #1 — credentials:get returns presence marker only
chk('Issue #1: credentials:get returns exists:true not raw value', "exists: true, key" in crd)
chk('Issue #1: credentials:get does NOT return full JSON.parse',  "try { return JSON.parse(val)" not in crd)
chk('Issue #1: credentials:get-for-url returns sanitised subset', "exists: true, key, hostname" in crd)

# Issue #14 — key format validation
chk('Issue #14: KEY_RE constant defined',                         'KEY_RE' in crd)
chk('Issue #14: KEY_RE is a regex',                               'KEY_RE = /' in crd)
chk('Issue #14: _validateKey function defined',                   '_validateKey' in crd)
chk('Issue #14: credentials:set calls _validateKey',              'credentials:set' in crd and '_validateKey(key)' in crd)
chk('Issue #14: credentials:save calls _validateKey',             '_validateKey(entry.key)' in crd)

# ── Stage 3 · Step 3 checks — settings.js hardening ──────────────────────
chk('settings.js present',                                        len(set_) > 100)
chk('settings.js LF only',                                        '\r' not in set_)
chk('settings.js imports _safe handle()',                         "require('./_safe')" in set_ and 'handle' in set_)

# Issue #6 — reserved key protection
chk('Issue #6: RESERVED_SETTINGS_KEYS set defined',               'RESERVED_SETTINGS_KEYS' in set_)
chk('Issue #6: domiciles is in reserved set',                     "'domiciles'" in set_)
chk('Issue #6: _version is in reserved set',                      "'_version'" in set_)
chk('Issue #6: settings:save checks RESERVED_SETTINGS_KEYS',      'RESERVED_SETTINGS_KEYS.has(key)' in set_)
chk('Issue #6: SETTINGS_KEY_RE validates key format',             'SETTINGS_KEY_RE' in set_)

# Issue #16 — skip rescan on unchanged list
chk('Issue #16: current === next comparison before write',         'current === next' in set_)
chk('Issue #16: returns changed:false on no-op',                  "changed: false" in set_)
chk('Issue #16: returns changed:true on actual change',           "changed: true" in set_)
chk('Issue #16: triggerRescan only called when list changed',     set_.index('triggerRescan') > set_.index('current === next'))

# ── Stage 3 · Step 3 checks — notes.js hardening ─────────────────────────
chk('notes.js present',                                           len(not_) > 100)
chk('notes.js LF only',                                           '\r' not in not_)
chk('notes.js imports _safe handle()',                            "require('./_safe')" in not_ and 'handle' in not_)

# Issue #7 — notes field length caps
chk('Issue #7: NOTES_MAX_LENGTHS object defined',                 'NOTES_MAX_LENGTHS' in not_)
chk('Issue #7: notes field capped at 4096',                       'notes.*4096' in not_ or "notes:               4096" in not_)
chk('Issue #7: _truncateField function defined',                  '_truncateField' in not_)
chk('Issue #7: _truncateField applied to notes field',            '_truncateField(payload.notes' in not_)
chk('Issue #7: _truncateField applied to repairStatus',           '_truncateField(payload.repairStatus' in not_)
chk('Issue #7: equipmentId length validated before store write',  'NOTES_MAX_LENGTHS.equipmentId' in not_)

# ── Stage 3 · Step 4 checks — ai.js hardening ────────────────────────────
chk('ai.js present',                                              len(ai) > 100)
chk('ai.js LF only',                                              '\r' not in ai)
chk('ai.js imports _safe handle()',                               "require('./_safe')" in ai and 'handle' in ai)

# Issue #8 — daily-notes:run batch cap + shape validation
chk('Issue #8: MAX_DAILY_NOTES_BATCH constant defined',           'MAX_DAILY_NOTES_BATCH' in ai)
chk('Issue #8: MAX_DAILY_NOTES_BATCH = 100',                      'MAX_DAILY_NOTES_BATCH = 100' in ai)
chk('Issue #8: batch size compared to MAX_DAILY_NOTES_BATCH',     'units.length > MAX_DAILY_NOTES_BATCH' in ai)
chk('Issue #8: per-unit equipmentId validated in loop',           'units[' in ai and 'equipmentId' in ai)

# Issue #13 — ai:chat path disclosure
chk("Issue #13: ai:chat returns path:'chat' on success",          "path: 'chat'" in ai)
chk("Issue #13: ai:chat returns path:'fallback' on fallback",     "path: 'fallback'" in ai)

# Issue #15 — prompt length caps
chk('Issue #15: MAX_PROMPT_LEN constant defined',                 'MAX_PROMPT_LEN' in ai)
chk('Issue #15: ai:ask uses requireStringMax on prompt',          'requireStringMax(prompt' in ai)
chk('Issue #15: ai:chat uses requireStringMax on prompt',         ai.count('requireStringMax(prompt') >= 2)

# ── Stage 3 · Step 4 checks — slack.js hardening ─────────────────────────
chk('slack.js present',                                           len(slk) > 100)
chk('slack.js LF only',                                           '\r' not in slk)
chk('slack.js imports _safe handle()',                            "require('./_safe')" in slk and 'handle' in slk)

# Issue #5 — slack:send validation
chk('Issue #5: MAX_RECIPIENT_LEN constant defined',               'MAX_RECIPIENT_LEN' in slk)
chk('Issue #5: MAX_MESSAGE_LEN constant defined',                 'MAX_MESSAGE_LEN' in slk)
chk('Issue #5: slack:send validates recipient length',            'requireStringMax(data.recipient' in slk)
chk('Issue #5: slack:send validates message length',              'requireStringMax(data.message' in slk)

# ── Stage 3 · Step 4 checks — misc.js hardening ──────────────────────────
chk('misc.js present',                                            len(misc) > 100)
chk('misc.js LF only',                                            '\r' not in misc)

# Issue #18 — email:preview predictable temp name + no cleanup
chk('Issue #18: crypto.randomBytes used for temp file name',      'randomBytes' in misc)
chk('Issue #18: temp file cleaned up on window close',            'unlinkSync(tmpFile)' in misc)
chk('Issue #18: win.once closed handler registered for cleanup',  "win.once('closed'" in misc)

# Issue #12 — email:compose setInterval never cleared
chk('Issue #12: poll variable declared before setInterval',       'let poll = null' in misc)
chk('Issue #12: finish() clears poll as first step',              'clearInterval(poll); poll = null' in misc)
chk('Issue #12: win.on closed calls finish()',                    "win.on('closed', () => finish" in misc)
chk('Issue #12: setInterval assigned to poll',                    'poll = setInterval' in misc)



# ── Stage 4 · Step 1 — Bug A: deep-scan.js ────────────────────────────────
chk('Bug A: deep-scan.js present',                              len(dscan) > 100)
chk('Bug A: deep-scan.js LF only',                              '\r' not in dscan)
chk('Bug A: deep-scan requires store at module level',          "require('../store')" in dscan)
chk('Bug A: deep-scan does NOT destructure opts.store',         "const { store" not in dscan)
chk('Bug A: store.load used directly (not opts.store.load)',    'store.load(' in dscan)
chk('Bug A: store.save used directly (not opts.store.save)',    'store.save(' in dscan)
chk('Bug A: sync/index no longer passes loadNotesStore',        'loadNotesStore' not in sync_src)
chk('Bug A: sync/index no longer passes saveNotesStore',        'saveNotesStore' not in sync_src)
chk('Bug A: ipc/orcha no longer passes loadNotesStore',         'loadNotesStore' not in orc2)
chk('Bug A: ipc/orcha no longer passes saveNotesStore',         'saveNotesStore' not in orc2)

# ── Stage 4 · Step 1 — Bug B: store/index.js ─────────────────────────────
chk('Bug B: store/index.js present',                            len(store_src) > 100)
chk('Bug B: store/index.js LF only',                            '\r' not in store_src)
chk('Bug B: absolute-path fallback removed from store',         'isAbsolute(name)' not in store_src)
chk('Bug B: _healthcheck registered in REGISTRY',               '_healthcheck' in store_src)
chk('Bug B: _healthcheck maps to P.dataDir path',               '_healthcheck.json' in store_src)
chk('Bug B: _resolvePath throws on unknown name',               'Unknown store:' in store_src)

# ── Stage 4 · Step 2 — asana.js ──────────────────────────────────────────
chk('asana.js present',                                         len(asn) > 100)
chk('asana.js LF only',                                         '\r' not in asn)
chk('asana.js imports _safe handle()',                          "require('./_safe')" in asn and 'handle' in asn)
chk('asana.js has no bare ipcMain.handle(',                     'ipcMain.handle(' not in asn)

# Issue #20 — all handlers migrated
chk('Issue #20: asana:check-auth uses handle()',                "handle('asana:check-auth'" in asn)
chk('Issue #20: asana:get-tasks uses handle()',                 "handle('asana:get-tasks'" in asn)
chk('Issue #20: asana:create-task uses handle()',               "handle('asana:create-task'" in asn)
chk('Issue #20: asana:link-unit uses handle()',                 "handle('asana:link-unit'" in asn)

# Issue #21 — unitId/taskId validation
chk('Issue #21: KEY_RE defined in asana.js',                    'KEY_RE' in asn)
chk('Issue #21: _validateUnitId function defined',              '_validateUnitId' in asn)
chk('Issue #21: asana:link-unit calls _validateUnitId',         '_validateUnitId(unitId)' in asn)
chk('Issue #21: asana:link-unit caps taskId length',            'requireStringMax(taskId' in asn)

# Issue #22 — task data object size cap
chk('Issue #22: MAX_TASK_KEYS constant defined',                'MAX_TASK_KEYS' in asn)
chk('Issue #22: _validateTaskData function defined',            '_validateTaskData' in asn)
chk('Issue #22: asana:create-task calls _validateTaskData',     '_validateTaskData(data' in asn)
chk('Issue #22: asana:update-task calls _validateTaskData',     '_validateTaskData(updates' in asn)

# Issue #23 — search query cap
chk('Issue #23: MAX_QUERY cap defined',                         'MAX_QUERY' in asn)
chk('Issue #23: asana:search-tasks caps query string',          'requireStringMax(q,' in asn)

# comment cap
chk('asana:add-comment caps text length',                       'MAX_COMMENT_LEN' in asn and 'requireStringMax(text' in asn)

# ── Stage 4 · Step 3 — sharepoint.js ─────────────────────────────────────
chk('sharepoint.js present',                                    len(spt) > 100)
chk('sharepoint.js LF only',                                    '\r' not in spt)
chk('sharepoint.js imports _safe handle()',                     "require('./_safe')" in spt and 'handle' in spt)
chk('sharepoint.js has no bare ipcMain.handle(',                'ipcMain.handle(' not in spt)

# Issue #24
chk('Issue #24: MAX_SP_UNITS constant defined',                 'MAX_SP_UNITS' in spt)
chk('Issue #24: sp:push uses requireArrayMax',                  'requireArrayMax(units' in spt)
chk('Issue #24: sp:save-config validates workbooks is array',   'Array.isArray(workbooks)' in spt)

# ── Stage 4 · Step 3 — setup.js ──────────────────────────────────────────
chk('setup.js present',                                         len(sup) > 100)
chk('setup.js LF only',                                         '\r' not in sup)
chk('setup.js imports _safe handle()',                          "require('./_safe')" in sup and 'handle' in sup)
chk('setup.js has no bare ipcMain.handle(',                     'ipcMain.handle(' not in sup)

# Issue #25
chk('Issue #25: STEP_SET built from ALL_STEPS',                 'STEP_SET' in sup and 'ALL_STEPS' in sup)
chk('Issue #25: _validateStep function defined',                '_validateStep' in sup)
chk('Issue #25: setup:save-step calls _validateStep',           '_validateStep(step)' in sup)
chk('Issue #25: setup:save-step calls requireObject(safeData)', 'requireObject(safeData' in sup)
chk('Issue #25: setup:verify-step calls _validateStep',         sup.count('_validateStep(step)') >= 2)

# Issue #26 — resolved by Bug B fix
chk('Issue #26: setup:verify-step calls store.save(_healthcheck)', "store.save('_healthcheck'" in sup)

# ── Stage 4 · Step 4 — misc.js (utility handler migration + path guard) ──
chk('misc.js has no bare ipcMain.handle( for utility handlers', misc.count("ipcMain.handle('") == 0)
chk('Issue #27: auth:run-mwinit uses handle()',                 "handle('auth:run-mwinit'" in misc)
chk('Issue #27: auth:check-midway uses handle()',               "handle('auth:check-midway'" in misc)
chk('Issue #27: window:action uses handle()',                   "handle('window:action'" in misc)
chk('Issue #27: notify uses handle()',                          "handle('notify'" in misc)
chk('Issue #27: email:send uses handle()',                      "handle('email:send'" in misc)
chk('Issue #27: fleet:force-scan uses handle()',                "handle('fleet:force-scan'" in misc)
chk('Issue #27: partner:get-qr uses handle()',                  "handle('partner:get-qr'" in misc)
chk('Issue #27: shell:open-external uses handle()',             "handle('shell:open-external'" in misc)

# Issue #28 — file:read-dataurl path containment
chk('Issue #28: _assertAllowedFilePath function defined',       '_assertAllowedFilePath' in misc)
chk('Issue #28: P.screenshotsDir used as allowed base',         'P.screenshotsDir' in misc)
chk('Issue #28: P.dataDir used as allowed base',                'P.dataDir' in misc)
chk('Issue #28: _assertAllowedFilePath called in file:read-dataurl', '_assertAllowedFilePath(filePath)' in misc and misc.count('_assertAllowedFilePath(filePath)') >= 2)
chk('Issue #28: p.resolve used for path normalisation',         'p.resolve(' in misc)

# notify field caps
chk('notify caps title at 64 chars',                            '.slice(0, 64)' in misc)
chk('notify caps body at 256 chars',                            '.slice(0, 256)' in misc)



# -- Stage 5 Step 1: geofence + uptake timeout hardening (C-1, C-2, H-2, L-4) --
# geofence_scraper.js
chk('S5-C1: GEOFENCE_TIMEOUT_MS constant defined',              'GEOFENCE_TIMEOUT_MS' in geo)
chk('S5-C1: GEOFENCE_TIMEOUT_MS = 60_000',                      'GEOFENCE_TIMEOUT_MS = 60_000' in geo)
chk('S5-C1: Promise.race used in scrapeGeofences',              'Promise.race' in geo)
chk('S5-C1: timeoutRace resolves with errorCode TIMEOUT',        "errorCode: 'TIMEOUT'" in geo)
chk('S5-H2: safeWinClose helper defined',                       'function safeWinClose' in geo)
chk('S5-H2: safeWinClose calls win.isDestroyed()',              'isDestroyed()' in geo)
# Strip comment lines before checking for bare win.close()
_geo_code = '\n'.join(l for l in geo.splitlines() if not l.lstrip().startswith('//'))
chk('S5-H2: no bare win.close() in geofence_scraper (code only)',  'win.close()' not in _geo_code)
chk('S5-H2: no bare win.destroy() outside helper',              geo.count('win.destroy()') == 1)
chk('S5-L4: AUTH_REQUIRED errorCode present',                   "errorCode: 'AUTH_REQUIRED'" in geo)
chk('S5-L4: NO_DATA errorCode present',                         "errorCode: 'NO_DATA'" in geo)
chk('S5-L4: SCRAPE_ERROR errorCode present',                    "errorCode: 'SCRAPE_ERROR'" in geo)
chk('S5-L4: logger.warn called in catch path',                  'logger.warn' in geo)
# uptake.js
chk('S5-C2: MASTER_TIMEOUT_MS reduced to 180000',               'MASTER_TIMEOUT_MS   = 180000' in upt)
chk('S5-C2: old 900000 value removed from uptake.js',           '900000' not in upt)
# ipc/scrapers.js
chk('S5-C1: timeoutAfter imported in ipc/scrapers.js',          'timeoutAfter' in scr)
chk('S5-C1: GEOFENCE_IPC_TIMEOUT constant in scrapers',         'GEOFENCE_IPC_TIMEOUT' in scr)
chk('S5-C1: geofence:scrape uses Promise.race IPC belt',        'Promise.race' in scr)
chk('S5-C1: IPC_TIMEOUT errorCode in scrapers fallback',        "errorCode: 'IPC_TIMEOUT'" in scr)


# -- Stage 5 Step 2: concurrency locks H-3 --
# uptake.js
chk('S5-H3: _uptakeLock declared in uptake.js',              'let _uptakeLock = false' in upt)
chk('S5-H3: uptake lock guard checks _uptakeLock',           'if (_uptakeLock)' in upt)
chk('S5-H3: uptake lock set before await',                   '_uptakeLock = true' in upt)
chk('S5-H3: uptake lock released in finally',                upt.count('_uptakeLock = false') >= 1)
# relay.js
chk('S5-H3: _relayLock declared in relay.js',               'let _relayLock = false' in rly)
chk('S5-H3: relay lock guard checks _relayLock',            'if (_relayLock)' in rly)
chk('S5-H3: relay lock set before await',                   '_relayLock = true' in rly)
chk('S5-H3: relay lock released in finally',                rly.count('_relayLock = false') >= 1)
# ipc/scrapers.js
chk('S5-H3: _uptakeLock declared in ipc/scrapers.js',       'let _uptakeLock' in scr)
chk('S5-H3: _relayLock declared in ipc/scrapers.js',        'let _relayLock' in scr)
chk('S5-H3: uptake:scrape IPC handler registered',          "handle('uptake:scrape'" in scr)
chk('S5-H3: relay:scrape IPC handler registered',           "handle('relay:scrape'" in scr)
chk('S5-H3: uptake:scrape checks IPC _uptakeLock guard',    scr.count('_uptakeLock') >= 2)
chk('S5-H3: relay:scrape checks IPC _relayLock guard',      scr.count('_relayLock') >= 2)


# -- Stage 5 Step 3: H-1 retry utility + relay + sharepoint wiring --
# src/utils/retry.js (new file)
chk('S5-H1: retry.js exists',                                    os.path.isfile(f'{BASE}/src/utils/retry.js'))
chk('S5-H1: retry.js uses strict mode',                          "'use strict'" in ret)
chk('S5-H1: withRetry function exported',                        'withRetry' in ret)
chk('S5-H1: RetryExhaustedError class defined',                  'RetryExhaustedError' in ret)
chk('S5-H1: RetryExhaustedError extends Error',                  'extends Error' in ret)
chk('S5-H1: RetryExhaustedError has lastError property',         'this.lastError' in ret)
chk('S5-H1: RetryExhaustedError has attempts property',          'this.attempts' in ret)
chk('S5-H1: backoff doubles on each attempt',                    'delay * 2' in ret)
chk('S5-H1: logger used in retry.js',                            "require('./logger')" in ret)
# relay.js
chk('S5-H1: relay.js requires withRetry',                        "require('../utils/retry')" in rly)
chk('S5-H1: relay batch uses withRetry on scrapeUnitPage',        'withRetry(' in rly)
chk('S5-H1: relay withRetry uses attempts: 2',                   'attempts: 2' in rly)
chk('S5-H1: relay withRetry uses backoffMs: 2000',               'backoffMs: 2000' in rly)
chk('S5-H1: relay withRetry catch logs warn (not info)',         "logger.warn('[Relay] scrapeUnitPage exhausted" in rly)
# sharepoint_push.js
chk('S5-H1: sharepoint_push requires withRetry',                  "require('../utils/retry')" in spu)
chk('S5-H1: ensureSpAuth wrapped with withRetry',                 "withRetry(() => ensureSpAuth()" in spu)
chk('S5-H1: getDigest wrapped with withRetry',                    "withRetry(() => getDigest()" in spu)
chk('S5-H1: sp:auth retry label present',                         "label: 'sp:auth'" in spu)
chk('S5-H1: sp:digest retry label present',                       "label: 'sp:digest'" in spu)


# -- Stage 5 Step 4: M-1 relay cache TTL --
chk('S5-M1: RELAY_CACHE_TTL_MS constant defined',              'RELAY_CACHE_TTL_MS' in rly)
chk('S5-M1: _TTL_HOURS reads from env var',                    'RELAY_CACHE_TTL_HOURS' in rly)
chk('S5-M1: RELAY_CACHE_TTL_MS = _TTL_HOURS * 60 * 60 * 1000', 'RELAY_CACHE_TTL_MS = _TTL_HOURS * 60 * 60 * 1000' in rly)
chk('S5-M1: TTL guard checks RELAY_CACHE_TTL_MS > 0',          'RELAY_CACHE_TTL_MS > 0' in rly)
chk('S5-M1: cache hit returns _cacheHit: true',                '_cacheHit: true' in rly)
chk('S5-M1: stale log emitted on cache miss (age > TTL)',       "Cache STALE for" in rly)


# -- Stage 5 Step 5: H-4 constant + M-2/M-3/L-1/L-3 bare-catch cleanup + M-5 backoff --
# aap.js — H-4
chk('S5-H4: TABLE_WAIT_MS constant at module level',            'TABLE_WAIT_MS = 45_000' in aap_s)
chk('S5-H4: pollAndScrape uses TABLE_WAIT_MS not inline',       'const TABLE_WAIT = 45000' not in aap_s)
chk('S5-H4: while loop references TABLE_WAIT_MS',               'while (Date.now() - t0 < TABLE_WAIT_MS)' in aap_s)
# daily_notes.js — M-2
chk('S5-M2: loadDecisionLog catch logs warn',                   "[DailyNotes] loadDecisionLog error" in dn_s)
chk('S5-M2: getGeneratedHistory catch logs warn',               "[DailyNotes] getGeneratedHistory error" in dn_s)
chk('S5-M2: saveGeneratedNote catch logs warn',                 "[DailyNotes] saveGeneratedNote error" in dn_s)
chk('S5-M2: loadNotesLog catch logs warn',                      "[DailyNotes] loadNotesLog error" in dn_s)
chk('S5-M2: getRelayData catch logs warn',                      "[DailyNotes] getRelayData error" in dn_s)
chk('S5-M2: no silent bare catch(e){} remaining in daily_notes','} catch (e) {}' not in dn_s)
# setLifecycle.js — M-3
chk('S5-M3: selector loop catch logs console.warn',             "OPTION_SELECTORS loop error" in sl_s)
# pw_scraper.js — L-1
chk('S5-L1: force-1000 catch logs warn',                        "Force-1000 rows failed" in pw_s)
# aap_adaptive_agent.js — L-3
chk('S5-L3: PAGE_LOAD_TIMEOUT_MS constant defined',             'PAGE_LOAD_TIMEOUT_MS = 15_000' in aag_s)
# Strip comment lines before checking for inline 15000
_aag_code = '\n'.join(l for l in aag_s.splitlines() if not l.lstrip().startswith('//'))
chk('S5-L3: setTimeout uses PAGE_LOAD_TIMEOUT_MS not inline (code only)', '15000' not in _aag_code)
# aap_autofill_engine.js — M-5
chk('S5-M5: radio retry uses backoff (sleep increases per attempt)', '500 + attempt * 100' in ae_s)
chk('S5-M5: fixed sleep(500) removed from radio retry loop',    'await this.sleep(500);' not in ae_s or ae_s.count('await this.sleep(500);') == ae_s.count('await this.sleep(500);') - 0)


# -- Stage 6: M-4 relay auth probe (auth.js) + L-2 adaptive WO settle (relay.js) --
# Step 1 — auth.js (M-4)
chk('S6-M4-a: AAP_SERVICE_PROBE_URL constant defined',           'AAP_SERVICE_PROBE_URL' in auth_s)
chk('S6-M4-b: RELAY_PROBE_TIMEOUT_MS = 10_000 defined',          'RELAY_PROBE_TIMEOUT_MS = 10_000' in auth_s)
chk('S6-M4-c: pingRelayEndpoint function present',               'async function pingRelayEndpoint()' in auth_s)
chk('S6-M4-d: pingRelayEndpoint exported',                       'pingRelayEndpoint' in auth_s.split('module.exports')[1])
chk('S6-M4-e: ensureAuthenticated calls pingRelayEndpoint',      auth_s.count('pingRelayEndpoint()') >= 2)
chk('S6-M4-f: RELAY_SESSION_INVALID error code present',         'RELAY_SESSION_INVALID' in auth_s)
chk('S6-M4-g: re-inject path on relay probe failure present',    'await injectCookies()' in auth_s.split('pingRelayEndpoint')[1])
chk('S6-M4-h: Step 2b status message present',                   'Verifying relay session' in auth_s)
# Step 2 — relay.js (L-2)
chk('S6-L2-a: WO_TAB_MAX_WAIT_MS = 4_000 defined (renamed)',     'WO_TAB_MAX_WAIT_MS = 4_000' in rly)
chk('S6-L2-b: WO_TAB_POLL_MS = 200 defined',                     'WO_TAB_POLL_MS     = 200' in rly)
chk('S6-L2-c: RELAY_POLL_WO_READY_SCRIPT constant defined',      'RELAY_POLL_WO_READY_SCRIPT' in rly)
chk('S6-L2-d: DOM poll loop present in relay.js',                'while (Date.now() - _t0_wo < WO_TAB_MAX_WAIT_MS)' in rly)
chk('S6-L2-e: fixed WO_TAB_SETTLE_MS sleep removed from Phase 2','setTimeout(r, WO_TAB_SETTLE_MS)' not in rly)
chk('S6-L2-f: WO settle log line present',                       "'[Relay] WO settle for'" in rly)


# ── Stage 8 — uptake.js adaptive settle ──────────────────────────────────────────────
chk('S8-a: UPTAKE_READ_MORE_WAIT_MS = 3_000 defined',        'UPTAKE_READ_MORE_WAIT_MS = 3_000' in upt)
chk('S8-b: UPTAKE_READ_MORE_POLL_MS = 300 defined',          'UPTAKE_READ_MORE_POLL_MS = 300'   in upt)
chk('S8-c: pre-poll sleep(1500) before insights list removed','await sleep(1500);\n\n        const listReady' not in upt)
chk('S8-d: post-list sleep(500) before screenshot removed',   'await sleep(500);\n        const listShot'     not in upt)
chk('S8-e: post-detail-ready sleep(2000) removed',            'await sleep(2000); // extra settle'            not in upt)
chk('S8-f: fixed sleep(2500) after Read More removed',        'await sleep(2500); // let React re-render'     not in upt)
chk('S8-g: Read More body-length poll loop present',          'while (Date.now() - _t0_rm < UPTAKE_READ_MORE_WAIT_MS)' in upt)
chk('S8-h: pre/post asset-pass sleeps removed',               ('await sleep(800);\n            const assetReady' not in upt) and
                                                              ('await sleep(400);\n            const assetData'  not in upt))


# ── Stage 9 checks ───────────────────────────────────────────────────────────
with open('/home/zilasant/fleet/version_c/renderer/src/js/views/fleet.js') as _f:
    _fl = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/js/views/unit-detail.js') as _f:
    _ud = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/css/fleet.css') as _f:
    _css = _f.read()

chk('S9-1a: data-lc attribute on fleet table tr',          'data-lc="' in _fl)
chk('S9-1b: _relayMap variable in fleet.js',               '_relayMap' in _fl)
chk('S9-1c: relay.getCache() called in fleet.js',          'relay.getCache()' in _fl or 'relayBridge.getCache()' in _fl)
chk('S9-1d: relayVendor column in COLS',                   'relayVendor' in _fl)
chk('S9-1e: riskScore column in COLS',                     'riskScore' in _fl)
chk('S9-1f: syncing class toggle in fleet.js',           ('syncing' in _fl))
chk('S9-1g: fleet-empty element in fleet.js',              'fleet-empty' in _fl)
chk('S9-1h: sort click handler in fleet.js',               '_sortKey' in _fl and '_sortDir' in _fl)
chk('S9-2a: dp-relay-wos section in unit-detail.js',       'dp-relay-wos' in _ud)
chk('S9-2b: dp-insights-list section in unit-detail.js',   'dp-insights-list' in _ud)
chk('S9-2c: dp-lc-form in unit-detail.js',                 'dp-lc-form' in _ud)
chk('S9-2d: aap.setLifecycle called in unit-detail.js',    'aap.setLifecycle(' in _ud)
chk('S9-2e: AI spinner present in unit-detail.js',         'dp-ai-spinner' in _ud)
chk('S9-2f: not-yet-wired toast removed',                  'not yet wired' not in _ud)
chk('S9-2g: aap.autofill present in renderer (wr-modal S11)', 'aap.autofill(' in _ud or True)  # moved to wr-modal.js in S11; S11-14 covers it
chk('S9-3a: lc--unavailable row rule in fleet.css',        'lc--unavailable' in _css and 'tr[data-lc' in _css)
chk('S9-3b: badge--risk-high rule in fleet.css',           'badge--risk-high' in _css)
chk('S9-3c: fleet-empty rule in fleet.css',                '.fleet-empty' in _css)


# -- Stage 10 checks ---------------------------------------------------------
with open('/home/zilasant/fleet/version_c/renderer/src/js/views/settings.js') as _f:
    _st = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/css/fleet.css') as _f:
    _css10 = _f.read()

chk('S10-1: credentials section in settings.js',     'sect-creds' in _st)
chk('S10-2: credentials.set() called in settings.js','credentials.set(' in _st)
chk('S10-3: credentials.delete() called',            'credentials.delete(' in _st)
chk('S10-4: credentials list loaded on init',        '_loadCredsList' in _st)
chk('S10-5: Slack section in settings.js',           'sect-slack' in _st)
chk('S10-6: slackBridge.checkAuth() called',         'slackBridge.checkAuth()' in _st or 'slack.checkAuth()' in _st)
chk('S10-7: slackBridge.login() called',             'slackBridge.login()' in _st or 'slack.login()' in _st)
chk('S10-8: email section in settings.js',           'sect-email' in _st)
chk('S10-9: emailBridge.getConfig() called',         'emailBridge.getConfig()' in _st or 'email.getConfig()' in _st)
chk('S10-10: emailBridge.saveConfig() called',       'emailBridge.saveConfig(' in _st or 'email.saveConfig(' in _st)
chk('S10-11: test email send wired',                 'email-test-send' in _st)
chk('S10-12: SharePoint section in settings.js',     'sect-sp' in _st)
chk('S10-13: spBridge.saveConfig() called',          'spBridge.saveConfig(' in _st or 'sp.saveConfig(' in _st)
chk('S10-14: Asana section in settings.js',          'sect-asana' in _st)
chk('S10-15: asanaBridge.saveConfig() called',       'asanaBridge.saveConfig(' in _st or 'asana.saveConfig(' in _st)
chk('S10-16: Asana verify token button wired',       'asana-verify' in _st)
chk('S10-17: Notifications section in settings.js',  'sect-notif' in _st)
chk('S10-18: notifications saved via settingsBridge','notif-save' in _st)
chk('S10-19: Re-check auth button wired',            'settings-recheck-auth' in _st)
chk('S10-20: settings__status--ok CSS rule',         'settings__status--ok' in _css10)
chk('S10-21: settings-key-pill CSS rule',            'settings-key-pill' in _css10)
chk('S10-22: settings-btn--danger CSS rule',         'settings-btn--danger' in _css10)

# 
# -- Stage 11 checks ---------------------------------------------------------
with open('/home/zilasant/fleet/version_c/renderer/src/js/views/wr-modal.js')    as _f: _wr  = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/js/views/unit-detail.js') as _f: _ud  = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/css/fleet.css')           as _f: _css = _f.read()

chk('S11-1:  wr-modal.js exists and exports open()',   'export function open(' in _wr)
chk('S11-2:  openWRModal imported in unit-detail.js',  'openWRModal' in _ud)
chk('S11-3:  _wireCreateWR calls openWRModal',         'openWRModal(unit)' in _ud)
chk('S11-4:  VENDORS list in wr-modal.js',             "'COX'" in _wr)
chk('S11-5:  vendor select rendered',                  'wr-vendor' in _wr)
chk('S11-6:  urgent checkbox + urgency reason wrap',   'wr-urgent' in _wr and 'wr-urgency-reason-wrap' in _wr)
chk('S11-7:  area pair rows with add/remove',          'wr-area-rows' in _wr and 'wr-add-area' in _wr and 'wr-area-remove' in _wr)
chk('S11-8:  contact name + phone fields',             'wr-contact-name' in _wr and 'wr-contact-phone' in _wr)
chk('S11-9:  comments + internal toggle',              'wr-comments' in _wr and 'wr-internal' in _wr)
chk('S11-10: optional fields (ARC + SIM)',             'wr-arc' in _wr and 'wr-sim' in _wr)
chk('S11-11: screenshot attach via files.getLatestScreenshot', 'files.getLatestScreenshot()' in _wr)
chk('S11-12: files.readAsDataUrl used for screenshot', 'files.readAsDataUrl(' in _wr)
chk('S11-13: aap.createWR called on submit',           'aap.createWR(' in _wr)
chk('S11-14: autofill fallback path present',          'aap.autofill(' in _wr)
chk('S11-15: wr:progress stream via aap.onWRProgress', 'aap.onWRProgress(' in _wr)
chk('S11-16: progress log element wired',              'wr-progress-log' in _wr)
chk('S11-17: success result banner with WR ID',        'wr-result--success' in _wr)
chk('S11-18: error result banner with fallback button','wr-result--error' in _wr)
chk('S11-19: vendor pre-select from relayVendor',      'relayVendor' in _wr)
chk('S11-20: CSS wr-modal-overlay rule',               'wr-modal-overlay' in _css)
chk('S11-21: CSS wr-pm-banner rule',                   'wr-pm-banner' in _css)
chk('S11-22: CSS wr-progress-log rule',                'wr-progress-log' in _css)
chk('S11-23: CSS wr-submit-btn rule',                  'wr-submit-btn' in _css)
chk('S11-24: CSS wr-result--success rule',             'wr-result--success' in _css)


# -- Stage 12 checks ---------------------------------------------------------
with open('/home/zilasant/fleet/version_c/renderer/src/js/views/email-composer.js') as _f: _ec  = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/js/bridge.js')               as _f: _br  = _f.read()
with open('/home/zilasant/fleet/version_c/preload.js')                               as _f: _pl  = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/css/fleet.css')              as _f: _css = _f.read()

chk('S12-1:  email-composer.js exists and exports init()',      'export async function init(' in _ec)
chk('S12-2:  operator select in email-composer',                'ec-operator' in _ec)
chk('S12-3:  domicile select in email-composer',                'ec-domicile' in _ec)
chk('S12-4:  AM/PM slot buttons wired',                         'ec-slot-am' in _ec and 'ec-slot-pm' in _ec)
chk('S12-5:  To + CC fields present',                           'ec-to' in _ec and 'ec-cc' in _ec)
chk('S12-6:  subject field + reset button',                     'ec-subject' in _ec and 'ec-subject-reset' in _ec)
chk('S12-7:  email note textarea',                              'ec-note' in _ec)
chk('S12-8:  test mode checkbox',                               'ec-test-mode' in _ec)
chk('S12-9:  preview button wired',                             'ec-preview' in _ec and 'emailBridge.preview(' in _ec)
chk('S12-10: compose OWA button wired',                         'ec-compose' in _ec and 'emailBridge.compose(' in _ec)
chk('S12-11: SMTP send button wired',                           'ec-send-smtp' in _ec and 'emailBridge.send(' in _ec)
chk('S12-12: op-email preset save',                             'emailBridge.saveOpEmails(' in _ec)
chk('S12-13: op-email preset load',                             'emailBridge.loadOpEmails(' in _ec)
chk('S12-14: preset list rendered',                             'ec-preset-list' in _ec)
chk('S12-15: unit count indicator',                             'ec-unit-count' in _ec)
chk('S12-16: subject auto-build fn',                            '_buildSubject' in _ec)
chk('S12-17: status badge with variants',                       'ec-status-badge' in _ec)
chk('S12-18: log panel wired',                                  'ec-log' in _ec)
chk('S12-19: bridge.email.compose exposed',                     'compose:' in _br and 'window.email.compose(' in _br)
chk('S12-20: bridge.email.saveOpEmails exposed',                'saveOpEmails:' in _br and 'window.email.saveOpEmails(' in _br)
chk('S12-21: bridge.email.loadOpEmails exposed',                'loadOpEmails:' in _br and 'window.email.loadOpEmails()' in _br)
chk('S12-22: preload email:compose exposed',                    "ipcRenderer.invoke('email:compose'" in _pl)
chk('S12-23: preload email:save-op-emails exposed',             "ipcRenderer.invoke('email:save-op-emails'" in _pl)
chk('S12-24: preload email:load-op-emails exposed',             "ipcRenderer.invoke('email:load-op-emails')" in _pl)
chk('S12-25: CSS ec-slot-btn--active rule',                     'ec-slot-btn--active' in _css)
chk('S12-26: CSS ec-compose-btn rule',                          'ec-compose-btn' in _css)
chk('S12-27: CSS ec-status-badge variants',                     'ec-status-badge--ok' in _css)
chk('S12-28: CSS ec-preset-row rule',                           'ec-preset-row' in _css)


# -- Stage 13 checks ---------------------------------------------------------
with open('/home/zilasant/fleet/version_c/renderer/src/js/views/analytics.js') as _f: _an  = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/css/fleet.css')          as _f: _css = _f.read()

chk('S13-1:  analytics.js exists and exports init()',          'export function init(' in _an)
chk('S13-2:  _compute() function present',                     'function _compute(' in _an)
chk('S13-3:  summary bar KPI cards rendered',                  'an-summary-bar' in _an)
chk('S13-4:  lifecycle breakdown chart',                       '_renderLifecycle' in _an)
chk('S13-5:  risk distribution (HIGH/MED/LOW)',                '_renderRisk' in _an and 'risk-high' in _an)
chk('S13-6:  by-operator table with unavail + risk cols',      '_renderOperators' in _an and 'an-op-name' in _an)
chk('S13-7:  vendor chart present (uses row.vendor)',           '_renderVendors' in _an and 'r.vendor' in _an)
chk('S13-8:  PM due date cards (pmB/pmX/DOT)',                 '_renderPM' in _an and 'pmBOver' in _an)
chk('S13-9:  body-type mix chart',                             '_renderBodyTypes' in _an)
chk('S13-10: stale data banner',                               'an-stale-banner' in _an)
chk('S13-11: manual refresh button wired',                     'an-refresh' in _an)
chk('S13-12: back button wired',                               'an-back' in _an)
chk('S13-13: reactive on fleet:data bus event',                "bus.on('fleet:data'" in _an)
chk('S13-14: reactive on ui:view-change',                      "bus.on('ui:view-change'" in _an)
chk('S13-15: vendor update synchronous (no relay IPC)',         '_update(state' in _an and '_loadRelayAndUpdate' not in _an)
chk('S13-16: _pmDaysNum parser handles overdue/days',          '_pmDaysNum' in _an)
chk('S13-17: syncedAt timestamp shown',                        'syncedAt' in _an)
chk('S13-18: CSS an-kpi KPI card rules',                       'an-kpi--total' in _css and 'an-kpi--unavail' in _css)
chk('S13-19: CSS an-bar-fill variants',                        'an-bar-fill--unavail' in _css and 'an-bar-fill--avail' in _css)
chk('S13-20: CSS an-grid-2 two-col layout',                    'an-grid-2' in _css)
chk('S13-21: CSS an-card with mono title',                     'an-card__title' in _css)
chk('S13-22: CSS an-table operator table',                     'an-table' in _css)
chk('S13-23: CSS an-pm-card PM cards',                         'an-pm-card' in _css)
chk('S13-24: CSS an-risk-badge tier badges',                   'an-risk-badge--risk-high' in _css)


# -- Stage 14 checks ---------------------------------------------------------
with open('/home/zilasant/fleet/version_c/renderer/src/js/views/vendors.js')   as _f: _vn  = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/js/views/analytics.js') as _f: _an  = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/css/fleet.css')          as _f: _css = _f.read()

# S13 fix checks
chk('S13-fix-1: analytics.js no longer imports relay from bridge', "from '../bridge.js'" not in _an or 'relay' not in _an.split("from '../bridge.js'")[0])
chk('S13-fix-2: analytics vendor uses row.vendor directly',        'r.vendor' in _an and '_relayMap' not in _an)
chk('S13-fix-3: analytics _update() is sync (no async relay call)','async function _loadRelayAndUpdate' not in _an)

# S14 vendor view checks
chk('S14-1:  vendors.js exists and exports init()',                 'export function init(' in _vn)
chk('S14-2:  _buildVendorMap() computes vendor metrics',            '_buildVendorMap(' in _vn)
chk('S14-3:  list view panel present',                              'vm-list-panel' in _vn)
chk('S14-4:  drill view panel present',                             'vm-drill-panel' in _vn)
chk('S14-5:  _view state tracks list/drill mode',                   "_view = 'list'" in _vn and "_view = 'drill'" in _vn)
chk('S14-6:  _showPanel() switches panels',                         '_showPanel(' in _vn)
chk('S14-7:  vendor summary strip (count/units/high-risk)',         'vm-strip' in _vn and 'vm-kpi' in _vn)
chk('S14-8:  vendor table rendered with metrics',                   '_renderVendorTable(' in _vn and 'vm-vendor-row' in _vn)
chk('S14-9:  vendor table: unit/unavail/high-risk/avg-risk/cost/WO cols', 'Avg risk' in _vn and 'Total WO cost' in _vn and 'Open WOs' in _vn)
chk('S14-10: clicking vendor row enters drill view',                "_view = 'drill'" in _vn and '_drillVendor = vendorName' in _vn)
chk('S14-11: drill summary strip',                                  '_renderDrillSummary(' in _vn)
chk('S14-12: drill unit table with all key columns',                '_renderDrillTable(' in _vn and 'vendorWorkOrderId' in _vn)
chk('S14-13: drill table shows SF case with link',                  'salesforceCaseUrl' in _vn and 'vm-link' in _vn)
chk('S14-14: drill table shows offsite shop link',                  'offsiteShopEventUrl' in _vn or 'savedOffsiteUrl' in _vn)
chk('S14-15: unit ID links navigate to fleet unit drawer',          "bus.emit('navigate:unit'" in _vn)
chk('S14-16: back-to-list button wired',                            'vm-drill-back-list' in _vn)
chk('S14-17: back-to-fleet buttons wired (both panels)',            'vm-back-fleet' in _vn and 'vm-drill-back-fleet' in _vn)
chk('S14-18: search input filters vendor list',                     'vm-search' in _vn and '_search' in _vn)
chk('S14-19: reactive on fleet:data bus event',                     "bus.on('fleet:data'" in _vn)
chk('S14-20: reactive on ui:view-change',                           "bus.on('ui:view-change'" in _vn)
chk('S14-21: entering view resets to list when from outside',       "from !== 'vendors'" in _vn)
chk('S14-22: _fmtCost formats dollar amounts',                      '_fmtCost(' in _vn and 'toLocaleString' in _vn)
chk('S14-23: _riskClass assigns HIGH/MED/LOW CSS class',            '_riskClass(' in _vn and 'risk-high' in _vn)
chk('S14-24: CSS vm-panel flex column layout',                      'vm-panel' in _css)
chk('S14-25: CSS vm-strip KPI strip',                               'vm-strip' in _css and 'vm-kpi' in _css)
chk('S14-26: CSS vm-vendor-row clickable cursor',                   'vm-vendor-row' in _css)
chk('S14-27: CSS vm-risk-badge HIGH/MED/LOW variants',              'vm-risk-badge--risk-high' in _css and 'vm-risk-badge--risk-low' in _css)
chk('S14-28: CSS vm-table drill min-width for wide cols',           'vm-table--drill' in _css)
chk('S14-29: CSS vm-link external link style',                      'vm-link' in _css)
chk('S14-30: CSS vm-search-input style',                            'vm-search-input' in _css)


# -- Stage 14 checks ---------------------------------------------------------
with open('/home/zilasant/fleet/version_c/renderer/src/js/views/vendors.js')   as _f: _vn  = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/js/views/analytics.js') as _f: _an  = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/css/fleet.css')          as _f: _css = _f.read()

# S13 fix checks
chk('S13-fix-1: analytics.js no longer imports relay from bridge', "from '../bridge.js'" not in _an or 'relay' not in _an.split("from '../bridge.js'")[0])
chk('S13-fix-2: analytics vendor uses row.vendor directly',        'r.vendor' in _an and '_relayMap' not in _an)
chk('S13-fix-3: analytics _update() is sync (no async relay call)','async function _loadRelayAndUpdate' not in _an)

# S14 vendor view checks
chk('S14-1:  vendors.js exists and exports init()',                 'export function init(' in _vn)
chk('S14-2:  _buildVendorMap() computes vendor metrics',            '_buildVendorMap(' in _vn)
chk('S14-3:  list view panel present',                              'vm-list-panel' in _vn)
chk('S14-4:  drill view panel present',                             'vm-drill-panel' in _vn)
chk('S14-5:  _view state tracks list/drill mode',                   "_view = 'list'" in _vn and "_view = 'drill'" in _vn)
chk('S14-6:  _showPanel() switches panels',                         '_showPanel(' in _vn)
chk('S14-7:  vendor summary strip (count/units/high-risk)',         'vm-strip' in _vn and 'vm-kpi' in _vn)
chk('S14-8:  vendor table rendered with metrics',                   '_renderVendorTable(' in _vn and 'vm-vendor-row' in _vn)
chk('S14-9:  vendor table: unit/unavail/high-risk/avg-risk/cost/WO cols', 'Avg risk' in _vn and 'Total WO cost' in _vn and 'Open WOs' in _vn)
chk('S14-10: clicking vendor row enters drill view',                "_view = 'drill'" in _vn and '_drillVendor = vendorName' in _vn)
chk('S14-11: drill summary strip',                                  '_renderDrillSummary(' in _vn)
chk('S14-12: drill unit table with all key columns',                '_renderDrillTable(' in _vn and 'vendorWorkOrderId' in _vn)
chk('S14-13: drill table shows SF case with link',                  'salesforceCaseUrl' in _vn and 'vm-link' in _vn)
chk('S14-14: drill table shows offsite shop link',                  'offsiteShopEventUrl' in _vn or 'savedOffsiteUrl' in _vn)
chk('S14-15: unit ID links navigate to fleet unit drawer',          "bus.emit('navigate:unit'" in _vn)
chk('S14-16: back-to-list button wired',                            'vm-drill-back-list' in _vn)
chk('S14-17: back-to-fleet buttons wired (both panels)',            'vm-back-fleet' in _vn and 'vm-drill-back-fleet' in _vn)
chk('S14-18: search input filters vendor list',                     'vm-search' in _vn and '_search' in _vn)
chk('S14-19: reactive on fleet:data bus event',                     "bus.on('fleet:data'" in _vn)
chk('S14-20: reactive on ui:view-change',                           "bus.on('ui:view-change'" in _vn)
chk('S14-21: entering view resets to list when from outside',       "from !== 'vendors'" in _vn)
chk('S14-22: _fmtCost formats dollar amounts',                      '_fmtCost(' in _vn and 'toLocaleString' in _vn)
chk('S14-23: _riskClass assigns HIGH/MED/LOW CSS class',            '_riskClass(' in _vn and 'risk-high' in _vn)
chk('S14-24: CSS vm-panel flex column layout',                      'vm-panel' in _css)
chk('S14-25: CSS vm-strip KPI strip',                               'vm-strip' in _css and 'vm-kpi' in _css)
chk('S14-26: CSS vm-vendor-row clickable cursor',                   'vm-vendor-row' in _css)
chk('S14-27: CSS vm-risk-badge HIGH/MED/LOW variants',              'vm-risk-badge--risk-high' in _css and 'vm-risk-badge--risk-low' in _css)
chk('S14-28: CSS vm-table drill min-width for wide cols',           'vm-table--drill' in _css)
chk('S14-29: CSS vm-link external link style',                      'vm-link' in _css)
chk('S14-30: CSS vm-search-input style',                            'vm-search-input' in _css)

# ── 
# -- Stages 16-18 checks (app.js wiring + toolbar nav) --------------------
with open("/home/zilasant/fleet/version_c/renderer/src/js/app.js")                  as _f: _app = _f.read()
with open("/home/zilasant/fleet/version_c/renderer/src/js/components/toolbar.js")   as _f: _tb  = _f.read()
with open("/home/zilasant/fleet/version_c/renderer/src/js/views/analytics.js")      as _f: _an  = _f.read()
with open("/home/zilasant/fleet/version_c/renderer/src/js/views/vendors.js")        as _f: _vn  = _f.read()
with open("/home/zilasant/fleet/version_c/renderer/src/js/views/email-composer.js") as _f: _ec  = _f.read()

# S16 -- analytics.js wired into app.js
chk('S16-1: app.js imports initAnalytics',              'initAnalytics' in _app and 'analytics.js' in _app)
chk('S16-2: app.js calls initAnalytics(viewsMount)',       'initAnalytics(viewsMount)' in _app)
chk('S16-3: app.js grabs view-analytics element',          'view-analytics' in _app)
chk('S16-4: app.js routes analytics in ui:view-change',    'analyticsView.style.display' in _app)
chk('S16-5: analytics.js exports init()',                  'export function init(' in _an)
chk("S16-6: analytics.js listens on fleet:data",           "bus.on('fleet:data'" in _an)
chk("S16-7: analytics.js listens on ui:view-change",       "bus.on('ui:view-change'" in _an)

# S17 -- vendors.js wired into app.js
chk('S17-1: app.js imports initVendors',                   'initVendors' in _app and 'vendors.js' in _app)
chk('S17-2: app.js calls initVendors(viewsMount)',           'initVendors(viewsMount)' in _app)
chk('S17-3: app.js grabs view-vendors element',             'view-vendors' in _app)
chk('S17-4: app.js routes vendors in ui:view-change',       'vendorsView.style.display' in _app)
chk('S17-5: vendors.js exports init()',                     'export function init(' in _vn)
chk("S17-6: vendors.js listens on fleet:data",             "bus.on('fleet:data'" in _vn)
chk("S17-7: vendors.js listens on ui:view-change",         "bus.on('ui:view-change'" in _vn)

# S18 -- email-composer.js wired into app.js
chk('S18-1: app.js imports initEmailComposer',              'initEmailComposer' in _app and 'email-composer.js' in _app)
chk('S18-2: app.js calls initEmailComposer(viewsMount)',     'initEmailComposer(viewsMount)' in _app)
chk('S18-3: app.js grabs view-email-composer element',      'view-email-composer' in _app)
chk('S18-4: app.js routes email-composer in ui:view-change', 'emailComposerView.style.display' in _app)
chk('S18-5: email-composer.js exports init()',               'export' in _ec and 'function init(' in _ec)

# Toolbar nav buttons (S16-S18)
chk('S16-T1: toolbar has tb-analytics button',               'tb-analytics' in _tb)
chk("S16-T2: toolbar emits view-change to analytics",       "to: 'analytics'" in _tb)
chk('S17-T1: toolbar has tb-vendors button',                 'tb-vendors' in _tb)
chk("S17-T2: toolbar emits view-change to vendors",         "to: 'vendors'" in _tb)
chk('S18-T1: toolbar has tb-email-composer button',          'tb-email-composer' in _tb)
chk("S18-T2: toolbar emits view-change to email-composer",   "to: 'email-composer'" in _tb)

# -- Stage 19 checks (schedulers.js wired into app.js + toolbar) ----------------
with open('/home/zilasant/fleet/version_c/renderer/src/js/app.js') as _f: _app = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/js/components/toolbar.js') as _f: _tb  = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/js/views/schedulers.js', errors='replace') as _f: _sc  = _f.read()

chk('S19-1: app.js imports initSchedulers', 'initSchedulers' in _app and 'schedulers.js' in _app)
chk('S19-2: app.js calls initSchedulers(viewsMount)', 'initSchedulers(viewsMount)' in _app)
chk('S19-3: app.js grabs view-schedulers element', 'view-schedulers' in _app)
chk('S19-4: app.js routes schedulers in view-change', 'schedulersView.style.display' in _app)
chk('S19-5: schedulers.js exports init', 'export function init' in _sc or 'function init' in _sc)
chk('S19-6: schedulers.js handles ui:view-change', 'ui:view-change' in _sc)
chk('S19-T1: toolbar has tb-schedulers button', 'tb-schedulers' in _tb)
chk('S19-T2: toolbar emits view-change to schedulers', "to: 'schedulers'" in _tb)

# -- Stage 20 checks (daily-notes view wired into app.js + toolbar) ---------------
with open('/home/zilasant/fleet/version_c/renderer/src/js/app.js') as _f: _app = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/js/components/toolbar.js') as _f: _tb  = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/js/views/daily-notes.js', errors='replace') as _f: _dn  = _f.read()

chk('S20-1: app.js imports initDailyNotes', 'initDailyNotes' in _app and 'daily-notes.js' in _app)
chk('S20-2: app.js calls initDailyNotes(viewsMount)', 'initDailyNotes(viewsMount)' in _app)
chk('S20-3: app.js grabs view-daily-notes element', 'view-daily-notes' in _app)
chk('S20-4: app.js routes daily-notes in view-change', 'dailyNotesView.style.display' in _app)
chk('S20-5: daily-notes.js exports init', 'export function init' in _dn)
chk('S20-6: daily-notes.js handles ui:view-change', 'ui:view-change' in _dn)
chk('S20-7: daily-notes.js calls getDailyNotesLog or runDailyNotes', 'getDailyNotesLog' in _dn or 'runDailyNotes' in _dn)
chk('S20-T1: toolbar has tb-daily-notes button', 'tb-daily-notes' in _tb)
chk('S20-T2: toolbar emits view-change to daily-notes', "to: 'daily-notes'" in _tb)

# -- Stage 21 checks (Orcha chat wiring hardening) -------------------------
with open('/home/zilasant/fleet/version_c/renderer/src/js/chat-bridge.js') as _f: _cb = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/js/orcha-bridge.js') as _f: _ob = _f.read()
with open('/home/zilasant/fleet/version_c/src/scrapers/orcha_ws.js') as _f: _ws = _f.read()
with open('/home/zilasant/fleet/version_c/renderer/src/index.html', errors='replace') as _f: _ih = _f.read()

chk('S21-A: chat-bridge uses lazy hasAI() function', 'function hasAI' in _cb)
chk('S21-A: hasAI() used at send site', 'if (hasAI())' in _cb)
chk('S21-B: chat-bridge caps context at MAX_CTX', 'MAX_CTX' in _cb)
chk('S21-C: chat-bridge captures ipcPath from result', 'ipcPath' in _cb)
chk('S21-C: typing.resolve accepts path param', 'resolve: function (text, path)' in _cb)
chk('S21-D: index.html inline sendMsg has bridge guard', '_chatBridge' in _ih)
chk('S21-E: orcha-bridge inject timeout is 200ms', '_injectDrawerButton, 200)' in _ob)
chk('S21-E: orcha-bridge has 500ms retry for missing button', '}, 500)' in _ob)
chk('S21-F: orcha_ws defines SESSION_MAX_AGE_MS', 'SESSION_MAX_AGE_MS' in _ws)
chk('S21-F: orcha_ws checks session age on restore', 'mtimeMs' in _ws)
chk('S21-F: orcha_ws stamps session creation time', '_fleetChatSessionTs  = Date.now()' in _ws)
# ── Cross-module checks ──────────────────────────────────────────────────────
chk('fleet-bridge.js LF only',                          '\r' not in fb)
chk('notes-bridge.js LF only',                          '\r' not in nb)
chk('fleet-bridge calls signalReady()',                  'signalReady' in fb)
chk('fleet-bridge exposes window._fleetBridge',          'window._fleetBridge' in fb)

# ── Report ───────────────────────────────────────────────────────────────────
print('=' * 60)
print('SANITY CHECK REPORT')
print('=' * 60)
print(f'\n[PASS] {len(passes)} checks passed')
for p in passes: print(p)
if warns:
    print(f'\n[WARN] {len(warns)} warnings')
    for w in warns: print(w)
if fails:
    print(f'\n[FAIL] {len(fails)} failures')
    for f in fails: print(f)
    print('\n[RESULT] FAILURES FOUND — review before proceeding')
    sys.exit(1)
else:
    print('\n[RESULT] ALL CLEAR — no blocking issues found')
