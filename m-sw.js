/* The phone page's service worker: what lets /m be added to a home screen and
   what shows a notification when the server sends a push.

   It caches almost nothing on purpose. The board is live data, so every
   reading of it and every command go straight to the server, untouched. Only
   the page's own shell (the page, the renderer, the shared sheet and logic,
   the manifest, and the squid the startup screen is painted from) is kept, and
   network first at that: the copy is used only when the server cannot be
   reached, so an installed page still opens and can say the server is
   unreachable. Every fetch the worker makes itself has a deadline: a worker
   woken by a push, or answering a page open, must never sit on a connection the
   server is not answering.

   No board data is kept anywhere here. The page's startup screen waits for a
   live reading before it shows the board, so a stored copy could not shorten a
   start; it could only make one look connected when it was not. */

const CACHE = "facilitator-m-3";
const SHELL = ["/m", "/card-markdown.js", "/card-tokens.css", "/card-logic.js", "/m-manifest.json"];
/* The squid the page paints the phone's own launch image from. It is kept for
   the same reason the shell is: an installed open that cannot reach the server
   should still be able to paint the picture the NEXT open starts with, and the
   page draws that picture from this one file. It is asked for on its own rather
   than added to the list above, because addAll is all-or-nothing and a build
   whose image had not landed yet would lose the whole shell with it. */
const SPLASH = "/m-splash-squid.png";
const KEPT = [...SHELL, SPLASH];
const SHELL_DEADLINE_MS = 8000;   // a page open waits this long for the server before the kept copy
const PUSH_DEADLINE_MS = 6000;    // a push reads the board this long, then shows what it has

function bounded(request, ms) {
  return fetch(request, { signal: AbortSignal.timeout(ms) });
}

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL).catch(() => {});
      await cache.add(SPLASH).catch(() => {});
    } catch (error) {}
  })());
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
  if (!isPage && !KEPT.includes(url.pathname)) return;   // live data: never intercepted
  event.respondWith((async () => {
    try {
      const fresh = await bounded(request, SHELL_DEADLINE_MS);
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

// Each push carries the card that caused it. Keeping that identity in the
// event means two delayed pushes cannot both turn into whichever card happens
// to be newest when the worker wakes. Old or malformed pushes still show a
// generic notification so the browser sees the event was handled.
self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let title = "facilitator";
    let box = "";
    try {
      const data = event.data?.json();
      if (data && typeof data.box === "string" && typeof data.title === "string") {
        title = data.title || title;
        box = data.box;
      }
    } catch (error) {}
    await self.registration.showNotification(title, {
      tag: "facilitator-" + (box || "board"),
      data: { box },
    });
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const box = event.notification.data && event.notification.data.box;
  const target = "/m" + (box ? "?box=" + encodeURIComponent(box) : "");
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).pathname !== "/m") continue;
      try { await client.focus(); } catch (error) {}
      try { client.postMessage({ box }); return; } catch (error) {}
    }
    await self.clients.openWindow(target);
  })());
});
