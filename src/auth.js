'use strict';

// ---------------------------------------------------------------------------
// auth.js — passwords, sessions, and the Express middleware that guards the API.
//
// Deliberately dependency-free: Node's crypto module provides everything needed
// (scrypt for hashing, randomBytes for tokens, timingSafeEqual for comparison),
// so there is no bcrypt native build to go wrong on a deploy.
//
// Two rules this file exists to enforce:
//   1. A plaintext password is never stored, logged, or compared with ===.
//   2. A session token is never stored in the database in a usable form — only
//      its SHA-256 hash, so a leaked database dump cannot be replayed as logins.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const { promisify } = require('util');
const dbModule = require('./db');
const { createLogger } = require('./log');

const log = createLogger('auth');
const scrypt = promisify(crypto.scrypt);

// scrypt cost parameters. N=16384 keeps a single hash around 50-100ms, which is
// slow enough to make offline brute force expensive and fast enough that a
// login does not feel sluggish.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const SESSION_DAYS = 30;
const COOKIE = 'ti_session';

/* ------------------------------------------------------------- passwords */

/** Hash a password with a fresh random salt. Returns "salt:hash", both hex. */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

/**
 * A real scrypt hash of nothing in particular.
 *
 * Used when the email does not exist, so that branch costs the same as a wrong
 * password. Without it an unknown account answers in about a millisecond while
 * a real one takes ~80ms verifying the hash, and that gap is a reliable oracle
 * for "does this account exist" — the identical error message achieves nothing
 * if the clock gives the answer away.
 */
let decoyHash = null;
async function verifyDecoy(password) {
  // Built once, lazily, so startup does not pay for it.
  if (!decoyHash) decoyHash = await hashPassword('a password nobody has');
  try {
    await verifyPassword(password, decoyHash);
  } catch {
    // The result is discarded either way; this exists only to burn the time.
  }
  return false;
}

/**
 * Check a password against a stored "salt:hash".
 *
 * timingSafeEqual compares in constant time. A plain === would return as soon
 * as two bytes differ, and that timing difference is measurable over many
 * attempts — enough to recover a hash byte by byte.
 */
async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltHex, keyHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, salt, expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

/* -------------------------------------------------------------- sessions */

/** Hash a session token for storage. Fast (unlike scrypt) — tokens are already
 *  high-entropy random, so there is nothing to brute force. */
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Issue a new session and return the raw token to put in a cookie. */
async function createSession(userId, userAgent) {
  // 32 random bytes = 256 bits of entropy; guessing one is not feasible.
  const token = crypto.randomBytes(32).toString('base64url');
  await dbModule.insertSession({
    token_hash: tokenHash(token),
    user_id: userId,
    created_at: Date.now(),
    expires_at: Date.now() + SESSION_DAYS * 86400e3,
    user_agent: (userAgent || '').slice(0, 200),
  });
  return token;
}

async function destroySession(token) {
  if (token) await dbModule.deleteSession(tokenHash(token));
}

/** Resolve a raw token to its user, or null. Expired sessions are cleaned up. */
async function userForToken(token) {
  if (!token) return null;
  const session = await dbModule.findSession(tokenHash(token));
  if (!session) return null;
  if (session.expires_at < Date.now()) {
    await dbModule.deleteSession(session.token_hash);
    return null;
  }
  return dbModule.getUser(session.user_id);
}

/* --------------------------------------------------------------- cookies */

/**
 * Parse the Cookie header. Express does not do this without cookie-parser, and
 * the format is simple enough ("a=1; b=2") not to warrant the dependency.
 */
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token, secure) {
  res.cookie(COOKIE, token, {
    httpOnly: true,   // unreadable from JavaScript, so XSS cannot steal it
    sameSite: 'lax',  // not sent on cross-site POSTs — the CSRF mitigation here
    secure,           // HTTPS only; disabled in local dev or the cookie is dropped
    maxAge: SESSION_DAYS * 86400e3,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

/* ------------------------------------------------------ rate limiting */

// In-memory failed-login counters. Reset on restart, which is fine: they exist
// to slow down online guessing, not to be an audit log. (A multi-process
// deployment would need this in Mongo instead.)
//
// TWO counters, deliberately:
//   • per IP+email — the tight one. Stops guessing at a specific account.
//   • per IP alone — a looser cap, so someone cannot dodge the first by
//     spraying one guess each across many different email addresses.
//
// Keying the tight limit on the pair rather than the IP alone matters as soon
// as the app is multi-user: everyone in a household, an office, or behind a
// reverse proxy shares one IP, and a per-IP lock would let one person's typo
// lock out everybody else.
const attempts = new Map();
const MAX_PER_ACCOUNT = 8;
const MAX_PER_IP = 40;
const WINDOW_MS = 15 * 60e3;

/** Read a counter, treating an expired window as absent. */
function current(key) {
  const rec = attempts.get(key);
  if (!rec) return 0;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(key); return 0; }
  return rec.n;
}

function bump(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) attempts.set(key, { n: 1, first: Date.now() });
  else rec.n += 1;
}

/*
 * Prune expired counters.
 *
 * current() only forgets a key when that exact key is looked up again, so an
 * attacker cycling through fresh email addresses would add an entry per guess
 * and never revisit any of them — a slow memory leak that is also a denial of
 * service. A sweep on a timer bounds it.
 */
const PRUNE_EVERY_MS = 5 * 60e3;
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, rec] of attempts) if (rec.first < cutoff) attempts.delete(key);
  // unref below means this timer never keeps the process alive on its own.
}, PRUNE_EVERY_MS).unref();

function tooManyAttempts(ip, email = '') {
  return current(`${ip}|${email}`) >= MAX_PER_ACCOUNT || current(`ip:${ip}`) >= MAX_PER_IP;
}

function noteFailure(ip, email = '') {
  bump(`${ip}|${email}`);
  bump(`ip:${ip}`);
}

/** Clear the per-account counter on a successful sign-in. The IP-wide counter
 *  is deliberately left alone — a success should not reset a spraying budget. */
const clearAttempts = (ip, email = '') => attempts.delete(`${ip}|${email}`);

/* ------------------------------------------------------------ middleware */

/**
 * Attach req.user when a valid session cookie is present. Always calls next() —
 * this only identifies the caller; requireAuth is what refuses anonymous ones.
 */
async function attachUser(req, _res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.sessionToken = token;
    req.user = await userForToken(token);
  } catch (err) {
    log.error('session lookup failed:', err.message);
    req.user = null;
  }
  next();
}

/** Refuse the request unless a user is signed in. */
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not signed in' });
  next();
}

module.exports = {
  COOKIE,
  hashPassword,
  verifyPassword,
  verifyDecoy,
  createSession,
  destroySession,
  userForToken,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  tooManyAttempts,
  noteFailure,
  clearAttempts,
  attemptsSize: () => attempts.size,
  attachUser,
  requireAuth,
};
