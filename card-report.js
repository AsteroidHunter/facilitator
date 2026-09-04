// What a page does when something breaks. One copy for the board (index.html),
// the phone page (m.html) and the page view (page.html): three copies would
// drift, and the phone is where a failure is hardest to reproduce and therefore
// where this matters most. Each page starts it with its own name.
//
// It listens for thrown errors, rejected promises and fetches that failed,
// keeps one report per distinct message and line with a count of how often it
// happened, and sends the batch to POST /clientlog on page hide, through
// sendBeacon, which is the one send that survives the page going away.
//
// It never carries card text, a message, or any URL beyond the route that
// failed. Nothing here runs on load: a page that does not call startReporter
// (the page view's mock sandbox, which makes no requests at all by design) is
// left exactly as it was.
(function () {
  const BATCH = 20;    // distinct reports held at once; the server caps again
  const FIELD = 500;   // characters kept of any one string, as the route does
  const TICK = 1000;   // how often the freeze watchdog is due
  const LATE = 2000;   // a tick later than this means the thread was blocked

  let page = null;                 // "board", "phone" or "page"; null until started
  let doing = "idle";              // the one word the page last said it was doing
  let freezes = 0;                 // lateness is an event, not a kind: each is its own
  const queued = new Map();        // key -> the one report for that key, and its count

  function cut(text) {
    return String(text == null ? "" : text).slice(0, FIELD);
  }

  // the card open right now. Each page declares selectedId itself, so this is
  // read through the scope rather than off an object, and a page that has not
  // declared it yet simply reports no card
  function openBox() {
    try {
      return typeof selectedId === "string" ? selectedId : "";
    } catch (e) {
      return "";
    }
  }

  // the route a request was for, never the whole address it was sent to
  function routeOf(url) {
    try {
      return new URL(String(url), location.href).pathname;
    } catch (e) {
      return "";
    }
  }

  // where a thrown error came from, out of its own stack: without this every
  // render failure would carry no place at all and they would all dedupe into
  // one report saying nothing about where they happened
  function frameOf(error) {
    const at = String((error && error.stack) || "").split("\n")[1] || "";
    const found = /(https?:\/\/[^\s)]+):(\d+):(\d+)/.exec(at);
    return found
      ? { file: found[1], line: Number(found[2]), col: Number(found[3]) }
      : { file: "", line: 0, col: 0 };
  }

  // one report, or one more count on a report already held: two throws from the
  // same line are one thing that is wrong, not fifty
  function add(kind, detail) {
    if (!page) return;
    const message = cut(detail.message);
    const file = cut(detail.file);
    const line = Number(detail.line) || 0;
    // two throws from the same line are one thing that is wrong; two freezes in
    // a row are two freezes, so lateness gets a key of its own every time
    const key = kind === "slow" ? "slow|" + (++freezes)
                                : kind + "|" + message + "|" + file + "|" + line;
    const held = queued.get(key);
    if (held) {
      held.count++;
      return;
    }
    if (queued.size >= BATCH) return;   // the batch is full; that is what the cap is for
    const report = { kind: kind, message: message, file: file, line: line,
                     col: Number(detail.col) || 0, box: openBox(), count: 1 };
    if (detail.route) report.route = cut(detail.route);
    if (detail.late != null) report.late = Number(detail.late) || 0;
    if (detail.doing) report.doing = cut(detail.doing);
    queued.set(key, report);
  }

  function flush() {
    if (!page || !queued.size || !navigator.sendBeacon) return;
    const reports = [];
    for (const report of queued.values()) reports.push(report);
    queued.clear();
    try {
      navigator.sendBeacon("/clientlog", new Blob(
        [JSON.stringify({ page: page, reports: reports })], { type: "application/json" }));
    } catch (e) {
      // the page is going away and there is nowhere left to say so
    }
  }

  // every failed request, wherever it was made from, reported once. The caller's
  // own catch still sees exactly the error it always saw: this only watches
  function watchFetch() {
    const real = window.fetch;
    if (typeof real !== "function") return;
    window.fetch = function (input, init) {
      return real.apply(this, arguments).catch(function (error) {
        add("fetch", {
          message: (error && error.message) || "the request failed",
          route: routeOf(typeof input === "string" ? input : (input && input.url) || ""),
          file: "", line: 0,
        });
        throw error;
      });
    };
  }

  // a timer that ran late is the only portable way to catch a freeze: the long
  // task observer is the better instrument and Safari does not have it, and the
  // phone page runs in Safari, which is the surface where a freeze is least
  // reproducible. It cannot say what blocked the thread, only that something
  // did, for how long, and what the page thought it was doing at the time.
  function watchFreeze() {
    let due = Date.now() + TICK;
    setInterval(function () {
      const now = Date.now();
      const late = now - due;
      due = now + TICK;
      // a hidden page's timers are throttled by the browser on purpose: that is
      // not a freeze, and reporting it would drown the ones that are
      if (late > LATE && !document.hidden) {
        add("slow", { message: "the main thread was blocked", late: late,
                      doing: doing, file: "", line: 0 });
      }
    }, TICK);
  }

  // a page says which of the three it is, once. A second call changes nothing,
  // so a page that starts the reporter twice does not report twice
  window.startReporter = function (name) {
    if (page) return;
    page = name;
    watchFetch();
    watchFreeze();
    addEventListener("error", function (event) {
      // a picture or a script that failed to load fires this too, carrying no
      // message at all; that is not a page error and there is nothing to say
      if (!event || !event.message) return;
      add("error", { message: event.message, file: event.filename,
                     line: event.lineno, col: event.colno });
    });
    addEventListener("unhandledrejection", function (event) {
      const why = event && event.reason;
      const where = frameOf(why);
      add("rejection", {
        message: (why && why.message) || String(why == null ? "a promise was rejected" : why),
        file: where.file, line: where.line, col: where.col,
      });
    });
    // the pair MDN recommends, and not belt and braces on a phone: the phone
    // page is added to the home screen and backgrounded by a swipe, which fires
    // the second and may never fire the first
    addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) flush();
    });
  };

  // one word for what the page is in the middle of: the poll, the render and the
  // card draw each set it, and a freeze report carries the last one, which is
  // the nearest a timer can come to saying what the thread was blocked on
  window.noteDoing = function (what) {
    doing = cut(what).slice(0, 40);
  };

  // what a page reports itself: a render that threw, and anything else a page
  // catches and would otherwise swallow
  window.reportProblem = function (kind, error, extra) {
    const where = frameOf(error);
    const detail = {
      message: (error && error.message) || String(error == null ? "" : error),
      file: where.file, line: where.line, col: where.col,
    };
    for (const name in (extra || {})) detail[name] = extra[name];
    add(kind, detail);
  };
})();
