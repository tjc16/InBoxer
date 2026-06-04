'use strict';

const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const express = require('express');
const imaps = require('imap-simple');
const Imap = require('imap');
const nodemailer = require('nodemailer');
const { classify } = require('./categorize');
const { generateDemoInbox } = require('./demo-data');

// Load a local .env file (if present) so secrets like MS_CLIENT_ID can live in one
// gitignored file instead of being typed on every run. Real environment variables
// (e.g. those set on Vercel) always take precedence over the file.
(function loadDotEnv() {
  try {
    const fs = require('fs');
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;                              // skip blanks and # comments
      let val = m[2].trim();
      if (/^(".*"|'.*')$/.test(val)) val = val.slice(1, -1);   // strip matching quotes
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch (_) { /* .env is optional — ignore any read/parse error */ }
})();

const msoauth = require('./ms-oauth');
const msgraph = require('./ms-graph');
const { rateLimiter, concurrencyGate } = require('./rate-limit');

const app = express();
app.set('trust proxy', 1);   // behind a host's proxy (Render etc.) — use the real client IP
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);

// --- Public-deployment guardrails (all tunable via env) ---
// Largest inbox slice a single scan will pull. Defaults to the whole inbox for local use;
// set MAX_SCAN lower in production (e.g. 30000) to protect the server and the user's browser.
const SCAN_CAP = num(process.env.MAX_SCAN, 100000);

const RL_WINDOW = 15 * 60 * 1000;   // 15-minute windows
const apiLimiter = rateLimiter({ windowMs: RL_WINDOW, max: num(process.env.RL_API_MAX, 200), message: 'Too many requests — please slow down and try again shortly.' });
const scanLimiter = rateLimiter({ windowMs: RL_WINDOW, max: num(process.env.RL_SCAN_MAX, 30), message: 'Too many scan attempts — please wait a few minutes and try again.' });
const unsubLimiter = rateLimiter({ windowMs: RL_WINDOW, max: num(process.env.RL_UNSUB_MAX, 15), message: 'Too many unsubscribe requests — please wait a few minutes.' });
// Heavy, long-running ops (scan + sort): cap how many run at once, overall and per visitor.
const heavyGate = concurrencyGate({ maxGlobal: num(process.env.MAX_CONCURRENT, 6), maxPerIp: num(process.env.MAX_CONCURRENT_PER_IP, 2) });

app.use('/api/', apiLimiter);   // gentle catch-all on every API route

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
// Donations — Stripe Checkout (server-validated amount, hosted card form)
// ---------------------------------------------------------------------------

const Stripe = require('stripe');
const DONATION_CURRENCY = (process.env.DONATION_CURRENCY || 'usd').toLowerCase();
const DONATION_MIN = 1;      // dollars
const DONATION_MAX = 999;    // dollars — sanity ceiling, never trust the client

// Lazily created so the app still boots without a key (the route returns a
// clear error instead). Keep the secret key in an env var — never in code.
let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  _stripe = new Stripe(key);
  return _stripe;
}

// Build the public origin (works locally and behind Vercel's proxy).
function publicOrigin(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (req.headers.origin) return req.headers.origin;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  return `${proto}://${req.headers.host}`;
}

