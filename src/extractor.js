'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const dbModule = require('./db');
const { scoreTask } = require('./priority');
const { createLogger } = require('./log');

const log = createLogger('extract');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * Structured-output schema. Optional values use empty string / 0 rather than
 * null unions, which keeps the schema inside the documented supported subset.
 * normalise() turns the sentinels back into nulls.
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
            enum: [1, 2, 3, 4, 5],
            description: 'Time pressure: 1 = whenever, 3 = this week, 5 = drop everything.',
          },
          importance: {
            type: 'integer',
            enum: [1, 2, 3, 4, 5],
            description: 'Cost of slipping: 1 = trivial, 5 = serious consequences.',
          },
          effort_minutes: {
            type: 'integer',
            enum: [0, 5, 15, 30, 60, 120, 240, 480],
            description: 'Rough minutes to complete. 0 when it cannot be guessed.',
          },
        },
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
        ],
        additionalProperties: false,
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

const SYSTEM_PROMPT = `You extract actionable tasks from messages a user forwards from WhatsApp into their personal task inbox.

The user forwards a message when they believe it needs action from them, so lean towards extracting a task — but not every forward contains one: pure FYIs, status updates, greetings, or already-completed things yield an empty task list.

Rules:
- Tasks are things the USER must do, phrased as imperatives from their point of view ("Pay the electricity bill", not "User should pay").
- One message can contain several tasks; extract each separately.
- The message may include a forward header naming who it came from — that is usually the requester.
- Resolve relative deadlines ("tomorrow", "by Friday", "tonight") against the current time and timezone given. If only a date is implied, use 18:00 local.
- Be honest with urgency and importance; most things are 2-3. Reserve 5 for genuine emergencies or hard external deadlines.`;

function emptyToNull(s) {
  const trimmed = (s ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** Older SDK builds lack messages.parse; fall back to create + JSON.parse. */
async function callModel(params) {
  if (typeof client.messages.parse === 'function') {
    const response = await client.messages.parse(params);
    return { response, parsed: response.parsed_output };
  }
  const response = await client.messages.create(params);
  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  return { response, parsed: text ? JSON.parse(text) : null };
}

/**
 * Run one message through Claude and return task field objects (not yet persisted).
 * Throws on API errors so callers can mark the message failed and retry later.
 */
async function extractTasks(message) {
  const sentAt = message.sent_at ? new Date(message.sent_at).toISOString() : null;
  const contextLines = [
    `Current time: ${new Date().toISOString()}`,
    `User timezone: ${config.timezone}`,
    message.origin_name ? `Forwarded from: ${message.origin_name}` : null,
    message.origin_chat ? `Original chat: ${message.origin_chat}` : null,
    sentAt ? `Originally sent: ${sentAt}` : null,
  ].filter(Boolean);

  const { response, parsed } = await callModel({
    model: config.anthropic.model,
    // Thinking shares this budget with the response, so leave headroom.
    max_tokens: 8192,
    output_config: {
      effort: config.anthropic.effort,
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `${contextLines.join('\n')}\n\nMessage:\n"""\n${message.text}\n"""`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('model declined to process this message');
  }
  if (!parsed) {
    throw new Error(`no parseable output (stop_reason: ${response.stop_reason})`);
  }

  return {
    note: emptyToNull(parsed.note),
    tasks: (parsed.tasks ?? []).map((t) => {
      const iso = emptyToNull(t.due_at_iso);
      const parsedDue = iso ? Date.parse(iso) : NaN;
      const fields = {
        title: t.title,
        details: emptyToNull(t.details),
        requester: emptyToNull(t.requester),
        category: t.category,
        due_at: Number.isNaN(parsedDue) ? null : parsedDue,
        due_text: emptyToNull(t.due_text),
        urgency: t.urgency,
        importance: t.importance,
        effort_minutes: t.effort_minutes > 0 ? t.effort_minutes : null,
        extractor: config.anthropic.model,
      };
      fields.score = scoreTask(fields);
      return fields;
    }),
  };
}

/**
 * Process a stored message end-to-end: extract, persist tasks, update status.
 * Returns { tasks, note }. Never throws — failures are recorded on the message.
 */
async function processMessage(message) {
  try {
    const { tasks, note } = await extractTasks(message);
    const saved = await dbModule.insertTasks(message.id, tasks);
    await dbModule.setMessageStatus(message.id, tasks.length > 0 ? 'processed' : 'no_task');
    return { tasks: saved, note };
  } catch (err) {
    log.error(`message #${message.id} failed:`, err.message);
    await dbModule.setMessageStatus(message.id, 'failed', err.message);
    return { tasks: [], note: null, error: err.message };
  }
}

/** Retry anything still pending (e.g. after a crash or API outage). */
async function processPending() {
  const pending = await dbModule.listPendingMessages();
  const results = [];
  for (const message of pending) {
    results.push(await processMessage(message));
  }
  return results;
}

module.exports = { extractTasks, processMessage, processPending };
