'use strict';

// ---------------------------------------------------------------------------
// extractor.js — the one place that talks to Claude.
//
// Input:  a stored message ("can you pay the electricity bill before friday?")
// Output: zero or more task objects, each with a deadline, urgency, importance
//         and effort estimate.
//
// The model is asked for *judgement about content only*. Turning those
// judgements into a priority number is priority.js's job — see the note there.
// ---------------------------------------------------------------------------

const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const dbModule = require('./db');
const { scoreTask, rankRequester } = require('./priority');
const { normaliseRule } = require('./recurrence');
const { createLogger } = require('./log');

const log = createLogger('extract');

// One client for the process. It holds a connection pool and retry policy, so
// constructing a new one per request would be wasteful.
const client = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * The shape the model MUST reply in — a JSON Schema.
 *
 * This is "structured outputs": the API constrains generation so the response
 * is guaranteed to parse and to match this schema. No "please reply in JSON"
 * pleading, no regex salvage, no retry-on-malformed loop.
 *
 * Note the `description` on each field. Those are not documentation for humans
 * — the model reads them, so they are effectively part of the prompt and are
 * where most of the extraction quality lives.
 *
 * Optional values use "" / 0 sentinels rather than nullable types, because
 * nullable unions sit outside the documented supported subset of JSON Schema.
 * emptyToNull() converts them back on the way in.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      description: 'Actionable tasks found in the message. Empty array if there are none.',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short imperative task title, e.g. "Send Q3 invoice to Rahul".',
          },
          details: {
            type: 'string',
            description: 'Extra context worth keeping. Empty string if the title says it all.',
          },
          requester: {
            type: 'string',
            description:
              'Who is asking for this, if identifiable from the message or its forward header. Empty string if unknown.',
          },
          category: {
            type: 'string',
            // `enum` constrains the value to this list, so the dashboard can
            // safely map each one to a fixed colour without a fallback branch.
            enum: ['work', 'personal', 'finance', 'errand', 'social', 'health', 'other'],
          },
          due_text: {
            type: 'string',
            description:
              'The deadline as phrased in the message, e.g. "by Friday", "tonight". Empty string if none.',
          },
          due_at_iso: {
            type: 'string',
            description:
              'The deadline resolved to an ISO 8601 datetime using the current time and timezone given. Empty string if there is no deadline. Use 18:00 local for date-only deadlines.',
          },
          urgency: {
            type: 'integer',
            enum: [1, 2, 3, 4, 5], // enum, not min/max — numeric bounds are unsupported
            description: 'Time pressure: 1 = whenever, 3 = this week, 5 = drop everything.',
          },
          importance: {
            type: 'integer',
            enum: [1, 2, 3, 4, 5],
            description: 'Cost of slipping: 1 = trivial, 5 = serious consequences.',
          },
          effort_minutes: {
            type: 'integer',
            // Buckets rather than free integers: "about half an hour" is the
            // real precision available, and it stops 7-vs-8-minute quibbling.
            enum: [0, 5, 15, 30, 60, 120, 240, 480],
            description: 'Rough minutes to complete. 0 when it cannot be guessed.',
          },
          waiting_on: {
            type: 'boolean',
            description:
              'True when the user is blocked on somebody else replying or delivering, rather than on doing the work themselves. "Chase Rahul for the figures" is true; "Write the report" is false.',
          },
          repeat_text: {
            type: 'string',
            description:
              'The recurrence as phrased, e.g. "every Tuesday", "monthly", "every other day". Empty string if this is a one-off.',
          },
          repeat_freq: {
            type: 'string',
            // "none" rather than an empty string: an enum cannot also allow "".
            enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'],
            description: 'The recurrence unit. "none" for a one-off task.',
          },
          repeat_interval: {
            type: 'integer',
            enum: [1, 2, 3, 4, 6, 12],
            description: 'How many units between occurrences. 1 for "every week", 2 for "every other week".',
          },
          repeat_weekday: {
            type: 'integer',
            // -1 is the "not applicable" sentinel; 0 is a real value (Sunday).
            enum: [-1, 0, 1, 2, 3, 4, 5, 6],
            description: 'For a weekly repeat, the day: 0 = Sunday … 6 = Saturday. -1 when not applicable.',
          },
          repeat_monthday: {
            type: 'integer',
            enum: [-1, 1, 5, 10, 15, 20, 25, 28],
            description: 'For a monthly repeat, the day of the month. -1 when not applicable.',
          },
          duplicate_of: {
            type: 'integer',
            description:
              'The id of an existing open task from the EXISTING TASKS list that this is the same piece of work as. 0 when it is new.',
          },
        },
        // Every field is required. With sentinels for "unknown", the model never
        // needs to omit anything — so our parsing code has no missing-key case.
        required: [
          'title',
          'details',
          'requester',
          'category',
          'due_text',
          'due_at_iso',
          'urgency',
          'importance',
          'effort_minutes',
          'waiting_on',
          'repeat_text',
          'repeat_freq',
          'repeat_interval',
          'repeat_weekday',
          'repeat_monthday',
          'duplicate_of',
        ],
        additionalProperties: false, // reject invented fields
      },
    },
    note: {
      type: 'string',
      description:
        'One short sentence on why nothing was extracted, when tasks is empty. Empty string otherwise.',
    },
  },
  required: ['tasks', 'note'],
  additionalProperties: false,
};

