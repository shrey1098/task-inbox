'use strict';

// ---------------------------------------------------------------------------
// app.js — the dashboard, presented as an iOS app with a game layer.
//
// Plain browser JavaScript, no framework and no build step. The rendering model
// is "fetch everything, rebuild the view" — wasteful in theory, completely fine
// for a few hundred rows, and it removes a whole class of stale-state bugs.
//
// Four views share one shell: Inbox (grouped by priority), Calendar (the same
// tasks by deadline), People (grouped by who asked) and Done. On top of that
// sits the part that makes it something you want to open: a level, an XP bar, a
// streak, a daily goal, and a small celebration every time you finish something.
//
// The iOS-specific behaviour lives in a few places:
//   • the collapsing large title (scroll listener → .scrolled on the nav)
//   • the segmented control's sliding thumb (measured, not CSS-only)
//   • swipe-to-action rows (pointer events, so a mouse drag works too)
//   • sheets that slide up over a dimmed, blurred backdrop
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
const CATEGORY_KEYS = Object.keys(CATEGORY);

// Bucket → label and colour. Order matters: it drives the segmented control.
const BUCKETS = {
  p1: { name: 'P1', hint: 'Do now',    color: 'var(--p1)' },
  p2: { name: 'P2', hint: 'This week', color: 'var(--p2)' },
  p3: { name: 'P3', hint: 'Whenever',  color: 'var(--p3)' },
};

// Width of one swipe action button; must match .swipe button in the stylesheet.
// The slide distance is this times the number of buttons the row actually has.
const SWIPE_BTN_W = 68;

/**
 * How the app looks in each state of the list, worst first. `when` is tested in
 * order and the first match wins, so "anything overdue" always beats "some
 * tasks are urgent". Each mood supplies the hero card's two gradient stops and
 * the three ambient blob colours behind the page.
 */
const MOODS = [
  { key: 'late',  when: (c) => c.overdue > 0, hero: ['--red', '--orange'],  amb: ['--red', '--orange', '--pink'] },
  { key: 'p1',    when: (c) => c.p1 > 0,      hero: ['--orange', '--pink'], amb: ['--orange', '--pink', '--purple'] },
  { key: 'busy',  when: (c) => c.open > 0,    hero: ['--blue', '--indigo'], amb: ['--blue', '--purple', '--teal'] },
  { key: 'clear', when: () => true,           hero: ['--green', '--teal'],  amb: ['--green', '--teal', '--blue'] },
];

/** Longest stagger delay we will ever apply, in rows. */
const MAX_STAGGER = 12;

const DAY = 86400000;

/** Two completions inside this window count as a combo. */
const COMBO_MS = 120000;

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/* ------------------------------------------------------------------ state */

const state = {
  tab: 'inbox',      // 'inbox' | 'calendar' | 'people' | 'done'
  filter: 'all',     // 'all' | 'p1' | 'p2' | 'p3'
  open: [],
  done: [],
  game: null,        // level / xp / streak, from /api/game
  people: [],
  settings: null,
  // Calendar: which month is shown, and which day is selected inside it.
  month: startOfMonth(Date.now()),
  selectedDay: startOfDay(Date.now()),
  // Search: null when the field is closed, a string when it is open.
  search: null,
  searchResults: [],
  // People: the requester currently drilled into, or null for the list.
  person: undefined,
  // Has a fetch ever succeeded? Distinguishes "offline from the start" from
  // "briefly lost the connection", which deserve different screens.
  loaded: false,
  // Combo tracking — the timestamp of the last completion.
  lastDone: 0,
  combo: 0,
};

/* ---------------------------------------------------------------- helpers */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'value') node.value = v;          // inputs need the property
    else if (k === 'checked') node.checked = Boolean(v);
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

/**
 * A progress ring, as an SVG donut.
 *
 * The arc is drawn by setting stroke-dasharray to the full circumference and
 * then offsetting the dash by the unfinished portion — the standard trick, and
 * the reason the fill animates smoothly when only the offset changes.
 */
function ring(fraction, { size = 62, stroke = 6, label = null } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;

  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  for (const cls of ['track', 'arc']) {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', size / 2); c.setAttribute('cy', size / 2); c.setAttribute('r', r);
    c.setAttribute('stroke-width', stroke);
    c.setAttribute('class', cls);
    if (cls === 'arc') {
      c.setAttribute('stroke-dasharray', circ);
      // Offset = the part NOT filled. fraction 1 → offset 0 → full circle.
      c.setAttribute('stroke-dashoffset', circ * (1 - Math.max(0, Math.min(1, fraction))));
    }
    svg.append(c);
  }

  return el('div', { class: 'ring', style: `width:${size}px;height:${size}px` },
    [svg, label != null ? el('div', { class: 'pct' }, label) : null].filter(Boolean));
}

/**
 * Recolour the app for the current state of the list.
 *
 * Only custom properties are written — the hero gradient and the ambient blobs
 * both read them, and both have a slow CSS transition, so the change arrives as
 * a cross-fade rather than a jump.
 */
