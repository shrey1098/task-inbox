'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const color = process.stdout.isTTY && !process.env.NO_COLOR;

const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2;37', s);

const STYLE = {
  error: (s) => c('1;31', s),
  warn: (s) => c('1;33', s),
  info: (s) => c('1;36', s),
  debug: (s) => c('2;37', s),
};

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function emit(level, scope, args) {
  if (LEVELS[level] > threshold) return;
  const line = [dim(stamp()), STYLE[level](level.toUpperCase().padEnd(5)), dim(`${scope}`)].join(' ');
  const stream = level === 'error' ? console.error : console.log;
  stream(line, ...args);
}

/** createLogger('telegram').info('polling as @bot') */
function createLogger(scope) {
  return {
    error: (...a) => emit('error', scope, a),
    warn: (...a) => emit('warn', scope, a),
    info: (...a) => emit('info', scope, a),
    debug: (...a) => emit('debug', scope, a),
  };
}

module.exports = { createLogger, colorize: c, dim, level: threshold };
