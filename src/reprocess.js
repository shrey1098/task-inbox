'use strict';

// ---------------------------------------------------------------------------
// reprocess.js — `npm run reprocess`
//
// A one-shot maintenance script: re-runs the extractor over messages that never
// produced tasks. Useful after fixing a bug (a failed batch can be replayed
// without re-forwarding anything) or after editing the prompt (see how the new
// wording judges messages you have already sent).
//
// Every inbound message is stored verbatim, which is what makes this possible.
// ---------------------------------------------------------------------------

require('./bootstrap-net'); // same outbound-connection fix as index.js

const dbModule = require('./db');
const { processMessage } = require('./extractor');

async function main() {
  const db = await dbModule.connect();

  // Queried directly rather than through a db.js helper: this is an ad-hoc
  // maintenance query, not part of the app's normal vocabulary.
  //   pending — never attempted (crashed before the API call returned)
  //   failed  — attempted and errored (outage, truncated reply, bad SDK)
  const stuck = await db
    .collection('messages')
    .find({ status: { $in: ['pending', 'failed'] } })
    .sort({ id: 1 }) // oldest first
    .toArray();

  console.log(`${stuck.length} message(s) to reprocess`);

  // Sequential, not Promise.all: a burst of parallel API calls risks rate
  // limits, and progress printed in order is easier to read.
  for (const message of stuck) {
    const result = await processMessage(message); // never throws; reports via .error
    console.log(
      `#${message.id}: ${result.error ? `failed (${result.error})` : `${result.tasks.length} task(s)`}`
    );
  }

  // Close explicitly — otherwise the open connection keeps Node alive and the
  // script appears to hang after finishing.
  await dbModule.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1); // non-zero so a shell `&&` chain stops here
});
