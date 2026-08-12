'use strict';

// ---------------------------------------------------------------------------
// harness.js — shared scaffolding for the integration suites.
//
// Provides an in-memory stand-in for db.js that behaves like MongoDB where the
// behaviour matters (unique-index violations as code 11000, the field allowlist
// on updates, per-tenant filtering), a way to mount the real server on a random
// port, and a cookie-aware fetch so a test can act like a browser.
//
// The double deliberately mirrors the real db.js rather than being permissive.
// A lenient double makes the tests that exist to prove a restriction pass for
// the wrong reason — which has already happened once here, with the field
// allowlist.
// ---------------------------------------------------------------------------

const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');

/**
 * Mongo's duplicate-key error, which several code paths branch on.
 *
 * keyPattern names WHICH index rejected the write, and the real driver always
 * supplies it. The double omitted it, which let server.js get away with
 * treating every 11000 on `users` as an email collision — a shortcut that
 * later reported a broken tg_chat_id index as "that email is already
 * registered". Callers must say which index they are simulating.
 */
const dupKey = (keyPattern) =>
  Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern });

/** The same allowlist db.js applies to PATCH. Kept in step deliberately. */
const TASK_UPDATE_ALLOWLIST = [
  'title', 'details', 'requester', 'requester_rank', 'category',
  'due_at', 'due_text', 'urgency', 'importance', 'effort_minutes',
  'status', 'snooze_until', 'completed_at', 'score',
  'recurrence', 'recurrence_text', 'waiting_on', 'dup_of', 'notes',
  'nudged_at', 'edited_at',
];

const DEFAULT_SETTINGS = {
  seniors: [], digest_enabled: true, digest_hour: 8, nudge_enabled: true,
  nudge_lead_minutes: 60, weekly_enabled: true, weekly_weekday: 0,
  weekly_hour: 18, daily_goal: 5,
};

/**
 * Build a fresh in-memory database.
 *
 * `events` is injected so the double can emit exactly where the real
 * insertTasks does — the push channel is part of what these suites test.
 */
