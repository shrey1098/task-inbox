'use strict';

const { MongoClient } = require('mongodb');
const config = require('./config');

let client;
let db;

/** Collections: messages, tasks, state (key/value, e.g. Telegram poll offset). */
async function connect() {
  if (db) return db;
  client = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  db = client.db(config.mongo.dbName);

  await ensureCounters();
  // Dedupe guard: Telegram redelivers updates when an offset commit is lost.
  await db.collection('messages').createIndex(
    { tg_chat_id: 1, tg_message_id: 1 },
    { unique: true, partialFilterExpression: { tg_message_id: { $type: 'number' } } }
  );
  await db.collection('messages').createIndex({ status: 1, id: 1 });
  await db.collection('tasks').createIndex({ status: 1, score: -1 });
  await db.collection('tasks').createIndex({ id: 1 }, { unique: true });
  await db.collection('state').createIndex({ key: 1 }, { unique: true });
  return db;
}

async function close() {
  if (client) await client.close();
  client = undefined;
  db = undefined;
}

/* Friendly integer ids (task #7 reads better than an ObjectId in a dashboard
 * and in bot replies), maintained via an atomic counter document. */
async function ensureCounters() {
  const counters = db.collection('counters');
  for (const name of ['messages', 'tasks']) {
    await counters.updateOne({ _id: name }, { $setOnInsert: { seq: 0 } }, { upsert: true });
  }
}

async function nextId(name) {
  const res = await db
    .collection('counters')
    .findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { returnDocument: 'after' });
  return res.seq;
}

// ---------- state ----------

async function getState(key) {
  const row = await db.collection('state').findOne({ key });
  return row ? row.value : null;
}

async function setState(key, value) {
  await db
    .collection('state')
    .updateOne({ key }, { $set: { value: String(value) } }, { upsert: true });
}

// ---------- messages ----------

/** Returns the new message doc, or null if this Telegram message was already stored. */
async function insertMessage(msg) {
  const doc = {
    id: await nextId('messages'),
    source: msg.source || 'telegram',
    tg_chat_id: msg.tg_chat_id ?? null,
    tg_message_id: msg.tg_message_id ?? null,
    text: msg.text,
    origin_name: msg.origin_name ?? null,
    origin_chat: msg.origin_chat ?? null,
    sent_at: msg.sent_at ?? null,
    received_at: msg.received_at ?? Date.now(),
    status: 'pending',
    error: null,
    raw: msg.raw ?? null,
  };
  try {
    await db.collection('messages').insertOne(doc);
    return doc;
  } catch (err) {
    if (err.code === 11000) return null; // duplicate Telegram message
    throw err;
  }
}

function getMessage(id) {
  return db.collection('messages').findOne({ id });
}

function listPendingMessages() {
  return db.collection('messages').find({ status: 'pending' }).sort({ id: 1 }).toArray();
}

async function setMessageStatus(id, status, error = null) {
  await db.collection('messages').updateOne({ id }, { $set: { status, error } });
}

// ---------- tasks ----------

async function insertTasks(messageId, tasks) {
  const now = Date.now();
  const docs = [];
  for (const t of tasks) {
    docs.push({
      id: await nextId('tasks'),
      message_id: messageId,
      title: t.title,
      details: t.details ?? null,
      requester: t.requester ?? null,
      category: t.category ?? null,
      due_at: t.due_at ?? null,
      due_text: t.due_text ?? null,
      urgency: t.urgency ?? 3,
      importance: t.importance ?? 3,
      effort_minutes: t.effort_minutes ?? null,
      score: t.score ?? 0,
      status: 'open',
      snooze_until: null,
      extractor: t.extractor ?? null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    });
  }
  if (docs.length > 0) await db.collection('tasks').insertMany(docs);
  return docs;
}

function getTask(id) {
  return db.collection('tasks').findOne({ id });
}

function listTasksByStatus(status) {
  return db.collection('tasks').find({ status }).sort({ score: -1, id: 1 }).toArray();
}

function listAllTasks() {
  return db.collection('tasks').find({}).sort({ score: -1, id: 1 }).toArray();
}

async function updateTaskFields(id, fields) {
  const allowed = [
    'title',
    'details',
    'requester',
    'category',
    'due_at',
    'due_text',
    'urgency',
    'importance',
    'effort_minutes',
    'status',
    'snooze_until',
    'completed_at',
    'score',
  ];
  const $set = { updated_at: Date.now() };
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) $set[k] = v;
  }
  const res = await db
    .collection('tasks')
    .findOneAndUpdate({ id }, { $set }, { returnDocument: 'after' });
  return res;
}

async function updateTaskScore(id, score, now = Date.now()) {
  await db.collection('tasks').updateOne({ id }, { $set: { score, updated_at: now } });
}

async function deleteTask(id) {
  const res = await db.collection('tasks').deleteOne({ id });
  return res.deletedCount > 0;
}

async function countByStatus() {
  const rows = await db
    .collection('tasks')
    .aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
    .toArray();
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
