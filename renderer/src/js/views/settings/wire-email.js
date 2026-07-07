// settings/wire-email.js — Email tab wiring
export function wireEmail(drawer, bridge) {
  const _drawer = drawer;
  const settingsBridge = bridge;

  document.getElementById('email-save').addEventListener('click', async () => {
    await emailBridge.saveConfig({
      host: document.getElementById('email-host').value.trim(),
      port: parseInt(document.getElementById('email-port').value, 10) || 587,
      from: document.getElementById('email-from').value.trim(),
      user: document.getElementById('email-user').value.trim(),
      pass: document.getElementById('email-pass').value,
    });
    document.getElementById('email-pass').value = '';
    const st = document.getElementById('email-status');
    st.textContent = '✓ Saved'; st.style.display = 'block';
    setTimeout(() => { st.style.display = 'none'; }, 2000);
  });
  document.getElementById('email-test').addEventListener('click', () => {
    toast.show('info', 'Send test — not yet wired in bridge', 3000);
  });

}
