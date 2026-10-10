// The phone page does not start without its code, and does not sit on the
// globe: when a shared file did not load, or the page throws before its first
// board is drawn, the white "server down" screen takes over, counts to its next
// try, and reloads into the app once the Mac answers.
//
// The page's own guard (the first lines of m.html's main script) and its
// downRetry count are taken out of the page and run in node:vm, on a clock this
// test moves by hand, against a document and a network written down. No browser
// opens and port 8877 is never touched.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const flush = () => new Promise(resolve => setImmediate(resolve));
const STARTS = "// THE PAGE DOES NOT START WITHOUT ITS CODE";
const ENDS = "// Only the Mac's own same-origin frame can enable the host adapter.";

function fakeClock() {
  let now = 1_000_000, seq = 0;
  const timers = new Map();
  return {
    get now() { return now; },
    setTimeout(fn, ms = 0, ...args) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args, seq: id });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
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
}

function functionText(source, head) {
  const start = source.indexOf(head);
  assert.notEqual(start, -1, `m.html has no ${head}`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${head} does not end`);
  return source.slice(start, end + 2);
}

// the count's line: its class list and its "in N seconds" words
function fakeLine() {
  const classes = new Set();
  const inWords = { textContent: " in 3 seconds" };
  return {
    classes, inWords,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    querySelector: selector => (selector === ".in" ? inWords : null),
  };
}

const ALL = { CardMarkdown: {}, settingsPage() {}, ComposeFormat: {} };

// the page's first lines, run as the browser runs them, with the shared files
// that "loaded" given. The guard is followed by the declaration the real page
// makes much further down (drewBoard), so it is read before it exists, as there.
async function startPage({ loaded = ALL, hidden = false } = {}) {
  const html = await readFile(path.join(ROOT, "m.html"), "utf8");
  const from = html.indexOf(STARTS);
  const to = html.indexOf(ENDS);
  assert.ok(from > 0 && to > from, "m.html's guard is not where it was");
  const clock = fakeClock();
  const classes = new Set();
  const line = fakeLine();
  const listeners = { window: {}, document: {} };
  const page = {
    clock, classes, line, listeners, tries: [], reloads: 0, error: null,
    down: () => classes.has("down"),
    fire: (type, event) => listeners.window[type](event),
  };
  const context = {
    Promise, Error, RegExp, ...loaded,
    setTimeout: (...args) => clock.setTimeout(...args),
    clearTimeout: id => clock.clearTimeout(id),
    Date: class extends Date { static now() { return clock.now; } },
    document: {
      hidden,
      body: { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } },
      querySelector: selector => (selector === "#serverdown .retry" ? line : null),
      addEventListener: (type, fn) => { listeners.document[type] = fn; },
    },
    addEventListener: (type, fn) => { listeners.window[type] = fn; },
    location: { href: "https://board.test/m?box=1.1", reload: () => { page.reloads += 1; } },
    fetch: (url, init) => new Promise((resolve, reject) => { page.tries.push({ url, init, resolve, reject }); }),
  };
  page.context = context;
  const script = [
    functionText(html, "function downRetry(line, ask){"),
    html.slice(from, to),
    "let drewBoard = false;",
  ].join("\n");
  try { vm.runInNewContext(script, vm.createContext(context), { filename: "m.html guard" }); }
  catch (error) { page.error = error; }
  // the guard's own functions stand in the context the script ran in
  page.call = name => vm.runInContext(name, context);
  return page;
}

// a file that arrives whole
const whole = { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };

test("with every shared file run, the page starts and the white screen stays away", async () => {
  const page = await startPage();
  assert.equal(page.error, null, "the guard stopped a page whose files all ran");
  assert.equal(page.down(), false);
  await page.clock.advance(60_000);
  assert.equal(page.tries.length, 0, "the page asked for something with nothing wrong");
  assert.equal(typeof page.listeners.window.error, "function", "no error is watched for");
});

test("a shared file that did not run: the script stops, the screen comes up and counts", async () => {
  const page = await startPage({ loaded: { CardMarkdown: {}, ComposeFormat: {} } });
  assert.match(String(page.error), /did not load: \/card-logic\.js$/, "the page went on without card-logic.js");
  assert.equal(page.down(), true, "the page was left on the globe");
  assert.equal(page.line.inWords.textContent, " in 3 seconds");
  await page.clock.advance(2999);
  assert.equal(page.tries.length, 0, "a try came before the count ran out");
  await page.clock.advance(1);
  assert.equal(page.tries.length, 1);
  assert.equal(page.tries[0].url, "/card-logic.js", "the try did not ask for the file that failed");
  assert.equal(page.tries[0].init.cache, "no-store");
});

test("the screen reloads only when the lost file comes through whole, and tries again until then", async () => {
  const page = await startPage({ loaded: { CardMarkdown: {}, ComposeFormat: {} } });
  const next = async () => { await page.clock.advance(3000); return page.tries.at(-1); };

  // the line is down
  (await next()).reject(new TypeError("Failed to fetch"));
  await page.clock.advance(800);
  assert.equal(page.reloads, 0);
  assert.equal(page.line.inWords.textContent, " in 3 seconds", "the count did not start again after a failed try");
  assert.equal(page.down(), true);

  // the bridge answers an error
  (await next()).resolve({ ok: false, status: 502, arrayBuffer: async () => new ArrayBuffer(0) });
  await page.clock.advance(800);
  assert.equal(page.reloads, 0, "a 502 reloaded the page into the same failure");

  // the answer starts and the line drops part of the way through it
  const cut = await next();
  cut.resolve({ ok: true, status: 200, arrayBuffer: async () => { throw new TypeError("network connection was lost"); } });
  await page.clock.advance(800);
  assert.equal(page.reloads, 0, "half a file was taken for the file");

  // the Mac answers whole
  (await next()).resolve(whole);
  await page.clock.advance(0);
  assert.equal(page.reloads, 1, "the file came through and the app was not reopened");
  const tries = page.tries.length;
  await page.clock.advance(60_000);
  assert.equal(page.tries.length, tries, "the screen went on trying after the app was reopened");
  assert.equal(page.reloads, 1);
});

test("every file that failed is asked for, and one still missing keeps the screen", async () => {
  const page = await startPage({ loaded: { ComposeFormat: {} } });
  assert.match(String(page.error), /did not load: \/card-markdown\.js, \/card-logic\.js$/);
  await page.clock.advance(3000);
  assert.equal(page.tries.length, 1);
  assert.equal(page.tries[0].url, "/card-markdown.js");
  page.tries[0].resolve(whole);
  await page.clock.advance(0);
  assert.equal(page.tries.length, 2);
  assert.equal(page.tries[1].url, "/card-logic.js");
  page.tries[1].resolve({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) });
  await page.clock.advance(800);
  assert.equal(page.reloads, 0, "one file still missing and the page was reloaded");
  assert.equal(page.down(), true);
});

test("an error before the first board is drawn brings up the same screen, and its try asks for the page", async () => {
  const page = await startPage();
  assert.equal(page.down(), false);
  page.fire("error", { message: "Uncaught ReferenceError: Can't find variable: settingsPage" });
  assert.equal(page.down(), true, "an error before the board left the page on the globe");
  await page.clock.advance(3000);
  assert.equal(page.tries.length, 1);
  assert.equal(page.tries[0].url, "https://board.test/m?box=1.1");
  page.tries[0].resolve(whole);
  await page.clock.advance(0);
  assert.equal(page.reloads, 1);
  // a second error while the screen is up starts no second count
  const again = await startPage();
  again.fire("error", { message: "first" });
  again.fire("error", { message: "second" });
  await again.clock.advance(3000);
  assert.equal(again.tries.length, 1, "two errors made two counts");
});

test("routine browser noise and failed loads are not the page breaking", async () => {
  const page = await startPage();
  for (const event of [
    { message: "ResizeObserver loop completed with undelivered notifications." },
    { message: "ResizeObserver loop limit exceeded" },
    { message: "" },   // a picture or script that failed to load carries no message
    {},
  ]) page.fire("error", event);
  assert.equal(page.down(), false, "noise brought the white screen up");
  await page.clock.advance(60_000);
  assert.equal(page.tries.length, 0);
  // rejected promises are not listened for: a call that fails on a bad line is not an error in the page
  assert.equal(page.listeners.window.unhandledrejection, undefined);
});

test("once a board has been drawn, an error changes nothing; one that came earlier lets go", async () => {
  const page = await startPage();
  page.fire("error", { message: "Uncaught TypeError: early" });
  assert.equal(page.down(), true);
  // the first board arrives after all
  vm.runInContext("drewBoard = true; pageMended();", page.context);
  assert.equal(page.down(), false, "the screen stayed over a board that was drawn");
  await page.clock.advance(60_000);
  assert.equal(page.tries.length, 0, "the count went on after the board was drawn");
  assert.equal(page.reloads, 0);
  page.fire("error", { message: "Uncaught TypeError: late" });
  assert.equal(page.down(), false, "an error after the first board brought the screen back");
  // and a mend with nothing to mend does nothing
  const quiet = await startPage();
  vm.runInContext("pageMended();", quiet.context);
  assert.equal(quiet.down(), false);
});

test("a page put away tries nothing, and coming back tries at once", async () => {
  const page = await startPage({ loaded: { CardMarkdown: {}, ComposeFormat: {} } });
  page.context.document.hidden = true;
  await page.clock.advance(3000);
  assert.equal(page.tries.length, 0, "a hidden page made a try");
  await page.clock.advance(800);
  page.context.document.hidden = false;
  page.listeners.document.visibilitychange();
  assert.equal(page.tries.length, 1, "coming back to the screen did not try at once");
});

test("m.html: the guard comes first, asks only for what the script cannot run without, and a draw lets it go", async () => {
  const html = await readFile(path.join(ROOT, "m.html"), "utf8");
  const guard = html.slice(html.indexOf(STARTS), html.indexOf(ENDS));
  // first thing in the main script, after the shared files and before anything uses them
  const head = html.slice(0, html.indexOf(STARTS));
  assert.match(head, /<script src="\/m-splash\.js"><\/script>\n<script>\n$/, "the guard is not the main script's first code");
  // the files it names are ones the page loads, and each global is defined by its own file
  for (const [file, name] of [["card-markdown.js", "CardMarkdown"], ["card-logic.js", "function settingsPage"],
                              ["compose-format.js", "ComposeFormat"]]) {
    assert.ok(html.includes(`<script src="/${file}"></script>`), `${file} is not a file the page loads`);
    assert.ok(guard.includes(`"/${file}"`), `the guard does not look for ${file}`);
    const source = await readFile(path.join(ROOT, file), "utf8");
    assert.ok(source.includes(name), `${file} does not define ${name}`);
  }
  assert.equal((guard.match(/\["\/[a-z-]+\.js", typeof /g) || []).length, 3, "the guard asks for more or fewer than the three files");
  assert.match(html, /drewBoard = true;[^\n]*\n\s*pageMended\(\);/, "drawing the first board does not let the screen go");
});
