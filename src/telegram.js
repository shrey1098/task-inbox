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
const { explainScore, bucketOf } = require('./priority');
const transcriber = require('./transcribe');
const { periodSummary, gameStats, xpForTask } = require('./stats');
const { parsePeriod, renderSummary, PERIOD_EXAMPLES } = require('./summary');
const { describeRule, completeTask } = require('./recurrence');
const { createLogger } = require('./log');

const log = createLogger('telegram');

/**
 * A task's priority band as a coloured tag: "🔴 P1".
 *
 * The band is computed from the score rather than read off the task, because a
 * document straight out of the database has no `bucket` — that field is
 * derived, and only the HTTP layer adds it.
 *
 * The emoji is not decoration: Telegram offers no colour control, so a coloured
 * circle is the only way to tell the bands apart at a glance in a wall of text.
 * The letters still carry the meaning for anyone who cannot distinguish them.
 */
const BAND_DOT = { p1: '🔴', p2: '🟠', p3: '🟢' };

function bandOf(task) {
  const band = task.bucket || bucketOf(task.score ?? 0);
  return `${BAND_DOT[band] || '⚪️'} <b>${band.toUpperCase()}</b>`;
}

/** A ten-cell text progress bar: ▓▓▓▓▓░░░░░ — readable in any Telegram font. */
function progressBar(fraction, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

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

/* ------------------------------------------------------------------ media */

/**
 * Download a file the bot has been sent.
 *
 * Two steps, which is how the Bot API works: getFile turns a file_id into a
 * temporary path, then the file itself is fetched from a different host. The
 * path expires after about an hour, which is exactly why anything we want to
 * keep gets stored rather than re-fetched later.
 */
async function downloadFile(fileId) {
  const file = await tg('getFile', { file_id: fileId });
  const url = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`file download failed: ${res.status}`);
  // arrayBuffer → Buffer, because that is what base64 encoding and FormData
  // both want.
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Pick which of Telegram's photo sizes to use.
 *
 * A photo arrives as several pre-scaled versions, smallest first. We want the
 * largest one that is still under the size cap: bigger means more readable
 * text in a screenshot, which is the whole point of reading photos, but an
 * unbounded original would bloat both the database and the model request.
 */
function pickPhotoSize(sizes) {
  const affordable = sizes.filter((s) => (s.file_size ?? 0) <= config.maxImageBytes);
  // If every size is over the cap, fall back to the smallest rather than
  // refusing outright — a slightly-too-big photo is still worth reading.
  const pool = affordable.length > 0 ? affordable : [sizes[0]];
  return pool.reduce((best, s) => ((s.file_size ?? 0) > (best.file_size ?? 0) ? s : best));
}

/**
 * Turn a photo message into base64 image blocks for the extractor.
 * Returns null when the download fails, so the caller can fall back to the
 * caption rather than losing the message entirely.
 */
async function imagesFromMessage(msg) {
  if (!msg.photo || msg.photo.length === 0) return null;
  try {
    const size = pickPhotoSize(msg.photo);
    const buffer = await downloadFile(size.file_id);
    // Telegram re-encodes photos as JPEG, so the media type is not a guess.
    return [{ media_type: 'image/jpeg', data: buffer.toString('base64') }];
  } catch (err) {
    log.error('photo download failed:', err.message);
    return null;
  }
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
          'Text, screenshots and voice notes all work.',
          '',
          '<b>Your list</b>',
          '/tasks — top open tasks',
          '/today — tasks due in the next 24h (plus overdue)',
          '/waiting — things you are chasing someone else for',
          '/people — who your open work is coming from',
          '',
          '<b>Acting</b>',
          '/done N — mark task N done',
          '/drop N — dismiss task N (not a real task)',
          '/snooze N — hide task N until tomorrow morning',
          '',
          '<b>Looking back</b>',
          '/summary [period] — e.g. <code>/summary last month</code>, <code>/summary 7d</code>',
          '/streak — level, XP and current streak',
          '',
          '<b>Setup</b>',
          '/seniors — list who outranks the clock',
          '/seniors add CO — their asks are always top priority',
          '/seniors remove CO',
          '/whoami — which account this chat is linked to',
          '/unlink — disconnect this chat from your account',
        ].join('\n')
      );
      return;

    case '/waiting': {
      const tasks = (await dbModule.listTasksByStatus(user.id, 'open')).filter((t) => t.waiting_on);
      if (tasks.length === 0) return void (await send(chatId, 'Not waiting on anybody. 🎉'));
      const lines = tasks.map(
        (t) => `⏳ <b>#${t.id}</b> ${esc(t.title)}${t.requester ? ` — <i>${esc(t.requester)}</i>` : ''}`
      );
      await send(chatId, ['<b>Waiting on others</b>', ...lines].join('\n'));
      return;
    }

    case '/people': {
      const groups = await dbModule.groupByRequester(user.id);
      if (groups.length === 0) return void (await send(chatId, 'No open tasks.'));
      const lines = groups.map((g) => {
        const who = g._id || 'Unattributed';
        const star = g.rank === 'senior' ? '⭐️ ' : '';
        const waiting = g.waiting ? ` · ${g.waiting} waiting` : '';
        return `${star}<b>${esc(who)}</b> — ${g.n} open${waiting}`;
      });
      await send(chatId, ['<b>Who your work comes from</b>', ...lines].join('\n'));
      return;
    }

    case '/summary': {
      const period = parsePeriod(arg);
      if (!period) {
        await send(
          chatId,
          `Try: ${PERIOD_EXAMPLES.map((e) => `<code>${esc(e)}</code>`).join(', ')}`
        );
        return;
      }
      const data = await periodSummary(dbModule, user.id, period.from, period.to);
      await send(chatId, renderSummary(data, period.label));
      return;
    }

    case '/streak': {
      const g = await gameStats(dbModule, user.id);
      const bar = progressBar(g.progress);
      await send(
        chatId,
        [
          `🎮 <b>Level ${g.level}</b> — ${g.xp} XP`,
          `${bar} ${g.to_next} XP to level ${g.level + 1}`,
          '',
          `🔥 Streak: <b>${g.streak} day${g.streak === 1 ? '' : 's'}</b> (best ${g.best_streak})`,
          `✅ Today: ${g.done_today}/${g.daily_goal}`,
          `📦 Lifetime: ${g.lifetime_done} tasks`,
        ].join('\n')
      );
      return;
    }

    case '/seniors': {
      const settings = dbModule.settingsOf(user);
      const [action, ...nameParts] = arg.split(/\s+/);
      const name = nameParts.join(' ').trim();

      if (action === 'add' && name) {
        // Case-insensitive dedupe, so "CO" and "co" don't both end up stored.
        const exists = settings.seniors.some((s) => s.toLowerCase() === name.toLowerCase());
        const seniors = exists ? settings.seniors : [...settings.seniors, name];
        await dbModule.updateUser(user.id, { settings: { ...settings, seniors } });
        await send(chatId, `⭐️ <b>${esc(name)}</b>’s requests will now always rank as P1.`);
        return;
      }
      if ((action === 'remove' || action === 'rm') && name) {
        const seniors = settings.seniors.filter((s) => s.toLowerCase() !== name.toLowerCase());
        await dbModule.updateUser(user.id, { settings: { ...settings, seniors } });
        await send(chatId, `Removed <b>${esc(name)}</b>.`);
        return;
      }

      await send(
        chatId,
        settings.seniors.length
          ? ['<b>Always top priority</b>', ...settings.seniors.map((s) => `⭐️ ${esc(s)}`),
             '', 'Add with <code>/seniors add NAME</code>.'].join('\n')
          : 'Nobody set yet. Add one with <code>/seniors add CO</code> — their requests will always rank as P1, whatever the deadline says.'
      );
      return;
    }

    case '/tasks': {
      // Already sorted by score in the database; cap at 10 so the reply stays
      // glanceable on a phone.
      const tasks = (await dbModule.listTasksByStatus(user.id, 'open')).slice(0, 10);
      // `void` discards the value so this stays an expression — it lets us
      // "reply and return" on one line.
      if (tasks.length === 0) return void (await send(chatId, 'No open tasks. 🎉'));
      const lines = tasks.map(
        (t) => `${bandOf(t)} <b>#${t.id}</b> ${esc(t.title)}${t.due_text ? ` — <i>${esc(t.due_text)}</i>` : ''}`
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
        // The shared path, so a recurring chore comes back whether you tick it
        // off here or in the dashboard.
        const { next } = await completeTask(dbModule, user.id, task);
        const g = await gameStats(dbModule, user.id);
        const again = next
          ? `\n🔁 Next one: <b>#${next.id}</b> ${esc(new Date(next.due_at).toDateString())}`
          : '';
        await send(
          chatId,
          `✅ Done: ${esc(task.title)}\n⚡ +${xpForTask(task)} XP · 🔥 ${g.streak}-day streak${again}`
        );
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

  if (text && text.startsWith('/')) return handleCommand(chatId, user, text);

  // --- media. Both branches end up producing ordinary message text, so the
  //     extraction path below does not need to know how it arrived.
  let kind = 'text';
  let images = null;
  let transcript = null;
  let body = text;

  if (msg.photo) {
    kind = 'photo';
    // Reading a screenshot takes a moment; say so rather than going quiet.
    await send(chatId, '🖼 Reading that image…');
    images = await imagesFromMessage(msg);
    if (!images) {
      await send(chatId, '⚠️ Could not download that image. Try sending it again.');
      return;
    }
    // The caption is context, not the whole story — the extractor is told to
    // read the picture too.
    body = text || '';
  } else if (msg.voice || msg.audio) {
    kind = 'voice';
    const audio = msg.voice || msg.audio;

    if (!transcriber.isConfigured()) {
      await send(
        chatId,
        '🎤 I can’t transcribe voice notes — no speech-to-text service is configured.\n\n' +
          'Set <code>TRANSCRIBE_URL</code> on the server (any OpenAI-compatible ' +
          '/audio/transcriptions endpoint, including a local whisper server), or just type the task.'
      );
      return;
    }

    await send(chatId, '🎤 Listening…');
    try {
      const buffer = await downloadFile(audio.file_id);
      transcript = await transcriber.transcribe(buffer, audio.file_name || 'voice.ogg');
      body = transcript;
      log.info(`transcribed ${Math.round((audio.duration ?? 0))}s of audio for #${user.id}`);
    } catch (err) {
      await send(chatId, `⚠️ Could not transcribe that (${esc(err.message)}).`);
      return;
    }
  } else if (!text) {
    await send(
      chatId,
      'I can read text, photos and voice notes. That message had none of those.'
    );
    return;
  }

  const origin = describeOrigin(msg);
  const stored = await dbModule.insertMessage({
    user_id: user.id,
    tg_chat_id: chatId,
    tg_message_id: msg.message_id,
    text: body,
    kind,
    images,
    transcript,
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
  const preview = (body || `(${kind})`).replace(/\s+/g, ' ').slice(0, 70);
  log.info(
    `message #${stored.id} (${kind}) for #${user.id} from ${origin.name || 'them'}: ` +
      `"${preview}${(body || '').length > 70 ? '…' : ''}"`
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
    // Include the score breakdown so a bad judgement is visible immediately,
    // plus flags for the things that change how a task behaves.
    const lines = tasks.map((t) => {
      const flags = [
        t.requester_rank === 'senior' ? '⭐️ from a senior — pinned to P1' : null,
        t.recurrence ? `🔁 ${esc(describeRule(t.recurrence))}` : null,
        t.waiting_on ? '⏳ waiting on someone else' : null,
        t.dup_of ? `♻️ looks like #${t.dup_of} — check before doing both` : null,
      ].filter(Boolean);

      return [
        `${bandOf(t)} <b>#${t.id}</b> ${esc(t.title)}`,
        `<i>${esc(explainScore(t))} → score ${Math.round(t.score)}</i>`,
        ...flags,
      ].join('\n');
    });
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

// `send` is exported for the scheduler, which needs to push messages without
// owning a poll loop of its own.
module.exports = { runBot, send };
