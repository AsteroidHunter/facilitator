/* The phone page's service worker: what lets /m be added to a home screen and
   what shows a notification when the server sends a push.

   The page navigation must reach the server, because the server may return
   either the board or the sign-in page. It is never kept and never answered
   from a copy; only when the server cannot answer it is the white "server
   down" screen (below) put in its place. Static renderer files and the splash
   picture can be kept; readings and commands always go straight to the server.
   Every fetch the worker makes itself has a deadline, except the page open:
   a slow page is still a page, and the browser gives up on a dead one itself.

   No board data is kept anywhere here. The page's startup screen waits for a
   live reading before it shows the board, so a stored copy could not shorten a
   start; it could only make one look connected when it was not. */

/* New cache name drops previously kept authenticated pages and manifests. */
const CACHE = "facilitator-m-7";
const SHELL = ["/card-markdown.js", "/card-tokens.css", "/card-logic.js",
               "/compose-format.js"];
/* The squid the page paints the phone's own launch image from. It is kept
   so a page already open through a short interruption can still paint it.
   It is asked for on its own rather
   than added to the list above, because addAll is all-or-nothing and a build
   whose image had not landed yet would lose the whole shell with it. */
const SPLASH = "/m-splash-squid.png";
/* The vendored editor the composer's typed formatting is drawn with, kept on
   the same terms as the squid and for the same two reasons. It is one prebuilt
   file of about 1.6 MB that never changes between rebuilds, so asking the board
   for it on every open would spend that much of the phone's connection each
   time for a file that is always the same; and it is asked for on its own so a
   build where it is missing cannot take the whole shell down with it. A rebuilt
   bundle arrives with the cache name above. */
const VENDORED = "/cm-markdown.js";
const KEPT = [...SHELL, SPLASH, VENDORED];
const SHELL_DEADLINE_MS = 8000;   // static files wait this long before the kept copy
const PUSH_DEADLINE_MS = 6000;    // wait at most this long for auth before dropping a push

/* The white screen a page open shows when the server cannot answer it: the same
   screen m.html draws over the board once its readings have failed, with the
   same icon, words, typeface, sizes, colours and centring. The rules and the
   markup here are a copy of that screen's, and
   tests/phone-server-down-fresh-open.test.cjs compares the two, so change them
   together. The whole page lives in this file
   on purpose: the browser keeps the worker's own script and runs it with no
   network, so there is nothing else to have kept before the server goes away.

   An answer of 502, 503 or 504 is what a proxy in front of a stopped server
   says; anything else, a refusal included, is the server answering. The page
   asks for the manifest every few seconds, a small public file the board
   serves, and reloads itself as soon as that is answered. */
const DOWN_STATUS = [502, 503, 504];
const DOWN_POLL_MS = 3000;
const DOWN_WORDS = "Is the Facilitator server down?";
const DOWN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m6.5 8 3.5 3.5m0-3.5-3.5 3.5m7.5-3.5 3.5 3.5m0-3.5-3.5 3.5"/><path d="M8.5 17c1-1.2 2.2-1.8 3.5-1.8s2.5.6 3.5 1.8"/></svg>';
const DOWN_MARKUP = '<div id="serverdown" role="alert"><p>' + DOWN_ICON + DOWN_WORDS + '</p></div>';
/* the page's first web font sheet, the one m.html asks for, so the words are in
   the same face and a copy the phone already holds is used */
const DOWN_FONTS = "https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap";
const DOWN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#FFFFFF">
<title>facilitator</title>
<style>
  :root{--ink:#211D17; --sans:"IBM Plex Sans", -apple-system, sans-serif; --root-h:100%}
  @media (display-mode:standalone){ :root{--root-h:100vh} }
  *{box-sizing:border-box}
  html{height:var(--root-h); -webkit-text-size-adjust:100%}
  body{
    margin:0; background:#FFFFFF; color:var(--ink);
    position:fixed; left:0; top:0; width:100%; height:100%;
    overflow:hidden;
    -webkit-tap-highlight-color:transparent;
  }
  #serverdown{
    display:none; position:fixed; left:0; right:0; top:0; height:var(--screen-h, var(--root-h)); z-index:50;
    align-items:center; justify-content:center; padding:0 24px;
    background:#FFFFFF; color:var(--ink); font:400 17px/1.4 var(--sans); text-align:center;
    -webkit-user-select:none; user-select:none;
  }
  body.down #serverdown{display:flex}
  #serverdown p{margin:0}
  #serverdown svg{width:1em; height:1em; margin-right:.4em; vertical-align:-.15em}
