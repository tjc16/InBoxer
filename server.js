'use strict';

const path = require('path');
const express = require('express');
const imaps = require('imap-simple');
const Imap = require('imap');
const nodemailer = require('nodemailer');
const { classify } = require('./categorize');
const { generateDemoInbox } = require('./demo-data');

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

const HEADER_FIELDS =
  'HEADER.FIELDS (FROM TO SUBJECT DATE LIST-UNSUBSCRIBE LIST-UNSUBSCRIBE-POST PRECEDENCE AUTO-SUBMITTED REPLY-TO)';

// ---------------------------------------------------------------------------
// Provider auto-detection (IMAP + SMTP)
// ---------------------------------------------------------------------------

const PRESETS = [
  { m: ['gmail.com', 'googlemail.com'], imap: 'imap.gmail.com', smtp: 'smtp.gmail.com' },
  { m: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'office365.com'], imap: 'outlook.office365.com', smtp: 'smtp.office365.com', smtpPort: 587 },
  { m: ['yahoo.com', 'ymail.com', 'rocketmail.com'], imap: 'imap.mail.yahoo.com', smtp: 'smtp.mail.yahoo.com' },
  { m: ['icloud.com', 'me.com', 'mac.com'], imap: 'imap.mail.me.com', smtp: 'smtp.mail.me.com', smtpPort: 587 },
  { m: ['aol.com'], imap: 'imap.aol.com', smtp: 'smtp.aol.com' },
  { m: ['gmx.com', 'gmx.net'], imap: 'imap.gmx.com', smtp: 'mail.gmx.com', smtpPort: 587 },
  { m: ['zoho.com'], imap: 'imap.zoho.com', smtp: 'smtp.zoho.com' },
  { m: ['fastmail.com'], imap: 'imap.fastmail.com', smtp: 'smtp.fastmail.com' },
];

function detectImap(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  const p = PRESETS.find((x) => x.m.includes(domain));
  return p ? { host: p.imap, port: 993 } : { host: domain ? `imap.${domain}` : '', port: 993 };
}
function detectSmtp(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  const p = PRESETS.find((x) => x.m.includes(domain));
  const host = p ? p.smtp : (domain ? `smtp.${domain}` : '');
  const port = p && p.smtpPort ? p.smtpPort : 465;
  return { host, port, secure: port === 465 };
}

app.post('/api/detect', (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  res.json(detectImap(email));
});

// ---------------------------------------------------------------------------
// Map a raw email → the client-facing classified object
// ---------------------------------------------------------------------------

function toEmail(raw) {
  const r = classify(raw);
  return {
    uid: raw.uid,
    subject: raw.subject || '(no subject)',
    from: r.fromName,
    fromAddress: r.fromAddress,
    date: raw.date,
    seen: raw.seen,
    categoryKey: r.categoryKey, categoryName: r.categoryName, categoryIcon: r.categoryIcon, categoryOrder: r.categoryOrder,
    groupKey: r.groupKey, groupName: r.groupName, groupIcon: r.groupIcon, groupOrder: r.groupOrder,
    dispKey: r.dispKey, dispName: r.dispName, dispIcon: r.dispIcon, dispOrder: r.dispOrder,
    priority: r.priority, suggestedAction: r.suggestedAction, confidence: r.confidence,
    unsubscribeUrl: r.unsubscribeUrl, unsubscribeMailto: r.unsubscribeMailto, unsubscribeOneClick: r.unsubscribeOneClick,
    reasons: r.reasons,
  };
}

// ---------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------

app.get('/api/demo', (req, res) => {
  const emails = generateDemoInbox(320).map(toEmail);
  emails.sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json({ emails, demo: true });
});

// ---------------------------------------------------------------------------
// Connect + stream-scan
// ---------------------------------------------------------------------------

function buildImapConfig({ email, password, host, port }) {
  const d = detectImap(email);
  return {
    imap: {
      user: email, password,
      host: host || d.host, port: Number(port) || d.port || 993,
      tls: true, authTimeout: 20000,
      tlsOptions: { servername: host || d.host, rejectUnauthorized: false },
    },
  };
}

const openBoxReadOnly = (connection, name) => new Promise((resolve, reject) =>
  connection.imap.openBox(name, true, (err, box) => (err ? reject(err) : resolve(box))));

function fetchHeaderBatch(imap, range) {
  return new Promise((resolve, reject) => {
    let f;
    try { f = imap.seq.fetch(range, { bodies: HEADER_FIELDS, struct: false }); }
    catch (e) { return reject(e); }
    const out = [];
    f.on('message', (msg) => {
      const item = { attrs: null, buffer: '' };
      msg.on('body', (stream) => stream.on('data', (d) => { item.buffer += d.toString('utf8'); }));
      msg.once('attributes', (a) => { item.attrs = a; });
      msg.once('end', () => out.push(item));
    });
    f.once('error', reject);
    f.once('end', () => resolve(out));
  });
}