function applyMood(counts) {
  const mood = MOODS.find((m) => m.when(counts));
  const root = document.documentElement.style;
  root.setProperty('--h1', `var(${mood.hero[0]})`);
  root.setProperty('--h2', `var(${mood.hero[1]})`);
  mood.amb.forEach((v, i) => root.setProperty(`--a${i + 1}`, `var(${v})`));
  return mood;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A short burst of coloured pieces from a point on screen. Each piece gets a
 * random direction and spin as inline custom properties; the CSS animation does
 * the rest and the container removes itself once the longest one finishes.
 */
function confetti(fromEl, count = 12) {
  if (reducedMotion()) return;
  const box = fromEl.getBoundingClientRect();
  const wrap = el('div', {
    class: 'confetti',
    style: `left:${box.left + box.width / 2}px; top:${box.top + box.height / 2}px`,
  });
  const colors = ['--blue', '--green', '--orange', '--pink', '--purple', '--yellow'];

  for (let i = 0; i < count; i += 1) {
    // Spread over a full circle, with enough jitter that the burst does not
    // read as a clock face.
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 34 + Math.random() * 40;
    wrap.append(el('i', {
      style: [
        `background: var(${colors[i % colors.length]})`,
        `--dx: ${Math.cos(angle) * dist}px`,
        `--dy: ${Math.sin(angle) * dist}px`,
        `--rot: ${Math.round(Math.random() * 540 - 270)}deg`,
      ].join(';'),
    }));
  }

  document.body.append(wrap);
  setTimeout(() => wrap.remove(), 900); // just past the 750ms animation
}

/** "+18 XP" floating up from a point — the small, immediate reward. */
function floatXp(fromEl, text) {
  if (reducedMotion()) return;
  const box = fromEl.getBoundingClientRect();
  const node = el('div', {
    class: 'xp-float',
    style: `left:${box.left + box.width / 2}px; top:${box.top}px`,
  }, text);
  document.body.append(node);
  setTimeout(() => node.remove(), 1200);
}

/** The full-screen moment when a level ticks over. Rare, so it can be loud. */
function levelUpBanner(level) {
  const node = el('div', { class: 'levelup' }, [
    el('div', { class: 'levelup-card' }, [
      el('div', { class: 'levelup-n' }, String(level)),
      el('div', { class: 'levelup-t' }, 'Level up'),
    ]),
  ]);
  document.body.append(node);
  confetti(node, 26);
  setTimeout(() => node.remove(), 2200);
}

let toastTimer;
/**
 * The floating capsule. `action` adds a button — that is how Undo is offered,
 * which is why every destructive gesture in the app can be taken back.
 */
function toast(msg, action = null) {
  $('#toast')?.remove();
  if (!msg) return;

  const node = el('div', { class: 'toast', id: 'toast', role: 'status' }, [
    el('span', {}, msg),
    action ? el('button', {
      class: 'toast-action',
      type: 'button',
      onclick: () => { node.remove(); action.run(); },
    }, action.label) : null,
  ].filter(Boolean));

  document.body.append(node);
  clearTimeout(toastTimer);
  // Longer when there is something to click — five seconds is not enough time
  // to notice an Undo, decide, and reach it.
  toastTimer = setTimeout(() => node.remove(), action ? 8000 : 5000);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  // 401 means the session expired or was revoked. Reload rather than showing
  // an error: the server will redirect to the login page.
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('signed out');
  }
  if (!res.ok && res.status !== 204) {
    let detail = res.statusText;
    try { detail = (await res.json()).error || detail; } catch { /* not JSON */ }
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

/* ------------------------------------------------------------ time helpers */

/** Compact relative time, iOS-style: "3h", "in 2d". */
function relative(ts) {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const unit = mins < 60 ? `${mins}m`
    : abs < DAY ? `${Math.round(abs / 3600000)}h`
    : `${Math.round(abs / DAY)}d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

/** Just the magnitude: "2d", "6h" — for badges where "ago" is implied. */
function shortDuration(ms) {
  const abs = Math.abs(ms);
  if (abs < 3600000) return `${Math.max(1, Math.round(abs / 60000))}m`;
  if (abs < DAY) return `${Math.round(abs / 3600000)}h`;
  return `${Math.round(abs / DAY)}d`;
}

/**
 * Shorten a task title for a toast.
 *
 * A toast is a glance, not a record — you already know what you just swiped,
 * so it only has to be enough to recognise. Breaking on a word boundary rather
 * than mid-word keeps the fragment readable ("Pay the flat…" beats "Pay the fl…").
 */
function short(text, max = 24) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  // Only honour the word boundary if it isn't so early that we lose the sense.
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut.trimEnd()}…`;
}

function exactTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfMonth(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** An epoch time as the value a <input type="datetime-local"> expects. */
function toLocalInput(ts) {
  if (!ts) return '';
  const d = new Date(ts - d0(ts));
  return d.toISOString().slice(0, 16);
}
/** The timezone offset in ms, so toISOString can be used for a LOCAL value. */
function d0(ts) {
  return new Date(ts).getTimezoneOffset() * 60000;
}

/* -------------------------------------------------------------------- rows */

/**
 * Apply a change optimistically: collapse the row away immediately, then
 * confirm with the server and roll back if it refused.
 *
 * `undo` describes how to reverse it. When present the confirmation toast gets
 * an Undo button — the reason dropping something by accident is recoverable.
 */
async function mutate(cell, id, fields, failMsg, undo = null) {
  // Collapse the row to zero height so the list closes up smoothly, the way an
  // iOS list animates a deletion.
  cell.style.height = `${cell.offsetHeight}px`;
  requestAnimationFrame(() => {
    cell.classList.add('removing');
    cell.style.height = '0px';
    cell.style.opacity = '0';
  });

  try {
    const result = await api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
    if (undo) {
      toast(undo.message, {
        label: 'Undo',
        run: async () => {
          try {
            await api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(undo.fields) });
            refresh();
          } catch (err) {
            toast(`Could not undo: ${err.message}`);
          }
        },
      });
    }
    refresh();
    return result;
  } catch (err) {
    // Undo the optimistic removal — the task is still there.
    cell.classList.remove('removing');
    cell.style.height = '';
    cell.style.opacity = '';
    toast(`${failMsg}: ${err.message}`);
    return null;
  }
}

/**
 * Completing a task: the same PATCH as any other, wrapped in the celebration.
 *
 * The server returns the XP and level after the change, so the client never
 * computes the score itself — it only decides how loudly to announce it.
 */
async function completeTask(cell, check, task) {
  check.classList.add('on', 'just');
  confetti(check);

  // Combo: finishing several in quick succession is worth calling out.
  const now = Date.now();
  state.combo = now - state.lastDone < COMBO_MS ? state.combo + 1 : 1;
  state.lastDone = now;

  const before = state.game?.level ?? 1;
  floatXp(check, `+${task.xp ?? 10} XP`);

  const result = await mutate(
    cell, task.id, { status: 'done' }, 'Could not complete',
    { message: `Done · ${short(task.title)}`, fields: { status: 'open', completed_at: null } }
  );
  if (!result) return;

  if (result.game) {
    state.game = result.game;
    if (result.game.level > before) levelUpBanner(result.game.level);
  }
  // A spawned recurrence is worth mentioning — otherwise it looks like the task
  // you just completed came straight back as a bug.
  if (result.next_occurrence) {
    const due = result.next_occurrence.due_at;
    toast(`🔁 Next one ${due ? relative(due).replace('in ', 'in ') : 'scheduled'}`);
  } else if (state.combo >= 2) {
    toast(`🔥 ${state.combo} in a row`);
  }
}

/**
 * Swipe-to-reveal, using Pointer Events so touch and mouse share one code path.
 *
 * Horizontal drags move the row; vertical ones are handed back to the page so
 * scrolling still works. The axis is decided once, on the first few pixels of
 * movement, and then locked — otherwise a diagonal drag fights the scroller.
 */
function attachSwipe(cell, row, openW, onTap) {
  let startX = 0, startY = 0, dx = 0, axis = null, dragging = false;

  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;             // ignore right-click
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
    } else if (axis === null) {
      // No axis was ever locked, so the finger stayed inside the 6px threshold:
      // that is a tap. Testing for "an axis was never chosen" rather than for a
      // separate movement flag matters — an earlier version tripped that flag
      // at 4px while the axis locked at 6px, so any tap that wobbled 5px fell
      // into a dead zone and did nothing at all. On a touchscreen that is most
      // taps, which is why the detail sheet seemed not to exist.
      // A swiped-open row closes instead, as every iOS list does.
      if (cell.classList.contains('open')) cell.classList.remove('open');
      else onTap?.();
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
  const senior = task.requester_rank === 'senior';

  // Overdue escalates in three tiers, because "an hour late" and "a week late"
  // are not the same problem and should not look the same.
  const lateDays = task.overdue ? task.overdue_by / DAY : 0;
  const tier = !task.overdue ? '' : lateDays >= 3 ? 'critical' : lateDays >= 1 ? 'late' : 'due';

  const cell = el('div', {
    class: ['cell', task.overdue && !isDone ? 'late' : '', tier === 'critical' && !isDone ? 'critical' : '',
      senior && !isDone ? 'vip' : ''].filter(Boolean).join(' '),
  });

  // --- the completion circle. --c is the category colour, which the circle
  //     fills with when ticked and which the bloom ring borrows.
  const check = el('button', {
    class: `check ${isDone ? 'on' : ''}`,
    type: 'button',
    style: `--c:${cat.color}`,
    'aria-label': isDone ? 'Mark not done' : 'Mark done',
    onclick: (e) => {
      e.stopPropagation();
      if (isDone) {
        check.classList.remove('on');
        setTimeout(() => mutate(cell, task.id, { status: 'open' }, 'Could not reopen'), 160);
      } else {
        completeTask(cell, check, task);
      }
    },
  }, icon('M5 12.5l4.5 4.5L19 7.5', { size: 13, width: 2.6 }));

  // --- category tile. The gradient and glow are built in CSS from --c.
  const catTile = el('span', {
    class: 'cat',
    style: `--c:${cat.color}`,
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
  if (task.requester) {
    sub.push(el('span', { class: `who ${senior ? 'vip' : ''}` }, senior ? `★ ${task.requester}` : task.requester));
  }
  if (task.repeat_text) sub.push(el('span', { class: 'rep' }, `🔁 ${task.repeat_text}`));
  // Steps in progress are worth seeing without opening the task: a half-done
  // job looks identical to an untouched one otherwise.
  if (task.progress_count) {
    sub.push(el('span', { class: 'steps-n' },
      `▸ ${task.progress_count} step${task.progress_count === 1 ? '' : 's'}`));
  }
  if (task.waiting_on) sub.push(el('span', { class: 'wait' }, 'waiting'));

  // Interleave "·" separators between whatever pieces exist.
  const subLine = [];
  sub.forEach((node, i) => {
    if (i) subLine.push(el('span', { class: 'sep' }, '·'));
    subLine.push(node);
  });

  const badges = [];
  if (tier === 'late' || tier === 'critical') {
    badges.push(el('span', { class: `badge late ${tier}` }, `${shortDuration(task.overdue_by)} LATE`));
  }
  if (task.dup_of) badges.push(el('span', { class: 'badge dup' }, `DUPLICATE OF #${task.dup_of}`));

  const row = el('div', { class: `row ${isDone ? 'done' : ''}` }, [
    check,
    catTile,
    el('div', { class: 'body' }, [
      badges.length ? el('div', { class: 'badges' }, badges) : null,
      el('div', { class: 't' }, task.title),
      subLine.length ? el('div', { class: 'sub' }, subLine) : null,
      task.details ? el('div', { class: 'detail' }, task.details) : null,
    ].filter(Boolean)),
    // Accessory: the score as a pill tinted with its bucket's colour. The title
    // attribute carries the full breakdown from priority.js, so the ranking
    // stays inspectable rather than being a mystery number.
    el('div', { class: 'acc', title: task.explanation }, [
      isDone ? null : el('span', {
        class: 'score',
        style: `--c:${BUCKETS[task.bucket].color}`,
      }, String(Math.round(task.score))),
      // The disclosure chevron. Without it nothing on the row says it is
      // tappable, and the whole edit sheet goes undiscovered.
      el('span', { class: 'chev' }, icon('M9 5l7 7-7 7', { size: 14, width: 2.4 })),
    ].filter(Boolean)),
  ].filter(Boolean));

  // --- swipe actions behind the row
  const tomorrow8 = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    return d.getTime();
  };

  const swipeBtn = (cls, label, path, fields, failMsg, undo) =>
    el('button', {
      class: cls,
      type: 'button',
      onclick: () => mutate(cell, task.id, fields, failMsg, undo),
    }, [icon(path, { size: 19, width: 1.9 }), label]);

  // Edit is a swipe action too, not just a tap. Tapping a row is the iOS
  // convention but it is invisible, and a named button is the one way a person
  // finds a feature they are actively looking for.
  const editBtn = el('button', {
    class: 'edit',
    type: 'button',
    onclick: () => { cell.classList.remove('open'); openDetail(task.id); },
  }, [icon('M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3zM13.5 6.5l4 4', { size: 19, width: 1.9 }), 'Edit']);

  const actions = isDone
    ? [swipeBtn('undo', 'Reopen', 'M4 10h10a5 5 0 1 1-5 5M4 10l4-4M4 10l4 4',
        { status: 'open' }, 'Could not reopen')]
    : [
        editBtn,
        swipeBtn('snooze', 'Tomorrow', 'M12 7v5l3 2M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z',
          { status: 'snoozed', snooze_until: tomorrow8() }, 'Could not snooze',
          { message: `Snoozed · ${short(task.title)}`, fields: { status: 'open', snooze_until: null } }),
        swipeBtn('drop', 'Drop', 'M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13',
          { status: 'dropped' }, 'Could not drop',
          { message: `Dropped · ${short(task.title)}`, fields: { status: 'open' } }),
      ];

  const openW = actions.length * SWIPE_BTN_W;
  cell.style.setProperty('--swipe-w', `${openW}px`);
  cell.append(el('div', { class: 'swipe' }, actions), row);
  attachSwipe(cell, row, openW, () => openDetail(task.id));
  return cell;
}

/**
 * Build the rows of one list, tagging each with its position so the CSS can
 * stagger them in. The index is capped so a long list still finishes appearing
 * quickly instead of trickling in for a second and a half.
 */
function rowsOf(tasks) {
  return tasks.map((task, i) => {
    const cell = taskRow(task);
    cell.style.setProperty('--i', String(Math.min(i, MAX_STAGGER)));
    // A task that arrived over the live stream gets a one-off highlight, so a
    // list that changed while you were looking at it does not do so silently.
    if (freshIds.has(task.id)) {
      cell.classList.add('fresh');
      // Consumed on first paint — it should flash once, not on every render.
      freshIds.delete(task.id);
    }
    return cell;
  });
}

/* --------------------------------------------------------------- the hero */

/**
 * The player card: level ring, XP bar, streak, today's goal, and whichever task
 * the score says to do next. Rendering it also sets the app's mood.
 */
function renderHero() {
  const counts = {
    open: state.open.length,
    p1: state.open.filter((t) => t.bucket === 'p1').length,
    overdue: state.open.filter((t) => t.overdue).length,
  };
  const mood = applyMood(counts);

  // The card is about the inbox, so it is hidden on the archive — but the mood
  // is applied on every tab, so the ambient colour does not jump when you look.
  $('#hero').style.display = state.tab === 'done' ? 'none' : '';
  if (state.tab === 'done') return;

  const g = state.game;
  if (!g) return; // first paint, before /api/game has answered

  // Goal pips: one per task in today's target, filled as they are completed.
  // Capped at ten so a goal of twenty does not become a wall of dots.
  const pipCount = Math.min(10, g.daily_goal);
  const pips = [];
  for (let i = 0; i < pipCount; i += 1) {
    pips.push(el('i', { class: i < g.done_today ? 'on' : '' }));
  }
  // Anything beyond the goal is a bonus, and worth showing off.
  const extra = Math.max(0, g.done_today - g.daily_goal);

  const next = state.open[0];

  $('#hero').replaceChildren(
    el('button', {
      class: 'hero-inner',
      type: 'button',
      'aria-label': 'Open stats',
      onclick: openStats,
    }, [
      ring(g.progress, { size: 66, stroke: 6, label: el('span', { class: 'lvl' }, String(g.level)) }),
      el('div', { class: 'main' }, [
        el('div', { class: 'top' }, [
          el('span', { class: 'streak' }, `🔥 ${g.streak}`),
          el('span', { class: 'xp' }, `${g.xp} XP`),
          el('span', { class: 'tonext' }, `${g.to_next} to L${g.level + 1}`),
        ]),
        el('div', { class: 'goal' }, [
          el('div', { class: 'pips' }, pips),
          el('span', { class: 'goal-t' },
            extra > 0 ? `goal smashed +${extra}` : `${g.done_today}/${g.daily_goal} today`),
        ]),
        el('div', { class: 'chips' }, [
          counts.overdue ? el('span', { class: 'hot' }, `${counts.overdue} overdue`) : null,
          counts.p1 ? el('span', {}, `${counts.p1} in P1`) : null,
          el('span', {}, `${counts.open} open`),
        ].filter(Boolean)),
        next ? el('div', { class: 'next', title: next.title }, [
          el('b', {}, 'Up next'),
          el('span', { class: 'ttl' }, `· ${next.title}`),
        ]) : el('div', { class: 'next' }, mood.key === 'clear' ? 'Inbox zero. Go outside.' : ''),
      ]),
    ])
  );
}

/** "Good morning" / "Good afternoon" / "Good evening", plus today's date. */
function renderGreeting() {
  const h = new Date().getHours();
  const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  const date = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  $('#greeting').textContent = `Good ${part} · ${date}`;
}

/** Update the segmented control's counts and slide the thumb under the active one. */
function renderSegments() {
  const counts = { all: state.open.length, now: 0, soon: 0, later: 0 };
  for (const t of state.open) counts[t.bucket] += 1;

  for (const btn of $$('#seg button')) {
    const key = btn.dataset.filter;
    btn.classList.toggle('on', key === state.filter);
    // The selected segment takes its bucket's colour; "All" stays neutral.
    btn.style.setProperty('--seg-c', BUCKETS[key]?.color ?? 'var(--label)');
    // .filter(Boolean) is load-bearing: replaceChildren(null) renders the
    // literal string "null", exactly as append(null) does.
    btn.replaceChildren(
      ...[
        BUCKETS[key]?.name ?? 'All',
        counts[key] ? el('span', { class: 'n' }, String(counts[key])) : null,
      ].filter(Boolean)
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

function emptyState(title, body, gradient = 'var(--green), var(--teal)') {
  return el('div', { class: 'empty' }, [
    el('div', { class: 'glyph', style: `background:linear-gradient(145deg, ${gradient})` },
      icon('M5 13l4 4L19 7', { size: 34, width: 2 })),
    el('h3', {}, title),
    el('p', {}, body),
  ]);
}

/* ------------------------------------------------------------- inbox view */

function renderInbox() {
  const content = $('#content');
  const tasks = state.filter === 'all'
    ? state.open
    : state.open.filter((t) => t.bucket === state.filter);

  if (tasks.length === 0) {
    const filtered = state.filter !== 'all';
    content.replaceChildren(emptyState(
      filtered ? `Nothing in ${BUCKETS[state.filter].name}` : 'Inbox zero',
      filtered ? 'Try another filter.' : 'Forward a message to your bot to add one.'
    ));
    $('#list-footer').textContent = '';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const key of Object.keys(BUCKETS)) {
    const group = tasks.filter((t) => t.bucket === key);
    if (group.length === 0) continue;
    frag.append(
      el('div', { class: 'section-head' }, [
        el('span', { class: 'dot', style: `--c:${BUCKETS[key].color}` }),
        BUCKETS[key].name,
        // "P1" alone is a label you have to learn. The hint says what the band
        // means without turning the header back into an adjective.
        el('span', { class: 'hint' }, BUCKETS[key].hint),
        el('span', { class: 'count' }, String(group.length)),
      ]),
      el('div', { class: 'list' }, rowsOf(group))
    );
  }
  content.replaceChildren(frag);
  $('#list-footer').textContent = `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
}

/* ---------------------------------------------------------- calendar view */

/**
 * A month grid with a dot per task, and the selected day's tasks underneath.
 *
 * Built from the tasks already in memory rather than a separate fetch: the open
 * list is everything with a future deadline anyway, and re-using it keeps the
 * calendar exactly consistent with the inbox.
 */
function renderCalendar() {
  const content = $('#content');
  const monthStart = new Date(state.month);
  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();

  // Bucket every dated task by its local day.
  const byDay = new Map();
  for (const t of [...state.open, ...state.done]) {
    if (t.due_at == null) continue;
    const key = startOfDay(t.due_at);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(t);
  }

  // Monday-first grid. getDay() is Sunday-first, so shift it.
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = startOfDay(Date.now());

  const cells = [];
  // Leading blanks so the 1st lands under the right weekday.
  for (let i = 0; i < firstWeekday; i += 1) cells.push(el('div', { class: 'cal-cell blank' }));

  for (let day = 1; day <= daysInMonth; day += 1) {
    const ts = new Date(year, month, day).getTime();
    const tasks = byDay.get(ts) || [];
    const open = tasks.filter((t) => t.status !== 'done');
    const overdue = open.filter((t) => t.due_at < Date.now());

    // At most three dots — beyond that the count matters more than the detail.
    const dots = open.slice(0, 3).map((t) =>
      el('i', { style: `background:${BUCKETS[t.bucket]?.color || 'var(--label-3)'}` }));

    cells.push(el('button', {
      class: ['cal-cell', ts === today ? 'today' : '', ts === state.selectedDay ? 'sel' : '',
        overdue.length ? 'has-late' : ''].filter(Boolean).join(' '),
      type: 'button',
      onclick: () => { state.selectedDay = ts; render(); },
    }, [
      el('span', { class: 'd' }, String(day)),
      el('div', { class: 'dots' }, dots),
      open.length > 3 ? el('span', { class: 'more' }, `+${open.length - 3}`) : null,
    ].filter(Boolean)));
  }

  const selTasks = (byDay.get(state.selectedDay) || [])
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  content.replaceChildren(
    el('div', { class: 'cal' }, [
      el('div', { class: 'cal-head' }, [
        el('button', { class: 'cal-nav', type: 'button', 'aria-label': 'Previous month',
          onclick: () => { state.month = new Date(year, month - 1, 1).getTime(); render(); } },
          icon('M15 5l-7 7 7 7', { size: 18, width: 2.2 })),
        el('span', { class: 'cal-title' }, `${MONTHS[month]} ${year}`),
        el('button', { class: 'cal-nav', type: 'button', 'aria-label': 'Next month',
          onclick: () => { state.month = new Date(year, month + 1, 1).getTime(); render(); } },
          icon('M9 5l7 7-7 7', { size: 18, width: 2.2 })),
      ]),
      el('div', { class: 'cal-week' }, WEEKDAYS.map((d) => el('span', {}, d))),
      el('div', { class: 'cal-grid' }, cells),
    ]),
    el('div', { class: 'section-head' }, [
      new Date(state.selectedDay).toLocaleDateString(undefined,
        { weekday: 'long', day: 'numeric', month: 'long' }),
      el('span', { class: 'count' }, String(selTasks.length)),
    ]),
    selTasks.length
      ? el('div', { class: 'list' }, rowsOf(selTasks))
      : emptyState('Nothing due', 'A clear day.', 'var(--blue), var(--teal)')
  );
  $('#list-footer').textContent = '';
}

/* ------------------------------------------------------------ people view */

/**
 * Who your work is coming from. The list first; tapping a person drills into
 * just their tasks, which is the view you want before a conversation with them.
 */
function renderPeople() {
  const content = $('#content');

  // Drilled in: that person's open tasks.
  if (state.person !== undefined) {
    const who = state.person;
    const tasks = state.open.filter((t) => (t.requester ?? null) === who);
    content.replaceChildren(
      el('button', { class: 'back', type: 'button', onclick: () => { state.person = undefined; render(); } },
        [icon('M15 5l-7 7 7 7', { size: 16, width: 2.2 }), 'Everyone']),
      el('div', { class: 'section-head' }, [
        who || 'Unattributed',
        el('span', { class: 'count' }, String(tasks.length)),
      ]),
      tasks.length
        ? el('div', { class: 'list' }, rowsOf(tasks))
        : emptyState('Nothing open', 'All clear with them.')
    );
    $('#list-footer').textContent = '';
    return;
  }

  if (state.people.length === 0) {
    content.replaceChildren(emptyState('No one yet', 'Tasks show who asked once you forward a few.'));
    $('#list-footer').textContent = '';
    return;
  }

  const rows = state.people.map((p, i) => {
    const name = p.name || 'Unattributed';
    const senior = p.rank === 'senior';
    return el('div', { class: `cell person ${senior ? 'vip' : ''}`, style: `--i:${Math.min(i, MAX_STAGGER)}` }, [
      el('button', { class: 'row', type: 'button', onclick: () => { state.person = p.name ?? null; render(); } }, [
        // Initials rather than an avatar: there are no photos in this system,
        // and a coloured monogram is more legible than a generic silhouette.
        el('span', { class: 'mono', style: `--c:${colorForName(name)}` }, initials(name)),
        el('div', { class: 'body' }, [
          el('div', { class: 't' }, senior ? `★ ${name}` : name),
          el('div', { class: 'sub' }, [
            el('span', {}, `${p.count} open`),
            p.waiting ? el('span', { class: 'sep' }, '·') : null,
            p.waiting ? el('span', { class: 'wait' }, `${p.waiting} waiting`) : null,
          ].filter(Boolean)),
        ]),
        el('span', { class: 'score', style: `--c:${BUCKETS[bucketOfScore(p.top_score)].color}` },
          String(Math.round(p.top_score))),
      ]),
    ]);
  });

  content.replaceChildren(
    el('div', { class: 'section-head' }, ['Who your work comes from',
      el('span', { class: 'count' }, String(state.people.length))]),
    el('div', { class: 'list' }, rows)
  );
  $('#list-footer').textContent = '';
}

/** Mirror of priority.js's bucketOf, for values the server sent us raw. */
function bucketOfScore(score) {
  if (score >= 70) return 'p1';
  if (score >= 45) return 'p2';
  return 'p3';
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

/** A stable colour per person: hash the name, pick from the system palette. */
function colorForName(name) {
  const palette = ['--blue', '--indigo', '--purple', '--pink', '--teal', '--green', '--orange'];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return `var(${palette[hash % palette.length]})`;
}

/* -------------------------------------------------------------- done view */

function renderDone() {
  const rows = state.done.slice(0, 50);
  $('#content').replaceChildren(
    rows.length ? el('div', { class: 'list' }, rowsOf(rows))
      : emptyState('Nothing completed yet', 'Finished tasks collect here.')
  );
  $('#list-footer').textContent = state.done.length ? `${state.done.length} completed` : '';
}

/* ------------------------------------------------------------ search view */

function renderSearch() {
  const content = $('#content');
  const q = state.search.trim();

  if (q.length < 2) {
    content.replaceChildren(emptyState('Search', 'Type at least two characters.', 'var(--blue), var(--indigo)'));
    $('#list-footer').textContent = '';
    return;
  }
  if (state.searchResults.length === 0) {
    content.replaceChildren(emptyState('No matches', `Nothing for “${q}”.`, 'var(--label-3), var(--label-3)'));
    $('#list-footer').textContent = '';
    return;
  }
  content.replaceChildren(el('div', { class: 'list' }, rowsOf(state.searchResults)));
  $('#list-footer').textContent = `${state.searchResults.length} result${state.searchResults.length === 1 ? '' : 's'}`;
}

/* --------------------------------------------------------------- dispatch */

const TAB_TITLES = { inbox: 'Inbox', calendar: 'Calendar', people: 'People', done: 'Completed' };

function render() {
  const searching = state.search != null;
  const title = searching ? 'Search' : TAB_TITLES[state.tab];
  $('#page-title').textContent = title;
  // The small title that fades in once the large one scrolls away has to match
  // it — it was hard-coded to "Inbox" and stayed that way on every other tab.
  $('.nav-title').textContent = title;
  // The priority filter only makes sense on the inbox.
  $('#seg').style.display = state.tab === 'inbox' && !searching ? '' : 'none';

  renderGreeting();
  renderHero(); // also sets the app's mood colours
  if (!searching) renderSegments();

  if (searching) renderSearch();
  else if (state.tab === 'calendar') renderCalendar();
  else if (state.tab === 'people') renderPeople();
  else if (state.tab === 'done') renderDone();
  else renderInbox();
}

let inFlight = false;
async function refresh() {
  if (inFlight) return; // the timer, a tap and a tab focus can all fire at once
  inFlight = true;
  try {
    const [open, done, game, people] = await Promise.all([
      api('/tasks?status=open'),
      api('/tasks?status=done'),
      api('/game'),
      api('/people'),
    ]);
    done.sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
    state.open = open;
    state.done = done;
    state.game = game;
    state.people = people;
    state.loaded = true; // we have real data now, so never show the offline state again
    render();
    hideRefreshPill(); // whatever prompted this, the view is now current
    $('#synced').textContent = `Updated ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  } catch (err) {
    $('#synced').textContent = 'Not connected';
    // First load with no network: the service worker served the shell, but
    // there is no data behind it. Skeleton rows would sit there for ever
    // pretending something is coming, so say plainly what has happened.
    if (!state.loaded) {
      $('#hero').style.display = 'none';
      $('#content').replaceChildren(emptyState(
        'You’re offline',
        'Your tasks will appear as soon as there is a connection.',
        'var(--label-3), var(--label-3)'
      ));
      $('#list-footer').textContent = '';
    }
    toast(`Can’t reach the server: ${err.message}`);
  } finally {
    inFlight = false;
  }
}

/* ------------------------------------------------------- the detail sheet */

/**
 * The whole record for one task, editable in place, with the message it came
 * from underneath. Opened by tapping a row.
 *
 * Every field writes straight through on change rather than waiting for a Save
 * button: there is nothing here that needs to be committed atomically, and an
 * unsaved-changes prompt is a worse experience than an instant one.
 */
async function openDetail(id) {
  showSheet('#detail-sheet', true);
  $('#detail-body').replaceChildren(el('div', { class: 'sheet-loading' }, 'Loading…'));

  let task;
  try {
    task = await api(`/tasks/${id}`);
  } catch (err) {
    $('#detail-body').replaceChildren(el('p', { class: 'sheet-note' }, `Could not load: ${err.message}`));
    return;
  }

  /** PATCH one field, then refresh the list behind the sheet. */
  const save = async (fields, { reopen = false } = {}) => {
    try {
      await api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
      refresh();
      if (reopen) openDetail(id); // re-read when a change alters other fields
    } catch (err) {
      toast(`Could not save: ${err.message}`);
    }
  };

  const cat = CATEGORY[task.category] || CATEGORY.other;
  const rec = task.recurrence || {};

  const body = el('div', {}, [
    // --- title, edited in place. A textarea rather than an input so a long
    //     title wraps instead of scrolling out of sight inside the field.
    el('textarea', {
      class: 'detail-title',
      // Only a fallback: field-sizing:content overrides it where supported.
      rows: 2,
      value: task.title,
      'aria-label': 'Task title',
      // Enter commits rather than inserting a newline — a task title is one
      // line by definition, and the browser would otherwise store the break.
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
      onchange: (e) => save({ title: e.target.value.replace(/\s+/g, ' ').trim() || task.title }),
    }),

    // --- the score, explained. The breakdown is the whole justification for
    //     the ordering, so it belongs on the face of the sheet, not in a hover.
    el('div', { class: 'detail-score', style: `--c:${BUCKETS[task.bucket].color}` }, [
      el('span', { class: 'n' }, String(Math.round(task.score))),
      el('span', { class: 'why' }, task.explanation),
    ]),

    task.dup_of ? el('div', { class: 'warn' }, [
      `Looks like a duplicate of #${task.dup_of}. `,
      el('button', { class: 'linkish', type: 'button', onclick: () => openDetail(task.dup_of) }, 'Open it'),
      ' · ',
      el('button', { class: 'linkish', type: 'button', onclick: () => save({ dup_of: null }, { reopen: true }) }, 'Not a duplicate'),
    ]) : null,

    // --- the progress log, first among the sections.
    // It is what you came to the sheet for on any task that is already under
    // way: to see where you got to, and to add the next step. The fields below
    // are corrections to the extraction, which is a rarer errand.
    progressBlock(task, id, save),

    // --- the editable fields
    el('h3', { class: 'sheet-head' }, 'Details'),
    el('div', { class: 'group' }, [
      field('Due', el('input', {
        type: 'datetime-local',
        value: toLocalInput(task.due_at),
        // An empty value clears the deadline rather than being ignored.
        onchange: (e) => save({
          due_at: e.target.value ? new Date(e.target.value).getTime() : null,
          due_text: e.target.value ? null : null,
        }),
      })),
      field('Category', select(CATEGORY_KEYS, task.category || 'other', (v) => save({ category: v }))),
      field('Asked by', el('input', {
        type: 'text',
        value: task.requester || '',
        placeholder: 'Nobody',
        // reopen: the rank (and therefore the score) may change with the name.
        onchange: (e) => save({ requester: e.target.value.trim() || null }, { reopen: true }),
      })),
      field('Urgency', select(['1', '2', '3', '4', '5'], String(task.urgency), (v) => save({ urgency: Number(v) }, { reopen: true }))),
      field('Importance', select(['1', '2', '3', '4', '5'], String(task.importance), (v) => save({ importance: Number(v) }, { reopen: true }))),
      field('Effort', select(
        ['0', '5', '15', '30', '60', '120', '240', '480'],
        String(task.effort_minutes ?? 0),
        (v) => save({ effort_minutes: Number(v) || null }, { reopen: true }),
        (v) => (v === '0' ? 'unknown' : Number(v) < 60 ? `${v} min` : `${Number(v) / 60} hr`)
      )),
      // A toggle rather than a checkbox: it changes the score, so it deserves
      // to look like a switch you are throwing.
      field('Waiting on them', toggle(task.waiting_on, (on) => save({ waiting_on: on }, { reopen: true }))),
    ]),

    // --- recurrence
    el('h3', { class: 'sheet-head' }, 'Repeat'),
    el('div', { class: 'group' }, [
      field('Every', select(
        ['none', 'daily', 'weekly', 'monthly', 'yearly'],
        rec.freq || 'none',
        (v) => save({ recurrence: v === 'none' ? null : { freq: v, interval: rec.interval || 1, weekday: rec.weekday, monthday: rec.monthday } }, { reopen: true })
      )),
      rec.freq ? field('Interval', select(
        ['1', '2', '3', '4', '6', '12'],
        String(rec.interval || 1),
        (v) => save({ recurrence: { ...rec, interval: Number(v) } }, { reopen: true }),
        (v) => (v === '1' ? 'every one' : `every ${v}`)
      )) : null,
      rec.freq === 'weekly' ? field('On', select(
        ['0', '1', '2', '3', '4', '5', '6'],
        String(rec.weekday ?? new Date(task.due_at || Date.now()).getDay()),
        (v) => save({ recurrence: { ...rec, weekday: Number(v) } }, { reopen: true }),
        (v) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number(v)]
      )) : null,
      task.repeat_text ? el('div', { class: 'line' }, [
        el('span', { class: 'k' }, 'Summary'), el('span', { class: 'v' }, `🔁 ${task.repeat_text}`),
      ]) : null,
    ].filter(Boolean)),

    // --- notes
    el('h3', { class: 'sheet-head' }, 'Notes'),
    el('textarea', {
      class: 'detail-notes',
      placeholder: 'Anything you want to remember about this…',
      value: task.notes || '',
      onchange: (e) => save({ notes: e.target.value.trim() || null }),
    }),

    // --- provenance
    sourceBlock(task),

    el('div', { class: 'detail-actions' }, [
      el('button', { class: 'btn-primary', type: 'button', onclick: async () => {
        closeAllSheets();
        try {
          const r = await api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
          if (r.game) state.game = r.game;
          toast(`Done · ${short(task.title)}`, { label: 'Undo', run: () => save({ status: 'open', completed_at: null }) });
          refresh();
        } catch (err) { toast(`Could not complete: ${err.message}`); }
      } }, task.status === 'done' ? 'Completed' : 'Mark done'),
      el('button', { class: 'btn-plain btn-danger', type: 'button', onclick: async () => {
        closeAllSheets();
        await save({ status: 'dropped' });
        toast(`Dropped · ${short(task.title)}`, { label: 'Undo', run: () => save({ status: 'open' }) });
      } }, 'Drop this task'),
      el('button', { class: 'btn-plain', type: 'button', onclick: closeAllSheets }, 'Close'),
    ]),
  ].filter(Boolean));

  $('#detail-body').replaceChildren(body);
}

/** A labelled row inside a grouped list. */
function field(label, control) {
  return el('div', { class: 'line' }, [el('span', { class: 'k' }, label), control]);
}

/** A <select> that calls back with the chosen value. */
function select(values, current, onChange, labelOf = (v) => v) {
  return el('select', {
    class: 'v',
    onchange: (e) => onChange(e.target.value),
  }, values.map((v) => el('option', { value: v, selected: v === current }, labelOf(v))));
}

/** An iOS-style switch. */
function toggle(on, onChange) {
  const input = el('input', { type: 'checkbox', checked: on, onchange: (e) => onChange(e.target.checked) });
  return el('label', { class: 'switch' }, [input, el('span', { class: 'track' })]);
}

/**
 * The progress log: the steps already done, and a box to add the next one.
 *
 * Most real tasks are not one action. "Not done" is a poor summary of one you
 * have half finished, and a week later the useful question is not "is it done"
 * but "where had I got to?" — which only a log can answer.
 *
 * Steps are numbered oldest-first, so it reads as the story of the task rather
 * than as a notification feed.
 */
function progressBlock(task, id, save) {
  const steps = task.progress || [];

  const addStep = async (input) => {
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    try {
      await api(`/tasks/${id}/progress`, { method: 'POST', body: JSON.stringify({ text }) });
      input.value = '';
      refresh();
      openDetail(id); // re-read so the new step appears in the list
    } catch (err) {
      toast(`Could not log that: ${err.message}`);
    } finally {
      input.disabled = false;
    }
  };

  const removeStep = async (entryId) => {
    try {
      await api(`/tasks/${id}/progress/${entryId}`, { method: 'DELETE' });
      refresh();
      openDetail(id);
    } catch (err) {
      toast(`Could not remove that: ${err.message}`);
    }
  };

  const input = el('input', {
    type: 'text',
    placeholder: 'What did you just do?',
    'aria-label': 'Add a step',
    // Enter submits — this is a field you use repeatedly, and reaching for a
    // button every time would be the slow path.
    onkeydown: (e) => { if (e.key === 'Enter') addStep(e.target); },
  });

  return el('div', {}, [
    el('h3', { class: 'sheet-head' }, [
      'Progress',
      steps.length ? el('span', { class: 'head-n' }, `${steps.length} step${steps.length === 1 ? '' : 's'}`) : null,
    ].filter(Boolean)),

    steps.length
      ? el('ol', { class: 'steps' }, steps.map((e, i) => el('li', {}, [
          el('span', { class: 'n' }, String(i + 1)),
          el('div', { class: 'body' }, [
            el('div', { class: 't' }, e.text),
            el('div', { class: 'when', title: exactTime(e.at) }, `${relative(e.at)} · ${exactTime(e.at)}`),
          ]),
          el('button', {
            class: 'x',
            type: 'button',
            'aria-label': 'Remove this step',
            onclick: () => removeStep(e.id),
          }, '×'),
        ])))
      : el('p', { class: 'sheet-note' }, 'No steps yet. Log what you have done so far and the task keeps its history.'),

    el('div', { class: 'add-row' }, [
      input,
      el('button', { class: 'btn-add', type: 'button', onclick: () => addStep(input) }, 'Log'),
    ]),
  ]);
}

/**
 * The message this task came from — the answer to "why do I have this?".
 * Shows the transcript for a voice note and the photo for a screenshot, both
 * labelled, so machine-heard text is never mistaken for something you typed.
 */
function sourceBlock(task) {
  const src = task.source;
  if (!src) {
    return el('div', {}, [
      el('h3', { class: 'sheet-head' }, 'Source'),
      el('p', { class: 'sheet-note' }, 'Added by hand — no message behind this one.'),
    ]);
  }

  const KINDS = { text: '💬 Forwarded message', photo: '🖼 Photo', voice: '🎤 Voice note' };

  return el('div', {}, [
    el('h3', { class: 'sheet-head' }, 'Source'),
    el('div', { class: 'source' }, [
      el('div', { class: 'source-head' }, [
        el('span', {}, KINDS[src.kind] || KINDS.text),
        src.origin_name ? el('span', { class: 'from' }, `from ${src.origin_name}`) : null,
        src.sent_at ? el('span', { class: 'when' }, exactTime(src.sent_at)) : null,
      ].filter(Boolean)),
      src.has_image ? el('img', {
        class: 'source-img',
        src: `/api/messages/${src.id}/image`,
        alt: 'The forwarded photo',
        loading: 'lazy',
      }) : null,
      src.transcript
        ? el('p', { class: 'source-text transcript' }, `“${src.transcript}”`)
        : (src.text ? el('p', { class: 'source-text' }, src.text) : null),
    ].filter(Boolean)),
  ]);
}

/* -------------------------------------------------------- the stats sheet */

/**
 * The trophy cabinet: level, streak, lifetime totals, and a summary for any
 * period you care to ask about.
 */
async function openStats() {
  showSheet('#stats-sheet', true);
  $('#stats-body').replaceChildren(el('div', { class: 'sheet-loading' }, 'Loading…'));

  const g = state.game || await api('/game');

  const periods = ['today', 'this week', 'last week', 'this month', 'last month', '30 days'];
  let period = 'this week';

  const summaryHost = el('div', { class: 'summary-host' });

  const loadSummary = async () => {
    summaryHost.replaceChildren(el('div', { class: 'sheet-loading' }, 'Counting…'));
    try {
      const s = await api(`/summary?period=${encodeURIComponent(period)}`);
      summaryHost.replaceChildren(summaryView(s));
    } catch (err) {
      summaryHost.replaceChildren(el('p', { class: 'sheet-note' }, `Could not load: ${err.message}`));
    }
  };

  $('#stats-body').replaceChildren(el('div', {}, [
    el('h2', {}, 'Your progress'),

    // The headline: level ring, streak, lifetime.
    el('div', { class: 'stat-hero' }, [
      ring(g.progress, { size: 92, stroke: 8, label: el('span', { class: 'lvl big' }, String(g.level)) }),
      el('div', { class: 'stat-lines' }, [
        el('div', { class: 'big' }, `${g.xp} XP`),
        el('div', { class: 'muted' }, `${g.to_next} XP to level ${g.level + 1}`),
        el('div', { class: 'flames' }, `🔥 ${g.streak}-day streak`),
        el('div', { class: 'muted' }, `Best ${g.best_streak} · ${g.days_active} active days`),
      ]),
    ]),

    el('div', { class: 'tiles' }, [
      tile(String(g.lifetime_done), 'tasks done', 'var(--green)'),
      tile(String(g.done_today), `of ${g.daily_goal} today`, 'var(--blue)'),
      tile(String(g.best_streak), 'best streak', 'var(--orange)'),
    ]),

    el('h3', { class: 'sheet-head' }, 'Summary'),
    // The period picker. Any of these, or a custom range below.
    el('div', { class: 'chips picker' }, periods.map((p) =>
      el('button', {
        class: p === period ? 'on' : '',
        type: 'button',
        onclick: (e) => {
          period = p;
          for (const b of $$('.picker button', $('#stats-body'))) b.classList.remove('on');
          e.target.classList.add('on');
          loadSummary();
        },
      }, p))),

    // An explicit range, for "how did March go?".
    el('div', { class: 'range' }, [
      el('input', { type: 'date', id: 'range-from', 'aria-label': 'From' }),
      el('span', {}, 'to'),
      el('input', { type: 'date', id: 'range-to', 'aria-label': 'To' }),
      el('button', { class: 'btn-add', type: 'button', onclick: async () => {
        const from = $('#range-from').value;
        const to = $('#range-to').value;
        if (!from || !to) return toast('Pick both dates.');
        period = `${from}..${to}`;
        for (const b of $$('.picker button', $('#stats-body'))) b.classList.remove('on');
        loadSummary();
      } }, 'Go'),
    ]),

    summaryHost,
    el('button', { class: 'btn-plain', type: 'button', onclick: closeAllSheets }, 'Done'),
  ]));

  loadSummary();
}

function tile(n, label, color) {
  return el('div', { class: 'tile', style: `--c:${color}` }, [
    el('div', { class: 'n' }, n),
    el('div', { class: 'k' }, label),
  ]);
}

/** One rendered period summary. */
function summaryView(s) {
  const rows = [];

  rows.push(el('div', { class: 'tiles' }, [
    tile(String(s.completed), 'completed', 'var(--green)'),
    tile(String(s.created), 'arrived', 'var(--blue)'),
    tile(`${s.xp_earned}`, 'XP earned', 'var(--purple)'),
  ]));

  if (s.span_days > 1) {
    rows.push(el('p', { class: 'sheet-note' },
      `${s.per_day} a day over ${s.span_days} days · ${s.still_open} still open${s.still_overdue ? `, ${s.still_overdue} overdue` : ''}`));
  }

  if (s.by_category.length) {
    // A stacked bar: the split by category, in one line, using each category's
    // own colour so it matches the tiles on every row in the list.
    const total = s.by_category.reduce((sum, c) => sum + c.n, 0);
    rows.push(el('div', { class: 'bar' }, s.by_category.map((c) =>
      el('i', {
        style: `flex:${c.n};background:${(CATEGORY[c.key] || CATEGORY.other).color}`,
        title: `${c.key}: ${c.n}`,
      }))));
    rows.push(el('div', { class: 'legend' }, s.by_category.map((c) =>
      el('span', {}, [
        el('i', { style: `background:${(CATEGORY[c.key] || CATEGORY.other).color}` }),
        `${c.key} ${c.n}`,
      ]))));
    rows.push(el('p', { class: 'sheet-note' }, `${total} completed in total.`));
  }

  if (s.by_requester.length) {
    rows.push(el('h3', { class: 'sheet-head' }, 'Most demanding'));
    rows.push(el('div', { class: 'group' }, s.by_requester.map((r) =>
      el('div', { class: 'line' }, [el('span', { class: 'k' }, r.key), el('span', { class: 'v' }, String(r.n))]))));
  }

  if (s.highlights.length) {
    rows.push(el('h3', { class: 'sheet-head' }, 'Biggest wins'));
    rows.push(el('div', { class: 'group' }, s.highlights.map((h) =>
      el('div', { class: 'line' }, [
        el('span', { class: 'k' }, h.title),
        el('span', { class: 'v' }, String(Math.round(h.score))),
      ]))));
  }

  if (s.worst_open) {
    rows.push(el('div', { class: 'warn' },
      `Longest overdue: ${s.worst_open.title} — ${shortDuration(Date.now() - s.worst_open.due_at)} late.`));
  }

  if (!s.completed && !s.created) {
    rows.push(el('p', { class: 'sheet-note' }, 'Nothing happened in that window.'));
  }

  return el('div', {}, rows);
}

/* ------------------------------------------------------------ interactions */

// Collapse the large title once the list scrolls, the signature iOS behaviour.
// The listener is on <main>, not on the window: the document is locked so it
// never scrolls, and window.scrollY would be permanently 0.
// A passive listener tells the browser we will not preventDefault, so scrolling
// stays on the compositor and never janks.
$('#main').addEventListener('scroll', (e) => {
  $('#nav').classList.toggle('scrolled', e.target.scrollTop > 24);
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
  state.person = undefined; // leaving People resets the drill-down
  closeSearch();
  for (const b of $$('#tabbar button')) b.classList.toggle('on', b === btn);
  $('#main').scrollTop = 0;
  render();
});

// Re-measure the segmented thumb when the width changes.
addEventListener('resize', moveThumb);

/* -------------------------------------------------------------------- search */

let searchTimer;
function openSearch() {
  state.search = '';
  $('#searchbar').hidden = false;
  $('#search-input').value = '';
  $('#search-input').focus();
  render();
}
function closeSearch() {
  if (state.search == null) return;
  state.search = null;
  state.searchResults = [];
  $('#searchbar').hidden = true;
  render();
}

$('#search-btn').addEventListener('click', () => (state.search == null ? openSearch() : closeSearch()));
$('#search-cancel').addEventListener('click', closeSearch);

$('#search-input').addEventListener('input', (e) => {
  state.search = e.target.value;
  // Debounced: typing "deposit" should be one request, not seven.
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = state.search.trim();
    if (q.length < 2) { state.searchResults = []; return render(); }
    try {
      state.searchResults = await api(`/search?q=${encodeURIComponent(q)}`);
    } catch {
      state.searchResults = [];
    }
    render();
  }, 220);
});

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

/* ------------------------------------------------------------------ sheets */

/** Show or hide one sheet. The backdrop is shared by all of them. */
const SHEETS = ['#sheet', '#account-sheet', '#detail-sheet', '#stats-sheet'];

function showSheet(id, on) {
  $(id).classList.toggle('on', on);
  const anyOpen = SHEETS.some((s) => $(s).classList.contains('on'));
  $('#backdrop').classList.toggle('on', anyOpen);
  // Stop the page behind a sheet from scrolling under it.
  document.body.classList.toggle('locked', anyOpen);
}

function openSheet(on) {
  showSheet('#sheet', on);
  if (on) setTimeout(() => $('#compose-text').focus(), 250); // after the slide-up
  else $('#compose-text').value = '';
}

function closeAllSheets() {
  for (const s of SHEETS) $(s).classList.remove('on');
  $('#backdrop').classList.remove('on');
  document.body.classList.remove('locked');
  $('#compose-text').value = '';
}

$('#compose-btn').addEventListener('click', () => openSheet(true));
$('#compose-cancel').addEventListener('click', () => openSheet(false));
$('#backdrop').addEventListener('click', closeAllSheets);
// Escape closes whatever is open — expected on a desktop keyboard.
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllSheets(); });