</style>
</head>
<body class="down">
${DOWN_MARKUP}
<script>
  // an installed app on iOS is measured by the screen, as m.html does
  if (navigator.standalone) {
    document.documentElement.style.setProperty("--screen-h", screen.height + "px");
  }
  // the web font sheet, asked for without holding any paint, as m.html asks
  {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.media = "print";
    link.addEventListener("load", () => { link.media = "all"; }, { once: true });
    link.href = ${JSON.stringify(DOWN_FONTS)};
    document.head.appendChild(link);
  }
  // ask the board every few seconds, and at once when the phone wakes or
  // comes back online; the page it answers is the app, so reload into it
  const DOWN_STATUS = ${JSON.stringify(DOWN_STATUS)};
  let asking = false;
  async function ask() {
    if (asking) return;
    asking = true;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 5000);
    try {
      const answer = await fetch("/m-manifest.json", { cache: "no-store", signal: stop.signal });
      if (!DOWN_STATUS.includes(answer.status)) location.reload();
    } catch (error) {
      // still down: try again at the next turn
    } finally {
      clearTimeout(timer);
      asking = false;
    }
  }
  setInterval(ask, ${DOWN_POLL_MS});
  document.addEventListener("visibilitychange", () => { if (!document.hidden) ask(); });
  addEventListener("online", ask);
</script>
</body>
</html>
`;

function downPage() {
  return new Response(DOWN_PAGE, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// The page open, asked of the server every time. A failed request or a proxy's
// 502, 503 or 504 gets the down screen; every other answer is passed on as it came.
async function openPage(request) {
  let answer;
  try {
    answer = await fetch(request);
  } catch (error) {
    return downPage();
  }
  return DOWN_STATUS.includes(answer.status) ? downPage() : answer;
}

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
      await cache.add(VENDORED).catch(() => {});
    } catch (error) {}
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

// Answer only a controlled page's request for this worker's actual cache name.
// The page does not infer a loaded worker version from the server's current file.
self.addEventListener("message", event => {
  if (event.data?.kind === "diagnostic-worker" && event.ports?.[0])
    event.ports[0].postMessage({ kind: "diagnostic-worker", cache: CACHE });
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The navigation is an authentication decision. Never serve a kept board
  // shell in place of the server's sign-in page after a session has ended: the
  // server is asked every time, and the down screen stands in only when it
  // cannot answer.
  if (request.mode === "navigate") {
    if (url.pathname === "/m") event.respondWith(openPage(request));
    return;
  }
  /* The one thing read from the copy before the server is asked. Everything
     else here is network first, because everything else can change under an
     installed app and a stale copy of it would be wrong. This file cannot: it
     is a vendored build that arrives with a new cache name or not at all, and
     reading it from the copy is what keeps the composer's formatting from
     costing 1.6 MB of the phone's connection on every open. */
  if (url.pathname === VENDORED) {
    event.respondWith((async () => {
      const kept = await caches.match(request);
      if (kept) return kept;
      const fresh = await bounded(request, SHELL_DEADLINE_MS);
      if (fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(request, fresh.clone()).catch(() => {});
      }
      return fresh;
    })());
    return;
  }
  if (!KEPT.includes(url.pathname)) return;   // live data: never intercepted
  event.respondWith((async () => {
    try {
      const fresh = await bounded(request, SHELL_DEADLINE_MS);
      if (fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(request, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (error) {
      const kept = await caches.match(request);
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
    // A push service can hold an encrypted title for hours after sign-out.
    // The server may have accepted it while the session was still live, so
    // ask again at delivery time and show nothing if the answer is unavailable.
    try {
      const status = await bounded("/auth/check", PUSH_DEADLINE_MS);
      if (!status.ok || !(await status.json()).authenticated) return;
    } catch (_) { return; }
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
    // Only a page controlled by this worker is known to have the matching
    // message listener. postMessage has no delivery acknowledgement, so a
    // loading or stale uncontrolled /m window could otherwise consume the
    // target silently and prevent the URL fallback below.
    const windows = await self.clients.matchAll({ type: "window" });
    for (const client of windows) {
      if (new URL(client.url).pathname !== "/m") continue;
      try { await client.focus(); } catch (error) {}
      try { client.postMessage({ box }); return; } catch (error) {}
    }
    await self.clients.openWindow(target);
  })());
});