app.post('/api/scan', async (req, res) => {
  const { email, password, host, port, limit } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  const maxScan = Math.min(Number(limit) || 100000, 100000);
  const BATCH = 400;
  let connection;
  try {
    connection = await imaps.connect(buildImapConfig({ email, password, host, port }));
    const box = await openBoxReadOnly(connection, 'INBOX');
    const total = box.messages.total || 0;
    const toScan = Math.min(total, maxScan);
    send({ type: 'start', total: toScan, mailboxTotal: total });
    if (toScan === 0) { send({ type: 'done', scanned: 0 }); connection.end(); return res.end(); }

    let scanned = 0;
    const lowest = total - toScan + 1;
    for (let hi = total; hi >= lowest; hi -= BATCH) {
      const lo = Math.max(lowest, hi - BATCH + 1);
      const rows = await fetchHeaderBatch(connection.imap, `${lo}:${hi}`);
      rows.reverse();
      const emails = rows.map((row) => {
        const h = Imap.parseHeader(row.buffer);
        const flags = (row.attrs && row.attrs.flags) || [];
        const hv = (n) => (h[n] && h[n][0]) || '';
        return toEmail({
          uid: row.attrs.uid, from: hv('from'), to: hv('to'), subject: hv('subject'), date: hv('date'),
          seen: flags.includes('\\Seen'), listUnsubscribe: hv('list-unsubscribe'),
          listUnsubscribePost: hv('list-unsubscribe-post'), precedence: hv('precedence'),
          autoSubmitted: hv('auto-submitted'), replyTo: hv('reply-to'), userAddress: email,
        });
      });
      scanned += emails.length;
      send({ type: 'batch', emails, scanned, total: toScan });
    }
    send({ type: 'done', scanned });
    connection.end(); res.end();
  } catch (err) {
    if (connection) try { connection.end(); } catch (_) {}
    send({ type: 'error', error: friendlyError(err) }); res.end();
  }
});

// ---------------------------------------------------------------------------
// Apply taxonomy: create nested folders & move (streams progress)
// ---------------------------------------------------------------------------

app.post('/api/apply', async (req, res) => {
  const { email, password, host, port, demo, parent, plan } = req.body || {};
  const parentName = sanitizeSeg(parent || 'InBoxer') || 'InBoxer';
  const groups = Array.isArray(plan) ? plan.filter((g) => g && Array.isArray(g.uids) && g.uids.length && Array.isArray(g.segments)) : [];
  const totalToMove = groups.reduce((n, g) => n + g.uids.length, 0);

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  if (demo) {
    send({ type: 'start', totalToMove, folders: groups.length });
    let moved = 0;
    for (const g of groups) { moved += g.uids.length; send({ type: 'progress', folder: g.segments.join('/'), moved, totalToMove }); }
    send({ type: 'done', moved, folders: groups.length, parent: parentName });
    return res.end();
  }
  if (!email || !password) { send({ type: 'error', error: 'Email and password are required.' }); return res.end(); }

  let connection;
  try {
    connection = await imaps.connect(buildImapConfig({ email, password, host, port }));
    await connection.openBox('INBOX');
    const delim = connection.imap.delimiter || '/';
    send({ type: 'start', totalToMove, folders: groups.length });

    let moved = 0;
    for (const g of groups) {
      const segs = [parentName, ...g.segments.map(sanitizeSeg)].filter(Boolean);
      await ensureBoxPath(connection, segs, delim);
      const full = segs.join(delim);
      const uids = g.uids.map(String);
      for (let i = 0; i < uids.length; i += 200) {
        const batch = uids.slice(i, i + 200);
        await connection.moveMessage(batch, full);
        moved += batch.length;
        send({ type: 'progress', folder: g.segments.join(' / '), moved, totalToMove });
      }
    }
    send({ type: 'done', moved, folders: groups.length, parent: parentName });
    connection.end(); res.end();
  } catch (err) {
    if (connection) try { connection.end(); } catch (_) {}
    send({ type: 'error', error: friendlyError(err) }); res.end();
  }
});

const sanitizeSeg = (s) => String(s || '').replace(/[/.\\]/g, ' ').replace(/\s+/g, ' ').trim();

