'use strict';
// 'use strict' opts the file into JavaScript's stricter parsing rules: assigning
// to an undeclared variable throws instead of silently creating a global, etc.

// ---------------------------------------------------------------------------
// config.js — the single place every setting is read from.
//
// Nothing else in the codebase touches process.env directly. That means you can
// see every knob the app has by reading this one file, and a typo'd variable
// name fails here rather than deep inside some request handler.
// ---------------------------------------------------------------------------

const path = require('path'); // Node's built-in path utilities (join, resolve…)
const fs = require('fs');     // Node's built-in filesystem module

// __dirname is the directory of THIS file (…/task-inbox/src). Going up one
// level gives the project root (…/task-inbox), which we use to locate .env and
// the public/ folder. Resolving it once here means the app works no matter what
// directory you happen to run `node` from.
const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');

// Load .env into process.env if the file exists.
// process.loadEnvFile is built into Node 20.12+, so we don't need the `dotenv`
// package. The existsSync guard matters because loadEnvFile throws if the file
// is missing — and a missing .env is legitimate (you may set real environment
// variables instead, e.g. in Docker or systemd).
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

/**
 * Parse an env var as an integer, falling back when it's missing or malformed.
 * Environment variables are ALWAYS strings, so "3200" must become 3200 before
 * it can be used as a port number.
 */
function int(value, fallback) {
  const n = parseInt(value, 10); // radix 10 = interpret as decimal, never octal
  // parseInt returns NaN for undefined/"" /"abc"; Number.isFinite rejects those
  // (and also rejects Infinity), so any garbage falls back to the default.
  return Number.isFinite(n) ? n : fallback;
}

// Turn "123,456" into [123, 456] — the list of Telegram chat ids allowed to use
// the bot. Read the chain bottom-up:
//   || ''      → treat an unset variable as an empty string so .split won't throw
//   .split(',')→ ["123", " 456"]
//   .map(trim) → ["123", "456"]      (tolerate spaces after commas)
//   .filter    → drop empty strings, which is what "" and "1,,2" produce
//   .map(Number)→ [123, 456]         (Telegram chat ids are numbers)
const allowedChatIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

// The exported config object. `X || default` supplies a fallback whenever the
// variable is unset OR empty, which is the behaviour we want for all of these.
module.exports = {
  rootDir, // shorthand for `rootDir: rootDir` — used by server.js to find public/

  port: int(process.env.PORT, 3200),

  // Which network interface the web server binds to.
  // 0.0.0.0 = every interface, so other devices on your network can reach it.
  // 127.0.0.1 = loopback only, so it is reachable from this machine alone.
  host: process.env.HOST || '0.0.0.0',

  mongo: {
    // Where MongoDB lives. 127.0.0.1:27017 is the default for a local install
    // or the `docker run -p 27017:27017 mongo` container.
    uri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
    // Mongo creates the database on first write, so this need not exist yet.
    dbName: process.env.MONGODB_DB || 'task_inbox',
  },

  telegram: {
    // From @BotFather. Empty string means "no bot" — index.js checks for this
    // and starts the dashboard without polling instead of crashing.
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    // Empty list = accept the first chat that talks to the bot and pin to it.
    allowedChatIds,
    // How long Telegram holds an unanswered long-poll open before replying with
    // an empty list. Longer = fewer requests and lower latency; 30s is typical.
    pollTimeoutSeconds: int(process.env.TELEGRAM_POLL_TIMEOUT, 30),
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
    // How much reasoning the model spends per message. Extraction is a simple
    // job, so 'low' keeps it fast and cheap; raise if classifications feel off.
    effort: process.env.ANTHROPIC_EFFORT || 'low',
  },

  // IANA timezone (e.g. "Asia/Kolkata"). Passed to the model so it can turn
  // "by Friday" into a real timestamp in YOUR local time rather than UTC.
  timezone: process.env.TIMEZONE || 'UTC',
};
