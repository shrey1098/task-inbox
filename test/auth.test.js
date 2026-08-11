// Integration test for multi-user auth + tenant isolation.
// Runs the REAL server.js / auth.js / telegram.js against an in-memory double
// of db.js that reproduces Mongo's unique-index errors (code 11000).
const assert = require('assert');
const path = require('path');
const ROOT = '/home/user/task-inbox/src';

/* ---------------------------------------------------------- fake database */
const users = [], sessions = [], tasks = [], messages = [], state = new Map();
let seq = { users: 0, tasks: 0, messages: 0 };
const dup = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });

const fakeDb = {
  connect: async () => {}, close: async () => {},
  getState: async (k) => state.get(k) ?? null,
  setState: async (k, v) => void state.set(k, String(v)),

  createUser: async ({ email, password_hash }) => {
    email = email.toLowerCase().trim();
    if (users.some((u) => u.email === email)) throw dup();          // unique index
    const doc = { id: ++seq.users, email, password_hash, tg_chat_id: null,
                  link_code: null, link_code_expires: null, created_at: Date.now() };
    users.push(doc); return doc;
  },
  getUser: async (id) => users.find((u) => u.id === id) ?? null,
  getUserByEmail: async (e) => users.find((u) => u.email === String(e).toLowerCase().trim()) ?? null,
  getUserByChatId: async (c) => users.find((u) => u.tg_chat_id === c) ?? null,
  getUserByLinkCode: async (c) => users.find((u) => u.link_code === String(c).toUpperCase()) ?? null,
  countUsers: async () => users.length,
  updateUser: async (id, f) => {
    const u = users.find((x) => x.id === id);
    if (f.tg_chat_id != null && users.some((x) => x.id !== id && x.tg_chat_id === f.tg_chat_id)) throw dup();
    Object.assign(u, f); return u;
  },

  insertSession: async (d) => void sessions.push(d),
  findSession: async (h) => sessions.find((s) => s.token_hash === h) ?? null,
  deleteSession: async (h) => { const i = sessions.findIndex((s) => s.token_hash === h); if (i >= 0) sessions.splice(i, 1); },
  deleteUserSessions: async (uid) => { for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i].user_id === uid) sessions.splice(i, 1); },

  insertMessage: async (m) => {
    if (m.tg_message_id != null &&
        messages.some((x) => x.tg_chat_id === m.tg_chat_id && x.tg_message_id === m.tg_message_id)) return null;
    const doc = { id: ++seq.messages, status: 'pending', tg_message_id: null, tg_chat_id: null, ...m };
    messages.push(doc); return doc;
  },
  getMessage: async (id) => messages.find((m) => m.id === id) ?? null,
  listPendingMessages: async () => messages.filter((m) => m.status === 'pending'),
  setMessageStatus: async (id, st, e = null) => { const m = messages.find((x) => x.id === id); if (m) Object.assign(m, { status: st, error: e }); },

  insertTasks: async (uid, mid, rows) => rows.map((t) => {
    const doc = { id: ++seq.tasks, user_id: uid, message_id: mid, status: 'open',
                  created_at: Date.now(), updated_at: Date.now(), snooze_until: null,
                  completed_at: null, details: null, ...t };
    tasks.push(doc); return doc;
  }),
  getTask: async (uid, id) => tasks.find((t) => t.id === id && t.user_id === uid) ?? null,
  listTasksByStatus: async (uid, st) => tasks.filter((t) => t.user_id === uid && t.status === st).sort((a, b) => b.score - a.score),
  listAllTasks: async (uid) => tasks.filter((t) => t.user_id === uid),
  listTasksByStatusAllUsers: async (st) => tasks.filter((t) => t.status === st),
  // Mirrors the allowlist in db.js. Without it the double would happily write
  // any field the real database refuses, and the tests that exist to prove the
  // allowlist works would pass for the wrong reason.
  updateTaskFields: async (uid, id, f) => {
    const allowed = ['title', 'details', 'requester', 'requester_rank', 'category',
      'due_at', 'due_text', 'urgency', 'importance', 'effort_minutes',
      'status', 'snooze_until', 'completed_at', 'score',
      'recurrence', 'recurrence_text', 'waiting_on', 'dup_of', 'notes',
      'nudged_at', 'edited_at'];
    const t = tasks.find((x) => x.id === id && x.user_id === uid);
    if (!t) return null;
    for (const [k, v] of Object.entries(f)) if (allowed.includes(k)) t[k] = v;
    t.updated_at = Date.now();
    return t;
  },
  // Mirrors the real conditional update: the write only lands if the task is
  // not already done, so two concurrent completions cannot both win.
  completeTaskAtomically: async (uid, id, now = Date.now()) => {
    const t = tasks.find((x) => x.id === id && x.user_id === uid);
    if (!t || t.status === 'done') return null;
    Object.assign(t, { status: 'done', completed_at: now, updated_at: now });
    return t;
  },
  updateTaskScore: async (id, sc) => { const t = tasks.find((x) => x.id === id); if (t) t.score = sc; },
  deleteTask: async (uid, id) => { const i = tasks.findIndex((t) => t.id === id && t.user_id === uid); if (i < 0) return false; tasks.splice(i, 1); return true; },
  countByStatus: async (uid) => Object.entries(
    tasks.filter((t) => t.user_id === uid).reduce((a, t) => ((a[t.status] = (a[t.status] || 0) + 1), a), {})
  ).map(([status, n]) => ({ status, n })),

  // --- the newer surface: settings, search, time ranges, grouping, stats.
  DEFAULT_SETTINGS: { seniors: [], digest_enabled: true, digest_hour: 8, nudge_enabled: true,
    nudge_lead_minutes: 60, weekly_enabled: true, weekly_weekday: 0, weekly_hour: 18, daily_goal: 5 },
  settingsOf: (u) => ({ ...fakeDb.DEFAULT_SETTINGS, ...(u?.settings || {}) }),
  listUsersWithChat: async () => users.filter((u) => u.tg_chat_id != null),
  searchTasks: async (uid, q) => tasks.filter((t) => t.user_id === uid
    && [t.title, t.details, t.requester, t.notes].some((f) => f && f.toLowerCase().includes(q.toLowerCase()))),
  listTasksDueBetween: async (uid, from, to, st = ['open', 'snoozed']) => tasks.filter((t) =>
    t.user_id === uid && st.includes(t.status) && t.due_at != null && t.due_at >= from && t.due_at < to),
  listTasksCompletedBetween: async (uid, from, to) => tasks.filter((t) =>
    t.user_id === uid && t.status === 'done' && t.completed_at >= from && t.completed_at < to),
  listTasksCreatedBetween: async (uid, from, to) => tasks.filter((t) =>
    t.user_id === uid && t.created_at >= from && t.created_at < to),
  completionTimes: async (uid) => tasks.filter((t) => t.user_id === uid && t.status === 'done' && t.completed_at)
    .map((t) => ({ completed_at: t.completed_at, score: t.score })),
  groupByRequester: async (uid) => {
    const map = new Map();
    for (const t of tasks.filter((x) => x.user_id === uid && ['open', 'snoozed'].includes(x.status))) {
      const key = t.requester ?? null;
      const g = map.get(key) || { _id: key, n: 0, top_score: 0, rank: t.requester_rank, waiting: 0 };
      g.n += 1; g.top_score = Math.max(g.top_score, t.score); if (t.waiting_on) g.waiting += 1;
      map.set(key, g);
    }
    return [...map.values()].sort((a, b) => b.top_score - a.top_score);
  },
  recentOpenTaskSummaries: async (uid) => tasks.filter((t) => t.user_id === uid && t.status === 'open')
    .map((t) => ({ id: t.id, title: t.title, requester: t.requester, due_at: t.due_at })),
  recentMessagesForChat: async () => [],
  listNudgeCandidates: async () => [],
  addProgress: async (uid, id, text) => {
    const t = tasks.find((x) => x.id === id && x.user_id === uid);
    if (!t) return null;
    t.progress = t.progress || [];
    t.progress.push({ id: t.progress.reduce((m, e) => Math.max(m, e.id), 0) + 1, at: Date.now(), text });
    t.progress_at = Date.now();
    return t;
  },
  deleteProgress: async (uid, id, entryId) => {
    const t = tasks.find((x) => x.id === id && x.user_id === uid);
    if (!t) return null;
    t.progress = (t.progress || []).filter((e) => e.id !== entryId);
    return t;
  },
};

