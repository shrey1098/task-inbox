'use strict';

/* ---------------------------------------------------------------------------
   sw.js — the service worker.
   ---------------------------------------------------------------------------
   Its job is narrow on purpose: make the app installable and make it launch
   instantly, including on a bad connection. It is NOT an offline database.

   The rule that shapes everything below: this app is multi-tenant and every
   interesting response is somebody's private data. A service worker cache is
   shared across sign-ins on the same device, so caching an API response could
   show one person another person's tasks after they swap accounts. So:

       static assets  cached (they are the same for everybody)
       API responses  NEVER cached, not even briefly
       navigations    network first, cached shell only as a fallback

   There is no precache list. Assets are cached as they are successfully
   fetched, which sidesteps a real problem: app.js and index.html sit behind
   the sign-in gate, so a precache at install time — before anyone has logged
   in — would fetch redirects to the login page and store those instead.
--------------------------------------------------------------------------- */

// Bumping this name is how a deploy takes effect: the new worker creates a new
// cache and the activate handler below deletes every older one.
const CACHE = 'task-inbox-v1';

self.addEventListener('install', (event) => {
  // Do not wait for every existing tab to close before taking over. For an app
  // like this one, "the new version starts now" is the behaviour people expect.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from previous versions, or they accumulate for ever.
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    // Control pages that were already open when this worker installed.
    await self.clients.claim();
  })());
});

/** Anything private, dynamic, or not ours. None of it may be cached. */
function neverCache(url) {
  return url.pathname.startsWith('/api/')   // every response is one user's data
    || url.pathname === '/healthz'
    || url.pathname === '/sw.js';           // the worker must never cache itself
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET is cacheable, and only our own origin. A POST is an action, and
  // another origin's response is not ours to store.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (neverCache(url)) return; // fall through to the network, untouched

  // --- navigations: network first.
  // The page must reflect the current sign-in state, so a stale shell is only
  // acceptable when the network is genuinely unavailable.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        // Only cache a real page. A 302 to /login.html is a redirect, and
        // storing it would pin the app to the login screen.
        if (fresh.ok && fresh.type === 'basic') {
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch {
        // Offline. Serve whatever version of this page we last saw; the app's
        // own fetches will fail and it will show "Not connected", which is the
        // honest thing for it to display.
        const cached = await caches.match(request) || await caches.match('/');
        if (cached) return cached;
        return new Response('Offline, and this page has not been opened before.', {
          status: 503,
          headers: { 'content-type': 'text/plain' },
        });
      }
    })());
    return;
  }

  // --- static assets: stale-while-revalidate.
  // Answer from cache immediately when we have it — that is what makes a cold
  // launch feel instant — while fetching a fresh copy in the background for
  // next time.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);

    const network = fetch(request).then((response) => {
      // 200 only: a redirect to the login page must never be stored as if it
      // were styles.css.
      if (response.ok && response.type === 'basic') cache.put(request, response.clone());
      return response;
    }).catch(() => null);

    // The cached copy wins the race when there is one; otherwise wait for the
    // network, and if that fails too let the browser show its own error.
    return cached || (await network) || Response.error();
  })());
});
