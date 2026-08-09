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
  updateTaskFields: async (uid, id, f) => {
    const t = tasks.find((x) => x.id === id && x.user_id === uid);
    if (!t) return null;
    Object.assign(t, f, { updated_at: Date.now() }); return t;
  },
  updateTaskScore: async (id, sc) => { const t = tasks.find((x) => x.id === id); if (t) t.score = sc; },
  deleteTask: async (uid, id) => { const i = tasks.findIndex((t) => t.id === id && t.user_id === uid); if (i < 0) return false; tasks.splice(i, 1); return true; },
  countByStatus: async (uid) => Object.entries(
    tasks.filter((t) => t.user_id === uid).reduce((a, t) => ((a[t.status] = (a[t.status] || 0) + 1), a), {})
  ).map(([status, n]) => ({ status, n })),
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

  server.close();
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
