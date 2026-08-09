'use strict';

// Re-run the extractor over failed/pending messages: `npm run reprocess`

require('./bootstrap-net');

const dbModule = require('./db');
const { processMessage } = require('./extractor');

async function main() {
  const db = await dbModule.connect();
  const stuck = await db
    .collection('messages')
    .find({ status: { $in: ['pending', 'failed'] } })
    .sort({ id: 1 })
    .toArray();

  console.log(`${stuck.length} message(s) to reprocess`);
  for (const message of stuck) {
    const result = await processMessage(message);
    console.log(
      `#${message.id}: ${result.error ? `failed (${result.error})` : `${result.tasks.length} task(s)`}`
    );
  }
  await dbModule.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
