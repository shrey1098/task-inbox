'use strict';

// ---------------------------------------------------------------------------
// login.js — sign in / sign up.
//
// One form serves both, toggled by `mode`. On success the server sets an
// httpOnly session cookie and we hard-navigate to "/" — a full navigation
// rather than a client-side route, so the server re-evaluates the session and
// serves the app shell.
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

let mode = 'login'; // 'login' | 'signup'

const TEXT = {
  login: {
    title: 'Welcome back',
    sub: 'Wilco. Your taskings, sorted.',
    submit: 'Sign in',
    toggle: 'Create an account',
    autocomplete: 'current-password',
  },
  signup: {
    title: 'Create account',
    sub: 'Your tasks stay private to you.',
    submit: 'Create account',
    toggle: 'I already have an account',
    autocomplete: 'new-password', // prompts password managers to generate one
  },
};

function applyMode() {
  const t = TEXT[mode];
  $('#auth-title').textContent = t.title;
  $('#auth-sub').textContent = t.sub;
  $('#auth-submit').textContent = t.submit;
  $('#auth-toggle').textContent = t.toggle;
  $('#password').autocomplete = t.autocomplete;
  showError('');
}

function showError(msg) {
  const box = $('#auth-error');
  box.textContent = msg;
  box.hidden = !msg;
}

$('#auth-toggle').addEventListener('click', () => {
  mode = mode === 'login' ? 'signup' : 'login';
  applyMode();
});

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault(); // this is an AJAX form, not a page POST
  const email = $('#email').value.trim();
  const password = $('#password').value;
  const btn = $('#auth-submit');

  // Cheap client-side checks for immediate feedback. The server repeats them —
  // anything enforced only in the browser is not enforced at all.
  if (!email || !password) return showError('Enter your email and password.');
  if (mode === 'signup' && password.length < 10) {
    return showError('Password must be at least 10 characters.');
  }

  btn.disabled = true;
  btn.textContent = mode === 'login' ? 'Signing in…' : 'Creating…';
  showError('');

  try {
    const res = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Something went wrong (${res.status}).`);
    }

    // Full navigation, not history.pushState: the session cookie is now set,
    // so let the server decide what to serve.
    location.href = '/';
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    btn.textContent = TEXT[mode].submit;
  }
});

applyMode();
$('#email').focus();
