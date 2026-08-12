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
const { bucketOf, explainScore, rescoreOpenTasks, scoreTask, rankRequester } = require('./priority');
const { describeRule, normaliseRule, completeTask } = require('./recurrence');
const { gameStats, periodSummary, xpForTask } = require('./stats');
const { parsePeriod } = require('./summary');
const { labelFor, ratesAt, modelInfo } = require('./pricing');
const events = require('./events');
const auth = require('./auth');
const { createLogger, colorize, dim } = require('./log');

const log = createLogger('http');

/** Files a signed-out visitor may load. Anything else redirects to the login. */
const PUBLIC_FILES = new Set([
  '/login.html', '/login.js', '/styles.css', '/favicon.ico',
  // The PWA files must be reachable while signed out. A manifest or a service
  // worker that answers 302-to-login is not installable, and the browser gives
  // no useful error when it happens.
  '/manifest.webmanifest', '/sw.js',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/icons/maskable-512.png', '/icons/apple-touch-icon.png',
]);

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

/**
 * Wrap one route handler so a rejected promise becomes an Express error.
 *
 * Express 4 predates async functions: it calls the handler and ignores the
 * promise it returns. A handler that throws therefore never answers the
 * request AND raises an unhandledRejection, which on modern Node terminates
 * the process. One transient database blip would take the whole server down.
 */
const wrapHandler = (fn) => {
  if (typeof fn !== 'function') return fn; // a path string, an array, a sub-router

  // Express identifies an error handler purely by its ARITY: four parameters
  // means "call me with the error". A wrapper that always takes three silently
  // demotes it to ordinary middleware — Express then falls back to its own
  // handler and returns the stack trace to the client. That is exactly what
  // happened here the first time, and exactly what the test caught.
  if (fn.length === 4) {
    return (err, req, res, next) => {
      Promise.resolve(fn(err, req, res, next)).catch(next);
    };
  }

  // Promise.resolve() so a synchronous throw takes the same path as a rejection.
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Make every handler registered on a router async-safe, rather than relying on
 * each route being wrapped by hand — which works until somebody adds the
 * twenty-first route and forgets.
 */
function catchAsync(router) {
  for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'use']) {
    const original = router[verb].bind(router);
    router[verb] = (...args) => original(...args.map(wrapHandler));
  }
  return router;
}

/*
 * A small per-account rate limiter for the endpoints that cost real money.
 *
 * Every call to /api/messages is a Claude API request. Authentication stops a
 * stranger spending your credit, but nothing stops a stuck retry loop in a
 * page — or a careless script — from making a thousand calls a minute. This is
 * the cap that turns a runaway bill into a 429.
 */
const spend = new Map(); // userId → { n, first }
const SPEND_WINDOW_MS = 60e3;
const SPEND_MAX = 20;    // per account per minute; a person cannot type this fast

function overSpendLimit(userId) {
  const rec = spend.get(userId);
  const now = Date.now();
  if (!rec || now - rec.first > SPEND_WINDOW_MS) {
    spend.set(userId, { n: 1, first: now });
    return false;
  }
  rec.n += 1;
  return rec.n > SPEND_MAX;
}

// Same reasoning as the login limiter: sweep, or the map grows with every user
// who has ever posted a message.
setInterval(() => {
  const cutoff = Date.now() - SPEND_WINDOW_MS;
  for (const [k, rec] of spend) if (rec.first < cutoff) spend.delete(k);
}, 5 * 60e3).unref();

/**
 * The headers a browser needs in order to defend the page. No dependency:
 * these are four constant strings, and helmet would bring a tree of them.
 */
