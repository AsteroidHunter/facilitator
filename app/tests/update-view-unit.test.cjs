// The update's pop-up and progress view (updateView and updateNext in
// card-logic.js), and the phone's reload onto a new version (m.html). The page
// reloads only once the update is done on a board that kept running, or once a
// board of another run (another epoch) answers: an answer from the board that
// started the update, which can come once more while it stops, never reloads
// it. Run in a vm with a few fake elements and a hand-turned clock; nothing
// here asks a real board.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const LOGIC = fs.readFileSync(path.join(ROOT, "card-logic.js"), "utf8");
const PHONE = fs.readFileSync(path.join(ROOT, "m.html"), "utf8");
const plain = v => JSON.parse(JSON.stringify(v));

function between(text, from, to) {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `missing: ${from}`);
  const end = text.indexOf(to, start);
  assert.ok(end > start, `missing: ${to}`);
  return text.slice(start, end);
}

// the elements the view builds, enough of each to drive it
function fakeDocument() {
  const doc = { activeElement: null, listeners: {} };
  doc.addEventListener = (type, fn) => { doc.listeners[type] = fn; };
  doc.createElement = tag => {
    const classes = new Set(), on = {}, kids = [];
    const el = {
      tag, kids, on, dataset: {}, style: {}, attrs: {}, hidden: false, isConnected: true, textContent: "",
      set className(v) { classes.clear(); for (const c of String(v).split(/\s+/)) if (c) classes.add(c); },
      get className() { return [...classes].join(" "); },
      classList: {
        add: (...c) => c.forEach(x => classes.add(x)), remove: (...c) => c.forEach(x => classes.delete(x)),
        contains: c => classes.has(c), toggle: (c, want) => (want ? classes.add(c) : classes.delete(c)),
      },
      setAttribute(k, v) { el.attrs[k] = String(v); },
      append(...c) { kids.push(...c); },
      appendChild(c) { kids.push(c); return c; },
      addEventListener(type, fn) { on[type] = fn; },
      focus() { doc.activeElement = el; },
      blur() {},
      contains(x) { return x === el || kids.some(k => k.contains(x)); },
      click() { if (on.click) on.click({}); },
    };
    return el;
  };
  return doc;
}

// card-logic.js with that document, a clock turned by hand and the view's
// four calls answered by the test
function harness() {
  const document = fakeDocument();
  const timers = [];
  let now = 1000;
  class Clock extends Date {
    static now() { return now; }
  }
  const context = vm.createContext({
    console, document, AbortController,
    Date: Clock,
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].done = true; },
    setInterval: () => 0, clearInterval() {},
  });
  vm.runInContext(LOGIC, context, { filename: "card-logic.js" });
  const host = document.createElement("body");
  const calls = { ask: 0, start: 0, later: 0, reload: 0 };
  const answers = [];
  let startWith = null;
  const view = vm.runInContext("updateView", context)(host, {
    ask: async () => { calls.ask++; return answers.length ? answers.shift() : null; },
    start: () => { calls.start++; return new Promise(done => { startWith = done; }); },
    later: () => { calls.later++; },
    reload: () => { calls.reload++; },
  });
  const veil = host.kids[0];
  const [box, work] = veil.kids;
  const [title, line, row] = box.kids;
  const [later, yes] = row.kids;
  const words = work.kids[0].kids[1];
  const settle = () => new Promise(done => setImmediate(done));
  return {
    context, document, view, calls, answers, veil, box, work, title, line, later, yes, words,
    answerStart: async answer => { startWith(answer); await settle(); },
    // the clock on by ms, running every timer that falls due, each one settled
    async pass(ms) {
      now += ms;
      for (const t of timers) if (!t.done && t.at <= now) { t.done = true; t.fn(); await settle(); }
    },
    settle,
  };
}

const RUN = (epoch, stage) => ({ epoch, version: "v0.2.513", state: "running", stage });