/* ------------------------------------------------------------ account sheet */

/** Load identity, Telegram status and preferences into the account sheet. */
async function loadAccount() {
  try {
    const [me, settings] = await Promise.all([api('/me'), api('/settings')]);
    state.settings = settings;

    $('#acct-email').textContent = me.email;
    $('#acct-tg').textContent = me.tg_linked ? 'Linked' : 'Not linked';
    $('#acct-tg').classList.toggle('ok', me.tg_linked);
    // Linking and unlinking are mutually exclusive states.
    $('#link-btn').hidden = me.tg_linked;
    $('#unlink-btn').hidden = !me.tg_linked;
    if (me.tg_linked) $('#link-area').hidden = true;

    renderSeniors();
    renderSettings();
  } catch {
    // api() already redirects on 401; anything else is transient.
  }
}

/** Save one or more preferences and re-render what depends on them. */
async function saveSettings(patch) {
  try {
    state.settings = await api('/settings', { method: 'PUT', body: JSON.stringify(patch) });
    renderSeniors();
    renderSettings();
    // The senior list re-ranks existing tasks server-side, so the list behind
    // the sheet is now out of date.
    refresh();
  } catch (err) {
    toast(`Could not save: ${err.message}`);
  }
}

function renderSeniors() {
  const list = state.settings?.seniors ?? [];
  $('#seniors-list').replaceChildren(
    ...(list.length
      ? list.map((name) => el('span', { class: 'chip vip' }, [
          `★ ${name}`,
          el('button', {
            type: 'button',
            'aria-label': `Remove ${name}`,
            onclick: () => saveSettings({ seniors: list.filter((s) => s !== name) }),
          }, '×'),
        ]))
      : [el('span', { class: 'chip muted' }, 'Nobody yet')])
  );
}

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  $('#settings-group').replaceChildren(
    field('Morning digest', toggle(s.digest_enabled, (on) => saveSettings({ digest_enabled: on }))),
    field('Digest at', select(
      [...Array(24).keys()].map(String), String(s.digest_hour),
      (v) => saveSettings({ digest_hour: Number(v) }),
      (v) => `${String(v).padStart(2, '0')}:00`
    )),
    field('Deadline nudge', toggle(s.nudge_enabled, (on) => saveSettings({ nudge_enabled: on }))),
    field('Nudge me', select(
      ['15', '30', '60', '120', '240'], String(s.nudge_lead_minutes),
      (v) => saveSettings({ nudge_lead_minutes: Number(v) }),
      (v) => (Number(v) < 60 ? `${v} min before` : `${Number(v) / 60} hr before`)
    )),
    field('Weekly review', toggle(s.weekly_enabled, (on) => saveSettings({ weekly_enabled: on }))),
    field('Daily goal', select(
      ['1', '2', '3', '5', '8', '10', '15'], String(s.daily_goal),
      (v) => saveSettings({ daily_goal: Number(v) }),
      (v) => `${v} tasks`
    ))
  );
}

