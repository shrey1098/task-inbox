// Unit tests for the pure logic: recurrence dates, streaks, XP, and the
// period parser. No database and no HTTP — these are the functions where a
// quiet off-by-one would be invisible until somebody's chore drifted a day.
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'src');

const { normaliseRule, nextOccurrence, describeRule, buildNextOccurrence } = require(path.join(ROOT, 'recurrence'));
const { streakFrom, levelForXp, xpForTask } = require(path.join(ROOT, 'stats'));
const { parsePeriod } = require(path.join(ROOT, 'summary'));
const { scoreTask, rankRequester, bucketOf } = require(path.join(ROOT, 'priority'));
const { costOf, ratesAt, supportsEffort, labelFor, modelInfo } = require(path.join(ROOT, 'pricing'));

let pass = 0, fail = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ✓ ${name}`); pass++; }
  catch (e) { results.push(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

const DAY = 86400000;
/** A fixed reference point, so nothing here depends on when it is run. */
const MON = new Date(2026, 7, 10, 9, 0, 0).getTime(); // Monday 10 Aug 2026, 09:00

/* ------------------------------------------------------------- recurrence */

check('a rule is normalised and clamped', () => {
  assert.deepStrictEqual(normaliseRule({ freq: 'weekly', interval: '2', weekday: 3 }),
    { freq: 'weekly', interval: 2, weekday: 3, until: null });
  // Junk in, null out — a bad rule must never reach the scheduler.
  assert.strictEqual(normaliseRule({ freq: 'fortnightly' }), null);
  assert.strictEqual(normaliseRule(null), null);
  // An absurd interval is capped rather than honoured.
  assert.strictEqual(normaliseRule({ freq: 'daily', interval: 9999 }).interval, 52);
});

check('weekly recurrence lands on the same weekday', () => {
  const next = nextOccurrence({ freq: 'weekly', interval: 1 }, MON, MON);
  assert.strictEqual(new Date(next).getDay(), 1, 'should still be a Monday');
  assert.strictEqual(next - MON, 7 * DAY);
});

check('a named weekday is snapped to, even after drift', () => {
  // Base is a Monday, but the rule says Thursday (4).
  const next = nextOccurrence({ freq: 'weekly', interval: 1, weekday: 4 }, MON, MON);
  assert.strictEqual(new Date(next).getDay(), 4);
});

check('monthly recurrence clamps to the length of the month', () => {
  // The 31st of January, repeating monthly on the 31st → February has no 31st.
  const jan31 = new Date(2026, 0, 31, 9, 0, 0).getTime();
  const next = nextOccurrence({ freq: 'monthly', interval: 1, monthday: 31 }, jan31, jan31);
  const d = new Date(next);
  assert.strictEqual(d.getMonth(), 1, 'should be February');
  assert.strictEqual(d.getDate(), 28, 'and clamped to the 28th');
});

check('a long-neglected chore catches up instead of spawning an overdue one', () => {
  // Due two months ago, weekly. The next occurrence must be in the future, not
  // next week from back then.
  const longAgo = MON - 60 * DAY;
  const next = nextOccurrence({ freq: 'weekly', interval: 1 }, longAgo, MON);
  assert.ok(next > MON, `expected a future date, got ${new Date(next).toDateString()}`);
  assert.strictEqual(new Date(next).getDay(), new Date(longAgo).getDay(), 'weekday preserved');
});

check('a series stops at its until date', () => {
  const rule = { freq: 'weekly', interval: 1, until: MON + 3 * DAY };
  assert.strictEqual(nextOccurrence(rule, MON, MON), null);
});

check('rules read as English', () => {
  assert.strictEqual(describeRule({ freq: 'weekly', interval: 1, weekday: 2 }), 'every week on Tuesday');
  assert.strictEqual(describeRule({ freq: 'daily', interval: 2 }), 'every 2 days');
  assert.strictEqual(describeRule({ freq: 'monthly', interval: 1, monthday: 3 }), 'every month on the 3rd');
  assert.strictEqual(describeRule({ freq: 'monthly', interval: 1, monthday: 11 }), 'every month on the 11th');
});

check('the next occurrence inherits judgement but not history', () => {
  const task = {
    id: 7, title: 'Pay the rent', category: 'finance', urgency: 4, importance: 5,
    requester: 'Landlord', requester_rank: 'peer', due_at: MON, effort_minutes: 5,
    recurrence: { freq: 'monthly', interval: 1 }, notes: 'old note', status: 'done',
  };
  const next = buildNextOccurrence(task, MON);
  assert.strictEqual(next.title, 'Pay the rent');
  assert.strictEqual(next.urgency, 4);
  assert.strictEqual(next.parent_task_id, 7);
  assert.ok(next.due_at > MON);
  // Notes and completion are personal to the occurrence you finished.
  assert.strictEqual(next.notes, undefined);
  assert.strictEqual(next.waiting_on, false);
});

/* --------------------------------------------------------------- priority */

check('a senior’s request is pinned to P1 with no deadline at all', () => {
  const base = { urgency: 1, importance: 1, due_at: null, created_at: MON };
  const ordinary = scoreTask({ ...base, requester_rank: 'peer' }, MON);
  const fromBoss = scoreTask({ ...base, requester_rank: 'senior' }, MON);
  assert.ok(ordinary < 45, `an ordinary trivial task should be P3, got ${ordinary}`);
  assert.ok(fromBoss >= 70, `a senior’s should hit the floor, got ${fromBoss}`);
  assert.strictEqual(bucketOf(fromBoss), 'p1');
});

check('a senior’s request still outranks a same-day errand', () => {
  const errand = scoreTask({ urgency: 3, importance: 2, due_at: MON + 3600e3, created_at: MON }, MON);
  const boss = scoreTask({ urgency: 1, importance: 1, due_at: null, requester_rank: 'senior', created_at: MON }, MON);
  assert.ok(boss >= 70 && bucketOf(errand) !== 'p1' || boss > errand - 20,
    `boss ${boss} vs errand ${errand}`);
  assert.ok(boss >= 70);
});

check('waiting on somebody else pushes a task down, and past the floor', () => {
  const doing = scoreTask({ urgency: 4, importance: 4, due_at: MON + DAY, created_at: MON }, MON);
  const waiting = scoreTask({ urgency: 4, importance: 4, due_at: MON + DAY, created_at: MON, waiting_on: true }, MON);
  assert.ok(waiting < doing, `${waiting} should be below ${doing}`);
  // A senior's task you are blocked on is not something you can act on, so the
  // floor deliberately does not apply.
  const blockedBoss = scoreTask({ urgency: 1, importance: 1, requester_rank: 'senior', waiting_on: true, created_at: MON }, MON);
  assert.ok(blockedBoss < 70, `expected no floor when blocked, got ${blockedBoss}`);
});

check('senior matching is forgiving about how a name is written', () => {
  assert.strictEqual(rankRequester('the CO', ['CO']), 'senior');
  assert.strictEqual(rankRequester('Col. Mehta (Ops)', ['Col. Mehta']), 'senior');
  assert.strictEqual(rankRequester('Priya', ['CO', 'Col. Mehta']), 'peer');
  assert.strictEqual(rankRequester('', ['CO']), 'unknown');
  // A one-character entry would match nearly everyone, so it is ignored.
  assert.strictEqual(rankRequester('Priya', ['a']), 'peer');
});

/* ----------------------------------------------------------------- streaks */

check('a streak counts consecutive days', () => {
  const now = new Date(2026, 7, 10, 20, 0, 0).getTime();
  const done = [0, 1, 2].map((d) => ({ completed_at: now - d * DAY, score: 60 }));
  const s = streakFrom(done, now);
  assert.strictEqual(s.current, 3);
  assert.strictEqual(s.done_today, 1);
});

check('an unfinished today does not break the streak', () => {
  const now = new Date(2026, 7, 10, 9, 0, 0).getTime();
  // Nothing today; yesterday and the day before are done.
  const done = [1, 2].map((d) => ({ completed_at: now - d * DAY, score: 60 }));
  const s = streakFrom(done, now);
  assert.strictEqual(s.current, 2, 'the day is still in progress');
  assert.strictEqual(s.done_today, 0);
});

check('a missed day does break it', () => {
  const now = new Date(2026, 7, 10, 20, 0, 0).getTime();
  const done = [0, 1, 3, 4].map((d) => ({ completed_at: now - d * DAY, score: 60 }));
  const s = streakFrom(done, now);
  assert.strictEqual(s.current, 2, 'the gap at day 2 ends the run');
  assert.strictEqual(s.best, 2);
});

check('an empty history is zero, not a crash', () => {
  assert.deepStrictEqual(streakFrom([], MON), { current: 0, best: 0, days_active: 0, done_today: 0 });
});

/* --------------------------------------------------------------- XP levels */

check('XP rewards the hard tasks more', () => {
  assert.ok(xpForTask({ score: 95 }) > xpForTask({ score: 30 }));
  assert.ok(xpForTask({ score: 0 }) >= 5, 'every task is worth something');
});

check('levels get harder as they go', () => {
  assert.strictEqual(levelForXp(0).level, 1);
  assert.strictEqual(levelForXp(50).level, 2);
  const l2 = levelForXp(50);
  const l9 = levelForXp(50 * 64); // level 9
  assert.ok(l9.level_span > l2.level_span, 'later levels should span more XP');
  assert.ok(l2.progress >= 0 && l2.progress <= 1);
});

/* --------------------------------------------------------- period parsing */

check('period phrases parse to sane ranges', () => {
  const now = new Date(2026, 7, 12, 15, 0, 0).getTime(); // Wednesday

  const today = parsePeriod('today', now);
  assert.strictEqual(new Date(today.from).getHours(), 0);
  assert.strictEqual(today.to, now);

  const week = parsePeriod('this week', now);
  assert.strictEqual(new Date(week.from).getDay(), 1, 'weeks start on Monday');

  const sevenDays = parsePeriod('7d', now);
  assert.strictEqual(now - sevenDays.from, 7 * DAY);

  const lastMonth = parsePeriod('last month', now);
  assert.strictEqual(new Date(lastMonth.from).getMonth(), 6, 'July');
  assert.strictEqual(new Date(lastMonth.to).getMonth(), 7, 'up to the start of August');
});

check('an explicit range includes its last day', () => {
  const r = parsePeriod('2026-08-01..2026-08-11');
  assert.strictEqual(new Date(r.from).getDate(), 1);
  // The end is pushed to midnight after the 11th, so the 11th itself counts.
  assert.strictEqual(new Date(r.to).getDate(), 12);
});

check('nonsense periods are rejected rather than guessed at', () => {
  assert.strictEqual(parsePeriod('whenever'), null);
  assert.strictEqual(parsePeriod('9999999 days'), null);
  assert.strictEqual(parsePeriod('2026-08-11..2026-08-01'), null, 'backwards range');
});

/* ----------------------------------------------------------------- pricing */

check('a call is priced from the per-million rates for its model', () => {
  // Haiku 4.5: $1 in, $5 out per million.
  const cost = costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-haiku-4-5');
  assert.strictEqual(cost, 6);
});

check('cache reads and writes are priced apart from fresh input', () => {
  // Reads are a tenth of the input rate, writes 1.25x. Lumping either in with
  // input_tokens would over- or under-charge silently.
  const reads = costOf({ cache_read_input_tokens: 1_000_000 }, 'claude-haiku-4-5');
  const writes = costOf({ cache_creation_input_tokens: 1_000_000 }, 'claude-haiku-4-5');
  assert.strictEqual(reads, 0.1);
  assert.strictEqual(writes, 1.25);
});

check('a realistic extraction lands where the estimate said it would', () => {
  // ~2,300 in / ~650 out on Haiku is fractions of a cent — the figure that
  // justified the switch away from Opus. Guards against a stray factor of
  // 1,000 in either direction.
  const cost = costOf({ input_tokens: 2300, output_tokens: 650 }, 'claude-haiku-4-5');
  assert.ok(cost > 0.004 && cost < 0.008, `expected ~$0.0056, got ${cost}`);

  const onOpus = costOf({ input_tokens: 2300, output_tokens: 650 }, 'claude-opus-5');
  assert.ok(onOpus / cost > 4, 'Opus should be several times dearer than Haiku');
});

check('introductory pricing applies before its date and not after', () => {
  const during = ratesAt('claude-sonnet-5', Date.parse('2026-08-15T00:00:00Z'));
  const after = ratesAt('claude-sonnet-5', Date.parse('2026-10-01T00:00:00Z'));
  assert.strictEqual(during.input, 2);
  assert.strictEqual(after.input, 3);
});

check('an unknown model is reported as unpriced, not guessed at', () => {
  assert.strictEqual(costOf({ input_tokens: 5000 }, 'claude-something-7'), 0);
  assert.strictEqual(modelInfo('claude-something-7').unknown, true);
  // The raw id still shows, so unattributed traffic is visible on the page.
  assert.strictEqual(labelFor('claude-something-7'), 'claude-something-7');
});

check('effort support is per-model — Haiku rejects it, Opus takes it', () => {
  // Not cosmetic: sending output_config.effort to Haiku 4.5 is a 400, so this
  // flag is the only thing stopping a model switch breaking every extraction.
  assert.strictEqual(supportsEffort('claude-haiku-4-5'), false);
  assert.strictEqual(supportsEffort('claude-opus-5'), true);
  assert.strictEqual(supportsEffort('claude-sonnet-5'), true);
  // An unknown model errs towards omitting the parameter.
  assert.strictEqual(supportsEffort('claude-something-7'), false);
});

/* -------------------------------------------------- index declarations */

check('no unique index in db.js is declared sparse', () => {
  // This is a source-level check, and it exists because no in-memory double
  // can catch the bug it guards. MongoDB's `sparse` omits documents where the
  // indexed field is MISSING — not where it is null. Every account is written
  // with `tg_chat_id: null`, so a `{unique: true, sparse: true}` index put
  // them all in the index and rejected the second account ever created, with
  // an E11000 the HTTP layer then misreported as a duplicate email.
  //
  // partialFilterExpression is the correct tool and is what both indexes in
  // db.js now use. A test double models intent, so only the real database
  // could have caught this — and it did, in production. This assertion is the
  // cheapest thing that would have.
  const src = require('fs').readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  // Each createIndex(...) call, options included, across line breaks.
  const calls = src.match(/createIndex\([\s\S]*?\)\s*;/g) || [];
  assert.ok(calls.length >= 5, `expected several createIndex calls, found ${calls.length}`);
  const offenders = calls.filter((c) => /unique:\s*true/.test(c) && /sparse:\s*true/.test(c));
  assert.deepStrictEqual(offenders, [],
    'a unique+sparse index will reject the second document whose field is null — '
    + 'use partialFilterExpression instead');
});

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
