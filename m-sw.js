/* The phone page's service worker: what lets /m be added to a home screen.

   It caches almost nothing on purpose. The board is live data, so /state and
   every other call go straight to the server, untouched. Only the page's own
   shell (the page, the renderer, the manifest) is kept, and network first at
   that: the copy is used only when the server cannot be reached, so an
   installed page still opens and can say the server is unreachable. */

const CACHE = "facilitator-m-1";
const SHELL = ["/m", "/card-markdown.js", "/m-manifest.json"];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).catch(() => {}));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const isPage = request.mode === "navigate";
  if (!isPage && !SHELL.includes(url.pathname)) return;   // live data: never intercepted
  event.respondWith((async () => {
    try {
      const fresh = await fetch(request);
      if (fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(isPage ? "/m" : request, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (error) {
      const kept = await caches.match(isPage ? "/m" : request);
      if (kept) return kept;
      throw error;
    }
  })());
});
