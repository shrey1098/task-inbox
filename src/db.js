'use strict';

// ---------------------------------------------------------------------------
// db.js — every MongoDB read and write in the app lives here.
//
// Keeping storage behind this module means the rest of the code calls
// `listTasksByStatus('open')` instead of writing queries inline — so swapping
// databases, or stubbing storage in a test, only touches this file.
//
// Three collections:
//   messages — every inbound message, raw, exactly as received
//   tasks    — what the extractor found inside those messages
//   state    — small key/value scratchpad (Telegram poll offset, pinned chat)
//   counters — internal, powers the friendly integer ids (see nextId)
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');
const config = require('./config');

// Module-level handles. They start undefined and are filled in by connect().
// Because Node caches modules, every file that requires './db' shares these —
// one connection pool for the whole process, which is what the driver wants.
let client;
let db;

/**
 * Open the connection and make sure indexes exist. Safe to call more than once:
 * the `if (db)` guard makes subsequent calls a no-op returning the same handle.
 */
async function connect() {
  if (db) return db;

  // serverSelectionTimeoutMS caps how long the driver retries an unreachable
  // server before rejecting. The default is 30s, which makes a wrong
  // MONGODB_URI look like a hang; 8s fails fast with a clear error instead.
  client = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  db = client.db(config.mongo.dbName);

  await ensureCounters();

  // --- Indexes. createIndex is idempotent: creating an existing index is a
  // no-op, so it is safe (and conventional) to declare them on every startup.

  // Dedupe guard. Telegram redelivers an update if our offset commit is lost,
  // so the same message can arrive twice. A unique index makes the second
  // insert fail with code 11000, which insertMessage turns into "skip this".
  // partialFilterExpression limits the constraint to documents that actually
  // have a numeric tg_message_id — without it, every manually-captured message
  // (where the field is null) would collide with every other one.
  await db.collection('messages').createIndex(
    { tg_chat_id: 1, tg_message_id: 1 },
    { unique: true, partialFilterExpression: { tg_message_id: { $type: 'number' } } }
  );

  // Supporting indexes for the queries below. 1 = ascending, -1 = descending;
  // the order matters because an index can serve both filtering and sorting
  // only if its fields line up with the query's filter + sort.
  await db.collection('messages').createIndex({ status: 1, id: 1 });
  await db.collection('tasks').createIndex({ status: 1, score: -1 }); // listTasksByStatus
  await db.collection('tasks').createIndex({ id: 1 }, { unique: true });
  await db.collection('state').createIndex({ key: 1 }, { unique: true });

  return db;
}

/** Close the pool on shutdown so Mongo doesn't hold a dead connection open. */
async function close() {
  if (client) await client.close();
  client = undefined;
  db = undefined;
}

/*
 * Friendly integer ids.
 *
 * Mongo's native _id is an ObjectId like 507f1f77bcf86cd799439011 — fine for a
 * database, useless for a human typing "/done 7" into Telegram. So each
 * collection also carries a plain incrementing `id`, handed out by a counter
 * document. (SQL databases give you this for free with AUTOINCREMENT; Mongo
 * does not, because a global counter is a bottleneck at scale. At one message
 * every few minutes, it costs us nothing.)
 */
async function ensureCounters() {
  const counters = db.collection('counters');
  for (const name of ['messages', 'tasks']) {
    // upsert: create the doc if absent. $setOnInsert only applies on creation,
    // so restarting the app never resets an existing counter back to 0.
    await counters.updateOne({ _id: name }, { $setOnInsert: { seq: 0 } }, { upsert: true });
  }
}

/** Atomically increment a counter and return its new value. */
async function nextId(name) {
  // findOneAndUpdate is a single atomic operation: increment and read happen
  // together, so two concurrent calls can never receive the same number.
  // returnDocument: 'after' asks for the post-increment value.
  const res = await db
    .collection('counters')
    .findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { returnDocument: 'after' });
  return res.seq;
}

// ---------- state: a tiny key/value store ----------

async function getState(key) {
  const row = await db.collection('state').findOne({ key });
  return row ? row.value : null; // null means "never set"
}

async function setState(key, value) {
  // Insert-or-update in one round trip. Values are stringified so the caller
  // never has to think about types; getState's callers parse as needed.
  await db
    .collection('state')
    .updateOne({ key }, { $set: { value: String(value) } }, { upsert: true });
}

// ---------- messages ----------

/**
 * Store an inbound message. Returns the new document, or null if this exact
 * Telegram message was already stored (a duplicate delivery).
 */
