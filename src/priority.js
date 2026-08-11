'use strict';

// ---------------------------------------------------------------------------
// priority.js — turns a task's attributes into a 0-100 score.
//
// Design decision worth understanding: the MODEL judges content (how urgent,
// how important, how long, what deadline), and THIS FILE does the arithmetic.
// Scoring stays here rather than being asked of the model because:
//   • it is explainable — you can point at exactly why #7 outranks #3
//   • it is stable — the same task never scores differently on a re-run
//   • it is free — deadlines "heat up" over time without new API calls
// Want different priorities? Change the weights below; nothing else moves.
// ---------------------------------------------------------------------------

const HOUR = 3600 * 1000;   // milliseconds in an hour
const DAY = 24 * HOUR;      // milliseconds in a day

/**
 * How much pressure a deadline exerts, as 0-1.
 *
 * Deliberately a step function rather than a smooth curve: "due in 5 hours" and
 * "due in 6 hours" should feel the same, while crossing into "due today" should
 * feel like a jump. Steps model that; a linear ramp does not.
 */
function duePressure(dueAt, now) {
  if (!dueAt) return 0.15;                    // no deadline — a low baseline, not zero
  const remaining = dueAt - now;              // negative once the deadline has passed
  if (remaining <= 0) return 1.0;             // overdue — maximum pressure
  if (remaining <= 6 * HOUR) return 0.95;
  if (remaining <= DAY) return 0.85;
  if (remaining <= 3 * DAY) return 0.6;
  if (remaining <= 7 * DAY) return 0.35;
  if (remaining <= 14 * DAY) return 0.2;
  return 0.15;                                // further out than a fortnight
}

/** Clamp n into [lo, hi]. Guards against bad input reaching the arithmetic. */
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/*
 * Authority.
 *
 * A request from a CO or a senior officer is not merely "important" — it
 * outranks its own timeline. Something the boss asked for with no deadline at
 * all must not sink below a trivial errand that happens to be due today.
 *
 * Two mechanisms, because a bonus alone would not do it:
 *   • AUTHORITY_BONUS adds points, so seniority still orders within the group.
 *   • AUTHORITY_FLOOR is a minimum score, so such a task lands in P1
 *     whatever the deadline arithmetic produced.
 *
 * The floor is 70 — exactly the P1 threshold — so the rule reads as "the
 * boss's asks are always P1", with the bonus then ranking them among
 * themselves by urgency and deadline as usual.
 */
const AUTHORITY_BONUS = 18;
const AUTHORITY_FLOOR = 70;

/** True when this task came from someone the user has marked as senior. */
function isFromSenior(task) {
  return task.requester_rank === 'senior';
}

/**
 * Decide a requester's rank against the user's list of senior names.
 *
 * Substring matching in both directions on purpose: the list may hold "CO"
 * while the message says "the CO", or hold "Col. Mehta" while the forward
 * header says "Col. Mehta (Ops)". Both should match. Single-character entries
 * are ignored — they would match almost everything.
 */
function rankRequester(requester, seniors = []) {
  const name = String(requester || '').trim().toLowerCase();
  if (!name) return 'unknown';
  for (const raw of seniors) {
    const senior = String(raw || '').trim().toLowerCase();
    if (senior.length < 2) continue;
    if (name === senior || name.includes(senior) || senior.includes(name)) return 'senior';
  }
  return 'peer';
}

/**
 * The scoring formula. Four weighted components plus two nudges.
 *
 * @param task  needs urgency, importance, due_at, effort_minutes, created_at
 * @param now   injectable so tests can pin "the current time"
 */
function scoreTask(task, now = Date.now()) {
  // `??` defaults a missing value to 3 (neutral); clamp then rejects anything
  // outside 1-5, so a malformed model response can't distort the scale.
  const urgency = clamp(task.urgency ?? 3, 1, 5);
  const importance = clamp(task.importance ?? 3, 1, 5);

  // Map 1-5 onto 0-30 points. Subtracting 1 then dividing by 4 rescales
  // 1..5 → 0..1; multiplying by 30 gives the component its weight.
  // So urgency 1 contributes 0 and urgency 5 contributes the full 30.
  const urgencyPoints = ((urgency - 1) / 4) * 30;
  const importancePoints = ((importance - 1) / 4) * 30;

  // Deadline pressure carries equal weight to the other two.
  const duePoints = duePressure(task.due_at, now) * 30;

  // Quick-win bonus: among similar tasks, prefer the one that clears fast.
  // Small on purpose — it should break ties, not reorder real priorities.
  const effort = task.effort_minutes;
  let quickWin = 0;
  if (effort != null && effort <= 15) quickWin = 6;       // != null covers null AND undefined
  else if (effort != null && effort <= 60) quickWin = 3;

  // Staleness nudge: +1 point per day open, capped at 8. Without this, a task
  // with no deadline and low urgency would sit at the bottom forever.
  const createdAt = task.created_at ?? now;
  const ageDays = Math.max(0, (now - createdAt) / DAY); // max(0,…) guards clock skew
  const stalenessPoints = Math.min(8, ageDays);

  // Authority: extra points, and then a floor applied after the clamp so it
  // cannot itself be clamped away.
  const authorityPoints = isFromSenior(task) ? AUTHORITY_BONUS : 0;

  // A task where you are waiting on somebody else is not yours to do right now.
  // Nudging it down keeps the top of the list to things you can actually act
  // on, without hiding it — it still ages upward via staleness.
  const waitingPenalty = task.waiting_on ? -12 : 0;

  const raw = urgencyPoints + importancePoints + duePoints
    + quickWin + stalenessPoints + authorityPoints + waitingPenalty;

  // Clamp to 0-100 (the nudges can push past 90), then apply the authority
  // floor, then round to one decimal: ×10, round, ÷10 is the standard trick
  // for fixed-precision rounding.
  let final = clamp(raw, 0, 100);
  if (isFromSenior(task) && !task.waiting_on) final = Math.max(final, AUTHORITY_FLOOR);
  return Math.round(final * 10) / 10;
}

