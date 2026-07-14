'use strict';
/**
 * src/updater.js — Auto-update infrastructure
 * 
 * Uses electron-updater when packaged.
 * In dev mode, does nothing.
 * 
 * To enable:
 * 1. npm install electron-updater
 * 2. Configure publish in package.json build section
 * 3. Call initUpdater() from app.js after window ready
 */

const logger = require('./utils/logger')('updater');

let autoUpdater = null;

function initUpdater(mainWindow) {
  if (process.env.NODE_ENV === 'development') {
    logger.info('Dev mode — auto-updater disabled');
    return;
  }

  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    logger.info('electron-updater not installed — updates disabled');
    return;
  }

  autoUpdater.logger = logger;
  autoUpdater.autoDownload = false;

  autoUpdater.on('update-available', (info) => {
    logger.info('Update available: v' + info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:update-available', {
        version: info.version,
        releaseDate: info.releaseDate
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    logger.info('Update downloaded: v' + info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:update-ready', { version: info.version });
    }
  });

  autoUpdater.on('error', (err) => {
    logger.error('Update error: ' + err.message);
  });

  // Check for updates every 4 hours
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 4 * 60 * 60 * 1000);
}

function downloadUpdate() {
  if (autoUpdater) autoUpdater.downloadUpdate();
}

function installUpdate() {
  if (autoUpdater) autoUpdater.quitAndInstall();
}

module.exports = { initUpdater, downloadUpdate, installUpdate };
