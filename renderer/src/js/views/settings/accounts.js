// Extracted from settings.js
// Function: _wireAccounts
// Can be imported back when ready to modularize

function _wireAccounts() {
  settingsBridge.getAll().then((all) => {
    const rows = (all && Array.isArray(all.accounts)) ? all.accounts : [];
    if (rows.length > 0) {
      const empty = document.getElementById('acct-empty');
      if (empty) empty.style.display = 'none';
      rows.forEach((r) => _acctAddRow(r));
    }
  }).catch(() => {});

  document.getElementById('acct-add').addEventListener('click', () => {
    _acctAddRow();
    const list = document.getElementById('acct-list');
    if (list && list.lastElementChild) {
      const inp = list.lastElementChild.querySelector('.acct-input.acct-name');
      if (inp) inp.focus();
    }
  });
}
