'use strict';

// ---------------------------------------------------------------------------
// usage.js — the /usage page. Read-only: fetch /api/usage and draw it.
//
// Deliberately standalone rather than another screen inside app.js. Nothing
// here shares state with the task list, and app.js is already the largest file
// in the project; a page you visit occasionally should not be loaded on every
// cold start of the app you use constantly.
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

/** Same builder as app.js: strings become text nodes, never markup. */
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

async function api(path) {
  const res = await fetch('/api' + path, { headers: { 'content-type': 'application/json' } });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('signed out'); }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).error || detail; } catch { /* not JSON */ }
    throw new Error(detail);
  }
  return res.json();
}

/* --------------------------------------------------------------- formatting */

let display = null; // { currency, rate } when a second currency is configured

/**
 * Money, at a precision that suits the magnitude.
 *
 * Per-message costs live in the tenths of a cent, so a flat 2dp would render
 * most of this page as "$0.00" — which reads as "free" rather than "small".
 */
function usd(n) {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/** The optional second currency, shown beside the dollar figure. */
function alt(n) {
  if (!display || !Number.isFinite(n)) return null;
  const v = n * display.rate;
  const s = v < 1 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v).toLocaleString();
  return `≈ ${s} ${display.currency}`;
}

/** Thousands separators, and k/M once the digits stop being readable. */
function num(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 10000) return n.toLocaleString();
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

