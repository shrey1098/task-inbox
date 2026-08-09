'use strict';

// ---------------------------------------------------------------------------
// log.js — a ~40-line logger, so we don't pull in winston/pino for this.
//
// Produces lines like:
//   18:41:50.641 INFO  telegram polling as @task_me_bot
//   └ time      └ level └ scope  └ message
// ---------------------------------------------------------------------------

// Levels as numbers so they can be compared. Lower number = more severe.
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// The cutoff: a message is printed only if its level number is <= this.
// LOG_LEVEL=warn (1) therefore prints error(0) and warn(1) but drops info(2).
// `??` (nullish coalescing) supplies the default only when the lookup is
// undefined — i.e. when LOG_LEVEL holds something that isn't a level name.
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

// Only colourise when stdout is a real terminal. isTTY is false when output is
// piped to a file (`npm start > run.log`), where escape codes would be garbage.
// NO_COLOR is a cross-tool convention for disabling colour explicitly.
const color = process.stdout.isTTY && !process.env.NO_COLOR;

// Wrap a string in an ANSI colour escape: \x1b[<code>m …text… \x1b[0m (reset).
// When colour is off this returns the string untouched.
const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2;37', s); // 2 = faint, 37 = white → grey secondary text

// One colour per level: red / yellow / cyan / faint.
const STYLE = {
  error: (s) => c('1;31', s),
  warn: (s) => c('1;33', s),
  info: (s) => c('1;36', s),
  debug: (s) => c('2;37', s),
};

/** Local wall-clock time as HH:MM:SS.mmm — no date, since logs are read live. */
function stamp() {
  const d = new Date();
  // padStart pads with '0' so 9 becomes "09" and 7ms becomes "007", keeping
  // every line the same width and therefore visually aligned.
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** Format and print one line, unless its level is below the threshold. */
function emit(level, scope, args) {
  if (LEVELS[level] > threshold) return; // higher number = less severe = filtered out

  // padEnd keeps the message column aligned across levels ("INFO " vs "ERROR").
  const line = [dim(stamp()), STYLE[level](level.toUpperCase().padEnd(5)), dim(`${scope}`)].join(' ');

  // Errors go to stderr so `npm start 2> errors.log` can separate them.
  const stream = level === 'error' ? console.error : console.log;

  // Spreading `args` (rather than joining) preserves console's own formatting:
  // objects stay inspectable, and log.info('x:', err) works like console.log.
  stream(line, ...args);
}

/**
 * Build a logger bound to one subsystem name.
 *   const log = createLogger('telegram');
 *   log.info('polling as @bot');   →  … INFO  telegram polling as @bot
 */
function createLogger(scope) {
  return {
    error: (...a) => emit('error', scope, a),
    warn: (...a) => emit('warn', scope, a),
    info: (...a) => emit('info', scope, a),
    debug: (...a) => emit('debug', scope, a),
  };
}

// `colorize` and `dim` are exported so server.js can tint HTTP status codes
// using the same colour-on/off decision made here.
module.exports = { createLogger, colorize: c, dim, level: threshold };
