// renderer/src/zoom-meeting/zoom-meeting.js
// Embedded Zoom Meeting SDK component view. Loaded as its own Vite entry
// (see vite.config.js -> rollupOptions.input.zoomMeeting) because the SDK
// needs real bundling (bare `require`/import resolution, React/Redux peer
// deps) -- unlike renderer/src/setup, which is loaded unbundled via
// loadFile() straight from source.
//
// The join signature (JWT) is generated server-side in the main process
// (src/orcha/zoom.js) via window.zoomBridge.getJoinSignature() -- the SDK
// Secret never reaches this renderer.

import ZoomMtgEmbedded from '@zoom/meetingsdk/embedded';

const root = document.getElementById('zoom-meeting-root');

function showError(message) {
  root.innerHTML = '<div style="color:#fff;font-family:sans-serif;padding:24px;">' +
    '<h2 style="margin-top:0;">Could not join meeting</h2><p>' +
    String(message).replace(/</g, '&lt;') + '</p></div>';
}

async function main() {
  const params = new URLSearchParams(window.location.search);
  const meetingNumber = params.get('meetingNumber');
  const password = params.get('password') || '';
  const userName = params.get('userName') || 'Fleet Operations';

  if (!meetingNumber) {
    showError('No meeting number provided.');
    return;
  }

  let signature, sdkKey;
  try {
    const result = await window.zoomBridge.getJoinSignature(meetingNumber, 0);
    if (!result || !result.signature) throw new Error('empty signature response');
    signature = result.signature;
    sdkKey = result.sdkKey;
  } catch (e) {
    showError('Failed to get join signature: ' + (e && e.message ? e.message : e));
    return;
  }

  const client = ZoomMtgEmbedded.createClient();
  try {
    await client.init({
      zoomAppRoot: root,
      language: 'en-US',
      customize: {
        video: { isResizable: true, viewSizes: { default: { width: root.clientWidth, height: root.clientHeight } } },
      },
    });
    await client.join({
      signature,
      sdkKey,
      meetingNumber,
      password,
      userName,
    });
  } catch (e) {
    showError('Failed to join meeting: ' + (e && e.message ? e.message : e));
  }
}

main();
