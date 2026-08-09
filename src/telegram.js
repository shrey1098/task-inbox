'use strict';

// ---------------------------------------------------------------------------
// telegram.js — the bot: receives your forwarded messages, replies with what
// it filed, and handles /commands.
//
// It uses LONG POLLING, not webhooks: we repeatedly ask Telegram "anything new?"
// and Telegram holds the request open until there is. That means no public URL,
// no HTTPS certificate, no tunnel — it works from a laptop behind a router.
//
// The Bot API is simple enough (POST JSON, get JSON) that we call it with plain
// fetch rather than adding a library.
// ---------------------------------------------------------------------------

const config = require('./config');
const dbModule = require('./db');
const { processMessage } = require('./extractor');
const { explainScore } = require('./priority');
const { createLogger } = require('./log');

const log = createLogger('telegram');

// Every Bot API call is <base>/bot<TOKEN>/<method>. The token is in the URL,
// which is why it must never be logged or committed.
const API = `https://api.telegram.org/bot${config.telegram.token}`;

// Promise-based sleep: `await sleep(2000)` pauses without blocking the process.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call one Bot API method.
 * @param timeoutMs abort if the whole request takes longer than this
 */
async function tg(method, params = {}, timeoutMs = 20000) {
  let res;
  try {
    res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      // Without this a half-open connection hangs forever and the poll loop
      // silently stops. AbortSignal.timeout is built into modern Node.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // fetch collapses every network problem into the useless message
    // "fetch failed" and hides the real reason on err.cause. Unwrap it, or
    // debugging a connectivity issue is guesswork.
    throw new Error(`Telegram ${method}: ${err.cause?.code || err.name || err.message}`);
  }

  const body = await res.json();
  // The Bot API signals failure in the BODY ({ok:false}), often still with
  // HTTP 200 — so checking res.ok alone would miss real errors.
  if (!body.ok) throw new Error(`Telegram ${method}: ${res.status} ${body.description}`);
  return body.result;
}

/**
 * Is this error permanent? 401 means the token is wrong and 404 means the
 * method or bot doesn't exist — retrying either just burns requests forever.
 * Everything else (timeouts, 5xx, DNS) is transient and worth retrying.
 */
function isFatal(err) {
  return /\b401\b|unauthorized|\b404\b/i.test(err.message);
}

/** Retry with exponential backoff: 2s, 4s, 8s… capped at 60s, forever. */
async function withRetry(label, fn) {
  let delay = 2000;
  for (let attempt = 1; ; attempt += 1) { // no exit condition — only return/throw leaves
    try {
      return await fn();
    } catch (err) {
      if (isFatal(err)) throw err; // permanent — stop immediately
      log.warn(`${label} failed (attempt ${attempt}): ${err.message} — retrying in ${delay / 1000}s`);
      await sleep(delay);
      // Back off so a long outage doesn't hammer the API, but cap it so
      // recovery is noticed within a minute.
      delay = Math.min(delay * 2, 60000);
    }
  }
}

/**
 * Send a message, swallowing failures. Every call site is "tell the user what
 * happened" — if that notification itself fails, logging is the right response;
 * throwing would abort the handler that had already done the real work.
 */
function send(chatId, text) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' }).catch((err) =>
    log.error('send failed:', err.message)
  );
}

/**
 * Escape text before putting it inside an HTML-formatted message.
 * We send parse_mode:'HTML', so a task title containing "<" would otherwise be
 * read as markup and Telegram would reject the whole message.
 */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Which account owns this Telegram chat, if any.
 *
 * This is the multi-user access control: a chat reaches an account only by
 * having been linked to it with a one-time code issued from a signed-in
 * session. An unknown chat is told how to link and nothing else — it can
 * neither read nor create tasks.
 *
 * TELEGRAM_ALLOWED_CHAT_IDS, when set, is an additional restriction on top.
 */
async function userForChat(chatId) {
  if (config.telegram.allowedChatIds.length > 0
      && !config.telegram.allowedChatIds.includes(chatId)) {
    return null;
  }
  return dbModule.getUserByChatId(chatId);
}

