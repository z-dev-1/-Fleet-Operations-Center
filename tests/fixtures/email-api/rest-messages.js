// tests/fixtures/email-api/rest-messages.js — Outlook REST v2.0 JSON builders (example.test addresses only).
let seq = 0;

export function restMessage(o) {
  const x = o || {};
  seq++;
  const id = x.Id || ('AAMkMSG' + seq + '-x_y=');
  return {
    Id: id,
    ConversationId: x.ConversationId || 'AAQkCONV-1_a=',
    InternetMessageId: x.InternetMessageId === undefined ? '<msg' + seq + '@example.test>' : x.InternetMessageId,
    ReceivedDateTime: x.ReceivedDateTime || '2026-11-07T08:00:00Z',
    Subject: x.Subject === undefined ? 'Unit 40123 status' : x.Subject,
    From: x.From || { EmailAddress: { Name: 'Shop Desk', Address: 'shop@example.test' } },
    ToRecipients: x.ToRecipients || [{ EmailAddress: { Name: 'Me Person', Address: 'me@example.test' } }],
    CcRecipients: x.CcRecipients || [],
    HasAttachments: !!x.HasAttachments,
    IsRead: x.IsRead !== undefined ? x.IsRead : false,
    IsDraft: !!x.IsDraft,
    ParentFolderId: x.ParentFolderId || 'FOLDER-INBOX',
    Body: x.Body || { ContentType: 'HTML', Content: '<html><body><p>' + (x.text || 'Unit 40123 is in repair, ETA Friday.') + '</p></body></html>' },
  };
}

/** The list projection the reader requests (SELECT_LIST + ParentFolderId). */
export function listItem(m) {
  return { Id: m.Id, ConversationId: m.ConversationId, InternetMessageId: m.InternetMessageId, ReceivedDateTime: m.ReceivedDateTime, IsDraft: m.IsDraft, ParentFolderId: m.ParentFolderId, IsRead: m.IsRead };
}

export function restAttachment(o) {
  const x = o || {};
  return {
    '@odata.type': x.type || '#Microsoft.OutlookServices.FileAttachment',
    Id: x.Id || 'ATT-1', Name: x.Name || 'estimate.pdf', ContentType: x.ContentType || 'application/pdf', Size: x.Size == null ? 1000 : x.Size, IsInline: !!x.IsInline,
  };
}

export const WK = { inbox: 'FOLDER-INBOX', sentitems: 'FOLDER-SENT', drafts: 'FOLDER-DRAFTS', deleteditems: 'FOLDER-DEL', junkemail: 'FOLDER-JUNK', archive: 'FOLDER-ARCHIVE' };

const _q = (path) => new URLSearchParams(path.split('?')[1] || '');
const _ts = (s) => Date.parse(s);
function _filter(list, f) {
  let out = list.slice();
  if (!f) return out;
  for (const clause of f.split(' and ')) {
    let m;
    if ((m = /^ReceivedDateTime ge (\S+)$/.exec(clause))) { const t = _ts(m[1]); out = out.filter((x) => _ts(x.ReceivedDateTime) >= t); }
    else if ((m = /^ReceivedDateTime lt (\S+)$/.exec(clause))) { const t = _ts(m[1]); out = out.filter((x) => _ts(x.ReceivedDateTime) < t); }
    else if ((m = /^ConversationId eq '(.*)'$/.exec(clause))) { const c = m[1].replace(/''/g, "'"); out = out.filter((x) => x.ConversationId === c); }
    else if ((m = /^InternetMessageId eq '(.*)'$/.exec(clause))) { const c = m[1].replace(/''/g, "'"); out = out.filter((x) => x.InternetMessageId === c); }
    else if ((m = /^Subject eq '(.*)'$/.exec(clause))) { const c = m[1].replace(/''/g, "'"); out = out.filter((x) => x.Subject === c); }
  }
  return out;
}
function _page(path, list, opts) {
  const q = _q(path);
  let out = _filter(list, q.get('$filter'));
  const ob = q.get('$orderby');
  if (ob === 'ReceivedDateTime desc') out.sort((a, b) => _ts(b.ReceivedDateTime) - _ts(a.ReceivedDateTime));
  else if (ob === 'ReceivedDateTime asc') out.sort((a, b) => _ts(a.ReceivedDateTime) - _ts(b.ReceivedDateTime));
  else if (opts && opts.shuffle) out = opts.shuffle(out);
  const top = Number(q.get('$top') || 10);
  const skip = Number(q.get('$skip') || 0);
  const value = out.slice(skip, skip + top).map((m) => (opts && opts.full ? m : listItem(m)));
  const json = { value };
  if (skip + top < out.length) {
    q.set('$skip', String(skip + top));
    json['@odata.nextLink'] = (opts && opts.linkHost ? opts.linkHost : 'https://outlook.office.com') + path.split('?')[0] + '?' + q.toString();
  }
  return json;
}

