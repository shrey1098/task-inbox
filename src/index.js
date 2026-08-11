'use strict';

// ---------------------------------------------------------------------------
// index.js — the entry point (`npm start`). Wires the pieces together and
// controls startup and shutdown order.
//
//   config → db → http server → retry backlog → telegram bot
// ---------------------------------------------------------------------------

// FIRST import, before anything can open a socket: it changes how Node makes
// outbound connections. See bootstrap-net.js for why that is necessary.
require('./bootstrap-net');

const config = require('./config');
const dbModule = require('./db');
const { startServer } = require('./server');
const { runBot, send } = require('./telegram');
const { startScheduler } = require('./scheduler');
const { processPending } = require('./extractor');
const { createLogger } = require('./log');

const log = createLogger('app');

async function main() {
  // Echo the effective settings. When something behaves unexpectedly, the first
  // question is always "which config did it actually load?"
  log.info(`starting — model ${config.anthropic.model}, effort ${config.anthropic.effort}, tz ${config.timezone}`);

  // The database first: everything downstream needs it, and a wrong
  // MONGODB_URI should fail here with a clear message rather than later.
  await dbModule.connect();
  log.info(`mongo connected — ${config.mongo.dbName}`);

  // The dashboard before the backlog, so the UI is up while the retries run.
  await startServer();

  // Anything left 'pending' from a crash or an outage gets another attempt.
  const retried = await processPending();
  if (retried.length > 0) log.info(`retried ${retried.length} pending message(s)`);

  // `npm run server` passes --no-bot: dashboard only, no Telegram polling.
  if (process.argv.includes('--no-bot')) {
    log.info('--no-bot: Telegram polling disabled');
    return;
  }

  // Digests, deadline nudges and the weekly review. Started only when there is
  // a bot to send them through — without a token there is nowhere to deliver.
  if (config.telegram.token) startScheduler(send);

  // NOT awaited: runBot loops forever, so awaiting it would never return.
  // Transient network failures are retried inside runBot; reaching this catch
  // means something unrecoverable (usually a bad token). Log it and leave the
  // dashboard running rather than exiting — half the app still works.
  runBot().catch((err) => {
    log.error(`bot stopped: ${err.message}`);
    log.error('dashboard is still running; fix the problem and restart.');
  });
}

/** Close the Mongo connection cleanly instead of dropping it mid-flight. */
async function shutdown(signal) {
  log.info(`${signal} received — shutting down`);
  try {
    await dbModule.close();
  } catch {
    // Already closing or never opened — nothing useful to do or report.
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));   // Ctrl-C
process.on('SIGTERM', () => shutdown('SIGTERM')); // `kill`, Docker stop, systemd

// main() is async, so a rejection here would otherwise be an unhandled promise
// rejection with a much less readable trace. Exit non-zero so a supervisor
// (systemd, pm2, Docker) knows the start failed and can restart.
main().catch((err) => {
  log.error('fatal:', err);
  process.exit(1);
});
