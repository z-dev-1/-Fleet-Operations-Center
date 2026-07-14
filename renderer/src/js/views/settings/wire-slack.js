// settings/wire-slack.js — Slack tab wiring
export function wireSlack(drawer, bridge) {
  const _drawer = drawer;
  const settingsBridge = bridge;

  _checkSlack();
  document.getElementById('slack-recheck').addEventListener('click', _checkSlack);
  document.getElementById('slack-login').addEventListener('click', () => {
    slackBridge.login().then(() => _checkSlack()).catch(() => {});
  });

}