// The system prompt: the model's standing instructions, sent with every call.
// The hardest judgement here is the false-positive/false-negative balance —
// forwarding implies intent, but plenty of forwards are just FYIs. If the
// extractor is too eager or too shy for your taste, this paragraph is the knob.
const SYSTEM_PROMPT = `You extract actionable tasks from messages a user forwards from WhatsApp into their personal task inbox.

The user forwards a message when they believe it needs action from them, so lean towards extracting a task — but not every forward contains one: pure FYIs, status updates, greetings, or already-completed things yield an empty task list.

Rules:
- Tasks are things the USER must do, phrased as imperatives from their point of view ("Pay the electricity bill", not "User should pay").
- One message can contain several tasks; extract each separately.
- The message may include a forward header naming who it came from — that is usually the requester. Give the person's name alone, without a role description.
- Resolve relative deadlines ("tomorrow", "by Friday", "tonight") against the current time and timezone given. If only a date is implied, use 18:00 local.
- Be honest with urgency and importance; most things are 2-3. Reserve 5 for genuine emergencies or hard external deadlines.
- Set waiting_on when the next move belongs to somebody else — chasing, following up, awaiting a reply or a delivery. The user cannot finish those by working harder.
- Set the repeat_* fields only when the message really describes something recurring ("every Tuesday", "monthly rent"). A single future date is not a recurrence.

RECENT CONTEXT: you may be given the previous few messages from the same chat. Use them to understand a message that only makes sense as a continuation ("actually make that Friday", "and the other thing too"). Do not re-extract tasks that the earlier messages already produced — those are listed for you.

EXISTING TASKS: you may be given the user's current open tasks. If the message describes one that is already on that list, still extract it, but set duplicate_of to that task's id so it can be flagged rather than silently doubled.

IMAGES: a forwarded photo may be a screenshot of a chat, a bill, a notice or a whiteboard. Read the text in it and extract the tasks it implies, exactly as you would from typed text. Describe amounts and reference numbers in the details.`;