function securityHeaders(_req, res, next) {
  // Stop a browser second-guessing a declared content type — the trick behind
  // "upload a .txt that runs as script".
  res.set('x-content-type-options', 'nosniff');
  // Clickjacking. frame-ancestors in the CSP is the modern spelling; the
  // header is kept for older browsers that ignore it.
  res.set('x-frame-options', 'DENY');
  // Don't hand full URLs (which include task ids) to other origins.
  res.set('referrer-policy', 'same-origin');
  // Everything this app loads is same-origin. The one exception is the favicon,
  // which is an inline SVG data: URI. No inline <script> or <style> exists in
  // the markup, so neither needs 'unsafe-inline' — setting element.style from
  // JavaScript is CSSOM and is not covered by style-src.
  // Only over HTTPS: sending HSTS over plain HTTP is meaningless, and sending
  // it from a local dev server would pin localhost to HTTPS in your browser
  // for a year, which is a genuinely annoying thing to undo.
  if (res.req.secure || res.req.headers['x-forwarded-proto'] === 'https') {
    res.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  res.set('content-security-policy', [
    "default-src 'self'",
    "img-src 'self' data:",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '));
  next();
}

function createApp() {
  const app = express();

  // Do not advertise the framework. It is free reconnaissance for an attacker
  // deciding which exploits to try.
  app.disable('x-powered-by');

  // Behind a reverse proxy (Caddy, nginx, a PaaS router) this makes req.secure
  // and req.ip reflect the ORIGINAL request rather than the proxy hop — which
  // decides whether the session cookie gets the Secure flag, and which IP the
  // login rate limiter counts against.
  if (config.trustProxy) app.set('trust proxy', 1);

  // Every handler registered on `app` from here on is async-safe.
  catchAsync(app);

  // Middleware order matters: each runs in the order registered.
  app.use(securityHeaders);                  // 0. before anything can respond
  app.use(requestLogger);                    // 1. time everything
  app.use(express.json({ limit: '256kb' })); // 2. parse JSON bodies (capped — nothing here is large)
  app.use(auth.attachUser);                  // 3. set req.user from the session cookie

  /**
   * Liveness probe for the platform (Railway, Fly, Docker HEALTHCHECK).
   *
   * Registered BEFORE the sign-in gate below, because a health checker carries
   * no session cookie and must not be answered with a redirect to the login
   * page — the platform would read a 302 as "unhealthy" and restart the app in
   * a loop.
   *
   * It pings the database rather than just returning 200: a process that
   * cannot reach Mongo is not healthy, and reporting otherwise would keep a
   * broken deploy in the load balancer.
   */
  app.get('/healthz', async (_req, res) => {
    try {
      await dbModule.ping();
      res.json({ ok: true, uptime: Math.round(process.uptime()) });
    } catch (err) {
      log.error('health check failed:', err.message);
      res.status(503).json({ ok: false, error: 'database unreachable' });
    }
  });

  // 4. Gate the app shell BEFORE static files are served, so a signed-out
  //    visitor gets the login page rather than a flash of empty dashboard.
  app.use((req, res, next) => {
    if (req.user) return next();
    if (req.path.startsWith('/api/')) return next(); // the API answers 401 itself
    if (PUBLIC_FILES.has(req.path)) return next();
    return res.redirect('/login.html');
  });

  // The operator's monitor. A real path of its own rather than a section
  // buried in the account sheet: it is something you go and look at
  // deliberately, and a URL can be bookmarked.
  //
  // Gated here as well as on /api/usage. The API check is the one that
  // actually protects the data — the page holds no numbers of its own — but
  // serving the shell to everyone would still advertise that a cross-account
  // monitor exists, so it is withheld too.
  //
  // Both the pretty path and the underlying file are matched. The file has to
  // be listed explicitly because express.static below would otherwise serve
  // it, quietly leaving the shell reachable for anyone who guessed the name.
  app.get(['/usage', '/usage.html'], (req, res) => {
    const email = String(req.user?.email || '').toLowerCase();
    if (config.adminEmail === '' || email !== config.adminEmail) return res.redirect('/');
    res.sendFile(path.join(config.rootDir, 'public', 'usage.html'));
  });

  app.use(express.static(path.join(config.rootDir, 'public'), {
    setHeaders(res, filePath) {
      // The service worker is the one file that must always be revalidated:
      // browsers may cache it for up to 24 hours otherwise, and a phone would
      // keep running an old version of the app long after a deploy.
      if (filePath.endsWith('sw.js')) res.set('cache-control', 'no-cache');
      // The icons never change without changing name, so let them sit.
      else if (filePath.includes('/icons/')) res.set('cache-control', 'public, max-age=604800');
    },
  })); // 5. serve the app

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
    // verifyDecoy when there is no such account, so both branches take the same
    // ~80ms. Skipping the hash for a missing user is the timing leak.
    const ok = user
      ? await auth.verifyPassword(password, user.password_hash)
      : await auth.verifyDecoy(password);
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
  const api = catchAsync(express.Router());
  api.use(auth.requireAuth); // every route below needs a signed-in user

  /**
   * Gate for the one cross-account view in the app.
   *
   * isAdmin is a single email comparison rather than a flag on the user
   * document, and that is on purpose: a stored flag can be set by any code
   * path that writes a user (signup, settings, a future import), whereas this
   * cannot be granted at runtime at all — changing who is the operator means
   * changing an environment variable and restarting.
   *
   * An empty ADMIN_EMAIL disables the monitor outright rather than matching
   * every account with a blank email, which is the failure mode a naive
   * comparison would have.
   */
  const isAdmin = (user) =>
    config.adminEmail !== '' && String(user?.email || '').toLowerCase() === config.adminEmail;

  const requireAdmin = (req, res, next) => {
    if (isAdmin(req.user)) return next();
    log.warn(`non-admin ${req.user.email} asked for ${req.originalUrl}`);
    // 404, not 403 — see the note on the /usage route below.
    return res.status(404).json({ error: 'not found' });
  };

  // GET /api/tasks?status=open — the dashboard's main read.
  api.get('/tasks', async (req, res) => {
    const status = req.query.status || 'open';
    const uid = req.user.id; // the tenant filter — see the note at the top of db.js
    const tasks =
      status === 'all' ? await dbModule.listAllTasks(uid) : await dbModule.listTasksByStatus(uid, status);

    // One timestamp for the whole batch, so every task is judged against the
    // same "now" and the list can't be internally inconsistent.
    const now = Date.now();

    res.json(tasks.map((t) => decorate(t, now)));
  });

  // GET /api/tasks/:id — the detail sheet: one task plus the message it came
  // from, so "why do I have this?" is always answerable.
  api.get('/tasks/:id', async (req, res) => {
    const task = await dbModule.getTask(req.user.id, Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'not found' });

    // The message is fetched by id alone (it has no tenant filter of its own),
    // so it is checked against the task's owner before being returned.
    let message = task.message_id != null ? await dbModule.getMessage(task.message_id) : null;
    if (message && message.user_id !== req.user.id) message = null;

    res.json({
      ...decorate(task, Date.now()),
      // Only the fields the UI shows. `images` in particular is megabytes of
      // base64 and is served separately, on demand.
      source: message
        ? {
            id: message.id,
            kind: message.kind || 'text',
            text: message.text,
            transcript: message.transcript || null,
            origin_name: message.origin_name,
            origin_chat: message.origin_chat,
            sent_at: message.sent_at,
            received_at: message.received_at,
            has_image: Array.isArray(message.images) && message.images.length > 0,
          }
        : null,
    });
  });

  // GET /api/messages/:id/image — the forwarded photo itself.
  // Served as bytes rather than inlined into the JSON above so the detail sheet
  // stays small and the browser can cache the image normally.
  api.get('/messages/:id/image', async (req, res) => {
    const message = await dbModule.getMessage(Number(req.params.id));
    // The ownership check is the point of this route existing separately.
    if (!message || message.user_id !== req.user.id) return res.status(404).end();
    const image = message.images?.[0];
    if (!image) return res.status(404).end();

    res.set('content-type', image.media_type);
    // private: it is one user's forwarded message, so no shared cache may keep
    // it. immutable: a stored image never changes.
    res.set('cache-control', 'private, max-age=86400, immutable');
    res.send(Buffer.from(image.data, 'base64'));
  });

  // GET /api/search?q=deposit — the search field.
  api.get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    // Two characters minimum: one character matches most of the list and makes
    // the results useless rather than helpful.
    if (q.length < 2) return res.json([]);
    const tasks = await dbModule.searchTasks(req.user.id, q);
    const now = Date.now();
    res.json(tasks.map((t) => decorate(t, now)));
  });

  // GET /api/calendar?from=…&to=… — tasks with deadlines in a window.
  api.get('/calendar', async (req, res) => {
    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return res.status(400).json({ error: 'from and to (epoch ms) required' });
    }
    // A year is the widest window worth serving in one request; beyond that the
    // caller should page by month like the UI does.
    if (to - from > 400 * 86400e3) return res.status(400).json({ error: 'range too wide' });

    const tasks = await dbModule.listTasksDueBetween(req.user.id, from, to, ['open', 'snoozed', 'done']);
    const now = Date.now();
    res.json(tasks.map((t) => decorate(t, now)));
  });

  // GET /api/people — open work grouped by who asked for it.
  api.get('/people', async (req, res) => {
    const groups = await dbModule.groupByRequester(req.user.id);
    const seniors = dbModule.settingsOf(req.user).seniors;
    res.json(
      groups.map((g) => ({
        name: g._id,                        // null = nobody identified
        count: g.n,
        waiting: g.waiting,
        top_score: g.top_score,
        // Recomputed from the current senior list rather than trusting the
        // stored rank, so editing the list updates the view immediately.
        rank: g._id ? rankRequester(g._id, seniors) : 'unknown',
      }))
    );
  });

  // GET /api/game — level, XP, streak, today's progress.
  api.get('/game', async (req, res) => {
    res.json(await gameStats(dbModule, req.user.id));
  });

  // GET /api/summary?period=last+month  or  ?from=…&to=…
  // One endpoint for the presets and for an arbitrary range, because they are
  // the same question asked two ways.
  api.get('/summary', async (req, res) => {
    let from = Number(req.query.from);
    let to = Number(req.query.to);
    let label = 'custom range';

    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      const period = parsePeriod(req.query.period || 'this week');
      if (!period) return res.status(400).json({ error: 'unrecognised period' });
      ({ from, to } = period);
      label = period.label;
    }
    if (to <= from) return res.status(400).json({ error: 'to must be after from' });

    const data = await periodSummary(dbModule, req.user.id, from, to);
    res.json({ ...data, label });
  });

  // GET /api/stats — counts per status, for the stat tiles.
  api.get('/stats', async (req, res) => {
    res.json({ counts: await dbModule.countByStatus(req.user.id) });
  });

  /**
   * GET /api/usage?days=30 — API spend across EVERY account.
   *
   * This is the one endpoint in the app that deliberately crosses the tenancy
   * boundary, so it is the one endpoint with an authorization check beyond
   * "are you signed in": only config.adminEmail may call it. Everyone else
   * gets a 404 rather than a 403 — a 403 confirms the route exists and that
   * somebody is privileged on it, and there is no reason to tell a signed-in
   * stranger either. The same reasoning already governs cross-tenant task
   * reads, which also answer 404.
   *
   * Costs come from the stored per-call figures, not from re-pricing at read
   * time, so a switch of model — or a price change — leaves the history
   * telling the truth about what was actually charged.
   */
  api.get('/usage', requireAdmin, async (req, res) => {
    // Two different situations, deliberately handled differently: a value that
    // is not a positive number at all ("abc", "0", "-5") is not a window, so
    // it falls back to the default; a real but extreme one is clamped rather
    // than rejected, so a long window degrades to the longest allowed instead
    // of erroring — and neither can turn into a scan of all history.
    const asked = Number(req.query.days);
    const days = Number.isFinite(asked) && asked > 0 ? Math.min(Math.round(asked), 365) : 30;
    const to = Date.now();
    const from = to - days * 86400000;

    // null, explicitly: every account. Only reachable past requireAdmin.
    const [summary, recent] = await Promise.all([
      dbModule.usageSummary(null, from, to, config.timezone),
      dbModule.recentUsage(null, 25),
    ]);

    const zero = {
      calls: 0, input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0,
    };
    const overall = { ...zero, ...(summary.overall[0] ?? {}) };
    delete overall._id;

    const byModel = summary.by_model.map(({ _id, ...m }) => ({
      model: _id,
      label: labelFor(_id),
      // Flagged so the page can say "unpriced" rather than quietly showing
      // £0.00 for a model this build has never heard of.
      unpriced: modelInfo(_id).unknown === true,
      ...m,
    }));

    // Attribute the aggregated rows to people. One extra query rather than a
    // $lookup, because the account list is tiny and a join here would bind the
    // ledger's shape to the users collection for no gain.
    const ids = new Set([
      ...summary.by_user.map((u) => u._id),
      ...recent.map((r) => r.user_id),
    ]);
    const emails = new Map((await dbModule.emailsForIds(ids)).map((u) => [u.id, u.email]));
    // A deleted account leaves its spend behind — that history is real and
    // should still total, so it is labelled rather than dropped.
    const nameOf = (id) => emails.get(id) ?? `account #${id} (deleted)`;

    const byUser = summary.by_user
      .map(({ _id, ...u }) => ({ user_id: _id, email: nameOf(_id), ...u }));

    const current = config.anthropic.model;
    const rates = ratesAt(current);

    res.json({
      // Says plainly what this is looking at, so the page never has to guess
      // whether it is showing one account or all of them.
      scope: 'all-accounts',
      accounts: byUser.length,
      days,
      from,
      to,
      // Null unless the operator set both env vars — see config.display.
      display: config.display.currency && config.display.rate ? config.display : null,
      // What the next message will be charged at, so the page can project
      // forward as well as report backwards.
      current_model: {
        id: current,
        label: labelFor(current),
        input_per_mtok: rates.input,
        output_per_mtok: rates.output,
        unpriced: rates.unknown,
      },
      overall,
      by_model: byModel,
      by_day: summary.by_day.map(({ _id, ...d }) => ({ day: _id, ...d })),
      failures: summary.failures.map(({ _id, ...f }) => ({ stop_reason: _id, ...f })),
      by_user: byUser,
      recent: recent.map(({ user_id, ...r }) => ({ ...r, email: nameOf(user_id) })),
    });
  });

  /** Who am I — drives the account sheet and the Telegram link status. */
  api.get('/me', async (req, res) => {
    res.json({
      email: req.user.email,
      tg_linked: req.user.tg_chat_id != null,
      link_code: req.user.link_code,
      // Drives whether the account sheet offers the usage monitor. Purely
      // cosmetic — the endpoint enforces this itself, so a client that lies
      // to itself about this gains nothing.
      is_admin: isAdmin(req.user),
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

    // Completing goes through the shared path, which also spawns the next
    // occurrence of a recurring task. Doing it here rather than in the browser
    // means the bot and any curl call behave identically.
    if (fields.status === 'done' && task.status !== 'done') {
      const { task: done, next } = await completeTask(dbModule, req.user.id, task);
      return res.json({
        ...decorate(done, Date.now()),
        // The UI announces both: "+18 XP" and "next one is on the 18th".
        next_occurrence: next ? decorate(next, Date.now()) : null,
        game: await gameStats(dbModule, req.user.id),
      });
    }

    if (fields.status === 'open') fields.snooze_until = null;

    // --- an edit rather than a status change.
    // A recurrence rule arriving from the browser is normalised before storage,
    // so a hand-crafted PATCH cannot put a nonsense rule into the database and
    // have the scheduler trip over it later.
    if ('recurrence' in fields) {
      fields.recurrence = normaliseRule(fields.recurrence);
      fields.recurrence_text = fields.recurrence ? describeRule(fields.recurrence) : null;
    }
    // Re-rank the requester whenever it changes, so retyping a name as "CO"
    // immediately applies the authority rule.
    if ('requester' in fields) {
      fields.requester_rank = rankRequester(fields.requester, dbModule.settingsOf(req.user).seniors);
    }
    // Mark human edits, so the UI can show "edited" and the extractor's
    // judgement is never silently credited with a correction you made.
    const EDIT_FIELDS = ['title', 'details', 'due_at', 'category', 'requester',
      'urgency', 'importance', 'effort_minutes', 'notes', 'recurrence', 'waiting_on'];
    if (EDIT_FIELDS.some((f) => f in fields)) fields.edited_at = Date.now();

    // db.updateTaskFields ignores any field not on its allowlist, so a
    // malicious PATCH cannot rewrite `id` or `message_id`.
    let updated = await dbModule.updateTaskFields(req.user.id, id, fields);
    // A manual edit may have changed urgency/importance/due date, so the score
    // has to be recomputed from the post-update document.
    updated = await dbModule.updateTaskFields(req.user.id, id, { score: scoreTask(updated) });

    res.json(decorate(updated, Date.now()));
  });

  // POST /api/tasks — a task typed straight in, with no message behind it and
  // no model call. The compose box sends prose to /messages; this is the edit
  // sheet's "add manually", where you already know what you want.
  api.post('/tasks', async (req, res) => {
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title required' });

    const recurrence = normaliseRule(req.body.recurrence);
    const requester = req.body.requester ? String(req.body.requester).trim() : null;
    const spec = {
      title: title.slice(0, 500),
      details: req.body.details ? String(req.body.details).slice(0, 4000) : null,
      requester,
      requester_rank: rankRequester(requester, dbModule.settingsOf(req.user).seniors),
      category: req.body.category || 'other',
      due_at: Number.isFinite(Number(req.body.due_at)) ? Number(req.body.due_at) : null,
      due_text: req.body.due_text || (recurrence ? describeRule(recurrence) : null),
      urgency: clampInt(req.body.urgency, 1, 5, 3),
      importance: clampInt(req.body.importance, 1, 5, 3),
      effort_minutes: Number.isFinite(Number(req.body.effort_minutes))
        ? Number(req.body.effort_minutes) : null,
      waiting_on: Boolean(req.body.waiting_on),
      recurrence,
      recurrence_text: recurrence ? describeRule(recurrence) : null,
      extractor: 'manual',
    };
    spec.score = scoreTask(spec);

    // messageId null: this task has no message behind it, which the detail
    // sheet handles by simply not showing a source section.
    const [created] = await dbModule.insertTasks(req.user.id, null, [spec]);
    res.status(201).json(decorate(created, Date.now()));
  });

  /* --------------------------------------------------------- the push channel */

  /**
   * GET /api/events — a Server-Sent Events stream for this account.
   *
   * The dashboard opens one of these and stops polling. Everything it needs to
   * know ("a task arrived", "something changed elsewhere") arrives here within
   * milliseconds instead of on a fifteen-second timer.
   */
  api.get('/events', (req, res) => {
    res.set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform', // no-transform stops a proxy buffering it
      connection: 'keep-alive',
      // Nginx in particular buffers responses by default, which would hold
      // every event until the connection closed — i.e. forever.
      'x-accel-buffering': 'no',
    });
    // Send the headers now rather than waiting for the first write, so the
    // browser's EventSource fires `open` immediately.
    res.flushHeaders();
    // A comment line (": …") is ignored by the client but proves the stream is
    // alive and flushes any remaining buffer in front of us.
    res.write(': connected\n\n');

    const unsubscribe = events.subscribe(req.user.id, res);
    log.info(`sse open for #${req.user.id} (${events.countFor(req.user.id)} tab(s))`);

    // Heartbeat. Idle connections get closed by proxies, phone radios and load
    // balancers after a minute or two; a comment every 25 seconds is cheap and
    // keeps the path warm. EventSource would reconnect anyway, but a reconnect
    // storm from every sleeping phone is worth avoiding.
    const beat = setInterval(() => res.write(': beat\n\n'), 25000);

    // 'close' fires when the browser goes away — tab closed, navigation, or a
    // dropped network. Without this the interval and the subscriber leak.
    req.on('close', () => {
      clearInterval(beat);
      unsubscribe();
      log.debug(`sse closed for #${req.user.id}`);
    });
  });

  /* -------------------------------------------------------- the progress log */

  /**
   * POST /api/tasks/:id/progress — record a step.
   *
   * Append-only by design. A task with three steps behind it is not "not done",
   * and a status field cannot express that; a log can, and it also answers
   * "where had I got to?" when you come back to something a week later.
   */
  api.post('/tasks/:id/progress', async (req, res) => {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    // Long enough for a real note, short enough that the capped array cannot
    // push the document anywhere near Mongo's 16MB limit.
    if (text.length > 1000) return res.status(400).json({ error: 'keep a step under 1000 characters' });

    const updated = await dbModule.addProgress(req.user.id, Number(req.params.id), text);
    // null means no such task FOR THIS USER — the tenant filter lives in db.js.
    if (!updated) return res.status(404).json({ error: 'not found' });

    res.status(201).json(decorate(updated, Date.now()));
  });

  /** DELETE one step — for the inevitable typo, not for rewriting history. */
  api.delete('/tasks/:id/progress/:entryId', async (req, res) => {
    const updated = await dbModule.deleteProgress(
      req.user.id, Number(req.params.id), Number(req.params.entryId)
    );
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(decorate(updated, Date.now()));
  });

  /* ----------------------------------------------------------- preferences */

  api.get('/settings', async (req, res) => {
    res.json(dbModule.settingsOf(req.user));
  });

  /**
   * Merge in changed preferences. Each field is validated rather than trusted:
   * these values drive a scheduler loop, and a digest_hour of 900 or a seniors
   * list of ten thousand strings would be a self-inflicted denial of service.
   */
  api.put('/settings', async (req, res) => {
    const current = dbModule.settingsOf(req.user);
    const body = req.body || {};
    const next = { ...current };

    if (Array.isArray(body.seniors)) {
      next.seniors = body.seniors
        .map((s) => String(s).trim().slice(0, 60))
        .filter((s) => s.length >= 2)  // a single character would match everyone
        .slice(0, 25);
    }
    for (const flag of ['digest_enabled', 'nudge_enabled', 'weekly_enabled']) {
      if (flag in body) next[flag] = Boolean(body[flag]);
    }
    if ('digest_hour' in body) next.digest_hour = clampInt(body.digest_hour, 0, 23, current.digest_hour);
    if ('weekly_hour' in body) next.weekly_hour = clampInt(body.weekly_hour, 0, 23, current.weekly_hour);
    if ('weekly_weekday' in body) next.weekly_weekday = clampInt(body.weekly_weekday, 0, 6, current.weekly_weekday);
    if ('nudge_lead_minutes' in body) {
      next.nudge_lead_minutes = clampInt(body.nudge_lead_minutes, 5, 1440, current.nudge_lead_minutes);
    }
    if ('daily_goal' in body) next.daily_goal = clampInt(body.daily_goal, 1, 50, current.daily_goal);

    await dbModule.updateUser(req.user.id, { settings: next });

    // Changing the senior list re-ranks existing work, or the rule would only
    // apply to tasks that happen to arrive after you set it up.
    if (Array.isArray(body.seniors)) await rerankRequesters(req.user.id, next.seniors);

    res.json(next);
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
    // This endpoint calls the model, so it is the one that can run up a bill.
    if (overSpendLimit(req.user.id)) {
      log.warn(`#${req.user.id} hit the capture rate limit`);
      return res.status(429).json({ error: 'slow down — too many captures in a minute' });
    }

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

  /**
   * The last word on every failed request.
   *
   * Four arguments is what marks a function as Express's error handler, and it
   * must be registered after the routes. Without it Express falls back to its
   * default, which returns the stack trace in the response body whenever
   * NODE_ENV is not exactly "production" — telling anyone who can trigger an
   * error the file layout of the server.
   */
  app.use((err, req, res, next) => {
    // Headers already flushed (a streaming response, say) — hand it back to
    // Express to close the connection; there is no way to send a status now.
    if (res.headersSent) return next(err);

    // body-parser attaches a status for malformed JSON (400) and oversized
    // bodies (413). Those are the caller's fault and safe to describe.
    const status = err.status || err.statusCode || 500;

    if (status >= 500) {
      // The full detail goes to the log, where it belongs, and never to the
      // client.
      log.error(`${req.method} ${req.originalUrl} failed:`, err.stack || err.message);
      return res.status(500).json({ error: 'something went wrong' });
    }

    log.warn(`${req.method} ${req.originalUrl} rejected: ${err.message}`);
    res.status(status).json({ error: status === 413 ? 'that is too large' : 'bad request' });
  });

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

/** Parse an integer and force it into a range, falling back when unusable. */
function clampInt(value, lo, hi, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Re-rank every open task after the senior list changes, and rescore the ones
 * whose rank actually moved.
 *
 * Without this, marking someone senior would only affect tasks that arrive
 * afterwards — the twenty things they already asked for would stay buried,
 * which is precisely the situation the feature exists to fix.
 */
async function rerankRequesters(userId, seniors) {
  const open = await dbModule.listTasksByStatus(userId, 'open');
  for (const task of open) {
    const rank = rankRequester(task.requester, seniors);
    if (rank === task.requester_rank) continue; // nothing moved for this one
    const updated = await dbModule.updateTaskFields(userId, task.id, { requester_rank: rank });
    await dbModule.updateTaskFields(userId, task.id, { score: scoreTask(updated) });
  }
}

/**
 * Add the fields the browser needs but the database does not store, because
 * they depend on the current time or on logic that lives in Node.
 *
 * A stored `overdue` flag would be wrong within the hour; a stored bucket would
 * be wrong as soon as the score moved. Computing them per response, from one
 * shared `now`, keeps every task in a list judged against the same instant.
 */
function decorate(task, now) {
  return {
    ...withoutMongoId(task),
    bucket: bucketOf(task.score),          // which section it belongs in
    explanation: explainScore(task, now),  // the breakdown behind the score
    overdue: task.due_at != null && task.due_at < now && task.status === 'open',
    // How late, in ms — the UI escalates its treatment as this grows.
    overdue_by: task.due_at != null && task.due_at < now ? now - task.due_at : 0,
    repeat_text: task.recurrence ? describeRule(task.recurrence) : null,
    xp: xpForTask(task),
    // Surfaced separately so a list view can show "3 steps" without every row
    // carrying the full log.
    progress_count: (task.progress || []).length,
  };
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
