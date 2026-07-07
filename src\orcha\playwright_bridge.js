'use strict';
/**
 * playwright_bridge.js — Orcha → Playwright Command Bridge [V-C]
 * V-C changes vs V-B:
 *   - SCREENSHOT_DIR: was hardcoded AppData\Roaming path → P.screenshotsDir
 *   - LOG_FILE: was hardcoded AppData\Roaming path → P.playwrightLog
 *   - console.log replaced with namespaced logger
 *   - _log now uses logger instead of direct file write (logger handles rotation)
 *
 * Architecture:
 *   Orcha Brain → playwright_bridge → Playwright API → Browser
 *                                     ↑
 *                               Guardian (pre-flight check)
 */

const fs       = require('fs');
const path     = require('path');
const { P }    = require('../config/paths');
const guardian = require('./guardian');
const context  = require('./context');
const logger   = require('../utils/logger')('pw-bridge');

// ── BRIDGE STATE ──────────────────────────────────────────────────────────────
let _browser   = null;
let _page      = null;
let _connected = false;
let _actionLog = [];

// ═══════════════════════════════════════════════════════════════════════════════
// BROWSER LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * connect(browserOrPage)
 * Accept an existing Playwright browser/page from the Electron main process.
 */
function connect(browserOrPage) {
  if (browserOrPage && typeof browserOrPage.goto === 'function') {
    _page = browserOrPage; _connected = true;
    logger.info('Connected to existing Playwright page');
  } else if (browserOrPage && typeof browserOrPage.newPage === 'function') {
    _browser = browserOrPage; _connected = true;
    logger.info('Connected to existing Playwright browser');
  }
}

async function getPage() {
  if (_page && !_page.isClosed()) return _page;
  if (_browser) {
    _page = await _browser.newPage();
    logger.info('Created new page from browser');
    return _page;
  }
  throw new Error('No browser or page connected — call connect() first');
}

function isConnected() { return _connected && (_page || _browser); }

// ═══════════════════════════════════════════════════════════════════════════════
// COMMAND API
// ═══════════════════════════════════════════════════════════════════════════════

async function navigate(url, opts = {}) {
  const check = guardian.checkPlaywrightAction({ type: 'navigate', url });
  if (!check.allowed) {
    logger.warn(`BLOCKED navigate to ${url}: ${check.issues.map(i => i.message).join('; ')}`);
    return { success: false, blocked: true, issues: check.issues };
  }
  const page = await getPage();
  logger.info(`Navigating to: ${url}`);
  try {
    await page.goto(url, { waitUntil: opts.waitUntil || 'domcontentloaded', timeout: opts.timeout || 30000 });
    _recordAction('navigate', { url }, true);
    return { success: true, url: page.url() };
  } catch (e) {
    logger.warn(`Navigate failed: ${e.message}`);
    _recordAction('navigate', { url }, false, e.message);
    return { success: false, error: e.message };
  }
}

async function click(selector, opts = {}) {
  const check = guardian.checkPlaywrightAction({ type: 'click', selector });
  if (!check.allowed) { logger.warn(`BLOCKED click on ${selector}`); return { success: false, blocked: true, issues: check.issues }; }
  const page = await getPage();
  logger.info(`Clicking: ${selector}`);
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout: opts.timeout || 10000 });
    await page.click(selector, { delay: opts.delay || 50 });
    _recordAction('click', { selector }, true);
    return { success: true };
  } catch (e) {
    logger.warn(`Click failed on "${selector}": ${e.message}`);
    _recordAction('click', { selector }, false, e.message);
    return { success: false, error: e.message, selector };
  }
}

async function fill(selector, value, opts = {}) {
  const check = guardian.checkPlaywrightAction({ type: 'fill', selector, value });
  if (!check.allowed) { logger.warn(`BLOCKED fill on ${selector}`); return { success: false, blocked: true, issues: check.issues }; }
  const page = await getPage();
  logger.info(`Filling "${selector}" with ${value.length} chars`);
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout: opts.timeout || 10000 });
    if (opts.clear !== false) await page.fill(selector, '');
    await page.fill(selector, value);
    _recordAction('fill', { selector, valueLength: value.length }, true);
    return { success: true };
  } catch (e) {
    logger.warn(`Fill failed on "${selector}": ${e.message}`);
    _recordAction('fill', { selector }, false, e.message);
    return { success: false, error: e.message };
  }
}

async function select(selector, value, opts = {}) {
  const page = await getPage();
  logger.info(`Selecting "${value}" in ${selector}`);
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout: opts.timeout || 10000 });
    await page.selectOption(selector, value);
    _recordAction('select', { selector, value }, true);
    return { success: true };
  } catch (e) {
    logger.warn(`Select failed: ${e.message}`);
    _recordAction('select', { selector, value }, false, e.message);
    return { success: false, error: e.message };
  }
}

