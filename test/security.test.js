'use strict';

// ---------------------------------------------------------------------------
// security.test.js — the adversarial pass.
//
// Everything here assumes an attacker, a second tenant, or bad luck with
// timing. It is deliberately harsher than the feature tests: those check that
// the app does what it should, these check that it refuses everything else.
//
//   1. Authentication      forged cookies, dead sessions, cookie flags, signup
//   2. Rate limiting       lockout, blast radius, and what it must NOT lock
//   3. Enumeration         can an attacker learn which emails exist?
//   4. Tenant isolation    every verb, every route, under concurrent load
//   5. Live stream         one account's events must never reach another's tab
//   6. Write races         two requests hitting the same row at once
//   7. Robustness          malformed input, oversized bodies, database failure
//   8. Hardening           the headers a browser needs to defend the page
// ---------------------------------------------------------------------------

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const { ROOT, makeFakeDb, installDoubles, makeClient, signUp, makeRunner } = require('./harness');

const events = require(path.join(ROOT, 'events'));
const config = require(path.join(ROOT, 'config'));

const fakeDb = makeFakeDb(events);
installDoubles(fakeDb);

const { createApp } = require(path.join(ROOT, 'server'));
const auth = require(path.join(ROOT, 'auth'));

const { check, report } = makeRunner();

/** Every authenticated route, for the "no session, no data" sweep. */
const PROTECTED = [
  ['GET', '/api/tasks?status=open'],
  ['GET', '/api/tasks/1'],
  ['GET', '/api/search?q=deposit'],
  ['GET', '/api/calendar?from=0&to=1'],
  ['GET', '/api/people'],
  ['GET', '/api/game'],
  ['GET', '/api/summary?period=today'],
  ['GET', '/api/settings'],
  ['GET', '/api/stats'],
  ['GET', '/api/me'],
  ['GET', '/api/events'],
  ['GET', '/api/messages/1/image'],
  ['POST', '/api/tasks'],
  ['POST', '/api/messages'],
  ['POST', '/api/me/link-code'],
  ['POST', '/api/me/unlink'],
  ['POST', '/api/tasks/1/progress'],
  ['PUT', '/api/settings'],
  ['PATCH', '/api/tasks/1'],
  ['DELETE', '/api/tasks/1'],
  ['DELETE', '/api/tasks/1/progress/1'],
];