function makeFakeDb(events) {
  const users = [];
  const sessions = [];
  const tasks = [];
  const messages = [];
  const usage = [];
  const state = new Map();
  const seq = { users: 0, tasks: 0, messages: 0 };

  // Lets a test make one call fail, to check the server's error handling.
  let failNext = null;
  const maybeFail = (name) => {
    if (failNext === name) {
      failNext = null;
      throw new Error('simulated database failure');
    }
  };

  const db = {
    /* --- test controls, not part of the real db.js surface --- */
    _users: users, _tasks: tasks, _sessions: sessions, _messages: messages, _usage: usage,
    _failNextCallTo: (name) => { failNext = name; },

    connect: async () => {}, close: async () => {},
    getState: async (k) => state.get(k) ?? null,
    setState: async (k, v) => void state.set(k, String(v)),

    createUser: async ({ email, password_hash }) => {
      const clean = email.toLowerCase().trim();
      if (users.some((u) => u.email === clean)) throw dupKey({ email: 1 });
      const doc = {
        id: ++seq.users, email: clean, password_hash, tg_chat_id: null,
        link_code: null, link_code_expires: null,
        settings: { ...DEFAULT_SETTINGS }, created_at: Date.now(),
      };
      users.push(doc);
      return doc;
    },
    getUser: async (id) => users.find((u) => u.id === id) ?? null,
    getUserByEmail: async (e) => users.find((u) => u.email === String(e).toLowerCase().trim()) ?? null,
    getUserByChatId: async (c) => users.find((u) => u.tg_chat_id === c) ?? null,
    getUserByLinkCode: async (c) => users.find((u) => u.link_code === String(c).toUpperCase()) ?? null,
    countUsers: async () => users.length,
    updateUser: async (id, f) => {
      const u = users.find((x) => x.id === id);
      if (!u) return null;
      if (f.tg_chat_id != null && users.some((x) => x.id !== id && x.tg_chat_id === f.tg_chat_id)) {
        // The unique index on tg_chat_id. Partial, not sparse: it covers only
        // documents whose tg_chat_id is a number, so the many unlinked
        // accounts (tg_chat_id: null) never collide with each other. The
        // `!= null` guard above is what models that.
        throw dupKey({ tg_chat_id: 1 });
      }
      Object.assign(u, f);
      return u;
    },

    insertSession: async (d) => void sessions.push(d),
    findSession: async (h) => sessions.find((s) => s.token_hash === h) ?? null,
    deleteSession: async (h) => {
      const i = sessions.findIndex((s) => s.token_hash === h);
      if (i >= 0) sessions.splice(i, 1);
    },
    deleteUserSessions: async (uid) => {
      for (let i = sessions.length - 1; i >= 0; i -= 1) {
        if (sessions[i].user_id === uid) sessions.splice(i, 1);
      }
    },

    insertMessage: async (m) => {
      if (m.tg_message_id != null
        && messages.some((x) => x.tg_chat_id === m.tg_chat_id && x.tg_message_id === m.tg_message_id)) {
        return null;
      }
      const doc = { id: ++seq.messages, status: 'pending', tg_message_id: null, tg_chat_id: null, ...m };
      messages.push(doc);
      return doc;
    },
    getMessage: async (id) => messages.find((m) => m.id === id) ?? null,
    listPendingMessages: async () => messages.filter((m) => m.status === 'pending'),
    setMessageStatus: async (id, st, e = null) => {
      const m = messages.find((x) => x.id === id);
      if (m) Object.assign(m, { status: st, error: e });
    },

    insertTasks: async (uid, mid, rows) => {
      const docs = rows.map((t) => ({
        id: ++seq.tasks, user_id: uid, message_id: mid, status: 'open',
        created_at: Date.now(), updated_at: Date.now(), snooze_until: null,
        completed_at: null, details: null, requester: null, requester_rank: 'unknown',
        due_at: null, due_text: null, urgency: 3, importance: 3, effort_minutes: null,
        category: 'other', recurrence: null, recurrence_text: null, parent_task_id: null,
        waiting_on: false, dup_of: null, notes: null, nudged_at: null, edited_at: null,
        progress: [], progress_at: null, score: 0, ...t,
      }));
      tasks.push(...docs);
      // Mirrors the emit in the real insertTasks.
      if (docs.length > 0 && events) {
        events.emit(uid, { type: 'tasks-added', ids: docs.map((d) => d.id) });
      }
      return docs;
    },
    getTask: async (uid, id) => {
      maybeFail('getTask');
      return tasks.find((t) => t.id === id && t.user_id === uid) ?? null;
    },
    listTasksByStatus: async (uid, st) => tasks
      .filter((t) => t.user_id === uid && t.status === st)
      .sort((a, b) => b.score - a.score),
    listAllTasks: async (uid) => tasks.filter((t) => t.user_id === uid),
    listTasksByStatusAllUsers: async (st) => tasks.filter((t) => t.status === st),

    updateTaskFields: async (uid, id, f) => {
      const t = tasks.find((x) => x.id === id && x.user_id === uid);
      if (!t) return null;
      for (const [k, v] of Object.entries(f)) {
        if (TASK_UPDATE_ALLOWLIST.includes(k)) t[k] = v;
      }
      t.updated_at = Date.now();
      return t;
    },
    // Mirrors the real conditional update: only the first caller wins.
    completeTaskAtomically: async (uid, id, now = Date.now()) => {
      const t = tasks.find((x) => x.id === id && x.user_id === uid);
      if (!t || t.status === 'done') return null;
      // The await is deliberate: it forces an interleaving point, so a test
      // with two concurrent completions really exercises the race. The status
      // is set BEFORE it, exactly as an atomic findOneAndUpdate would.
      t.status = 'done';
      t.completed_at = now;
      t.updated_at = now;
      await new Promise((r) => setImmediate(r));
      return t;
    },
    updateTaskScore: async (id, sc) => {
      const t = tasks.find((x) => x.id === id);
      if (t) t.score = sc;
    },
    deleteTask: async (uid, id) => {
      const i = tasks.findIndex((t) => t.id === id && t.user_id === uid);
      if (i < 0) return false;
      tasks.splice(i, 1);
      return true;
    },
    countByStatus: async (uid) => Object.entries(
      tasks.filter((t) => t.user_id === uid)
        .reduce((a, t) => ((a[t.status] = (a[t.status] || 0) + 1), a), {})
    ).map(([status, n]) => ({ status, n })),

    DEFAULT_SETTINGS,
    settingsOf: (u) => ({ ...DEFAULT_SETTINGS, ...(u?.settings || {}) }),
    listUsersWithChat: async () => users.filter((u) => u.tg_chat_id != null),

    searchTasks: async (uid, q) => tasks.filter((t) => t.user_id === uid
      && [t.title, t.details, t.requester, t.notes]
        .some((f) => f && f.toLowerCase().includes(q.toLowerCase()))),
    listTasksDueBetween: async (uid, from, to, st = ['open', 'snoozed']) => tasks.filter((t) =>
      t.user_id === uid && st.includes(t.status) && t.due_at != null && t.due_at >= from && t.due_at < to),
    listTasksCompletedBetween: async (uid, from, to) => tasks.filter((t) =>
      t.user_id === uid && t.status === 'done' && t.completed_at >= from && t.completed_at < to),
    listTasksCreatedBetween: async (uid, from, to) => tasks.filter((t) =>
      t.user_id === uid && t.created_at >= from && t.created_at < to),
    completionTimes: async (uid) => tasks
      .filter((t) => t.user_id === uid && t.status === 'done' && t.completed_at)
      .map((t) => ({ completed_at: t.completed_at, score: t.score })),
    groupByRequester: async (uid) => {
      const map = new Map();
      for (const t of tasks.filter((x) => x.user_id === uid && ['open', 'snoozed'].includes(x.status))) {
        const key = t.requester ?? null;
        const g = map.get(key) || { _id: key, n: 0, top_score: 0, rank: t.requester_rank, waiting: 0 };
        g.n += 1;
        g.top_score = Math.max(g.top_score, t.score);
        if (t.waiting_on) g.waiting += 1;
        map.set(key, g);
      }
      return [...map.values()].sort((a, b) => b.top_score - a.top_score);
    },
    recentOpenTaskSummaries: async (uid) => tasks
      .filter((t) => t.user_id === uid && t.status === 'open')
      .map((t) => ({ id: t.id, title: t.title, requester: t.requester, due_at: t.due_at })),
    recentMessagesForChat: async () => [],
    listNudgeCandidates: async () => [],

    /* --- the API-spend ledger --- */
    recordUsage: async (uid, row) => void usage.push({ user_id: uid, ...row }),
    // Mirrors the real $facet aggregation closely enough to prove the tenancy
    // boundary and the response shape. The arithmetic is deliberately
    // reimplemented rather than shared with db.js: a double that delegated to
    // the real summariser would still pass if the real query lost its
    // user_id filter, which is the one thing this most needs to catch.
    usageSummary: async (uid, from, to) => {
      if (uid === undefined) throw new Error('usageSummary: pass a user id, or null for all accounts');
      // null means every account — the operator's monitor. Mirrored here so a
      // test can prove the admin route really does cross the boundary, and
      // that the non-admin route never reaches this branch.
      const rows = usage.filter((r) =>
        (uid === null || r.user_id === uid) && r.at >= from && r.at <= to);
      const tot = (list) => list.reduce((a, r) => ({
        calls: a.calls + 1,
        input_tokens: a.input_tokens + (r.input_tokens || 0),
        output_tokens: a.output_tokens + (r.output_tokens || 0),
        cache_read_input_tokens: a.cache_read_input_tokens + (r.cache_read_input_tokens || 0),
        cache_creation_input_tokens:
          a.cache_creation_input_tokens + (r.cache_creation_input_tokens || 0),
        cost_usd: a.cost_usd + (r.cost_usd || 0),
      }), {
        calls: 0, input_tokens: 0, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0,
      });
      const groupBy = (key) => {
        const map = new Map();
        for (const r of rows) {
          const k = typeof key === 'function' ? key(r) : r[key];
          map.set(k, [...(map.get(k) ?? []), r]);
        }
        return [...map].map(([_id, list]) => ({ _id, ...tot(list) }));
      };
      // The sort orders matter and are mirrored from the real $facet: the page
      // presents these lists in the order it receives them, so a double that
      // returned insertion order would let an ordering bug pass here.
      const byCost = (a, b) => b.cost_usd - a.cost_usd;
      return {
        overall: rows.length ? [{ _id: null, ...tot(rows) }] : [],
        by_model: groupBy('model').sort(byCost),
        by_day: groupBy((r) => new Date(r.at).toISOString().slice(0, 10))
          .sort((a, b) => (a._id < b._id ? -1 : 1)),
        failures: groupBy('stop_reason')
          .filter((g) => g._id && g._id !== 'end_turn')
          .map((g) => ({ _id: g._id, n: g.calls, cost_usd: g.cost_usd }))
          .sort((a, b) => b.n - a.n),
        by_user: groupBy('user_id').sort(byCost),
      };
    },
    recentUsage: async (uid, limit = 20) => {
      if (uid === undefined) throw new Error('recentUsage: pass a user id, or null for all accounts');
      return usage
        .filter((r) => uid === null || r.user_id === uid)
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
    },
    emailsForIds: async (ids) => users
      .filter((u) => [...ids].includes(u.id))
      .map((u) => ({ id: u.id, email: u.email })),

    addProgress: async (uid, id, text) => {
      const t = tasks.find((x) => x.id === id && x.user_id === uid);
      if (!t) return null;
      t.progress = t.progress || [];
      // Mirrors the real pipeline update: the counter is bumped and the entry
      // appended as one indivisible step, so concurrent appends cannot share
      // an id. The await afterwards still gives the test an interleaving
      // point, proving the atomicity is what protects it rather than luck.
      t.progress_seq = (t.progress_seq || 0) + 1;
      t.progress.push({ id: t.progress_seq, at: Date.now(), text });
      t.progress_at = Date.now();
      await new Promise((r) => setImmediate(r));
      return t;
    },
    deleteProgress: async (uid, id, entryId) => {
      const t = tasks.find((x) => x.id === id && x.user_id === uid);
      if (!t) return null;
      t.progress = (t.progress || []).filter((e) => e.id !== entryId);
      return t;
    },
  };

  return db;
}

