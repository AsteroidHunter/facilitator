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
const CACHE = "facilitator-m-11";
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

/* A record of each push, and of each tap on a notification, kept in the
   worker's own database because the board may be out of reach when one happens
   and the page may not be open. Only fixed words and numbers are kept, never
   the push's title or any address; a tap keeps the card's id and its own tap
   id. The records go to the client log when a request to the board has just
   worked, or when the page opens, and are removed once the board has taken
   them. The oldest are dropped past the cap. A cache would not do: the
   activate step above deletes every cache that is not CACHE. A record with no
   kind is a push; a tap's is "notifytapready" or "notifytap". */
const PUSH_LOG_DB = "facilitator-m-push-log";
const PUSH_LOG_STORE = "pushes";
const PUSH_LOG_KEEP = 50;
const PUSH_LOG_BATCH = 20;        // the most reports the board takes in one request
const PUSH_LOG_DEADLINE_MS = 4000;

/* The white screen a page open shows when the server cannot answer it: the same
   screen m.html draws when the app is opened and its first reading is not
   answered, with the same icon, words, typeface, sizes, colours and centring. The rules and the
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

// One transaction on the push record store; work gets the store and a setter
// for the value the call returns once the transaction has completed.
async function pushLogRun(mode, work) {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open(PUSH_LOG_DB, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(PUSH_LOG_STORE, { keyPath: "id", autoIncrement: true });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error("blocked"));
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PUSH_LOG_STORE, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      work(tx.objectStore(PUSH_LOG_STORE), value => { result = value; });
    });
  } finally {
    db.close();
  }
}

function pushLogAdd(record) {
  return pushLogRun("readwrite", store => {
    store.add(record);
    store.getAllKeys().onsuccess = event => {
      const keys = event.target.result;
      for (const key of keys.slice(0, Math.max(0, keys.length - PUSH_LOG_KEEP))) store.delete(key);
    };
  });
}

function pushLogRows() {
  return pushLogRun("readonly", (store, give) => {
    store.getAll().onsuccess = event => give(event.target.result);
  });
}

function pushLogDrop(ids) {
  return pushLogRun("readwrite", store => { for (const id of ids) store.delete(id); });
}

function pushLogWhole(value, most) {
  return Math.max(0, Math.min(most, Math.round(Number(value)) || 0));
}

// One tap as the board takes it: fixed words, the card's id, the tap's id and
// bounded numbers. The opened word belongs to a tap that asked for a window.
function tapReport(row) {
  const report = {
    kind: "notifytap", box: row.box, tap: row.tap,
    windows: pushLogWhole(row.windows, 1000), route: row.route, focus: row.focus,
  };
  if (row.route === "open") report.opened = row.opened;
  report.ms = pushLogWhole(row.ms, 600000);
  if (row.age != null) report.age = pushLogWhole(row.age, 7776000);
  return report;
}

function tapReadyReport(row) {
  const report = {
    kind: "notifytapready", stage: row.stage, tap: row.tap, box: row.box,
    at: row.at, worker: row.worker,
  };
  if (row.stage === "ready") {
    report.windows = pushLogWhole(row.windows, 1000);
    report.visibility = row.visibility;
    report.focused = row.focused;
  }
  return report;
}

// The oldest records go first, 20 to a request, and a request the board did not
// take leaves its records where they are. Nothing here ever throws.
let pushLogSending = null;
function pushLogFlush() {
  if (pushLogSending) return pushLogSending;
  pushLogSending = (async () => {
    try {
      const rows = await pushLogRows();
      for (let from = 0; from < rows.length; from += PUSH_LOG_BATCH) {
        const part = rows.slice(from, from + PUSH_LOG_BATCH);
        const now = Date.now();
        const reports = part.map(row => {
          if (row.kind === "notifytap") return tapReport(row);
          if (row.kind === "notifytapready") return tapReadyReport(row);
          const report = { kind: "pushreceived", outcome: row.outcome };
          if (row.outcome === "skipped") report.reason = row.reason;
          report.ms = pushLogWhole(row.ms, 600000);
          report.status = pushLogWhole(row.status, 599);
          report.ago = pushLogWhole((now - row.at) / 1000, 7776000);
          report.n = pushLogWhole(row.id, 1e12);
          report.worker = row.worker;
          return report;
        });
        const answer = await fetch("/clientlog", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ page: "phone", reports }),
          signal: AbortSignal.timeout(PUSH_LOG_DEADLINE_MS),
        });
        if (!answer.ok) return;
        await pushLogDrop(part.map(row => row.id));
      }
    } catch (error) {
    } finally {
      pushLogSending = null;
    }
  })();
  return pushLogSending;
}

// Keep one record, and when the board has just answered, send what is kept.
async function pushLogNote(record, reachable) {
  try {
    await pushLogAdd({ ...record, worker: CACHE });
    if (reachable) await pushLogFlush();
  } catch (error) {}
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
  // The page asks for the kept push records to be sent whenever it opens.
  if (event.data?.kind === "push-log-flush") event.waitUntil(pushLogFlush());
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
    // Show the words already delivered, with no network or window check first.
    // The server stops new sends after sign-out; an already queued title can
    // still arrive. Record the display result only after trying to show it.
    const began = Date.now();
    const note = () => ({ at: began, ms: Date.now() - began, status: 0 });
    let title = "facilitator";
    let box = "";
    try {
      const data = event.data?.json();
      if (typeof data?.title === "string" && data.title.trim()) title = data.title;
      if (typeof data?.box === "string") box = data.box;
    } catch (error) {}
    try {
      await self.registration.showNotification(title, {
        tag: "facilitator-" + (box || "board"),
        data: { box, shown: Date.now() },
      });
    } catch (error) {
      await pushLogNote({ ...note(), outcome: "skipped", reason: "show-failed" }, true);
      throw error;
    }
    await pushLogNote({ ...note(), outcome: "shown" }, true);
  })());
});

// Eight random hex characters made for each tap. They go to the page in the
// message and in the opened address, so one tap can be followed from this
// worker's line to the page's own.
function tapId() {
  let bytes;
  try { bytes = crypto.getRandomValues(new Uint8Array(4)); }
  catch (error) { bytes = Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)); }
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

const TAP_BOX = /^(?:[mt]?\d+(?:\.\d+)*|q)$/;

// How many windows this worker controls on the page, as the loop below sees them.
function tapWindows(windows) {
  try { return windows.filter(client => new URL(client.url).pathname === "/m").length; }
  catch (error) { return 0; }
}

// What one tap did, kept and sent like a push's record. It is written after the
// tap has been acted on and never throws. The notification's own time is the
// one the push handler gave it, or the browser's if an older worker showed it.
async function tapNote(notification, tap, box, began, seen) {
  try {
    const shownAt = Number(notification.data && notification.data.shown) || Number(notification.timestamp) || 0;
    const record = {
      kind: "notifytap", at: began, tap,
      box: typeof box === "string" && box.length <= 32 && TAP_BOX.test(box) ? box : "",
      windows: seen.windows, route: seen.route, focus: seen.focus,
      ms: seen.ms == null ? Date.now() - began : seen.ms,
    };
    if (seen.route === "open") record.opened = seen.opened;
    if (shownAt > 0) record.age = pushLogWhole((Date.now() - shownAt) / 1000, 7776000);
    await pushLogNote(record, true);
  } catch (error) {}
}

// Start the durable write before window lookup or focus. The event keeps it
// alive independently of routing: neither storage nor upload holds up a tap.
// The received stage has no window fields because lookup has not happened yet.
async function tapReadyNote(tap, box, began, windows) {
  try {
    const record = {
      kind: "notifytapready", stage: windows ? "ready" : "received", tap,
      box: typeof box === "string" && box.length <= 32 && TAP_BOX.exec(box)?.[0] === box ? box : "",
      at: began,
    };
    if (windows) {
      const client = windows.find(client => new URL(client.url).pathname === "/m");
      record.windows = tapWindows(windows);
      record.visibility = client ? (client.visibilityState === "visible" ? "visible" : "hidden") : "none";
      record.focused = client ? (client.focused ? "yes" : "no") : "none";
    }
    await pushLogNote(record, true);
  } catch (error) {}
}

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const box = event.notification.data && event.notification.data.box;
  const began = Date.now();
  const tap = tapId();
  event.waitUntil(tapReadyNote(tap, box, began));
  const target = "/m" + (box ? "?box=" + encodeURIComponent(box) + "&tap=" + tap : "");
  event.waitUntil((async () => {
    // What was done, for the line the finally block keeps. "failed" stands until
    // the windows have been listed; "rejected" until a window has been opened.
    const seen = { windows: 0, route: "failed", focus: "none", opened: "rejected", ms: null };
    try {
      // Only a page controlled by this worker is known to have the matching
      // message listener. postMessage has no delivery acknowledgement, so a
      // loading or stale uncontrolled /m window could otherwise consume the
      // target silently and prevent the URL fallback below.
      const windows = await self.clients.matchAll({ type: "window" });
      seen.windows = tapWindows(windows);
      event.waitUntil(tapReadyNote(tap, box, began, windows));
      for (const client of windows) {
        if (new URL(client.url).pathname !== "/m") continue;
        try { await client.focus(); seen.focus = "ok"; } catch (error) { seen.focus = "rejected"; }
        try { client.postMessage({ box, tap }); seen.route = "message"; seen.ms = Date.now() - began; return; } catch (error) {}
      }
      seen.route = "open";
      try {
        seen.opened = (await self.clients.openWindow(target)) ? "client" : "null";
      } finally {
        seen.ms = Date.now() - began;
      }
    } finally {
      await tapNote(event.notification, tap, box, began, seen);
    }
  })());
});
