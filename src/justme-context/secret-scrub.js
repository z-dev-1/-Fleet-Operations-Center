'use strict';
// src/justme-context/secret-scrub.js — deterministic credential screen (round-3
// fix 2, plan D3). The vision reader runs Claude Code with Read permission and
// confineRead could not be verified (lane probe P2 failed), so a hostile image
// could induce it to transcribe a local secret. Any vision text that looks like
// a credential is discarded before it becomes an item, and the same screen is
// applied to the AI reply on context turns. It only catches credential-SHAPED
// data; that is the stated residual.
//
// findSecret returns the pattern NAME (never the matched text) or null.

const SECRET_RES = [
  { name: 'httponly-cookie', re: /#HttpOnly_/i },
  { name: 'cookie-jar-line', re: /^\S+\t(TRUE|FALSE)\t\/\S*\t(TRUE|FALSE)\t\d+\t/m },
  { name: 'slack-token', re: /\bxox[abcdeposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'aws-access-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'aws-secret-key', re: /aws_secret_access_key/i },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

function findSecret(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return null;
  for (const p of SECRET_RES) if (p.re.test(s)) return p.name;
  return null;
}

module.exports = { SECRET_RES, findSecret };