app.post('/api/create-checkout-session', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Payments are not configured yet. Set STRIPE_SECRET_KEY to enable donations.' });
  }

  // Validate the amount server-side; the client value is untrusted.
  const dollars = Math.floor(Number(req.body && req.body.amount));
  if (!Number.isFinite(dollars) || dollars < DONATION_MIN || dollars > DONATION_MAX) {
    return res.status(400).json({ error: `Please choose an amount between $${DONATION_MIN} and $${DONATION_MAX}.` });
  }

  try {
    const origin = publicOrigin(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      submit_type: 'donate',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: DONATION_CURRENCY,
          unit_amount: dollars * 100,   // Stripe expects the smallest currency unit
          product_data: { name: 'Support InBoxer', description: 'A tip to help keep InBoxer free and running.' },
        },
      }],
      success_url: `${origin}/?donation=success`,
      cancel_url: `${origin}/?donation=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: (err && err.message) || 'Could not start the payment.' });
  }
});

// ---------------------------------------------------------------------------
// Microsoft OAuth (Sign in with Microsoft) for Outlook / Hotmail / Live
// ---------------------------------------------------------------------------

const msRedirectUri = (req) => `${publicOrigin(req)}/auth/microsoft/callback`;

// The front-end asks which sign-in methods are available before drawing buttons.
app.get('/api/auth/config', (req, res) => {
  res.json({ microsoft: msoauth.isConfigured(), maxScan: SCAN_CAP });
});

// Opened in a popup; bounces the user to Microsoft's consent screen.
app.get('/auth/microsoft/start', (req, res) => {
  if (!msoauth.isConfigured()) {
    return res.status(503).send('Microsoft sign-in is not configured. Set MS_CLIENT_ID and MS_CLIENT_SECRET.');
  }
  res.redirect(msoauth.authorizeUrl(msRedirectUri(req)));
});

// Microsoft redirects back here; we exchange the code and hand the browser an opaque
// session token via postMessage, then close the popup.
app.get('/auth/microsoft/callback', async (req, res) => {
  const reply = (payload) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!doctype html><meta charset="utf-8"><title>Signing in…</title>
<body style="font:15px -apple-system,Segoe UI,Roboto,sans-serif;color:#18203a;text-align:center;padding:48px">
<p>${payload.ok ? 'Signed in — you can close this window.' : 'Sign-in failed. You can close this window.'}</p>
<script>
  var payload = ${JSON.stringify(payload)};
  // Two channels: postMessage (when window.opener survives) and localStorage (which is
  // same-origin and survives Microsoft's COOP severing window.opener — the reliable one).
  try { if (window.opener) window.opener.postMessage(payload, window.location.origin); } catch (e) {}
  try { localStorage.setItem('inboxer-ms-auth', JSON.stringify(payload)); } catch (e) {}
  setTimeout(function(){ window.close(); }, payload.ok ? 400 : 2500);
</script></body>`);
  };
  try {
    if (req.query.error) throw new Error(req.query.error_description || req.query.error);
    if (!req.query.code) throw new Error('No authorization code returned.');
    const { sessionToken, email } = await msoauth.exchangeCode(String(req.query.code), String(req.query.state || ''), msRedirectUri(req));
    reply({ ok: true, type: 'ms-auth', sessionToken, email });
  } catch (err) {
    reply({ ok: false, type: 'ms-auth', error: friendlyError(err) });
  }
});

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

// Resolve a request's auth into an IMAP config (+ SMTP details). A Microsoft session
// token (`msToken`) is exchanged for a fresh access token; everything else is plain
// IMAP password auth. Returns `sessionToken` (possibly refreshed) so streaming/JSON
// handlers can hand the latest one back to the browser.
async function resolveAuth(body) {
  body = body || {};
  // Microsoft accounts go through Graph (IMAP is dead for them); everyone else is IMAP.
  if (body.msToken) {
    const { email, accessToken, sessionToken } = await msoauth.accessTokenFor(body.msToken);
    return { provider: 'graph', email, sessionToken, accessToken };
  }
  const { email, password, host, port } = body;
  if (!email || !password) { const e = new Error('Email and password are required.'); e.friendly = true; throw e; }
  return {
    provider: 'imap', email, sessionToken: null,
    imapConfig: buildImapConfig({ email, password, host, port }),
    smtp: { type: 'password', email, password },
  };
}

function buildTransport(smtp) {
  const s = detectSmtp(smtp.email);
  return nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: { user: smtp.email, pass: smtp.password } });
}

