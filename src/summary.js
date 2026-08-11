'use strict';

// ---------------------------------------------------------------------------
// summary.js — "how did the last N days go?"
//
// Two jobs, kept together because they are two halves of the same feature:
//   parsePeriod()   turns what a person typed ("last month", "7d", "this week")
//                   into a [from, to) millisecond range
//   renderSummary() turns the computed numbers into Telegram HTML
//
// The numbers themselves come from stats.periodSummary, so the bot's /summary,
// the scheduled weekly review and the dashboard's date-range picker all report
// exactly the same figures.
// ---------------------------------------------------------------------------

const DAY = 24 * 3600 * 1000;

const { formatDuration } = require('./priority');

/** Local midnight at the start of the day containing ts. */
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight at the start of the week containing ts (weeks start Monday). */
function startOfWeek(ts) {
  const d = new Date(startOfDay(ts));
  // getDay(): 0 = Sunday. Shift so Monday is 0, which is how a week is read
  // everywhere the app shows one.
  const shift = (d.getDay() + 6) % 7;
  return d.getTime() - shift * DAY;
}

function startOfMonth(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/**
 * Turn a phrase into a range. Returns { from, to, label } or null if the input
 * makes no sense — the caller then shows the usage hint rather than guessing.
 *
 * Understood forms:
 *   ""                       → today
 *   "today" / "yesterday"
 *   "week" / "this week" / "last week"
 *   "month" / "this month" / "last month"
 *   "year" / "this year"
 *   "7d" / "30 days" / "12h" / "6 weeks" / "3 months"
 *   "2026-08-01..2026-08-11" — an explicit range, both ends inclusive of the day
 */
function parsePeriod(input, now = Date.now()) {
  const text = String(input || '').trim().toLowerCase();

  if (text === '' || text === 'today') {
    return { from: startOfDay(now), to: now, label: 'today' };
  }
  if (text === 'yesterday') {
    const start = startOfDay(now) - DAY;
    return { from: start, to: start + DAY, label: 'yesterday' };
  }
  if (text === 'week' || text === 'this week') {
    return { from: startOfWeek(now), to: now, label: 'this week' };
  }
  if (text === 'last week') {
    const thisWeek = startOfWeek(now);
    return { from: thisWeek - 7 * DAY, to: thisWeek, label: 'last week' };
  }
  if (text === 'month' || text === 'this month') {
    return { from: startOfMonth(now), to: now, label: 'this month' };
  }
  if (text === 'last month') {
    const d = new Date(now);
    const from = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
    return { from, to: startOfMonth(now), label: 'last month' };
  }
  if (text === 'year' || text === 'this year') {
    return { from: new Date(new Date(now).getFullYear(), 0, 1).getTime(), to: now, label: 'this year' };
  }
  if (text === 'all' || text === 'ever' || text === 'all time') {
    return { from: 0, to: now, label: 'all time' };
  }

  // An explicit range: two ISO dates separated by "..". The end is pushed to
  // the end of that day, because "1st..11th" plainly means through the 11th.
  const range = text.match(/^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|to|-)\s*(\d{4}-\d{2}-\d{2})$/);
  if (range) {
    const from = Date.parse(`${range[1]}T00:00:00`);
    const to = Date.parse(`${range[2]}T00:00:00`);
    if (Number.isFinite(from) && Number.isFinite(to) && to >= from) {
      return { from, to: to + DAY, label: `${range[1]} to ${range[2]}` };
    }
    return null;
  }

  // A relative window: "7d", "30 days", "12h", "6 weeks", "3 months".
  const rel = text.match(/^(?:last\s+|past\s+)?(\d+)\s*(h|hour|hours|d|day|days|w|week|weeks|m|month|months)$/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2][0]; // first letter is enough to tell them apart
    if (n < 1 || n > 3650) return null; // guard against absurd inputs

    if (unit === 'h') return { from: now - n * 3600e3, to: now, label: `last ${n}h` };
    if (unit === 'd') return { from: now - n * DAY, to: now, label: `last ${n} days` };
    if (unit === 'w') return { from: now - n * 7 * DAY, to: now, label: `last ${n} weeks` };
    // Months are calendar months, not 30-day blocks — "last 3 months" from the
    // 31st should land on the 31st (or the closest valid day).
    const d = new Date(now);
    d.setMonth(d.getMonth() - n);
    return { from: d.getTime(), to: now, label: `last ${n} months` };
  }

  return null;
}

/** The list of period phrases, for help text and the dashboard's presets. */
const PERIOD_EXAMPLES = ['today', 'yesterday', 'this week', 'last week', 'this month', 'last month', '7d', '30 days', '2026-08-01..2026-08-11'];

/** Escape for Telegram's HTML parse mode. Same rule as telegram.js. */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render a computed summary as Telegram HTML.
 *
 * Written to be readable on a phone: a headline, a handful of numbers, then
 * only the sections that have something in them. A summary full of "0" lines
 * is worse than a short one.
 */
function renderSummary(summary, label) {
  const lines = [`📊 <b>Summary — ${esc(label)}</b>`, ''];

  lines.push(`✅ Completed: <b>${summary.completed}</b>${summary.span_days > 1 ? ` (${summary.per_day}/day)` : ''}`);
  lines.push(`📥 Arrived: <b>${summary.created}</b>`);
  if (summary.dropped) lines.push(`🗑 Dropped: ${summary.dropped}`);
  lines.push(`⚡ XP earned: <b>${summary.xp_earned}</b>`);

  lines.push('', `📋 Still open: <b>${summary.still_open}</b>`);
  if (summary.still_overdue) lines.push(`🔴 Overdue: <b>${summary.still_overdue}</b>`);

  if (summary.by_category.length > 0) {
    lines.push('', '<b>By category</b>');
    lines.push(summary.by_category.map((c) => `${esc(c.key)} ${c.n}`).join(' · '));
  }

  if (summary.by_requester.length > 0) {
    lines.push('', '<b>Most demanding</b>');
    lines.push(...summary.by_requester.map((r) => `• ${esc(r.key)} — ${r.n}`));
  }

  if (summary.highlights.length > 0) {
    lines.push('', '<b>Biggest wins</b>');
    lines.push(...summary.highlights.map((h) => `• ${esc(h.title)} <i>[${Math.round(h.score)}]</i>`));
  }

  if (summary.worst_open) {
    const late = formatDuration(Date.now() - summary.worst_open.due_at);
    lines.push('', `⚠️ Longest overdue: <b>${esc(summary.worst_open.title)}</b> — ${late} late`);
  }

  if (summary.completed === 0 && summary.created === 0) {
    lines.push('', '<i>Nothing happened in that window.</i>');
  }

  return lines.join('\n');
}

module.exports = { parsePeriod, renderSummary, PERIOD_EXAMPLES, startOfDay, startOfWeek, startOfMonth };