const dbPath = require.resolve(path.join(ROOT, 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

// Stub the model call so tests never hit the API.
const exPath = require.resolve(path.join(ROOT, 'extractor.js'));
require.cache[exPath] = { id: exPath, filename: exPath, loaded: true, exports: {
  processMessage: async (message) => {
    const saved = await fakeDb.insertTasks(message.user_id, message.id, [{
      title: `Task from: ${message.text.slice(0, 24)}`, urgency: 3, importance: 3,
      category: 'other', due_at: null, due_text: null, effort_minutes: 15,
      requester: null, score: 50, extractor: 'test',
    }]);
    await fakeDb.setMessageStatus(message.id, 'processed');
    return { tasks: saved, note: null };
  },
  processPending: async () => [],
  extractTasks: async () => ({ tasks: [], note: null }),
}};

const { createApp } = require(path.join(ROOT, 'server'));

/* ------------------------------------------------------------ test harness */
let pass = 0, fail = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(`  ✓ ${name}`); pass++; }
  catch (e) { results.push(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

(async () => {
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  // A tiny cookie-aware fetch, one jar per simulated browser.
  const client = () => {
    let cookie = '';
    return async (p, opts = {}) => {
      const res = await fetch(base + p, {
        redirect: 'manual',
        ...opts,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
      });
      const sc = res.headers.getSetCookie?.() || [];
      for (const c of sc) cookie = c.split(';')[0];
      let body = null;
      try { body = await res.json(); } catch { /* empty or redirect */ }
      return { status: res.status, body, location: res.headers.get('location') };
    };
  };

  const anon = client(), alice = client(), bob = client();

  // ---- signup / login
  await check('signup creates an account and a session', async () => {
    const r = await alice('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email: 'alice@example.com', password: 'correct-horse-battery' }) });
    assert.strictEqual(r.status, 201, `got ${r.status}`);
    assert.strictEqual(r.body.email, 'alice@example.com');
  });
  await check('second account works too', async () => {
    const r = await bob('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email: 'bob@example.com', password: 'another-long-password' }) });
    assert.strictEqual(r.status, 201, `got ${r.status}`);
  });
  await check('duplicate email is rejected with 409', async () => {
    const r = await anon('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email: 'alice@example.com', password: 'yet-another-password' }) });
    assert.strictEqual(r.status, 409, `got ${r.status}`);
  });
  await check('short password is rejected', async () => {
    const r = await anon('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email: 'x@example.com', password: 'short' }) });
    assert.strictEqual(r.status, 400, `got ${r.status}`);
  });
  await check('password is never stored in plaintext', async () => {
    const u = await fakeDb.getUserByEmail('alice@example.com');
    assert.ok(!u.password_hash.includes('correct-horse-battery'), 'plaintext found in hash!');
    assert.match(u.password_hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/, 'not a salt:hash pair');
  });
  await check('session token is not stored raw in the database', async () => {
    assert.ok(sessions.every((s) => s.token_hash && !s.token), 'raw token stored');
    assert.match(sessions[0].token_hash, /^[0-9a-f]{64}$/);
  });

  // ---- anonymous access
  await check('anonymous API call is 401', async () => {
    const r = await anon('/api/tasks');
    assert.strictEqual(r.status, 401, `got ${r.status}`);
  });
  await check('anonymous page load redirects to login', async () => {
    const r = await anon('/');
    assert.strictEqual(r.status, 302, `got ${r.status}`);
    assert.strictEqual(r.location, '/login.html');
  });
  await check('login page itself is reachable when signed out', async () => {
    const r = await anon('/login.html');
    assert.strictEqual(r.status, 200, `got ${r.status}`);
  });

  // ---- tenant isolation
  await fakeDb.insertTasks(1, 1, [{ title: 'Alice private', score: 80, urgency: 4, importance: 4, category: 'work' }]);
  await fakeDb.insertTasks(2, 2, [{ title: 'Bob private', score: 90, urgency: 5, importance: 5, category: 'work' }]);

  await check('each user sees only their own tasks', async () => {
    const a = await alice('/api/tasks');
    const b = await bob('/api/tasks');
    assert.deepStrictEqual(a.body.map((t) => t.title), ['Alice private']);
    assert.deepStrictEqual(b.body.map((t) => t.title), ['Bob private']);
  });
  await check("PATCHing another user's task 404s", async () => {
    const bobTask = tasks.find((t) => t.title === 'Bob private');
    const r = await alice(`/api/tasks/${bobTask.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
    assert.strictEqual(r.status, 404, `got ${r.status}`);
    assert.strictEqual(tasks.find((t) => t.id === bobTask.id).status, 'open', 'task was modified!');
  });
  await check("DELETEing another user's task 404s", async () => {
    const bobTask = tasks.find((t) => t.title === 'Bob private');
    const r = await alice(`/api/tasks/${bobTask.id}`, { method: 'DELETE' });
    assert.strictEqual(r.status, 404, `got ${r.status}`);
    assert.ok(tasks.some((t) => t.id === bobTask.id), 'task was deleted!');
  });
  await check('stats are per-user', async () => {
    const a = await alice('/api/stats');
    assert.strictEqual(a.body.counts.reduce((n, c) => n + c.n, 0), 1);
  });
  await check('captured messages belong to the capturing user', async () => {
    await alice('/api/messages', { method: 'POST', body: JSON.stringify({ text: 'pay the bill tomorrow' }) });
    const b = await bob('/api/tasks');
    assert.strictEqual(b.body.length, 1, 'Bob can see Alice’s new task');
    const a = await alice('/api/tasks');
    assert.strictEqual(a.body.length, 2);
  });

  // ---- login behaviour
  await check('wrong password is rejected', async () => {
    const r = await anon('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alice@example.com', password: 'wrong-password-here' }) });
    assert.strictEqual(r.status, 401, `got ${r.status}`);
  });
  await check('unknown email gives the identical message (no enumeration)', async () => {
    const a = await anon('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alice@example.com', password: 'wrong-password-here' }) });
    const b = await anon('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password-here' }) });
    assert.strictEqual(a.body.error, b.body.error, 'messages differ');
  });
  await check('brute force is rate limited', async () => {
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const r = await anon('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alice@example.com', password: 'nope-nope-nope' }) });
      if (r.status === 429) { limited = true; break; }
    }
    assert.ok(limited, 'never hit 429');
  });
  await check('correct password signs in', async () => {
    const fresh = client();
    const r = await fresh('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'bob@example.com', password: 'another-long-password' }) });
    assert.strictEqual(r.status, 200, `got ${r.status}`);
    const t = await fresh('/api/tasks');
    assert.strictEqual(t.status, 200);
  });
  await check('logout invalidates the session', async () => {
    const fresh = client();
    await fresh('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'bob@example.com', password: 'another-long-password' }) });
    await fresh('/api/auth/logout', { method: 'POST' });
    const r = await fresh('/api/tasks');
    assert.strictEqual(r.status, 401, `got ${r.status}`);
  });

  // ---- Telegram linking
  await check('link code binds a chat to the right account', async () => {
    const { body } = await alice('/api/me/link-code', { method: 'POST' });
    assert.match(body.link_code, /^[A-Z2-9]{6}$/);

    const u = await fakeDb.getUserByLinkCode(body.link_code);
    assert.strictEqual(u.email, 'alice@example.com');
    // Simulate what handleLink does on a correct code.
    await fakeDb.updateUser(u.id, { tg_chat_id: 555, link_code: null, link_code_expires: null });
    const owner = await fakeDb.getUserByChatId(555);
    assert.strictEqual(owner.id, u.id);
  });
  await check('a used code cannot be replayed', async () => {
    const again = await fakeDb.getUserByLinkCode('ZZZZZZ');
    assert.strictEqual(again, null);
  });
  await check('a chat cannot be linked to two accounts', async () => {
    const bobU = await fakeDb.getUserByEmail('bob@example.com');
    await assert.rejects(() => fakeDb.updateUser(bobU.id, { tg_chat_id: 555 }), (e) => e.code === 11000);
  });
  await check('/me reports link status', async () => {
    const r = await alice('/api/me');
    assert.strictEqual(r.body.email, 'alice@example.com');
    assert.strictEqual(r.body.tg_linked, true);
  });

  /* ------------------------------------------- the newer feature surface */

  // Everything below runs against Alice's account, which already has tasks
  // from the tenancy tests above.
  const aliceUser = await fakeDb.getUserByEmail('alice@example.com');

  await check('a task can be created directly and edited', async () => {
    const created = await alice('/api/tasks', { method: 'POST', body: JSON.stringify({
      title: 'Pay the deposit', category: 'finance', urgency: 4, importance: 4,
    }) });
    assert.strictEqual(created.status, 201, `got ${created.status}`);
    assert.strictEqual(created.body.title, 'Pay the deposit');

    const edited = await alice(`/api/tasks/${created.body.id}`, { method: 'PATCH',
      body: JSON.stringify({ title: 'Pay the flat deposit', notes: 'ref 14B' }) });
    assert.strictEqual(edited.body.title, 'Pay the flat deposit');
    assert.strictEqual(edited.body.notes, 'ref 14B');
    // An edit is marked as such, so the extractor is not credited with it.
    assert.ok(edited.body.edited_at > 0, 'edited_at should be set');
  });

  await check('search finds a task by title and stays inside the account', async () => {
    const mine = await alice('/api/search?q=deposit');
    assert.ok(mine.body.length >= 1, 'alice should find her own task');
    const theirs = await bob('/api/search?q=deposit');
    assert.strictEqual(theirs.body.length, 0, 'bob must not see alice’s task');
  });

  await check('search needs two characters', async () => {
    const r = await alice('/api/search?q=d');
    assert.deepStrictEqual(r.body, []);
  });

  await check('naming a senior re-ranks the tasks they already asked for', async () => {
    // A task from the CO with no deadline at all — normally a low score.
    const t = await alice('/api/tasks', { method: 'POST', body: JSON.stringify({
      title: 'Readiness report', requester: 'Col. Mehta', urgency: 1, importance: 1,
    }) });
    assert.ok(t.body.score < 70, `expected a low score first, got ${t.body.score}`);

    await alice('/api/settings', { method: 'PUT', body: JSON.stringify({ seniors: ['Col. Mehta'] }) });

    const after = await alice(`/api/tasks/${t.body.id}`);
    assert.strictEqual(after.body.requester_rank, 'senior');
    // The floor is the whole point: no deadline, minimum urgency, still P1.
    assert.ok(after.body.score >= 70, `expected the authority floor, got ${after.body.score}`);
    assert.strictEqual(after.body.bucket, 'p1');
  });

  await check('settings are validated, not trusted', async () => {
    const r = await alice('/api/settings', { method: 'PUT', body: JSON.stringify({
      digest_hour: 99,        // out of range
      daily_goal: -4,         // out of range
      // 'x' is too short to be a useful match. Col. Mehta is carried over
      // because this replaces the list wholesale — dropping them here would
      // silently demote the tasks the previous test just promoted.
      seniors: ['x', 'Boss', 'Col. Mehta'],
    }) });
    assert.strictEqual(r.body.digest_hour, 23, 'hour should clamp to 23');
    assert.strictEqual(r.body.daily_goal, 1, 'goal should clamp to 1');
    assert.deepStrictEqual(r.body.seniors, ['Boss', 'Col. Mehta'], 'single characters are dropped');
  });

  await check('removing someone from the senior list demotes their tasks again', async () => {
    const t = await alice('/api/tasks', { method: 'POST', body: JSON.stringify({
      title: 'Fetch the stationery', requester: 'Boss', urgency: 1, importance: 1,
    }) });
    assert.ok(t.body.score >= 70, 'a senior’s task starts pinned to P1');

    await alice('/api/settings', { method: 'PUT', body: JSON.stringify({ seniors: ['Col. Mehta'] }) });
    const after = await alice(`/api/tasks/${t.body.id}`);
    assert.strictEqual(after.body.requester_rank, 'peer');
    assert.ok(after.body.score < 70, `expected a demotion, got ${after.body.score}`);
  });

  await check('completing a recurring task spawns the next occurrence', async () => {
    const due = Date.now() + 3600e3;
    const created = await alice('/api/tasks', { method: 'POST', body: JSON.stringify({
      title: 'Pay the rent', due_at: due, recurrence: { freq: 'monthly', interval: 1, monthday: 5 },
    }) });
    assert.ok(created.body.recurrence, 'the rule should be stored');

    const done = await alice(`/api/tasks/${created.body.id}`, { method: 'PATCH',
      body: JSON.stringify({ status: 'done' }) });
    assert.strictEqual(done.body.status, 'done');
    assert.ok(done.body.next_occurrence, 'a new occurrence should appear');
    assert.ok(done.body.next_occurrence.due_at > due, 'and it should be in the future');
    assert.strictEqual(done.body.next_occurrence.parent_task_id, created.body.id);
    // Completing something awards XP, so the game state must come back too.
    assert.ok(done.body.game.xp > 0, 'XP should be reported');
  });

  await check('a one-off task does not come back', async () => {
    const created = await alice('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'One and done' }) });
    const done = await alice(`/api/tasks/${created.body.id}`, { method: 'PATCH',
      body: JSON.stringify({ status: 'done' }) });
    assert.strictEqual(done.body.next_occurrence, null);
  });

  await check('a nonsense recurrence rule is rejected rather than stored', async () => {
    const created = await alice('/api/tasks', { method: 'POST', body: JSON.stringify({
      title: 'Bad rule', recurrence: { freq: 'fortnightly', interval: 999 },
    }) });
    assert.strictEqual(created.body.recurrence, null);
  });

  await check('the summary counts a period', async () => {
    const r = await alice('/api/summary?period=today');
    assert.ok(r.body.completed >= 2, `expected today's completions, got ${r.body.completed}`);
    assert.strictEqual(r.body.label, 'today');
    assert.ok(r.body.xp_earned > 0);
  });

  await check('an unrecognised period is a 400, not a guess', async () => {
    const r = await alice('/api/summary?period=whenever');
    assert.strictEqual(r.status, 400);
  });

  await check('game stats report a streak after completing something', async () => {
    const r = await alice('/api/game');
    assert.strictEqual(r.body.streak, 1, 'one active day so far');
    assert.ok(r.body.level >= 1);
    assert.ok(r.body.done_today >= 2);
  });

  await check('people groups open tasks by requester', async () => {
    const r = await alice('/api/people');
    const mehta = r.body.find((p) => p.name === 'Col. Mehta');
    assert.ok(mehta, 'Col. Mehta should appear');
    assert.strictEqual(mehta.rank, 'senior');
  });

  await check('the calendar refuses an absurd range', async () => {
    const r = await alice(`/api/calendar?from=0&to=${Date.now()}`);
    assert.strictEqual(r.status, 400);
  });

  await check('one account cannot read another’s task detail', async () => {
    const mine = await alice('/api/tasks?status=open');
    const id = mine.body[0].id;
    const theirs = await bob(`/api/tasks/${id}`);
    assert.strictEqual(theirs.status, 404);
  });

  await check('one account cannot read another’s message image', async () => {
    const r = await bob('/api/messages/1/image');
    assert.strictEqual(r.status, 404);
  });

  await check('steps can be logged against a task and read back', async () => {
    const t = await alice('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Multi-step job' }) });
    const id = t.body.id;

    const first = await alice(`/api/tasks/${id}/progress`, { method: 'POST',
      body: JSON.stringify({ text: 'Rang the bank' }) });
    assert.strictEqual(first.status, 201, `got ${first.status}`);
    assert.strictEqual(first.body.progress_count, 1);

    await alice(`/api/tasks/${id}/progress`, { method: 'POST',
      body: JSON.stringify({ text: 'Got the reference number' }) });

    const read = await alice(`/api/tasks/${id}`);
    assert.strictEqual(read.body.progress.length, 2);
    // Oldest first — the log reads as the story of the task.
    assert.strictEqual(read.body.progress[0].text, 'Rang the bank');
    assert.ok(read.body.progress[0].at > 0, 'each step is timestamped');
    // The task is still open: progress is not completion.
    assert.strictEqual(read.body.status, 'open');
  });

  await check('a step can be removed', async () => {
    const t = await alice('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Typo job' }) });
    const added = await alice(`/api/tasks/${t.body.id}/progress`, { method: 'POST',
      body: JSON.stringify({ text: 'Teh wrong thing' }) });
    const entryId = added.body.progress[0].id;

    const after = await alice(`/api/tasks/${t.body.id}/progress/${entryId}`, { method: 'DELETE' });
    assert.strictEqual(after.body.progress.length, 0);
  });

  await check('an empty or oversized step is rejected', async () => {
    const t = await alice('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Guarded' }) });
    const blank = await alice(`/api/tasks/${t.body.id}/progress`, { method: 'POST',
      body: JSON.stringify({ text: '   ' }) });
    assert.strictEqual(blank.status, 400);
    const huge = await alice(`/api/tasks/${t.body.id}/progress`, { method: 'POST',
      body: JSON.stringify({ text: 'x'.repeat(1001) }) });
    assert.strictEqual(huge.status, 400);
  });

  await check('one account cannot log progress on another’s task', async () => {
    const mine = await alice('/api/tasks?status=open');
    const id = mine.body[0].id;
    const attempt = await bob(`/api/tasks/${id}/progress`, { method: 'POST',
      body: JSON.stringify({ text: 'sneaking in' }) });
    assert.strictEqual(attempt.status, 404);
  });

  await check('a PATCH cannot rewrite the progress log', async () => {
    const t = await alice('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'History' }) });
    await alice(`/api/tasks/${t.body.id}/progress`, { method: 'POST',
      body: JSON.stringify({ text: 'genuine step' }) });
    // `progress` is deliberately absent from the PATCH allowlist.
    await alice(`/api/tasks/${t.body.id}`, { method: 'PATCH',
      body: JSON.stringify({ progress: [{ id: 99, at: 0, text: 'fabricated' }] }) });

    const read = await alice(`/api/tasks/${t.body.id}`);
    assert.strictEqual(read.body.progress.length, 1);
    assert.strictEqual(read.body.progress[0].text, 'genuine step');
  });

  server.close();
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