async function ensureBoxPath(connection, segs, delim) {
  for (let i = 1; i <= segs.length; i++) {
    await ensureBox(connection, segs.slice(0, i).join(delim));
  }
}
function ensureBox(connection, name) {
  return new Promise((resolve, reject) => {
    connection.imap.addBox(name, (err) => {
      if (err && !/exist|alreadyexists/i.test(err.message || '')) return reject(err);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// One-click mass unsubscribe (RFC 8058 HTTP POST + GET fallback + SMTP mailto)
// ---------------------------------------------------------------------------

app.post('/api/unsubscribe', async (req, res) => {
  const { email, password, demo, targets } = req.body || {};
  const list = Array.isArray(targets) ? targets : [];

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  send({ type: 'start', total: list.length });

  if (demo) {
    let done = 0, ok = 0;
    for (const t of list) { done++; ok++; send({ type: 'progress', done, total: list.length, sender: t.sender, status: 'ok' }); }
    send({ type: 'done', ok, failed: 0, manual: 0, total: list.length });
    return res.end();
  }

  // SMTP transporter only built if we actually need to send mailto unsubscribes.
  let transporter = null;
  if (email && password && list.some((t) => !t.url && t.mailto)) {
    try {
      const s = detectSmtp(email);
      transporter = nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: { user: email, pass: password } });
    } catch (_) { transporter = null; }
  }

  let done = 0, ok = 0, failed = 0, manual = 0;
  const queue = list.slice();
  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      let status = 'manual';
      try {
        if (t.url) status = await httpUnsub(t.url, t.oneClick);
        else if (t.mailto && transporter) { await transporter.sendMail({ from: email, ...parseMailto(t.mailto) }); status = 'ok'; }
      } catch (_) { status = 'failed'; }
      done++; status === 'ok' ? ok++ : status === 'manual' ? manual++ : failed++;
      send({ type: 'progress', done, total: list.length, sender: t.sender, status });
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, list.length || 1) }, worker));
  send({ type: 'done', ok, failed, manual, total: list.length });
  res.end();
});

async function httpUnsub(url, oneClick) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  const okStatus = (r) => r && (r.ok || r.status < 400);
  try {
    // RFC 8058 one-click: POST List-Unsubscribe=One-Click
    const post = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click', redirect: 'follow', signal: ctrl.signal,
    }).catch(() => null);
    if (okStatus(post)) return 'ok';
    if (oneClick) return 'failed';
    // Fallback: a plain GET to the unsubscribe link often completes it.
    const get = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal }).catch(() => null);
    return okStatus(get) ? 'ok' : 'failed';
  } finally { clearTimeout(timer); }
}

function parseMailto(m) {
  const [addr, qs] = String(m).split('?');
  const params = new URLSearchParams(qs || '');
  return { to: addr, subject: params.get('subject') || 'unsubscribe', text: params.get('body') || 'Please unsubscribe me from this list.' };
}

// ---------------------------------------------------------------------------
// Simple per-email organise (used by the detail dashboard)
// ---------------------------------------------------------------------------

app.post('/api/organise', async (req, res) => {
  const { email, password, host, port, action, uids, folder, demo } = req.body || {};
  if (demo) return res.json({ ok: true, affected: (uids || []).length, demo: true });
  if (!email || !password || !action || !Array.isArray(uids) || !uids.length) return res.status(400).json({ error: 'Missing action or selection.' });
  let connection;
  try {
    connection = await imaps.connect(buildImapConfig({ email, password, host, port }));
    await connection.openBox('INBOX');
    const delim = connection.imap.delimiter || '/';
    const uidList = uids.map(String);
    if (action === 'markRead') await connection.addFlags(uidList, '\\Seen');
    else if (action === 'markUnread') await connection.delFlags(uidList, '\\Seen');
    else if (action === 'move') {
      const segs = String(folder || 'InBoxer/Sorted').split('/').map(sanitizeSeg).filter(Boolean);
      await ensureBoxPath(connection, segs, delim);
      await connection.moveMessage(uidList, segs.join(delim));
    } else { connection.end(); return res.status(400).json({ error: `Unknown action: ${action}` }); }
    connection.end();
    res.json({ ok: true, affected: uidList.length });
  } catch (err) {
    if (connection) try { connection.end(); } catch (_) {}
    res.status(500).json({ error: friendlyError(err) });
  }
});

function friendlyError(err) {
  const msg = (err && err.message) || String(err);
  if (/auth|credentials|invalid|login/i.test(msg)) return 'Login failed. Check your email and password. Gmail/Outlook/Yahoo usually require an "app password" with 2FA enabled, not your normal password.';
  if (/ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(msg)) return 'Could not reach the mail server. Check the IMAP host in Advanced settings.';
  if (/timeout|ETIMEDOUT/i.test(msg)) return 'Connection timed out. The IMAP host/port may be wrong, or the server is blocking the connection.';
  return msg;
}

// Run a normal server locally; export the app so Vercel can use it as a
// serverless function (see vercel.json).
if (require.main === module) {
  app.listen(PORT, () => console.log(`\n  📬  InBoxer running at http://localhost:${PORT}\n`));
}

module.exports = app;