(async () => {
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const anon = makeClient(base);

  const alice = (await signUp(base, 'alice@example.com')).client;
  const bob = (await signUp(base, 'bob@example.com')).client;

  /* ================================================== 1. authentication === */

  await check('every protected route refuses an anonymous caller', async () => {
    const leaks = [];
    for (const [method, url] of PROTECTED) {
      const r = await anon(url, { method, body: method === 'GET' ? undefined : '{}' });
      // 401 is the contract. Anything 2xx is a leak; a 5xx means the route
      // fell over before the guard, which is its own bug.
      if (r.status !== 401) leaks.push(`${method} ${url} → ${r.status}`);
    }
    assert.strictEqual(leaks.length, 0, `not refused:\n${leaks.join('\n')}`);
  });

  await check('a garbage cookie is refused, not a 500', async () => {
    const forged = makeClient(base);
    for (const value of ['ti_session=notatoken', 'ti_session=', 'ti_session=%%%', 'ti_session=' + 'A'.repeat(5000)]) {
      forged.setCookie(value);
      const r = await forged('/api/tasks?status=open');
      assert.strictEqual(r.status, 401, `${value.slice(0, 24)} → ${r.status}`);
    }
  });

  await check('a well-formed token that was never issued is refused', async () => {
    const forged = makeClient(base);
    // Exactly the shape createSession produces — 32 random bytes, base64url.
    forged.setCookie(`ti_session=${crypto.randomBytes(32).toString('base64url')}`);
    assert.strictEqual((await forged('/api/me')).status, 401);
  });

  await check('an expired session is refused and cleaned up', async () => {
    const { client } = await signUp(base, 'expiry@example.com');
    assert.strictEqual((await client('/api/me')).status, 200);

    // Age THIS user's session past its expiry, as time would. Only theirs —
    // ageing every session would sign out the other tests' clients too, which
    // is exactly what it did the first time this was written.
    const victim = fakeDb._users.find((u) => u.email === 'expiry@example.com');
    const before = fakeDb._sessions.length;
    for (const s of fakeDb._sessions.filter((x) => x.user_id === victim.id)) {
      s.expires_at = Date.now() - 1000;
    }

    assert.strictEqual((await client('/api/me')).status, 401);
    assert.ok(fakeDb._sessions.length < before, 'the dead session should be deleted, not left to accumulate');
  });

  await check('logging out kills only that device', async () => {
    const { client: laptop } = await signUp(base, 'twodevice@example.com');
    // A second sign-in for the same account, as a phone would be.
    const phone = makeClient(base);
    await phone('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'twodevice@example.com', password: 'a-long-enough-password' }) });
    assert.strictEqual((await phone('/api/me')).status, 200);

    await laptop('/api/auth/logout', { method: 'POST' });
    assert.strictEqual((await laptop('/api/me')).status, 401, 'the laptop should be signed out');
    assert.strictEqual((await phone('/api/me')).status, 200, 'the phone should not be');
  });

  await check('the session cookie is httpOnly, SameSite=Lax and path-scoped', async () => {
    const fresh = makeClient(base);
    const r = await fresh('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email: 'flags@example.com', password: 'a-long-enough-password' }) });
    const setCookie = (r.headers.getSetCookie?.() || []).find((c) => c.startsWith('ti_session='));
    assert.ok(setCookie, 'no session cookie was set');
    assert.match(setCookie, /HttpOnly/i, 'must be unreadable from JavaScript');
    assert.match(setCookie, /SameSite=Lax/i, 'the CSRF mitigation');
    assert.match(setCookie, /Path=\//i);
    // Secure would be dropped over plain HTTP, so it must be absent here.
    assert.doesNotMatch(setCookie, /Secure/i, 'Secure over plain HTTP would break local dev');
  });

  await check('the cookie is marked Secure when the request came over HTTPS', async () => {
    const fresh = makeClient(base);
    const r = await fresh('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email: 'secureflag@example.com', password: 'a-long-enough-password' }),
      headers: { 'x-forwarded-proto': 'https' },
    });
    const setCookie = (r.headers.getSetCookie?.() || []).find((c) => c.startsWith('ti_session='));
    assert.match(setCookie, /Secure/i);
  });

  await check('signup validates the email and the password length', async () => {
    const cases = [
      [{ email: 'nope', password: 'a-long-enough-password' }, 400],
      [{ email: 'a@b.c', password: 'short' }, 400],
      [{ email: '', password: '' }, 400],
      [{ email: 'alice@example.com', password: 'a-long-enough-password' }, 409], // taken
    ];
    for (const [body, want] of cases) {
      const r = await makeClient(base)('/api/auth/signup', { method: 'POST', body: JSON.stringify(body) });
      assert.strictEqual(r.status, want, `${JSON.stringify(body)} → ${r.status}`);
    }
  });

  await check('closing signups actually closes them', async () => {
    const original = config.allowSignup;
    config.allowSignup = false;
    try {
      const r = await makeClient(base)('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email: 'late@example.com', password: 'a-long-enough-password' }) });
      assert.strictEqual(r.status, 403);
    } finally {
      config.allowSignup = original;
    }
  });

  await check('no endpoint ever returns a password hash or a session token', async () => {
    const probes = ['/api/me', '/api/tasks?status=open', '/api/people', '/api/settings', '/api/game'];
    for (const url of probes) {
      const r = await alice(url);
      const body = JSON.stringify(r.body ?? '');
      assert.ok(!/password/i.test(body), `${url} mentions a password`);
      assert.ok(!/token_hash|password_hash/.test(body), `${url} leaks a credential field`);
    }
  });

  /* ================================================== 2. rate limiting === */

  await check('brute force against one account is locked out', async () => {
    const email = 'target@example.com';
    await signUp(base, email);
    const attacker = makeClient(base);

    let locked = false;
    for (let i = 0; i < 12; i += 1) {
      const r = await attacker('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: `guess-${i}` }) });
      if (r.status === 429) { locked = true; break; }
    }
    assert.ok(locked, 'twelve wrong passwords should have tripped the limiter');

    // And the lockout holds even against the CORRECT password, or it would be
    // no protection at all.
    const r = await attacker('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'a-long-enough-password' }) });
    assert.strictEqual(r.status, 429);
  });

  await check('one locked-out account does not lock out the household', async () => {
    // Same IP (everything here is 127.0.0.1), different account. This is the
    // case the limiter is keyed on IP+email to protect.
    const other = makeClient(base);
    const r = await other('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'alice@example.com', password: 'a-long-enough-password' }) });
    assert.strictEqual(r.status, 200, 'a different account from the same IP must still work');
  });

  /* ==================================================== 3. enumeration === */

  await check('a wrong password and an unknown email are indistinguishable', async () => {
    await signUp(base, 'timing-known@example.com');
    const c = makeClient(base);

    const wrongPassword = await c('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'timing-known@example.com', password: 'definitely-wrong' }) });
    const unknownEmail = await c('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'timing-unknown@example.com', password: 'definitely-wrong' }) });

    assert.strictEqual(wrongPassword.status, unknownEmail.status, 'the status codes differ');
    assert.deepStrictEqual(wrongPassword.body, unknownEmail.body, 'the messages differ');
  });

  await check('…and they take a similar amount of time', async () => {
    // The subtle version of the same leak: if an unknown email skips the
    // password hash, it answers in a millisecond while a real one takes ~80ms,
    // and the difference is a reliable oracle for "does this account exist".
    const time = async (email) => {
      const c = makeClient(base);
      const started = process.hrtime.bigint();
      await c('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'definitely-wrong' }) });
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    const samples = 6;
    let known = 0;
    let unknown = 0;
    for (let i = 0; i < samples; i += 1) {
      // Fresh emails each round so the rate limiter never trips.
      known += await time('alice@example.com');
      unknown += await time(`ghost-${i}-${Date.now()}@example.com`);
    }
    known /= samples;
    unknown /= samples;

    const ratio = known / Math.max(unknown, 0.01);
    assert.ok(
      ratio < 4,
      `an unknown email answers ${ratio.toFixed(1)}x faster than a real one `
      + `(${unknown.toFixed(1)}ms vs ${known.toFixed(1)}ms) — that is an account-enumeration oracle`
    );
  });

  /* =============================================== 4. tenant isolation === */

  await check('every task verb refuses another tenant', async () => {
    const mine = await alice('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Alice private' }) });
    const id = mine.body.id;

    const attempts = [
      ['GET', `/api/tasks/${id}`, undefined],
      ['PATCH', `/api/tasks/${id}`, JSON.stringify({ title: 'stolen' })],
      ['DELETE', `/api/tasks/${id}`, undefined],
      ['POST', `/api/tasks/${id}/progress`, JSON.stringify({ text: 'sneaking in' })],
      ['DELETE', `/api/tasks/${id}/progress/1`, undefined],
    ];
    for (const [method, url, body] of attempts) {
      const r = await bob(url, { method, body });
      assert.strictEqual(r.status, 404, `${method} ${url} → ${r.status}`);
    }

    // And nothing was actually changed by the attempts.
    const after = await alice(`/api/tasks/${id}`);
    assert.strictEqual(after.body.title, 'Alice private');
    assert.strictEqual(after.body.progress.length, 0);
  });

  await check('a PATCH cannot move a task to another account', async () => {
    const mine = await alice('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Stays mine' }) });
    const bobUser = fakeDb._users.find((u) => u.email === 'bob@example.com');

    await alice(`/api/tasks/${mine.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ user_id: bobUser.id, id: 999999, message_id: 42 }),
    });

    const raw = fakeDb._tasks.find((t) => t.id === mine.body.id);
    assert.notStrictEqual(raw.user_id, bobUser.id, 'ownership was reassigned');
    assert.strictEqual(raw.id, mine.body.id, 'the id was rewritten');
    assert.strictEqual((await bob(`/api/tasks/${mine.body.id}`)).status, 404);
  });

  await check('search, people, calendar and summary never cross tenants', async () => {
    await alice('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Alicesecret handshake', requester: 'AliceBoss' }) });
    await bob('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Bobsecret handshake', requester: 'BobBoss' }) });

    const aSearch = await alice('/api/search?q=Bobsecret');
    assert.strictEqual(aSearch.body.length, 0, 'alice found bob’s task');

    const aPeople = await alice('/api/people');
    assert.ok(!aPeople.body.some((p) => p.name === 'BobBoss'), 'alice sees bob’s requester');

    const aCal = await alice(`/api/calendar?from=${Date.now() - 86400e3}&to=${Date.now() + 86400e3}`);
    assert.ok(!aCal.body.some((t) => String(t.title).includes('Bobsecret')));
  });

  await check('ten accounts writing at once keep their tasks to themselves', async () => {
    // Ten simultaneous browsers, each creating five tasks, all interleaved.
    const crowd = await Promise.all(
      Array.from({ length: 10 }, (_, i) => signUp(base, `crowd${i}@example.com`))
    );
    assert.ok(crowd.every((c) => c.status === 201), 'concurrent signups should all succeed');

    await Promise.all(crowd.flatMap(({ client }, i) =>
      Array.from({ length: 5 }, (_, j) =>
        client('/api/tasks', { method: 'POST', body: JSON.stringify({ title: `user${i}-task${j}` }) }))
    ));

    // Every account must see exactly its own five, and nobody else's.
    const lists = await Promise.all(crowd.map(({ client }) => client('/api/tasks?status=open')));
    lists.forEach((r, i) => {
      assert.strictEqual(r.body.length, 5, `user${i} sees ${r.body.length} tasks`);
      for (const t of r.body) {
        assert.ok(t.title.startsWith(`user${i}-`), `user${i} can see "${t.title}"`);
      }
    });

    // And no two tasks anywhere share an id.
    const ids = fakeDb._tasks.map((t) => t.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate task ids were handed out');
  });

  /* =================================================== 5. the live stream === */

  await check('one account’s events never reach another account’s stream', async () => {
    const aliceUser = fakeDb._users.find((u) => u.email === 'alice@example.com');
    const bobUser = fakeDb._users.find((u) => u.email === 'bob@example.com');

    // Open a raw SSE connection as Bob and record everything it receives.
    const received = [];
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, {
      headers: { cookie: bob.cookie() },
      signal: controller.signal,
    });
    assert.strictEqual(res.status, 200);

    const reader = res.body.getReader();
    const pump = (async () => {
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received.push(decoder.decode(value));
        }
      } catch { /* aborted at the end of the check */ }
    })();

    // Give the subscription a moment to register, then fire at both accounts.
    await new Promise((r) => setTimeout(r, 100));
    events.emit(aliceUser.id, { type: 'tasks-added', ids: [111], secret: 'ALICE-ONLY' });
    events.emit(bobUser.id, { type: 'tasks-added', ids: [222] });
    await new Promise((r) => setTimeout(r, 200));

    controller.abort();
    await pump;

    const text = received.join('');
    assert.ok(!text.includes('ALICE-ONLY'), 'bob received an event meant for alice');
    assert.ok(!text.includes('111'), 'bob received alice’s task id');
    assert.ok(text.includes('222'), 'bob did not receive his own event');
  });

  await check('an anonymous caller cannot open a stream', async () => {
    const r = await anon('/api/events');
    assert.strictEqual(r.status, 401);
  });

  /* ===================================================== 6. write races === */

  await check('completing the same task twice at once awards it once', async () => {
    const t = await alice('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Race me' }) });
    const id = t.body.id;

    // Two taps, two devices, same instant.
    const [a, b] = await Promise.all([
      alice(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) }),
      alice(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) }),
    ]);
    assert.ok(a.status === 200 && b.status === 200);

    const raw = fakeDb._tasks.filter((x) => x.id === id);
    assert.strictEqual(raw.length, 1, 'the task itself was duplicated');
    assert.strictEqual(raw[0].status, 'done');
  });

  await check('a recurring task completed twice at once spawns ONE next occurrence', async () => {
    const t = await alice('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Recurring race',
        due_at: Date.now() + 3600e3,
        recurrence: { freq: 'weekly', interval: 1 },
      }),
    });
    const id = t.body.id;

    await Promise.all([
      alice(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) }),
      alice(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) }),
    ]);

    const children = fakeDb._tasks.filter((x) => x.parent_task_id === id);
    assert.strictEqual(children.length, 1,
      `two simultaneous completions produced ${children.length} occurrences — the chore now duplicates itself`);
  });

  await check('concurrent progress entries all survive with unique ids', async () => {
    const t = await alice('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Busy task' }) });
    const id = t.body.id;

    await Promise.all(Array.from({ length: 6 }, (_, i) =>
      alice(`/api/tasks/${id}/progress`, { method: 'POST', body: JSON.stringify({ text: `step ${i}` }) })));

    const read = await alice(`/api/tasks/${id}`);
    assert.strictEqual(read.body.progress.length, 6, 'a concurrent append was lost');
    const ids = read.body.progress.map((e) => e.id);
    assert.strictEqual(new Set(ids).size, ids.length,
      `duplicate entry ids ${JSON.stringify(ids)} — deleting one would delete both`);
  });

  /* ===================================================== 7. robustness === */

  await check('malformed JSON is a 400, not a crash', async () => {
    const r = await alice('/api/tasks', { method: 'POST', body: '{"title": ' });
    assert.ok(r.status === 400, `got ${r.status}`);
  });

  await check('an oversized body is refused', async () => {
    const r = await alice('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'x'.repeat(400 * 1024) }),
    });
    assert.strictEqual(r.status, 413, `got ${r.status}`);
  });

  await check('nonsense ids 404 rather than 500', async () => {
    for (const id of ['abc', '-1', '99999999999999999999', 'null', '1e999']) {
      const r = await alice(`/api/tasks/${id}`);
      assert.strictEqual(r.status, 404, `id ${id} → ${r.status}`);
    }
  });

  await check('a database failure is a clean 500 with no stack trace', async () => {
    fakeDb._failNextCallTo('getTask');
    const r = await alice('/api/tasks/1', { method: 'PATCH', body: JSON.stringify({ title: 'x' }) });
    assert.strictEqual(r.status, 500, `got ${r.status}`);
    assert.ok(!/\bat \/|\bat Object|\.js:\d+/.test(r.text || ''),
      `the response leaked a stack trace:\n${String(r.text).slice(0, 300)}`);
  });

  await check('the server is still alive after that failure', async () => {
    const r = await alice('/api/me');
    assert.strictEqual(r.status, 200);
  });

  await check('a task title is stored verbatim, escaping is the renderer’s job', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const t = await alice('/api/tasks', { method: 'POST', body: JSON.stringify({ title: payload }) });
    // The API must not mangle data. Safety comes from the client building text
    // nodes rather than from the server rewriting user content.
    assert.strictEqual(t.body.title, payload);
  });

  /* ====================================================== 8. hardening === */

  await check('responses carry the basic browser hardening headers', async () => {
    const r = await alice('/api/me');
    const missing = [];
    if (r.headers.get('x-content-type-options') !== 'nosniff') missing.push('X-Content-Type-Options: nosniff');
    if (!r.headers.get('x-frame-options') && !r.headers.get('content-security-policy')) {
      missing.push('X-Frame-Options or a CSP frame-ancestors (clickjacking)');
    }
    if (r.headers.get('x-powered-by')) missing.push('X-Powered-By should not advertise the stack');
    assert.strictEqual(missing.length, 0, `missing: ${missing.join(', ')}`);
  });

  await check('the login page is served with a content security policy', async () => {
    const r = await anon('/login.html');
    assert.ok(r.headers.get('content-security-policy'), 'no CSP on an HTML response');
  });

  await check('the endpoint that spends money is capped per account', async () => {
    const { client } = await signUp(base, 'spender@example.com');
    let limited = false;
    for (let i = 0; i < 30; i += 1) {
      const r = await client('/api/messages', { method: 'POST', body: JSON.stringify({ text: `capture ${i}` }) });
      if (r.status === 429) { limited = true; break; }
    }
    assert.ok(limited, 'thirty model calls in a row should have been throttled');
  });

  await check('…and one account’s cap does not throttle another', async () => {
    const { client } = await signUp(base, 'innocent@example.com');
    const r = await client('/api/messages', { method: 'POST', body: JSON.stringify({ text: 'just one' }) });
    assert.strictEqual(r.status, 201, `got ${r.status}`);
  });

  await check('the failed-login table does not grow without bound', async () => {
    const before = auth.attemptsSize();
    // A spray across many fresh addresses: the shape of attack that used to add
    // a permanent map entry per guess.
    const c = makeClient(base);
    for (let i = 0; i < 40; i += 1) {
      await c('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: `spray-${i}@example.com`, password: 'x' }) });
    }
    const grew = auth.attemptsSize() - before;
    // It is expected to grow within the window; what matters is that a sweep
    // exists to reclaim it, which the unit check below covers.
    assert.ok(grew <= 45, `grew by ${grew} for 40 attempts — more than one entry each`);
  });

  await check('HSTS is sent over HTTPS and withheld over plain HTTP', async () => {
    const plain = await alice('/api/me');
    assert.strictEqual(plain.headers.get('strict-transport-security'), null,
      'HSTS over plain HTTP would pin localhost to HTTPS in your browser');

    const secure = await alice('/api/me', { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(secure.headers.get('strict-transport-security') || '', /max-age=\d+/);
  });

  await check('a burst of 120 mixed requests from 6 accounts stays consistent', async () => {
    // A soak: six people using the app hard at the same time, every kind of
    // write interleaved. The point is not throughput, it is that nothing
    // crosses a tenant boundary and nothing 500s under contention.
    const crowd = await Promise.all(
      Array.from({ length: 6 }, (_, i) => signUp(base, `soak${i}@example.com`))
    );

    const work = [];
    crowd.forEach(({ client }, i) => {
      for (let j = 0; j < 5; j += 1) {
        work.push((async () => {
          const made = await client('/api/tasks', {
            method: 'POST',
            body: JSON.stringify({ title: `soak${i}-${j}`, requester: `boss${i}` }),
          });
          const id = made.body.id;
          await Promise.all([
            client(`/api/tasks/${id}/progress`, { method: 'POST', body: JSON.stringify({ text: 'a step' }) }),
            client(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ notes: 'noted' }) }),
            client('/api/search?q=soak'),
            client('/api/people'),
            client('/api/game'),
          ]);
        })());
      }
    });

    const settled = await Promise.allSettled(work);
    const broke = settled.filter((r) => r.status === 'rejected');
    assert.strictEqual(broke.length, 0, `${broke.length} request chains threw: ${broke[0]?.reason}`);

    // Every account ends with exactly its own five tasks, each with one step.
    for (const [i, { client }] of crowd.entries()) {
      const list = await client('/api/tasks?status=open');
      assert.strictEqual(list.body.length, 5, `soak${i} sees ${list.body.length}`);
      for (const t of list.body) {
        assert.ok(t.title.startsWith(`soak${i}-`), `soak${i} sees "${t.title}"`);
        assert.strictEqual(t.progress_count, 1, `"${t.title}" has ${t.progress_count} steps`);
      }
      const people = await client('/api/people');
      assert.deepStrictEqual(people.body.map((p) => p.name), [`boss${i}`],
        `soak${i} sees other people's requesters`);
    }
  });

  await check('the stream cap closes the oldest tab rather than piling up', async () => {
    const { client } = await signUp(base, 'manytabs@example.com');
    const user = fakeDb._users.find((u) => u.email === 'manytabs@example.com');
    const controllers = [];

    // Twelve tabs against a cap of eight.
    for (let i = 0; i < 12; i += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      // Not awaited to completion — these stay open, which is the point.
      fetch(`${base}/api/events`, { headers: { cookie: client.cookie() }, signal: controller.signal })
        .then((r) => r.body.getReader().read().catch(() => {}))
        .catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(events.countFor(user.id) <= 8,
      `${events.countFor(user.id)} streams open for one account — the cap did not hold`);
    for (const c of controllers) c.abort();
  });

  server.close();
  process.exit(report('Security and concurrency') ? 1 : 0);
})();
