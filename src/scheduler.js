'use strict';

// ---------------------------------------------------------------------------
// scheduler.js — the three things the bot says without being asked.
//
//   morning digest  your top few tasks, at an hour you choose
//   deadline nudge  an hour before something is due, once per task
//   weekly review   Sunday evening, what the week actually looked like
//
// Design notes worth knowing:
//
// • It ticks once a minute and asks "is anything owed right now?" rather than
//   setting a timer per user. One cheap indexed query beats hundreds of timers,
//   and it survives a restart with no rescheduling logic — the next tick simply
//   finds whatever is due.
//
// • "Sent already" is recorded in the database, not in memory. A restart at
//   08:00:30 must not re-send the digest that went out at 08:00:00, and an
//   in-memory flag would do exactly that.
//
// • Nothing here throws outward. A failed send is logged and the tick moves on;
//   one user's broken chat must not stop everybody else's digest.
// ---------------------------------------------------------------------------

const config = require('./config');
const dbModule = require('./db');
const { gameStats, periodSummary } = require('./stats');
const { renderSummary, startOfWeek } = require('./summary');
const { formatDuration } = require('./priority');
const { createLogger } = require('./log');

const log = createLogger('sched');

const DAY = 24 * 3600 * 1000;

/** Escape for Telegram's HTML parse mode. */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Local YYYY-MM-DD, used as the "already sent today" marker. */
function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/* --------------------------------------------------------- morning digest */

/**
 * Your day, in one message: the streak you are defending, what is overdue, and
 * the handful of things worth doing first.
 *
 * Deliberately capped at five tasks. A digest listing everything is a list, and
 * you already have a list — the value here is that somebody picked.
 */
async function buildDigest(user, now) {
  const open = await dbModule.listTasksByStatus(user.id, 'open');
  if (open.length === 0) {
    const g = await gameStats(dbModule, user.id, now);
    return `☀️ <b>Good morning</b>\n\nNothing open. 🎉\n🔥 ${g.streak}-day streak — keep it alive.`;
  }

  const overdue = open.filter((t) => t.due_at != null && t.due_at < now);
  const dueToday = open.filter((t) => t.due_at != null && t.due_at >= now && t.due_at < now + DAY);
  const g = await gameStats(dbModule, user.id, now);

  const lines = [`☀️ <b>Good morning</b>`, ''];
  lines.push(`🔥 ${g.streak}-day streak · Level ${g.level} · today's goal ${g.daily_goal}`);
  lines.push('');

  if (overdue.length > 0) {
    lines.push(`🔴 <b>${overdue.length} overdue</b>`);
    lines.push(
      ...overdue.slice(0, 3).map(
        (t) => `• <b>#${t.id}</b> ${esc(t.title)} — ${formatDuration(now - t.due_at)} late`
      )
    );
    lines.push('');
  }

  lines.push('<b>Top of the list</b>');
  lines.push(
    ...open.slice(0, 5).map((t) => {
      const star = t.requester_rank === 'senior' ? '⭐️ ' : '';
      const when = t.due_text ? ` — <i>${esc(t.due_text)}</i>` : '';
      return `${star}<b>#${t.id}</b> [${Math.round(t.score)}] ${esc(t.title)}${when}`;
    })
  );

  if (dueToday.length > 0) lines.push('', `⏰ ${dueToday.length} due later today.`);
  return lines.join('\n');
}

/* --------------------------------------------------------- deadline nudge */

/**
 * The "this is about to be late" ping.
 *
 * Sent once per task, tracked by writing nudged_at — which is also why the scan
 * query filters on nudged_at being null. Without that, every tick inside the
 * lead window would send another copy.
 */
async function nudgeText(task, now) {
  const left = formatDuration(task.due_at - now);
  const star = task.requester_rank === 'senior' ? '⭐️ ' : '';
  return [
    `⏰ <b>Due in ${left}</b>`,
    `${star}<b>#${task.id}</b> ${esc(task.title)}`,
    task.requester ? `<i>asked by ${esc(task.requester)}</i>` : null,
    '',
    `<code>/done ${task.id}</code> · <code>/snooze ${task.id}</code>`,
  ].filter(Boolean).join('\n');
}

