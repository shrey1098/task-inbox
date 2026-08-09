'use strict';

const $ = (sel, root = document) => root.querySelector(sel);

const CATEGORY_COLOR = {
  work: 'var(--cat-work)',
  personal: 'var(--cat-personal)',
  finance: 'var(--cat-finance)',
  errand: 'var(--cat-errand)',
  social: 'var(--cat-social)',
  health: 'var(--cat-health)',
  other: 'var(--cat-other)',
};

const BUCKET = {
  now: { name: 'Now', hint: 'do these next' },
  soon: { name: 'Soon', hint: 'this week' },
  later: { name: 'Later', hint: 'when there is room' },
};

/* ------------------------------------------------------------------ helpers */

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
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

let toastTimer;
function toast(msg) {
  $('#toast')?.remove();
  if (!msg) return;
  const node = el('div', { class: 'toast', id: 'toast', role: 'status' }, msg);
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 6000);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  if (!res.ok && res.status !== 204) {
    let detail = res.statusText;
    try { detail = (await res.json()).error || detail; } catch { /* keep statusText */ }
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

/** "in 3h" / "2d ago" — relative time is easier to triage than a timestamp. */
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

/* -------------------------------------------------------------------- cards */

function chip(text, { color, cls, title } = {}) {
  return el('span', { class: `chip ${cls || ''}`, title }, [
    color ? el('span', { class: 'dot', style: `--c:${color}` }) : null,
    text,
  ]);
}

function taskCard(task, onChange) {
  const chips = [];
  if (task.category) {
    chips.push(chip(task.category, { color: CATEGORY_COLOR[task.category] || CATEGORY_COLOR.other }));
  }
  if (task.due_at) {
    chips.push(chip(relative(task.due_at), {
      cls: task.overdue ? 'danger' : '',
      title: `Due ${exactTime(task.due_at)}${task.due_text ? ` — "${task.due_text}"` : ''}`,
    }));
  } else if (task.due_text) {
    chips.push(chip(task.due_text));
  }
  if (task.effort_minutes) {
    const e = task.effort_minutes;
    chips.push(chip(e < 60 ? `${e} min` : `${e / 60} hr`, { title: 'Estimated effort' }));
  }
  if (task.requester) chips.push(chip(task.requester, { cls: 'who', title: 'Asked by' }));

  const card = el('article', { class: 'card', 'data-bucket': task.bucket });

  const act = (label, cls, fields) =>
    el('button', {
      class: cls,
      onclick: async (ev) => {
        ev.currentTarget.disabled = true;
        card.classList.add('leaving');
        try {
          await api(`/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify(fields) });
          onChange();
        } catch (err) {
          card.classList.remove('leaving');
          ev.currentTarget.disabled = false;
          toast(`Could not update task #${task.id}: ${err.message}`);
        }
      },
    }, label);

  const tomorrow8 = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
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

function renderStats(open, done) {
  const counts = { now: 0, soon: 0, later: 0 };
  for (const t of open) counts[t.bucket] = (counts[t.bucket] || 0) + 1;
  const overdue = open.filter((t) => t.overdue).length;

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

  $('#stats').replaceChildren(
    tile('Open tasks', open.length, open.length ? 'across all buckets' : 'inbox zero', null, true),
    tile('Now', counts.now, overdue ? `${overdue} overdue` : 'nothing overdue', 'var(--now)'),
    tile('Soon', counts.soon, 'due this week', 'var(--soon)'),
    tile('Done today', doneToday, `${done.length} all time`, 'var(--later)')
  );
}

function renderColumns(open, onChange) {
  for (const key of Object.keys(BUCKET)) {
    const items = open.filter((t) => t.bucket === key);
    $(`#col-${key} .hint`).textContent = items.length ? String(items.length) : '';
    const list = $(`#col-${key} .list`);
    list.replaceChildren(
      ...(items.length
        ? items.map((t) => taskCard(t, onChange))
        : [el('div', { class: 'empty' }, key === 'now' ? 'Nothing urgent. Enjoy it.' : 'Empty')])
    );
  }
}

function renderDone(done) {
  $('#done-list').replaceChildren(
    ...(done.length
      ? done.slice(0, 20).map((t) =>
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

let inFlight = false;
async function refresh() {
  if (inFlight) return;
  inFlight = true;
  try {
    const [open, done] = await Promise.all([api('/tasks?status=open'), api('/tasks?status=done')]);
    done.sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));

    renderStats(open, done);
    renderColumns(open, refresh);
    renderDone(done);

    $('#pulse').dataset.state = 'live';
    $('#synced').textContent = `updated ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    toast('');
  } catch (err) {
    $('#pulse').dataset.state = 'down';
    $('#synced').textContent = 'disconnected';
    toast(`Could not reach the server: ${err.message}`);
  } finally {
    inFlight = false;
  }
}

/* -------------------------------------------------------------------- theme */

function applyTheme(mode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = mode;
  localStorage.setItem('theme', mode);
  const label = { system: 'Auto', light: 'Light', dark: 'Dark' }[mode];
  $('#theme').textContent = label;
  $('#theme').title = `Theme: ${label} — click to cycle`;
}

$('#theme').addEventListener('click', () => {
  const order = ['system', 'light', 'dark'];
  const current = localStorage.getItem('theme') || 'system';
  applyTheme(order[(order.indexOf(current) + 1) % order.length]);
});
applyTheme(localStorage.getItem('theme') || 'system');

/* ------------------------------------------------------------------ capture */

$('#capture').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#capture-text');
  const btn = $('#capture-btn');
  const text = input.value.trim();
  if (!text) return;

  btn.disabled = true;
  btn.textContent = 'Reading…';
  try {
    const result = await api('/messages', { method: 'POST', body: JSON.stringify({ text }) });
    input.value = '';
    if (result.tasks.length === 0) toast(result.note || 'No task found in that message.');
    refresh();
  } catch (err) {
    toast(`Could not file that: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('#capture-text')) {
    e.preventDefault();
    $('#capture-text').focus();
  }
});

refresh();
setInterval(refresh, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
