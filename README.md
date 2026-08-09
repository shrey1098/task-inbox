# Task Inbox

Forward WhatsApp messages that need action to a Telegram bot → Claude extracts the task(s), estimates urgency/importance/effort and resolves deadlines → tasks land in MongoDB with a deterministic priority score → a web dashboard shows them as **Now / Soon / Later**.

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

## Daily use

- In WhatsApp: long-press a message → **Forward** → your Telegram bot. (Telegram's "forwarded from" header, when present, is used as the requester.)
- The bot replies with what it filed and why it scored the task the way it did.
- Bot commands: `/tasks`, `/today`, `/done N`, `/snooze N`, `/drop N`.
- The dashboard has a capture box too, so you can file tasks without Telegram.

## How prioritisation works

Claude only judges the *content*: urgency (1–5), importance (1–5), effort, deadline. The 0–100 score is computed locally and re-computed every 5 minutes:

- urgency → up to 30 pts, importance → up to 30 pts
- deadline pressure → up to 30 pts (overdue = max; grows as the deadline nears)
- quick-win bonus (≤15 min) and a small staleness nudge so old tasks resurface

Because scoring is local, ranks stay explainable, deadlines "heat up" without extra API calls, and you can tune the weights in `src/priority.js`.

## Ops notes

- Messages that fail extraction (API outage etc.) are kept with `status: failed` and retried on boot, or manually via `npm run reprocess`.
- `npm run server` starts the dashboard/API without the Telegram bot.
- Everything the bot receives is stored in the `messages` collection, so the extractor can be re-run when you tweak the prompt.

## Troubleshooting

**`fetch failed` / `ETIMEDOUT` reaching Telegram, but `curl` to the same URL works**
(common on WSL2) — Node races IPv4 and IPv6 with a 250 ms per-attempt deadline, and a
blackholed IPv6 route makes every attempt expire. `src/bootstrap-net.js` pins connections
to IPv4 to avoid this. Set `NET_AUTOSELECT_FAMILY=1` to restore Node's default behaviour.

**Bot stops but the dashboard keeps running** — that is deliberate. Transient network
errors retry with backoff; only an unrecoverable error (usually a bad
`TELEGRAM_BOT_TOKEN`) ends the poll loop, and it logs the reason.
