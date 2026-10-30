/* The board's live line, as the Mac board, the /page view and the Mac's
   narrow view hear it.

   The board keeps a line open to each listening page (GET /events, Server-Sent
   Events, server.py EventsRoute) and writes one short line on it whenever the
   board changes: data: {"rev": R, "quiet": "Q"}, the revision on disk and the
   board clock's mark of what moves with no save, and the same again every 15
   seconds whether or not anything moved. A page compares that with what it
   holds and, when it differs, makes exactly the reading it made every 1.2
   seconds before there was a line. Nothing about a reading or its draw
   changes here; the line only says when.

   One line serves every board window of a browser. Chrome allows six open
   connections to one address across all its tabs and windows, and each line
   holds one for its whole life, so six windows each with a line of its own
   would leave the board no room to answer. A SharedWorker (board-line-worker.js)
   holds the one line and hands each line it hears to every window; it belongs
   to no window, so closing any one of them hands nothing over. A browser with
   no SharedWorker, or one whose worker does not load, opens a line in the page.
   The Mac's narrow view, the phone document inside the board, takes the board's
   lines from the page around it (relay) and opens none.

   Whenever the line is down (the board stopped, its lines all taken, the lock
   refusing, a connection gone dead after a sleep), the page is told (down) and
   runs its timed check exactly as it did before the line; when a line comes
   again it is told (up), stops the timer and reads once, as it does every time
   a line opens. The worst case is the page as it was. */
