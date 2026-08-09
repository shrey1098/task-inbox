'use strict';

const config = require('./config');
const dbModule = require('./db');
const { processMessage } = require('./extractor');
const { explainScore } = require('./priority');

const API = `https://api.telegram.org/bot${config.telegram.token}`;

async function tg(method, params = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Telegram ${method}: ${body.description}`);
  return body.result;
}

function send(chatId, text) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' }).catch((err) =>
    console.error('[telegram] send failed:', err.message)
  );
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Access control: only chats in TELEGRAM_ALLOWED_CHAT_IDS may use the bot.
 * With no allowlist configured, the first chat to message the bot gets pinned
 * (stored in state) so a stranger who finds the bot can't fill your inbox.
 */
async function isAllowed(chatId) {
  if (config.telegram.allowedChatIds.length > 0) {
    return config.telegram.allowedChatIds.includes(chatId);
  }
  const pinned = await dbModule.getState('pinned_chat_id');
  if (pinned == null) {
    await dbModule.setState('pinned_chat_id', chatId);
    return true;
  }
  return Number(pinned) === chatId;
}

/** Pull sender/origin info out of a Telegram message, including forward headers. */
function describeOrigin(msg) {
  // New-style forward metadata (Bot API 7+)
  const fo = msg.forward_origin;
  if (fo) {
    if (fo.type === 'user' && fo.sender_user) {
      const u = fo.sender_user;
      return { name: [u.first_name, u.last_name].filter(Boolean).join(' '), chat: null };
    }
    if (fo.type === 'hidden_user') return { name: fo.sender_user_name || null, chat: null };
    if (fo.chat || fo.sender_chat) {
      const c = fo.chat || fo.sender_chat;
      return { name: c.title || null, chat: c.title || null };
    }
  }
  return { name: null, chat: null };
}

async function handleCommand(chatId, text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ');

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
        ].join('\n')
      );
      return;

    case '/tasks': {
      const tasks = (await dbModule.listTasksByStatus('open')).slice(0, 10);
      if (tasks.length === 0) return void (await send(chatId, 'No open tasks. 🎉'));
      const lines = tasks.map(
        (t) => `<b>#${t.id}</b> [${Math.round(t.score)}] ${esc(t.title)}${t.due_text ? ` — <i>${esc(t.due_text)}</i>` : ''}`
      );
      await send(chatId, lines.join('\n'));
      return;
    }

    case '/today': {
      const cutoff = Date.now() + 24 * 3600 * 1000;
      const tasks = (await dbModule.listTasksByStatus('open')).filter(
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

    case '/done':
    case '/drop':
    case '/snooze': {
      const id = parseInt(arg, 10);
      if (!Number.isFinite(id)) return void (await send(chatId, `Usage: ${cmd} &lt;task id&gt;`));
      const task = await dbModule.getTask(id);
      if (!task) return void (await send(chatId, `No task #${id}.`));

      if (cmd === '/done') {
        await dbModule.updateTaskFields(id, { status: 'done', completed_at: Date.now() });
        await send(chatId, `✅ Done: ${esc(task.title)}`);
      } else if (cmd === '/drop') {
        await dbModule.updateTaskFields(id, { status: 'dropped' });
        await send(chatId, `🗑 Dropped: ${esc(task.title)}`);
      } else {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(8, 0, 0, 0);
        await dbModule.updateTaskFields(id, { status: 'snoozed', snooze_until: tomorrow.getTime() });
        await send(chatId, `😴 Snoozed until tomorrow 8am: ${esc(task.title)}`);
      }
      return;
    }

    default:
      await send(chatId, 'Unknown command. /help for the list.');
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  if (!(await isAllowed(chatId))) return; // silently ignore strangers

  const text = msg.text || msg.caption;
  if (!text) {
    await send(chatId, 'I can only read text right now — media without a caption is skipped.');
    return;
  }

  if (text.startsWith('/')) return handleCommand(chatId, text);

  const origin = describeOrigin(msg);
  const stored = await dbModule.insertMessage({
    tg_chat_id: chatId,
    tg_message_id: msg.message_id,
    text,
    origin_name: origin.name,
    origin_chat: origin.chat,
    sent_at: msg.forward_origin?.date ? msg.forward_origin.date * 1000 : msg.date * 1000,
    raw: msg,
  });
  if (!stored) return; // duplicate delivery

  const { tasks, note, error } = await processMessage(stored);

  if (error) {
    await send(chatId, `⚠️ Could not process that message (${esc(error)}). It is saved and will be retried.`);
  } else if (tasks.length === 0) {
    await send(chatId, `No task found${note ? ` — ${esc(note)}` : ''}. Saved for reference.`);
  } else {
    const lines = tasks.map(
      (t) => `📌 <b>#${t.id}</b> ${esc(t.title)}\n<i>${esc(explainScore(t))} → score ${Math.round(t.score)}</i>`
    );
    await send(chatId, lines.join('\n\n'));
  }
}

/** Long-poll loop. Offset is persisted so restarts don't replay old updates. */
async function runBot() {
  if (!config.telegram.token) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — bot disabled.');
    return;
  }

  const me = await tg('getMe');
  console.log(`[telegram] polling as @${me.username}`);

  let offset = parseInt((await dbModule.getState('tg_offset')) ?? '0', 10);

  for (;;) {
    let updates;
    try {
      updates = await tg('getUpdates', {
        offset,
        timeout: config.telegram.pollTimeoutSeconds,
        allowed_updates: ['message'],
      });
    } catch (err) {
      console.error('[telegram] poll error:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      try {
        if (update.message) await handleMessage(update.message);
      } catch (err) {
        console.error('[telegram] handler error:', err);
      }
      await dbModule.setState('tg_offset', offset);
    }
  }
}

module.exports = { runBot };
