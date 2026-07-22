'use strict';
// pw_scraper.js — Playwright with AEA extension + Midway cookie injection
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { P } = require('../config/paths');
const logger = require('../utils/logger').createLogger('pw_scraper');

const PROFILE_DIR = P.playwrightProfile;
const AEA_PATH = P.aeaExtension;
const MIDWAY_COOKIE_FILE = P.midwayCookie;


/**
 * Parse ~/.midway/cookie (Netscape format) into Playwright cookie objects
 */
function parseMidwayCookies() {
  if (!fs.existsSync(MIDWAY_COOKIE_FILE)) {
    throw new Error('No midway cookie -- run: mwinit'); // FIX (2026-07-21): dropped -o, see auth.js runMwinit() comment
  }
  const text = fs.readFileSync(MIDWAY_COOKIE_FILE, 'utf8');
  const cookies = [];
  for (let line of text.split(/\r?\n/)) {
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) { httpOnly = true; line = line.slice('#HttpOnly_'.length); }
    else if (line.startsWith('#') || !line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const domain = parts[0];
    const cookiePath = parts[2] || '/';
    const secure = parts[3] === 'TRUE';
    const expiry = parseInt(parts[4], 10);
    const name = parts[5];
    const value = parts.slice(6).join('\t');
    if (!/amazon|a2z/.test(domain)) continue;
    if (expiry && expiry < Math.floor(Date.now() / 1000)) continue;
    cookies.push({ name, value, domain: domain.replace(/^\./, ''), path: cookiePath, secure, httpOnly, expires: expiry || -1 });
  }
  return cookies;
}

/**
 * Launch persistent context with AEA + inject midway cookies
 */
async function launchWithAuth(opts = {}) {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${AEA_PATH}`,
      `--load-extension=${AEA_PATH}`,
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: opts.viewport || { width: 1400, height: 900 },
  });

  // Inject midway cookies
  try {
    const cookies = parseMidwayCookies();
    const playwrightCookies = cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expires: c.expires > 0 ? c.expires : undefined,
      sameSite: 'None',
    }));
    await context.addCookies(playwrightCookies);
    logger.info('[PW] Injected', playwrightCookies.length, 'midway cookies');
  } catch(e) {
    logger.warn('[PW] Cookie injection failed:', e.message);
  }

  return context;
}

/**
 * Scrape AAP inventory
 */
async function scrapeAAP(domiciles) {
  const searchParam = (domiciles || []).join('+');
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

  logger.info('[PW] Launching with AEA + midway cookies...');
  const context = await launchWithAuth();
  const page = context.pages()[0] || await context.newPage();

  logger.info('[PW] Navigating to AAP...');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Check if still on login page
  const bodyText = await page.textContent('body').catch(() => '');
  if (bodyText.includes('Sign in') || bodyText.includes('midway')) {
    logger.info('[PW] Still on login — waiting for user (90s)...');
    await page.waitForURL('**/aap-na.corp.amazon.com/**', { timeout: 90000 });
    await page.waitForTimeout(5000);
  }

  // Wait for table
  logger.info('[PW] Waiting for table...');
  await page.waitForSelector('tbody tr', { timeout: 90000 });
  await page.waitForTimeout(3000);

  // Force 1000
  try {
    const rpp = await page.$('button:has-text("150"), button:has-text("50")');
    if (rpp) {
      await rpp.click();
      await page.waitForTimeout(500);
      const opt = await page.$('[role="option"]:has-text("1000"), li:has-text("1000")');
      if (opt) { await opt.click(); await page.waitForTimeout(5000); }
    }
  } catch(e) { logger.warn('[PW] Force-1000 rows failed (non-fatal):', e.message); }

  // Extract
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

  logger.info('[PW] Scraped', data.count, 'units');
  await context.close();
  return data;
}

/**
 * Send email via OWA
 */
async function sendEmail({ to, cc, subject, htmlBody }) {
  const owaUrl = 'https://outlook.office365.com/mail/deeplink/compose'
    + '?to=' + encodeURIComponent(to || '')
    + '&cc=' + encodeURIComponent(cc || '')
    + '&subject=' + encodeURIComponent(subject || '');

  logger.info('[PW-Email] Launching with AEA + cookies...');
  const context = await launchWithAuth({ viewport: { width: 1100, height: 800 } });
  const page = context.pages()[0] || await context.newPage();

  await page.goto(owaUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Inject HTML
  const bodySelector = '[aria-label="Message body"], [role="textbox"][contenteditable], div[contenteditable="true"]';
  await page.waitForSelector(bodySelector, { timeout: 15000 });
  await page.evaluate((html) => {
    const body = document.querySelector('[aria-label="Message body"]') ||
                 document.querySelector('[role="textbox"][contenteditable]') ||
                 document.querySelector('div[contenteditable="true"]');
    if (body) { body.innerHTML = html; body.dispatchEvent(new Event('input', { bubbles: true })); }
  }, htmlBody);
  await page.waitForTimeout(1000);

  // Click Send
  const sendBtn = await page.$('button[aria-label="Send"], button:has-text("Send")');
  if (sendBtn) {
    await sendBtn.click();
    logger.info('[PW-Email] Sent!');
    await page.waitForTimeout(3000);
    await context.close();
    return { success: true, method: 'playwright-owa' };
  }

  await context.close();
  return { success: false, error: 'Send button not found' };
}

module.exports = { scrapeAAP, sendEmail, launchWithAuth, parseMidwayCookies, PROFILE_DIR, AEA_PATH };