(function boardLine(root) {
  "use strict";
  const FLOOR_MS = 1000;        // at most one reading a ring asks for in a second; a burst after one becomes one more
  const RING_WAIT_MS = 250;     // a ring that lands in a card's motion is tried again this much later
  const RETRY_MS = 1200;        // a ring's reading that did not get through is tried again at the old timer's pace
  const DEAD_MS = 40000;        // no line for this long (the board repeats one every 15 s): the line is dead
  const CLOSED_MS = 30000;      // a line the browser gave up on (a 503 or a 401) is opened again after this
  const WORKER_DEAD_MS = 45000; // a page that hears nothing from its worker for this long joins it again
  const EVENTS_URL = "/events";
  const WORKER_URL = "/board-line-worker.js";
  // Chrome finds the worker by its address and name, and keeps the one running
  // while any board window is open, through reloads and updates. The name
  // carries a mark of this file's code, so a page with other code starts a
  // worker of the new code and never joins one left running from before
  const WORKER_NAME = "facilitator-board-line-" + codeMark(String(boardLine));
  const CLOSED = 2;             // EventSource.CLOSED: the browser will not open this one again by itself

  const now = () => root.Date.now();
  // a short mark of a text (32-bit FNV-1a), the same for the same text
  function codeMark(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
  }
  function report(e) {
    try { if (typeof root.reportProblem === "function") root.reportProblem("error", e); } catch (_) {}
  }

  // The one line itself, wherever it is held: in the worker, or in a page with
  // no worker. say(message) is told {type: "line", rev, quiet} for every line
  // the board writes, and {type: "down"} whenever the line is not open. The
  // browser opens a line that broke again by itself after the retry time the
  // board gave (3 s); one it gave up on is opened here after CLOSED_MS, and one
  // that has said nothing for DEAD_MS (half open after a sleep or a change of
  // network) is closed and opened again.
  function hub(say) {
    let source = null, last = null, dead = 0, again = 0, wanted = false;
    function down() { last = null; say({ type: "down" }); }
    function watch() { root.clearTimeout(dead); dead = root.setTimeout(lost, DEAD_MS); }
    function lost() { shut(); down(); open(); }
    function shut() {
      root.clearTimeout(dead); dead = 0;
      if (!source) return;
      source.onmessage = source.onerror = null;
      try { source.close(); } catch (_) {}
      source = null;
    }
    function open() {
      root.clearTimeout(again); again = 0;
      if (!wanted || source || typeof root.EventSource !== "function") return;
      let es = null;
      try { es = new root.EventSource(EVENTS_URL); } catch (e) { report(e); }
      if (!es) { again = root.setTimeout(open, CLOSED_MS); return; }
      source = es;
      watch();
      es.onmessage = e => {
        if (source !== es) return;
        watch();
        let line = null;
        try { line = JSON.parse(e.data); } catch (_) {}
        if (!line || !Number.isFinite(line.rev) || typeof line.quiet !== "string") return;
        last = { rev: line.rev, quiet: line.quiet };
        say({ type: "line", rev: last.rev, quiet: last.quiet });
      };
      es.onerror = () => {
        if (source !== es) return;
        down();
        if (es.readyState === CLOSED) { shut(); again = root.setTimeout(open, CLOSED_MS); }
      };
    }
    return {
      start() { wanted = true; open(); },
      stop() { wanted = false; shut(); root.clearTimeout(again); again = 0; last = null; },
      // how the line stands, as a message: what a window that joins is told first
      now() { return last ? { type: "line", rev: last.rev, quiet: last.quiet } : { type: "down" }; },
    };
  }

  // The worker's side (board-line-worker.js): one hub, and every window that
  // says hello is told each message. A window that goes (its pagehide) says
  // bye; when none is left the line is closed, and the next hello opens it. A
  // worker that has no EventSource of its own says so (none), and the window
  // holds its own line.
  function worker(scope) {
    const ports = new Set();
    const line = hub(message => { for (const port of ports) port.postMessage(message); });
    scope.addEventListener("connect", e => {
      const port = e.ports[0];
      port.onmessage = m => {
        const kind = m.data && m.data.type;
        if (kind === "hello" && typeof root.EventSource !== "function") {
          port.postMessage({ type: "none" });
        } else if (kind === "hello") {
          ports.add(port);
          port.postMessage(line.now());
          line.start();
        } else if (kind === "bye") {
          ports.delete(port);
          try { port.close(); } catch (_) {}
          if (!ports.size) line.stop();
        }
      };
    });
  }

  // A window's own way to the line: the shared worker when the browser has
  // one and it loads, else a hub in the page. hear is told every message.
  // stop and start are for the page leaving and coming back (pagehide and
  // pageshow): a page kept in the back and forward cache holds no line, and the
  // worker it left may have gone by the time it comes back, so it joins anew.
  function browserFeed(hear) {
    let port = null, own = null, quiet = 0, on = false;
    function arm() { root.clearTimeout(quiet); quiet = root.setTimeout(rejoin, WORKER_DEAD_MS); }
    // nothing from the worker for a while: a worker that died, or a page that
    // was frozen. The page runs its timer until the worker says the line is up
    function rejoin() { leave(); hear({ type: "down" }); join(); }
    function join() {
      if (!on) return;
      if (own) { ownLine(); return; }
      if (typeof root.SharedWorker === "function") {
        let shared = null;
        try { shared = new root.SharedWorker(WORKER_URL, { name: WORKER_NAME }); } catch (_) { shared = null; }
        if (shared) {
          const mine = port = shared.port;
          // the worker's file did not load, or it can hold no line: this page
          // holds a line of its own
          const alone = () => {
            if (port !== mine) return;
            root.clearTimeout(quiet); port = null;
            try { mine.close(); } catch (_) {}
            ownLine();
          };
          mine.onmessage = e => {
            if (port !== mine) return;
            arm();
            if (e.data && e.data.type === "none") alone();
            else if (e.data && typeof e.data.type === "string") hear(e.data);
          };
          shared.onerror = alone;
          mine.postMessage({ type: "hello" });
          arm();
          return;
        }
      }
      ownLine();
    }
    function ownLine() {
      if (!on) return;
      if (!own) own = hub(hear);
      own.start();
    }
    function leave() {
      root.clearTimeout(quiet); quiet = 0;
      if (port) {
        try { port.postMessage({ type: "bye" }); port.close(); } catch (_) {}
        port = null;
      }
      if (own) own.stop();
    }
    return {
      start() { if (on) return; on = true; join(); },
      stop() { on = false; leave(); },
    };
  }

  // A page's client. page says:
  //   held()     the revision of the reading the page holds, or null
  //   read()     make the reading; a promise for it, or nothing for a page that
  //              reads on its own schedule (the narrow view's schedulePoll)
  //   moving()   whether a card is in motion now (cardsMoving): a ring waits
  //   failed()   whether the last reading did not get through (pollFails)
  //   up()       the line is up: the timed check stops
  //   down()     the line is down: the timed check runs, as before the line.
  //              Said once at the start, since no line is open yet
  //   first      the page's reading at load, still out: counted as in flight
  //   feed       for the narrow view: another client's relay to listen to
  // and is answered with the client: up (whether the line is up now), check()
  // (one reading now, through the same gate, for a page shown again or
  // resumed), relay(page) (a client for a page inside this one that hears this
  // page's line) and stop().
  //
  // A line read: one that differs from what the page holds (another revision,
  // or a mark other than the last one heard) asks for a reading, and so does
  // the first line after the line opens. A line that matches asks for nothing.
  // The reading itself: one at a time, at most one start in FLOOR_MS (a burst
  // of lines is one reading now and one more after the floor, which reads what
  // is current by then), put off RING_WAIT_MS at a time while a card moves and
  // never dropped, and tried again every RETRY_MS while one does not get
  // through and the line is up.
  function connect(page) {
    const relays = new Set();
    let up = false, line = null, quiet = null, stopped = false;
    let last = now(), floor = 0, wait = 0, run = null, again = false;
    const call = fn => { try { return fn ? fn() : undefined; } catch (e) { report(e); return undefined; } };
    function hear(message) {
      if (stopped || !message) return;
      for (const relay of [...relays]) {
        try { relay(message); } catch (e) { report(e); }
      }
      if (message.type === "down") { lineDown(); return; }
      if (message.type !== "line") return;
      const first = !up;
      line = { rev: message.rev, quiet: message.quiet };
      if (first) { up = true; call(page.up); }
      const moved = first || message.quiet !== quiet || message.rev !== call(page.held);
      quiet = message.quiet;
      if (moved) due();
    }
    function lineDown() {
      line = null; quiet = null;
      if (!up) return;
      up = false; again = false;
      root.clearTimeout(floor); floor = 0;
      root.clearTimeout(wait); wait = 0;
      call(page.down);
    }
    function due() {
      if (!up || floor) return;
      const left = last + FLOOR_MS - now();
      if (left > 0) { floor = root.setTimeout(() => { floor = 0; read(); }, left); return; }
      read();
    }
    function later(ms) {
      if (!wait) wait = root.setTimeout(() => { wait = 0; read(); }, ms);
    }
    function read() {
      if (!up || stopped) return;
      if (run) { again = true; return; }
      if (page.moving && call(page.moving)) { later(RING_WAIT_MS); return; }
      root.clearTimeout(wait); wait = 0;
      last = now();
      let out = null;
      try { out = page.read(); } catch (e) { report(e); }
      if (out && typeof out.then === "function") track(out);
    }
    function track(out) {
      const mine = run = Promise.resolve(out).then(() => {}, () => {}).then(() => {
        if (run !== mine) return;
        run = null;
        if (!up || stopped) return;
        if (again) { again = false; due(); }
        else if (page.failed && call(page.failed)) later(RETRY_MS);
      });
    }
    // no line is open yet: the page's timed check runs until one is, and a
    // reading the page made at load is the one in flight
    call(page.down);
    if (page.first && typeof page.first.then === "function") track(page.first);
    let feed = null;
    const client = {
      get up() { return up; },
      check() { if (up) due(); },
      relay(child) {
        return connect({ ...child, feed: listen => {
          relays.add(listen);
          listen(line ? { type: "line", rev: line.rev, quiet: line.quiet } : { type: "down" });
          return () => relays.delete(listen);
        } });
      },
      stop() {
        if (stopped) return;
        stopped = true; up = false;
        root.clearTimeout(floor); root.clearTimeout(wait);
        relays.clear();
        if (typeof feed === "function") feed();
      },
    };
    if (typeof page.feed === "function") feed = page.feed(hear);
    else {
      const own = browserFeed(hear);
      feed = () => own.stop();
      own.start();
      if (typeof root.addEventListener === "function") {
        root.addEventListener("pagehide", () => { if (!stopped) own.stop(); });
        root.addEventListener("pageshow", e => {
          if (stopped || !e.persisted) return;
          lineDown(); own.start();
        });
        // a page frozen while hidden may have missed a line: resumed, or shown
        // again, it reads once
        root.addEventListener("resume", () => client.check());
        if (root.document && typeof root.document.addEventListener === "function")
          root.document.addEventListener("visibilitychange", () => { if (!root.document.hidden) client.check(); });
      }
    }
    return client;
  }

  root.BoardLine = { connect, worker, hub, FLOOR_MS, RING_WAIT_MS, RETRY_MS, DEAD_MS, CLOSED_MS, WORKER_DEAD_MS };
})(globalThis);
