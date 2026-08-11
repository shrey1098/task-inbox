'use strict';

// ---------------------------------------------------------------------------
// recurrence.js — "every Tuesday" handling.
//
// The model reads the wording and returns a small rule object; this file does
// the date arithmetic. Same split as priority.js, for the same reason: dates
// are exactly the kind of thing a language model gets subtly wrong and plain
// code gets right every time.
//
// A recurring task is NOT a template that quietly generates rows forever. One
// occurrence exists at a time, and completing it spawns the next. That means:
//   • your list never fills with fifty future copies of the same chore
//   • skipping a week does not leave a pile of overdue ghosts
//   • the chain is inspectable — each occurrence records its parent
// ---------------------------------------------------------------------------

const { scoreTask } = require('./priority');

const DAY = 24 * 3600 * 1000;

/** The rule shapes we accept. Anything else is treated as "not recurring". */
const FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'yearly']);

/**
 * Validate and normalise a rule object coming from the model or from an edit.
 * Returns null for anything unusable, which callers treat as "no recurrence" —
 * a bad rule must never become an exception on the ingest path.
 */
function normaliseRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const freq = String(rule.freq || '').toLowerCase();
  if (!FREQUENCIES.has(freq)) return null;

  // interval 1 = "every week", 2 = "every other week". Capped at 52 so a
  // nonsense value cannot produce a date centuries away.
  const interval = Math.min(52, Math.max(1, parseInt(rule.interval, 10) || 1));

  const out = { freq, interval };

  // weekday 0-6 (Sunday = 0), only meaningful for a weekly rule.
  if (freq === 'weekly') {
    const wd = parseInt(rule.weekday, 10);
    out.weekday = Number.isInteger(wd) && wd >= 0 && wd <= 6 ? wd : null;
  }
  // monthday 1-31, only meaningful for a monthly rule.
  if (freq === 'monthly') {
    const md = parseInt(rule.monthday, 10);
    out.monthday = Number.isInteger(md) && md >= 1 && md <= 31 ? md : null;
  }
  // An optional end date, as epoch ms. After it, the chain stops.
  const until = parseInt(rule.until, 10);
  out.until = Number.isFinite(until) && until > 0 ? until : null;

  return out;
}

/**
 * The next occurrence after `from`.
 *
 * `from` is the occurrence being completed — its due date if it had one, else
 * the moment it was ticked. Advancing from the DUE date rather than from "now"
 * is what keeps a weekly chore on its weekday even when you do it two days
 * late; advancing from now would let the schedule drift later and later.
 */
function nextOccurrence(rule, from, now = Date.now()) {
  const r = normaliseRule(rule);
  if (!r) return null;

  const base = new Date(from);
  let next;

  switch (r.freq) {
    case 'daily':
      next = new Date(base.getTime() + r.interval * DAY);
      break;

    case 'weekly': {
      next = new Date(base.getTime() + r.interval * 7 * DAY);
      // If the rule names a weekday and drift has crept in (because the base
      // date was edited by hand), snap forward onto that weekday.
      if (r.weekday != null && next.getDay() !== r.weekday) {
        const delta = (r.weekday - next.getDay() + 7) % 7;
        next = new Date(next.getTime() + delta * DAY);
      }
      break;
    }

    case 'monthly': {
      next = new Date(base);
      // Move to the 1st BEFORE changing the month. setMonth keeps the day
      // number, so going from the 31st of January to "February" silently rolls
      // over into March — and then any clamping is applied to the wrong month.
      // Parking on the 1st makes the month arithmetic exact.
      const wantedDay = r.monthday ?? base.getDate();
      next.setDate(1);
      next.setMonth(next.getMonth() + r.interval);
      // Clamp to the length of the target month, so "the 31st" becomes the 28th
      // in February. Day 0 of the following month is the last day of this one.
      const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(wantedDay, lastDay));
      break;
    }

    case 'yearly':
      next = new Date(base);
      next.setFullYear(next.getFullYear() + r.interval);
      break;

    default:
      return null;
  }

  // Catch-up: if the task was left undone for several cycles, keep advancing
  // until the next occurrence is actually in the future. Otherwise completing a
  // month-old weekly chore would immediately produce another overdue one.
  // Bounded at 500 iterations so a pathological rule cannot spin forever.
  let guard = 0;
  while (next.getTime() <= now && guard < 500) {
    const advanced = nextOccurrence(r, next.getTime(), 0); // 0 = don't recurse on catch-up
    if (!advanced) break;
    next = new Date(advanced);
    guard += 1;
  }

  if (r.until && next.getTime() > r.until) return null; // the series has ended
  return next.getTime();
}