/**
 * mailboxRoutes(world) -> fake-net routes for a small REST mailbox.
 *   world = { msgs: [restMessage], folders?: [restFolder], children?: { id: [restFolder] }, atts?: { msgId: [restAttachment] },
 *             convOrderby?: false (reject the ordered conversation query with InefficientFilter), listOrderby?: false,
 *             shuffle?: fn, linkHost?, failFolder?: { [folderId]: response } }
 */
export function mailboxRoutes(world) {
  const w = world;
  const msgs = () => w.msgs;
  return [
    { method: 'GET', re: /\/me\/mailfolders\/(inbox|sentitems|drafts|deleteditems|junkemail|archive)\?/, respond: (req) => {
      const name = /\/mailfolders\/([a-z]+)\?/.exec(req.decoded)[1];
      if (w.missingWellKnown && w.missingWellKnown.includes(name)) return { status: 404, json: { error: { code: 'ErrorFolderNotFound' } } };
      return { status: 200, json: { Id: WK[name], DisplayName: name } };
    } },
    { method: 'GET', re: /\/me\/mailfolders\?/, respond: () => ({ status: 200, json: { value: w.folders || [] } }) },
    { method: 'GET', re: /\/me\/mailfolders\/[^/]+\/childfolders/, respond: (req) => {
      const id = decodeURIComponent(/\/mailfolders\/([^/]+)\/childfolders/.exec(req.path)[1]);
      return { status: 200, json: { value: (w.children && w.children[id]) || [] } };
    } },
    { method: 'GET', re: /\/me\/mailfolders\/[^/]+\/messages/, respond: (req) => {
      const fid = decodeURIComponent(/\/mailfolders\/([^/]+)\/messages/.exec(req.path)[1]);
      if (w.failFolder && w.failFolder[fid]) return typeof w.failFolder[fid] === 'function' ? w.failFolder[fid](req) : w.failFolder[fid];
      if (w.listOrderby === false && /\$orderby/.test(req.decoded)) return { status: 400, json: { error: { code: 'InefficientFilter' } } };
      return { status: 200, json: _page(req.path, msgs().filter((m) => m.ParentFolderId === fid), { linkHost: w.linkHost, full: fid === WK.sentitems && /Body/.test(req.decoded) }) };
    } },
    { method: 'GET', re: /\/me\/messages\?/, respond: (req) => {
      if (w.convOrderby === false && /\$orderby/.test(req.decoded)) return { status: 400, json: { error: { code: 'InefficientFilter' } } };
      return { status: 200, json: _page(req.path, msgs(), { shuffle: w.shuffle, linkHost: w.linkHost }) };
    } },
    { method: 'GET', re: /\/me\/messages\/[^/?]+\/attachments\?/, respond: (req) => {
      const id = decodeURIComponent(/\/messages\/([^/?]+)\/attachments/.exec(req.path)[1]);
      return { status: 200, json: { value: (w.atts && w.atts[id]) || [] } };
    } },
    { method: 'GET', re: /\/me\/messages\/[^/?]+\?/, respond: (req) => {
      const id = decodeURIComponent(/\/messages\/([^/?]+)\?/.exec(req.path)[1]);
      const m = msgs().find((x) => x.Id === id);
      if (!m) return { status: 404, json: { error: { code: 'ErrorItemNotFound' } } };
      if (w.tooLarge && w.tooLarge.includes(id) && /Body(,|%2C|$)/.test(req.decoded) && !/BodyPreview/.test(req.decoded)) return { status: 200, chunks: ['x'.repeat(5 * 1024 * 1024)] };
      return { status: 200, json: Object.assign({}, m, /BodyPreview/.test(req.decoded) ? { Body: undefined, BodyPreview: 'preview' } : {}) };
    } },
  ];
}

/**
 * mailServerRoutes(s) -> fake-net routes for the send / move side of the REST API.
 *   s = { originals: { [itemId]: restMessage }, draftTo?, draftCc?, rewrite?(html) -> html, dropQuote?, draftSubject?,
 *         send?: response for POST /send, sendmail?: response, sent: [] (filled on 202), moveFail?: Set(ids), conv?: { [convId]: [ids] } }
 * Created drafts live in s.drafts; a 202 send copies the draft (with its marker body) into s.sent, which the
 * Sent Items search routes serve.
 */
