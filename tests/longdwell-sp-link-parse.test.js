// tests/longdwell-sp-link-parse.test.js - parseSheetLink (src/longdwell/link-parse.js).
// All links are synthetic (contoso tenant).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { parseSheetLink } = require('../src/longdwell/link-parse');

const H = 'https://contoso.sharepoint.com';
const HEX = '0123456789abcdef0123456789ABCDEF';
const GUID = '01234567-89ab-cdef-0123-456789abcdef';

describe('recognized forms', () => {
  it('sharing link, short /:x:/s/', () => {
    const r = parseSheetLink(H + '/:x:/s/FleetOps/EaBcDeFgHiJ?e=TOKEN123');
    expect(r).toMatchObject({ ok: true, host: 'contoso.sharepoint.com', site: '/sites/FleetOps', kind: 'sharing-token', serverRelativeUrl: null, fileGuid: null });
  });
  it('sharing link /:x:/t/ and /:x:/g/personal/', () => {
    expect(parseSheetLink(H + '/:x:/t/Team1/Etoken?e=x')).toMatchObject({ ok: true, site: '/teams/Team1', kind: 'sharing-token' });
    expect(parseSheetLink('https://contoso-my.sharepoint.com/:x:/g/personal/user_contoso_com/Etoken?e=x'))
      .toMatchObject({ ok: true, host: 'contoso-my.sharepoint.com', site: '/personal/user_contoso_com', kind: 'sharing-token' });
  });
  it('sharing link, path /:x:/r/ with d=w<hex32>', () => {
    const r = parseSheetLink(H + '/:x:/r/sites/FleetOps/Shared%20Documents/Long%20Dwell/Week%2045.xlsx?d=w' + HEX + '&csf=1&web=1&e=abc');
    expect(r).toMatchObject({
      ok: true, kind: 'direct-path', site: '/sites/FleetOps',
      serverRelativeUrl: '/sites/FleetOps/Shared Documents/Long Dwell/Week 45.xlsx',
      fileGuid: GUID, fileName: 'Week 45.xlsx',
    });
  });
  it('Doc.aspx sourcedoc={guid}', () => {
    const r = parseSheetLink(H + '/sites/FleetOps/_layouts/15/Doc.aspx?sourcedoc=%7B' + GUID.toUpperCase() + '%7D&file=Week%2045.xlsx&action=default&mobileredirect=true');
    expect(r).toMatchObject({ ok: true, kind: 'doc-aspx', site: '/sites/FleetOps', fileGuid: GUID, fileName: 'Week 45.xlsx' });
  });
  it('Doc.aspx reached through /:x:/r/', () => {
    const r = parseSheetLink(H + '/:x:/r/sites/FleetOps/_layouts/15/Doc.aspx?sourcedoc=%7B' + GUID + '%7D&file=T.xlsx');
    expect(r).toMatchObject({ ok: true, kind: 'doc-aspx', site: '/sites/FleetOps', fileGuid: GUID });
  });
  it('direct path', () => {
    const r = parseSheetLink(H + '/sites/FleetOps/Shared%20Documents/Tracker%20%231.xlsx');
    expect(r).toMatchObject({ ok: true, kind: 'direct-path', site: '/sites/FleetOps', serverRelativeUrl: '/sites/FleetOps/Shared Documents/Tracker #1.xlsx', fileGuid: null });
  });
  it('host is case-insensitive and lower-cased; fragment dropped from canonicalUrl', () => {
    const r = parseSheetLink('  https://CONTOSO.SharePoint.com/sites/A/D/x.XLSX#gid=1  ');
    expect(r.ok).toBe(true);
    expect(r.host).toBe('contoso.sharepoint.com');
    expect(r.canonicalUrl).not.toContain('#');
    expect(r.canonicalUrl).not.toContain('gid=1');
  });
});

describe('rejects', () => {
  const cases = [
    ['http scheme', 'http://contoso.sharepoint.com/sites/A/D/x.xlsx', 'bad-link'],
    ['non-SharePoint host', 'https://evil.example.com/sites/A/D/x.xlsx', 'bad-host'],
    ['look-alike host', 'https://contoso.sharepoint.com.evil.com/sites/A/D/x.xlsx', 'bad-host'],
    ['userinfo', 'https://u:p@contoso.sharepoint.com/sites/A/D/x.xlsx', 'bad-link'],
    ['too long', H + '/sites/A/D/' + 'a'.repeat(2050) + '.xlsx', 'link-too-long'],
    ['control chars', H + '/sites/A/D/x\u0001.xlsx', 'bad-link'],
    ['empty', '   ', 'bad-link'],
    ['not a url', 'hello', 'bad-link'],
    ['javascript', 'javascript:alert(1)', 'bad-link'],
    ['xlsm', H + '/sites/A/D/x.xlsm', 'unsupported-format'],
    ['xlsb', H + '/sites/A/D/x.xlsb', 'unsupported-format'],
    ['xls', H + '/sites/A/D/x.xls', 'unsupported-format'],
    ['csv', H + '/sites/A/D/x.csv', 'unsupported-format'],
    ['word sharing link', H + '/:w:/s/A/Etoken?e=1', 'unsupported-format'],
    ['folder sharing link', H + '/:f:/s/A/Etoken?e=1', 'unsupported-link'],
    ['site root', H + '/sites/A', 'unsupported-link'],
    ['Doc.aspx without sourcedoc', H + '/sites/A/_layouts/15/Doc.aspx?file=x.xlsx', 'unsupported-link'],
    ['Doc.aspx for a docx', H + '/sites/A/_layouts/15/Doc.aspx?sourcedoc=%7B' + GUID + '%7D&file=x.docx', 'unsupported-format'],
    ['bad percent encoding', H + '/sites/A/D/%E0%A4%A.xlsx', 'bad-link'],
  ];
  for (const [name, url, code] of cases) {
    it(name + ' -> ' + code, () => expect(parseSheetLink(url)).toEqual({ ok: false, code }));
  }
  it('non-string input', () => {
    for (const v of [undefined, null, 42, {}, ['x']]) expect(parseSheetLink(v)).toEqual({ ok: false, code: 'bad-link' });
  });
  it('no query value leaks into an error result', () => {
    const r = parseSheetLink('https://evil.example.com/:x:/s/A/E?e=SECRETTOKEN');
    expect(JSON.stringify(r)).not.toContain('SECRETTOKEN');
    const r2 = parseSheetLink(H + '/sites/A/D/x.xlsm?e=SECRETTOKEN');
    expect(JSON.stringify(r2)).not.toContain('SECRETTOKEN');
  });
});
