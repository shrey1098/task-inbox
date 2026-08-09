'use strict';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/**
 * Deterministic 0-100 score. The model supplies urgency/importance/effort;
 * everything time-dependent is computed here so scores stay explainable and
 * can be recomputed as deadlines approach without re-calling the API.
 */
function duePressure(dueAt, now) {
  if (!dueAt) return 0.15;
  const remaining = dueAt - now;
  if (remaining <= 0) return 1.0; // overdue
  if (remaining <= 6 * HOUR) return 0.95;
  if (remaining <= DAY) return 0.85;
  if (remaining <= 3 * DAY) return 0.6;
  if (remaining <= 7 * DAY) return 0.35;
  if (remaining <= 14 * DAY) return 0.2;
  return 0.15;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function scoreTask(task, now = Date.now()) {
  const urgency = clamp(task.urgency ?? 3, 1, 5);
  const importance = clamp(task.importance ?? 3, 1, 5);

  const urgencyPoints = ((urgency - 1) / 4) * 30;
  const importancePoints = ((importance - 1) / 4) * 30;
  const duePoints = duePressure(task.due_at, now) * 30;

  // Small nudge for things that clear in one sitting.
  const effort = task.effort_minutes;
  let quickWin = 0;
  if (effort != null && effort <= 15) quickWin = 6;
  else if (effort != null && effort <= 60) quickWin = 3;

  // Age nudge so nothing sits open forever.
  const createdAt = task.created_at ?? now;
  const ageDays = Math.max(0, (now - createdAt) / DAY);
  const stalenessPoints = Math.min(8, ageDays);

  const raw = urgencyPoints + importancePoints + duePoints + quickWin + stalenessPoints;
  return Math.round(clamp(raw, 0, 100) * 10) / 10;
}

function bucketOf(score) {
  if (score >= 70) return 'now';
  if (score >= 45) return 'soon';
  return 'later';
}

/** Human-readable breakdown, shown in the dashboard so the ranking isn't a black box. */
function explainScore(task, now = Date.now()) {
  const urgency = clamp(task.urgency ?? 3, 1, 5);
  const importance = clamp(task.importance ?? 3, 1, 5);
  const parts = [
    `urgency ${urgency}/5`,
    `importance ${importance}/5`,
  ];
  if (task.due_at) {
    const remaining = task.due_at - now;
    parts.push(remaining <= 0 ? 'overdue' : `due in ${formatDuration(remaining)}`);
  } else {
    parts.push('no deadline');
  }
  if (task.effort_minutes != null) parts.push(`~${formatMinutes(task.effort_minutes)}`);
  return parts.join(' · ');
}

function formatMinutes(mins) {
  if (mins < 60) return `${mins}m`;
  const hours = mins / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

function formatDuration(ms) {
  const hours = ms / HOUR;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Recompute every open task's score; deadlines and age move without new input. */
async function rescoreOpenTasks(dbModule, now = Date.now()) {
  const open = await dbModule.listTasksByStatus('open');
  const snoozed = await dbModule.listTasksByStatus('snoozed');
  let changed = 0;

  for (const task of snoozed) {
    if (task.snooze_until && task.snooze_until <= now) {
      await dbModule.updateTaskFields(task.id, { status: 'open', snooze_until: null });
      open.push({ ...task, status: 'open', snooze_until: null });
    }
  }

  for (const task of open) {
    const score = scoreTask(task, now);
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
  explainScore,
  rescoreOpenTasks,
  formatMinutes,
  formatDuration,
};
