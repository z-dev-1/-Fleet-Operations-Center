'use strict';
// tests/helpers/fake-aap-page.cjs — fake AAP page + provider for aap_api tests.
// The page answers the in-page scripts aap_api runs: the XHR hook script
// (null), the token wait ('csrf-token') and request scripts, which are parsed
// back into { method, url, path, body } and routed through routeFn(req) to an
// in-page XHR result ({ ok, status, json }). Plain CJS, no vitest import.
const AAP_ORIGIN = 'https://aap-na.corp.amazon.com';

function parseRequestScript(script) {
  const m = /xhr\.open\("(\w+)", "([^"]+)", true\)/.exec(script);
  if (!m) return null;
  const method = m[1];
  const url = m[2];
  let body = null;
  if (method !== 'GET') {
    const b = /xhr\.send\((".*")\);/.exec(script);
    if (b) body = JSON.parse(JSON.parse(b[1]));
  }
  const path = url.startsWith(AAP_ORIGIN) ? url.slice(AAP_ORIGIN.length) : url;
  return { method, url, path, body };
}

const never = () => new Promise(() => {});

function mkRoutedPage(routeFn, { hangWhen } = {}) {
  const page = {
    requests: [],
    hung: 0,
    closed: 0,
    evaluate(script) {
      if (script.includes('__aapHookInstalled')) return Promise.resolve(null);
      if (script.includes('xhr.open(')) {
        const req = parseRequestScript(script);
        page.requests.push(req);
        if (hangWhen && hangWhen(req)) { page.hung++; return never(); }
        return Promise.resolve().then(() => routeFn(req));
      }
      return Promise.resolve('csrf-token');
    },
    url() { return AAP_ORIGIN + '/v2/page/test'; },
    close() { page.closed++; },
  };
  return page;
}

// pages: an array of pages (used in order) or a factory () => page.
function mkProvider(pages) {
  const queue = Array.isArray(pages) ? pages.slice() : null;
  const prov = {
    opened: 0,
    async openPage() {
      prov.opened++;
      return queue ? queue.shift() : pages();
    },
    kind: () => 'electron',
    shutdown() {},
  };
  return prov;
}

module.exports = { parseRequestScript, mkRoutedPage, mkProvider, AAP_ORIGIN };
