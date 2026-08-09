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
const { createLogger, colorize, dim } = require('./log');

const log = createLogger('http');

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

  // Middleware order matters: each runs in the order registered.
  app.use(requestLogger);                                   // 1. time everything
  app.use(express.json());                                  // 2. parse JSON bodies into req.body
  app.use(express.static(path.join(config.rootDir, 'public'))); // 3. serve the dashboard

  // A Router groups the API endpoints so they can be mounted under /api below.
  const api = express.Router();

  // GET /api/tasks?status=open — the dashboard's main read.
  api.get('/tasks', async (req, res) => {
    const status = req.query.status || 'open';
    const tasks =
      status === 'all' ? await dbModule.listAllTasks() : await dbModule.listTasksByStatus(status);

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
  api.get('/stats', async (_req, res) => { // _req: unused, underscore marks it so
    res.json({ counts: await dbModule.countByStatus() });
  });

  // PATCH /api/tasks/:id — the done / snooze / drop buttons.
  api.patch('/tasks/:id', async (req, res) => {
    const id = Number(req.params.id); // URL params are strings
    const task = await dbModule.getTask(id);
    if (!task) return res.status(404).json({ error: 'not found' });

    const fields = { ...req.body }; // copy so we don't mutate the request body

    // Server-side consequences of a status change. Doing this here rather than
    // in the browser means the Telegram bot and any curl call get it too.
    if (fields.status === 'done' && task.status !== 'done') fields.completed_at = Date.now();
    if (fields.status === 'open') fields.snooze_until = null;

    // db.updateTaskFields ignores any field not on its allowlist, so a
    // malicious PATCH cannot rewrite `id` or `message_id`.
    let updated = await dbModule.updateTaskFields(id, fields);
    // A manual edit may have changed urgency/importance/due date, so the score
    // has to be recomputed from the post-update document.
    updated = await dbModule.updateTaskFields(id, { score: scoreTask(updated) });

    res.json(withoutMongoId(updated));
  });

  // DELETE /api/tasks/:id — permanent removal (the UI prefers 'dropped').
  api.delete('/tasks/:id', async (req, res) => {
    const ok = await dbModule.deleteTask(Number(req.params.id));
    // 204 = success, no body. .end() sends the response with no content.
    res.status(ok ? 204 : 404).end();
  });

  // POST /api/messages — the dashboard capture box (and handy for curl).
  // Same pipeline as Telegram, minus Telegram.
  api.post('/messages', async (req, res) => {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });

    const stored = await dbModule.insertMessage({
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