$('#account-btn').addEventListener('click', () => {
  showSheet('#account-sheet', true);
  loadAccount();
  renderInstall();
});
$('#account-cancel').addEventListener('click', closeAllSheets);

$('#senior-add').addEventListener('click', () => {
  const input = $('#senior-input');
  const name = input.value.trim();
  if (name.length < 2) return toast('Give at least two characters.');
  saveSettings({ seniors: [...(state.settings?.seniors ?? []), name] });
  input.value = '';
});
$('#senior-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#senior-add').click();
});

$('#link-btn').addEventListener('click', async () => {
  const btn = $('#link-btn');
  btn.disabled = true;
  try {
    const { link_code } = await api('/me/link-code', { method: 'POST' });
    $('#link-code').textContent = link_code;
    $('#link-area').hidden = false;
    btn.textContent = 'New code';
  } catch (err) {
    toast(`Couldn’t create a code: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

$('#unlink-btn').addEventListener('click', async () => {
  try {
    await api('/me/unlink', { method: 'POST' });
    loadAccount();
    toast('Telegram unlinked.');
  } catch (err) {
    toast(`Couldn’t unlink: ${err.message}`);
  }
});

$('#logout-btn').addEventListener('click', async () => {
  // Not api(): a 401 here would bounce through the redirect path pointlessly.
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login.html';
});

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

/* ------------------------------------------------------------ live updates */

/*
 * The app does not poll.
 *
 * It used to refetch everything every 15 seconds, which is wasted work when
 * nothing has happened (almost always) and still up to 15 seconds late when
 * something has. Instead the server holds one Server-Sent Events connection
 * open and says what happened, the moment it happens.
 *
 * The two cases are treated differently on purpose:
 *
 *   tasks-added    A task arrived — almost always something you just forwarded
 *                  to the bot and are waiting to see. Pull it in immediately;
 *                  making you press a button to see the thing you just sent
 *                  would be silly.
 *
 *   tasks-changed  Something moved that you did not do here: /done from the
 *                  phone, a snooze from the bot. Refetching under your finger
 *                  while you are reading the list is worse than being slightly
 *                  stale, so this offers a button and waits.
 */
let stream;
let pendingChanges = false;

function connectStream() {
  // EventSource reconnects by itself after a drop, with its own backoff, so
  // there is no retry logic to write here.
  stream = new EventSource('/api/events');

  stream.addEventListener('message', (e) => {
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }

    if (payload.type === 'tasks-added') {
      // Remember which ids are new so the rows can be highlighted once drawn.
      for (const id of payload.ids || []) freshIds.add(id);
      refresh();
      const n = (payload.ids || []).length;
      toast(n === 1 ? 'New task added' : `${n} new tasks added`);
    } else if (payload.type === 'tasks-changed') {
      showRefreshPill();
    }
  });

  stream.addEventListener('error', () => {
    // Fires on every disconnect, including the ones EventSource is about to
    // recover from on its own. Only worth reacting to when it has given up.
    if (stream.readyState === EventSource.CLOSED) {
      $('#synced').textContent = 'Reconnecting…';
      setTimeout(connectStream, 5000);
    }
  });
}

/** Ids that arrived while you were looking, so their rows can flash once. */
const freshIds = new Set();

/** The "something changed" button. Nothing refetches until it is pressed. */
function showRefreshPill() {
  if (pendingChanges) return; // already offered
  pendingChanges = true;
  $('#refresh-pill').hidden = false;
}

function hideRefreshPill() {
  pendingChanges = false;
  $('#refresh-pill').hidden = true;
}

$('#refresh-pill').addEventListener('click', () => {
  hideRefreshPill();
  refresh();
});

// The "Updated 14:32" line is also a refresh button, so there is always a way
// to force one even if the stream never connected.
$('#synced').addEventListener('click', () => { hideRefreshPill(); refresh(); });

/* --------------------------------------------------------- installable app */

/*
 * Service worker registration.
 *
 * Two things it buys: the app becomes installable (a home-screen icon that
 * opens with no browser chrome), and a cold launch paints from cache instead
 * of waiting on the network. It caches static files only — never API
 * responses, which are one account's private data. See sw.js.
 */
if ('serviceWorker' in navigator) {
  // After load, so registering never competes with the first paint.
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // A new worker means a new deploy. Tell the user rather than swapping
      // the code under them mid-action — the running page may have a sheet
      // open and half-typed text in it.
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // 'installed' with an existing controller = an update, not a first
          // install. Without that check this fires on the very first visit.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            toast('A new version is ready', { label: 'Reload', run: () => location.reload() });
          }
        });
      });
    }).catch((err) => {
      // Not fatal: without a worker the app simply behaves like a normal site.
      console.warn('service worker registration failed:', err.message);
    });
  });
}

/*
 * The install prompt.
 *
 * Chrome fires beforeinstallprompt and lets you defer it; iOS Safari has no
 * such API and requires Share → Add to Home Screen by hand. The account sheet
 * shows whichever of those two applies, and nothing at all once installed.
 */
let installPrompt = null;

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // stop Chrome's own mini-infobar; we have our own banner
  installPrompt = e;
  renderInstall();
  offerInstall();
});

addEventListener('appinstalled', () => {
  installPrompt = null;
  $('#install-banner')?.remove();
  renderInstall();
  toast('Installed. Open it from your home screen.');
});

/* --- the automatic offer ------------------------------------------------- */

/*
 * Nobody goes looking in a settings screen for "install". The offer has to come
 * to them — but an offer that reappears on every visit is an advert, so it is
 * shown once and then left alone for a fortnight.
 */
const INSTALL_SNOOZE_KEY = 'wilco.install.snoozed';
const INSTALL_SNOOZE_MS = 14 * DAY;
const INSTALL_DELAY_MS = 2500; // let the list paint first

function installSnoozed() {
  const at = Number(localStorage.getItem(INSTALL_SNOOZE_KEY) || 0);
  return Date.now() - at < INSTALL_SNOOZE_MS;
}

/** iOS has no install API at all — the only route is Share → Add to Home Screen. */
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  // iPadOS 13+ reports itself as a Mac, and a touchscreen is the giveaway.
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** On iOS only Safari can install. Chrome and Firefox there simply cannot. */
const isIosSafari = () => isIos() && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);

/**
 * Show the banner, if there is anything worth showing.
 *
 * Called both when Chrome hands us a prompt and, on a delay, at startup —
 * because on iOS no event ever arrives and waiting for one would mean iPhone
 * users never see the offer at all.
 */
function offerInstall() {
  if (isInstalled() || installSnoozed()) return;
  if ($('#install-banner')) return;              // already up
  if (!installPrompt && !isIosSafari()) return;  // nothing useful to say here

  const dismiss = () => {
    localStorage.setItem(INSTALL_SNOOZE_KEY, String(Date.now()));
    const node = $('#install-banner');
    if (!node) return;
    node.classList.remove('on');
    // Let the slide-down finish before removing it.
    setTimeout(() => node.remove(), 300);
  };

  const install = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null; // a prompt can only be used once
    // "dismissed" is a no for now, not for ever, but re-asking immediately
    // would be obnoxious — the snooze applies either way.
    if (outcome !== 'accepted') dismiss();
    else $('#install-banner')?.remove();
    renderInstall();
  };

  const banner = el('div', { class: 'install-banner', id: 'install-banner' }, [
    el('img', { class: 'ib-icon', src: '/icons/icon-192.png', alt: '', width: 44, height: 44 }),
    el('div', { class: 'ib-body' }, [
      el('b', {}, 'Add Wilco to your home screen'),
      el('span', {}, installPrompt
        ? 'Opens full screen, loads instantly, works offline.'
        : 'Tap Share, then “Add to Home Screen”.'),
    ]),
    // iOS gets no button, because there is no API to trigger — just an arrow
    // pointing at the Share control in Safari's toolbar below.
    installPrompt
      ? el('button', { class: 'ib-cta', type: 'button', onclick: install }, 'Install')
      : el('span', { class: 'ib-arrow', 'aria-hidden': 'true' },
          icon('M12 4v14m0 0l-6-6m6 6l6-6', { size: 22, width: 2.4 })),
    el('button', { class: 'ib-x', type: 'button', 'aria-label': 'Not now', onclick: dismiss }, '×'),
  ]);

  document.body.append(banner);
  // Next frame, so the slide-up transition has a starting state to animate from.
  requestAnimationFrame(() => banner.classList.add('on'));
}

/** True when running from the home screen rather than in a browser tab. */
const isInstalled = () =>
  matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function renderInstall() {
  const host = $('#install-area');
  if (!host) return;

  if (isInstalled()) {
    host.replaceChildren(el('p', { class: 'sheet-note' }, 'Installed. Enjoy.'));
    return;
  }
  if (installPrompt) {
    host.replaceChildren(el('button', {
      class: 'btn-primary', type: 'button',
      onclick: async () => {
        installPrompt.prompt();
        await installPrompt.userChoice;
        installPrompt = null; // a prompt may only be used once
        renderInstall();
      },
    }, 'Add to home screen'));
    return;
  }
  // iOS, or a browser that has already dismissed the prompt.
  host.replaceChildren(el('p', { class: 'sheet-note' },
    'On iPhone: tap Share, then "Add to Home Screen". On Android: the browser menu, then "Install app".'));
}

/* --------------------------------------------------------------- lifecycle */

refresh();
connectStream();

// The install offer, once the app has had a moment to draw itself. On Chrome
// beforeinstallprompt has usually fired by now; on iOS nothing ever fires, so
// this timer is the only thing that surfaces it there.
setTimeout(offerInstall, INSTALL_DELAY_MS);

// Coming back to the tab is a deliberate act, and the stream may have missed
// events while the page was frozen in the background — so this one refetch
// stays. It is not a timer.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  hideRefreshPill();
  refresh();
});
