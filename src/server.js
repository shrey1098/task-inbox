'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const dbModule = require('./db');
const { processMessage } = require('./extractor');
const { bucketOf, explainScore, rescoreOpenTasks, scoreTask } = require('./priority');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(config.rootDir, 'public')));

  const api = express.Router();

  api.get('/tasks', async (req, res) => {
    const status = req.query.status || 'open';
    const tasks =
      status === 'all' ? await dbModule.listAllTasks() : await dbModule.listTasksByStatus(status);
    const now = Date.now();
    res.json(
      tasks.map((t) => ({
        ...withoutMongoId(t),
        bucket: bucketOf(t.score),
        explanation: explainScore(t, now),
        overdue: t.due_at != null && t.due_at < now && t.status === 'open',
      }))
    );
  });

  api.get('/stats', async (_req, res) => {
    res.json({ counts: await dbModule.countByStatus() });
  });

  api.patch('/tasks/:id', async (req, res) => {
    const id = Number(req.params.id);
    const task = await dbModule.getTask(id);
    if (!task) return res.status(404).json({ error: 'not found' });

    const fields = { ...req.body };
    if (fields.status === 'done' && task.status !== 'done') fields.completed_at = Date.now();
    if (fields.status === 'open') fields.snooze_until = null;

    let updated = await dbModule.updateTaskFields(id, fields);
    // Priority inputs may have changed — recompute.
    updated = await dbModule.updateTaskFields(id, { score: scoreTask(updated) });
    res.json(withoutMongoId(updated));
  });

  api.delete('/tasks/:id', async (req, res) => {
    const ok = await dbModule.deleteTask(Number(req.params.id));
    res.status(ok ? 204 : 404).end();
  });

  // Manual capture from the dashboard (or curl) without going through Telegram.
  api.post('/messages', async (req, res) => {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });

    const stored = await dbModule.insertMessage({
      source: 'manual',
      text,
      origin_name: req.body.origin_name || null,
    });
    const result = await processMessage(stored);
    res.status(result.error ? 502 : 201).json({
      message_id: stored.id,
      tasks: result.tasks.map(withoutMongoId),
      note: result.note,
      error: result.error || null,
    });
  });

  app.use('/api', api);
  return app;
}

function withoutMongoId(doc) {
  const { _id, ...rest } = doc;
  return rest;
}

async function startServer() {
  const app = createApp();

  // Deadlines march on even when nothing changes in the DB.
  setInterval(() => {
    rescoreOpenTasks(dbModule).catch((err) => console.error('[rescore]', err.message));
  }, 5 * 60 * 1000).unref();
  await rescoreOpenTasks(dbModule);

  return new Promise((resolve) => {
    const server = app.listen(config.port, () => {
      console.log(`[server] dashboard on http://localhost:${config.port}`);
      resolve(server);
    });
  });
}

module.exports = { createApp, startServer };
