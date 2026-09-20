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
  let incidents = null;            // the phone's recent history, only in memory
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
        if (incidents) incidents.freeze(late);
      }
    }, TICK);
  }

  // a page says which of the three it is, once. A second call changes nothing,
  // so a page that starts the reporter twice does not report twice
  window.startReporter = function (name) {
    if (page) return;
    page = name;
    if (name === "phone") {
      try {
        incidents = phoneHistory(window.fetch);
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
  function phoneHistory(realFetch) {
    const ENTRIES = 40, AGE = 60000, BYTES = 12 * 1024;
    const COALESCE = 250, UI_SLOW = 150, REQUEST_SLOW = 2000;
    const COOLDOWN = 30000, SAVES_PER_MINUTE = 4, SAVE_TIMEOUT = 4000;
    const POST_MS = 20000, SPARSE_AGE = 120000;
    const events = new Set(["create", "select", "focus", "send", "operation", "request",
      "render", "stage", "observer", "drawer", "viewport", "lifecycle", "problem", "freeze", "mark",
      "input", "scroll", "frame", "timer", "phase", "poll"]);
    const v3Events = new Set(["input", "scroll", "frame", "timer", "phase", "poll"]);
    const reasons = new Set(["manual", "slow-ui", "slow-request", "invariant", "problem", "freeze"]);
    const numbers = { ms: 600000, seq: 1000000000, status: 599, serverMs: 600000,
      rev: 1000000000000, boxes: 10000, vh: 10000, vt: 10000, late: 600000,
      count: 1000000, bytes: 16000000 };
    const flags = new Set(["present", "shown", "title", "titled", "emptyTitle", "editing", "known", "kb", "lifting",
      "editor", "editorReady", "inputReady", "selectedDom", "paneBlank", "loading", "connected", "formatted", "active",
      "changed", "persisted"]);
    const choices = { phase: ["start", "end"], route: ["/send", "/create", "/m/state"],
      side: ["left", "right"], source: ["settings", "shortcut"],
      action: ["drawer", "card", "response-scroll", "project", "state"],
      part: ["touch", "intent", "touch-end", "handler", "menu-commit", "frame-one", "frame-two",
        "transition", "select", "tickets", "tabs", "blur", "scroll-view", "fetch-headers",
        "json", "apply", "reconcile", "observer"],
      outcome: ["minted", "applied", "retry", "unsure", "failed"],
      lifecycle: ["start", "hidden", "visible", "pageshow", "pagehide", "online", "offline"],
      problem: ["error", "rejection", "render", "fetch"],
      stage: ["create-response", "card-insertion", "editor-init", "selected-ready", "title-input"],
      observer: ["loop-limit", "undelivered"], reason: [...reasons] };
    const routineProblems = new Set(["ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications."]);
    const legacyEvents = new Set(["create", "select", "focus", "send", "operation", "request",
      "render", "drawer", "viewport", "lifecycle", "problem", "freeze", "mark"]);
    const legacyFields = new Set(["event", "time", "visible", "online", "resume", "box", "selected", "op",
      "phase", "route", "side", "source", "outcome", "lifecycle", "problem", "reason",
      "ms", "seq", "status", "serverMs", "rev", "boxes", "vh", "vt", "late",
      "present", "shown", "title", "titled", "emptyTitle", "editing", "known", "kb", "lifting"]);
    const boxPattern = /^(?:[mt]?\d+(?:\.\d+)*|q)$/;
    const opPattern = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;
    let ring = [], lost = 0, sparseLost = 0, suppressed = 0, seq = 0, generation = 0;
    const important = [], work = [], life = [], pollBuckets = [], observerBuckets = [];
    let collecting = null, worker = "unknown", activeRequest = null;
    const session = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    let lastResume = -Infinity, lastAuto = -Infinity, attempts = [];
    let viewport = null, viewportTimer = null, viewportAt = -Infinity, viewportKey = "";
    let held = null, pendingManual = null, beaconed = null, busy = false, build = "phone-diag-unidentified", schema = 1;
    const cap = (n, max) => Math.min(max, Math.max(0, Math.round(n)));
    // Even a broken getter, unavailable clock, or disabled reporter must never
    // escape into a send, focus, navigation or keyboard reconciliation.
    const safe = (fn, fallback) => (...args) => {
      try { return fn(...args); } catch (_) { return fallback; }
    };
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
      if (schema < 3) return;
      const event = entry.event;
      if (!force && event === "request" && (entry.phase !== "end" || (entry.ms || 0) < 1000 && (entry.status || 0) < 400)) return;
      if (!force && event === "render" && (entry.phase !== "end" || (entry.ms || 0) < 50)) return;
      if (!force && event === "phase" && entry.action === "state" &&
          (entry.phase !== "end" || (entry.ms || 0) < 50)) return;
      if (event === "viewport") return; // coarse viewport state rides the next action or frame anomaly
      const target = event === "lifecycle" ? life
        : event === "input" || event === "scroll" || event === "frame" || event === "timer" || event === "freeze" || event === "mark" ? important : work;
      target.push(entry);
      const limit = target === important ? 60 : target === work ? 40 : 8;
      const cutoff = collecting ? collecting.markAt - SPARSE_AGE : entry.time - SPARSE_AGE;
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
      if (event === "operation" && fields.outcome === "failed") automatic("problem");
    }
    function begin(event, detail) {
      if (schema < 3 && v3Events.has(event)) return null;
      const token = { event, time: performance.now(), seq: seq = (seq + 1) % 1000000000,
        generation, visible: !document.hidden, detail: clean(detail) };
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
      if (!token) return;
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
      if (stable && ms >= (token.event === "request" ? REQUEST_SLOW : UI_SLOW)) {
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
      if (schema < 2) recent = recent.filter(e => legacyEvents.has(e.event)).map(e =>
        Object.fromEntries(Object.entries(e).filter(([key]) => legacyFields.has(key))));
      const report = { kind: "incident", v: schema, reason, marked: Date.now(),
        box: [...recent].reverse().find(e => e.box)?.box || "",
        lost, suppressed, events: recent.map(({ time, ...e }) => ({ ...e, at: -cap(now - time, AGE) })) };
      if (schema >= 2) report.build = build;
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
      const report = { kind: "incident", v: 3, reason, marked,
        box: [...recent].reverse().find(e => e.box)?.box || "", lost: sparseLost, suppressed,
        build, worker, session, events: recent.map(({ time, ...e }) =>
          ({ ...e, at: Math.max(-SPARSE_AGE, Math.min(POST_MS, Math.round(time - markAt))) })) };
      Object.defineProperty(report, "_markAt", { value: markAt });
      return report;
    }
    function bodyOf(report) {
      let body;
      // All strings are ASCII enums or validated ids. Byte length equals
      // length here, and trimming oldest entries always keeps the marker.
      for (;;) {
        body = JSON.stringify({ page: "phone", reports: [report] });
        if ((body.length <= BYTES && report.events.length <= (report.v === 3 ? 128 : 40)) ||
            report.events.length <= 1) return body;
        const drop = report.v === 3
          ? report.events.findIndex(e => e.event === "poll") : 0;
        const index = drop >= 0 ? drop : report.events.findIndex(e => e.event !== "mark");
        if (index < 0) return body;
        report.events.splice(index, 1); report.lost = cap(report.lost + 1, 1000000000);
      }
    }
    function permit() {
      const now = performance.now();
      attempts = attempts.filter(t => now - t < AGE);
      if (attempts.length >= SAVES_PER_MINUTE) return false;
      attempts.push(now);
      return true;
    }
    function upload() {
      if (busy) return Promise.resolve({ status: "busy" });
      if (!held) return Promise.resolve({ status: "failed" });
      if (navigator.onLine === false) return Promise.resolve({ status: "offline" });
      if (!permit()) return Promise.resolve({ status: "limited" });
      busy = true;
      // JSON and transport start on a later task, after the triggering work.
      return new Promise(resolve => setTimeout(async () => {
        let timer = null;
        try {
          const controller = new AbortController();
          timer = setTimeout(() => controller.abort(), SAVE_TIMEOUT);
          const response = await realFetch.call(window, "/clientlog", { method: "POST",
            headers: { "content-type": "application/json" }, body: bodyOf(held),
            signal: controller.signal, keepalive: true });
          const answer = response.ok ? await response.json() : null;
          if (answer?.ok === true && answer.written === 1 && answer.dropped === 0) {
            held = null; resolve({ status: "saved" });
          } else resolve({ status: "failed" });
        } catch (_) { resolve({ status: "failed" }); }
        finally { if (timer !== null) clearTimeout(timer); busy = false; }
      }, 0));
    }
    function automatic(reason) {
      const now = performance.now();
      if (!reasons.has(reason) || document.hidden || busy || collecting || pendingManual ||
          (held && held.reason === "manual") || now - lastAuto < COOLDOWN) {
        suppressed = cap(suppressed + 1, 1000000000); return;
      }
      lastAuto = now;
      held = capture(reason);
      if (schema >= 3) collect(held, false);
      else upload();
    }
    function collect(initial, manual) {
      const markAt = initial._markAt;
      return new Promise(resolve => {
        const current = { initial, markAt, resolve, timer: null, manual };
        collecting = current;
        current.timer = setTimeout(() => {
          if (collecting !== current) return;
          collecting = null;
          held = captureSparse(initial.reason, markAt, initial.marked,
            initial.events.find(e => e.event === "mark"));
          upload().then(resolve);
        }, POST_MS);
      });
    }
    function mark(source, detail, retry = false) {
      if (busy || collecting) {
        if (!pendingManual) pendingManual = capture("manual", { ...detail, source });
        return Promise.resolve({ status: "busy" });
      }
      if (retry && pendingManual) {
        held = pendingManual; pendingManual = null;
      } else if (!retry || !held) {
        pendingManual = null;
        held = capture("manual", { ...detail, source });
      }
      if (schema >= 3 && !retry) return collect(held, true);
      return upload();
    }
    function lifecycle(value, detail = {}) {
      if (value === "visible" || value === "pageshow") beaconed = null;
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
    let lastFrame = null, frameEpoch = generation;
    if (typeof requestAnimationFrame === "function") {
      const frame = safe(time => {
        if (!document.hidden && schema >= 3 && lastFrame !== null && frameEpoch === generation) {
          const gap = time - lastFrame;
          if (gap >= 250 && time - lastResume > gap + 100) {
            note("frame", { ms: gap });
            if (gap >= 1000) automatic("freeze");
          }
        }
        lastFrame = document.hidden ? null : time;
        frameEpoch = generation;
        requestAnimationFrame(frame);
      });
      requestAnimationFrame(frame);
    }
    let due = performance.now() + 100;
    setInterval(safe(() => {
      const now = performance.now(), late = now - due;
      due = now + 100;
      if (schema >= 3 && !document.hidden && late >= 500 && now - lastResume > late + 100) {
        note("timer", { late });
        if (late >= 1000) automatic("freeze");
      }
    }), 100);
    return {
      begin: safe(begin), end: safe(end), note: safe(note),
      identity: safe(value => { if (/^[a-z0-9._-]{1,64}$/.test(String(value))) build = String(value); }),
      worker: safe(value => { if (/^[a-z0-9._-]{1,64}$/.test(String(value))) worker = String(value); }),
      version: safe(() => schema, 1),
      observerSample: safe(observerSample),
      // Follow every successful reading. A server rolled back under an open
      // page omits the capability, so that page must return to strict v1 too.
      capability: safe(value => { schema = Number(value) >= 3 ? 3 : Number(value) >= 2 ? 2 : 1; }),
      mark: safe(mark, Promise.resolve({ status: "failed" })),
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
        drainViewport();
        if (collecting) {
          const current = collecting;
          collecting = null; clearTimeout(current.timer);
          held = captureSparse(current.initial.reason, current.markAt, current.initial.marked,
            current.initial.events.find(e => e.event === "mark"));
          current.resolve({ status: "failed" }); // a beacon is never a persistence acknowledgement
        }
        const report = pendingManual || (!busy ? held : null);
        if (report && report !== beaconed && navigator.sendBeacon && permit()) {
          if (navigator.sendBeacon("/clientlog", new Blob([bodyOf(report)], { type: "application/json" })))
            beaconed = report;
        }
      }),
    };
  }
})();
