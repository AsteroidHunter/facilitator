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
  const ASLEEP = 10000; // the wall clock this far ahead of the page's own means sleep

  let page = null;                 // "board", "phone" or "page"; null until started
  let client = "other";            // the kind of window this page is open in
  let windowId = "";               // 16 random hex characters, new on every page load
  let doing = "idle";              // the one word the page last said it was doing
  let freezes = 0;                 // lateness is an event, not a kind: each is its own
  let incidents = null;            // the phone's recent history, only in memory
  const queued = new Map();        // key -> the one report for that key, and its count
  const notices = [];              // notification reports the board has not taken yet
  let noticeBusy = false;          // one notification request at a time
  let plainFetch = null;           // the page's fetch as it was before the reporter wrapped it

  function cut(text) {
    return String(text == null ? "" : text).slice(0, FIELD);
  }

  // which kind of window this is, as one short word. The user agent is read
  // here and never sent: Electron adds its own token, the Tauri app is the bare
  // system WebKit view (no Version or Safari token, which the Safari browser has),
  // and a touch screen on a Mac user agent is an iPad. Anything else is "other"
  function clientOf(agent, touchPoints) {
    const ua = String(agent || "");
    if (/\b(iPhone|iPad|iPod|Android)\b/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return "phone";
    if (/Electron\//.test(ua)) return "electron";
    if (/Chrome\//.test(ua)) return /\b(Edg|OPR)\//.test(ua) ? "other" : "chrome";
    if (/Safari\//.test(ua)) return "safari";
    if (/Macintosh/.test(ua) && /AppleWebKit\//.test(ua)) return "tauri";
    return "other";
  }

  // the batch as the route reads it: which page, which kind of window, and which
  // load of it, so lines from two windows showing the same page can be told apart
  function batchOf(reports) {
    return JSON.stringify({ page: page, client: client, window: windowId, reports: reports });
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
    if (incidents) incidents.problem(kind, message);
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
    if (incidents) incidents.hide();
    if (!page || !queued.size || !navigator.sendBeacon) return;
    const reports = [];
    for (const report of queued.values()) reports.push(report);
    queued.clear();
    try {
      navigator.sendBeacon("/clientlog", new Blob([batchOf(reports)], { type: "application/json" }));
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
  //
  // lateness is read off performance.now, which a clock change cannot move and
  // which on a Mac stops while the machine sleeps. The wall clock keeps going
  // through sleep, so a tick where it ran well ahead of performance.now spans
  // a sleep with the page still visible, when no page event fires at all
  function watchFreeze() {
    let due = 0, wall = 0;
    let away = false;   // hidden since the last tick and not shown again since
    function restart() {
      due = performance.now() + TICK;
      wall = Date.now() + TICK;
      away = false;
    }
    restart();
    // a hidden page's timers are throttled by the browser on purpose: that is
    // not a freeze, and reporting it would drown the ones that are. The count
    // starts again when the page is shown, so the time away is never counted
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) away = true;
      else restart();
    });
    addEventListener("pagehide", function () { away = true; });
    addEventListener("pageshow", restart);
    setInterval(function () {
      const now = performance.now();
      const late = now - due;
      const slept = (Date.now() - wall) - late;
      const skip = away || document.hidden || slept > ASLEEP;
      due = now + TICK;
      wall = Date.now() + TICK;
      away = false;
      if (late > LATE && !skip) {
        add("slow", { message: "the main thread was blocked", late: late,
                      doing: doing, file: "", line: 0 });
        if (incidents) incidents.freeze(late);
      }
    }, TICK);
  }

  // a page says which of the three it is, once. A second call changes nothing,
  // so a page that starts the reporter twice does not report twice
  window.startReporter = function (name, options = {}) {
    if (page) return;
    page = name;
    // the page's own fetch, taken before anything here wraps it, so a notice
    // that cannot be sent is not also reported as a failed request
    plainFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
    addEventListener("online", sendNotices);
    client = clientOf(navigator.userAgent, navigator.maxTouchPoints);
    windowId = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    if (name === "phone") {
      try {
        incidents = phoneHistory(window.fetch, options.phoneHistory !== false);
        window.phoneHistory = incidents;
      } catch (_) { incidents = null; }
    }
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

  // What the phone says about its notifications when it opens or comes back:
  // fixed words and flags only, sent at once rather than at page hide, and held
  // (up to a batch) for the next try when the board does not answer. A board
  // that refuses the shape is not asked again with it. A notice made while one
  // request is out goes in the next request as soon as the board has answered.
  function sendNotices() {
    if (!page || noticeBusy || !notices.length || !plainFetch) return;
    noticeBusy = true;
    const sent = notices.slice(0, BATCH);
    let answered = false;
    plainFetch("/clientlog", {
      method: "POST", headers: { "content-type": "application/json" },
      body: batchOf(sent), keepalive: true,
    }).then(function (answer) {
      if (answer.ok || answer.status === 400) { notices.splice(0, sent.length); answered = true; }
    }).catch(function () {}).then(function () {
      noticeBusy = false;
      if (answered) sendNotices();
    });
  }

  window.reportNotice = function (report) {
    if (!page) return;
    if (notices.length >= BATCH) notices.shift();
    notices.push(report);
    sendNotices();
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

  // A short lead-up to an incident, not an activity stream. All normal events
  // stay in RAM. Each saved history has its own bounded /clientlog batch, so
  // neither an incident nor a failed upload can crowd out existing errors.
  function phoneHistory(realFetch, enabled) {
    const ENTRIES = 40, AGE = 60000, BYTES = 12 * 1024;
    const COALESCE = 250, UI_SLOW = 150, REQUEST_SLOW = 2000;
    const COOLDOWN = 30000, SAVES_PER_MINUTE = 4, SAVE_TIMEOUT = 4000;
    const POST_MS = 20000, SPARSE_AGE = 120000, FRAME_WATCH = 5000;
    const TIMING_ENTRIES = 240, TIMING_BYTES = 6144;
    const timingRows = [], scrollWindows = [];
    const timingJobs = new Set(["board", "json", "list", "reply", "glass"]);
    let timingLost = 0, timingSerial = 0, activeScroll = null, longObserver = null;
    let longTasksSupported = false;
    const STUCK_COOLDOWN = 120000;   // one no-scroll save per card in this long
    const events = new Set(["create", "select", "focus", "send", "operation", "request",
      "render", "stage", "observer", "drawer", "viewport", "lifecycle", "problem", "freeze", "mark",
      "input", "scroll", "frame", "timer", "phase", "poll", "enter"]);
    const v3Events = new Set(["input", "scroll", "frame", "timer", "phase", "poll"]);
    const reasons = new Set(["manual", "slow-ui", "slow-request", "invariant", "problem", "freeze", "no-scroll"]);
    const numbers = { ms: 600000, seq: 1000000000, status: 599, serverMs: 600000,
      rev: 1000000000000, boxes: 10000, vh: 10000, vt: 10000, late: 600000,
      count: 1000000, bytes: 16000000, base: 10000, inner: 10000,
      scale: 1000, keyCode: 255,
      top: 1000000, range: 1000000, view: 10000, lag: 600000, wait: 600000, moved: 1000000 };
    const flags = new Set(["present", "shown", "title", "titled", "emptyTitle", "editing", "known", "kb", "lifting",
      "editor", "editorReady", "inputReady", "selectedDom", "paneBlank", "loading", "connected", "formatted", "active",
      "changed", "persisted", "shift", "repeat", "composing", "prevented", "draft", "minted",
      "hist", "far", "same"]);
    const choices = { phase: ["start", "end"], route: ["/send", "/create", "/m/state"],
      side: ["left", "right"], source: ["settings", "shortcut"],
      action: ["drawer", "card", "response-scroll", "project", "state"],
      part: ["touch", "intent", "touch-end", "handler", "menu-commit", "frame-one", "frame-two",
        "transition", "select", "tickets", "tabs", "blur", "scroll-view", "fetch-headers",
        "json", "apply", "reconcile", "observer", "touch-cancel", "taken", "reply-swap"],
      edge: ["top", "bottom", "middle", "none"], dir: ["up", "down"],
      by: ["drawer", "cardswipe", "focus", "scrim", "curtain", "panel"],
      outcome: ["minted", "applied", "retry", "unsure", "failed"],
      lifecycle: ["start", "hidden", "visible", "pageshow", "pagehide", "online", "offline"],
      problem: ["error", "rejection", "render", "fetch"],
      stage: ["create-response", "card-insertion", "editor-init", "selected-ready", "title-input"],
      observer: ["loop-limit", "undelivered"], reason: [...reasons],
      step: ["capture", "format", "editor", "handler", "beforeinput", "input"],
      branch: ["seen", "other-key", "composition", "modifier", "send", "shift", "keyboard",
        "repeat", "empty", "held", "row-line", "empty-item", "editor", "no-caret",
        "line-intent", "line-applied"],
      key: ["Enter", "Unidentified", "Other"],
      code: ["Enter", "NumpadEnter", "Unidentified", "Other"],
      target: ["textarea", "editor", "other"], focus: ["textarea", "editor", "other", "none"],
      inputType: ["insertLineBreak", "insertParagraph"] };
    // What schema 5 added to response gestures. An older receiver refuses all of
    // it, so a report for one leaves these out (withoutV5).
    const v5Fields = new Set(["top", "range", "view", "edge", "hist", "focus", "lag", "dir",
      "far", "wait", "moved", "same", "prevented", "by"]);
    const v5Parts = new Set(["taken", "reply-swap"]);
    // the board read's wait for headers and its download, timed on the phone's link
    const networkParts = new Set(["fetch-headers", "json"]);
    const routineProblems = new Set(["ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications."]);
    const legacyEvents = new Set(["create", "select", "focus", "send", "operation", "request",
      "render", "drawer", "viewport", "lifecycle", "problem", "freeze", "mark"]);
    const v2Events = new Set([...legacyEvents, "stage", "observer"]);
    const oldLifecycles = new Set(["start", "hidden", "visible", "pageshow", "online", "offline"]);
    const legacyFields = new Set(["event", "time", "visible", "online", "resume", "box", "selected", "op",
      "phase", "route", "side", "source", "outcome", "lifecycle", "problem", "reason",
      "ms", "seq", "status", "serverMs", "rev", "boxes", "vh", "vt", "late",
      "present", "shown", "title", "titled", "emptyTitle", "editing", "known", "kb", "lifting"]);
    const v2Fields = new Set([...legacyFields, "stage", "observer", "editor", "editorReady",
      "inputReady", "selectedDom", "paneBlank", "loading", "connected", "formatted", "active"]);
    const boxPattern = /^(?:[mt]?\d+(?:\.\d+)*|q)$/;
    const opPattern = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;
    let ring = [], lost = 0, sparseLost = 0, suppressed = 0, seq = 0, generation = 0;
    const important = [], work = [], life = [], pollBuckets = [], observerBuckets = [];
    const collecting = new Set();   // saves still recording their 20 seconds of recovery
    let worker = "unknown", activeRequest = null;
    const session = windowId;
    let lastResume = -Infinity, lastAuto = -Infinity, attempts = [];
    const stuck = new Map();   // card -> when its last no-scroll save was made
    let viewport = null, viewportTimer = null, viewportAt = -Infinity, viewportKey = "";
    let held = null, beaconed = null, busy = false, sending = null, inflight = Promise.resolve();
    let build = "phone-diag-unidentified", schema = 1;
    let lastFrame = null, frameEpoch = generation, watching = false, watchUntil = -Infinity, watchedRev = null;
    let modeEpoch = 0, uploadJob = null;
    let watchFrames = () => {};   // set once the frame callback exists, below
    const cap = (n, max) => Math.min(max, Math.max(0, Math.round(n)));
    // Even a broken getter, unavailable clock, or disabled reporter must never
    // escape into a send, focus, navigation or keyboard reconciliation.
    const safe = (fn, fallback) => (...args) => {
      try { return fn(...args); } catch (_) { return fallback; }
    };
    // This switch belongs only to the phone recorder. Ordinary page/error and
    // notification reporting above never consults it. Old callers stay enabled.
    function setEnabled(value) {
      const next = value === true;
      if (enabled === next) return;
      enabled = next;
      modeEpoch++;
      generation++;
      ring.length = 0;
      timingRows.length = scrollWindows.length = 0;
      timingLost = 0; activeScroll = null;
      configureLongTasks();
      for (const lane of [important, work, life, pollBuckets, observerBuckets]) lane.length = 0;
      lost = sparseLost = suppressed = 0;
      activeRequest = viewport = held = beaconed = null;
      clearTimeout(viewportTimer); viewportTimer = null;
      viewportAt = -Infinity; viewportKey = "";
      stuck.clear(); lastAuto = -Infinity;
      lastResume = performance.now(); due = lastResume + 100;
      watching = false; lastFrame = null; watchUntil = -Infinity; watchedRev = null;
      for (const current of collecting) {
        clearTimeout(current.timer);
        current.resolve({ status: "disabled" });
      }
      collecting.clear();
      if (uploadJob) {
        clearTimeout(uploadJob.task); clearTimeout(uploadJob.timeout);
        uploadJob.controller?.abort();
        uploadJob.resolve({ status: "disabled" });
        uploadJob = null;
      }
      busy = false; sending = null; inflight = Promise.resolve();
      // Keep the attempt budget across toggles; switching cannot bypass it.
      if (enabled) note("lifecycle", { lifecycle: "start" });
    }
    // Compact rows have only fixed words and numbers. The first value is the
    // clock time; capture changes all clock columns to ms from the save marker.
    // No DOM or content enters this lane. It cannot crowd out sparse gestures.
    // start/end: [clock, kind, surface]; step: [set, kind, surface, computed,
    // position, offered, callback]; frame: [callback, kind, surface, offered];
    // job-start/job-end: [clock, kind, surface, job]; longtask: [start, kind,
    // surface, duration]. Clock values keep tenths of a millisecond on save.
    const tenth = n => Math.round(n * 10) / 10;
    function timingRow(row) {
      Object.defineProperty(row, "serial", { value: ++timingSerial });
      timingRows.push(row);
      if (timingRows.length > TIMING_ENTRIES) {
        timingRows.shift(); timingLost = cap(timingLost + 1, 1000000000);
      }
    }
    function keyboardScroll(phase, surface, top, frame, computed, callback) {
      if (!enabled || document.hidden || !["reply", "list"].includes(surface)) return;
      const now = performance.now();
      if (phase === "start") {
        activeScroll = { surface, start: now, end: Infinity, step: now, frame: now, offered: now };
        scrollWindows.push(activeScroll);
        if (scrollWindows.length > 8) scrollWindows.shift();
        timingRow([now, "start", surface]);
        watchFrames();
      } else if (activeScroll && phase === "end") {
        timingRow([now, "end", activeScroll.surface]);
        activeScroll.end = now; activeScroll = null;
      } else if (activeScroll && phase === "step" && [top, frame, computed, callback].every(Number.isFinite)) {
        timingRow([now, "step", surface, computed, Math.min(1000000, Math.max(0, Math.round(top * 100) / 100)), frame, callback]);
        const gap = now - activeScroll.step;
        activeScroll.step = now;
        if (gap >= 100) automatic("slow-ui");
      }
    }
    function jobStart(name) {
      if (!enabled || !activeScroll || !timingJobs.has(name)) return null;
      const token = { name, surface: activeScroll.surface, epoch: modeEpoch, generation };
      timingRow([performance.now(), "job-start", token.surface, name]);
      return token;
    }
    function jobEnd(token) {
      if (!enabled || !token || token.epoch !== modeEpoch || token.generation !== generation) return;
      timingRow([performance.now(), "job-end", token.surface, token.name]);
    }
    function configureLongTasks() {
      try {
        longObserver?.disconnect(); longObserver = null;
        longTasksSupported = typeof PerformanceObserver === "function" &&
          !!PerformanceObserver.supportedEntryTypes?.includes("longtask");
        if (!enabled || !longTasksSupported) return;
        const epoch = modeEpoch;
        longObserver = new PerformanceObserver(safe(list => {
          if (!enabled || epoch !== modeEpoch) return;
          for (const entry of list.getEntries().slice(-TIMING_ENTRIES)) {
            const start = entry.startTime, duration = entry.duration;
            if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration < 0) continue;
            const span = scrollWindows.find(w => start < w.end && start + duration > w.start);
            if (span) timingRow([start, "longtask", span.surface, tenth(Math.min(600000, duration))]);
          }
        }));
        // No attribution, script names or URLs are read, and no buffered old tasks.
        longObserver.observe({ type: "longtask", buffered: false });
      } catch (_) {
        try { longObserver?.disconnect(); } catch (_) {}
        longObserver = null; longTasksSupported = false;
      }
    }
    function timingSnapshot(markAt, after = 0) {
      const relative = n => tenth(Math.max(-SPARSE_AGE, Math.min(POST_MS, n - markAt)));
      return timingRows.filter(row => row[0] >= markAt - SPARSE_AGE && row.serial > after && row[0] <= markAt + POST_MS)
        .map(row => {
          const out = row.slice(); out[0] = relative(row[0]);
          if (row[1] === "step") for (const i of [3, 5, 6]) out[i] = relative(row[i]);
          if (row[1] === "frame") out[3] = relative(row[3]);
          return out;
        }).sort((a, b) => a[0] - b[0]);
    }
    function fitTiming(timing) {
      while (timing.rows.length > TIMING_ENTRIES || JSON.stringify(timing).length > TIMING_BYTES) {
        // Keep the captured gap through a busy recovery, plus its latest sample.
        const post = timing.rows.findIndex((row, i) => row[0] > 0 && i < timing.rows.length - 1);
        timing.rows.splice(post < 0 ? 0 : post, 1);
        timing.lost = cap(timing.lost + 1, 1000000000);
      }
    }
    function clean(detail) {
      const out = {};
      for (const [key, value] of Object.entries(detail || {})) {
        if ((key === "box" || key === "selected") && typeof value === "string" && value.length <= 32 && boxPattern.test(value)) out[key] = value;
        else if (key === "op" && typeof value === "string" && opPattern.test(value)) out.op = value;
        else if (flags.has(key) && typeof value === "boolean") out[key] = value;
        else if (Object.hasOwn(numbers, key) && typeof value === "number" && Number.isFinite(value)) out[key] = cap(value, numbers[key]);
        else if (Object.hasOwn(choices, key) && choices[key].includes(value)) out[key] = value;
      }
      return out;
    }
    function evict(now) {
      while (ring.length && (ring.length >= ENTRIES || now - ring[0].time > AGE)) {
        ring.shift(); lost = cap(lost + 1, 1000000000);
      }
    }
    function sparseKeep(entry, force = false) {
      if (schema < 3 && entry.event !== "enter") return;
      const event = entry.event;
      if (!force && event === "request" && (entry.phase !== "end" || (entry.ms || 0) < 1000 && (entry.status || 0) < 400)) return;
      if (!force && event === "render" && (entry.phase !== "end" || (entry.ms || 0) < 50)) return;
      if (!force && event === "phase" && entry.action === "state" &&
          (entry.phase !== "end" || (entry.ms || 0) < 50)) return;
      if (event === "viewport") return; // coarse viewport state rides the next action or frame anomaly
      const target = event === "lifecycle" ? life
        : event === "input" || event === "enter" || event === "scroll" || event === "frame" || event === "timer" || event === "freeze" || event === "mark" ||
          entry.part === "reply-swap" ? important : work;
      target.push(entry);
      const limit = target === important ? 60 : target === work ? 40 : 8;
      let from = collecting.size ? Infinity : entry.time;
      for (const current of collecting) from = Math.min(from, current.markAt);
      const cutoff = from - SPARSE_AGE;
      while (target.length && (target.length > limit || target[0].time < cutoff)) {
        target.shift(); sparseLost = cap(sparseLost + 1, 1000000000);
      }
    }
    function append(event, detail, time = performance.now()) {
      evict(time);
      const entry = { ...detail, event, time, visible: !document.hidden,
        online: navigator.onLine !== false, resume: generation };
      ring.push(entry);
      sparseKeep(entry);
    }
    function drainViewport() {
      if (viewportTimer !== null) clearTimeout(viewportTimer);
      viewportTimer = null;
      if (!viewport) return;
      const sample = viewport; viewport = null;
      viewportAt = sample.time;
      append("viewport", sample.detail, sample.time);
    }
    function note(event, detail) {
      if (!enabled) return;
      if (!events.has(event) || (schema < 3 && v3Events.has(event))) return;
      const fields = clean(detail), now = performance.now();
      if (event === "viewport") {
        const key = [fields.kb, fields.lifting, fields.vh, fields.vt].join("|");
        if (key === viewportKey) return;
        viewportKey = key;
        viewport = { detail: fields, time: now };
        if (now - viewportAt >= COALESCE) drainViewport();
        else if (viewportTimer === null) {
          const wait = Math.max(0, COALESCE - (now - viewportAt));
          viewportTimer = setTimeout(safe(drainViewport), wait);
        }
        return;
      }
      drainViewport();
      append(event, fields, now);
      if (event === "render" && typeof fields.rev === "number" && fields.rev !== watchedRev) {
        watchedRev = fields.rev;
        watchFrames();
      }
      if (event === "operation" && fields.outcome === "failed") automatic("problem");
    }
    function begin(event, detail) {
      if (!enabled) return null;
      if (schema < 3 && v3Events.has(event)) return null;
      const token = { event, time: performance.now(), seq: seq = (seq + 1) % 1000000000,
        generation, modeEpoch, visible: !document.hidden, detail: clean(detail) };
      if (schema >= 3 && event === "request" && token.detail.route === "/m/state") activeRequest = token;
      note(event, { ...detail, phase: "start", seq: token.seq });
      return token;
    }
    function pollSummary(time, ms, serverMs) {
      if (schema < 3) return;
      const start = Math.floor(time / 10000) * 10000;
      let bucket = pollBuckets.at(-1);
      if (!bucket || bucket.time !== start) {
        bucket = { event: "poll", time: start, visible: !document.hidden,
          online: navigator.onLine !== false, resume: generation, count: 0, ms: 0, serverMs: 0 };
        pollBuckets.push(bucket);
      }
      bucket.count++;
      bucket.ms = Math.max(bucket.ms, Math.round(ms));
      bucket.serverMs = Math.max(bucket.serverMs, Math.round(serverMs || 0));
      while (pollBuckets.length > 12) pollBuckets.shift();
    }
    function observerSample(ms) {
      if (!enabled) return;
      if (schema < 3) return;
      const time = performance.now(), start = Math.floor(time / 20000) * 20000;
      let bucket = observerBuckets.at(-1);
      if (!bucket || bucket.time !== start) {
        bucket = { event: "phase", part: "observer", time: start,
          visible: !document.hidden, online: navigator.onLine !== false,
          resume: generation, count: 0, ms: 0 };
        observerBuckets.push(bucket);
      }
      bucket.count++;
      bucket.ms = Math.max(bucket.ms, cap(ms, 600000));
      while (observerBuckets.length > 6) observerBuckets.shift();
    }
    function end(token, detail, response) {
      if (!enabled || !token || token.modeEpoch !== modeEpoch) return;
      if (activeRequest === token) activeRequest = null;
      const ms = performance.now() - token.time;
      let serverMs;
      try {
        const value = response?.headers?.get("X-Facilitator-Duration-Ms");
        if (value && /^\d{1,6}$/.test(value)) serverMs = Number(value);
      } catch (_) {}
      if (schema >= 3 && token.event === "request" && detail?.route === "/m/state" &&
          detail?.status < 400 && ms < 1000) pollSummary(performance.now(), ms, serverMs);
      if (schema >= 3 && ((token.event === "request" && ms >= 1000) ||
          (token.event === "render" && ms >= 50) ||
          (token.event === "phase" && detail?.action === "state" && ms >= 50))) {
        sparseKeep({ ...clean({ ...detail, phase: "start", seq: token.seq }),
          event: token.event, time: token.time, visible: token.visible,
          online: navigator.onLine !== false, resume: token.generation }, true);
      }
      note(token.event, { ...detail, phase: "end", seq: token.seq, ms, serverMs });
      const stable = token.visible && !document.hidden && token.generation === generation;
      // waiting on the network is not a slow screen: these steps stay in the
      // history, and a whole read that is slow still saves as slow-request
      const waited = token.event === "phase" && networkParts.has(token.detail.part);
      if (stable && !waited && ms >= (token.event === "request" ? REQUEST_SLOW : UI_SLOW)) {
        automatic(token.event === "request" ? "slow-request" : "slow-ui");
      }
      if (stable && token.event === "request" && (detail?.status >= 400 || detail?.outcome === "retry")) automatic("problem");
      if (stable && detail?.known && (!detail.present || !detail.shown || !detail.title ||
          (detail.titled && !detail.editing && detail.emptyTitle))) automatic("invariant");
    }
    function capture(reason, detail) {
      note("mark", { ...detail, reason });
      const now = ring.at(-1).time;
      if (schema >= 3) return captureSparse(reason, now, Date.now());
      let recent = ring.filter(e => now - e.time <= AGE);
      const enterOmitted = recent.some(e => e.event === "enter");
      const permittedEvents = schema === 2 ? v2Events : legacyEvents;
      const permittedFields = schema === 2 ? v2Fields : legacyFields;
      recent = recent.filter(e => permittedEvents.has(e.event) &&
        (e.event !== "lifecycle" || oldLifecycles.has(e.lifecycle))).map(e =>
        Object.fromEntries(Object.entries(e).filter(([key]) => permittedFields.has(key))));
      const report = { kind: "incident", v: schema, reason, marked: Date.now(),
        box: [...recent].reverse().find(e => e.box)?.box || "",
        lost, suppressed, events: recent.map(({ time, ...e }) => ({ ...e, at: -cap(now - time, AGE) })) };
      if (schema >= 2) report.build = build;
      Object.defineProperty(report, "_enterOmitted", { value: enterOmitted });
      Object.defineProperty(report, "_timingOmitted", { value: timingRows.length > 0 });
      return report;
    }
    function captureSparse(reason, markAt, marked, fallbackMark = null) {
      const earliest = markAt - SPARSE_AGE;
      let recent = [...important, ...work, ...life, ...pollBuckets, ...observerBuckets]
        .filter(e => e.time >= earliest && e.time <= markAt + POST_MS &&
          (e.event !== "mark" || e.time === markAt && e.reason === reason))
        .sort((a, b) => a.time - b.time);
      if (activeRequest && activeRequest.time >= earliest && activeRequest.time <= markAt)
        recent.push({ ...activeRequest.detail, event: "request", phase: "start", seq: activeRequest.seq,
          time: activeRequest.time, visible: activeRequest.visible,
          online: navigator.onLine !== false, resume: activeRequest.generation });
      // A marker is reserved even when a busy page has filled every other lane.
      const mark = recent.find(e => e.event === "mark" && e.time === markAt);
      if (!mark) {
        const { at: _at, ...saved } = fallbackMark || {};
        recent.push({ event: "mark", reason, time: markAt, visible: !document.hidden,
          online: navigator.onLine !== false, resume: generation, ...saved });
      }
      recent.sort((a, b) => a.time - b.time);
      const enterOmitted = schema < 4 && recent.some(e => e.event === "enter");
      if (schema < 4) recent = recent.filter(e => e.event !== "enter");
      let scrollOmitted = false;
      if (schema < 5) ({ kept: recent, omitted: scrollOmitted } = withoutV5(recent));
      const report = { kind: "incident", v: schema, reason, marked,
        box: [...recent].reverse().find(e => e.box)?.box || "", lost: sparseLost, suppressed,
        build, worker, session, events: recent.map(({ time, ...e }) =>
          ({ ...e, at: Math.max(-SPARSE_AGE, Math.min(POST_MS, Math.round(time - markAt))) })) };
      if (schema >= 6) {
        report.timing = { lost: timingLost, longtasks: longTasksSupported, rows: timingSnapshot(markAt) };
        fitTiming(report.timing);
      }
      Object.defineProperty(report, "_timingSerial", { value: timingSerial });
      Object.defineProperty(report, "_markAt", { value: markAt });
      Object.defineProperty(report, "_enterOmitted", { value: enterOmitted });
      Object.defineProperty(report, "_scrollOmitted", { value: scrollOmitted });
      Object.defineProperty(report, "_timingOmitted", { value: schema < 6 && timingRows.length > 0 });
      // Reserve room for recovery before a busy page can fill the post window.
      fitReport(report, BYTES - 2048, 112);
      return report;
    }
    function finishCollection(initial) {
      const markAt = initial._markAt;
      const post = [...important, ...work, ...life, ...pollBuckets, ...observerBuckets]
        .filter(e => e.time > markAt && e.time <= markAt + POST_MS && e.event !== "mark");
      if (activeRequest && activeRequest.time > markAt && activeRequest.time <= markAt + POST_MS)
        post.push({ ...activeRequest.detail, event: "request", phase: "start", seq: activeRequest.seq,
          time: activeRequest.time, visible: activeRequest.visible,
          online: navigator.onLine !== false, resume: activeRequest.generation });
      const enterOmitted = initial._enterOmitted || initial.v < 4 && post.some(e => e.event === "enter");
      let savedPost = initial.v < 4 ? post.filter(e => e.event !== "enter") : post;
      let scrollOmitted = !!initial._scrollOmitted;
      if (initial.v < 5) {
        const older = withoutV5(savedPost);
        savedPost = older.kept; scrollOmitted ||= older.omitted;
      }
      const events = [...initial.events, ...savedPost.map(({ time, ...e }) =>
        ({ ...e, at: Math.max(0, Math.min(POST_MS, Math.round(time - markAt))) }))]
        .sort((a, b) => a.at - b.at);
      const report = { ...initial, worker, lost: Math.max(initial.lost, sparseLost), events };
      if (initial.timing) {
        report.timing = { ...initial.timing, lost: Math.max(initial.timing.lost, timingLost),
          rows: [...initial.timing.rows, ...timingSnapshot(markAt, initial._timingSerial)].sort((a, b) => a[0] - b[0]) };
        fitTiming(report.timing);
      }
      Object.defineProperty(report, "_timingOmitted", { value: !!initial._timingOmitted });
      Object.defineProperty(report, "_markAt", { value: markAt });
      Object.defineProperty(report, "_enterOmitted", { value: enterOmitted });
      Object.defineProperty(report, "_scrollOmitted", { value: scrollOmitted });
      fitReport(report, BYTES, 128);
      return report;
    }
    function fitReport(report, maxBytes, maxEvents) {
      let body;
      for (;;) {
        body = batchOf([report]);
        if ((body.length <= maxBytes && report.events.length <= maxEvents) ||
            report.events.length <= 1) return body;
        const lastPost = [...report.events].reverse().find(e => e.at > 0 && e.event !== "mark");
        const essential = e => ["enter", "input", "scroll", "frame", "timer", "freeze"].includes(e.event) ||
          e.part === "reply-swap";
        let index = -1, rank = Infinity;
        for (let i = 0; i < report.events.length; i++) {
          const e = report.events[i];
          if (e.event === "mark" || e === lastPost) continue;
          const score = e.event === "poll" ? 0
            : e.event === "phase" && e.part === "observer" ? 1
            : e.at > 0 && !essential(e) ? 2
            : e.at <= 0 && !essential(e) ? 3
            : e.at > 0 ? 4 : 5;
          if (score < rank) { rank = score; index = i; }
        }
        if (index < 0) return body;
        report.events.splice(index, 1); report.lost = cap(report.lost + 1, 1000000000);
      }
    }
    function bodyOf(report) {
      // The fixed enum/ID alphabet is ASCII. This is also the final bound on a
      // retained retry, after any worker identity added during recovery.
      return fitReport(report, BYTES, report.v >= 3 ? 128 : 40);
    }
    function compatibleV5(report) {
      const { timing, ...older } = report;
      older.v = 5;
      Object.defineProperty(older, "_timingOmitted", { value: !!timing?.rows.length || !!report._timingOmitted });
      Object.defineProperty(older, "_enterOmitted", { value: !!report._enterOmitted });
      Object.defineProperty(older, "_scrollOmitted", { value: !!report._scrollOmitted });
      return older;
    }
    function compatibleV3(report) {
      // A receiver can be rolled back after its last /m/state. Its strict v3
      // validator rejects the new event, so keep the ordinary incident and
      // tell the owner that the Enter evidence needs the updated receiver.
      const omitted = report.events.some(e => e.event === "enter");
      const newer = new Set(["base", "inner", "scale", "keyCode", "shift", "repeat",
        "composing", "prevented", "draft", "minted", "step", "branch", "key",
        "code", "target", "focus", "inputType"]);
      const compatible = { ...report, v: 3,
        events: report.events.filter(e => e.event !== "enter").map(e =>
          Object.fromEntries(Object.entries(e).filter(([key]) => !newer.has(key)))) };
      Object.defineProperty(compatible, "_enterOmitted", { value: omitted || !!report._enterOmitted });
      Object.defineProperty(compatible, "_scrollOmitted", { value: !!report._scrollOmitted });
      Object.defineProperty(compatible, "_timingOmitted", { value: !!report._timingOmitted });
      return compatible;
    }
    // Events as a schema 3 or 4 receiver reads them: the gesture parts it has
    // no name for are left out, a cancelled touch is the touch-end it always
    // was, and an Enter record keeps its own fields.
    function withoutV5(list) {
      let omitted = false;
      const kept = [];
      for (const e of list) {
        if (e.event === "enter") { kept.push(e); continue; }
        if (v5Parts.has(e.part)) { omitted = true; continue; }
        const out = {};
        for (const [key, value] of Object.entries(e)) {
          if (v5Fields.has(key)) omitted = true;
          else out[key] = value;
        }
        if (out.part === "touch-cancel") { out.part = "touch-end"; omitted = true; }
        kept.push(out);
      }
      return { kept, omitted };
    }
    function compatibleV4(report) {
      // The same rollback one schema later. A no-scroll save has no reason a
      // schema-4 receiver accepts, so it stays held for a retry instead.
      if (report.reason === "no-scroll") return null;
      const { kept, omitted } = withoutV5(report.events);
      const compatible = { ...report, v: 4, events: kept };
      Object.defineProperty(compatible, "_enterOmitted", { value: !!report._enterOmitted });
      Object.defineProperty(compatible, "_scrollOmitted", { value: omitted || !!report._scrollOmitted });
      Object.defineProperty(compatible, "_timingOmitted", { value: !!report._timingOmitted });
      return compatible;
    }
    function permit() {
      const now = performance.now();
      attempts = attempts.filter(t => now - t < AGE);
      if (attempts.length >= SAVES_PER_MINUTE) return false;
      attempts.push(now);
      return true;
    }
    // One report goes out at a time. A report asked for while another is going
    // out follows it as soon as it finishes, so a save is never refused for that.
    function upload(report, epoch = modeEpoch) {
      if (!enabled || epoch !== modeEpoch) return Promise.resolve({ status: "disabled" });
      if (busy) return report === sending ? inflight : inflight.then(() => upload(report, epoch));
      if (!report) return Promise.resolve({ status: "failed" });
      if (navigator.onLine === false) return Promise.resolve({ status: "offline" });
      if (!permit()) return Promise.resolve({ status: "limited" });
      busy = true; sending = report;
      const job = { task: null, timeout: null, controller: null, resolve: null };
      uploadJob = job;
      const current = () => enabled && epoch === modeEpoch && uploadJob === job;
      // JSON and transport start on a later task, after the triggering work.
      inflight = new Promise(resolve => {
        job.resolve = resolve;
        job.task = setTimeout(async () => {
          try {
            if (!current()) { resolve({ status: "disabled" }); return; }
            job.controller = new AbortController();
            job.timeout = setTimeout(() => job.controller.abort(), SAVE_TIMEOUT);
            let submitted = report;
            let response = await realFetch.call(window, "/clientlog", { method: "POST",
              headers: { "content-type": "application/json" }, body: bodyOf(report),
              signal: job.controller.signal, keepalive: true });
            // A refusal steps down one schema at a time, within the same budget.
            while (current() && response.status === 400 && submitted.v >= 4) {
              const older = submitted.v === 6 ? compatibleV5(submitted)
                : submitted.v === 5 ? compatibleV4(submitted) : compatibleV3(submitted);
              if (!older) break;
              // Compatibility writes share the same four-per-minute budget.
              if (!permit()) { resolve({ status: "limited" }); return; }
              submitted = older;
              response = await realFetch.call(window, "/clientlog", { method: "POST",
                headers: { "content-type": "application/json" }, body: bodyOf(submitted),
                signal: job.controller.signal, keepalive: true });
            }
            if (!current()) { resolve({ status: "disabled" }); return; }
            const answer = response.ok ? await response.json() : null;
            if (!current()) { resolve({ status: "disabled" }); return; }
            if (answer?.ok === true && answer.written === 1 && answer.dropped === 0) {
              if (held === report) held = null;
              resolve({ status: submitted._enterOmitted || submitted._scrollOmitted || submitted._timingOmitted ? "saved-legacy" : "saved" });
            } else resolve({ status: "failed" });
          } catch (_) { resolve({ status: current() ? "failed" : "disabled" }); }
          finally {
            clearTimeout(job.timeout);
            if (uploadJob === job) { uploadJob = null; busy = false; sending = null; }
          }
        }, 0);
      });
      return inflight;
    }
    function automatic(reason, detail) {
      if (!enabled) return false;
      const now = performance.now();
      if (!reasons.has(reason) || document.hidden || busy || collecting.size ||
          (held && held.reason === "manual") || now - lastAuto < COOLDOWN) {
        suppressed = cap(suppressed + 1, 1000000000); return false;
      }
      lastAuto = now;
      const initial = capture(reason, detail);
      if (schema >= 3) collect(initial, false);
      else { held = initial; upload(initial); }
      return true;
    }
    // A swipe on a scrollable response that moved nothing, as the page judged
    // it. The shared cooldown and minute cap still apply, and a card that stays
    // stuck saves once per STUCK_COOLDOWN rather than once per attempt.
    function noScroll(box) {
      if (!enabled || schema < 5 || typeof box !== "string" || !boxPattern.test(box)) return false;
      const now = performance.now();
      for (const [card, at] of stuck) if (now - at >= STUCK_COOLDOWN) stuck.delete(card);
      if (stuck.has(box)) { suppressed = cap(suppressed + 1, 1000000000); return false; }
      if (!automatic("no-scroll", { box })) return false;
      stuck.set(box, now);
      return true;
    }
    function collect(initial, manual) {
      const markAt = initial._markAt;
      return new Promise(resolve => {
        const current = { initial, markAt, resolve, timer: null, manual };
        collecting.add(current);
        current.timer = setTimeout(() => {
          if (!collecting.delete(current)) return;
          const report = finishCollection(initial);
          held = report;
          upload(report).then(resolve);
        }, POST_MS);
      });
    }
    // A press starts its own marker and its own 20 seconds at once, even while an
    // automatic save is still recording or sending; it goes out when it is ready.
    function mark(source, detail, retry = false) {
      if (!enabled) return Promise.resolve({ status: "disabled" });
      if (retry && held) return upload(held);
      const report = capture("manual", { ...detail, source });
      if (schema >= 3 && !retry) return collect(report, true);
      held = report;
      return upload(report);
    }
    function lifecycle(value, detail = {}) {
      if (!enabled) return;
      if (value === "visible" || value === "pageshow") beaconed = null;
      if (activeScroll && ["hidden", "visible", "pagehide", "pageshow"].includes(value)) {
        activeScroll.end = performance.now();
        timingRow([activeScroll.end, "end", activeScroll.surface]);
        activeScroll = null;
      }
      generation = cap(generation + 1, 1000000000);
      lastResume = performance.now();
      if (schema >= 3 || value !== "pagehide")
        note("lifecycle", schema >= 3 ? { lifecycle: value, ...detail } : { lifecycle: value });
    }
    document.addEventListener("visibilitychange", safe(() => lifecycle(document.hidden ? "hidden" : "visible")));
    addEventListener("pageshow", safe(e => lifecycle("pageshow", { persisted: !!e?.persisted })));
    for (const event of ["pagehide", "online", "offline"]) addEventListener(event, safe(() => lifecycle(event)));
    note("lifecycle", { lifecycle: "start" });
    // Neither callback proves that pixels were presented. Together they show
    // whether script callbacks and frame opportunities stopped around an input.
    // Outside a keyboard hold, frames are watched only for FRAME_WATCH after a
    // touch, a key or a new board reading, so an idle page asks for none. The 100 ms timer
    // below still catches every stall.
    const onFrame = safe((time, epoch) => {
      if (!enabled || epoch !== modeEpoch) return;
      if (!document.hidden && activeScroll) {
        const now = performance.now();
        timingRow([now, "frame", activeScroll.surface, time]);
        const gap = Math.max(now - activeScroll.frame, time - activeScroll.offered);
        activeScroll.frame = now; activeScroll.offered = time;
        if (gap >= 100) automatic("slow-ui");
      }
      if (!document.hidden && schema >= 3 && lastFrame !== null && frameEpoch === generation) {
        const gap = time - lastFrame;
        if (gap >= 250 && time - lastResume > gap + 100) {
          note("frame", { ms: gap });
          if (gap >= 1000) automatic("freeze");
        }
      }
      frameEpoch = generation;
      if (document.hidden || (!activeScroll && performance.now() >= watchUntil)) { watching = false; lastFrame = null; return; }
      lastFrame = time;
      requestAnimationFrame(time => onFrame(time, epoch));
    });
    watchFrames = safe(() => {
      if (!enabled) return;
      watchUntil = performance.now() + FRAME_WATCH;
      if (watching || (schema < 3 && !activeScroll) || document.hidden || typeof requestAnimationFrame !== "function") return;
      watching = true;
      lastFrame = performance.now();
      frameEpoch = generation;
      const epoch = modeEpoch;
      requestAnimationFrame(time => onFrame(time, epoch));
    });
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "keydown"])
      document.addEventListener(type, watchFrames, { capture: true, passive: true });
    let due = performance.now() + 100;
    setInterval(safe(() => {
      const now = performance.now(), late = now - due;
      due = now + 100;
      if (enabled && schema >= 3 && !document.hidden && late >= 500 && now - lastResume > late + 100) {
        note("timer", { late });
        if (late >= 1000) automatic("freeze");
      }
    }), 100);
    configureLongTasks();
    return {
      setEnabled: safe(setEnabled),
      keyboardScroll: safe(keyboardScroll), jobStart: safe(jobStart), jobEnd: safe(jobEnd),
      begin: safe(begin), end: safe(end), note: safe(note),
      identity: safe(value => { if (/^[a-z0-9._-]{1,64}$/.test(String(value))) build = String(value); }),
      worker: safe(value => { if (/^[a-z0-9._-]{1,64}$/.test(String(value))) worker = String(value); }),
      version: safe(() => schema, 1),
      observerSample: safe(observerSample),
      // Follow every successful reading. A server rolled back under an open
      // page omits the capability, so that page must return to strict v1 too.
      capability: safe(value => {
        const offered = Number(value);
        schema = offered >= 6 ? 6 : offered >= 5 ? 5 : offered >= 4 ? 4 : offered >= 3 ? 3 : offered >= 2 ? 2 : 1;
      }),
      mark: safe(mark, Promise.resolve({ status: "failed" })),
      noScroll: safe(noScroll, false),
      problem: safe((kind, message) => {
        if (!choices.problem.includes(kind)) return;
        // Browsers may emit these while settling a normal responsive layout.
        // Keep the existing error report, but do not turn every page load into
        // an immediate incident upload.
        if (kind === "error" && routineProblems.has(message)) {
          note("observer", { observer: message.indexOf("undelivered") >= 0 ? "undelivered" : "loop-limit" });
          return;
        }
        note("problem", { problem: kind }); automatic("problem");
      }),
      freeze: safe(late => {
        const continuous = performance.now() - lastResume > late + TICK;
        if (schema >= 3 && !continuous) return;
        note("freeze", { late });
        if (continuous) automatic("freeze");
      }),
      hide: safe(() => {
        if (!enabled) return;
        drainViewport();
        for (const current of [...collecting]) {
          collecting.delete(current); clearTimeout(current.timer);
          const finished = finishCollection(current.initial);
          if (current.manual || held?.reason !== "manual") held = finished;
          current.resolve({ status: "failed" }); // a beacon is never a persistence acknowledgement
        }
        const report = held !== sending ? held : null;
        if (report && report !== beaconed && navigator.sendBeacon && permit()) {
          if (navigator.sendBeacon("/clientlog", new Blob([bodyOf(report)], { type: "application/json" })))
            beaconed = report;
        }
      }),
    };
  }
})();