/**
 * Handle "/link ABC123": bind this chat to the account that generated the code.
 * Codes are single-use and expire after 15 minutes.
 */
async function handleLink(chatId, arg) {
  const code = String(arg || '').trim().toUpperCase();
  if (!code) {
    await send(chatId, 'Send <code>/link CODE</code> using the code from the app’s Account screen.');
    return;
  }

  const user = await dbModule.getUserByLinkCode(code);
  if (!user || !user.link_code_expires || user.link_code_expires < Date.now()) {
    // One message for "wrong code" and "expired code" — no hints for guessing.
    await send(chatId, '❌ That code is not valid or has expired. Generate a new one in the app.');
    log.warn(`bad link code from chat ${chatId}`);
    return;
  }

  try {
    // Clearing link_code is what makes the code single-use.
    await dbModule.updateUser(user.id, {
      tg_chat_id: chatId,
      link_code: null,
      link_code_expires: null,
    });
  } catch (err) {
    // The unique index on tg_chat_id rejected it: this chat is already linked
    // to a different account, which has to unlink first.
    if (err.code === 11000) {
      await send(chatId, '❌ This Telegram account is already linked to another user.');
      return;
    }
    throw err;
  }

  log.info(`chat ${chatId} linked to account #${user.id} ${user.email}`);
  await send(chatId, `✅ Linked to <b>${esc(user.email)}</b>. Forward me anything that needs doing.`);
}

/**
 * Work out who originally wrote a forwarded message.
 *
 * Telegram exposes this as `forward_origin`, a tagged union whose shape depends
 * on the source — and on whether that person allows being linked when their
 * message is forwarded (`hidden_user` is what you get when they don't).
 */
function describeOrigin(msg) {
  const fo = msg.forward_origin;
  if (fo) {
    if (fo.type === 'user' && fo.sender_user) {
      const u = fo.sender_user;
      // filter(Boolean) drops an absent last name so we don't get "Rahul ".
      return { name: [u.first_name, u.last_name].filter(Boolean).join(' '), chat: null };
    }
    if (fo.type === 'hidden_user') return { name: fo.sender_user_name || null, chat: null };
    if (fo.chat || fo.sender_chat) {
      // Forwarded from a group or channel rather than a person.
      const c = fo.chat || fo.sender_chat;
      return { name: c.title || null, chat: c.title || null };
    }
  }
  return { name: null, chat: null }; // not a forward — you typed it yourself
}

