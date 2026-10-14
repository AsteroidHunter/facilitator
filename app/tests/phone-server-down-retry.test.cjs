// The server-down screen for a Mac that says nothing at all, and the count under
// its words. A page open that has had no answer within 8 seconds gets the
// screen from the phone's worker (Tailscale off, the Mac's Wi-Fi off, the Mac
// asleep), and an answer that has started is never cut. Under the words the
// screen reads "Retrying in 3 seconds", 2, then 1; just before zero the count
// fades out and the card spinner fades in to the left of "Retrying" while the
// try runs; a failed try counts again and an answered one opens the app. The
// R of "Retrying" stands under the I of "Is": one box, no indent, the face and
// the spinner hung outside the text. Both copies of the screen are held to
// this: the worker's own (m-sw.js) and m.html's. Everything runs in node:vm on
// a fake clock against fake pages; no browser and no server.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WORDS = "Is the Facilitator server down?";
const read = name => readFile(path.join(ROOT, name), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

// ---- a clock the test moves by hand ------------------------------------------------------

function fakeClock(start = 1_000_000) {
  let now = start, seq = 0;
  const timers = new Map();
  const armed = [];
  const clock = {
    get now() { return now; },
    armed,
    pending: () => timers.size,
    setTimeout(fn, ms = 0, ...args) {
      const id = ++seq;
      armed.push(ms);
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args, seq: id });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    // run every timer due by then, in order, letting promises settle between them
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        await flush();
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at > until) continue;
          if (!next || timer.at < next.timer.at || (timer.at === next.timer.at && timer.seq < next.timer.seq)) next = { id, timer };
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.timer.at;
        next.timer.fn(...next.timer.args);
      }
      now = until;
      await flush();
    },
  };
  clock.Date = class extends Date { static now() { return now; } };
  return clock;
}

const timerGlobals = clock => ({
  setTimeout: (...args) => clock.setTimeout(...args),
  clearTimeout: id => clock.clearTimeout(id),
  Date: clock.Date,
});

// ---- the two copies ------------------------------------------------------------------------

async function loadWorker(clock, fetchImpl) {
  const handlers = {};
  const context = {
    URL, AbortSignal, AbortController, Promise, Response, Headers, ...timerGlobals(clock),
    fetch: fetchImpl,
    caches: { keys: async () => [], open: async () => ({ addAll: async () => {} }), match: async () => undefined },
    self: {
      location: { origin: "https://board.test" },
      addEventListener: (type, fn) => { handlers[type] = fn; },
      skipWaiting() {}, registration: {}, clients: { claim: async () => {} },
    },
  };
  vm.runInNewContext(await read("m-sw.js"), context, { filename: "m-sw.js" });
  return { handlers, context };
}

// the worker's answer to a page open, with whether and when it has settled
function openApp(handlers, clock, url = "https://board.test/m?box=1.1") {
  let answered;
  handlers.fetch({ request: { url, mode: "navigate", method: "GET" }, respondWith: promise => { answered = promise; } });
  assert.ok(answered, "the worker left the page open alone");
  const seen = { settled: false, at: null, value: undefined };
  answered.then(value => { seen.settled = true; seen.at = clock.now; seen.value = value; });
  return seen;
}

