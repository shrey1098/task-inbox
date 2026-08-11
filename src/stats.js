'use strict';

// ---------------------------------------------------------------------------
// stats.js — the game layer: XP, levels, streaks, and period summaries.
//
// None of this is stored. Every number here is derived from the completed
// tasks themselves, which means there is no counter to drift out of sync, no
// migration when the formula changes, and no way to cheat by editing a total.
// At a few thousand tasks per account it costs one indexed query.
// ---------------------------------------------------------------------------

const DAY = 24 * 3600 * 1000;

/*
 * XP for finishing one task.
 *
 * Deliberately tied to the priority score: clearing the thing that has been
 * screaming at you should be worth more than clearing an easy one, or the game
 * would reward cherry-picking the trivial. The floor of 5 means every task is
 * still worth doing.
 */
function xpForTask(task) {
  const base = Math.max(5, Math.round((task.score ?? 0) / 4)); // 0-100 → 5-25
  return base;
}

/*
 * Levels.
 *
 * A quadratic curve: level N needs 50·N² XP in total. Early levels arrive in a
 * day or two, later ones take weeks — the standard shape, because a linear
 * curve makes progress feel identical forever.
 */
const LEVEL_BASE = 50;

function levelForXp(xp) {
  // Invert 50·N² = xp. floor(sqrt(xp/50)) + 1, so 0 XP is level 1.
  const level = Math.floor(Math.sqrt(Math.max(0, xp) / LEVEL_BASE)) + 1;
  const currentFloor = LEVEL_BASE * (level - 1) ** 2;
  const nextFloor = LEVEL_BASE * level ** 2;
  return {
    level,
    xp,
    into_level: xp - currentFloor,              // XP earned since levelling up
    level_span: nextFloor - currentFloor,       // XP the whole level is worth
    to_next: nextFloor - xp,                    // XP still needed
    // 0-1, for the progress bar.
    progress: (xp - currentFloor) / (nextFloor - currentFloor),
  };
}

/** A local YYYY-MM-DD key. Streaks are counted in local days, not UTC ones. */
function dayKey(ts) {
  const d = new Date(ts);
  // Manual formatting rather than toISOString(), which would convert to UTC and
  // put an 11pm completion on the following day for anyone east of Greenwich.
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** The local midnight that starts the day containing ts. */
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Current and best streak of consecutive days with at least one completion.
 *
 * Today not being done yet does NOT break the streak — the day is still in
 * progress. Only a *missed* day does. That distinction is the whole reason the
 * loop starts at "today or yesterday" rather than strictly today.
 */
function streakFrom(completions, now = Date.now()) {
  const days = new Set(completions.map((c) => dayKey(c.completed_at)));
  if (days.size === 0) return { current: 0, best: 0, days_active: 0, done_today: 0 };

  const todayKey = dayKey(now);
  const doneToday = completions.filter((c) => dayKey(c.completed_at) === todayKey).length;

  // Walk backwards from today. If today is empty, start from yesterday so an
  // unfinished morning does not read as a broken streak.
  let cursor = startOfDay(now);
  if (!days.has(dayKey(cursor))) cursor -= DAY;

  let current = 0;
  while (days.has(dayKey(cursor))) {
    current += 1;
    cursor -= DAY;
  }

  // Best streak: sort the active days and measure the longest consecutive run.
  const sorted = [...days].sort();
  let best = 0;
  let run = 0;
  let previous = null;
  for (const key of sorted) {
    // Parsing back to a date to test adjacency handles month and year ends,
    // which string comparison would not.
    const ts = new Date(`${key}T00:00:00`).getTime();
    run = previous != null && ts - previous === DAY ? run + 1 : 1;
    best = Math.max(best, run);
    previous = ts;
  }

  return { current, best: Math.max(best, current), days_active: days.size, done_today: doneToday };
}

/**
 * The whole game state for one account: XP, level, streak, today's progress.
 * `dbModule` is injected so this file needs no storage import and is trivial to
 * test with a fake.
 */
async function gameStats(dbModule, userId, now = Date.now()) {
  const completions = await dbModule.completionTimes(userId);
  const xp = completions.reduce((sum, c) => sum + xpForTask(c), 0);
  const streak = streakFrom(completions, now);
  const user = await dbModule.getUser(userId);
  const goal = dbModule.settingsOf(user).daily_goal;

  return {
    ...levelForXp(xp),
    streak: streak.current,
    best_streak: streak.best,
    days_active: streak.days_active,
    done_today: streak.done_today,
    daily_goal: goal,
    // Capped at 1 so the ring cannot overfill on a very productive day.
    goal_progress: goal > 0 ? Math.min(1, streak.done_today / goal) : 0,
    lifetime_done: completions.length,
  };
}

/**
 * What happened between two timestamps — the engine behind /summary, the
 * weekly review, and the "summary of any period" the dashboard asks for.
 *
 * Returns plain data. Rendering it as Telegram HTML or as JSON for the browser
 * is the caller's job, so both stay consistent with one implementation.
 */
async function periodSummary(dbModule, userId, from, to) {
  const [completed, created] = await Promise.all([
    dbModule.listTasksCompletedBetween(userId, from, to),
    dbModule.listTasksCreatedBetween(userId, from, to),
  ]);
  const open = await dbModule.listTasksByStatus(userId, 'open');

  // Overdue is measured at the END of the period, which for a past period means
  // "what was overdue by then" — the honest reading of a historical summary.
  const stillOverdue = open.filter((t) => t.due_at != null && t.due_at < Math.min(to, Date.now()));

  const byCategory = tally(completed, (t) => t.category || 'other');
  const byRequester = tally(completed.filter((t) => t.requester), (t) => t.requester);
  const dropped = created.filter((t) => t.status === 'dropped').length;

  // Busiest day, so the summary can say something a bare count cannot.
  const perDay = tally(completed, (t) => dayKey(t.completed_at));
  const busiest = perDay.sort((a, b) => b.n - a.n)[0] || null;

  const spanDays = Math.max(1, Math.round((to - from) / DAY));

  return {
    from,
    to,
    span_days: spanDays,
    completed: completed.length,
    created: created.length,
    dropped,
    still_open: open.length,
    still_overdue: stillOverdue.length,
    xp_earned: completed.reduce((sum, t) => sum + xpForTask(t), 0),
    per_day: Math.round((completed.length / spanDays) * 10) / 10,
    by_category: byCategory,
    by_requester: byRequester.slice(0, 5),
    busiest_day: busiest,
    // The three biggest things cleared — a summary should name achievements,
    // not just count them.
    highlights: [...completed].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 3)
      .map((t) => ({ id: t.id, title: t.title, score: t.score })),
    // And the thing that has been overdue longest — a summary should name what
    // still needs attention, not only what went well.
    worst_open: [...stillOverdue]
      .sort((a, b) => (a.due_at ?? 0) - (b.due_at ?? 0))
      .slice(0, 1)
      .map((t) => ({ id: t.id, title: t.title, due_at: t.due_at }))[0] || null,
  };
}

/** Count occurrences of a key across a list: [{ key, n }], biggest first. */
function tally(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => b.n - a.n);
}

module.exports = {
  xpForTask,
  levelForXp,
  streakFrom,
  gameStats,
  periodSummary,
  dayKey,
  startOfDay,
};
