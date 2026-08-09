'use strict';

require('./bootstrap-net');

const config = require('./config');
const dbModule = require('./db');
const { startServer } = require('./server');
const { runBot } = require('./telegram');
const { processPending } = require('./extractor');
const { createLogger } = require('./log');

const log = createLogger('app');

async function main() {
  log.info(`starting — model ${config.anthropic.model}, effort ${config.anthropic.effort}, tz ${config.timezone}`);

  await dbModule.connect();
  log.info(`mongo connected — ${config.mongo.dbName}`);

  await startServer();

  // Anything that failed mid-flight last run gets retried on boot.
  const retried = await processPending();
  if (retried.length > 0) log.info(`retried ${retried.length} pending message(s)`);

  if (process.argv.includes('--no-bot')) {
    log.info('--no-bot: Telegram polling disabled');
    return;
  }

  // Transient network failures are retried inside runBot; reaching here means
  // something unrecoverable (usually a bad token). Leave the dashboard up.
  runBot().catch((err) => {
    log.error(`bot stopped: ${err.message}`);
    log.error('dashboard is still running; fix the problem and restart.');
  });
}

async function shutdown(signal) {
  log.info(`${signal} received — shutting down`);
  try {
    await dbModule.close();
  } catch { /* already closing */ }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  log.error('fatal:', err);
  process.exit(1);
});