// the text of one top-level function, from its first line to the brace that closes it
function functionText(source, head, file) {
  const start = source.indexOf(head);
  assert.notEqual(start, -1, `${file} has no ${head}`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${file}: ${head} does not end`);
  return source.slice(start, end + 2);
}

async function downPageText() {
  const clock = fakeClock();
  const { handlers } = await loadWorker(clock, async () => { throw new TypeError("Failed to fetch"); });
  const seen = openApp(handlers, clock);
  await clock.advance(0);
  assert.equal(seen.settled, true);
  return seen.value.text();
}

// each copy of the count, made on the clock given
const COPIES = [
  ["m-sw.js", async clock => (await loadWorker(clock, async () => { throw new TypeError("no"); })).context.downRetry],
  ["m.html", async clock => vm.runInNewContext(
    functionText(await read("m.html"), "function downRetry(line, ask){", "m.html") + "\n;downRetry",
    { ...timerGlobals(clock), Promise }, { filename: "m.html downRetry" })],
];

// the count's line: its class list and its "in N seconds" words
function fakeLine(words = " in 3 seconds") {
  const classes = new Set();
  const inWords = { textContent: words };
  return {
    classes, inWords,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    querySelector: selector => (selector === ".in" ? inWords : null),
  };
}

// ---- the 8 second limit on the page open's first answer ------------------------------------

test("a page open with no answer at all for 8 seconds gets the server-down screen", async () => {
  const clock = fakeClock();
  const asked = [];
  const { handlers } = await loadWorker(clock, request => { asked.push(request); return new Promise(() => {}); });
  const seen = openApp(handlers, clock);
  const began = clock.now;
  await clock.advance(7999);
  assert.equal(seen.settled, false, "the screen came before 8 seconds of silence");
  await clock.advance(1);
  assert.equal(seen.settled, true, "the page open is still waiting on a Mac that never answered");
  assert.equal(seen.at - began, 8000);
  assert.equal(seen.value.status, 503);
  assert.equal(seen.value.headers.get("cache-control"), "no-store");
  const page = await seen.value.text();
  assert.ok(page.includes('<div id="serverdown"') && page.includes(WORDS), "the answer is not the server-down screen");
  assert.ok(page.includes("Retrying"), "the screen has no count under its words");
  assert.equal(page, await downPageText(), "the screen for silence is not the one for a failed request");
  assert.equal(asked.length, 1, "the page open was asked of the Mac more than once");
  assert.equal(asked[0].mode, "navigate", "the navigation was not passed on as it came");
});

test("an answer that starts before 8 seconds is never cut, however slowly the rest comes", async () => {
  for (const at of [50, 3000, 7999]) {
    const clock = fakeClock();
    let bodyRead = 0;
    const real = { status: 200, ok: true, text: async () => { bodyRead++; return ""; } };
    const { handlers } = await loadWorker(clock, () => new Promise(resolve => clock.setTimeout(resolve, at, real)));
    const seen = openApp(handlers, clock);
    const began = clock.now;
    assert.ok(clock.armed.includes(8000), "no 8 second limit is armed while the answer has not started");
    await clock.advance(at);
    assert.equal(seen.settled, true, `an answer at ${at} ms was held back`);
    assert.equal(seen.at - began, at, "a working start was made to wait longer than its answer");
    assert.equal(seen.value, real, `an answer at ${at} ms did not reach the page as it came`);
    assert.equal(clock.pending(), 0, "the limit was left running after the answer started");
    await clock.advance(120000);
    assert.equal(bodyRead, 0, "the worker read the page's body instead of handing it on");
  }
  // the old rules stand inside the limit: a failure is the screen at once, a proxy's 502 is the screen
  const clock = fakeClock();
  const { handlers } = await loadWorker(clock, () => new Promise((_, reject) => clock.setTimeout(reject, 300, new TypeError("refused"))));
  const failed = openApp(handlers, clock);
  await clock.advance(300);
  assert.equal(failed.settled, true);
  assert.equal(failed.value.status, 503);
  const gateway = fakeClock();
  const behind = await loadWorker(gateway, () => new Promise(resolve => gateway.setTimeout(resolve, 7000, { status: 502, ok: false })));
  const proxied = openApp(behind.handlers, gateway);
  await gateway.advance(7000);
  assert.equal(proxied.value.status, 503, "a 502 inside the limit is not the screen");
});

// ---- the count -----------------------------------------------------------------------------

test("the two copies of the count are the same text, and the worker's screen runs it", async () => {
  const worker = functionText(await read("m-sw.js"), "function downRetry(line, ask){", "m-sw.js");
  const page = functionText(await read("m.html"), "function downRetry(line, ask){", "m.html");
  assert.equal(page, worker, "m.html's count differs from the worker's");
  assert.ok((await downPageText()).includes(worker), "the worker's screen does not carry the count");
});

test("the count runs 3, 2, 1 a second apart, fades just before zero, and tries at zero", async () => {
  for (const [name, load] of COPIES) {
    const clock = fakeClock();
    const downRetry = await load(clock);
    const line = fakeLine("");
    const asks = [];
    const retry = downRetry(line, () => new Promise(resolve => asks.push({ at: clock.now, resolve })));
    const t0 = clock.now;
    const state = () => [clock.now - t0, line.inWords.textContent, line.classes.has("trying"), asks.length];
    retry.start();
    const timeline = [state()];
    for (const step of [999, 1, 999, 1, 739, 1, 259, 1]) { await clock.advance(step); timeline.push(state()); }
    assert.deepEqual(timeline, [
      [0, " in 3 seconds", false, 0],
      [999, " in 3 seconds", false, 0],
      [1000, " in 2 seconds", false, 0],
      [1999, " in 2 seconds", false, 0],
      [2000, " in 1 second", false, 0],
      [2739, " in 1 second", false, 0],
      [2740, " in 1 second", true, 0],    // the fade starts 260 ms before zero
      [2999, " in 1 second", true, 0],
      [3000, " in 1 second", true, 1],    // and the try at zero
    ], `${name}: the count's words and times`);
    assert.equal(asks[0].at - t0, 3000);

    // refused at once: the spinner is seen for a whole turn, then the count again
    asks[0].resolve(false);
    await clock.advance(799);
    assert.deepEqual(state().slice(2), [true, 1], `${name}: the count came back before the spinner had turned once`);
    await clock.advance(1);
    assert.deepEqual(state(), [3800, " in 3 seconds", false, 1], `${name}: a failed try did not start the count again`);
    await clock.advance(2740);
    assert.deepEqual(state(), [6540, " in 1 second", true, 1]);
    await clock.advance(260);
    assert.deepEqual(state(), [6800, " in 1 second", true, 2]);

    // a try left unanswered for 5 seconds: the count starts again the moment it fails
    await clock.advance(5000);
    asks[1].resolve(false);
    await clock.advance(0);
    assert.deepEqual(state(), [11800, " in 3 seconds", false, 2], `${name}: a slow failure held the count back`);

    // answered: the spinner stays, nothing more is tried
    await clock.advance(3000);
    assert.equal(asks.length, 3);
    asks[2].resolve(true);
    await clock.advance(60000);
    assert.deepEqual(state().slice(1), [" in 1 second", true, 3], `${name}: an answered try was followed by another`);
  }
});

