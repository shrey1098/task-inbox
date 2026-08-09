'use strict';

// ---------------------------------------------------------------------------
// app.js — the dashboard, presented as an iOS app.
//
// Plain browser JavaScript, no framework and no build step. The rendering model
// is "fetch everything, rebuild the list" — wasteful in theory, completely fine
// for a few dozen rows, and it removes a whole class of stale-state bugs.
//
// The iOS-specific behaviour lives in three places:
//   • the collapsing large title (scroll listener → .scrolled on the nav)
//   • the segmented control's sliding thumb (measured, not CSS-only)
//   • swipe-to-action rows (pointer events, so a mouse drag works too)
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* --------------------------------------------------------------- constants */

// Categories map to Apple's system colours AND to a distinct glyph. The glyph
// is not decoration: system green and system orange are close enough under
// some forms of colour blindness that colour alone would not separate them.
const CATEGORY = {
  work:     { color: 'var(--blue)',   path: 'M3 8h18v11H3zM8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' },
  personal: { color: 'var(--indigo)', path: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' },
  finance:  { color: 'var(--green)',  path: 'M3 7h18v11H3zM3 11h18M7 15h3' },
  errand:   { color: 'var(--orange)', path: 'M4 5h2l2.2 9.5a1 1 0 0 0 1 .8h7.6a1 1 0 0 0 1-.8L20 8H7M9 19h.01M17 19h.01' },
  social:   { color: 'var(--pink)',   path: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3.3 3.1-5 7-5s7 1.7 7 5M17 8a2.5 2.5 0 1 0 0-5M18 20c0-2.2-.7-3.7-2-4.6' },
  health:   { color: 'var(--red)',    path: 'M12 20s-7-4.3-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.7-7 9-7 9z' },
  other:    { color: 'var(--purple)', path: 'M4 6h16M4 12h16M4 18h10' },
};

// Bucket → label and colour. Order matters: it drives the segmented control.
const BUCKETS = {
  now:   { name: 'Now',   color: 'var(--now)' },
  soon:  { name: 'Soon',  color: 'var(--soon)' },
  later: { name: 'Later', color: 'var(--later)' },
};

// Width of one swipe action button; must match .swipe button in the stylesheet.
// The slide distance is this times the number of buttons the row actually has.
const SWIPE_BTN_W = 68;

/* ------------------------------------------------------------------ state */

const state = {
  tab: 'inbox',    // 'inbox' | 'done'
  filter: 'all',   // 'all' | 'now' | 'soon' | 'later'
  open: [],
  done: [],
};

/* ---------------------------------------------------------------- helpers */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    // Nodes append as-is; strings become TEXT nodes, so a task title containing
    // "<script>" is displayed rather than executed. Task text comes from other
    // people's messages, so this matters.
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

/**
 * Build an inline SVG icon.
 * `path` is a path string, or an array of them; an entry may also be
 * { d, fill } when one sub-path needs to be filled rather than stroked.
 */
function icon(path, { size = 20, width = 1.8, fill = 'none' } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', fill);
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', width);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const spec of [].concat(path)) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', typeof spec === 'string' ? spec : spec.d);
    if (typeof spec === 'object' && spec.fill) {
      p.setAttribute('fill', spec.fill);
      p.setAttribute('stroke', 'none');
    }
    svg.append(p);
  }
  return svg;
}

