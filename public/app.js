'use strict';

// ---------------------------------------------------------------------------
// app.js — the dashboard. Plain browser JavaScript, no framework and no build
// step: the file you edit is the file that runs.
//
// Shape of it: fetch tasks from /api → build DOM nodes → replace the columns.
// Re-rendering everything on each refresh is wasteful in theory and completely
// fine here (a few dozen cards), and it removes a whole class of
// state-out-of-sync bugs.
// ---------------------------------------------------------------------------

/** Shorthand for querySelector. `$('#stats')` reads better than the full call. */
const $ = (sel, root = document) => root.querySelector(sel);

// Category → CSS custom property. The values are defined once in styles.css so
// light and dark variants swap automatically; this maps meaning to slot.
const CATEGORY_COLOR = {
  work: 'var(--cat-work)',
  personal: 'var(--cat-personal)',
  finance: 'var(--cat-finance)',
  errand: 'var(--cat-errand)',
  social: 'var(--cat-social)',
  health: 'var(--cat-health)',
  other: 'var(--cat-other)',
};

// The three columns. Keys must match the bucket names the API returns.
const BUCKET = {
  now: { name: 'Now', hint: 'do these next' },
  soon: { name: 'Soon', hint: 'this week' },
  later: { name: 'Later', hint: 'when there is room' },
};

/* ------------------------------------------------------------------ helpers */

/**
 * Create an element in one call: el('div', {class:'card'}, ['text', childNode]).
 *
 * Building DOM nodes rather than assembling HTML strings is a deliberate
 * security choice: a task title containing "<script>" becomes literal text via
 * createTextNode, whereas innerHTML would execute it. The task text comes from
 * WhatsApp messages other people wrote, so that matters.
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);

  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;              // skip absent attributes
    if (k === 'class') node.className = v;               // 'class' is a reserved word in JS
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v); // onclick → 'click'
    else node.setAttribute(k, v);
  }

  // [].concat(children) accepts either a single child or an array.
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    // Nodes are appended as-is; everything else becomes escaped text.
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

let toastTimer;
/** Show a transient error message. Called with '' to dismiss the current one. */
function toast(msg) {
  $('#toast')?.remove(); // `?.` — no-op when there is no toast on screen
  if (!msg) return;

  const node = el('div', { class: 'toast', id: 'toast', role: 'status' }, msg);
  document.body.append(node);

  // Reset the timer on each new toast, so a second message gets its full time.
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 6000);
}

/** fetch wrapper: prefixes /api, sets JSON headers, turns failures into throws. */
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'content-type': 'application/json' },
    ...opts, // spread last so a caller can override method/body/headers
  });

  // fetch only rejects on network failure — an HTTP 500 is a resolved promise.
  // Convert non-2xx into a throw so callers can use try/catch uniformly.
  if (!res.ok && res.status !== 204) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).error || detail; // prefer the server's message
    } catch {
      /* body wasn't JSON — keep statusText */
    }
    throw new Error(detail);
  }

  // 204 No Content has no body; calling .json() on it would throw.
  return res.status === 204 ? null : res.json();
}

/**
 * "in 3h" / "2d ago". Relative times are easier to triage at a glance than
 * absolute ones — the exact timestamp is on hover, via the chip's title.
 */