/** Convert the schema's "unknown" sentinel back into a real null. */
function emptyToNull(s) {
  const trimmed = (s ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Call the API and hand back both the raw response and the parsed JSON.
 *
 * messages.parse() validates the reply against the schema for us, but it only
 * exists in newer SDK builds — this project hit exactly that failure once. The
 * fallback does the same job by hand so a version skew degrades instead of
 * breaking every extraction.
 */
async function callModel(params) {
  if (typeof client.messages.parse === 'function') {
    const response = await client.messages.parse(params);
    return { response, parsed: response.parsed_output };
  }
  const response = await client.messages.create(params);
  // A response is a list of content blocks; the JSON lives in the text one.
  // `?.` and `?? ''` keep this safe if the reply has no text block at all.
  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  return { response, parsed: text ? JSON.parse(text) : null };
}

/**
 * Run one message through Claude and return task field objects, not yet saved.
 * Throws on failure so the caller can mark the message for retry.
 */
async function extractTasks(message, { context = [], existing = [], seniors = [] } = {}) {
  const sentAt = message.sent_at ? new Date(message.sent_at).toISOString() : null;

  // Context the model needs but that isn't in the message text itself.
  // "Current time" is what makes "by Friday" resolvable — the model has no
  // clock of its own. .filter(Boolean) drops the nulls for absent fields.
  const contextLines = [
    `Current time: ${new Date().toISOString()}`,
    `User timezone: ${config.timezone}`,
    message.origin_name ? `Forwarded from: ${message.origin_name}` : null,
    message.origin_chat ? `Original chat: ${message.origin_chat}` : null,
    sentAt ? `Originally sent: ${sentAt}` : null,
  ].filter(Boolean);

  // Earlier messages from the same chat, oldest first, so a continuation reads
  // in the order it was written.
  if (context.length > 0) {
    contextLines.push(
      '',
      'RECENT MESSAGES from this chat (oldest first, already processed):',
      ...[...context].reverse().map((m) => `- ${collapse(m.text, 240)}`)
    );
  }

  // The open list, so the model can point at a duplicate by id.
  if (existing.length > 0) {
    contextLines.push(
      '',
      'EXISTING TASKS still open:',
      ...existing.map((t) => `- #${t.id} ${collapse(t.title, 120)}${t.requester ? ` (from ${t.requester})` : ''}`)
    );
  }

  // The user turn is a list of content blocks so images can sit alongside the
  // text. Triple quotes fence the message off from our instructions, so text
  // that looks like an instruction is read as content to analyse.
  const content = [];
  for (const image of message.images || []) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.media_type, data: image.data },
    });
  }
  content.push({
    type: 'text',
    text: `${contextLines.join('\n')}\n\nMessage:\n"""\n${message.text || '(no caption — read the image)'}\n"""`,
  });

  const { response, parsed } = await callModel({
    model: config.anthropic.model,
    // max_tokens caps thinking AND the reply together. 8192 is generous for a
    // small JSON object; too tight and a long message truncates mid-object.
    max_tokens: 8192,
    output_config: {
      effort: config.anthropic.effort, // how hard the model thinks (see config)
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA }, // the guarantee
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });

  // A refusal is a normal HTTP 200 with stop_reason set — not an exception —
  // so it has to be checked explicitly before trusting the content.
  if (response.stop_reason === 'refusal') {
    throw new Error('model declined to process this message');
  }
  if (!parsed) {
    // Most likely stop_reason: 'max_tokens' — the reply was cut off mid-JSON.
    throw new Error(`no parseable output (stop_reason: ${response.stop_reason})`);
  }

  return {
    note: emptyToNull(parsed.note),
    // `?? []` guards the (schema-forbidden, but cheap to survive) missing case.
    tasks: (parsed.tasks ?? []).map((t) => {
      // Convert the ISO string into epoch milliseconds, which is what the rest
      // of the app stores. Date.parse returns NaN on anything unparseable.
      const iso = emptyToNull(t.due_at_iso);
      const parsedDue = iso ? Date.parse(iso) : NaN;

      const requester = emptyToNull(t.requester);

      // The rule object, built from the flat sentinel fields the schema uses.
      // normaliseRule returns null for "none", which is the common case.
      const recurrence = normaliseRule({
        freq: t.repeat_freq,
        interval: t.repeat_interval,
        weekday: t.repeat_weekday >= 0 ? t.repeat_weekday : null,
        monthday: t.repeat_monthday >= 0 ? t.repeat_monthday : null,
      });

      // The model may only point at a task it was actually shown; anything else
      // is treated as "no duplicate" rather than trusted.
      const dupId = Number(t.duplicate_of) || 0;
      const dupOf = existing.some((e) => e.id === dupId) ? dupId : null;

      const fields = {
        title: t.title,
        details: emptyToNull(t.details),
        requester,
        // Seniority is decided HERE, from the user's own list — not by the
        // model. Who counts as senior is a fact about the user's world, and
        // leaving it to a judgement call would make the ranking unpredictable.
        requester_rank: rankRequester(requester, seniors),
        category: t.category,
        due_at: Number.isNaN(parsedDue) ? null : parsedDue,
        due_text: emptyToNull(t.due_text),
        urgency: t.urgency,
        importance: t.importance,
        effort_minutes: t.effort_minutes > 0 ? t.effort_minutes : null, // 0 = unknown
        waiting_on: Boolean(t.waiting_on),
        recurrence,
        recurrence_text: recurrence ? emptyToNull(t.repeat_text) : null,
        dup_of: dupOf,
        extractor: config.anthropic.model, // record which model judged this
      };

      // Score immediately so the task is ranked the moment it is saved.
      fields.score = scoreTask(fields);
      return fields;
    }),
  };
}