let toastTimer;
function toast(msg) {
  $('#toast')?.remove();
  if (!msg) return;
  const node = el('div', { class: 'toast', id: 'toast', role: 'status' }, msg);
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 5000);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  if (!res.ok && res.status !== 204) {
    let detail = res.statusText;
    try { detail = (await res.json()).error || detail; } catch { /* not JSON */ }
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

/** Compact relative time, iOS-style: "3h", "Yesterday", "in 2d". */
function relative(ts) {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const unit = mins < 60 ? `${mins}m`
    : abs < 86400000 ? `${Math.round(abs / 3600000)}h`
    : `${Math.round(abs / 86400000)}d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

function exactTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/* -------------------------------------------------------------------- rows */

/** Optimistically remove a row, then confirm with the server. */
async function mutate(cell, id, fields, failMsg) {
  // Collapse the row to zero height so the list closes up smoothly, the way an
  // iOS list animates a deletion.
  cell.style.height = `${cell.offsetHeight}px`;
  requestAnimationFrame(() => {
    cell.classList.add('removing');
    cell.style.height = '0px';
    cell.style.opacity = '0';
  });

  try {
    await api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
    refresh();
  } catch (err) {
    // Undo the optimistic removal — the task is still there.
    cell.classList.remove('removing');
    cell.style.height = '';
    cell.style.opacity = '';
    toast(`${failMsg}: ${err.message}`);
  }
}

/**
 * Swipe-to-reveal, using Pointer Events so touch and mouse share one code path.
 *
 * Horizontal drags move the row; vertical ones are handed back to the page so
 * scrolling still works. The axis is decided once, on the first few pixels of
 * movement, and then locked — otherwise a diagonal drag fights the scroller.
 */
function attachSwipe(cell, row, openW) {
  let startX = 0, startY = 0, dx = 0, axis = null, dragging = false;

  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;         // ignore right-click
    if (e.target.closest('.check')) return; // let the circle handle its own tap
    startX = e.clientX; startY = e.clientY;
    dx = 0; axis = null; dragging = true;
  });

  row.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;

    // Lock the axis once movement is unambiguous (>6px in one direction).
    if (!axis) {
      if (Math.abs(mx) > 6 || Math.abs(my) > 6) {
        axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
        if (axis === 'x') {
          cell.classList.add('dragging');
          // Capture the pointer so the drag survives leaving the element.
          row.setPointerCapture(e.pointerId);
        }
      }
      return;
    }
    if (axis !== 'x') return; // vertical: leave it to the page scroller

    const base = cell.classList.contains('open') ? -openW : 0;
    dx = base + mx;
    // Clamp: no dragging past fully-open, and a damped 1/3 pull to the right
    // past closed, which is how iOS resists over-scroll.
    dx = Math.max(-openW - 20, Math.min(dx > 0 ? dx / 3 : dx, 40));
    row.style.translate = `${dx}px 0`;
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    cell.classList.remove('dragging');
    row.style.translate = ''; // hand control back to the CSS class
    if (axis === 'x') {
      // Past a third of the way = open; otherwise snap shut.
      cell.classList.toggle('open', dx < -openW / 3);
    }
    axis = null;
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', end);
}

/** One list row. */
function taskRow(task) {
  const isDone = task.status === 'done';
  const cat = CATEGORY[task.category] || CATEGORY.other;

  const cell = el('div', { class: 'cell' });

  // --- the completion circle
  const check = el('button', {
    class: `check ${isDone ? 'on' : ''}`,
    type: 'button',
    'aria-label': isDone ? 'Mark not done' : 'Mark done',
    onclick: (e) => {
      e.stopPropagation();
      const next = isDone ? { status: 'open' } : { status: 'done' };
      check.classList.toggle('on');           // instant visual feedback
      setTimeout(() => mutate(cell, task.id, next, 'Could not update'), 160);
    },
  }, icon('M5 12.5l4.5 4.5L19 7.5', { size: 13, width: 2.6 }));

  // --- category tile
  const catTile = el('span', {
    class: 'cat',
    style: `background:${cat.color}`,
    title: task.category || 'other',
  }, icon(cat.path, { size: 16, width: 1.9 }));

  // --- subtitle: deadline · effort · who
  const sub = [];
  if (task.due_at) {
    sub.push(el('span', {
      class: `due ${task.overdue ? 'late' : ''}`,
      title: exactTime(task.due_at) + (task.due_text ? ` — "${task.due_text}"` : ''),
    }, task.overdue ? `Overdue ${relative(task.due_at)}` : relative(task.due_at)));
  } else if (task.due_text) {
    sub.push(el('span', { class: 'due' }, task.due_text));
  }
  if (task.effort_minutes) {
    const e = task.effort_minutes;
    sub.push(el('span', {}, e < 60 ? `${e} min` : `${e / 60} hr`));
  }
  if (task.requester) sub.push(el('span', { class: 'who' }, task.requester));

  // Interleave "·" separators between whatever pieces exist.
  const subLine = [];
  sub.forEach((node, i) => {
    if (i) subLine.push(el('span', { class: 'sep' }, '·'));
    subLine.push(node);
  });

  const row = el('div', { class: `row ${isDone ? 'done' : ''}` }, [
    check,
    catTile,
    el('div', { class: 'body' }, [
      el('div', { class: 't' }, task.title),
      subLine.length ? el('div', { class: 'sub' }, subLine) : null,
      task.details ? el('div', { class: 'detail' }, task.details) : null,
    ].filter(Boolean)),
    // Accessory: score plus a priority pip. The title attribute carries the
    // full breakdown from priority.js, so the ranking stays inspectable.
    isDone ? null : el('div', { class: 'acc', title: task.explanation }, [
      el('span', { class: 'score' }, String(Math.round(task.score))),
      el('span', { class: 'pip', style: `background:${BUCKETS[task.bucket].color}` }),
    ]),
  ].filter(Boolean));

  // --- swipe actions behind the row
  const tomorrow8 = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    return d.getTime();
  };

  const swipeBtn = (cls, label, path, fields, failMsg) =>
    el('button', {
      class: cls,
      type: 'button',
      onclick: () => mutate(cell, task.id, fields, failMsg),
    }, [icon(path, { size: 19, width: 1.9 }), label]);

  const actions = isDone
    ? [swipeBtn('undo', 'Reopen', 'M4 10h10a5 5 0 1 1-5 5M4 10l4-4M4 10l4 4',
        { status: 'open' }, 'Could not reopen')]
    : [
        swipeBtn('snooze', 'Tomorrow', 'M12 7v5l3 2M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z',
          { status: 'snoozed', snooze_until: tomorrow8() }, 'Could not snooze'),
        swipeBtn('drop', 'Drop', 'M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13',
          { status: 'dropped' }, 'Could not drop'),
      ];

  const openW = actions.length * SWIPE_BTN_W;
  cell.style.setProperty('--swipe-w', `${openW}px`);
  cell.append(el('div', { class: 'swipe' }, actions), row);
  attachSwipe(cell, row, openW);
  return cell;
}

/* --------------------------------------------------------------- rendering */

function renderSummary() {
  const counts = { now: 0, soon: 0, later: 0 };
  for (const t of state.open) counts[t.bucket] = (counts[t.bucket] || 0) + 1;

  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const doneToday = state.done.filter((t) => (t.completed_at ?? 0) >= startOfDay).length;
  const overdue = state.open.filter((t) => t.overdue).length;

  const stat = (n, label, color) =>
    el('div', { class: 'stat' }, [
      el('div', { class: 'n' }, String(n)),
      el('div', { class: 'k' }, [color ? el('i', { style: `background:${color}` }) : null, label].filter(Boolean)),
    ]);

  $('#summary').replaceChildren(
    stat(state.open.length, 'Open'),
    stat(overdue, 'Overdue', 'var(--now)'),
    stat(doneToday, 'Done today', 'var(--later)')
  );
}

/** Update the segmented control's counts and slide the thumb under the active one. */
function renderSegments() {
  const counts = { all: state.open.length, now: 0, soon: 0, later: 0 };
  for (const t of state.open) counts[t.bucket] += 1;

  for (const btn of $$('#seg button')) {
    const key = btn.dataset.filter;
    btn.classList.toggle('on', key === state.filter);
    btn.replaceChildren(
      BUCKETS[key]?.name ?? 'All',
      counts[key] ? el('span', { class: 'n' }, String(counts[key])) : null
    );
  }
  moveThumb();
}

/**
 * Position the sliding thumb. CSS can't do this alone because the segments are
 * flexible widths, so measure the active button and copy its geometry.
 */
function moveThumb() {
  const active = $('#seg button.on');
  const thumb = $('#seg-thumb');
  if (!active || !thumb) return;
  thumb.style.left = `${active.offsetLeft}px`;
  thumb.style.width = `${active.offsetWidth}px`;
}

function emptyState() {
  if (state.tab === 'done') {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'glyph' }, icon('M5 13l4 4L19 7', { size: 40, width: 1.4 })),
      el('h3', {}, 'Nothing completed yet'),
      el('p', {}, 'Finished tasks collect here.'),
    ]);
  }
  const filtered = state.filter !== 'all';
  return el('div', { class: 'empty' }, [
    el('div', { class: 'glyph' }, icon('M3 13h4l2 3h6l2-3h4M5 5h14l2 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4z', { size: 40, width: 1.4 })),
    el('h3', {}, filtered ? `Nothing in ${BUCKETS[state.filter].name}` : 'Inbox zero'),
    el('p', {}, filtered ? 'Try another filter.' : 'Forward a message to your bot to add one.'),
  ]);
}

function renderList() {
  const content = $('#content');

  if (state.tab === 'done') {
    const rows = state.done.slice(0, 50);
    content.replaceChildren(
      rows.length ? el('div', { class: 'list' }, rows.map(taskRow)) : emptyState()
    );
    $('#list-footer').textContent = state.done.length
      ? `${state.done.length} completed`
      : '';
    return;
  }

  // Inbox: optionally filtered, then grouped into Now / Soon / Later sections.
  const tasks = state.filter === 'all'
    ? state.open
    : state.open.filter((t) => t.bucket === state.filter);

  if (tasks.length === 0) {
    content.replaceChildren(emptyState());
    $('#list-footer').textContent = '';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const key of Object.keys(BUCKETS)) {
    const group = tasks.filter((t) => t.bucket === key);
    if (group.length === 0) continue;
    frag.append(
      el('div', { class: 'section-head' }, [
        el('span', { class: 'dot', style: `background:${BUCKETS[key].color}` }),
        BUCKETS[key].name,
        el('span', { class: 'count' }, String(group.length)),
      ]),
      el('div', { class: 'list' }, group.map(taskRow))
    );
  }
  content.replaceChildren(frag);
  $('#list-footer').textContent = `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
}

function render() {
  $('#page-title').textContent = state.tab === 'done' ? 'Completed' : 'Inbox';
  // The filter only applies to the inbox, so hide it on the Completed tab.
  $('#seg').style.display = state.tab === 'done' ? 'none' : '';
  renderSummary();
  renderSegments();
  renderList();
}

let inFlight = false;
async function refresh() {
  if (inFlight) return; // the timer, a tap and a tab focus can all fire at once
  inFlight = true;
  try {
    const [open, done] = await Promise.all([api('/tasks?status=open'), api('/tasks?status=done')]);
    done.sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
    state.open = open;
    state.done = done;
    render();
    $('#synced').textContent = `Updated ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
    toast('');
  } catch (err) {
    $('#synced').textContent = 'Not connected';
    toast(`Can’t reach the server: ${err.message}`);
  } finally {
    inFlight = false;
  }
}

/* ------------------------------------------------------------ interactions */

// Collapse the large title once the page scrolls, the signature iOS behaviour.
// A passive listener tells the browser we will not preventDefault, so scrolling
// stays on the compositor and never janks.
addEventListener('scroll', () => {
  $('#nav').classList.toggle('scrolled', scrollY > 24);
}, { passive: true });

// Segmented control.
$('#seg').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  render();
});

// Tab bar.
$('#tabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.tab = btn.dataset.tab;
  for (const b of $$('#tabbar button')) b.classList.toggle('on', b === btn);
  scrollTo({ top: 0 });
  render();
});

// Re-measure the segmented thumb when the width changes.
addEventListener('resize', moveThumb);

/* -------------------------------------------------------------------- theme */

const SUN = 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m11.4 0 1.4 1.4M4.9 4.9l1.4 1.4M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z';
const MOON = 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z';
const AUTO = [
  'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  { d: 'M12 3a9 9 0 0 0 0 18z', fill: 'currentColor' },
];

function applyTheme(mode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = mode;
  localStorage.setItem('theme', mode);
  const path = { system: AUTO, light: SUN, dark: MOON }[mode];
  $('#theme').replaceChildren(icon(path, { size: 20, width: 1.8 }));
  $('#theme').title = `Appearance: ${mode}`;
}

$('#theme').addEventListener('click', () => {
  const order = ['system', 'light', 'dark'];
  const current = localStorage.getItem('theme') || 'system';
  applyTheme(order[(order.indexOf(current) + 1) % order.length]);
});
applyTheme(localStorage.getItem('theme') || 'system');

/* ------------------------------------------------------------ compose sheet */

function openSheet(on) {
  $('#sheet').classList.toggle('on', on);
  $('#backdrop').classList.toggle('on', on);
  if (on) setTimeout(() => $('#compose-text').focus(), 250); // after the slide-up
  else $('#compose-text').value = '';
}

$('#compose-btn').addEventListener('click', () => openSheet(true));
$('#compose-cancel').addEventListener('click', () => openSheet(false));
$('#backdrop').addEventListener('click', () => openSheet(false));
// Escape closes the sheet — expected on a desktop keyboard.
addEventListener('keydown', (e) => { if (e.key === 'Escape') openSheet(false); });

$('#compose-submit').addEventListener('click', async () => {
  const input = $('#compose-text');
  const btn = $('#compose-submit');
  const text = input.value.trim();
  if (!text) return;

  btn.disabled = true;
  btn.textContent = 'Reading…'; // the model call takes a few seconds
  try {
    const result = await api('/messages', { method: 'POST', body: JSON.stringify({ text }) });
    openSheet(false);
    // Not an error: some messages genuinely contain no task. Surface the
    // model's reason rather than silently doing nothing.
    if (result.tasks.length === 0) toast(result.note || 'No task found in that message.');
    refresh();
  } catch (err) {
    toast(`Couldn’t add that: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
});

// Cmd/Ctrl+Enter submits from the textarea, as in most Apple apps.
$('#compose-text').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') $('#compose-submit').click();
});

/* --------------------------------------------------------------- lifecycle */

refresh();
setInterval(refresh, 15000);
// Refresh on returning to the tab rather than showing whatever was on screen
// when you left.
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