test("now() tries at once, a stopped count stays stopped, and a stale try cannot restart one", async () => {
  for (const [name, load] of COPIES) {
    const clock = fakeClock();
    const downRetry = await load(clock);
    const line = fakeLine();
    const asks = [];
    const retry = downRetry(line, () => new Promise(resolve => asks.push({ at: clock.now, resolve })));
    const t0 = clock.now;
    retry.now();
    assert.equal(asks.length, 0, `${name}: a count that was never started tried`);
    retry.start();
    await clock.advance(1500);
    retry.now();
    assert.equal(asks.length, 1, `${name}: now() did not try at once`);
    assert.equal(asks[0].at - t0, 1500);
    assert.equal(line.classes.has("trying"), true, `${name}: the spinner is not shown while trying`);
    retry.now();
    assert.equal(asks.length, 1, `${name}: now() made a second try while one was under way`);
    await clock.advance(5000);
    assert.equal(asks.length, 1, `${name}: the count went on during a try`);

    // stopped during a try: its failure starts nothing
    retry.stop();
    assert.equal(line.classes.has("trying"), false);
    asks[0].resolve(false);
    await clock.advance(20000);
    assert.equal(asks.length, 1, `${name}: a stopped count tried again`);
    assert.equal(clock.pending(), 0, `${name}: a stopped count left a timer`);

    // started again while an older try is still out: that try's end leaves the new count alone
    retry.start();
    await clock.advance(3000);
    assert.equal(asks.length, 2);
    retry.stop();
    retry.start();
    const restarted = clock.now;
    await clock.advance(100);
    asks[1].resolve(false);
    await clock.advance(900);
    assert.equal(line.inWords.textContent, " in 2 seconds", `${name}: a stale try reset the new count`);
    await clock.advance(2000);
    assert.equal(asks.length, 3);
    assert.equal(asks[2].at - restarted, 3000, `${name}: the new count did not try at its own zero`);
  }
});