/** A rule as a short phrase, for the UI: "every 2 weeks on Tuesday". */
function describeRule(rule) {
  const r = normaliseRule(rule);
  if (!r) return null;

  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[r.freq];
  // "every day" reads better than "every 1 days".
  const every = r.interval === 1 ? `every ${unit}` : `every ${r.interval} ${unit}s`;

  if (r.freq === 'weekly' && r.weekday != null) return `${every} on ${days[r.weekday]}`;
  if (r.freq === 'monthly' && r.monthday != null) return `${every} on the ${ordinal(r.monthday)}`;
  return every;
}

/** 1 → "1st", 2 → "2nd", 23 → "23rd". */
function ordinal(n) {
  // 11th/12th/13th are the exceptions that break the last-digit rule.
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

/**
 * Build the fields for the next occurrence of a completed recurring task.
 * Returns null when there is no rule, or when the series has run out.
 *
 * The new task inherits the description and the judgement (urgency, category,
 * who asked) but starts fresh: no completion, no notes, no nudge, and its own
 * deadline. `parent_task_id` points back so the chain can be walked.
 */
function buildNextOccurrence(task, now = Date.now()) {
  const rule = normaliseRule(task.recurrence);
  if (!rule) return null;

  // Advance from the deadline when there was one; from now when there wasn't.
  const from = task.due_at ?? now;
  const nextDue = nextOccurrence(rule, from, now);
  if (nextDue == null) return null;

  return {
    title: task.title,
    details: task.details,
    requester: task.requester,
    requester_rank: task.requester_rank,
    category: task.category,
    due_at: nextDue,
    // The wording is rewritten from the rule rather than copied: the original
    // said "every Tuesday", which is still true, but the resolved date is new.
    due_text: describeRule(rule),
    urgency: task.urgency,
    importance: task.importance,
    effort_minutes: task.effort_minutes,
    recurrence: rule,
    recurrence_text: task.recurrence_text,
    parent_task_id: task.id,
    waiting_on: false,
    extractor: task.extractor,
  };
}

/**
 * Mark a task done and, if it recurs, create the next occurrence.
 *
 * Lives here rather than in the HTTP layer so that ticking a task off in the
 * dashboard, in the bot, or via curl all behave identically — a recurring chore
 * must come back whichever way you completed it.
 *
 * Returns { task, next }, where next is the newly created occurrence or null.
 */
async function completeTask(dbModule, userId, task, now = Date.now()) {
  const updated = await dbModule.updateTaskFields(userId, task.id, {
    status: 'done',
    completed_at: now,
  });

  const spec = buildNextOccurrence(task, now);
  if (!spec) return { task: updated, next: null };

  // Score it now, so the next occurrence is ranked correctly the instant it
  // appears rather than sitting at 0 until the five-minute rescore runs.
  spec.score = scoreTask(spec, now);

  // insertTasks does the scoring-adjacent bookkeeping (ids, timestamps,
  // defaults) and takes a list, so the single occurrence goes in as a batch of
  // one. message_id is carried over so the new occurrence still points at the
  // message that originally described the chore.
  const [next] = await dbModule.insertTasks(userId, task.message_id, [spec]);
  return { task: updated, next };
}

module.exports = {
  normaliseRule,
  nextOccurrence,
  describeRule,
  buildNextOccurrence,
  completeTask,
};
