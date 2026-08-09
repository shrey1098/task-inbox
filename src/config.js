'use strict';

const path = require('path');
const fs = require('fs');

const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');

// Node 20.12+ ships an env-file loader, so no dotenv dependency.
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const allowedChatIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

module.exports = {
  rootDir,
  port: int(process.env.PORT, 3200),
  mongo: {
    uri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
    dbName: process.env.MONGODB_DB || 'task_inbox',
  },

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    // Empty list = accept the first chat that talks to the bot and pin to it.
    allowedChatIds,
    pollTimeoutSeconds: int(process.env.TELEGRAM_POLL_TIMEOUT, 30),
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
    effort: process.env.ANTHROPIC_EFFORT || 'low',
  },

  // Local timezone offset in minutes, used when resolving "tomorrow"/"Friday".
  timezone: process.env.TIMEZONE || 'UTC',
};