test("the epoch wait: an answer from the board that started the update never reloads the page", () => {
  const { context } = harness();
  const next = (epoch, answer, quiet = 0) => plain(vm.runInContext("updateNext", context)(epoch, answer, quiet));
  assert.deepEqual(next("E0", RUN("E0", "setting-up")), { do: "stage", stage: "setting-up", epoch: "E0" });
  // the old board, answering once more after it said Restarting
  assert.deepEqual(next("E0", RUN("E0", "restarting")), { do: "stage", stage: "restarting", epoch: "E0" });
  // nobody answering: the board is restarting
  assert.deepEqual(next("E0", null, 5000), { do: "wait", stage: "restarting" });
  assert.deepEqual(next("E0", { error: "not found" }, 5000), { do: "wait", stage: "restarting" },
    "an answer that names no run is not the new board");
  // the new board: another run, which started no update
  assert.deepEqual(next("E0", { epoch: "E1", version: "v0.2.516", state: "idle" }), { do: "reload" });
  // a page-only update: the same board, done
  assert.deepEqual(next("E0", { epoch: "E0", state: "done", stage: "setting-up" }), { do: "reload" });
  assert.deepEqual(next("E0", { epoch: "E0", state: "failed", message: "This checkout has uncommitted changes." }),
    { do: "fail", message: "This checkout has uncommitted changes." });
  assert.equal(next("E0", null, 90000).do, "fail", "a board that never came back is waited on for ever");
  assert.equal(next("E0", { epoch: "E0", state: "idle" }).do, "fail");
});

test("a window that learned of the update from a reading waits on the run that answers it running", () => {
  const { context } = harness();
  const next = (epoch, answer) => plain(vm.runInContext("updateNext", context)(epoch, answer, 0));
  assert.deepEqual(next(null, RUN("E0", "downloading")), { do: "stage", stage: "downloading", epoch: "E0" });
  assert.deepEqual(next(null, { epoch: "E1", state: "idle" }), { do: "reload" }, "the update had already ended");
  assert.deepEqual(next(null, { epoch: "E0", state: "done" }), { do: "reload" });
});

test("the feasibility run, answer by answer: the page reloads on the new board's first answer and on nothing before", () => {
  const { context } = harness();
  const step = vm.runInContext("updateNext", context);
  // as in the proof's third run: two answers from the old board, one refused
  // connection, then the new board's
  const seen = [RUN("E0", "setting-up"), RUN("E0", "restarting"), null, RUN("E0", "restarting"),
                { epoch: "E1", state: "idle" }].map(answer => step("E0", answer, 0).do);
  assert.deepEqual(seen, ["stage", "stage", "wait", "stage", "reload"]);
});

test("the pop-up asks, Yes frosts the board, and the board is asked only once it has answered the yes", async () => {
  const h = harness();
  h.view.see({ offer: "v0.2.516", version: "v0.2.513" }, false);
  assert.equal(h.view.mode(), "ask");
  assert.ok(h.veil.classList.contains("open") && h.veil.classList.contains("qn-veil") && h.veil.classList.contains("sp-veil"));
  assert.ok(h.box.classList.contains("qn-glass"), "the box is not the board's glass");
  assert.equal(h.title.textContent, "Update Facilitator?");
  assert.equal(h.line.textContent, "v0.2.516 is ready. You have v0.2.513.");
  assert.equal(h.yes.textContent, "Yes");
  assert.equal(h.later.textContent, "Remind me later");
  assert.ok(h.yes.classList.contains("qn-glass"), "Yes is not the glass pill");
  assert.equal(h.document.activeElement, h.box, "a button holds the focus, so a stray Enter would start an update");

  h.yes.click();
  await h.settle();
  assert.equal(h.view.mode(), "work");
  assert.ok(h.veil.classList.contains("frost"), "the board did not frost over");
  assert.equal(h.words.textContent, "Downloading update");
  assert.equal(h.calls.start, 1);
  assert.equal(h.calls.ask, 0, "the board was asked before it had answered the yes");

  h.answers.push(RUN("E0", "downloading"));
  await h.answerStart({ ok: true, epoch: "E0" });
  assert.equal(h.calls.ask, 1);
  assert.equal(h.words.textContent, "Downloading update");
  h.answers.push(RUN("E0", "setting-up"));
  await h.pass(400);
  assert.equal(h.words.textContent, "Setting up");
  h.answers.push(RUN("E0", "restarting"));
  await h.pass(400);
  assert.equal(h.words.textContent, "Restarting");
  await h.pass(400);   // nothing answers
  assert.equal(h.words.textContent, "Restarting");
  h.answers.push(RUN("E0", "restarting"));   // the old board, once more
  await h.pass(400);
  assert.equal(h.calls.reload, 0, "the page reloaded on the old board's answer");
  h.answers.push({ epoch: "E1", version: "v0.2.516", state: "idle" });
  await h.pass(400);
  assert.equal(h.calls.reload, 0, "the bar did not fill before the reload");
  await h.pass(350);
  assert.equal(h.calls.reload, 1);
});

