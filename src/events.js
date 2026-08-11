'use strict';

// ---------------------------------------------------------------------------
// events.js — the push channel, so the dashboard does not have to poll.
//
// The old design refetched everything every 15 seconds. That is wasteful when
// nothing has happened (which is almost always) and still up to 15 seconds late
// when something has. Server-Sent Events invert it: the browser holds one open
// connection and the server writes to it the moment something changes.
//
// SSE rather than WebSockets because this traffic only ever goes one way.
// EventSource reconnects on its own, survives a server restart, and needs no
// library on either side — a WebSocket would add a dependency and a heartbeat
// protocol to solve a problem we do not have.
//
// Subscribers are held in memory, keyed by account. That is correct for a
// single process, which is what this app is; a multi-process deployment would
// need a shared bus (Redis, or a Mongo change stream) instead.
// ---------------------------------------------------------------------------

const { createLogger } = require('./log');

const log = createLogger('events');

/** How many tabs one account may hold open at once. */
const MAX_STREAMS_PER_USER = 8;

/** userId → Set of open response objects. One per browser tab. */
const subscribers = new Map();

/**
 * Register an open SSE response for a user. Returns an unsubscribe function.
 *
 * A Set rather than a single response because one person may have the app open
 * on a laptop and a phone at once, and both should update.
 */
function subscribe(userId, res) {
  if (!subscribers.has(userId)) subscribers.set(userId, new Set());
  const set = subscribers.get(userId);

  // A cap, because each connection holds a socket and a heartbeat timer for as
  // long as it lives. A misbehaving page — or somebody deliberately opening
  // streams in a loop — should not be able to exhaust the server's sockets.
  // Dropping the OLDEST is right: the newest connection is the live tab.
  while (set.size >= MAX_STREAMS_PER_USER) {
    const oldest = set.values().next().value;
    set.delete(oldest);
    try { oldest.end(); } catch { /* already gone */ }
    log.warn(`user #${userId} hit the stream cap; closed the oldest`);
  }

  set.add(res);

  return () => {
    const set = subscribers.get(userId);
    if (!set) return;
    set.delete(res);
    // Drop the empty Set rather than leaving a shell behind for every user who
    // has ever connected.
    if (set.size === 0) subscribers.delete(userId);
  };
}

/**
 * Push an event to every tab this user has open.
 *
 * Never throws. A dead socket is a normal outcome — the browser closed the tab,
 * the laptop slept — and a failed write must not take down whatever real work
 * triggered the notification.
 */
function emit(userId, payload) {
  const set = subscribers.get(userId);
  if (!set || set.size === 0) return;

  // The SSE wire format: "data: <json>\n\n". The blank line is what ends the
  // event, and leaving it out means the browser waits forever for more.
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try {
      res.write(frame);
    } catch (err) {
      log.debug(`dropping a dead subscriber: ${err.message}`);
      set.delete(res);
    }
  }
}

/** How many tabs are listening, for the log line at connect time. */
const countFor = (userId) => subscribers.get(userId)?.size ?? 0;

module.exports = { subscribe, emit, countFor };
