# Task Inbox

Forward WhatsApp messages that need action to a Telegram bot → Claude extracts the task(s), estimates urgency/importance/effort and resolves deadlines → tasks land in MongoDB with a deterministic priority score → an iOS-style web app shows them as **P1 / P2 / P3**.

Multi-user: each person signs in with their own account, links their own Telegram chat, and sees only their own tasks.

```
WhatsApp ──(you forward)──▶ Telegram bot ──▶ Claude extractor ──▶ MongoDB ──▶ Dashboard
                                 ▲                                              │
                                 └───────── /done /snooze /drop ◀───────────────┘
```

Your WhatsApp account is never touched — you decide what gets forwarded.

## Setup

1. **MongoDB** — either run a local `mongod`, or create a free cluster on [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) and copy its connection string.
2. **Telegram bot** — message [@BotFather](https://t.me/BotFather), `/newbot`, copy the token.
3. **Claude API key** — from [console.anthropic.com](https://console.anthropic.com).

```sh
cd task-inbox
npm install
cp .env.example .env   # fill in MONGODB_URI, TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, TIMEZONE
npm start
```

Open http://localhost:3200 for the dashboard, then send your bot any message on Telegram. The first chat that messages the bot gets pinned as the only allowed user (or set `TELEGRAM_ALLOWED_CHAT_IDS` explicitly).

## Accounts

Everything is behind a login; the API returns 401 and page loads redirect when
signed out.

1. Open the app and choose **Create an account** (email + password, 10 chars minimum).
2. Once you have created the accounts you need, set `ALLOW_SIGNUP=false` and
   restart so nobody else can register.
3. Each user opens **Account → Link Telegram**, gets a 6-character code, and
   sends `/link CODE` to the bot. That code is single-use and expires in 15
   minutes; it is what ties a Telegram chat to an account.

One bot serves everyone — messages are routed to whichever account that chat is
linked to. A chat that is not linked to any account is told how to link and can
do nothing else.

Passwords are hashed with scrypt and a per-user salt. Sessions are server-side,
stored as SHA-256 hashes (so a database dump cannot be replayed as logins), and
carried in an httpOnly, SameSite=Lax cookie. Failed logins are rate limited per
account and per IP.

### Upgrading from the single-user version

Tasks created before accounts existed have no owner, so no account can see them.
Create your account, then run:

```sh
npm run adopt -- you@example.com
```

That assigns every ownerless task and message to that account, and carries the
previously pinned Telegram chat over to it. It is safe to run twice.

## Daily use

- In WhatsApp: long-press a message → **Forward** → your Telegram bot. (Telegram's "forwarded from" header, when present, is used as the requester.)
- **Text, screenshots and voice notes all work.** A photo is read for the text in it; a voice note is transcribed first (see below).
- The bot replies with what it filed and why it scored the task the way it did.
- The dashboard has a capture box too, so you can file tasks without Telegram.
- Tap any task to open it: edit every field, add notes, set a repeat, and read the original message it came from.

### Bot commands

| Command | What it does |
| --- | --- |
| `/tasks` | Top open tasks |
| `/today` | Due in the next 24h, plus overdue |
| `/waiting` | Things you are chasing somebody else for |
| `/people` | Who your open work is coming from |
| `/done N`, `/snooze N`, `/drop N` | Act on task N |
| `/progress N` | The steps logged on task N so far |
| `/progress N did the thing` | Log another step |
| `/summary [period]` | `today`, `last week`, `30 days`, `2026-08-01..2026-08-11`… |
| `/streak` | Level, XP, current streak |
| `/seniors [add\|remove NAME]` | Who outranks the clock |

### What the bot sends you unprompted

- **Morning digest** at your chosen hour: streak, anything overdue, the top five.
- **Deadline nudge** shortly before something is due (once per task).
- **Weekly review** on Sunday evening.

All three are per-account and switchable in the dashboard's Account sheet. The
scheduler ticks once a minute and records what it has sent in the database, so
a restart never double-sends (`src/scheduler.js`).

### Voice notes

The Claude API takes text and images but not audio, so voice notes need a
speech-to-text service. Point `TRANSCRIBE_URL` at any OpenAI-compatible
`/audio/transcriptions` endpoint — OpenAI's, or a local `whisper.cpp` server,
which is the plan for the Pi. Leave it unset and voice notes are refused with
an explanation; nothing else changes.

## How prioritisation works

Claude only judges the *content*: urgency (1–5), importance (1–5), effort, deadline, and whether you are waiting on somebody else. The 0–100 score is computed locally and re-computed every 5 minutes:

- urgency → up to 30 pts, importance → up to 30 pts
- deadline pressure → up to 30 pts (overdue = max; grows as the deadline nears)
- quick-win bonus (≤15 min) and a small staleness nudge so old tasks resurface
- **authority**: +18 pts and a **floor of 70** for anyone on your seniors list — the floor is exactly the P1 threshold, so their asks are P1 by definition
- **waiting on someone**: −12 pts, and the authority floor does not apply — you cannot finish those by working harder

Because scoring is local, ranks stay explainable, deadlines "heat up" without extra API calls, and you can tune the weights in `src/priority.js`.

### The seniors list

Add a name (`CO`, `Col. Mehta`) in the Account sheet or with `/seniors add CO`.
Anything they ask for is pinned to **P1** regardless of its timeline, and the
tasks they already asked for are re-ranked immediately — not just future ones.
Matching is case-insensitive and works on partial names in both directions, so
`CO` also catches "the CO".

## Recurring tasks

Say "every Tuesday" or "monthly" in the message and the extractor picks it up;
you can also set a repeat by hand in a task's detail sheet. Only **one
occurrence exists at a time** — completing it creates the next. That keeps the
list free of fifty future copies, and skipping a cycle does not leave a pile of
overdue ghosts. The date arithmetic lives in `src/recurrence.js`, including the
January-31st-to-February case, which has a test.

## Progress on multi-step tasks

Most real tasks are not one action, and "not done" is a poor summary of one you
have half finished. Every task carries a **progress log**: timestamped steps you
write yourself, numbered oldest-first so it reads as the story of the task.

- Add one in the task's detail sheet, or with `/progress 7 rang the bank`.
- A row in the list shows `▸ 3 steps`, so a half-done job does not look
  identical to an untouched one.
- A week later the useful question is not "is it done" but **"where had I got
  to?"** — which is exactly what the log answers.

The log is append-only through its own endpoints, and `progress` is deliberately
absent from the PATCH allowlist, so an ordinary task edit cannot rewrite
history. Each task keeps its last 100 steps.

## The game layer

Every completed task is worth XP scaled to its priority score, so clearing the
hard thing beats cherry-picking the easy ones. XP drives a level; consecutive
days with at least one completion drive a streak. None of it is stored — it is
all derived from your completed tasks, so there is no counter to drift out of
sync and nothing to migrate when the formula changes (`src/stats.js`).

A day you have not finished anything *yet* does not break the streak; only a
missed day does.

## Other views

- **Calendar** — the same tasks laid out by deadline, a month at a time. Days with something overdue are tinted red.
- **People** — open work grouped by who asked for it, seniors starred. Tap someone to see just their tasks before you talk to them.
- **Search** — partial-word matching across titles, details, requesters and notes.
- **Stats** — level, streak, lifetime totals, and a summary for any period you pick, including an arbitrary date range.

## Production readiness

`npm test` runs three suites — 102 checks in total:

| Suite | What it covers |
| --- | --- |
| `test/logic.test.js` | Pure logic: recurrence dates, streaks, XP, period parsing, the authority floor |
| `test/auth.test.js` | Accounts, tenancy, and the feature surface end to end |
| `test/security.test.js` | The adversarial pass — see below |

The security suite assumes an attacker, a second tenant, or bad timing:

- **Authentication** — every protected route refuses an anonymous caller; forged, malformed and never-issued cookies; expired sessions (refused *and* deleted); per-device logout; cookie flags (`HttpOnly`, `SameSite=Lax`, `Secure` only over HTTPS).
- **Rate limiting** — brute force is locked out, the lockout holds even against the correct password, and one locked account does **not** lock out others on the same IP.
- **Enumeration** — a wrong password and an unknown email return the same status, the same message, and take the **same amount of time**.
- **Tenant isolation** — every verb on another account's task 404s; a PATCH cannot reassign ownership; search, people, calendar and summary never cross accounts; ten accounts writing concurrently keep their data separate.
- **The live stream** — one account's events never reach another account's tab.
- **Write races** — the same task completed twice at once completes once and spawns one recurrence; concurrent progress entries all survive with unique ids.
- **Robustness** — malformed JSON, oversized bodies, nonsense ids, and a database failure mid-request all produce a clean status with no stack trace, and the process stays up.
- **Load** — 120 interleaved requests across 6 accounts, then every account's data is checked for consistency.

### What the audit changed

- **Unhandled async rejections crashed the process.** Express 4 ignores the promise an `async` handler returns, so one transient database error both hung the request and killed the server. Every handler is now wrapped, with a real error handler behind it.
- **Stack traces leaked.** Express's default error handler returns them whenever `NODE_ENV` is not exactly `production`. There is now an explicit handler: full detail to the log, `{"error":"something went wrong"}` to the client.
- **Login timing was an enumeration oracle.** An unknown email skipped the password hash and answered ~80× faster. It now verifies against a decoy hash so both paths cost the same.
- **Completion was not atomic.** Two taps at once could both pass the "is it done?" check and spawn two copies of a recurring chore. It is now a single conditional update.
- **Progress ids could collide** under concurrent appends, so deleting one entry would delete two. Now generated inside an aggregation-pipeline update (needs MongoDB 4.2+).
- **No security headers.** Added `nosniff`, `X-Frame-Options: DENY`, a strict CSP, `Referrer-Policy`, HSTS over HTTPS only, and `X-Powered-By` removed.
- **Unbounded memory.** The failed-login table grew by one entry per guessed address forever; the SSE registry had no cap. Both are now bounded and swept.
- **No spend limit.** `/api/messages` calls the model, so a stuck retry loop was an unbounded bill. Capped at 20/minute per account.

### Known gaps, deliberately still open

- **No password reset or change.** Forgetting a password currently means editing the database. The next thing to build if this goes to more people.
- **No email verification.** Anyone who can reach the signup page can register any address — which is why you should set `ALLOW_SIGNUP=false` once your accounts exist.
- **Single-process assumptions.** The rate limiter and the SSE subscriber registry live in memory. Correct for one Node process; running two behind a load balancer needs a shared store (Redis, or a Mongo change stream for the events).
- **`TRUST_PROXY` matters more than it looks.** Behind a reverse proxy with it unset, every client appears to come from the proxy's IP, so the IP-wide login cap could lock out everybody at once. Set it to `true` whenever there is a proxy in front.
- **No CSRF token.** `SameSite=Lax` is the whole mitigation. That is sound here — there are no state-changing `GET`s, and every write is a JSON `POST`/`PATCH` that a cross-site form cannot forge — but it is one layer, not two.
- **Photos are stored as base64 in MongoDB.** Fine at personal volume; it will grow faster than text if you forward hundreds of screenshots.
- **No audit log** of who changed what.

## Ops notes

- Messages that fail extraction (API outage etc.) are kept with `status: failed` and retried on boot, or manually via `npm run reprocess`.
- `npm run server` starts the dashboard/API without the Telegram bot.
- Everything the bot receives is stored in the `messages` collection, so the extractor can be re-run when you tweak the prompt.

## Opening it on your phone

The server binds `0.0.0.0` by default and prints every URL it is reachable on:

```
INFO  http listening on 0.0.0.0:3200
INFO  http   local    http://localhost:3200
INFO  http   network  http://192.168.1.24:3200
```

Open the `network` URL on your phone, on the same Wi-Fi. Set `HOST=127.0.0.1` to
disable that and keep the dashboard on the machine only.

**On WSL there is an extra hop.** WSL2 sits behind its own NAT, so the address
above is a `172.x` one your phone cannot reach. Either:

- **Mirrored networking (Windows 11, simplest).** Create `C:\Users\<you>\.wslconfig`:
  ```ini
  [wsl2]
  networkingMode=mirrored
  ```
  Run `wsl --shutdown` from PowerShell and reopen. WSL now shares the Windows
  network stack and the printed address is your real LAN IP.

- **Port proxy (any Windows).** In an **admin** PowerShell:
  ```powershell
  netsh interface portproxy add v4tov4 listenport=3200 listenaddress=0.0.0.0 `
    connectport=3200 connectaddress=(wsl hostname -I).Trim().Split()[0]
  ```
  Then browse to `http://<your-windows-LAN-IP>:3200`. Re-run it after each reboot,
  since the WSL IP changes.

Either way, allow the port through Windows Firewall once (admin PowerShell):

```powershell
New-NetFirewallRule -DisplayName "Task Inbox" -Direction Inbound `
  -LocalPort 3200 -Protocol TCP -Action Allow -Profile Private
```

> The dashboard has **no authentication** — anyone on your network can read and
> change tasks. That is usually fine on a home network; do not port-forward it to
> the internet as-is.

## Logs

Output is timestamped and scoped, and colourised when the terminal supports it:

```
18:41:50.641 INFO  app       starting — model claude-opus-5, effort low, tz Asia/Kolkata
18:41:50.642 INFO  app       mongo connected — task_inbox
18:41:50.660 INFO  http      listening on 0.0.0.0:3200
18:41:50.661 INFO  telegram  polling as @task_me_bot
18:41:52.744 INFO  telegram  message #4 from Mom: "can you pay the electricity bill before friday"
18:41:54.101 INFO  telegram  → 1 task(s): #7 Pay the electricity bill [78]
18:41:54.180 INFO  http      GET    /api/tasks?status=open 200 6ms
```

`LOG_LEVEL=debug` adds static-asset requests, duplicate-delivery notices and
rescoring runs; `LOG_LEVEL=warn` keeps only problems. `NO_COLOR=1` disables colour
(useful when piping to a file: `npm start | tee run.log`).

## Troubleshooting

**`fetch failed` / `ETIMEDOUT` reaching Telegram, but `curl` to the same URL works**
(common on WSL2) — Node races IPv4 and IPv6 with a 250 ms per-attempt deadline, and a
blackholed IPv6 route makes every attempt expire. `src/bootstrap-net.js` pins connections
to IPv4 to avoid this. Set `NET_AUTOSELECT_FAMILY=1` to restore Node's default behaviour.

**Bot stops but the dashboard keeps running** — that is deliberate. Transient network
errors retry with backoff; only an unrecoverable error (usually a bad
`TELEGRAM_BOT_TOKEN`) ends the poll loop, and it logs the reason.