// A token provider for the Graph helpers: returns a current access token, refreshing the
// session when it nears expiry (caching makes the common case a no-op) and pushing any new
// session blob to `onSession` so long-running jobs survive token expiry mid-operation.
function graphTokenProvider(initialSession, onSession) {
  let session = initialSession;
  return async () => {
    const r = await msoauth.accessTokenFor(session);
    if (r.sessionToken !== session) { session = r.sessionToken; if (onSession) onSession(session); }
    return r.accessToken;
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

app.post('/api/scan', heavyGate, scanLimiter, async (req, res) => {
  const { limit } = req.body || {};

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  const maxScan = Math.min(Number(limit) || SCAN_CAP, SCAN_CAP);
  const BATCH = 400;
  let connection;
  try {
    const auth = await resolveAuth(req.body);
    const email = auth.email;
    if (auth.sessionToken) send({ type: 'auth', sessionToken: auth.sessionToken });

    // --- Microsoft accounts: Graph API ---
    if (auth.provider === 'graph') {
      const getToken = graphTokenProvider(auth.sessionToken, (s) => send({ type: 'auth', sessionToken: s }));
      let scanned = 0;
      await msgraph.scanInbox(getToken, maxScan, email, {
        onStart: (total, toScan) => send({ type: 'start', total: toScan, mailboxTotal: total }),
        onBatch: (raws, done, toScan) => { scanned = done; send({ type: 'batch', emails: raws.map(toEmail), scanned, total: toScan }); },
      });
      send({ type: 'done', scanned });
      return res.end();
    }

    // --- Everyone else: IMAP ---
    connection = await imaps.connect(auth.imapConfig);
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
    console.error('[scan] failed —', 'provider:', (req.body && req.body.msToken) ? 'graph' : 'imap',
      '| status:', err && err.status, '| code:', err && (err.graphCode || err.textCode), '| message:', err && err.message);
    send({ type: 'error', error: friendlyError(err) }); res.end();
  }
});

// ---------------------------------------------------------------------------
// Apply taxonomy: create nested folders & move (streams progress)
// ---------------------------------------------------------------------------

app.post('/api/apply', heavyGate, async (req, res) => {
  const { demo, parent, plan } = req.body || {};
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
  let connection;
  try {
    const auth = await resolveAuth(req.body);
    if (auth.sessionToken) send({ type: 'auth', sessionToken: auth.sessionToken });
    send({ type: 'start', totalToMove, folders: groups.length });
    let moved = 0;

    // --- Microsoft accounts: Graph API ---
    if (auth.provider === 'graph') {
      const getToken = graphTokenProvider(auth.sessionToken, (s) => send({ type: 'auth', sessionToken: s }));
      for (const g of groups) {
        const segs = [parentName, ...g.segments.map(sanitizeSeg)].filter(Boolean);
        const destId = await msgraph.ensureFolderPath(getToken, segs);
        const before = moved;
        await msgraph.moveMessages(getToken, g.uids.map(String), destId,
          (done) => send({ type: 'progress', folder: g.segments.join(' / '), moved: before + done, totalToMove }));
        moved = before + g.uids.length;
      }
      send({ type: 'done', moved, folders: groups.length, parent: parentName });
      return res.end();
    }

    // --- Everyone else: IMAP ---
    connection = await imaps.connect(auth.imapConfig);
    await connection.openBox('INBOX');
    const delim = connection.imap.delimiter || '/';
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
    console.error('[apply] failed —', 'status:', err && err.status, '| message:', err && err.message);
    send({ type: 'error', error: friendlyError(err) }); res.end();
  }
});

const sanitizeSeg = (s) => String(s || '').replace(/[/.\\]/g, ' ').replace(/\s+/g, ' ').trim();

async function ensureBoxPath(connection, segs, delim) {
  for (let i = 1; i <= segs.length; i++) {
    await ensureBox(connection, segs.slice(0, i).join(delim));
  }
}
// Creating a folder is idempotent: if it's already there, that's success, not an
// error. Providers phrase this differently — Gmail returns "[ALREADYEXISTS] Duplicate
// folder name …" (textCode + "duplicate", no "exist" in the message), others say
// "Mailbox already exists" — so we check the response code and several phrasings.
function boxAlreadyExists(err) {
  if (!err) return false;
  const code = String(err.textCode || '').toUpperCase();
  if (code === 'ALREADYEXISTS') return true;
  return /exist|alreadyexists|duplicate/i.test(err.message || '');
}
function ensureBox(connection, name) {
  return new Promise((resolve, reject) => {
    connection.imap.addBox(name, (err) => {
      if (err && !boxAlreadyExists(err)) return reject(err);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// One-click mass unsubscribe (RFC 8058 HTTP POST + GET fallback + SMTP mailto)
// ---------------------------------------------------------------------------

app.post('/api/unsubscribe', unsubLimiter, async (req, res) => {
  const { demo, targets } = req.body || {};
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
  // URL-based unsubscribes work without any auth, so a missing/invalid login here is
  // non-fatal — those mailto targets simply fall through to "manual".
  let transporter = null, fromEmail = '', graphGetToken = null;
  const needMailto = list.some((t) => !t.url && t.mailto);
  try {
    const auth = await resolveAuth(req.body);
    fromEmail = auth.email;
    if (auth.sessionToken) send({ type: 'auth', sessionToken: auth.sessionToken });
    if (needMailto) {
      if (auth.provider === 'graph') graphGetToken = graphTokenProvider(auth.sessionToken, (s) => send({ type: 'auth', sessionToken: s }));
      else { try { transporter = buildTransport(auth.smtp); } catch (_) { transporter = null; } }
    }
  } catch (_) { /* no usable credentials — continue with URL unsubscribes only */ }

  let done = 0, ok = 0, failed = 0, manual = 0;
  const queue = list.slice();
  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      let status = 'manual';
      try {
        if (t.url) status = await httpUnsub(t.url, t.oneClick);
        else if (t.mailto && graphGetToken) { await msgraph.sendMail(graphGetToken, parseMailto(t.mailto)); status = 'ok'; }
        else if (t.mailto && transporter) { await transporter.sendMail({ from: fromEmail, ...parseMailto(t.mailto) }); status = 'ok'; }
      } catch (_) { status = 'failed'; }
      done++; status === 'ok' ? ok++ : status === 'manual' ? manual++ : failed++;
      send({ type: 'progress', done, total: list.length, sender: t.sender, status });
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, list.length || 1) }, worker));
  send({ type: 'done', ok, failed, manual, total: list.length });
  res.end();
});

// --- SSRF guard for unsubscribe URLs ---------------------------------------
// Unsubscribe links come from user-supplied email headers, so the server must never be
// tricked into fetching internal targets (loopback, private LAN, or the cloud metadata
// endpoint 169.254.169.254). We reject those, and re-check every redirect hop so a public
// URL can't 30x-redirect us inward. (Residual DNS-rebinding TOCTOU risk is accepted — this
// blocks the realistic abuse vectors.)
function ipIsPrivate(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127
      || (p[0] === 169 && p[1] === 254)                 // link-local incl. cloud metadata
      || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
      || (p[0] === 192 && p[1] === 168)
      || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)    // CGNAT
      || p[0] >= 224;                                   // multicast / reserved
  }
  if (net.isIPv6(ip)) {
    const a = ip.toLowerCase();
    if (a === '::1' || a === '::') return true;
    if (/^fe[89ab]/.test(a)) return true;               // fe80::/10 link-local
    if (/^f[cd]/.test(a)) return true;                  // fc00::/7 unique-local
    const m = a.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);   // IPv4-mapped
    if (m) return ipIsPrivate(m[1]);
    return false;
  }
  return true;   // unparseable → treat as unsafe
}

