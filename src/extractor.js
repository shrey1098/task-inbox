'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const dbModule = require('./db');
const { scoreTask } = require('./priority');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      description: 'Actionable tasks found in the message. Empty if none.',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short imperative task title, e.g. "Send Q3 invoice to Rahul".',
          },
          details: {
            type: ['string', 'null'],
            description: 'Extra context from the message worth keeping. Null if the title says it all.',
          },
          requester: {
            type: ['string', 'null'],
            description: 'Who is asking for this, if identifiable from the message or its forward header.',
          },
          category: {
            type: 'string',
            enum: ['work', 'personal', 'finance', 'errand', 'social', 'health', 'other'],
          },
          due_text: {
            type: ['string', 'null'],
            description: 'The deadline exactly as phrased in the message, e.g. "by Friday", "tonight". Null if none.',
          },
          due_at_iso: {
            type: ['string', 'null'],
            description: 'The deadline resolved to an ISO 8601 datetime using the provided current time and timezone. Null if no deadline. Prefer end of business (18:00) for date-only deadlines.',
          },
          urgency: {
            type: 'integer',
            enum: [1, 2, 3, 4, 5],
            description: 'How time-pressed this is: 1 = whenever, 3 = this week, 5 = drop everything.',
          },
          importance: {
            type: 'integer',
            enum: [1, 2, 3, 4, 5],
            description: 'How much it matters if this slips: 1 = trivial, 5 = serious consequences.',
          },
          effort_minutes: {
            type: ['integer', 'null'],
            description: 'Rough estimate of minutes to complete. Null if unguessable.',
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
      type: ['string', 'null'],
      description: 'One short sentence on why no task was extracted, when tasks is empty. Null otherwise.',
    },
  },
  required: ['tasks', 'note'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You extract actionable tasks from messages a user forwards from WhatsApp into their personal task inbox.

The user forwards a message when they believe it needs action from them, so lean towards extracting a task — but not every forward contains one: pure FYIs, greetings, or already-completed things yield an empty task list.

Rules:
- Tasks are things the USER must do, phrased as imperatives from their point of view ("Pay the electricity bill", not "User should pay").
- One message can contain several tasks; extract each separately.
- The message may include a forward header like "Forwarded from Mom" — that names the requester.
- Resolve relative deadlines ("tomorrow", "by Friday", "tonight") against the current time and timezone given in the message. If only a date is implied, use 18:00 local.
- Be honest with urgency/importance; most things are 2-3. Reserve 5s for genuine emergencies or hard external deadlines.`;

/**
 * Run one message through Claude and return an array of task field objects
 * (not yet persisted). Throws on API errors so callers can mark the message failed.
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

  const response = await client.messages.parse({
    model: config.anthropic.model,
    max_tokens: 2048,
    output_config: {
      effort: config.anthropic.effort,
      format: {
        type: 'json_schema',
        schema: OUTPUT_SCHEMA,
      },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `${contextLines.join('\n')}\n\nMessage:\n"""\n${message.text}\n"""`,
      },
    ],
  });

  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    throw new Error(`extractor got no parseable output (stop_reason: ${response.stop_reason})`);
  }

  const { tasks, note } = response.parsed_output;
  return {
    note,
    tasks: tasks.map((t) => {
      const due_at = t.due_at_iso ? Date.parse(t.due_at_iso) || null : null;
      const fields = {
        title: t.title,
        details: t.details,
        requester: t.requester,
        category: t.category,
        due_at,
        due_text: t.due_text,
        urgency: t.urgency,
        importance: t.importance,
        effort_minutes: t.effort_minutes,
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
    console.error(`[extractor] message ${message.id} failed:`, err.message);
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
