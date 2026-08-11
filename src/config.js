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

  // Set behind a reverse proxy or PaaS router, so Express reads the client's
  // real protocol and IP from X-Forwarded-* instead of seeing the proxy's.
  // Leave off when the app faces the network directly — otherwise a client
  // could spoof those headers and defeat the login rate limiter.
  trustProxy: process.env.TRUST_PROXY === 'true',

  // Open registration. The safe posture for a small private instance is to
  // leave it on, create the accounts you need, then set ALLOW_SIGNUP=false.
  allowSignup: process.env.ALLOW_SIGNUP !== 'false',

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
    // Optional extra restriction: even a correctly linked chat is ignored
    // unless it appears here. Usually left empty — accounts are the access
    // control now, and a chat can only link using a code from a signed-in user.
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

  // Speech-to-text for forwarded voice notes. The Claude API takes text and
  // images but not audio, so this is a separate provider — see transcribe.js.
  // Leave the URL unset and voice notes are refused with an explanation;
  // nothing else in the app changes.
  transcribe: {
    // Any OpenAI-compatible /audio/transcriptions endpoint — including a local
    // whisper.cpp server on the Pi later.
    url: process.env.TRANSCRIBE_URL || '',
    key: process.env.TRANSCRIBE_KEY || '',
    model: process.env.TRANSCRIBE_MODEL || 'whisper-1',
    timeoutMs: int(process.env.TRANSCRIBE_TIMEOUT_MS, 120000),
  },

  // Largest photo we will download from Telegram and keep, in bytes. Telegram
  // offers several sizes of each photo; the bot takes the biggest one under
  // this cap, so a single screenshot cannot bloat the database or the request.
  maxImageBytes: int(process.env.MAX_IMAGE_BYTES, 1500000),

  // How often the scheduler wakes to check for digests and deadline nudges.
  // A minute is fine: the checks are indexed queries and mostly find nothing.
  schedulerIntervalMs: int(process.env.SCHEDULER_INTERVAL_MS, 60000),

  // IANA timezone (e.g. "Asia/Kolkata"). Passed to the model so it can turn
  // "by Friday" into a real timestamp in YOUR local time rather than UTC.
  timezone: process.env.TIMEZONE || 'UTC',
};