/** Handle a /command. Anything else is treated as a message to file. */
async function handleCommand(chatId, user, text) {
  // Split on whitespace: "/snooze 7" → cmd "/snooze", arg "7".
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');

  // In groups Telegram sends "/done@my_bot"; strip the @suffix before matching.
  switch (cmd.split('@')[0]) {
    case '/start':
    case '/help':
      await send(
        chatId,
        [
          'Forward me any WhatsApp message that needs action and I will file it as a task.',
          '',
          '<b>Commands</b>',
          '/tasks — top open tasks',
          '/today — tasks due in the next 24h (plus overdue)',
          '/done N — mark task N done',
          '/drop N — dismiss task N (not a real task)',
          '/snooze N — hide task N until tomorrow morning',
          '/whoami — which account this chat is linked to',
          '/unlink — disconnect this chat from your account',
        ].join('\n')
      );
      return;

    case '/tasks': {
      // Already sorted by score in the database; cap at 10 so the reply stays
      // glanceable on a phone.
      const tasks = (await dbModule.listTasksByStatus(user.id, 'open')).slice(0, 10);
      // `void` discards the value so this stays an expression — it lets us
      // "reply and return" on one line.
      if (tasks.length === 0) return void (await send(chatId, 'No open tasks. 🎉'));
      const lines = tasks.map(
        (t) => `<b>#${t.id}</b> [${Math.round(t.score)}] ${esc(t.title)}${t.due_text ? ` — <i>${esc(t.due_text)}</i>` : ''}`
      );
      await send(chatId, lines.join('\n'));
      return;
    }

    case '/today': {
      const cutoff = Date.now() + 24 * 3600 * 1000;
      // due_at <= cutoff also catches overdue tasks, since those are in the past.
      const tasks = (await dbModule.listTasksByStatus(user.id, 'open')).filter(
        (t) => t.due_at != null && t.due_at <= cutoff
      );
      if (tasks.length === 0) return void (await send(chatId, 'Nothing due in the next 24h.'));
      const lines = tasks.map((t) => {
        const overdue = t.due_at < Date.now() ? ' ⚠️ overdue' : '';
        return `<b>#${t.id}</b> ${esc(t.title)} — <i>${esc(t.due_text || 'due soon')}</i>${overdue}`;
      });
      await send(chatId, lines.join('\n'));
      return;
    }

    // These three share argument parsing and validation, so they share a case.
    case '/done':
    case '/drop':
    case '/snooze': {
      const id = parseInt(arg, 10);
      // &lt; is an escaped "<" — the usage hint is inside an HTML message.
      if (!Number.isFinite(id)) return void (await send(chatId, `Usage: ${cmd} &lt;task id&gt;`));
      // Scoped lookup: another account's task id simply does not exist here.
      const task = await dbModule.getTask(user.id, id);
      if (!task) return void (await send(chatId, `No task #${id}.`));

      if (cmd === '/done') {
        await dbModule.updateTaskFields(user.id, id, { status: 'done', completed_at: Date.now() });
        await send(chatId, `✅ Done: ${esc(task.title)}`);
      } else if (cmd === '/drop') {
        // 'dropped' rather than deleted: the task stays for auditing what the
        // extractor got wrong.
        await dbModule.updateTaskFields(user.id, id, { status: 'dropped' });
        await send(chatId, `🗑 Dropped: ${esc(task.title)}`);
      } else {
        // Tomorrow at 08:00 local. setHours(8,0,0,0) zeroes minutes/seconds/ms.
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1); // rolls over months correctly
        tomorrow.setHours(8, 0, 0, 0);
        await dbModule.updateTaskFields(user.id, id, { status: 'snoozed', snooze_until: tomorrow.getTime() });
        await send(chatId, `😴 Snoozed until tomorrow 8am: ${esc(task.title)}`);
      }
      return;
    }

    case '/whoami':
      await send(chatId, `Linked to <b>${esc(user.email)}</b>.`);
      return;

    case '/unlink':
      await dbModule.updateUser(user.id, { tg_chat_id: null });
      log.info(`chat ${chatId} unlinked from account #${user.id}`);
      await send(chatId, 'Unlinked. Generate a new code in the app to reconnect.');
      return;

    default:
      await send(chatId, 'Unknown command. /help for the list.');
  }
}