async function urlIsSafe(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');       // strip IPv6 brackets
  if (net.isIP(host)) return !ipIsPrivate(host);
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (_) { return false; }
  return addrs.length > 0 && addrs.every((a) => !ipIsPrivate(a.address));
}

// fetch() that refuses internal targets and validates each redirect hop. Returns null if
// blocked or if it redirects too many times.
async function safeFetch(url, options, signal, maxRedirects = 5) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!(await urlIsSafe(current))) return null;
    const res = await fetch(current, { ...options, redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  return null;
}

async function httpUnsub(url, oneClick) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  const okStatus = (r) => r && (r.ok || r.status < 400);
  try {
    // RFC 8058 one-click: POST List-Unsubscribe=One-Click
    const post = await safeFetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    }, ctrl.signal).catch(() => null);
    if (okStatus(post)) return 'ok';
    if (oneClick) return 'failed';
    // Fallback: a plain GET to the unsubscribe link often completes it.
    const get = await safeFetch(url, { method: 'GET' }, ctrl.signal).catch(() => null);
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
  const { action, uids, folder, demo } = req.body || {};
  if (demo) return res.json({ ok: true, affected: (uids || []).length, demo: true });
  if (!action || !Array.isArray(uids) || !uids.length) return res.status(400).json({ error: 'Missing action or selection.' });
  let connection, sessionToken = null;
  try {
    const auth = await resolveAuth(req.body);
    sessionToken = auth.sessionToken;
    const uidList = uids.map(String);
    const moveSegs = () => String(folder || 'InBoxer/Sorted').split('/').map(sanitizeSeg).filter(Boolean);

    // --- Microsoft accounts: Graph API ---
    if (auth.provider === 'graph') {
      const getToken = graphTokenProvider(auth.sessionToken, (s) => { sessionToken = s; });
      if (action === 'markRead') await msgraph.setRead(getToken, uidList, true);
      else if (action === 'markUnread') await msgraph.setRead(getToken, uidList, false);
      else if (action === 'move') {
        const destId = await msgraph.ensureFolderPath(getToken, moveSegs());
        await msgraph.moveMessages(getToken, uidList, destId);
      } else return res.status(400).json({ error: `Unknown action: ${action}` });
      return res.json({ ok: true, affected: uidList.length, sessionToken });
    }

    // --- Everyone else: IMAP ---
    connection = await imaps.connect(auth.imapConfig);
    await connection.openBox('INBOX');
    const delim = connection.imap.delimiter || '/';
    if (action === 'markRead') await connection.addFlags(uidList, '\\Seen');
    else if (action === 'markUnread') await connection.delFlags(uidList, '\\Seen');
    else if (action === 'move') {
      const segs = moveSegs();
      await ensureBoxPath(connection, segs, delim);
      await connection.moveMessage(uidList, segs.join(delim));
    } else { connection.end(); return res.status(400).json({ error: `Unknown action: ${action}` }); }
    connection.end();
    res.json({ ok: true, affected: uidList.length, sessionToken });
  } catch (err) {
    if (connection) try { connection.end(); } catch (_) {}
    res.status(500).json({ error: friendlyError(err) });
  }
});

function friendlyError(err) {
  const msg = (err && err.message) || String(err);
  if (err && err.friendly) return msg;   // already a clear, user-facing message
  if (err && err.status === 401) return 'Your Microsoft sign-in has expired. Please sign in with Microsoft again.';
  if (err && err.status === 403) return 'InBoxer wasn’t granted permission for this mailbox. Sign in with Microsoft again and accept the requested permissions.';
  if (/auth|credentials|invalid|login/i.test(msg)) return 'Login failed. Gmail, Yahoo and iCloud need an "app password" (with 2FA on), not your normal password. Outlook/Hotmail no longer accept passwords at all — use the "Sign in with Microsoft" button instead.';
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
module.exports._ssrf = { ipIsPrivate, urlIsSafe };   // exposed for tests
