'use strict';

// ---------------------------------------------------------------------------
// Lightweight, dependency-free rate limiting + concurrency control.
//
// Two protections for a public deployment:
//   • rateLimiter     — caps requests per IP over a time window (stops brute-forcing
//                       logins through /api/scan, and spamming the mail-sending paths).
//   • concurrencyGate — caps simultaneous in-flight heavy operations (a scan/sort can
//                       run for minutes; without this, a handful of big inboxes at once
//                       can exhaust a small instance's CPU/RAM).
//
// State is in-memory, which is correct for a single instance (how InBoxer starts). If you
// later run multiple instances, move these counters to a shared store (e.g. Redis) so the
// limits stay global rather than per-instance.
// ---------------------------------------------------------------------------

const clientIp = (req) => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';

// Fixed-window per-IP request cap. Replies 429 (with Retry-After) when exceeded.
function rateLimiter({ windowMs, max, message }) {
  const hits = new Map();   // ip -> { count, resetAt }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of hits) if (now >= e.resetAt) hits.delete(ip);
  }, windowMs);
  if (sweep.unref) sweep.unref();   // don't keep the process alive for cleanup

  return (req, res, next) => {
    const ip = clientIp(req);
    const now = Date.now();
    let e = hits.get(ip);
    if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + windowMs }; hits.set(ip, e); }
    e.count++;
    if (e.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((e.resetAt - now) / 1000))));
      return res.status(429).json({ error: message || 'Too many requests — please wait a moment and try again.' });
    }
    next();
  };
}

// Caps simultaneous in-flight operations, globally and per IP. Releases the slot when the
// response finishes or the client disconnects (so it tracks truly active work).
function concurrencyGate({ maxGlobal, maxPerIp, message }) {
  let active = 0;
  const perIp = new Map();   // ip -> active count
  return (req, res, next) => {
    const ip = clientIp(req);
    const ipActive = perIp.get(ip) || 0;
    if (active >= maxGlobal || ipActive >= maxPerIp) {
      res.setHeader('Retry-After', '15');
      return res.status(429).json({ error: message || 'The server is busy right now — please try again in a few seconds.' });
    }
    active++; perIp.set(ip, ipActive + 1);
    let released = false;
    const release = () => {
      if (released) return; released = true;
      active = Math.max(0, active - 1);
      const n = (perIp.get(ip) || 1) - 1;
      if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
    };
    res.on('finish', release);
    res.on('close', release);
    next();
  };
}

module.exports = { rateLimiter, concurrencyGate };
