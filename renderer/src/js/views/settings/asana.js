// Extracted from settings.js
// Function: _wireAsana
// Can be imported back when ready to modularize

function _wireAsana() {
  document.getElementById('asana-save').addEventListener('click', async () => {
    await asanaBridge.saveConfig({
      pat:       document.getElementById('asana-pat').value,
      workspace: document.getElementById('asana-workspace').value.trim(),
      project:   document.getElementById('asana-project').value.trim(),
    });
    document.getElementById('asana-pat').value = '';
    const st = document.getElementById('asana-status');
    st.textContent = '✓ Saved'; st.style.display = 'block';
    setTimeout(() => { st.style.display = 'none'; }, 2000);
  });
  document.getElementById('asana-verify').addEventListener('click', () => {
    asanaBridge.checkAuth().then((ok) => {
      const st = document.getElementById('asana-status');
      st.textContent = ok ? '✅ Token valid' : '❌ Token invalid';
      st.style.display = 'block';
    }).catch(() => {});
  });
}