// ---- the screen's rules and markup -----------------------------------------------------------

// the rules of the screen as one list: selector, the at-rule it sits in, its declarations
function rulesOf(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [];
  let at = 0;
  const walk = within => {
    while (at < text.length) {
      const open = text.indexOf("{", at), close = text.indexOf("}", at);
      if (close !== -1 && (open === -1 || close < open)) { at = close + 1; return; }
      if (open === -1) { at = text.length; return; }
      const selector = text.slice(at, open).trim();
      at = open + 1;
      if (selector.startsWith("@")) { walk(selector); continue; }
      const end = text.indexOf("}", at);
      const decls = new Map();
      for (const part of text.slice(at, end).split(";")) {
        const colon = part.indexOf(":");
        if (colon > 0) decls.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
      }
      at = end + 1;
      rules.push({ selector, within, decls });
    }
  };
  walk(null);
  return rules;
}

async function screens() {
  const html = await read("m.html");
  const page = await downPageText();
  const pick = (source, pattern, what) => { const found = source.match(pattern); assert.ok(found, `no ${what}`); return found[0]; };
  const RULES = / {2}#serverdown\{[\s\S]*?#serverdown \.in, #serverdown \.spin\{transition:none\}\n {2}\}\n/;
  const MARKUP = /<div id="serverdown"[\s\S]*?<\/div><\/div>/;
  return [
    ["m.html", pick(html, RULES, "m.html screen rules"), pick(html, MARKUP, "m.html screen markup")],
    ["m-sw.js", pick(page, RULES, "worker screen rules"), pick(page, MARKUP, "worker screen markup")],
  ];
}

test("the R of Retrying and the I of Is share one left edge: one box, no indent, marks outside the text", async () => {
  for (const [name, css, markup] of await screens()) {
    // markup: the words and the count are the two lines of one box, each line's
    // own words its first text, nothing but an out-of-line mark before them
    const lines = markup.match(/^<div id="serverdown" role="alert"><div class="say">(<p>[\s\S]*?<\/p>)(<p class="retry"[\s\S]*?<\/p>)<\/div><\/div>$/);
    assert.ok(lines, `${name}: the words and the count are not two lines of one box`);
    assert.match(lines[1], /^<p><svg [^>]*>[\s\S]*<\/svg>Is the Facilitator server down\?<\/p>$/, `${name}: the I is not the first letter of its line`);
    assert.match(lines[2], /^<p class="retry" aria-live="off"><span class="spin" aria-hidden="true"><\/span>Retrying<span class="in"> in 3 seconds<\/span><\/p>$/,
      `${name}: the R is not the first letter of its line`);

    const rules = rulesOf(css);
    const rule = (selector, within = null) => {
      const found = rules.find(r => r.selector === selector && r.within === within);
      assert.ok(found, `${name}: no rule for ${selector}`);
      return found.decls;
    };
    const box = rule("#serverdown .say"), line = rule("#serverdown p"), count = rule("#serverdown .retry");
    const marks = rule("#serverdown svg, #serverdown .spin");
    assert.equal(box.get("text-align"), "left", `${name}: the lines do not start at the box's left edge`);
    assert.equal(line.get("margin"), "0");
    for (const [what, decls] of [["the box", box], ["a line", line], ["the count", count]]) {
      for (const property of ["text-indent", "padding", "padding-left", "padding-inline-start", "margin-left", "margin-inline-start", "left", "right", "inset", "transform"]) {
        if (what === "the box" && property === "padding-left") continue;   // the margin the marks hang in
        assert.equal(decls.has(property), false, `${name}: ${what} sets ${property}, which moves its first letter`);
      }
    }
    // the count is out of the flow where it stood, under the words: no offset
    // of its own, so its left edge is the box's content edge, the words' edge
    assert.equal(count.get("position"), "absolute");
    for (const property of ["top", "bottom", "margin", "margin-top"]) assert.equal(count.has(property), false, `${name}: the count sets ${property}`);
    // the face and the spinner hang to the left of the text's edge, out of the lines
    assert.equal(marks.get("position"), "absolute", `${name}: a mark sits in the line and pushes its words`);
    assert.equal(marks.get("right"), "100%", `${name}: a mark is not to the left of its line`);
    assert.equal(marks.get("width"), "1em");
    assert.equal(marks.get("margin-right"), ".4em");
    // the box's margin is the mark and its gap, so the words stand where they always stood
    assert.equal(box.get("padding-left"), "1.4em");
    assert.equal(rules.some(r => r.decls.has("text-indent")), false, `${name}: something in the screen is indented`);
  }
});

