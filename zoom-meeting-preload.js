'use strict';
/**
 * zoom-meeting-preload.js -- Context Bridge for the embedded Zoom Meeting
 * SDK window (see src/window/index.js openZoomMeetingWindow()).
 *
 * Deliberately minimal and separate from the main preload.js: this window
 * only ever needs to fetch a join signature. It never gets access to
 * window.credentials, window.fleet, or anything else the main app exposes.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zoomBridge', {
  getJoinSignature: (meetingNumber, role) => ipcRenderer.invoke('zoom:get-join-signature', meetingNumber, role),
});