async function insertMessage(msg) {
  const doc = {
    id: await nextId('messages'),
    source: msg.source || 'telegram', // 'telegram' | 'manual' (dashboard capture)
    // `??` supplies the fallback only for null/undefined — unlike `||`, it lets
    // legitimately falsy values such as 0 or "" through untouched.
    tg_chat_id: msg.tg_chat_id ?? null,
    tg_message_id: msg.tg_message_id ?? null,
    text: msg.text,
    origin_name: msg.origin_name ?? null, // who originally wrote it, if forwarded
    origin_chat: msg.origin_chat ?? null,
    sent_at: msg.sent_at ?? null,         // when it was originally sent
    received_at: msg.received_at ?? Date.now(), // when WE got it
    // pending → processed | no_task | failed. Anything left 'pending' or
    // 'failed' is retried on the next boot.
    status: 'pending',
    error: null,
    raw: msg.raw ?? null, // the untouched Telegram payload, for debugging
  };

  try {
    await db.collection('messages').insertOne(doc);
    return doc;
  } catch (err) {
    // 11000 is Mongo's duplicate-key error — here it means the unique index on
    // (tg_chat_id, tg_message_id) rejected a redelivered update. That is
    // expected, not exceptional, so we report it as null rather than throwing.
    if (err.code === 11000) return null;
    throw err; // anything else is a real failure; let it propagate
  }
}

function getMessage(id) {
  return db.collection('messages').findOne({ id });
}

function listPendingMessages() {
  // .find() returns a cursor (a lazy handle); .toArray() runs the query and
  // materialises the results. Sorting by id gives oldest-first processing.
  return db.collection('messages').find({ status: 'pending' }).sort({ id: 1 }).toArray();
}

async function setMessageStatus(id, status, error = null) {
  await db.collection('messages').updateOne({ id }, { $set: { status, error } });
}

// ---------- tasks ----------

/** Persist the tasks the extractor found in one message. */
async function insertTasks(messageId, tasks) {
  const now = Date.now(); // one timestamp for the batch, so they sort together
  const docs = [];

  // A plain for-of loop rather than .map(): nextId is async, and .map would
  // produce an array of promises with ids possibly assigned out of order.
  for (const t of tasks) {
    docs.push({
      id: await nextId('tasks'),
      message_id: messageId, // provenance: which message produced this task
      title: t.title,
      details: t.details ?? null,
      requester: t.requester ?? null,
      category: t.category ?? null,
      due_at: t.due_at ?? null,     // epoch milliseconds, or null
      due_text: t.due_text ?? null, // the original wording, e.g. "by Friday"
      urgency: t.urgency ?? 3,      // 1-5, from the model; 3 = middling
      importance: t.importance ?? 3,
      effort_minutes: t.effort_minutes ?? null,
      score: t.score ?? 0,          // 0-100, computed locally in priority.js
      status: 'open',               // open | done | snoozed | dropped
      snooze_until: null,
      extractor: t.extractor ?? null, // which model produced this
      created_at: now,
      updated_at: now,
      completed_at: null,
    });
  }

  // insertMany rejects an empty array, hence the guard.
  if (docs.length > 0) await db.collection('tasks').insertMany(docs);
  return docs;
}

function getTask(id) {
  return db.collection('tasks').findOne({ id });
}

function listTasksByStatus(status) {
  // Highest score first; id ascending breaks ties so the order is stable
  // between refreshes rather than jittering when scores are equal.
  return db.collection('tasks').find({ status }).sort({ score: -1, id: 1 }).toArray();
}

function listAllTasks() {
  return db.collection('tasks').find({}).sort({ score: -1, id: 1 }).toArray();
}

/**
 * Patch selected fields on a task and return the updated document.
 * The allowlist is the security boundary: this is reachable from the HTTP API,
 * so without it a caller could PATCH arbitrary fields — rewriting `id`,
 * inventing new ones, or overwriting `message_id` to break provenance.
 */
async function updateTaskFields(id, fields) {
  const allowed = [
    'title', 'details', 'requester', 'category',
    'due_at', 'due_text', 'urgency', 'importance', 'effort_minutes',
    'status', 'snooze_until', 'completed_at', 'score',
  ];

  const $set = { updated_at: Date.now() };
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) $set[k] = v; // silently ignore anything else
  }

  // returnDocument: 'after' gives back the post-update doc, saving a re-read.
  const res = await db
    .collection('tasks')
    .findOneAndUpdate({ id }, { $set }, { returnDocument: 'after' });
  return res;
}

/** Score-only update — used by the periodic rescore, which touches many rows. */
async function updateTaskScore(id, score, now = Date.now()) {
  await db.collection('tasks').updateOne({ id }, { $set: { score, updated_at: now } });
}

async function deleteTask(id) {
  const res = await db.collection('tasks').deleteOne({ id });
  return res.deletedCount > 0; // false = nothing matched, so the caller can 404
}

/** Counts per status, for the dashboard's stat tiles: [{status:'open', n:7}, …] */
async function countByStatus() {
  const rows = await db
    .collection('tasks')
    // An aggregation pipeline: $group collapses documents by status and $sum:1
    // counts each one. Doing it in the database avoids shipping every task to
    // Node just to count them.
    .aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
    .toArray();
  // Rename Mongo's _id (which holds the grouped value) to something readable.
  return rows.map((r) => ({ status: r._id, n: r.n }));
}

module.exports = {
  connect,
  close,
  getState,
  setState,
  insertMessage,
  getMessage,
  listPendingMessages,
  setMessageStatus,
  insertTasks,
  getTask,
  listTasksByStatus,
  listAllTasks,
  updateTaskFields,
  updateTaskScore,
  deleteTask,
  countByStatus,
};
