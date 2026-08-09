'use strict';

// ---------------------------------------------------------------------------
// migrate.js — one-off: adopt pre-multi-user data.
//
// Tasks and messages created before accounts existed have no user_id, so no
// account can see them. This assigns those orphans to one account.
//
//   npm run adopt -- you@example.com
//
// Safe to run more than once: documents that already have an owner are never
// touched, so a second run reports "0 adopted".
// ---------------------------------------------------------------------------

require('./bootstrap-net');

const dbModule = require('./db');

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npm run adopt -- you@example.com');
    process.exit(1);
  }

  const db = await dbModule.connect();
  const user = await dbModule.getUserByEmail(email);
  if (!user) {
    console.error(`No account for ${email}. Create it in the app first.`);
    process.exit(1);
  }

  // $exists:false matches only documents written before the field existed.
  const filter = { user_id: { $exists: false } };
  const tasks = await db.collection('tasks').updateMany(filter, { $set: { user_id: user.id } });
  const messages = await db.collection('messages').updateMany(filter, { $set: { user_id: user.id } });

  console.log(`Adopted ${tasks.modifiedCount} task(s) and ${messages.modifiedCount} message(s) into ${email}.`);

  // The old single-user bot pinned its chat in `state`; carry it over so the
  // Telegram link survives the upgrade instead of silently going dead.
  const pinned = await dbModule.getState('pinned_chat_id');
  if (pinned && user.tg_chat_id == null) {
    await dbModule.updateUser(user.id, { tg_chat_id: Number(pinned) });
    console.log(`Linked the previously pinned Telegram chat ${pinned} to ${email}.`);
  }

  await dbModule.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
