'use strict';

require('./bootstrap-net');

const dbModule = require('./db');
const { startServer } = require('./server');
const { runBot } = require('./telegram');
const { processPending } = require('./extractor');

async function main() {
  await dbModule.connect();
  console.log('[db] connected');

  await startServer();

  // Anything that failed mid-flight last run gets retried on boot.
  const retried = await processPending();
  if (retried.length > 0) console.log(`[extractor] retried ${retried.length} pending message(s)`);

  if (!process.argv.includes('--no-bot')) {
    // Transient network failures are retried inside runBot; reaching here means
    // something unrecoverable (usually a bad token). Leave the dashboard up.
    runBot().catch((err) => {
      console.error(`[telegram] bot stopped: ${err.message}`);
      console.error('[telegram] dashboard is still running; fix the problem and restart.');
    });
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