test("just before zero the count fades and the card spinner fades in, held still for reduced motion", async () => {
  const worker = functionText(await read("m-sw.js"), "function downRetry(line, ask){", "m-sw.js");
  const fade = Number(worker.match(/FADE_MS = (\d+)/)[1]);
  const turn = Number(worker.match(/TURN_MS = (\d+)/)[1]);
  const gap = Number(worker.match(/GAP_S = (\d+)/)[1]);
  const logic = await read("card-logic.js");
  const firstFrame = JSON.parse(logic.match(/const SPIN_FRAMES = (\[[^\]]*\])/)[1])[0];
  const home = await read("home-widgets.css");
  for (const [name, css, markup] of await screens()) {
    const rules = rulesOf(css);
    const rule = (selector, within = null) => {
      const found = rules.find(r => r.selector === selector && r.within === within);
      assert.ok(found, `${name}: no rule for ${selector} ${within || ""}`);
      return found.decls;
    };
    assert.equal(rule("#serverdown .spin").get("opacity"), "0", `${name}: the spinner shows while counting`);
    assert.equal(rule("#serverdown .trying .spin").get("opacity"), "1", `${name}: the spinner does not come in`);
    assert.equal(rule("#serverdown .trying .in").get("opacity"), "0", `${name}: "in N seconds" does not fade out`);
    const transition = rule("#serverdown .in, #serverdown .spin").get("transition");
    assert.equal(transition, "opacity .26s cubic-bezier(.42,.06,.38,1)", `${name}: not the card spinner's fade`);
    assert.equal(Math.round(parseFloat(transition.split(" ")[1]) * 1000), fade, `${name}: the fade is not the count's FADE_MS`);
    // the board's spinner: its first frame, in the mono face, turning in four steps
    const glyph = rule("#serverdown .spin::before");
    assert.equal(glyph.get("content"), JSON.stringify(firstFrame), `${name}: the mark is not the card spinner's`);
    assert.match(glyph.get("font"), /^600 1em\/1em var\(--mono\)$/);
    assert.equal(glyph.get("animation"), "downturn .8s steps(4) infinite");
    assert.equal(Math.round(parseFloat(glyph.get("animation").split(" ")[1]) * 1000), turn, `${name}: a whole turn is not TURN_MS`);
    assert.equal(rule("to", "@keyframes downturn").get("transform"), "rotate(180deg)");
    assert.match(home, /\.tk-refresh\.on::before\{animation:tk-refresh-turn \.8s steps\(4\) infinite\}/, "Home's marker turns differently now");
    assert.match(home, /@keyframes tk-refresh-turn\{to\{transform:rotate\(180deg\)\}\}/);
    // reduced motion: a still mark, and the words simply change
    const calm = "@media (prefers-reduced-motion: reduce)";
    assert.equal(rule("#serverdown .spin::before", calm).get("animation"), "none", `${name}: the spinner turns for reduced motion`);
    assert.equal(rule("#serverdown .in, #serverdown .spin", calm).get("transition"), "none");
    // no purple and no accent: the screen's only colours are its white and the ink
    assert.equal(/accent|purple/i.test(css), false, `${name}: the screen names an accent`);
    assert.deepEqual([...new Set(css.match(/#[0-9A-Fa-f]{3,8}\b/g))], ["#FFFFFF"], `${name}: a colour other than white`);
    // the words the screen first shows are the count's own first words, for its gap
    const line = fakeLine("");
    const clock = fakeClock();
    (await COPIES[0][1](clock))(line, async () => false).start();
    assert.equal(markup.match(/<span class="in">([^<]*)<\/span>/)[1], line.inWords.textContent);
    assert.equal(line.inWords.textContent, ` in ${gap} seconds`);
  }
});

// ---- recovery --------------------------------------------------------------------------------

// the worker's screen with its own script running, on the clock given
async function runDownPage(clock, fetchImpl) {
  const script = (await downPageText()).match(/<script>([\s\S]*?)<\/script>/)[1];
  const line = fakeLine();
  const on = {}, onDocument = {};
  const page = { reloads: 0, line, on, onDocument };
  const context = {
    ...timerGlobals(clock), Promise, AbortController, DOMException,
    navigator: { standalone: false }, screen: { height: 812 },
    location: { href: "https://board.test/m?box=1.1", reload: () => { page.reloads++; } },
    fetch: fetchImpl,
    document: {
      hidden: false,
      documentElement: { style: { setProperty() {} } },
      head: { appendChild() {} },
      createElement: () => ({ addEventListener() {} }),
      querySelector: selector => (selector === "#serverdown .retry" ? line : null),
      addEventListener: (type, fn) => { onDocument[type] = fn; },
    },
    addEventListener: (type, fn) => { on[type] = fn; },
  };
  vm.runInNewContext(script, context, { filename: "down screen" });
  return page;
}

test("the worker's screen tries the app page itself and reloads into the app only when it comes back", async () => {
  const clock = fakeClock();
  const tries = [];
  const page = await runDownPage(clock, (url, init) => new Promise((resolve, reject) => {
    tries.push({ url, init, at: clock.now, resolve, reject });
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }));
  assert.equal(page.line.inWords.textContent, " in 3 seconds");
  await clock.advance(2999);
  assert.equal(tries.length, 0, "the screen tried before its count reached zero");
  await clock.advance(1);
  assert.equal(tries.length, 1);
  assert.equal(tries[0].url, "https://board.test/m?box=1.1", "the try is not the page the reload would open");
  assert.equal(tries[0].init.cache, "no-store");

  // the Mac refuses, then answers through a proxy with 502, then with a broken page: never a reload
  tries[0].reject(new TypeError("Failed to fetch"));
  await clock.advance(800);
  assert.equal(page.line.inWords.textContent, " in 3 seconds");
  assert.equal(page.line.classes.has("trying"), false);
  for (const status of [502, 503, 504, 500, 404]) {
    await clock.advance(3000);
    const now = tries.at(-1);
    now.resolve({ ok: false, status });
    await clock.advance(800);
    assert.equal(page.reloads, 0, `a ${status} reloaded the screen into a broken page`);
  }
  // the Mac says nothing: the try is given the same 8 seconds and then let go
  await clock.advance(3000);
  const silent = tries.at(-1);
  await clock.advance(7999);
  assert.equal(silent.init.signal.aborted, false, "the try was let go before 8 seconds");
  await clock.advance(1);
  assert.equal(silent.init.signal.aborted, true, "a try the Mac never answers was waited on for ever");
  await clock.advance(0);
  assert.equal(page.line.inWords.textContent, " in 3 seconds", "the count did not start again after a silent try");
  assert.equal(page.reloads, 0);

  // the phone comes back on screen, or online: a try at once
  const before = tries.length;
  await clock.advance(1000);
  page.onDocument.visibilitychange();
  assert.equal(tries.length, before + 1, "coming back on screen did not try at once");
  tries.at(-1).reject(new TypeError("Failed to fetch"));
  await clock.advance(1000);
  page.on.online();
  assert.equal(tries.length, before + 2, "coming back online did not try at once");

  // the Mac answers with the page: the screen reloads into the app, still saying Retrying
  tries.at(-1).resolve({ ok: true, status: 200 });
  await clock.advance(0);
  assert.equal(page.reloads, 1, "an answered try did not open the app");
  assert.equal(page.line.classes.has("trying"), true);
  assert.equal(tries.at(-1).init.signal.aborted, true, "the page's words were waited for instead of reloading");
  const after = tries.length;
  await clock.advance(60000);
  assert.equal(tries.length, after, "the screen went on trying after the app was opened");
});

// m.html's own: the link rules, the count and the reading schedule taken out of the page and run
async function runPageLink(clock) {
  const html = await read("m.html");
  const from = html.indexOf("let opening = true, openedAt = Date.now();");
  assert.notEqual(from, -1, "m.html has no opening rule");
  const to = html.indexOf("\n}\n", html.indexOf("function linkUp(asked){", from)) + 3;
  const source = [
    "let pollTimer = null, pollGap = 1200; const POLL_MS = 1200;",
    "const poll = () => __page.poll(); const wakeOps = () => {}; const cardsMoving = () => false;",
    functionText(html, "function schedulePoll(ms){", "m.html"),
    html.slice(from, to),
    functionText(html, "function resume(){", "m.html"),
    "__page.link = { linkOpened, linkDown, linkUp, schedulePoll, resume, get openedAt(){ return openedAt; }, get pollTimer(){ return pollTimer; } };",
  ].join("\n");
  const classes = new Set();
  const line = fakeLine();
  const page = { line, polls: [], down: () => classes.has("down") };
  page.poll = () => new Promise(resolve => page.polls.push({ at: clock.now, resolve }));
  const context = {
    ...timerGlobals(clock), Promise, __page: page,
    document: {
      hidden: false,
      body: { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } },
      querySelector: selector => (selector === "#serverdown .retry" ? line : null),
    },
  };
  vm.runInNewContext(source, context, { filename: "m.html link" });
  return page;
}

test("m.html: the white screen's count runs the readings, and an answered one opens the app", async () => {
  const clock = fakeClock();
  const page = await runPageLink(clock);
  const { link } = page;
  link.linkDown(link.openedAt, null);
  assert.equal(page.down(), true, "the opening's failed reading did not bring the screen up");
  assert.equal(page.line.inWords.textContent, " in 3 seconds");
  link.schedulePoll(2400);
  assert.equal(link.pollTimer, null, "a reading was scheduled beside the count");
  await clock.advance(3000);
  assert.equal(page.polls.length, 1, "the count's zero made no reading");

  // the reading fails: the screen stays and counts again
  link.linkDown(clock.now, null);
  page.polls[0].resolve();
  await clock.advance(800);
  assert.equal(page.down(), true);
  assert.equal(page.line.inWords.textContent, " in 3 seconds");
  assert.equal(page.line.classes.has("trying"), false);
  await clock.advance(3000);
  assert.equal(page.polls.length, 2);

  // the reading is answered: the screen goes, the count stops, readings go back to their own schedule
  link.linkUp(clock.now);
  page.polls[1].resolve();
  await clock.advance(60000);
  assert.equal(page.down(), false, "the screen stayed after the board answered");
  assert.equal(page.polls.length, 2, "the count went on after the board answered");

  // opened again with the board gone: coming back tries at once, through the count, once
  link.linkOpened();
  link.linkDown(link.openedAt, null);
  await clock.advance(1000);
  link.resume();
  assert.equal(page.polls.length, 3, "coming back to the white screen did not try at once");
  assert.equal(page.line.classes.has("trying"), true);
  link.resume();
  assert.equal(page.polls.length, 3, "a second wake made a second reading beside the try");
  link.linkUp(clock.now);
  page.polls[2].resolve();
  await clock.advance(10000);
  link.resume();
  assert.equal(page.polls.length, 4, "with the screen gone a wake no longer reads");
  // and readings are back on their own schedule
  link.schedulePoll(1200);
  assert.notEqual(link.pollTimer, null, "readings did not go back to their own schedule");
});