async function type(selector, text, opts = {}) {
  const page = await getPage();
  logger.info(`Typing ${text.length} chars into ${selector}`);
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout: opts.timeout || 10000 });
    await page.type(selector, text, { delay: opts.delay || 30 });
    _recordAction('type', { selector, textLength: text.length }, true);
    return { success: true };
  } catch (e) {
    logger.warn(`Type failed: ${e.message}`);
    _recordAction('type', { selector }, false, e.message);
    return { success: false, error: e.message };
  }
}

async function waitFor(selector, opts = {}) {
  const page = await getPage();
  try {
    await page.waitForSelector(selector, { state: opts.state || 'visible', timeout: opts.timeout || 15000 });
    return { success: true, found: true };
  } catch (e) {
    return { success: false, found: false, error: e.message };
  }
}

async function getText(selector) {
  const page = await getPage();
  try {
    const el   = await page.waitForSelector(selector, { state: 'visible', timeout: 5000 });
    const text = await el.textContent();
    return { success: true, text: (text || '').trim() };
  } catch (e) {
    return { success: false, text: null, error: e.message };
  }
}

async function screenshot(name) {
  const page = await getPage();
  try {
    fs.mkdirSync(P.screenshotsDir, { recursive: true });
    const filename = `${name || 'screenshot'}_${Date.now()}.png`;
    const filepath = path.join(P.screenshotsDir, filename);
    await page.screenshot({ path: filepath, fullPage: false });
    logger.info(`Screenshot saved: ${filename}`);
    return { success: true, path: filepath, filename };
  } catch (e) {
    logger.warn(`Screenshot failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function evaluate(script) {
  const page = await getPage();
  try {
    const result = await page.evaluate(script);
    _recordAction('evaluate', { scriptLength: script.length }, true);
    return { success: true, result };
  } catch (e) {
    _recordAction('evaluate', { scriptLength: script.length }, false, e.message);
    return { success: false, error: e.message };
  }
}

async function getCurrentUrl() {
  try { return (await getPage()).url(); } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPOSITE COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

async function executeSequence(steps) {
  const results = [];
  logger.info(`Executing sequence of ${steps.length} steps`);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    logger.info(`Step ${i + 1}/${steps.length}: ${step.action} ${step.selector || step.url || ''}`);

    let result;
    switch (step.action) {
      case 'navigate':   result = await navigate(step.url, step.opts || {}); break;
      case 'click':      result = await click(step.selector, step.opts || {}); break;
      case 'fill':       result = await fill(step.selector, step.value, step.opts || {}); break;
      case 'select':     result = await select(step.selector, step.value, step.opts || {}); break;
      case 'type':       result = await type(step.selector, step.value, step.opts || {}); break;
      case 'wait':       result = await waitFor(step.selector, step.opts || {}); break;
      case 'screenshot': result = await screenshot(step.name); break;
      case 'evaluate':   result = await evaluate(step.script); break;
      case 'delay':      await new Promise(r => setTimeout(r, step.ms || 1000)); result = { success: true }; break;
      default:           result = { success: false, error: `Unknown action: ${step.action}` };
    }

    results.push({ step: i, action: step.action, ...result });

    if (!result.success && step.required !== false) {
      logger.warn(`Sequence halted at step ${i + 1}: ${result.error || 'failed'}`);
      return { success: false, stoppedAt: i, results, error: result.error };
    }

    if (step.delayAfter) await new Promise(r => setTimeout(r, step.delayAfter));
  }

  logger.info(`Sequence completed: ${results.length} steps`);
  return { success: true, results };
}

async function verifyPage(expectations) {
  const page   = await getPage();
  const issues = [];

  if (expectations.url) {
    const currentUrl = page.url();
    if (!currentUrl.includes(expectations.url)) issues.push(`URL mismatch: expected "${expectations.url}", got "${currentUrl}"`);
  }
  if (expectations.title) {
    const title = await page.title();
    if (!title.includes(expectations.title)) issues.push(`Title mismatch: expected "${expectations.title}", got "${title}"`);
  }
  if (expectations.hasElement) {
    const found = await page.$(expectations.hasElement);
    if (!found) issues.push(`Element not found: ${expectations.hasElement}`);
  }
  if (expectations.hasText) {
    const content = await page.textContent('body');
    if (!content.includes(expectations.hasText)) issues.push(`Text not found on page: "${expectations.hasText}"`);
  }

  return { ok: issues.length === 0, issues };
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL
// ═══════════════════════════════════════════════════════════════════════════════

function _recordAction(type, data, success, error) {
  _actionLog.push({ ts: Date.now(), type, data, success, error });
  if (_actionLog.length > 200) _actionLog.splice(0, _actionLog.length - 200);
}

function getActionLog(limit = 30) { return _actionLog.slice(-limit); }

function getStatus() {
  return {
    connected: _connected,
    hasPage:   !!(_page && !_page.isClosed()),
    hasBrowser: !!_browser,
    actionCount: _actionLog.length,
    lastAction: _actionLog.length > 0 ? _actionLog[_actionLog.length - 1] : null,
  };
}

module.exports = {
  connect, isConnected, getPage, getStatus, getActionLog,
  navigate, click, fill, select, type, waitFor, getText, screenshot, evaluate, getCurrentUrl,
  executeSequence, verifyPage,
};
