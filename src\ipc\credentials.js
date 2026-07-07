'use strict';
/**
 * ipc/credentials.js - Site credential manager IPC handlers
 * S23-0 (2026-06-28): VENDOR_CRED_KEYS, _HOST_TO_VENDOR, getForHostname()
 * BUG FIX: loadCredentials was never exported; auto-login.js was broken.
 */

const creds  = require("../security/credentials");
const logger = require("../utils/logger")("ipc:credentials");
const { handle, requireString } = require('./_safe');
const { ConfigError }           = require("../utils/errors");

const KEY_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

function _validateKey(key) {
  requireString(key, "key");
  if (!KEY_RE.test(key)) throw new ConfigError("invalid key chars","key");
}

const VENDOR_CRED_KEYS = {
  paccar:    { user: "vendor.paccar.username",    pass: "vendor.paccar.password"    },
  volvo:     { user: "vendor.volvo.username",     pass: "vendor.volvo.password"     },
  record360: { user: "vendor.record360.username", pass: "vendor.record360.password" },
  aperia:    { user: "vendor.aperia.username",    pass: "vendor.aperia.password"    },
  reach24:   { user: "vendor.reach24.username",   pass: "vendor.reach24.password"   },
  dtna:      { user: "vendor.dtna.username",      pass: "vendor.dtna.password"      },
  roadready: { user: "vendor.roadready.username", pass: "vendor.roadready.password" },
  velogic:   { user: "vendor.velogic.username",   pass: "vendor.velogic.password"   },
  abs:       { user: "vendor.abs.username",       pass: "vendor.abs.password"       },
};

const _HOST_TO_VENDOR = {
  "paccarpg.decisiv.net":           "paccar",
  "volvopg.asist.decisiv.net":      "volvo",
  "dashboard.record360.com":        "record360",
  "amazon.aperiatech.com":          "aperia",
  "amazon.reach24.net":             "reach24",
  "dtna.my.site.com":               "dtna",
  "ciam.dtna.com":                  "dtna",
  "login.dtna.com":                 "dtna",
  "roadready.fadv.com":             "roadready",
  "velogic.my.site.com":            "velogic",
  "www.access-billing-services.com":"abs",
};

async function getForHostname(hostname) {
  const vendor = _HOST_TO_VENDOR[hostname];
  if (vendor && VENDOR_CRED_KEYS[vendor]) {
    const keys = VENDOR_CRED_KEYS[vendor];
    const user = await creds.get(keys.user);
    const pass = await creds.get(keys.pass);
    if (user && pass) { logger.info("getForHostname: hit:", vendor); return { username: user, password: pass, label: vendor }; }
    logger.warn("getForHostname: no creds for:", vendor, "-- save via Settings > Credentials");
    return null;
  }
  const all = creds.list();
  for (const key of all) {
    const raw = await creds.get(key); if (!raw) continue;
    try {
      const entry = JSON.parse(raw);
      if (entry.url && entry.username && entry.password) {
        try { if (new URL(entry.url).hostname === hostname) return { username: entry.username, password: entry.password, label: entry.label || key }; } catch (_) {}
      }
    } catch (_) {}
  }
  logger.warn("getForHostname: no match for:", hostname); return null;
}

function registerCredentialIPC() {
  handle("credentials:list", async () => creds.list());
  handle("credentials:has", async (_e, key) => { const all = await creds.list(); return all.includes(key); });
  handle("credentials:set", async (_e, key, val) => { _validateKey(key); await creds.set(key, typeof val==="string"?val:JSON.stringify(val)); logger.info("set:",key); return {ok:true}; });
  handle("credentials:get", async (_e, key) => { requireString(key,"key"); const v=await creds.get(key); return v===null?null:{ exists: true, key }; });
  handle("credentials:save", async (_e, e) => { if (!e||typeof e!=="object") throw new ConfigError("entry must be object","entry"); _validateKey(e.key); await creds.set(e.key, typeof e.value==="string"?e.value:JSON.stringify(e.value)); logger.info("saved:",e.key); return {ok:true,key:e.key}; });
  handle("credentials:delete", async (_e, key) => { requireString(key,"key"); await creds.delete(key); logger.info("deleted:",key); return {ok:true}; });
  handle("credentials:get-for-url", async (_e, url) => { requireString(url,"url"); try { const h=new URL(url).hostname; const f=await getForHostname(h); return f?{exists:true,hostname:h,label:f.label}:null; } catch(_){return null;} });
  logger.info("Credentials IPC handlers registered");
}

module.exports = { registerCredentialIPC, getForHostname, VENDOR_CRED_KEYS };