export function mailServerRoutes(s) {
  s.drafts = s.drafts || {};
  s.sent = s.sent || [];
  let n = 0;
  const idOf = (path, re) => decodeURIComponent(re.exec(path)[1]);
  return [
    { method: 'POST', re: /\/me\/messages\/[^/]+\/createreply(all)?$/, respond: (req) => {
      const id = idOf(req.path, /\/messages\/([^/]+)\/createreply/);
      const o = s.originals && s.originals[id];
      if (!o) return { status: 404, json: { error: { code: 'ErrorItemNotFound' } } };
      const all = /createreplyall$/.test(req.path);
      const d = {
        Id: 'DRAFT-' + (++n), Subject: s.draftSubject !== undefined ? s.draftSubject : 'RE: ' + o.Subject, ConversationId: o.ConversationId, InternetMessageId: '<draft' + n + '@example.test>',
        ToRecipients: s.draftTo || [o.From], CcRecipients: s.draftCc || (all ? o.CcRecipients : []),
        Body: { ContentType: 'HTML', Content: '<html><head></head><body><div id="quote">Original: ' + (o.Body && o.Body.Content ? 'unit 40123 question' : '') + '</div></body></html>' },
      };
      s.drafts[d.Id] = d;
      return { status: 201, json: d };
    } },
    { method: 'GET', re: /\/me\/messages\/DRAFT-\d+\?/, respond: (req) => {
      const d = s.drafts[idOf(req.path, /\/messages\/([^/?]+)\?/)];
      return d ? { status: 200, json: d } : { status: 404 };
    } },
    { method: 'PATCH', re: /\/me\/messages\/DRAFT-\d+$/, respond: (req) => {
      const d = s.drafts[idOf(req.path, /\/messages\/([^/?]+)$/)];
      if (!d) return { status: 404 };
      let html = req.body.Body.Content;
      if (s.rewrite) html = s.rewrite(html);
      if (s.dropQuote) html = html.replace(/<div id="quote">[\s\S]*?<\/div>/, '');
      d.Body = { ContentType: 'HTML', Content: html };
      return { status: 200, json: d };
    } },
    { method: 'DELETE', re: /\/me\/messages\/DRAFT-\d+$/, respond: (req) => { delete s.drafts[idOf(req.path, /\/messages\/([^/?]+)$/)]; return s.deleteFail ? { status: 500 } : { status: 204 }; } },
    { method: 'POST', re: /\/me\/messages\/DRAFT-\d+\/send$/, respond: (req) => {
      const r = s.send || { status: 202 };
      if (r.status === 202 || (r.delayMs && r.status === 202)) {
        const d = s.drafts[idOf(req.path, /\/messages\/([^/]+)\/send/)];
        if (d && !s.sentHidden) s.sent.push({ Id: 'SENT-' + d.Id, InternetMessageId: d.InternetMessageId, ConversationId: d.ConversationId, Subject: d.Subject, Body: d.Body });
      }
      return r;
    } },
    { method: 'POST', re: /\/me\/sendmail$/, respond: (req) => {
      const r = s.sendmail || { status: 202 };
      if (r.status === 202 && !s.sentHidden) { const m = req.body.Message; s.sent.push({ Id: 'SENT-M' + (++n), InternetMessageId: '<sm' + n + '@example.test>', ConversationId: 'CONV-NEW', Subject: m.Subject, Body: m.Body }); }
      return r;
    } },
    { method: 'GET', re: /\/mailfolders\/sentitems\/messages/, respond: (req) => {
      const f = new URLSearchParams(req.path.split('?')[1]).get('$filter') || '';
      let m; let list = s.sent;
      if ((m = /^InternetMessageId eq '(.*)'$/.exec(f))) list = list.filter((i) => i.InternetMessageId === m[1].replace(/''/g, "'"));
      else if ((m = /^ConversationId eq '(.*)'$/.exec(f))) list = list.filter((i) => i.ConversationId === m[1].replace(/''/g, "'"));
      else if ((m = /^Subject eq '(.*)'$/.exec(f))) list = list.filter((i) => i.Subject === m[1].replace(/''/g, "'"));
      return { status: 200, json: { value: list } };
    } },
    { method: 'GET', re: /\/me\/mailfolders\/[^/]+\/messages\?\$filter=ConversationId eq/, respond: (req) => {
      const c = /ConversationId eq '(.*)'&/.exec(req.decoded)[1];
      return { status: 200, json: { value: ((s.conv && s.conv[c]) || []).map((Id) => ({ Id })) } };
    } },
    { method: 'POST', re: /\/me\/messages\/[^/]+\/move$/, respond: (req) => {
      const id = idOf(req.path, /\/messages\/([^/]+)\/move/);
      if (s.moveAuth && s.moveAuth.has(id)) return { status: 401 };
      if (s.moveFail && s.moveFail.has(id)) return s.moveFail.get ? s.moveFail.get(id) : { status: 500 };
      (s.moved = s.moved || []).push(id);
      return { status: 201, json: { Id: id + '-moved' } };
    } },
    { method: 'GET', re: /\/me\/mailfolders\/(inbox|sentitems|drafts|deleteditems|junkemail|archive)\?/, respond: (req) => {
      const name = /\/mailfolders\/([a-z]+)\?/.exec(req.decoded)[1];
      return { status: 200, json: { Id: WK[name], DisplayName: name } };
    } },
    { method: 'GET', re: /\/me\/mailfolders\?/, respond: () => ({ status: 200, json: { value: s.folders || [] } }) },
  ];
}

export function restFolder(o) {
  const x = o || {};
  return { Id: x.Id || 'FOLDER-X', DisplayName: x.DisplayName || 'Fleet', ChildFolderCount: x.ChildFolderCount || 0 };
}
