'use strict';

// ---------------------------------------------------------------------------
// Microsoft Graph backend for Outlook / Hotmail / Live (personal and work).
//
// Microsoft disabled password IMAP for personal accounts (2026) and their OAuth IMAP
// path is broken for consumer mailboxes ("User is authenticated but not connected"),
// so Graph is the only working way in. This module mirrors the IMAP operations InBoxer
// needs, using the Graph REST API with the OAuth access token from ms-oauth.js:
//   • scanInbox     — stream the newest N inbox messages (headers only)
//   • ensureFolderPath — find-or-create a nested folder, return its id
//   • moveMessages  — move messages into a folder ($batch)
//   • setRead       — mark messages read/unread ($batch)
//   • sendMail      — send a mailto unsubscribe
// ---------------------------------------------------------------------------

const GRAPH = 'https://graph.microsoft.com/v1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qs = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const odataEsc = (s) => String(s).replace(/'/g, "''");   // escape single quotes in $filter

// One Graph request with transparent 429/503 back-off. Returns parsed JSON (or null).
async function graphFetch(accessToken, method, pathOrUrl, body) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : GRAPH + pathOrUrl;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status === 503) {
      await sleep((Number(res.headers.get('retry-after')) || 2) * 1000);
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    const json = text ? safeJson(text) : null;
    if (!res.ok) {
      const e = new Error((json && json.error && json.error.message) || `Microsoft Graph error ${res.status}`);
      e.status = res.status;
      e.graphCode = json && json.error && json.error.code;
      throw e;
    }
    return json;
  }
  const e = new Error('Microsoft Graph is rate-limiting the request. Please try again shortly.');
  e.status = 429; e.friendly = true;
  throw e;
}
function safeJson(t) { try { return JSON.parse(t); } catch (_) { return null; } }

// Graph message → the raw shape InBoxer's classify() expects (same keys as the IMAP path).
function toRaw(msg, userEmail) {
  const headers = {};
  for (const h of (msg.internetMessageHeaders || [])) headers[(h.name || '').toLowerCase()] = h.value || '';
  const ea = (msg.from && msg.from.emailAddress) || {};
  const fromName = ea.name || '';
  const fromEmail = ea.address || '';
  return {
    uid: msg.id,
    from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
    to: (msg.toRecipients || []).map((r) => r.emailAddress && r.emailAddress.address).filter(Boolean).join(', '),
    subject: msg.subject || '',
    date: msg.receivedDateTime || '',
    seen: !!msg.isRead,
    listUnsubscribe: headers['list-unsubscribe'] || '',
    listUnsubscribePost: headers['list-unsubscribe-post'] || '',
    precedence: headers['precedence'] || '',
    autoSubmitted: headers['auto-submitted'] || '',
    replyTo: headers['reply-to'] || '',
    userAddress: userEmail,
  };
}

// Every operation takes `getToken` — an async () => accessToken — rather than a fixed
// token, and resolves it before each network call. That lets long jobs (filing a big
// inbox can outlive a 1-hour token) refresh transparently mid-operation; getToken caches,
// so this is a no-op until the token actually nears expiry.

// Stream the newest `limit` Inbox messages. Calls cbs.onStart(total, toScan) once, then
// cbs.onBatch(rawEmails, scannedSoFar, toScan) per page. Returns { total, scanned }.
async function scanInbox(getToken, limit, userEmail, cbs) {
  const folder = await graphFetch(await getToken(), 'GET', '/me/mailFolders/inbox?$select=totalItemCount');
  const total = (folder && folder.totalItemCount) || 0;
  const toScan = Math.min(total, Math.max(0, Number(limit) || 0));
  cbs.onStart && cbs.onStart(total, toScan);
  if (toScan === 0) return { total, scanned: 0 };

  const select = 'id,subject,from,toRecipients,receivedDateTime,isRead,internetMessageHeaders';
  let url = '/me/mailFolders/inbox/messages?' + qs({ '$top': 100, '$orderby': 'receivedDateTime desc', '$select': select });
  let scanned = 0;
  while (url && scanned < toScan) {
    const page = await graphFetch(await getToken(), 'GET', url);
    const items = (page && page.value) || [];
    if (!items.length) break;
    const slice = items.slice(0, toScan - scanned);   // don't overshoot the limit
    const raws = slice.map((m) => toRaw(m, userEmail));
    scanned += raws.length;
    cbs.onBatch && cbs.onBatch(raws, scanned, toScan);
    url = page['@odata.nextLink'] || null;
  }
  return { total, scanned };
}

// Find-or-create each path segment under the previous; returns the deepest folder id.
// Idempotent — reuses an existing folder rather than erroring on a duplicate name.
async function ensureFolderPath(getToken, segments) {
  let parentId = null;
  for (const name of segments) {
    const base = parentId ? `/me/mailFolders/${encodeURIComponent(parentId)}/childFolders` : '/me/mailFolders';
    const found = await graphFetch(await getToken(), 'GET', base + '?' + qs({ '$filter': `displayName eq '${odataEsc(name)}'`, '$select': 'id,displayName', '$top': 1 }));
    let folder = found && found.value && found.value[0];
    if (!folder) folder = await graphFetch(await getToken(), 'POST', base, { displayName: name });
    parentId = folder.id;
  }
  return parentId;
}

// Run id/method/url requests through Graph's $batch (max 20), re-queuing any that get
// throttled. `onProgress(done, total)` fires after each batch. Returns count processed.
async function runBatch(getToken, items, total, onProgress) {
  let done = 0;
  const queue = items.slice();
  while (queue.length) {
    const chunk = queue.splice(0, 20);
    const requests = chunk.map((it, j) => ({ id: String(j), method: it.method, url: it.url, headers: { 'Content-Type': 'application/json' }, body: it.body }));
    const resp = await graphFetch(await getToken(), 'POST', '/$batch', { requests });
    const responses = (resp && resp.responses) || [];
    let maxWait = 0;
    for (const r of responses) {
      const it = chunk[Number(r.id)];
      if (r.status === 429 || r.status === 503) {
        queue.push(it);
        const ra = r.headers && (r.headers['Retry-After'] || r.headers['retry-after']);
        maxWait = Math.max(maxWait, Number(ra) || 2);
      } else {
        done++;   // 2xx, or a 4xx we can't retry (e.g. already moved) — treat as processed
      }
    }
    if (onProgress) onProgress(done, total);
    if (maxWait) await sleep(maxWait * 1000);
  }
  return done;
}

function moveMessages(getToken, ids, destFolderId, onProgress) {
  const items = ids.map((id) => ({ method: 'POST', url: `/me/messages/${encodeURIComponent(id)}/move`, body: { destinationId: destFolderId } }));
  return runBatch(getToken, items, ids.length, onProgress);
}

function setRead(getToken, ids, isRead) {
  const items = ids.map((id) => ({ method: 'PATCH', url: `/me/messages/${encodeURIComponent(id)}`, body: { isRead: !!isRead } }));
  return runBatch(getToken, items, ids.length);
}

async function sendMail(getToken, { to, subject, text }) {
  await graphFetch(await getToken(), 'POST', '/me/sendMail', {
    message: {
      subject: subject || 'unsubscribe',
      body: { contentType: 'Text', content: text || 'Please unsubscribe me from this list.' },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems: false,
  });
}

module.exports = { scanInbox, ensureFolderPath, moveMessages, setRead, sendMail };