/**
 * Swap the real db.js and extractor.js out of the module cache before server.js
 * is required, so the server under test wires itself to the doubles.
 */
function installDoubles(fakeDb, { extractor } = {}) {
  const dbPath = require.resolve(path.join(ROOT, 'db.js'));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

  const exPath = require.resolve(path.join(ROOT, 'extractor.js'));
  require.cache[exPath] = {
    id: exPath,
    filename: exPath,
    loaded: true,
    exports: extractor || {
      // Never call the real model from a test.
      processMessage: async (message) => {
        const saved = await fakeDb.insertTasks(message.user_id, message.id, [{
          title: `Task from: ${String(message.text).slice(0, 40)}`,
          urgency: 3, importance: 3, category: 'other', score: 50, extractor: 'test',
        }]);
        await fakeDb.setMessageStatus(message.id, 'processed');
        return { tasks: saved, note: null };
      },
      processPending: async () => [],
      extractTasks: async () => ({ tasks: [], note: null }),
    },
  };
}

/**
 * A cookie-aware fetch. One instance per simulated browser, so two of them are
 * genuinely two different signed-in sessions.
 */
function makeClient(base) {
  let cookie = '';
  const client = async (p, opts = {}) => {
    const res = await fetch(base + p, {
      redirect: 'manual',
      ...opts,
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(opts.headers || {}),
      },
    });
    for (const c of res.headers.getSetCookie?.() || []) cookie = c.split(';')[0];
    let body = null;
    const text = await res.text();
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }
    return { status: res.status, body, headers: res.headers, text };
  };
  client.cookie = () => cookie;
  client.setCookie = (c) => { cookie = c; };
  return client;
}

/** Sign a fresh account up and return its client and email. */
async function signUp(base, email, password = 'a-long-enough-password') {
  const client = makeClient(base);
  const r = await client('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return { client, email, status: r.status, body: r.body };
}

/** A tiny test runner: named checks, collected results, a final tally. */
function makeRunner() {
  const results = [];
  let pass = 0;
  let fail = 0;

  const check = async (name, fn) => {
    try {
      await fn();
      results.push(`  ✓ ${name}`);
      pass += 1;
    } catch (e) {
      results.push(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`);
      fail += 1;
    }
  };

  const report = (title) => {
    console.log(`\n${title}`);
    console.log(results.join('\n'));
    console.log(`\n${pass} passed, ${fail} failed`);
    return fail;
  };

  return { check, report, counts: () => ({ pass, fail }) };
}

module.exports = { ROOT, makeFakeDb, installDoubles, makeClient, signUp, makeRunner, dupKey };