function relative(ts) {
  const diff = ts - Date.now();  // negative = in the past
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  // Pick the largest unit that still reads naturally.
  const unit = mins < 60 ? `${mins}m`
    : abs < 86400000 ? `${Math.round(abs / 3600000)}h`
    : `${Math.round(abs / 86400000)}d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

/** Full timestamp in the viewer's locale and timezone — used for tooltips. */
function exactTime(ts) {
  return new Date(ts).toLocaleString(undefined, { // undefined = the browser's locale
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/* -------------------------------------------------------------------- cards */

/** A small rounded pill, optionally with a coloured dot and a tooltip. */
function chip(text, { color, cls, title } = {}) {
  return el('span', { class: `chip ${cls || ''}`, title }, [
    color ? el('span', { class: 'dot', style: `--c:${color}` }) : null,
    text,
  ]);
}

/** Build one task card. `onChange` re-fetches after a successful action. */
function taskCard(task, onChange) {
  const chips = [];

  // Category: a coloured dot AND the name. Colour alone would exclude
  // colour-blind readers, so the label is always there.
  if (task.category) {
    chips.push(chip(task.category, { color: CATEGORY_COLOR[task.category] || CATEGORY_COLOR.other }));
  }

  // Deadline: relative on the face, exact plus the original wording on hover.
  if (task.due_at) {
    chips.push(chip(relative(task.due_at), {
      cls: task.overdue ? 'danger' : '',
      title: `Due ${exactTime(task.due_at)}${task.due_text ? ` — "${task.due_text}"` : ''}`,
    }));
  } else if (task.due_text) {
    // A deadline the model couldn't resolve to a date ("when you get a chance").
    chips.push(chip(task.due_text));
  }

  if (task.effort_minutes) {
    const e = task.effort_minutes;
    chips.push(chip(e < 60 ? `${e} min` : `${e / 60} hr`, { title: 'Estimated effort' }));
  }
  if (task.requester) chips.push(chip(task.requester, { cls: 'who', title: 'Asked by' }));

  // data-bucket drives the card's accent colour in CSS.
  const card = el('article', { class: 'card', 'data-bucket': task.bucket });

  /** Build one action button. All three do the same thing with different fields. */
  const act = (label, cls, fields) =>
    el('button', {
      class: cls,
      onclick: async (ev) => {
        ev.currentTarget.disabled = true;   // block a double-click
        card.classList.add('leaving');      // start the slide-out animation now,
                                            // so the UI feels instant
        try {
          await api(`/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify(fields) });
          onChange(); // refresh: the card disappears because the server agrees
        } catch (err) {
          // Roll the optimistic animation back — the task is still open.
          card.classList.remove('leaving');
          ev.currentTarget.disabled = false;
          toast(`Could not update task #${task.id}: ${err.message}`);
        }
      },
    }, label);

  /** Tomorrow at 08:00 local time, as epoch ms. */
  const tomorrow8 = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1); // handles month/year rollover
    d.setHours(8, 0, 0, 0);     // h, m, s, ms
    return d.getTime();
  };

  // Filter before append(): Node.append(null) renders the string "null".
  card.append(
    ...[
      el('div', { class: 'row' }, [
        el('span', { class: 'title' }, task.title),
        el('span', { class: 'id' }, `#${task.id}`),
      ]),
      task.details ? el('p', { class: 'details' }, task.details) : null,

      // The score meter. `title` carries the breakdown from priority.js, so the
      // ranking is inspectable rather than a mystery number.
      el('div', { class: 'meter', title: task.explanation }, [
        el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${task.score}%` })),
        el('span', { class: 'num' }, String(Math.round(task.score))),
      ]),

      chips.length ? el('div', { class: 'chips' }, chips) : null,

      el('div', { class: 'actions' }, [
        act('Done', 'done', { status: 'done' }),
        act('Tomorrow', 'snooze', { status: 'snoozed', snooze_until: tomorrow8() }),
        act('Drop', 'drop', { status: 'dropped' }),
      ]),
    ].filter(Boolean)
  );

  return card;
}

/* ----------------------------------------------------------------- rendering */

/** The four tiles across the top. */
function renderStats(open, done) {
  const counts = { now: 0, soon: 0, later: 0 };
  for (const t of open) counts[t.bucket] = (counts[t.bucket] || 0) + 1;
  const overdue = open.filter((t) => t.overdue).length;

  // setHours(0,0,0,0) on a fresh Date gives local midnight — the boundary for
  // "today", which is what a person means, not the last 24 hours.
  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const doneToday = done.filter((t) => (t.completed_at ?? 0) >= startOfDay).length;

  const tile = (label, value, foot, color, hero) =>
    el('div', { class: `tile ${hero ? 'hero' : ''}` }, [
      el('div', { class: 'label' }, [
        color ? el('span', { class: 'swatch', style: `background:${color}` }) : null,
        label,
      ]),
      el('div', { class: 'value' }, String(value)),
      foot ? el('div', { class: 'foot' }, foot) : null,
    ]);

  // replaceChildren swaps the whole contents in one operation — no flicker, and
  // it clears the loading skeletons on the first render.
  $('#stats').replaceChildren(
    tile('Open tasks', open.length, open.length ? 'across all buckets' : 'inbox zero', null, true),
    tile('Now', counts.now, overdue ? `${overdue} overdue` : 'nothing overdue', 'var(--now)'),
    tile('Soon', counts.soon, 'due this week', 'var(--soon)'),
    tile('Done today', doneToday, `${done.length} all time`, 'var(--later)')
  );
}

/** Fill the three columns. */
function renderColumns(open, onChange) {
  for (const key of Object.keys(BUCKET)) {
    const items = open.filter((t) => t.bucket === key);
    // Count in the header; blank rather than "0" when empty — the empty state
    // already says it.
    $(`#col-${key} .hint`).textContent = items.length ? String(items.length) : '';

    const list = $(`#col-${key} .list`);
    list.replaceChildren(
      ...(items.length
        ? items.map((t) => taskCard(t, onChange))
        : [el('div', { class: 'empty' }, key === 'now' ? 'Nothing urgent. Enjoy it.' : 'Empty')])
    );
  }
}

/** The collapsed "Completed" list at the bottom. */
function renderDone(done) {
  $('#done-list').replaceChildren(
    ...(done.length
      ? done.slice(0, 20).map((t) => // cap it: this is a glance, not an archive
          el('div', { class: 'done-row' }, [
            el('span', { class: 'id' }, `#${t.id}`),
            el('span', { class: 't' }, t.title),
            t.completed_at ? el('span', { style: 'margin-left:auto' }, relative(t.completed_at)) : null,
          ])
        )
      : [el('div', { class: 'done-row' }, 'Nothing completed yet.')])
  );
  $('#done-count').textContent = done.length ? ` (${done.length})` : '';
}

// Guard against overlapping refreshes: the 15s timer, a tab regaining focus and
// a button click can all fire at once, and two in-flight renders would fight.
let inFlight = false;

async function refresh() {
  if (inFlight) return;
  inFlight = true;
  try {
    // Both requests in parallel rather than one after the other.
    const [open, done] = await Promise.all([api('/tasks?status=open'), api('/tasks?status=done')]);

    // The API sorts by score; completed tasks are more useful newest-first.
    done.sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));

    renderStats(open, done);
    renderColumns(open, refresh); // pass refresh so a card action re-renders
    renderDone(done);

    // Header status: green dot + last-updated time.
    $('#pulse').dataset.state = 'live';
    $('#synced').textContent = `updated ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    toast(''); // clear any stale error now that we've succeeded
  } catch (err) {
    // Usually the server was stopped. Say so plainly rather than leaving stale
    // data looking live.
    $('#pulse').dataset.state = 'down';
    $('#synced').textContent = 'disconnected';
    toast(`Could not reach the server: ${err.message}`);
  } finally {
    inFlight = false; // must run on both paths, or refresh jams permanently
  }
}

/* -------------------------------------------------------------------- theme */

/**
 * Three states, not two: 'system' follows the OS, while 'light'/'dark' override
 * it. Removing the attribute (rather than setting it) is what hands control
 * back to the CSS media query.
 */
function applyTheme(mode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = mode;

  localStorage.setItem('theme', mode); // persists across reloads

  const label = { system: 'Auto', light: 'Light', dark: 'Dark' }[mode];
  $('#theme').textContent = label;
  $('#theme').title = `Theme: ${label} — click to cycle`;
}

$('#theme').addEventListener('click', () => {
  const order = ['system', 'light', 'dark'];
  const current = localStorage.getItem('theme') || 'system';
  // Modulo wraps past the end back to the start, so the button cycles.
  applyTheme(order[(order.indexOf(current) + 1) % order.length]);
});
applyTheme(localStorage.getItem('theme') || 'system'); // restore on load

/* ------------------------------------------------------------------ capture */

$('#capture').addEventListener('submit', async (e) => {
  e.preventDefault(); // stop the browser navigating away — this is an AJAX form
  const input = $('#capture-text');
  const btn = $('#capture-btn');
  const text = input.value.trim();
  if (!text) return;

  // The model call takes a few seconds, so say so on the button.
  btn.disabled = true;
  btn.textContent = 'Reading…';
  try {
    const result = await api('/messages', { method: 'POST', body: JSON.stringify({ text }) });
    input.value = '';
    // Not an error: sometimes a message genuinely holds no task. Show the
    // model's reason so the outcome isn't a silent no-op.
    if (result.tasks.length === 0) toast(result.note || 'No task found in that message.');
    refresh();
  } catch (err) {
    toast(`Could not file that: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
});

// Press "/" anywhere to jump to the capture box — unless you are already typing.
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('#capture-text')) {
    e.preventDefault(); // otherwise "/" gets typed into the newly focused field
    $('#capture-text').focus();
  }
});

refresh();                  // initial load
setInterval(refresh, 15000); // keep up with tasks arriving via Telegram

// Refresh immediately when the tab is reopened, rather than showing whatever
// was on screen when you left and waiting up to 15s for the timer.
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
