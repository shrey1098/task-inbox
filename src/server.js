'use strict';

// ---------------------------------------------------------------------------
// server.js — the HTTP layer: serves the dashboard files and the JSON API the
// dashboard talks to.
//
// createApp() builds the app without starting it (so tests can mount it on a
// random port); startServer() is what index.js calls.
// ---------------------------------------------------------------------------

const path = require('path');
const os = require('os'); // used to discover this machine's network addresses
const express = require('express');
const config = require('./config');
const dbModule = require('./db');
const { processMessage } = require('./extractor');
const { bucketOf, explainScore, rescoreOpenTasks, scoreTask } = require('./priority');
const auth = require('./auth');
const { createLogger, colorize, dim } = require('./log');

const log = createLogger('http');

/** Files a signed-out visitor may load. Anything else redirects to the login. */
const PUBLIC_FILES = new Set(['/login.html', '/login.js', '/styles.css', '/favicon.ico']);

/** Log one line per request: method, path, status, duration. */
function requestLogger(req, res, next) {
  // hrtime.bigint is a monotonic nanosecond clock — unlike Date.now() it cannot
  // jump backwards if the system clock is adjusted mid-request.
  const started = process.hrtime.bigint();

  // Capture up front: Express rewrites req.url when dispatching into a mounted
  // router, so by the time 'finish' fires req.path is router-relative
  // ("/tasks" instead of "/api/tasks"). This bit me — the log was wrong AND the
  // level check below silently misfired.
  const { method, originalUrl } = req;

  // 'finish' fires once the response has been flushed, which is the only point
  // at which the status code and total duration are both known.
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6; // ns → ms
    const code = res.statusCode;
    // Colour by status class: 5xx red, 4xx yellow, 3xx cyan, 2xx green.
    const tint = code >= 500 ? '1;31' : code >= 400 ? '1;33' : code >= 300 ? '36' : '32';
    // The dashboard polls every 15s, so logging its CSS/JS fetches at info
    // level would bury everything else. Keep those for debug.
    const level = originalUrl.startsWith('/api') || code >= 400 ? 'info' : 'debug';
    log[level](
      `${method.padEnd(6)} ${originalUrl} ${colorize(tint, code)} ${dim(`${ms.toFixed(0)}ms`)}`
    );
  });

  next(); // hand control to the next middleware — omit this and the request hangs
}