/** The main path: an inbound message becomes a stored message becomes task(s). */
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption; // caption = text attached to a photo/document

  // /link is the one command an unlinked chat may use — it is how a chat
  // becomes associated with an account in the first place.
  if (text && /^\/link(@\S+)?(\s|$)/i.test(text.trim())) {
    return handleLink(chatId, text.trim().split(/\s+/).slice(1).join(' '));
  }

  const user = await userForChat(chatId);
  if (!user) {
    // Explain how to link, but reveal nothing about any account.
    await send(
      chatId,
      'This chat is not linked to an account yet.\n\nOpen the app, go to Account, tap ' +
        '<b>Link Telegram</b>, and send me <code>/link YOURCODE</code>.'
    );
    return;
  }

  if (!text) {
    await send(chatId, 'I can only read text right now — media without a caption is skipped.');
    return;
  }

  if (text.startsWith('/')) return handleCommand(chatId, user, text);

  const origin = describeOrigin(msg);
  const stored = await dbModule.insertMessage({
    user_id: user.id,
    tg_chat_id: chatId,
    tg_message_id: msg.message_id,
    text,
    origin_name: origin.name,
    origin_chat: origin.chat,
    // Telegram timestamps are in SECONDS; JavaScript works in milliseconds.
    // Prefer the original send time when forwarded, else when you sent it on.
    sent_at: msg.forward_origin?.date ? msg.forward_origin.date * 1000 : msg.date * 1000,
    raw: msg, // keep the untouched payload for debugging
  });

  // null means the unique index rejected it — Telegram redelivered an update we
  // already handled. Silently ignore, or the user gets a duplicate task.
  if (!stored) {
    log.debug(`duplicate delivery of tg message ${msg.message_id} — ignored`);
    return;
  }

  // Collapse whitespace and truncate so one log line stays one line.
  const preview = text.replace(/\s+/g, ' ').slice(0, 70);
  log.info(
    `message #${stored.id} for #${user.id} from ${origin.name || 'them'}: ` +
      `"${preview}${text.length > 70 ? '…' : ''}"`
  );

  // The API round trip — the slow step, a few seconds.
  const { tasks, note, error } = await processMessage(stored);

  if (!error) {
    log.info(
      tasks.length
        ? `→ ${tasks.length} task(s): ${tasks.map((t) => `#${t.id} ${t.title} [${Math.round(t.score)}]`).join('; ')}`
        : `→ no task${note ? ` (${note})` : ''}`
    );
  }

  // Always reply with something: silence is indistinguishable from a dead bot.
  if (error) {
    await send(chatId, `⚠️ Could not process that message (${esc(error)}). It is saved and will be retried.`);
  } else if (tasks.length === 0) {
    await send(chatId, `No task found${note ? ` — ${esc(note)}` : ''}. Saved for reference.`);
  } else {
    // Include the score breakdown so a bad judgement is visible immediately.
    const lines = tasks.map(
      (t) => `📌 <b>#${t.id}</b> ${esc(t.title)}\n<i>${esc(explainScore(t))} → score ${Math.round(t.score)}</i>`
    );
    await send(chatId, lines.join('\n\n'));
  }
}

/**
 * The long-poll loop. Runs for the life of the process.
 *
 * How Telegram's offset works: getUpdates returns updates with ids, and passing
 * offset = lastId + 1 both requests the next batch AND acknowledges everything
 * before it. Acknowledged updates are deleted server-side, so persisting the
 * offset is what stops a restart from reprocessing your entire history.
 */
async function runBot() {
  if (!config.telegram.token) {
    log.warn('TELEGRAM_BOT_TOKEN not set — bot disabled.');
    return; // dashboard still runs; the bot is simply off
  }

  // getMe both verifies the token and gives us the username to log.
  // withRetry means a network blip at startup waits instead of crashing.
  const me = await withRetry('getMe', () => tg('getMe'));
  log.info(`polling as @${me.username}`);

  // Resume where we left off. `?? '0'` handles the very first run.
  let offset = parseInt((await dbModule.getState('tg_offset')) ?? '0', 10);
  const pollSeconds = config.telegram.pollTimeoutSeconds;

  for (;;) { // infinite loop — this is the bot's lifetime
    let updates;
    try {
      updates = await tg(
        'getUpdates',
        {
          offset,
          timeout: pollSeconds, // Telegram holds the request open this long
          allowed_updates: ['message'] // ignore edits, reactions, polls, etc.
        },
        // Our client-side abort must outlast Telegram's own hold, or we would
        // cancel every quiet poll as a "timeout".
        (pollSeconds + 15) * 1000
      );
    } catch (err) {
      if (isFatal(err)) throw err; // bad token — index.js reports and stops
      log.error('poll error:', err.message);
      await sleep(5000); // brief pause so an outage doesn't spin the CPU
      continue;          // then try again — transient errors are normal here
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        if (update.message) await handleMessage(update.message);
      } catch (err) {
        // One malformed message must not kill the loop.
        log.error('handler error:', err);
      }
      // Save the offset AFTER handling, and per update rather than per batch.
      // If we crash mid-batch, the unhandled remainder is redelivered; anything
      // already handled is not. (A crash between handling and this line causes
      // one redelivery — which the unique index in db.js absorbs.)
      await dbModule.setState('tg_offset', offset);
    }
  }
}

module.exports = { runBot };