/*
 * Priority bands.
 *
 * P1 / P2 / P3 rather than adjectives, because the labels have to survive
 * being said out loud ("that's a P1") and because a number implies a rank in a
 * way that "Soon" does not — nobody argues about whether P1 outranks P2.
 *
 * The thresholds are where they are because the authority floor is 70: a
 * senior's request is meant to land in P1 by definition, so the P1 boundary
 * and the floor are deliberately the same number.
 */
const BANDS = [
  { key: 'p1', min: 70, name: 'P1', hint: 'Do now' },
  { key: 'p2', min: 45, name: 'P2', hint: 'This week' },
  { key: 'p3', min: 0,  name: 'P3', hint: 'Whenever' },
];

/** Which priority band a score lands in. */
function bucketOf(score) {
  // Ordered high to low, so the first match is the right one.
  return BANDS.find((b) => score >= b.min).key;
}

/**
 * A human-readable breakdown, shown on card hover and in the bot's reply, so
 * the ranking is never a black box: "urgency 4/5 · importance 5/5 · overdue".
 */
function explainScore(task, now = Date.now()) {
  const urgency = clamp(task.urgency ?? 3, 1, 5);
  const importance = clamp(task.importance ?? 3, 1, 5);
  const parts = [];
  // Listed first because it is the reason that overrides all the others.
  if (isFromSenior(task)) parts.push(`from ${task.requester || 'a senior'} — always P1`);
  parts.push(`urgency ${urgency}/5`, `importance ${importance}/5`);
  if (task.waiting_on) parts.push('waiting on someone else');

  if (task.due_at) {
    const remaining = task.due_at - now;
    parts.push(remaining <= 0 ? 'overdue' : `due in ${formatDuration(remaining)}`);
  } else {
    parts.push('no deadline');
  }
  if (task.effort_minutes != null) parts.push(`~${formatMinutes(task.effort_minutes)}`);

  return parts.join(' · ');
}

/** 45 → "45m", 120 → "2h", 90 → "1.5h" */
function formatMinutes(mins) {
  if (mins < 60) return `${mins}m`;
  const hours = mins / 60;
  // Avoid "2.0h": show a decimal only when there is a fractional part.
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/** A duration in ms → the largest sensible unit: "45m", "6h", "3d". */
function formatDuration(ms) {
  const hours = ms / HOUR;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60000))}m`; // never show "0m"
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Recompute every open task's score, and wake any snoozed task whose time has
 * come. Called at startup and every 5 minutes by the server — without it, a
 * task due tomorrow would keep yesterday's score until something else touched it.
 *
 * dbModule is passed in rather than required at the top of the file: that keeps
 * this module free of storage dependencies and makes it trivial to test with a
 * fake.
 */
async function rescoreOpenTasks(dbModule, now = Date.now()) {
  // Deliberately across all accounts: this is a timer, not a request, and every
  // user's deadlines advance at the same rate.
  const open = await dbModule.listTasksByStatusAllUsers('open');
  const snoozed = await dbModule.listTasksByStatusAllUsers('snoozed');
  let changed = 0;

  // Wake expired snoozes first, then score them in the same pass below.
  for (const task of snoozed) {
    if (task.snooze_until && task.snooze_until <= now) {
      await dbModule.updateTaskFields(task.user_id, task.id, { status: 'open', snooze_until: null });
      open.push({ ...task, status: 'open', snooze_until: null });
    }
  }

  for (const task of open) {
    const score = scoreTask(task, now);
    // Only write when the number actually moved — most passes change nothing,
    // and a no-op write is still a round trip to the database.
    if (score !== task.score) {
      await dbModule.updateTaskScore(task.id, score, now);
      changed += 1;
    }
  }
  return changed;
}

module.exports = {
  scoreTask,
  bucketOf,
  BANDS,
  explainScore,
  rescoreOpenTasks,
  formatMinutes,
  formatDuration,
  rankRequester,
  isFromSenior,
  AUTHORITY_FLOOR,
};
