/* Nemo Aqua Store — service worker (offline fallback + always-fresh code) */
const CACHE = 'nemo-v90.b8a332f9';
/* Precached on install — so keep this to what a visit actually uses. The logo is
   here as WebP only: the splash asks for the WebP, so the PNG beside it is
   reached only by a browser that cannot read WebP, and precaching 160 KB for a
   fallback almost nobody takes cost more on a first visit than the whole
   document does. A browser that does need it fetches it on demand, and the
   cache-first handler below keeps it from then on.

   app.jsx is excluded for exactly the same reason, and it cost far more: index.html runs the
   precompiled app.js on the fast path and only falls back to compiling the JSX source when
   app.js is missing. Precaching it downloaded ~276 KB gzipped of source, on the first visit,
   competing with the app itself, for a path almost nobody takes — and one that cannot arise
   offline anyway, since app.js is precached right here. The .jsx handler below is
   network-first with a cache fallback, so a browser that genuinely needs it still gets it. */
const ASSETS = ['./index.html', './app.js', './assets/nemo-logo.webp', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'nemo-compiled').map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never touch Firebase / Google / CDN — always straight to network
  if (/gstatic|googleapis|firebaseio|firebasedatabase|google|unpkg|jsdelivr/.test(url.host)) return;
  if (e.request.method !== 'GET') return;
  // Server-rendered surfaces, all read from the live catalogue when the request
  // arrives: /s/<id> is the share-link shim, /p/ the indexable shop pages, and
  // sitemap.xml the crawler's list. Caching them here saves nothing — nobody
  // browses the store through them — and is one more place a stale price or a
  // delisted product could survive.
  if (url.pathname.startsWith('/s/') || url.pathname.startsWith('/api/') ||
      url.pathname === '/p' || url.pathname.startsWith('/p/') || url.pathname === '/sitemap.xml') return;
  // version.json is how a running tab finds out it is stale. Cache it and it would report
  // the build it was cached with — the check would agree with itself forever and no device
  // would ever update. It is a few dozen bytes, so it always goes to the network.
  if (url.pathname.endsWith('/version.json')) return;

  const isCode = /\.(html|jsx|js)$/.test(url.pathname) || e.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/');

  if (isCode) {
    // NETWORK-FIRST WITH A SHORT TIMEOUT for app code:
    //  • fast network  → serve fresh (a new deploy shows immediately)
    //  • slow network  → serve cached instantly after ~1.5s, while the fetch keeps
    //                     running in the background to refresh the cache for next time
    //  • offline       → serve cached
    e.respondWith((async () => {
      const cached = await caches.match(e.request);
      const network = fetch(e.request)
        .then((res) => { if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {}); } return res; })
        .catch(() => null);
      if (!cached) { const n = await network; return n || fetch(e.request); }
      const timeout = new Promise((r) => setTimeout(() => r('__timeout__'), 1500));
      const winner = await Promise.race([network, timeout]);
      return (winner && winner !== '__timeout__') ? winner : cached;
    })());
  } else {
    // CACHE-FIRST for static assets (images, fonts, manifest) — fast & rarely change.
    // A cached error/opaque response would be served forever — a deploy that briefly 404'd an
    // image (or an interrupted write) is exactly how the splash logo ends up permanently
    // "broken" on a device. So only OK responses are cached, and only OK ones are served back.
    e.respondWith(
      caches.match(e.request).then((cached) => {
        if (cached && cached.ok) return cached;
        return fetch(e.request).then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return res;
        }).catch(() => cached || Response.error());
      })
    );
  }
});

/* ── Push ──────────────────────────────────────────────────────────────────────
 * Nothing sends these yet. The weekly tank-care reminder is fired by the app when it is
 * opened (see careDue() in app.jsx), because a static site on Vercel has no sender and a
 * closed phone cannot be woken without one. This half is here so that when a sender is added
 * — FCM credentials plus a scheduled function posting to the customer's token — the app
 * already receives and opens the notification correctly, with no service-worker change and
 * so no waiting for every installed client to pick up a new worker.
 *
 * The payload is expected as JSON: {title, body, url}. A push with no readable body still
 * shows something rather than failing silently, because a notification the browser has
 * already committed to showing will display "This site has been updated in the background"
 * if the handler does not show one of its own.
 */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { try { d = { body: e.data.text() }; } catch (e2) { d = {}; } }
  const title = d.title || 'Nemo Aqua Store';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: d.icon || './assets/nemo-logo.png',
    badge: './assets/nemo-logo.png',
    tag: d.tag || 'nemo',
    data: { url: d.url || './' },
  }));
});

/* Focus a tab the store is already open in rather than stacking another one. */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { await c.navigate(url); } catch (err) {} return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});




