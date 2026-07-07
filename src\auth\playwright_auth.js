'use strict';
// playwright_auth.js — Captures and reuses Chrome auth state for AAP + OWA
// Bypasses AEA by connecting to Chrome's User Data Dir (which has AEA installed)
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { P } = require('../config/paths');
const logger = require('../utils/logger').createLogger('playwright_auth');

const AUTH_DIR = path.join(P.dataDir, 'playwright_auth');
const AUTH_FILE = path.join(AUTH_DIR, 'auth-state.json');
const CHROME_USER_DATA = P.chromeUserData;

/**
 * Capture auth state from Chrome's existing session
 * Opens a headless Chrome with your actual profile (has AEA + Midway cookies)
 */
async function captureAuth() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  logger.info('[PlaywrightAuth] Capturing auth from Chrome profile...');
  
  const browser = await chromium.launchPersistentContext(CHROME_USER_DATA, {
    headless: false,
    channel: 'chrome',
    args: ['--profile-directory=Default', '--no-first-run'],
    viewport: { width: 1200, height: 800 },
  });

  const page = browser.pages()[0] || await browser.newPage();
  
  // Navigate to AAP to confirm auth works
  await page.goto('https://aap-na.corp.amazon.com/v2/page/bafc8b2a-3be6-4a52-a86f-7cb2de7b5400', { waitUntil: 'networkidle', timeout: 30000 });
  
  // Save storage state
  await browser.storageState({ path: AUTH_FILE });
  logger.info('[PlaywrightAuth] Auth state saved to:', AUTH_FILE);
  
  await browser.close();
  return AUTH_FILE;
}

/**
 * Scrape AAP inventory using saved auth state
 */
async function scrapeAAPWithPlaywright(domiciles) {
  logger.info('[PlaywrightAuth] Scraping AAP with saved auth...');
  
  if (!fs.existsSync(AUTH_FILE)) {
    logger.info('[PlaywrightAuth] No auth file — capturing first...');
    await captureAuth();
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: AUTH_FILE });
  const page = await context.newPage();

  // Build URL with domiciles
  const searchParam = domiciles.join('+');
  const url = 'https://aap-na.corp.amazon.com/v2/page/bafc8b2a-3be6-4a52-a86f-7cb2de7b5400'
    + '?tab=Unplanned'
    + '&states=%5B%7B%22state%22%3A%22ACTIVE%22%2C%22reasons%22%3A%5B%5D%7D%2C%7B%22state%22%3A%22UNAVAILABLE%22%2C%22reasons%22%3A%5B%5D%7D%5D'
    + '&operationalStatuses=%5B%5D'
    + '&geofences=%7B%22type%22%3A%22ANYWHERE%22%2C%22customGeofences%22%3A%5B%5D%7D'
    + '&stationCodes=%5B%5D&dspShortCodes=%5B%5D&domicileSites=%5B%5D'
    + '&fleets=%5B%220bb2e249-fd34-437f-83af-d1d69150558b%22%2C%220f454f75-1e45-475f-8d8b-2334ade1f6f1%22%2C%225c19cdf7-ce2f-4593-a37a-3fe5d506e120%22%2C%227de393df-74e1-45af-9650-560ba008bc65%22%2C%22b84ddc20-589c-4330-af67-3d38f89e28af%22%2C%22b9e02fc4-2b9f-4a70-ac7c-76b30a33bcbe%22%2C%22ba97eda1-cb03-446e-a907-474084194777%22%2C%22daa83ad7-5d8f-43a4-ba9c-76c643e45e1e%22%5D'
    + '&fields=%5B%5D&flags=%7B%7D'
    + '&sortColumn=lifecycleStateReason&limit=1000&pageSize=1000&sortDirection=descending'
    + '&search=' + searchParam;

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  
  // Wait for table
  await page.waitForSelector('tbody tr', { timeout: 90000 });
  await page.waitForTimeout(3000); // extra buffer for React render

  // Force 1000 results per page
  try {
    const rppBtn = await page.$('button:has-text("150")');
    if (rppBtn) {
      await rppBtn.click();
      await page.waitForTimeout(500);
      const opt1000 = await page.$('[role="option"]:has-text("1000"), li:has-text("1000")');
      if (opt1000) {
        await opt1000.click();
        await page.waitForTimeout(5000);
      }
    }
  } catch(e) { logger.info('[PlaywrightAuth] RPP click skipped:', e.message); }

  // Extract table data
  const data = await page.evaluate(() => {
    const t = document.querySelector('table[class*="css-"]') || document.querySelector('table');
    if (!t) return { rows: [], headers: [], count: 0 };
    const headers = [];
    t.querySelectorAll('thead th').forEach(th => headers.push((th.innerText || '').trim().replace(/[\n\r]+/g, ' ')));
    const rows = [];
    t.querySelectorAll('tbody tr').forEach(tr => {
      const cells = tr.querySelectorAll('td');
      if (cells.length < 3) return;
      const row = {};
      for (let i = 0; i < cells.length; i++) row[headers[i] || 'c' + i] = (cells[i].innerText || '').trim();
      if (row['Equipment ID'] || row[headers[1]]) rows.push(row);
    });
    return { rows, headers, count: rows.length };
  });

  logger.info('[PlaywrightAuth] Scraped', data.count, 'units');
  await browser.close();
  return data;
}

/**
 * Send email via OWA using saved auth state
 */
async function sendEmailWithPlaywright({ to, cc, subject, htmlBody }) {
  logger.info('[PlaywrightAuth] Sending email via OWA...');
  
  if (!fs.existsSync(AUTH_FILE)) {
    throw new Error('No auth state — run captureAuth() first');
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: AUTH_FILE });
  const page = await context.newPage();

  const owaUrl = 'https://outlook.office365.com/mail/deeplink/compose'
    + '?to=' + encodeURIComponent(to || '')
    + '&cc=' + encodeURIComponent(cc || '')
    + '&subject=' + encodeURIComponent(subject || '');

  await page.goto(owaUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Inject HTML into compose body
  const bodySelector = '[aria-label="Message body"], [role="textbox"], .editorParent div[contenteditable]';
  await page.waitForSelector(bodySelector, { timeout: 15000 });
  
  await page.evaluate((html) => {
    const body = document.querySelector('[aria-label="Message body"]') ||
                 document.querySelector('[role="textbox"]') ||
                 document.querySelector('.editorParent div[contenteditable]');
    if (body) { body.innerHTML = html; body.dispatchEvent(new Event('input', { bubbles: true })); }
  }, htmlBody);

  await page.waitForTimeout(1000);

  // Click Send
  const sendBtn = await page.$('button[aria-label="Send"], button:has-text("Send")');
  if (sendBtn) {
    await sendBtn.click();
    await page.waitForTimeout(3000);
    logger.info('[PlaywrightAuth] Email sent via OWA');
    await browser.close();
    return { success: true, method: 'playwright-owa' };
  }

  await browser.close();
  return { success: false, error: 'Send button not found' };
}

/**
 * Check if auth state exists and is fresh
 */
function hasValidAuth() {
  if (!fs.existsSync(AUTH_FILE)) return false;
  const stat = fs.statSync(AUTH_FILE);
  const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
  return ageHours < 12; // valid for 12 hours
}

module.exports = { captureAuth, scrapeAAPWithPlaywright, sendEmailWithPlaywright, hasValidAuth, AUTH_FILE };