function createApp() {
  const app = express();

  // Behind a reverse proxy (Caddy, nginx, a PaaS router) this makes req.secure
  // and req.ip reflect the ORIGINAL request rather than the proxy hop — which
  // decides whether the session cookie gets the Secure flag, and which IP the
  // login rate limiter counts against.
  if (config.trustProxy) app.set('trust proxy', 1);

  // Middleware order matters: each runs in the order registered.
  app.use(requestLogger);                    // 1. time everything
  app.use(express.json({ limit: '256kb' })); // 2. parse JSON bodies (capped — nothing here is large)
  app.use(auth.attachUser);                  // 3. set req.user from the session cookie

  // 4. Gate the app shell BEFORE static files are served, so a signed-out
  //    visitor gets the login page rather than a flash of empty dashboard.
  app.use((req, res, next) => {
    if (req.user) return next();
    if (req.path.startsWith('/api/')) return next(); // the API answers 401 itself
    if (PUBLIC_FILES.has(req.path)) return next();
    return res.redirect('/login.html');
  });

  app.use(express.static(path.join(config.rootDir, 'public'))); // 5. serve the app

  /* ------------------------------------------------------------ auth routes */

  // Mark the cookie Secure only when the original request really was HTTPS: a
  // Secure cookie is silently dropped over plain HTTP, which would make local
  // development look like a broken login.
  const isSecure = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

  app.post('/api/auth/signup', async (req, res) => {
    if (!config.allowSignup) return res.status(403).json({ error: 'sign-ups are closed' });

    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'enter a valid email address' });
    }
    // Length beats composition rules, which mostly produce predictable
    // substitutions rather than stronger passwords.
    if (password.length < 10) {
      return res.status(400).json({ error: 'password must be at least 10 characters' });
    }

    try {
      const user = await dbModule.createUser({
        email,
        password_hash: await auth.hashPassword(password),
      });
      const token = await auth.createSession(user.id, req.headers['user-agent']);
      auth.setSessionCookie(res, token, isSecure(req));
      log.info(`new account #${user.id} ${email}`);
      res.status(201).json({ email: user.email, tg_linked: false });
    } catch (err) {
      if (err.code === 11000) { // unique index on email
        return res.status(409).json({ error: 'that email is already registered' });
      }
      throw err;
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const ip = req.ip || 'unknown';
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    // Limited per IP+email, so one account's failures never lock out another
    // person on the same network. See the note in auth.js.
    if (auth.tooManyAttempts(ip, email)) {
      return res.status(429).json({ error: 'too many attempts — wait 15 minutes' });
    }
    const user = await dbModule.getUserByEmail(email);

    // The same message for "no such account" and "wrong password": telling them
    // apart would let someone enumerate which emails are registered.
    const ok = user ? await auth.verifyPassword(password, user.password_hash) : false;
    if (!ok) {
      auth.noteFailure(ip, email);
      log.warn(`failed login for ${email || '(blank)'} from ${ip}`);
      return res.status(401).json({ error: 'wrong email or password' });
    }

    auth.clearAttempts(ip, email);
    const token = await auth.createSession(user.id, req.headers['user-agent']);
    auth.setSessionCookie(res, token, isSecure(req));
    log.info(`signed in #${user.id} ${user.email}`);
    res.json({ email: user.email, tg_linked: user.tg_chat_id != null });
  });

  app.post('/api/auth/logout', async (req, res) => {
    await auth.destroySession(req.sessionToken);
    auth.clearSessionCookie(res);
    res.status(204).end();
  });

  /* --------------------------------------------------------- the task API */

  // A Router groups the API endpoints so they can be mounted under /api below.
  const api = express.Router();
  api.use(auth.requireAuth); // every route below needs a signed-in user

  // GET /api/tasks?status=open — the dashboard's main read.
  api.get('/tasks', async (req, res) => {
    const status = req.query.status || 'open';
    const uid = req.user.id; // the tenant filter — see the note at the top of db.js
    const tasks =
      status === 'all' ? await dbModule.listAllTasks(uid) : await dbModule.listTasksByStatus(uid, status);

    // One timestamp for the whole batch, so every task is judged against the
    // same "now" and the list can't be internally inconsistent.
    const now = Date.now();

    // Derived fields are computed here rather than stored, because they depend
    // on the current time — a stored `overdue` flag would go stale immediately.
    res.json(
      tasks.map((t) => ({
        ...withoutMongoId(t),
        bucket: bucketOf(t.score),          // which column it belongs in
        explanation: explainScore(t, now),  // hover text on the score meter
        overdue: t.due_at != null && t.due_at < now && t.status === 'open',
      }))
    );
  });

  // GET /api/stats — counts per status, for the stat tiles.
  api.get('/stats', async (req, res) => {
    res.json({ counts: await dbModule.countByStatus(req.user.id) });
  });

  /** Who am I — drives the account sheet and the Telegram link status. */
  api.get('/me', async (req, res) => {
    res.json({
      email: req.user.email,
      tg_linked: req.user.tg_chat_id != null,
      link_code: req.user.link_code,
    });
  });

  /**
   * Issue a one-time code the user sends to the bot as "/link ABC123", which is
   * what ties a Telegram chat to this account. It replaces the old "whoever
   * messages the bot first owns it" rule, which cannot work with more than one
   * user.
   */
  api.post('/me/link-code', async (req, res) => {
    // No I/O/0/1 in the alphabet, so a code can be read aloud or retyped
    // without ambiguity.
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = require('crypto').randomBytes(6);
    const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');

    await dbModule.updateUser(req.user.id, {
      link_code: code,
      link_code_expires: Date.now() + 15 * 60e3, // short-lived on purpose
    });
    res.json({ link_code: code, expires_in_minutes: 15 });
  });

  api.post('/me/unlink', async (req, res) => {
    await dbModule.updateUser(req.user.id, { tg_chat_id: null, link_code: null });
    res.status(204).end();
  });

  // PATCH /api/tasks/:id — the done / snooze / drop buttons.
  api.patch('/tasks/:id', async (req, res) => {
    const id = Number(req.params.id); // URL params are strings
    // Scoped read: another account's task id 404s here instead of being
    // updated, so task ids never need to be unguessable.
    const task = await dbModule.getTask(req.user.id, id);
    if (!task) return res.status(404).json({ error: 'not found' });

    const fields = { ...req.body }; // copy so we don't mutate the request body

    // Server-side consequences of a status change. Doing this here rather than
    // in the browser means the Telegram bot and any curl call get it too.
    if (fields.status === 'done' && task.status !== 'done') fields.completed_at = Date.now();
    if (fields.status === 'open') fields.snooze_until = null;

    // db.updateTaskFields ignores any field not on its allowlist, so a
    // malicious PATCH cannot rewrite `id` or `message_id`.
    let updated = await dbModule.updateTaskFields(req.user.id, id, fields);
    // A manual edit may have changed urgency/importance/due date, so the score
    // has to be recomputed from the post-update document.
    updated = await dbModule.updateTaskFields(req.user.id, id, { score: scoreTask(updated) });

    res.json(withoutMongoId(updated));
  });

  // DELETE /api/tasks/:id — permanent removal (the UI prefers 'dropped').
  api.delete('/tasks/:id', async (req, res) => {
    const ok = await dbModule.deleteTask(req.user.id, Number(req.params.id));
    // 204 = success, no body. .end() sends the response with no content.
    res.status(ok ? 204 : 404).end();
  });

  // POST /api/messages — the dashboard capture box (and handy for curl).
  // Same pipeline as Telegram, minus Telegram.
  api.post('/messages', async (req, res) => {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });

    const stored = await dbModule.insertMessage({
      user_id: req.user.id,
      source: 'manual',
      text,
      origin_name: req.body.origin_name || null,
    });
    const result = await processMessage(stored);

    // 502 (bad gateway) when the upstream model call failed — the request was
    // fine, our dependency wasn't. 201 (created) otherwise.
    res.status(result.error ? 502 : 201).json({
      message_id: stored.id,
      tasks: result.tasks.map(withoutMongoId),
      note: result.note,
      error: result.error || null,
    });
  });

  app.use('/api', api); // every route above is now prefixed with /api
  return app;
}