/* ------------------------------------------------------------------- tick */

/**
 * One pass over every linked account. `send` is injected rather than imported
 * so this module has no dependency on telegram.js — which keeps the require
 * graph acyclic (telegram.js already pulls in stats and summary) and lets a
 * test capture the messages instead of sending them.
 */
async function tick(send, now = Date.now()) {
  let users;
  try {
    users = await dbModule.listUsersWithChat();
  } catch (err) {
    log.error('could not list users:', err.message);
    return;
  }

  for (const user of users) {
    try {
      await tickUser(user, send, now);
    } catch (err) {
      // One account's failure must not stop the others.
      log.error(`user #${user.id}: ${err.message}`);
    }
  }
}

async function tickUser(user, send, now) {
  const settings = dbModule.settingsOf(user);
  // A local copy that both branches below mutate, so a tick that sends the
  // digest AND the weekly review does not have the second write clobber the
  // first one's marker with a stale value.
  const marks = { ...(user.sched || {}) }; // { digest: '2026-08-11', weekly: '2026-08-09' }
  const today = dayKey(now);
  const localHour = new Date(now).getHours();

  // --- morning digest. The hour must have arrived and today must not be
  // marked yet. `>=` rather than `===` so a restart at 08:40 still sends the
  // 08:00 digest instead of skipping the day entirely.
  if (settings.digest_enabled && marks.digest !== today && localHour >= settings.digest_hour) {
    // Mark BEFORE sending. A double-send is worse than a missed one, and if the
    // send fails the user still has the app.
    marks.digest = today;
    await dbModule.updateUser(user.id, { sched: { ...marks } });
    await send(user.tg_chat_id, await buildDigest(user, now));
    log.info(`digest → #${user.id}`);
  }

  // --- weekly review. Same guard, keyed on the week's Monday so it is sent
  // once per week rather than once per day.
  const weekKey = dayKey(startOfWeek(now));
  const isWeeklyDay = new Date(now).getDay() === settings.weekly_weekday;
  if (settings.weekly_enabled && isWeeklyDay && marks.weekly !== weekKey
      && localHour >= settings.weekly_hour) {
    marks.weekly = weekKey;
    await dbModule.updateUser(user.id, { sched: { ...marks } });
    const from = startOfWeek(now);
    const data = await periodSummary(dbModule, user.id, from, now);
    await send(user.tg_chat_id, `🗓 <b>Your week</b>\n\n${renderSummary(data, 'this week')}`);
    log.info(`weekly → #${user.id}`);
  }

  // --- deadline nudges.
  if (!settings.nudge_enabled) return;
  const horizon = now + settings.nudge_lead_minutes * 60e3;
  const due = await dbModule.listTasksDueBetween(user.id, now, horizon, ['open']);
  for (const task of due) {
    if (task.nudged_at) continue; // already pinged for this one
    await dbModule.updateTaskFields(user.id, task.id, { nudged_at: now });
    await send(user.tg_chat_id, await nudgeText(task, now));
    log.info(`nudge → #${user.id} task #${task.id}`);
  }
}

/**
 * Start ticking. Returns a stop function.
 *
 * The first tick is deferred by one interval rather than run immediately: at
 * boot the database connection is fresh and the bot may not have verified its
 * token yet, and there is nothing time-critical about waiting a minute.
 */
function startScheduler(send) {
  const timer = setInterval(() => {
    tick(send).catch((err) => log.error('tick failed:', err.message));
  }, config.schedulerIntervalMs);

  // unref: this timer alone should not keep the process alive at shutdown.
  timer.unref();
  log.info(`scheduler running every ${Math.round(config.schedulerIntervalMs / 1000)}s`);
  return () => clearInterval(timer);
}

module.exports = { startScheduler, tick, buildDigest, nudgeText };
