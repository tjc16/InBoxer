'use strict';

// ---------------------------------------------------------------------------
// Microsoft OAuth 2.0 (XOAUTH2) for personal Outlook / Hotmail / Live accounts.
//
// Microsoft disabled basic auth (email + password / app password) for IMAP & SMTP
// on personal accounts in 2026, so the only way in is OAuth. This module runs the
// Authorization-Code-with-PKCE flow and mints short-lived access tokens for IMAP
// and SMTP. No tokens are stored on disk or in a server-side session: after sign-in
// the browser holds an *encrypted* blob (a "session token") that contains only the
// refresh token — it can't be read client-side, and the server exchanges it for a
// fresh access token on each request. That keeps the whole app stateless (works on
// Vercel) and consistent with InBoxer's "nothing persisted" promise.
//
// Setup (one-off): register an app at https://entra.microsoft.com → App registrations,
// allow personal Microsoft accounts, add a Web redirect URI of
// <your-origin>/auth/microsoft/callback, create a client secret, then set env vars:
//   MS_CLIENT_ID, MS_CLIENT_SECRET, and (recommended) MS_TOKEN_SECRET.
// ---------------------------------------------------------------------------

const crypto = require('crypto');

const TENANT = process.env.MS_TENANT || 'common';
const AUTH_BASE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;

// offline_access → refresh token. We use Microsoft Graph (not IMAP/SMTP) because
// Microsoft has disabled password IMAP and broken OAuth IMAP for personal mailboxes;
// Mail.ReadWrite covers reading, creating folders and moving messages, Mail.Send covers
// the mailto-unsubscribe path. Graph works for both personal and work/school accounts.
const SCOPES = [
  'openid', 'profile', 'email', 'offline_access',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
].join(' ');

function isConfigured() {
  return !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

// --- AES-256-GCM sealing, used for both the OAuth `state` and the session token ---
let _key = null;
function key() {
  if (_key) return _key;
  const secret = process.env.MS_TOKEN_SECRET;
  if (secret) {
    _key = crypto.createHash('sha256').update(secret).digest();
  } else {
    _key = crypto.randomBytes(32);
    console.warn('  ⚠️  MS_TOKEN_SECRET not set — using an ephemeral key. Microsoft sign-ins drop on restart.');
  }
  return _key;
}
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64url');
}
function open(token) {
  const raw = Buffer.from(String(token || ''), 'base64url');
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
}

function authError(message) {
  const e = new Error(message);
  e.isAuth = true; e.friendly = true;
  return e;
}

// Step 1 — build the Microsoft sign-in URL (with PKCE; the verifier rides inside the
// encrypted state so the callback can recover it without server-side storage).
function authorizeUrl(redirectUri) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state: seal({ v: verifier, t: Date.now() }),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_BASE}/authorize?${params.toString()}`;
}

async function tokenRequest(body) {
  const r = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const desc = (j.error_description || j.error || `HTTP ${r.status}`).split(/[\r\n]/)[0];
    throw authError('Microsoft sign-in failed: ' + desc);
  }
  return j;
}

function emailFromIdToken(idToken) {
  try {
    const p = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
    return p.email || p.preferred_username || p.upn || '';
  } catch (_) { return ''; }
}

// Step 2 — exchange the auth code for tokens; return an opaque session token for the
// browser plus the signed-in email address.
async function exchangeCode(code, state, redirectUri) {
  let st;
  try { st = open(state); } catch (_) { throw authError('Sign-in could not be verified. Please try again.'); }
  if (!st || !st.v || Date.now() - st.t > 10 * 60 * 1000) throw authError('Sign-in expired. Please try again.');

  const tok = await tokenRequest(new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: st.v,
    scope: SCOPES,
  }));
  if (!tok.refresh_token) throw authError('Microsoft did not return a refresh token. Check the offline_access scope and that the app allows personal accounts.');

  const email = emailFromIdToken(tok.id_token || '');
  return { sessionToken: sealSession(tok, tok.refresh_token, email), email };
}

// Build a session blob that caches the access token alongside the (rotated) refresh
// token and an expiry, so callers can reuse the access token until it actually expires.
function sealSession(tok, refreshToken, email) {
  const exp = Date.now() + (Number(tok.expires_in) || 3600) * 1000;
  return seal({ rt: refreshToken, at: tok.access_token, exp, email });
}

// Per-request — return a usable access token from the browser's session blob. Reuses the
// cached token until it's near expiry; only then does it hit Microsoft's token endpoint.
// (Refreshing on every call wastes round-trips and, on consumer accounts, trips the
// "service abuse" throttle — AADSTS70000.) On refresh we re-seal and hand back a new blob;
// the caller passes it to the browser, which updates its copy.
async function accessTokenFor(sessionToken) {
  let s;
  try { s = open(sessionToken); } catch (_) { throw authError('Your Microsoft session is no longer valid. Please sign in again.'); }

  if (s.at && s.exp && Date.now() < s.exp - 120000) {
    return { email: s.email, accessToken: s.at, sessionToken };   // cached token still good
  }

  const tok = await tokenRequest(new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: s.rt,
    scope: SCOPES,
  }));
  const email = s.email || emailFromIdToken(tok.id_token || '');
  console.log('[ms-oauth] refreshed access token for', JSON.stringify(email),
    '| token?', !!tok.access_token, '| granted scopes:', tok.scope || '(none returned)');
  return { email, accessToken: tok.access_token, sessionToken: sealSession(tok, tok.refresh_token || s.rt, email) };
}

module.exports = { isConfigured, authorizeUrl, exchangeCode, accessTokenFor };