/**
 * Strip Mongo's internal _id before sending a document to the browser.
 * Destructuring pulls _id out and `...rest` collects everything else — a
 * concise way to omit one key.
 */
function withoutMongoId(doc) {
  const { _id, ...rest } = doc;
  return rest;
}

/** Every non-loopback IPv4 address, so we can print URLs that work from a phone. */
function lanAddresses() {
  return Object.values(os.networkInterfaces()) // { eth0: [...], lo: [...] } → [[...],[...]]
    .flat()                                    // → one flat list of interfaces
    .filter((i) => i && i.family === 'IPv4' && !i.internal) // skip IPv6 and 127.0.0.1
    .map((i) => i.address);
}

async function startServer() {
  const app = createApp();

  // Scores drift purely with the passage of time (deadlines approach, tasks
  // age), so refresh them on a timer as well as at startup.
  setInterval(() => {
    rescoreOpenTasks(dbModule)
      .then((n) => n && log.debug(`rescored ${n} task(s)`))
      // A failure here must not crash the process — an unhandled rejection in a
      // timer callback would do exactly that.
      .catch((err) => log.error('rescore failed:', err.message));
  }, 5 * 60 * 1000).unref(); // unref: this timer alone shouldn't keep Node alive

  await rescoreOpenTasks(dbModule); // run once now, so the first page load is current

  // Wrap listen's callback in a promise so index.js can `await startServer()`
  // and know the port is actually open before continuing.
  return new Promise((resolve) => {
    const server = app.listen(config.port, config.host, () => {
      log.info(`listening on ${config.host}:${config.port}`);
      log.info(`  local    http://localhost:${config.port}`);
      // Only advertise network URLs when actually bound to all interfaces.
      if (config.host === '0.0.0.0') {
        for (const addr of lanAddresses()) {
          log.info(`  network  http://${addr}:${config.port}`);
        }
      }
      resolve(server);
    });
  });
}

module.exports = { createApp, startServer };