test("Remind me later puts the pop-up away, tells the board, and this page does not ask again", async () => {
  const h = harness();
  const offer = { offer: "v0.2.516", version: "v0.2.513" };
  h.view.see(offer, false);
  h.later.click();
  assert.equal(h.calls.later, 1);
  assert.equal(h.view.mode(), "shut");
  assert.equal(h.veil.classList.contains("open"), false);
  h.view.see(offer, false);
  assert.equal(h.view.mode(), "shut", "the same offer came back on the next reading");
  h.view.see({ offer: "v0.2.517", version: "v0.2.513" }, false);
  assert.equal(h.view.mode(), "ask", "a newer offer is still asked");
});

test("a refusal shows the update's own line in the same box with Close, and nothing is asked again", async () => {
  const h = harness();
  const offer = { offer: "v0.2.516", version: "v0.2.513" };
  h.view.see(offer, false);
  h.yes.click();
  h.answers.push({ epoch: "E0", state: "failed", stage: "downloading", message: "This checkout has uncommitted changes." });
  await h.answerStart({ ok: true, epoch: "E0" });
  assert.equal(h.view.mode(), "told");
  assert.equal(h.veil.classList.contains("frost"), false);
  assert.equal(h.title.textContent, "The update stopped");
  assert.equal(h.line.textContent, "This checkout has uncommitted changes.");
  assert.equal(h.yes.textContent, "Close");
  assert.equal(h.later.hidden, true);
  assert.equal(h.calls.reload, 0);
  h.yes.click();
  assert.equal(h.view.mode(), "shut");
  h.view.see(offer, false);
  assert.equal(h.view.mode(), "shut");
});

test("nothing goes up while the onboarding covers the board, and another window's update shows its progress", async () => {
  const h = harness();
  h.view.see({ offer: "v0.2.516", version: "v0.2.513" }, true);
  assert.equal(h.view.mode(), "shut");
  h.answers.push(RUN("E0", "setting-up"));
  h.view.see({ running: true }, false);
  assert.equal(h.view.mode(), "work");
  await h.settle();
  assert.equal(h.words.textContent, "Setting up");
  assert.equal(h.calls.start, 0, "a window that only watches started an update");
  h.answers.push({ epoch: "E1", state: "idle" });
  await h.pass(400);
  await h.pass(350);
  assert.equal(h.calls.reload, 1);
});

test("the phone reloads onto a new version, once, and not while a box holds the caret", () => {
  const block = between(PHONE, "// A NEW VERSION OF THE BOARD", "// the fetch and the render each get");
  const listeners = {};
  const reloads = [];
  const document = { activeElement: { tagName: "BODY" }, addEventListener: (type, fn) => { listeners[type] = fn; } };
  const context = vm.createContext({ document, location: { reload: () => reloads.push(1) },
    setTimeout: fn => fn() });
  vm.runInContext(block, context);
  const seen = vm.runInContext("versionSeen", context);
  seen("v0.2.513");
  seen("v0.2.513");
  seen(undefined);
  assert.equal(reloads.length, 0, "the version the page loaded with reloaded it");
  document.activeElement = { tagName: "TEXTAREA" };
  seen("v0.2.516");
  assert.equal(reloads.length, 0, "the page reloaded under the caret");
  document.activeElement = { tagName: "BODY" };
  listeners.focusout();
  assert.equal(reloads.length, 1);
  seen("v0.2.517");
  assert.equal(reloads.length, 1, "asked to reload twice");
});