function when(ms) {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

/* ------------------------------------------------------------------ pieces */

function group(rows) {
  return el('div', { class: 'u-group' }, rows.map(([k, v, cls]) =>
    el('div', { class: 'u-line' }, [
      el('span', { class: 'k' }, k),
      el('span', { class: `v ${cls || ''}` }, v),
    ])
  ));
}

function head(text, note) {
  return el('div', {}, [
    el('h3', { class: 'sheet-head' }, text),
    note ? el('p', { class: 'sheet-note' }, note) : null,
  ]);
}

/**
 * The daily spend chart.
 *
 * Bars are scaled against the busiest day rather than an absolute ceiling, so
 * the shape of a quiet month is still legible instead of being a flat line at
 * the bottom of the axis. Days with no traffic are drawn as gaps, not skipped
 * — an absent day is information.
 */
function chart(byDay, from, to) {
  const spend = new Map(byDay.map((d) => [d.day, d]));
  const peak = Math.max(...byDay.map((d) => d.cost_usd), 0);

  const days = [];
  for (let t = from; t <= to; t += 86400000) {
    const key = new Date(t).toISOString().slice(0, 10);
    days.push({ key, row: spend.get(key) });
  }
  // Long ranges get too dense to read one bar per day on a phone.
  const shown = days.length > 45 ? days.slice(-45) : days;

  if (peak === 0) {
    return el('p', { class: 'sheet-note' }, 'No API calls in this period.');
  }

  return el('div', { class: 'u-chart' }, shown.map(({ key, row }) => {
    const cost = row?.cost_usd ?? 0;
    const pct = peak > 0 ? Math.max((cost / peak) * 100, cost > 0 ? 4 : 0) : 0;
    const label = `${key}: ${usd(cost)} over ${row?.calls ?? 0} call${row?.calls === 1 ? '' : 's'}`;
    return el('div', { class: 'u-bar-slot', title: label, 'aria-label': label },
      el('div', { class: `u-bar ${cost > 0 ? '' : 'quiet'}`, style: `height:${pct}%` }));
  }));
}

/* ------------------------------------------------------------------ render */

function render(d) {
  display = d.display;

  const perCall = d.overall.calls > 0 ? d.overall.cost_usd / d.overall.calls : 0;
  // A month at the observed rate. Projection, not prophecy — labelled as such.
  const perDay = d.overall.cost_usd / d.days;

  $('#range').textContent =
    `${new Date(d.from).toLocaleDateString([], { day: 'numeric', month: 'short' })} – today`;
  $('#eyebrow').textContent = `Running on ${d.current_model.label}`;

  const cur = d.current_model;
  const totalAlt = alt(d.overall.cost_usd);

  $('#content').replaceChildren(
    // ---- the headline number
    el('section', { class: 'u-hero' }, [
      el('div', { class: 'u-total' }, usd(d.overall.cost_usd)),
      totalAlt ? el('div', { class: 'u-total-alt' }, totalAlt) : null,
      el('div', { class: 'u-sub' },
        `${num(d.overall.calls)} message${d.overall.calls === 1 ? '' : 's'} extracted · last ${d.days} days`),
    ]),

    head('Cost'),
    group([
      ['Average per message', usd(perCall) + (alt(perCall) ? ` (${alt(perCall)})` : '')],
      ['Projected month', `${usd(perDay * 30)} at this rate`],
    ]),

    head('Tokens', `Totals across the last ${d.days} days.`),
    group([
      ['Input', num(d.overall.input_tokens)],
      ['Output', num(d.overall.output_tokens)],
      d.overall.cache_read_input_tokens > 0
        ? ['Read from cache', num(d.overall.cache_read_input_tokens)] : null,
    ].filter(Boolean)),

    head('Current model', 'What the next forwarded message will be charged at.'),
    group([
      ['Model', cur.label],
      ['Input', cur.unpriced ? 'unpriced' : `$${cur.input_per_mtok} / M tokens`],
      ['Output', cur.unpriced ? 'unpriced' : `$${cur.output_per_mtok} / M tokens`],
    ]),

    head('Daily spend'),
    chart(d.by_day, d.from, d.to),

    // ---- only meaningful once more than one model has been used
    d.by_model.length > 1 ? head('By model', 'History keeps the price it was charged at.') : null,
    d.by_model.length > 1
      ? group(d.by_model.map((m) => [
          m.label,
          m.unpriced ? `${num(m.calls)} calls · unpriced` : `${usd(m.cost_usd)} · ${num(m.calls)} calls`,
        ]))
      : null,

    // ---- failed calls still cost money; they explain a surprising bill
    d.failures.length > 0 ? head('Calls that did not produce a task',
      'Refusals and truncated replies are still billed.') : null,
    d.failures.length > 0
      ? group(d.failures.map((f) => [f.stop_reason, `${f.n} · ${usd(f.cost_usd)}`]))
      : null,

    head('Recent calls'),
    d.recent.length === 0
      ? el('p', { class: 'sheet-note' }, 'Nothing yet.')
      : group(d.recent.map((r) => [
          when(r.at),
          `${usd(r.cost_usd)} · ${num(r.input_tokens)} in / ${num(r.output_tokens)} out`,
          r.stop_reason && r.stop_reason !== 'end_turn' ? 'u-warn' : '',
        ])),

    el('p', { class: 'u-foot' },
      'Costs are computed from the token counts Anthropic returns on each call, '
      + 'priced at the published rate for the model at the time of the call. '
      + 'Treat them as an accurate estimate, not as your invoice.'),
  );
}

/* -------------------------------------------------------------------- load */

let days = 30;

async function load() {
  try {
    render(await api(`/usage?days=${days}`));
  } catch (err) {
    $('#content').replaceChildren(
      el('p', { class: 'sheet-note' }, `Could not load usage: ${err.message}`));
  }
}

$('#period').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-days]');
  if (!btn) return;
  for (const b of $('#period').querySelectorAll('button')) b.classList.toggle('on', b === btn);
  days = Number(btn.dataset.days);
  load();
});

// The collapsing large title, same behaviour as the main app — see app.js for
// why the two thresholds differ.
$('#main').addEventListener('scroll', (e) => {
  const nav = $('#nav');
  const y = e.target.scrollTop;
  if (y > 24) nav.classList.add('scrolled');
  else if (y < 8) nav.classList.remove('scrolled');
}, { passive: true });

load();