/** Squash whitespace and truncate — keeps prompt context lines to one line each. */
function collapse(text, max) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Extract, save, and mark the message done — the whole pipeline for one message.
 *
 * Deliberately never throws: a failed extraction must not kill the bot's poll
 * loop or return a 500 to the dashboard. The failure is recorded on the message
 * (status 'failed' + the error text) so it can be retried later, and reported
 * back to the caller in the return value.
 */
/** How far back the multi-message context window reaches. */
const CONTEXT_WINDOW_MS = 10 * 60 * 1000;

/**
 * Assemble everything the extraction needs beyond the message itself: the
 * user's senior list, the recent messages from the same chat, and the open
 * tasks to check for duplicates.
 *
 * Failures here are swallowed on purpose — this is enrichment. Losing the
 * context window should degrade the extraction, not fail the message.
 */
async function gatherContext(message) {
  try {
    const user = await dbModule.getUser(message.user_id);
    const seniors = dbModule.settingsOf(user).seniors;

    const [context, existing] = await Promise.all([
      // Only Telegram messages have a chat to gather context from.
      message.tg_chat_id
        ? dbModule.recentMessagesForChat(
            message.user_id, message.tg_chat_id, Date.now() - CONTEXT_WINDOW_MS
          // Drop the message being processed — it is already the subject.
          ).then((rows) => rows.filter((m) => m.id !== message.id))
        : [],
      dbModule.recentOpenTaskSummaries(message.user_id),
    ]);

    return { seniors, context, existing };
  } catch (err) {
    log.warn(`context lookup failed for message #${message.id}: ${err.message}`);
    return { seniors: [], context: [], existing: [] };
  }
}

async function processMessage(message) {
  try {
    const { tasks, note } = await extractTasks(message, await gatherContext(message));
    const saved = await dbModule.insertTasks(message.user_id, message.id, tasks);
    // 'no_task' is distinct from 'processed' so you can audit what the
    // extractor decided to ignore.
    await dbModule.setMessageStatus(message.id, tasks.length > 0 ? 'processed' : 'no_task');
    return { tasks: saved, note };
  } catch (err) {
    log.error(`message #${message.id} failed:`, err.message);
    await dbModule.setMessageStatus(message.id, 'failed', err.message);
    return { tasks: [], note: null, error: err.message };
  }
}

/**
 * Retry every message still marked pending — run at startup, so a crash or an
 * API outage mid-message doesn't lose it. Sequential rather than parallel:
 * these are retries, not a hot path, and it keeps API usage predictable.
 */
async function processPending() {
  const pending = await dbModule.listPendingMessages();
  const results = [];
  for (const message of pending) {
    results.push(await processMessage(message));
  }
  return results;
}

module.exports = { extractTasks, processMessage, processPending };
